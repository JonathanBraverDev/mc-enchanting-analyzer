import { DATA } from '../core/data.js';
import { EnchantEngine } from '../engine/index.js';
import { UI_TEXTS } from '../core/config.js';
import { WorkerClient } from '../worker/client.js';
import { ParamsView } from './views/ParamsView.js';
import { ResultsView } from './views/ResultsView.js';
import { ChartController } from './chart.js';
import { RefinementService } from './refinement.js';
import { ResultProcessor } from '../utils/results.js';
import { EnchantInsights } from '../utils/types.js';

/**
 * Main Web Application Controller.
 * Orchestrates UI components and delegates calculations to RefinementService.
 */
class AppController {
    public params: ParamsView;
    public results: ResultsView;
    public chart: ChartController;
    public refinement: RefinementService;
    
    public engine: EnchantEngine | null = null;
    private isWorkerReady: boolean = false;
    private runDebounceTimeout: number = 0;
    private bestInsights: EnchantInsights | null = null;

    constructor() {
        this.params = new ParamsView(
            ["v-select", "cat-select", "mat-select", "guaranteed-first-select", "lvl-range", "chart-metric", "combo-sort"],
            (type) => this.onParamsChange(type)
        );
        this.results = new ResultsView();
        this.chart = new ChartController("mainChart", "chart-metric");
        this.refinement = new RefinementService();
    }

    public async init(): Promise<void> {
        try {
            document.title = UI_TEXTS.PAGE_TITLE;
            const logoSpan = document.querySelector('.logo span');
            if (logoSpan) logoSpan.textContent = UI_TEXTS.LOGO_TEXT;

            const { version } = this.params.getValues();
            await WorkerClient.init(version);
            this.isWorkerReady = true;

            this.params.updateMaterials(this.getEngine());
            this.run();
        } catch (err) {
            this.showError(UI_TEXTS.STATUS_ERROR_LOADING, err);
        }
    }

    private getEngine(): EnchantEngine {
        const { version } = this.params.getValues();
        if (!this.engine || this.engine.registry.version !== version) {
            this.engine = new EnchantEngine(DATA, version);
        }
        return this.engine;
    }

    private onParamsChange(type: string): void {
        const { version } = this.params.getValues();

        if (type === 'v') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_LOADING_VERSION);
            this.isWorkerReady = false;
            WorkerClient.init(version).then(() => {
                this.isWorkerReady = true;
                const engine = this.getEngine();
                this.params.updateMaterials(engine);
                this.params.updateGuaranteedFirst(engine);
                this.run();
            }).catch(err => this.showError(UI_TEXTS.STATUS_ERROR_LOADING, err));
            return;
        }

        const engine = this.getEngine();

        if (type === 'cat') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_SWITCHING_CATEGORY);
            this.params.updateMaterials(engine);
            this.params.updateGuaranteedFirst(engine);
        }

        if (type === 'mat') {
            this.params.updateGuaranteedFirst(engine);
        }

        if (type === 'chart-metric') {
            this.chart.refresh(this.refinement.currentSweep, engine.registry);
            return;
        }

        if (type === 'combo-sort') {
            this.updateInsightsFromRaw(this.lastRawStats, true);
            return;
        }

        if (type === 'level-input') {
            if (this.runDebounceTimeout) clearTimeout(this.runDebounceTimeout);
            this.runDebounceTimeout = window.setTimeout(() => this.run(), 50);
            return;
        }

        this.run();
    }

    private lastRawStats: any = null;

    public get currentSweep() {
        return this.refinement.currentSweep;
    }

    public get chartManager() {
        return this.chart.manager;
    }

    private async run(): Promise<void> {
        if (!this.isWorkerReady) return;

        try {
            const engine = this.getEngine();
            this.params.updateGuaranteedFirst(engine);
            
            const vals = this.params.getValues();
            this.params.setEnchantability(engine.registry.getEnchantability(vals.material, vals.category));

            await this.refinement.run(
                { ...vals, category: vals.category },
                engine.registry,
                {
                    onStatus: (status, level) => this.results.setRefinementStatus(status, level),
                    onInsights: (raw, isFinal) => this.updateInsightsFromRaw(raw, isFinal),
                    onChart: (sweep) => this.chart.refresh(sweep, engine.registry)
                }
            );
        } catch (err) {
            this.showError(UI_TEXTS.STATUS_ERROR_CALC, err);
        }
    }

    private updateInsightsFromRaw(raw: any, isFinal: boolean = false): void {
        if (!raw) return;
        this.lastRawStats = raw;

        const { sortMode } = this.params.getValues();
        const insights = ResultProcessor.humanize(raw, this.getEngine().registry, sortMode as any, DATA.constants.ROMAN_MAP);
        
        const uncertainty = insights.uncertainty ?? 1;
        if (isFinal || (this.bestInsights && uncertainty < (this.bestInsights.uncertainty || 1)) || !this.bestInsights) {
            this.bestInsights = insights;
            this.results.update(insights, this.getEngine().registry);
        }
    }

    private showError(title: string, err: any): void {
        console.error(title, err);
        this.results.showPlaceholder(`${title}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

window.onload = () => {
    const app = new AppController();
    app.init();
    (window as any).App = app;
    (window as any).UIController = app; // Backward compatibility for tests
};
