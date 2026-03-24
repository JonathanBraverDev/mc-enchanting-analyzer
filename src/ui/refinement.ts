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
    onInsights: (human: EnchantInsights, isFinal?: boolean) => void;
    onChart: (sweep: SweepData[]) => void;
}

/**
 * Service for orchestrating progressive refinement of enchantment calculations.
 */
export class RefinementService {
    private activeId: number = 0;
    private sweep: SweepData[] = [];

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

        // Trigger initial chart refresh after coarse pass
        this.refreshChart(basePayload, getParamsForMode('coarse', isBook).threshold, registry, currentId, callbacks);
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
        const labels = Array.from({ length: UI_DEFAULTS.MAX_XP_LEVEL }, (_, i) => i + 1);
        
        // Prioritize the current XP level
        const currentXP = payload.xp;
        const remainingLabels = labels.filter(l => l !== currentXP);
        const order = [currentXP, ...remainingLabels];

        for (const l of order) {
            if (currentId !== this.activeId) return;

            const stats = await WorkerClient.request(
                'getFullStats',
                { ...payload, xp: l, threshold, source: 'chart' }
            );

            if (currentId !== this.activeId) return;
            
            this.sweep[l - 1] = { l, s: stats.stats };
            callbacks.onChart(this.sweep);
            
            // Allow UI to breathe
            await AsyncUtils.yield();
        }
    }
}
