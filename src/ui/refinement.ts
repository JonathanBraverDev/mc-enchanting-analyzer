import { RegistryState, CalculationStats, SweepData } from '../types/index.js';
import { UI_TEXTS, UI_DEFAULTS, SearchLevel, getParamsForMode } from '../core/config.js';
import { WorkerClient } from '../worker/client.js';
import { AsyncUtils } from '../utils/index.js';

interface BaseSearchPayload {
    cat: string;
    xp: number;
    mat: string;
    guaranteedFirst: string | null;
}

export interface RefinementPayload {
    category: string;
    material: string;
    guaranteedFirst: string | null;
    xpLevel: number;
    version: string;
}

export interface RefinementCallbacks {
    onStatus: (status: string, level: SearchLevel) => void;
    onChartStatus?: (status: string, progress?: number) => void;
    onStats: (stats: CalculationStats, isFinal: boolean) => void;
    onChart: (sweep: SweepData[]) => void;
}

/**
 * Service for orchestrating progressive refinement of enchantment calculations.
 */
export class RefinementService {
    private activeId: number = 0;
    private sweep: SweepData[] = [];
    private isSweepRunning: boolean = false;
    private targetThreshold: number = 0;
    private sweepAbortController: AbortController | null = null;
    private activeChartLevel: Exclude<SearchLevel, 'done'> = 'coarse';

    public get currentSweep(): SweepData[] {
        return this.sweep;
    }

    /**
     * Starts a new refinement cycle. Cancels any existing cycle.
     */
    public async run(
        payload: RefinementPayload,
        registry: RegistryState,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        const currentId = ++this.activeId;
        this.sweep = new Array(UI_DEFAULTS.MAX_XP_LEVEL).fill(null);

        const basePayload = {
            cat: payload.category,
            xp: payload.xpLevel,
            mat: payload.material,
            guaranteedFirst: payload.guaranteedFirst
        };
        const isBook = payload.category === "book";

        // Update shared pointers immediately and abort any running chart search
        this.sweepAbortController?.abort();

        // Flush both worker queues to ensure immediate priority for this run and clear any staleness
        if (typeof Worker !== 'undefined') {
            await Promise.all([
                WorkerClient.resetWorker('main', payload.version),
                WorkerClient.resetWorker('chart', payload.version)
            ]);
        }

        const levels: Exclude<SearchLevel, 'done'>[] = ['coarse', 'standard', 'deep', 'ultra'];
        const tiers = levels.map(level => {
            const params = getParamsForMode(level, isBook);
            return { threshold: params.threshold, limit: params.limit };
        });

        callbacks.onStatus(getParamsForMode('coarse', isBook).status, 'coarse');

        let tierIndex = 0;
        let converged = false;

        await WorkerClient.request(
            'getFullStatsProgressive',
            { ...basePayload, source: 'main', tiers },
            (partial) => {
                if (currentId !== this.activeId || converged) return;
                converged = (partial.stats?.accounting?.pending ?? 1) < 1e-9;
                const isFinal = tierIndex === tiers.length - 1 || converged;
                callbacks.onStats(partial.stats, isFinal);
                
                const level = levels[tierIndex];
                this.activeChartLevel = level;
                this.refreshChart(basePayload, getParamsForMode(level, isBook).threshold, registry, currentId, callbacks);
                tierIndex++;
                if (!converged && tierIndex < levels.length) {
                    callbacks.onStatus(getParamsForMode(levels[tierIndex], isBook).status, levels[tierIndex]);
                }
            },
            'main'
        );

        if (currentId !== this.activeId) return;

        callbacks.onStatus(UI_TEXTS.STATUS_COMPLETE, "done");
    }

    private async refreshChart(
        payload: BaseSearchPayload,
        threshold: number,
        _registry: RegistryState,
        currentId: number,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        this.targetThreshold = threshold;
        // In case refinement tier starts faster than run() completes its reset

        if (this.isSweepRunning) return;

        this.isSweepRunning = true;
        try {
            while (true) {
                if (this.activeId !== currentId) break;

                // Capture the threshold for THIS pass
                const currentPassThreshold = this.targetThreshold;
                const labels = Array.from({ length: UI_DEFAULTS.MAX_XP_LEVEL }, (_, i) => i + 1);
                
                const passName = getParamsForMode(this.activeChartLevel, payload.cat === "book").status;
                const statusBase = passName + " probabilities";
                
                callbacks.onChartStatus?.(statusBase);
                for (const l of labels) {
                    // Pre-empt loop ONLY IF a new run (activeId change) was triggered
                    if (this.activeId !== currentId) break;

                    const ctrl = new AbortController();
                    this.sweepAbortController = ctrl;

                    const abortPromise = new Promise<never>((_, reject) => {
                        ctrl.signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
                    });

                    try {
                        const response = await Promise.race([
                            WorkerClient.request(
                                'getFullStats',
                                { ...payload, xp: l, threshold: currentPassThreshold, source: 'chart' },
                                undefined,
                                'chart'
                            ),
                            abortPromise
                        ]) as { stats: CalculationStats };

                        if (this.activeId !== currentId) break;
                        
                        // Overwrite existing index for "zeroing-in" look
                        this.sweep[l - 1] = { l, s: response.stats };
                        callbacks.onChartStatus?.(statusBase, l / UI_DEFAULTS.MAX_XP_LEVEL);
                        callbacks.onChart(this.sweep);
                    } catch (e: any) {
                        if (e.message === 'AbortError') break;
                        throw e;
                    }

                    await AsyncUtils.yield();
                }
                
                callbacks.onChartStatus?.(this.activeChartLevel === 'ultra' ? UI_TEXTS.STATUS_CHART_COMPLETE : "");

                // Termination & Restart conditions
                if (this.activeId !== currentId) break;
                // If targetThreshold is still the same or LARGER (worse), we are done with this tier-loop.
                // If it is SMALLER (better), we loop back to restart the sweep with the better threshold.
                if (this.targetThreshold >= currentPassThreshold) break;
            }
        } finally {
            this.isSweepRunning = false;
        }
    }
}
