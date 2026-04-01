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
        this.isSweepRunning = false;
        this.sweep = new Array(UI_DEFAULTS.MAX_XP_LEVEL).fill(null);

        const basePayload = { 
            cat: payload.category, 
            xp: payload.xpLevel, 
            mat: payload.material, 
            guaranteedFirst: payload.guaranteedFirst 
        };
        const isBook = payload.category === "book";

        // Pass 1: Coarse (Instant)
        const coarseDone = await this.executePass('coarse', basePayload, currentId, isBook, callbacks);
        if (currentId !== this.activeId) return;

        // Trigger initial chart refresh background
        this.refreshChart(basePayload, getParamsForMode('coarse', isBook).threshold, registry, currentId, callbacks);

        // Pass 2+: Standard -> Deep -> Ultra
        const refinementLevels: Exclude<SearchLevel, 'done' | 'coarse'>[] = ['standard', 'deep', 'ultra'];
        
        for (const level of refinementLevels) {
            const done = await this.executePass(level, basePayload, currentId, isBook, callbacks);
            if (currentId !== this.activeId) return;

            // Trigger non-blocking chart update at current pass precision
            this.refreshChart(basePayload, getParamsForMode(level, isBook).threshold, registry, currentId, callbacks);
            
            if (done) break;
        }

        if (currentId === this.activeId) {
            callbacks.onStatus(UI_TEXTS.STATUS_COMPLETE, "done");
        }
    }

    private async executePass(
        level: Exclude<SearchLevel, 'done'>,
        payload: BaseSearchPayload,
        currentId: number,
        isBook: boolean,
        callbacks: RefinementCallbacks
    ): Promise<boolean> {
        const config = getParamsForMode(level, isBook);
        callbacks.onStatus(config.status, level);

        const response = await WorkerClient.request(
            'getFullStats',
            { ...payload, threshold: config.threshold, source: 'main', maxIterations: config.limit },
            (partial) => {
                if (currentId === this.activeId) {
                    callbacks.onStats(partial.stats, false);
                }
            },
            'main'
        );

        if (currentId !== this.activeId) return true;

        callbacks.onStats(response.stats, true);
        return response.stats && response.stats.uncertainty === 0;
    }

    private async refreshChart(
        payload: BaseSearchPayload,
        threshold: number,
        registry: RegistryState,
        currentId: number,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        this.targetThreshold = threshold;
        if (this.isSweepRunning) return;

        this.isSweepRunning = true;
        try {
            while (true) {
                if (currentId !== this.activeId) break;
                
                const activeThreshold = this.targetThreshold;
                const labels = Array.from({ length: UI_DEFAULTS.MAX_XP_LEVEL }, (_, i) => i + 1);
                
                if (callbacks.onChartStatus) {
                    callbacks.onChartStatus(UI_TEXTS.STATUS_CHART_PREPARING);
                }
                
                for (const l of labels) {
                    if (currentId !== this.activeId) break;

                    let response: { stats: CalculationStats };
                    try {
                        response = await WorkerClient.request(
                            'getFullStats',
                            { ...payload, xp: l, threshold: activeThreshold, source: 'chart' },
                            undefined,
                            'chart'
                        );
                    } catch {
                        break; // worker was re-initialized; exit sweep cleanly
                    }

                    if (currentId !== this.activeId) break;
                    
                    this.sweep[l - 1] = { l, s: response.stats };
                    if (callbacks.onChartStatus) {
                        callbacks.onChartStatus(UI_TEXTS.STATUS_CHART_SWEEPING, l / UI_DEFAULTS.MAX_XP_LEVEL);
                    }
                    callbacks.onChart(this.sweep);
                    
                    await AsyncUtils.yield();
                }
                
                if (callbacks.onChartStatus) {
                    callbacks.onChartStatus(""); // Hide on completion
                }

                // If no higher precision was requested while we were sweeping, we are done
                if (currentId !== this.activeId || this.targetThreshold === activeThreshold) break;
            }
        } finally {
            this.isSweepRunning = false;
        }
    }
}
