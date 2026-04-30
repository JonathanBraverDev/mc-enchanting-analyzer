import { 
  WorkerRequest, 
  WorkerResponse, 
  RunId, 
  TopInputSignature, 
  ChartInputSignature, 
  RefinementLevelName,
  TopRunView,
  ChartCellView,
  RequestId
} from '#types/index.js';

type TopUpdateCallback = (view: TopRunView) => void;
type ChartUpdateCallback = (view: ChartCellView) => void;
type TerminalCallback = () => void;

/**
 * Client wrapper around the Enchant Engine Web Workers.
 * Manages dual workers (Top and Chart) to enable parallel refinement and sweeps.
 * Implements the v5 run-based protocol with automatic supersession.
 */
export const WorkerClient = {
    workers: {
        top: null as Worker | null,
        chart: null as Worker | null
    },
    
    callbacks: {
        top: new Map<RunId, TopUpdateCallback>(),
        chart: new Map<RunId, ChartUpdateCallback>(),
        terminal: new Map<RunId, TerminalCallback>()
    },

    activeRunIds: {
        top: null as RunId | null,
        chart: null as RunId | null
    },

    requestId: 0 as RequestId,

    async init(version: string): Promise<void> {
        await Promise.all([
            this.initWorker('top', version),
            this.initWorker('chart', version)
        ]);
    },

    initWorker(kind: 'top' | 'chart', version: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.workers[kind]) this.workers[kind]!.terminate();
            
            if (kind === 'top') {
                this.workers.top = new Worker('dist/top-worker.js');
            } else {
                this.workers.chart = new Worker('dist/chart-worker.js');
            }
            const timeout = setTimeout(() => reject(new Error(`Worker ${kind} initialization timed out`)), 10000);

            this.workers[kind]!.onmessage = (e: MessageEvent<WorkerResponse>) => {
                const data = e.data;
                const { type } = data;

                if (type === 'ready') {
                    clearTimeout(timeout);
                    resolve();
                    return;
                }

                if (type === 'runAccepted') {
                    // Could track acceptance if needed
                    return;
                }

                if (type === 'topUpdate' && kind === 'top') {
                    const cb = this.callbacks.top.get(data.runId);
                    if (cb && data.runId === this.activeRunIds.top) {
                        cb(data.view);
                    }
                } else if (type === 'chartUpdate' && kind === 'chart') {
                    const cb = this.callbacks.chart.get(data.runId);
                    if (cb && data.runId === this.activeRunIds.chart) {
                        cb(data.cell);
                    }
                } else if (type === 'terminal' && kind === 'chart') {
                    const cb = this.callbacks.terminal.get(data.runId);
                    if (cb && data.runId === this.activeRunIds.chart) {
                        cb();
                        this.callbacks.chart.delete(data.runId);
                        this.callbacks.terminal.delete(data.runId);
                    }
                } else if (type === 'error') {
                    console.error(`Worker ${kind} error:`, data.error);
                }
            };

            const requestId = ++(this.requestId as any) as RequestId;
            this.workers[kind]!.postMessage({ type: 'init', requestId, version });
        });
    },

    startTopRun(input: TopInputSignature, refinement: RefinementLevelName[], onUpdate: TopUpdateCallback): RunId {
        const runId = `top_${Date.now()}_${++(this.requestId as any)}` as RunId;
        this.activeRunIds.top = runId;
        this.callbacks.top.set(runId, onUpdate);

        this.workers.top?.postMessage({
            type: 'topRunStart',
            requestId: ++(this.requestId as any) as RequestId,
            runId,
            input,
            refinement
        } as WorkerRequest);

        return runId;
    },

    startChartRun(input: ChartInputSignature, refinement: RefinementLevelName[], onUpdate: ChartUpdateCallback, onTerminal: TerminalCallback): RunId {
        const runId = `chart_${Date.now()}_${++(this.requestId as any)}` as RunId;
        this.activeRunIds.chart = runId;
        this.callbacks.chart.set(runId, onUpdate);
        this.callbacks.terminal.set(runId, onTerminal);

        this.workers.chart?.postMessage({
            type: 'chartRunStart',
            requestId: ++(this.requestId as any) as RequestId,
            runId,
            input,
            refinement
        } as WorkerRequest);

        return runId;
    },

    /** Legacy support or explicit reset if needed */
    async resetWorker(kind: 'top' | 'chart', version: string): Promise<void> {
        await this.initWorker(kind, version);
    }
};
