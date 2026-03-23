import { DATA } from '../core/data.js';
import { EnchantEngine } from '../engine/index.js';
import { UI_DEFAULTS, UI_TEXTS } from '../core/config.js';
import { WorkerClient } from '../worker/client.js';
import { ParamsManager } from './params.js';
import { ResultsManager } from './results.js';
import { ChartController } from './chart.js';
import { RefinementService } from './refinement.js';

/**
 * Main Web Application Controller.
 * Orchestrates UI components and delegates calculations to RefinementService.
 */
class AppController {
    public params: ParamsManager;
    public results: ResultsManager;
    public chart: ChartController;
    public refinement: RefinementService;
    
    public engine: EnchantEngine | null = null;
    private isWorkerReady: boolean = false;
    private runDebounceTimeout: number = 0;
    private bestInsights: any = null;

    public get chartManager() {
        return this.chart.manager;
    }

    public get currentSweep() {
        return this.refinement.currentSweep;
    }

    constructor() {
        this.params = new ParamsManager(
            ["v-select", "cat-select", "mat-select", "guaranteed-first-select", "lvl-range", "chart-metric", "combo-sort"],
            (type) => this.onParamsChange(type)
        );
        this.results = new ResultsManager();
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
                this.params.updateMaterials(this.getEngine());
                this.params.updateGuaranteedFirst(this.getEngine());
                this.run();
            }).catch(err => this.showError(UI_TEXTS.STATUS_ERROR_LOADING, err));
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
            this.chart.refresh(this.refinement['sweep'] || [], this.getEngine().registry);
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

        try {
            const engine = this.getEngine();
            this.params.updateGuaranteedFirst(engine);
            
            const vals = this.params.getValues();
            const enchValEl = document.getElementById("ench-val");
            if (enchValEl) enchValEl.textContent = engine.registry.getEnchantability(vals.material, vals.category).toString();

            await this.refinement.run(
                { ...vals, category: vals.category },
                engine.registry,
                {
                    onStatus: (status, level) => this.results.setRefinementStatus(status, level),
                    onInsights: (human, isFinal) => this.updateInsights(human, isFinal),
                    onChart: (sweep) => this.chart.refresh(sweep, engine.registry)
                }
            );
        } catch (err) {
            this.showError(UI_TEXTS.STATUS_ERROR_CALC, err);
        }
    }

    private updateInsights(human: any, isFinal: boolean = false): void {
        const uncertainty = human.uncertainty ?? 1;
        if (isFinal || (this.bestInsights && uncertainty < (this.bestInsights.uncertainty || 1))) {
            this.bestInsights = human;
            const sortMode = (document.getElementById("combo-sort") as HTMLSelectElement).value;
            this.results.updateInsights(human, this.getEngine().registry, sortMode);
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
