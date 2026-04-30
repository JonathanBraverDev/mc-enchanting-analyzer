import { 
  RegistryState, 
  TopRunView, 
  ChartCellView, 
  RefinementLevelName,
  TopInputSignature,
  ChartInputSignature
} from '#types/index.js';
import { UI_TEXTS, UI_DEFAULTS, SearchLevel, getParamsForMode } from '#core/config.js';
import { WorkerClient } from '#ui/worker-client.js';

export interface RefinementPayload {
    category: string;
    material: string;
    clue: string | null;
    xpLevel: number;
    version: string;
}

export interface RefinementCallbacks {
    onStatus: (status: string, level: SearchLevel) => void;
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
    private activeRunGeneration: number = 0;

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
        const generation = ++this.activeRunGeneration;
        
        this.isRefining = true;
        this.isSweepRunning = true;
        
        try {
            const xpCap = registry?.mechanics?.xp_cap ?? UI_DEFAULTS.DEFAULT_VIEW_XP_CAP;
            this.sweep = new Array(xpCap).fill(null);

            const topInput: TopInputSignature = {
                category: payload.category,
                xpLevel: payload.xpLevel,
                material: payload.material,
                clue: payload.clue,
                version: payload.version
            };

            const chartInput: ChartInputSignature = {
                category: payload.category,
                material: payload.material,
                clue: payload.clue,
                version: payload.version
            };

            const levels: RefinementLevelName[] = ['coarse', 'standard', 'deep', 'ultra'];
            const isBook = payload.category === 'book';

            // Start Top Run (Single call for all levels)
            WorkerClient.startTopRun(
                topInput, 
                levels, 
                (view) => {
                    if (this.activeRunGeneration !== generation) return;
                    
                    const params = getParamsForMode(view.refinementLevel, isBook);
                    callbacks.onStatus(params.status, view.refinementLevel);
                    callbacks.onStats(view, view.refinementLevel === 'ultra');
                },
                (status, error) => {
                    if (this.activeRunGeneration !== generation) return;
                    
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
                levels, 
                (cellView) => {
                    if (this.activeRunGeneration !== generation) return;
                    
                    this.sweep[cellView.xpLevel - 1] = cellView;
                    callbacks.onChart(this.sweep);
                    
                    const params = getParamsForMode(cellView.refinementLevel, isBook);
                    callbacks.onChartStatus?.(`${params.status} probabilities`, cellView.xpLevel / xpCap);
                },
                (status) => {
                    if (this.activeRunGeneration !== generation) return;
                    
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
                    if (!this.isCalculating() || this.activeRunGeneration !== generation) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 100);
            });

        } finally {
            if (this.activeRunGeneration === generation) {
                this.isRefining = false;
                this.isSweepRunning = false;
            }
        }
    }
}
