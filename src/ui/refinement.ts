import {
  RegistryState,
  TopRunView,
  ChartCellView,
  RefinementLevelName,
  TopInputSignature,
  ChartInputSignature,
  TargetRequirementInput
} from '#types/index.js';
import { UI_TEXTS, UI_DEFAULTS, RefinementStatusLevel, getSearchCheckpointForRefinement } from '#core/config.js';
import { WorkerClient } from '#ui/worker-client.js';

export interface RefinementPayload {
    item: string;
    material: string;
    clue: string | null;
    xpLevel: number;
    version: string;
    targets?: TargetRequirementInput[] | undefined;
}

export interface RefinementCallbacks {
    onStatus: (status: string, level: RefinementStatusLevel) => void;
    onChartStatus?: (status: string, progress?: number) => void;
    onStats: (view: TopRunView, isFinal: boolean) => void;
    onChart: (sweep: ChartCellView[]) => void;
}

/**
 * Service for orchestrating progressive refinement of enchantment calculations.
 * V5 implementation uses the run-based protocol and specialized workers.
 */
export class RefinementService {
    private sweep: ChartCellView[] = [];
    private isRefining: boolean = false;
    private isSweepRunning: boolean = false;
    private activeTopGeneration: number = 0;
    private activeChartGeneration: number = 0;

    public get currentSweep(): ChartCellView[] {
        return this.sweep;
    }

    public isCalculating(): boolean {
        return this.isRefining || this.isSweepRunning;
    }

    public async run(
        payload: RefinementPayload,
        registry: RegistryState,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        const topGeneration = ++this.activeTopGeneration;
        const chartGeneration = ++this.activeChartGeneration;

        this.isRefining = true;
        this.isSweepRunning = true;

        try {
            const xpCap = registry?.mechanics?.xp_cap ?? UI_DEFAULTS.DEFAULT_VIEW_XP_CAP;
            this.sweep = new Array(xpCap).fill(null);

            const topInput: TopInputSignature = {
                item: payload.item,
                xpLevel: payload.xpLevel,
                material: payload.material,
                clue: payload.clue,
                version: payload.version,
                targets: payload.targets
            };

            const chartInput: ChartInputSignature = {
                item: payload.item,
                material: payload.material,
                clue: payload.clue,
                version: payload.version,
                targets: payload.targets
            };

            const refinementLevels: RefinementLevelName[] = ['coarse', 'standard', 'deep', 'ultra'];
            const isBook = payload.item === 'book';
            const initialChartParams = getSearchCheckpointForRefinement(refinementLevels[0]!, isBook);
            callbacks.onChartStatus?.(`${initialChartParams.status} probabilities`, 0);

            // Start Top Run (Single call for all levels)
            WorkerClient.startTopRun(
                topInput,
                refinementLevels,
                (view) => {
                    if (this.activeTopGeneration !== topGeneration) return;

                    const params = getSearchCheckpointForRefinement(view.refinementLevel, isBook);
                    callbacks.onStatus(params.status, view.refinementLevel);
                    callbacks.onStats(view, view.refinementLevel === 'ultra');
                },
                (status, error) => {
                    if (this.activeTopGeneration !== topGeneration) return;

                    this.isRefining = false;
                    if (status === 'done') {
                        callbacks.onStatus(UI_TEXTS.STATUS_COMPLETE, "done");
                    } else if (status === 'error') {
                        console.error("Top run error:", error);
                    }
                }
            );

            // Start Chart Run (Single call for all levels)
            WorkerClient.startChartRun(
                chartInput,
                refinementLevels,
                (cellView) => {
                    if (this.activeChartGeneration !== chartGeneration) return;

                    this.sweep[cellView.xpLevel - 1] = cellView;
                    callbacks.onChart(this.sweep);

                    const params = getSearchCheckpointForRefinement(cellView.refinementLevel, isBook);
                    callbacks.onChartStatus?.(`${params.status} probabilities`, cellView.xpLevel / xpCap);
                },
                (status) => {
                    if (this.activeChartGeneration !== chartGeneration) return;

                    this.isSweepRunning = false;
                    if (status === 'done') {
                        callbacks.onChartStatus?.(UI_TEXTS.STATUS_CHART_COMPLETE);
                    }
                }
            );

            // In v5, we don't await the workers directly here; they drive the UI via callbacks.
            // But we keep the promise active until terminal state if we want run() to represent the lifecycle.
            await new Promise<void>((resolve) => {
                const interval = setInterval(() => {
                    if (!this.isCalculating() || this.activeTopGeneration !== topGeneration || this.activeChartGeneration !== chartGeneration) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 100);
            });

        } finally {
            if (this.activeTopGeneration === topGeneration && this.activeChartGeneration === chartGeneration) {
                this.isRefining = false;
                this.isSweepRunning = false;
            }
        }
    }

    public async runTopOnly(
        payload: RefinementPayload,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        const topGeneration = ++this.activeTopGeneration;
        this.isRefining = true;

        const topInput: TopInputSignature = {
            item: payload.item,
            xpLevel: payload.xpLevel,
            material: payload.material,
            clue: payload.clue,
            version: payload.version,
            targets: payload.targets
        };

        const refinementLevels: RefinementLevelName[] = ['coarse', 'standard', 'deep', 'ultra'];
        const isBook = payload.item === 'book';

        WorkerClient.startTopRun(
            topInput,
            refinementLevels,
            (view) => {
                if (this.activeTopGeneration !== topGeneration) return;

                const params = getSearchCheckpointForRefinement(view.refinementLevel, isBook);
                callbacks.onStatus(params.status, view.refinementLevel);
                callbacks.onStats(view, view.refinementLevel === 'ultra');
            },
            (status, error) => {
                if (this.activeTopGeneration !== topGeneration) return;

                this.isRefining = false;
                if (status === 'done') {
                    callbacks.onStatus(UI_TEXTS.STATUS_COMPLETE, "done");
                } else if (status === 'error') {
                    console.error("Top run error:", error);
                }
            }
        );

        await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (!this.isRefining || this.activeTopGeneration !== topGeneration) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
    }

    public async projectTop(
        payload: RefinementPayload,
        registry: RegistryState,
        callbacks: RefinementCallbacks
    ): Promise<void> {
        const topGeneration = ++this.activeTopGeneration;
        this.isRefining = true;

        const topInput: TopInputSignature = {
            item: payload.item,
            xpLevel: payload.xpLevel,
            material: payload.material,
            clue: payload.clue,
            version: payload.version,
            targets: payload.targets
        };

        const refinementLevels: RefinementLevelName[] = ['coarse', 'standard', 'deep', 'ultra'];
        const isBook = payload.item === 'book';

        WorkerClient.projectTopRun(
            topInput,
            refinementLevels,
            (view) => {
                if (this.activeTopGeneration !== topGeneration) return;

                const params = getSearchCheckpointForRefinement(view.refinementLevel, isBook);
                callbacks.onStatus(params.status, view.refinementLevel);
                callbacks.onStats(view, view.refinementLevel === 'ultra');
            },
            (status, error) => {
                if (this.activeTopGeneration !== topGeneration) return;

                this.isRefining = false;
                if (status === 'done') {
                    callbacks.onStatus(UI_TEXTS.STATUS_COMPLETE, "done");
                } else if (status === 'error') {
                    console.warn("Top projection cache miss:", error);
                    void this.run(payload, registry, callbacks);
                }
            }
        );

        await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (!this.isRefining || this.activeTopGeneration !== topGeneration) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
    }
}
