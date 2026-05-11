import { UI_TEXTS } from '#core/config.js';
import { WorkerClient } from '#ui/worker-client.js';
import { ParamsView } from '#ui/views/ParamsView.js';
import { ResultsView } from '#ui/views/ResultsView.js';
import { ChartController } from '#ui/results-chart-controller.js';
import { RefinementService } from '#ui/refinement.js';
import { TargetClueAdvisorService } from '#services/TargetClueAdvisorService.js';
import { ClueSignalAdvisorService } from '#services/ClueSignalAdvisorService.js';
import { UiMetadataService } from '#services/UiMetadataService.js';
import { getEnchantName } from '#core/registry.js';
import { ChartCellView, RegistryState, TopRunView } from '#types/index.js';

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
    private suppressNextChartRefresh: boolean = false;

    constructor() {
        this.params = new ParamsView(
            ["v-select", "item-select", "material-select", "clue-select", "target-select", "lvl-range", "chart-metric", "combo-sort"],
            (type) => this.onParamsChange(type)
        );
        this.results = new ResultsView();
        this.chart = new ChartController("mainChart", "chart-metric", (level) => this.params.setLevel(level));
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
            this.params.updateItems();
            this.params.updateMaterials();
            this.params.updateClueTarget();
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
                this.params.updateItems();
                this.params.updateMaterials();
                this.params.updateClueTarget();
                this.enqueueRun();
            }).catch(err => this.showError(UI_TEXTS.STATUS_ERROR_LOADING, err));
            return;
        }

        if (type === 'item') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_SWITCHING_ITEM);
            this.params.updateMaterials();
            this.params.updateClueTarget();
        } else if (type === 'material') {
            this.params.updateClueTarget();
        } else if (type === 'chart-metric') {
            const registry = UiMetadataService.getRegistry(version);
            this.chart.refresh(this.refinement.currentSweep, registry);
            return;
        } else if (type === 'clue') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_REFINING);
        } else if (type === 'lvl' || type === 'level-input') {
            if (this.params.getValues().sortMode === 'advisor' && this.tryRefreshAdvisorFromSweepForCurrentLevel()) {
                return;
            }
            this.results.showPlaceholder(UI_TEXTS.STATUS_REFINING);
            this.enqueueTopRun();
            return;
        } else if (type === 'combo-sort') {
            const vals = this.params.getValues();
            if (vals.sortMode === 'advisor' && vals.targets.length > 0) {
                this.results.showPlaceholder(UI_TEXTS.STATUS_REFINING);
                this.suppressNextChartRefresh = true;
                this.enqueueRun();
                return;
            }
            if (this.lastView) {
                this.updateInsightsFromView(this.lastView);
            }
            return;
        } else if (type === 'target') {
            this.results.showPlaceholder(UI_TEXTS.STATUS_REFINING);
            if (this.params.getValues().sortMode === 'advisor') {
                this.suppressNextChartRefresh = true;
                this.enqueueRun();
                return;
            }
            if (!this.refinement.isCalculating() && this.lastView) {
                void this.projectTargets();
                return;
            }
        }

        this.enqueueRun();
    }

    private enqueueRun(): void {
        if (this.runDebounceTimeout) window.clearTimeout(this.runDebounceTimeout);
        if (!this.suppressNextChartRefresh) {
            this.results.setChartStatus(`${UI_TEXTS.STATUS_SEARCHING} probabilities`, 0);
        }
        this.runDebounceTimeout = window.setTimeout(() => this.run(), 50);
    }

    private enqueueTopRun(): void {
        if (this.runDebounceTimeout) window.clearTimeout(this.runDebounceTimeout);
        this.runDebounceTimeout = window.setTimeout(() => this.runTopOnly(), 50);
    }

    public get currentSweep() {
        return this.refinement.currentSweep;
    }

    public get chartManager() {
        return this.chart.manager;
    }

    private async run(): Promise<void> {
        if (!this.isWorkerReady) return;
        this.lastView = null;
        const suppressChartRefresh = this.suppressNextChartRefresh;
        this.suppressNextChartRefresh = false;

        try {
            this.params.updateClueTarget();

            const vals = this.params.getValues();
            const ench = UiMetadataService.getEnchantability(vals.version, vals.material, vals.item);
            this.params.setEnchantability(ench);

            const registry = UiMetadataService.getRegistry(vals.version);

            await this.refinement.run(
                vals,
                registry,
                {
                    onStatus: (status, level) => this.results.setRefinementStatus(status, level),
                    onChartStatus: (status, progress) => {
                        if (!suppressChartRefresh) this.results.setChartStatus(status, progress);
                    },
                    onStats: (view) => this.updateInsightsFromView(view),
                    onChart: (sweep) => {
                        if (!suppressChartRefresh) this.chart.refresh(sweep, registry);
                        this.refreshLastViewIfAdvisorMode();
                    }
                }
            );
        } catch (err) {
            if (err === 'Aborted' || (err instanceof Error && err.message === 'Aborted')) return;
            this.showError(UI_TEXTS.STATUS_ERROR_CALC, err);
        }
    }

    private async runTopOnly(): Promise<void> {
        if (!this.isWorkerReady) return;
        this.lastView = null;

        try {
            this.params.updateClueTarget();

            const vals = this.params.getValues();
            const ench = UiMetadataService.getEnchantability(vals.version, vals.material, vals.item);
            this.params.setEnchantability(ench);

            await this.refinement.runTopOnly(
                vals,
                {
                    onStatus: (status, level) => this.results.setRefinementStatus(status, level),
                    onChartStatus: (status, progress) => this.results.setChartStatus(status, progress),
                    onStats: (view) => this.updateInsightsFromView(view),
                    onChart: () => {
                        this.refreshLastViewIfAdvisorMode();
                    }
                }
            );
        } catch (err) {
            if (err === 'Aborted' || (err instanceof Error && err.message === 'Aborted')) return;
            this.showError(UI_TEXTS.STATUS_ERROR_CALC, err);
        }
    }

    private async projectTargets(): Promise<void> {
        if (!this.isWorkerReady) return;

        try {
            const vals = this.params.getValues();
            const registry = UiMetadataService.getRegistry(vals.version);

            await this.refinement.projectTop(
                vals,
                registry,
                {
                    onStatus: (status, level) => this.results.setRefinementStatus(status, level),
                    onChartStatus: () => {},
                    onStats: (view) => this.updateInsightsFromView(view),
                    onChart: () => {
                        this.refreshLastViewIfAdvisorMode();
                    }
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
        const sortMode = this.params.getValues().sortMode;

        this.results.updateRunView(
            view,
            registry,
            sortMode === 'advisor' ? TargetClueAdvisorService.summarizeSweep(this.refinement.currentSweep) : undefined,
            sortMode === 'advisor' && !view.target
                ? ClueSignalAdvisorService.summarizeLevels(
                    registry,
                    view.input.item,
                    view.input.material,
                    UiMetadataService.getXpCap(version)
                )
                : undefined,
            sortMode
        );
    }

    private refreshLastViewIfAdvisorMode(): void {
        if (!this.lastView) return;
        if (this.params.getValues().sortMode !== 'advisor') return;
        this.updateInsightsFromView(this.lastView);
    }

    private tryRefreshAdvisorFromSweepForCurrentLevel(): boolean {
        this.params.updateClueTarget();

        const vals = this.params.getValues();
        const registry = UiMetadataService.getRegistry(vals.version);
        const ench = UiMetadataService.getEnchantability(vals.version, vals.material, vals.item);
        this.params.setEnchantability(ench);

        const cell = this.refinement.currentSweep[vals.xpLevel - 1];
        if (!cell || (!cell.target && !cell.clueAdvisor)) return false;

        this.updateInsightsFromView(this.createAdvisorTopViewFromChartCell(cell, registry));
        return true;
    }

    private createAdvisorTopViewFromChartCell(cell: ChartCellView, registry: RegistryState): TopRunView {
        const vals = this.params.getValues();
        const enchants = Object.entries(cell.buckets.anyByEnchantId)
            .map(([id, share]) => {
                const enchantId = Number(id);
                return {
                    enchantId,
                    label: getEnchantName(registry, enchantId),
                    share
                };
            })
            .sort((a, b) => b.share - a.share);

        return {
            input: {
                item: vals.item,
                material: vals.material,
                clue: vals.clue,
                xpLevel: vals.xpLevel,
                version: vals.version,
                targets: vals.targets
            },
            refinementLevel: cell.refinementLevel,
            clueConditioned: cell.clueConditioned,
            normalization: cell.normalization,
            accounting: cell.accounting ?? {
                resolved: 0,
                clueIncompatible: 0,
                pending: 0,
                sieved: 0,
                overflow: 0,
                capped: 0,
                rounding: 0
            },
            combos: [],
            enchants,
            target: cell.target,
            clueAdvisor: cell.clueAdvisor,
            clueSignalAdvisor: cell.clueSignalAdvisor
        };
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
