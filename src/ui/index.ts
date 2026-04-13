import { DATA } from '../lib/data/index.js';
import { EnchantEngine, EngineFactory } from '../lib/engine/index.js';
import { UI_TEXTS } from '../lib/core/config.js';
import { WorkerClient } from '../worker/client.js';
import { ParamsView } from './views/ParamsView.js';
import { ResultsView } from './views/ResultsView.js';
import { ChartController } from './chart.js';
import { RefinementService } from './refinement.js';
import { HumanizationService } from '../lib/services/index.js';
import { getEnchantability } from '../lib/core/registry.js';
import { EnchantInsights, CalculationStats, ResultSortMode } from '../lib/types/index.js';

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
            if (this.engine) this.engine.destroy();
            this.engine = EngineFactory.create(DATA, version);
        }
        return this.engine!;
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
                this.enqueueRun();
            }).catch(err => this.showError(UI_TEXTS.STATUS_ERROR_LOADING, err));
            return;
        }

        const engine = this.getEngine();

        if (type === 'cat') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_SWITCHING_CATEGORY);
            this.params.updateMaterials(engine);
            this.params.updateGuaranteedFirst(engine);
        } else if (type === 'mat') {
            this.params.updateGuaranteedFirst(engine);
        } else if (type === 'chart-metric') {
            this.chart.refresh(this.refinement.currentSweep, engine.registry);
            return;
        } else if (type === 'combo-sort') {
            this.updateInsightsFromRaw(this.lastRawStats, true);
            return;
        }

        this.enqueueRun();
    }

    private enqueueRun(): void {
        if (this.runDebounceTimeout) window.clearTimeout(this.runDebounceTimeout);
        this.runDebounceTimeout = window.setTimeout(() => this.run(), 50);
    }

    private lastRawStats: CalculationStats | null = null;

    public get currentSweep() {
        return this.refinement.currentSweep;
    }

    public get chartManager() {
        return this.chart.manager;
    }

    private async run(): Promise<void> {
        if (!this.isWorkerReady) return;
        this.bestInsights = null;

        try {
            const engine = this.getEngine();
            this.params.updateGuaranteedFirst(engine);
            
            const vals = this.params.getValues();
            this.params.setEnchantability(getEnchantability(engine.registry, vals.material, vals.category));

            await this.refinement.run(
                { ...vals, category: vals.category },
                engine.registry,
                {
                    onStatus: (status, level) => this.results.setRefinementStatus(status, level),
                    onChartStatus: (status, progress) => this.results.setChartStatus(status, progress),
                    onStats: (raw, isFinal) => this.updateInsightsFromRaw(raw, isFinal),
                    onChart: (sweep) => this.chart.refresh(sweep, engine.registry)
                }
            );
        } catch (err) {
            if (err === 'Aborted' || (err instanceof Error && err.message === 'Aborted')) return;
            this.showError(UI_TEXTS.STATUS_ERROR_CALC, err);
        }
    }

    private updateInsightsFromRaw(raw: CalculationStats | null, isFinal: boolean = false): void {
        const engine = this.getEngine();
        if (!raw) {
            if (isFinal) this.results.showNoResults();
            return;
        }
        
        this.lastRawStats = raw;

        const { sortMode } = this.params.getValues();
        const insights = HumanizationService.humanize(raw, engine.registry, sortMode as ResultSortMode, DATA.constants.ROMAN_MAP);
        
        const pending = insights.accounting.pending;
        if (isFinal || (this.bestInsights && pending < this.bestInsights.accounting.pending) || !this.bestInsights) {
            this.bestInsights = insights;
            this.results.update(insights, engine.registry);
        }
    }

    private showError(title: string, err: unknown): void {
        console.error(title, err);
        this.results.showPlaceholder(`${title}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

declare global {
    interface Window {
        App: AppController;
    }
}

window.addEventListener("load", () => {
    const app = new AppController();
    app.init();
    window.App = app;
});
