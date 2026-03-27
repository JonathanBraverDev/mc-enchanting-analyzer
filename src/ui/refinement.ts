import { Registry } from '../core/registry.js';
import { UI_TEXTS, UI_DEFAULTS, SearchLevel, getParamsForMode } from '../core/config.js';
import { EnchantInsights, SweepData } from '../types/index.js';
import { WorkerClient } from '../worker/client.js';
import { AsyncUtils } from '../utils/index.js';

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
    onInsights: (insights: any, isFinal: boolean) => void;
    onChart: (sweep: any[]) => void;
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
        registry: Registry,
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
        payload: any,
        currentId: number,
        isBook: boolean,
        callbacks: RefinementCallbacks
    ): Promise<boolean> {
        const config = getParamsForMode(level, isBook);
        callbacks.onStatus(config.status, level);

        const response = await WorkerClient.request(
            'getFullStats',
            { ...payload, threshold: config.threshold, source: 'main', useBestCache: true, maxIterations: config.limit },
            (partial) => {
                if (currentId === this.activeId) {
                    callbacks.onInsights(partial.stats, false);
                }
            }
        );

        if (currentId !== this.activeId) return true;

        callbacks.onInsights(response.stats, true);
        return response.stats && response.stats.uncertainty === 0;
    }

    private async refreshChart(
        payload: any,
        threshold: number,
        registry: Registry,
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
                    
                    const response = await WorkerClient.request(
                        'getFullStats',
                        { ...payload, xp: l, threshold: activeThreshold, source: 'chart' }
                    );
                    
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
