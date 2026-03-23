import { Registry } from '../core/registry.js';
import { UI_TEXTS, UI_DEFAULTS, SearchLevel, getParamsForMode } from '../core/config.js';
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
    onInsights: (human: any, isFinal?: boolean) => void;
    onChart: (sweep: any[]) => void;
}

/**
 * Service for orchestrating progressive refinement of enchantment calculations.
 */
export class RefinementService {
    private activeId: number = 0;
    private sweep: any[] = [];

    public get currentSweep(): any[] {
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
        this.sweep = [];

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

        // Trigger initial chart refresh after coarse pass
        await this.refreshChart(basePayload, getParamsForMode('coarse', isBook).threshold, registry, currentId, callbacks);
        if (currentId !== this.activeId) return;

        // Pass 2+: Standard -> Deep -> Ultra
        const refinementLevels: Exclude<SearchLevel, 'done' | 'coarse'>[] = ['standard', 'deep', 'ultra'];
        
        for (const level of refinementLevels) {
            const done = await this.executePass(level, basePayload, currentId, isBook, callbacks);
            if (currentId !== this.activeId) return;

            // Update chart after standard pass or if refinement completes early
            if (level === 'standard' || done) {
                this.refreshChart(basePayload, getParamsForMode(level, isBook).threshold, registry, currentId, callbacks);
            }
            
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
                    callbacks.onInsights(partial.human, false);
                }
            }
        );

        if (currentId !== this.activeId) return true;

        callbacks.onInsights(response.human, true);
        return response.stats && response.stats.uncertainty === 0;
    }

    private async refreshChart(
        payload: any,
        threshold: number,
        registry: Registry,
        currentId: number,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        const labels = Array.from({ length: UI_DEFAULTS.MAX_XP_LEVEL }, (_, i) => i + 1);

        for (let i = 0; i < labels.length; i++) {
            if (currentId !== this.activeId) return;

            const stats = await WorkerClient.request(
                'getFullStats',
                { ...payload, xp: labels[i], threshold, source: 'chart' }
            );

            if (currentId !== this.activeId) return;
            
            this.sweep[i] = { l: labels[i], s: stats.stats };
            callbacks.onChart(this.sweep);
            
            // Allow UI to breathe if this is a long sweep
            if (i % 5 === 0) await AsyncUtils.yield();
        }
    }
}
