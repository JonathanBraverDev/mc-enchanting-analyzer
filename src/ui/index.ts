import { DATA } from '../core/data.js';
import { EnchantEngine } from '../engine/index.js';
import { UI_DEFAULTS, getParamsForMode, UI_TEXTS, SearchLevel } from '../core/config.js';
import { WorkerClient } from '../worker/client.js';
import { ParamsManager } from './params.js';
import { ResultsManager } from './results.js';
import { ChartController } from './chart.js';

/**
 * Main Web Application Controller.
 * Orchestrates UI components, Worker communication, and calculation refinement.
 */
class AppController {
    public params: ParamsManager;
    public results: ResultsManager;
    public chart: ChartController;
    
    public engine: EnchantEngine | null = null;
    public activeRefinementId: number = 0;
    private isWorkerReady: false | true = false;
    private lastRunParams = { version: "", cat: "", mat: "", guaranteedFirst: "" };
    public currentSweep: any[] = [];
    private bestUncertainty: number = 1.1;
    private bestInsights: any = null;
    private runDebounceTimeout: number = 0;

    public get chartManager() {
        return this.chart.manager;
    }

    constructor() {
        this.params = new ParamsManager(
            ["v-select", "cat-select", "mat-select", "guaranteed-first-select", "lvl-range", "chart-metric", "combo-sort"],
            (type) => this.onParamsChange(type)
        );
        this.results = new ResultsManager();
        this.chart = new ChartController("mainChart", "chart-metric");
    }

    public async init(): Promise<void> {
        // Initial branding
        document.title = UI_TEXTS.PAGE_TITLE;
        const logoSpan = document.querySelector('.logo span');
        if (logoSpan) logoSpan.textContent = UI_TEXTS.LOGO_TEXT;

        const { version } = this.params.getValues();
        await WorkerClient.init(version);
        this.isWorkerReady = true;

        this.params.updateMaterials(this.getEngine());
        this.run();
    }

    private getEngine(): EnchantEngine {
        const { version } = this.params.getValues();
        if (!this.engine || this.engine.registry.version !== version) {
            this.engine = new EnchantEngine(DATA, version);
        }
        return this.engine;
    }

    private onParamsChange(type: string): void {
        const { version, category } = this.params.getValues();

        if (type === 'v') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_LOADING_VERSION);
            this.isWorkerReady = false;
            WorkerClient.init(version).then(() => {
                this.isWorkerReady = true;
                this.params.updateMaterials(this.getEngine());
                this.params.updateGuaranteedFirst(this.getEngine());
                this.run();
            });
            return;
        }

        if (type === 'cat') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_SWITCHING_CATEGORY);
            this.params.updateMaterials(this.getEngine());
            this.params.updateGuaranteedFirst(this.getEngine());
        }

        if (type === 'mat') {
            this.params.updateGuaranteedFirst(this.getEngine());
        }

        if (type === 'chart-metric') {
            this.chart.refresh(this.currentSweep, this.getEngine().registry);
            return;
        }

        if (type === 'combo-sort') {
            this.updateInsights(this.bestInsights, true);
            return;
        }

        if (type === 'level-input') {
            if (this.runDebounceTimeout) clearTimeout(this.runDebounceTimeout);
            this.runDebounceTimeout = window.setTimeout(() => this.run(), UI_DEFAULTS.INPUT_DEBOUNCE_MS);
            return;
        }

        this.run();
    }

    private async run(): Promise<void> {
        if (!this.isWorkerReady) return;

        this.params.updateGuaranteedFirst(this.getEngine());
        const { version, category, material, guaranteedFirst, xpLevel } = this.params.getValues();
        const engine = this.getEngine();

        // Update UI-side only info
        const enchValEl = document.getElementById("ench-val");
        if (enchValEl) enchValEl.textContent = engine.registry.getEnchantability(material, category).toString();

        const currentId = ++this.activeRefinementId;
        const paramsChanged = this.lastRunParams.version !== version ||
                              this.lastRunParams.cat !== category || 
                              this.lastRunParams.mat !== material || 
                              this.lastRunParams.guaranteedFirst !== guaranteedFirst;

        if (paramsChanged) {
            this.currentSweep = [];
            this.bestUncertainty = 1.1;
            this.lastRunParams = { version, cat: category, mat: material, guaranteedFirst };
        }

        const basePayload = { cat: category, xp: xpLevel, mat: material, guaranteedFirst };
        const isBook = category === "book";

        // Refinement Pass 1: Coarse (Instant)
        await this.executeRefinementPass('coarse', basePayload, currentId, isBook, false);
        if (currentId !== this.activeRefinementId) return;

        if (paramsChanged) {
            const config = getParamsForMode('coarse', isBook);
            await this.refreshChart(basePayload, config.threshold);
        }
        if (currentId !== this.activeRefinementId) return;

        // Standard → Deep → Ultra
        for (const level of ['standard', 'deep', 'ultra'] as Exclude<SearchLevel, 'done'>[]) {
            const done = await this.executeRefinementPass(level, basePayload, currentId, isBook, false);
            if (currentId !== this.activeRefinementId || done) {
                if (paramsChanged && (level === 'standard' || done)) {
                    const config = getParamsForMode(level, isBook);
                    this.refreshChart(basePayload, config.threshold);
                }
                break;
            }
        }

        if (currentId === this.activeRefinementId) {
            this.results.setRefinementStatus(UI_TEXTS.STATUS_COMPLETE, "done");
        }
    }

    private async executeRefinementPass(
        level: Exclude<SearchLevel, 'done'>,
        payload: any,
        currentId: number,
        isBook: boolean,
        updateChart: boolean
    ): Promise<boolean> {
        const config = getParamsForMode(level, isBook);
        this.results.setRefinementStatus(config.status, level);

        const response = await WorkerClient.request(
            'getFullStats',
            { ...payload, threshold: config.threshold, source: 'main', useBestCache: true, maxIterations: config.limit },
            (partial) => {
                if (currentId === this.activeRefinementId) {
                    this.updateInsights(partial.human);
                }
            }
        );

        if (currentId !== this.activeRefinementId) return true;

        this.updateInsights(response.human, true);

        if (updateChart) {
            this.refreshChart(payload, config.threshold);
        }

        return response.stats && response.stats.uncertainty === 0;
    }

    private updateInsights(human: any, force: boolean = false): void {
        const uncertainty = human.uncertainty ?? 1;
        if (!force && uncertainty > this.bestUncertainty + 0.0001) return;
        
        this.bestInsights = human;
        this.bestUncertainty = uncertainty;
        
        const sortMode = (document.getElementById("combo-sort") as HTMLSelectElement).value;
        this.results.updateInsights(human, this.getEngine().registry, sortMode);
    }

    private async refreshChart(payload: any, threshold: number): Promise<void> {
        const currentId = this.activeRefinementId;
        const labels = Array.from({length: UI_DEFAULTS.MAX_XP_LEVEL}, (_, i) => i + 1);

        for (let i = 0; i < labels.length; i++) {
            if (currentId !== this.activeRefinementId) return;
            
            const stats = await WorkerClient.request(
                'getFullStats', 
                { ...payload, xp: labels[i], threshold, source: 'chart' }
            );
            
            if (currentId !== this.activeRefinementId) return;
            this.currentSweep[i] = { l: labels[i], s: stats.stats };
            this.chart.refresh(this.currentSweep, this.getEngine().registry);
        }
    }
}

window.onload = () => {
    const app = new AppController();
    app.init();
    (window as any).App = app;
    (window as any).UIController = app; // Backward compatibility for tests
};
