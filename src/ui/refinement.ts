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

            // Step through refinement levels
            for (let i = 0; i < levels.length; i++) {
                const level = levels[i]!;
                const params = getParamsForMode(level, isBook);
                
                callbacks.onStatus(params.status, level);

                // Start Top Run
                const topPromise = new Promise<TopRunView>((resolve) => {
                    WorkerClient.startTopRun(topInput, [level], (view) => {
                        resolve(view);
                    });
                });

                // Start Chart Run
                WorkerClient.startChartRun(
                    chartInput, 
                    [level], 
                    (cellView) => {
                        this.sweep[cellView.xpLevel - 1] = cellView;
                        callbacks.onChart(this.sweep);
                        callbacks.onChartStatus?.(`${params.status} probabilities`, cellView.xpLevel / xpCap);
                    },
                    () => {
                        if (level === 'ultra') {
                            callbacks.onChartStatus?.(UI_TEXTS.STATUS_CHART_COMPLETE);
                            this.isSweepRunning = false;
                        }
                    }
                );

                const topView = await topPromise;
                callbacks.onStats(topView, level === 'ultra');
            }

            callbacks.onStatus(UI_TEXTS.STATUS_COMPLETE, "done");
        } finally {
            this.isRefining = false;
        }
    }
}
