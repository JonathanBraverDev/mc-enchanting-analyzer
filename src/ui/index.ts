import { UI_TEXTS } from '#core/config.js';
import { WorkerClient } from '#ui/worker-client.js';
import { ParamsView } from '#ui/views/ParamsView.js';
import { ResultsView } from '#ui/views/ResultsView.js';
import { ChartController } from '#ui/results-chart-controller.js';
import { RefinementService } from '#ui/refinement.js';
import { UiMetadataService } from '#services/UiMetadataService.js';
import { TopRunView } from '#types/index.js';

/**
 * Main Web Application Controller.
 * Orchestrates UI components and delegates calculations to RefinementService.
 */
class AppController {
    public params: ParamsView;
    public results: ResultsView;
    public chart: ChartController;
    public refinement: RefinementService;

    private isWorkerReady: boolean = false;
    private runDebounceTimeout: number = 0;
    private lastView: TopRunView | null = null;

    constructor() {
        this.params = new ParamsView(
            ["v-select", "cat-select", "mat-select", "clue-select", "lvl-range", "chart-metric", "combo-sort"],
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

            this.params.updateConstraints();
            this.params.updateMaterials();
            this.run();
        } catch (err) {
            this.showError(UI_TEXTS.STATUS_ERROR_LOADING, err);
        }
    }

    private onParamsChange(type: string): void {
        const { version } = this.params.getValues();

        if (type === 'v') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_LOADING_VERSION);
            this.isWorkerReady = false;
            WorkerClient.init(version).then(() => {
                this.isWorkerReady = true;
                this.params.updateConstraints();
                this.params.updateMaterials();
                this.params.updateClueTarget();
                this.enqueueRun();
            }).catch(err => this.showError(UI_TEXTS.STATUS_ERROR_LOADING, err));
            return;
        }

        if (type === 'cat') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_SWITCHING_CATEGORY);
            this.params.updateMaterials();
            this.params.updateClueTarget();
        } else if (type === 'mat') {
            this.params.updateClueTarget();
        } else if (type === 'chart-metric') {
            const registry = UiMetadataService.getRegistry(version);
            this.chart.refresh(this.refinement.currentSweep, registry);
            return;
        } else if (type === 'clue') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_REFINING);
        } else if (type === 'combo-sort') {
            if (this.lastView) {
                this.updateInsightsFromView(this.lastView);
            }
            return;
        }

        this.enqueueRun();
    }

    private enqueueRun(): void {
        if (this.runDebounceTimeout) window.clearTimeout(this.runDebounceTimeout);
        this.runDebounceTimeout = window.setTimeout(() => this.run(), 50);
    }

    public get currentSweep() {
        return this.refinement.currentSweep;
    }

    public get chartManager() {
        return this.chart.manager;
    }

    private async run(): Promise<void> {
        if (!this.isWorkerReady) return;

        try {
            this.params.updateClueTarget();

            const vals = this.params.getValues();
            const ench = UiMetadataService.getEnchantability(vals.version, vals.material, vals.category);
            this.params.setEnchantability(ench);

            const registry = UiMetadataService.getRegistry(vals.version);

            await this.refinement.run(
                { ...vals, category: vals.category },
                registry,
                {
                    onStatus: (status, level) => this.results.setRefinementStatus(status, level),
                    onChartStatus: (status, progress) => this.results.setChartStatus(status, progress),
                    onStats: (view) => this.updateInsightsFromView(view),
                    onChart: (sweep) => this.chart.refresh(sweep, registry)
                }
            );
        } catch (err) {
            if (err === 'Aborted' || (err instanceof Error && err.message === 'Aborted')) return;
            this.showError(UI_TEXTS.STATUS_ERROR_CALC, err);
        }
    }

    private updateInsightsFromView(view: TopRunView): void {
        this.lastView = view;
        const { version } = this.params.getValues();
        const registry = UiMetadataService.getRegistry(version);

        this.results.updateV5(view, registry);
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
