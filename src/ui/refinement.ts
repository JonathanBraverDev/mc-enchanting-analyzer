import { RegistryState, CalculationStats, SweepData } from '../lib/types/index.js';
import { UI_TEXTS, UI_DEFAULTS, SearchLevel, getParamsForMode } from '../lib/core/config.js';
import { WorkerClient } from '../worker/client.js';
import { AsyncUtils } from '../lib/utils/index.js';

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
    private nextPendingRedraw: { threshold: number; level: Exclude<SearchLevel, 'done'> } | null = null;
    private sweepAbortController: AbortController | null = null;
    private activeChartLevel: Exclude<SearchLevel, 'done'> = 'coarse';

    private isRefining: boolean = false;

    public get currentSweep(): SweepData[] {
        return this.sweep;
    }

    /**
     * Returns true if either the main refinement or the chart sweep is active.
     */
    public isCalculating(): boolean {
        return this.isSweepRunning || this.isRefining;
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
        this.isRefining = true;
        try {
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
            this.nextPendingRedraw = null; // CRITICAL: Clear pending redraws from PREVIOUS items/categories

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
                    
                    if (partial.update) {
                        // Intermediate progress could be handled here if needed
                        return;
                    }

                    const stats = partial.stats!;
                    converged = (stats.accounting?.pending ?? 1) < 1e-9;
                    const isFinal = tierIndex === tiers.length - 1 || converged;
                    callbacks.onStats(stats, isFinal);
                    
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
        } finally {
            if (currentId === this.activeId) {
                this.isRefining = false;
            }
        }
    }

    /**
     * Internal coordinator for chart redraws. 
     * COMPRESSING QUEUE: We ensure EVERY started redraw completes a full pass (1-30).
     * If multiple redraw requests arrive during a sweep, we only keep the LATEST one.
     */
    private async refreshChart(
        payload: BaseSearchPayload,
        threshold: number,
        _registry: RegistryState,
        currentId: number,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        // Enqueue/Overwrite the latest tier request
        this.nextPendingRedraw = { threshold, level: this.activeChartLevel };

        if (this.isSweepRunning) return;

        this.isSweepRunning = true;
        try {
            while (this.nextPendingRedraw !== null) {
                // Pre-empt loop ONLY IF a new run (activeId change) was triggered
                if (this.activeId !== currentId) break;

                // Capture the LATEST pending request and clear the slot
                const currentPass = this.nextPendingRedraw;
                this.nextPendingRedraw = null;
                
                const currentPassThreshold = currentPass.threshold;
                const labels = Array.from({ length: UI_DEFAULTS.MAX_XP_LEVEL }, (_, i) => i + 1);
                
                const passName = getParamsForMode(currentPass.level, payload.cat === "book").status;
                const statusBase = passName + " probabilities";
                
                // IMPORTANT: We do a FULL PASS for every STARTED redraw. 
                // Aborting mid-sweep is forbidden as it causes UI progress "jitter" and test failures.
                callbacks.onChartStatus?.(statusBase);
                for (const l of labels) {
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
                        
                        this.sweep[l - 1] = { l, s: response.stats };
                        callbacks.onChartStatus?.(statusBase, l / UI_DEFAULTS.MAX_XP_LEVEL);
                        callbacks.onChart(this.sweep);
                    } catch (e: any) {
                        if (e.message === 'AbortError') break;
                        throw e;
                    }

                    await AsyncUtils.yield();
                }
                
                // Final status for THIS pass (unless a new one was queued or it was ultra)
                const isTerminal = currentPass.level === 'ultra' && this.nextPendingRedraw === null;
                callbacks.onChartStatus?.(isTerminal ? UI_TEXTS.STATUS_CHART_COMPLETE : "");
            }
        } finally {
            this.isSweepRunning = false;
        }
    }
}
