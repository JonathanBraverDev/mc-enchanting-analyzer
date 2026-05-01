import {
  WorkerRequest,
  WorkerResponse,
  RunId,
  TopInputSignature,
  ChartInputSignature,
  RefinementLevelName,
  TopRunView,
  ChartCellView,
  RequestId,
  RunStatus
} from '#types/index.js';

export type TopUpdateCallback = (view: TopRunView) => void;
export type ChartUpdateCallback = (view: ChartCellView) => void;
export type TerminalCallback = (status: RunStatus, error?: string) => void;

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

    /** Tracking generations to avoid stale callbacks from superseded runs */
    generations: {
        top: 0,
        chart: 0
    },

    async init(version: string): Promise<void> {
        await Promise.all([
            this.initWorker('top', version),
            this.initWorker('chart', version)
        ]);
    },

    initWorker(kind: 'top' | 'chart', version: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
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

                // Generic handler for run-based messages
                if ('runId' in data) {
                    const runId = data.runId;

                    const isActive = runId === this.activeRunIds[kind];

                    if (type === 'topUpdate' && kind === 'top' && isActive) {
                        this.callbacks.top.get(runId)?.(data.view);
                    } else if (type === 'chartUpdate' && kind === 'chart' && isActive) {
                        this.callbacks.chart.get(runId)?.(data.cell);
                    } else if (type === 'terminal') {
                        const cb = this.callbacks.terminal.get(runId);
                        if (cb) {
                            cb(data.status, data.error);
                        }
                        this.cleanupRun(kind, runId);
                    } else if (type === 'error' && data.runId) {
                        const cb = this.callbacks.terminal.get(data.runId);
                        if (cb) cb('error', data.error);
                        this.cleanupRun(kind, data.runId);
                    }
                } else if (type === 'error') {
                    console.error(`Worker ${kind} system error:`, data.error);
                }
            };

            const reqId = ++(this.requestId as any) as RequestId;

            // In standalone, we must send the raw data, not the Proxy (Proxies aren't cloneable)
            let rawData = (globalThis as any).ENCHANTING_DATA;
            if (rawData && rawData.RAW_DATA) rawData = rawData.RAW_DATA;

            this.workers[kind]!.postMessage({
                type: 'init',
                requestId: reqId,
                version,
                data: rawData
            });
        });
    },

    cleanupRun(kind: 'top' | 'chart', runId: RunId): void {
        if (this.activeRunIds[kind] === runId) {
            this.activeRunIds[kind] = null;
        }
        this.callbacks[kind].delete(runId);
        this.callbacks.terminal.delete(runId);
    },

    /**
     * Explicitly cancel an active run from the UI side.
     */
    cancelRun(kind: 'top' | 'chart'): void {
        this.generations[kind]++;
        const runId = this.activeRunIds[kind];
        if (runId) {
            const cb = this.callbacks.terminal.get(runId);
            if (cb) cb('superseded');
            this.cleanupRun(kind, runId);
        }
    },

    startTopRun(input: TopInputSignature, refinementLevels: RefinementLevelName[], onUpdate: TopUpdateCallback, onTerminal: TerminalCallback): RunId {
        this.cancelRun('top');

        const runId = `top_${Date.now()}_${++(this.requestId as any)}` as RunId;
        this.activeRunIds.top = runId;
        this.callbacks.top.set(runId, onUpdate);
        this.callbacks.terminal.set(runId, onTerminal);

        this.workers.top?.postMessage({
            type: 'topRunStart',
            requestId: ++(this.requestId as any) as RequestId,
            runId,
            input,
            refinementLevels
        } as WorkerRequest);

        return runId;
    },

    startChartRun(input: ChartInputSignature, refinementLevels: RefinementLevelName[], onUpdate: ChartUpdateCallback, onTerminal: TerminalCallback): RunId {
        this.cancelRun('chart');

        const runId = `chart_${Date.now()}_${++(this.requestId as any)}` as RunId;
        this.activeRunIds.chart = runId;
        this.callbacks.chart.set(runId, onUpdate);
        this.callbacks.terminal.set(runId, onTerminal);

        this.workers.chart?.postMessage({
            type: 'chartRunStart',
            requestId: ++(this.requestId as any) as RequestId,
            runId,
            input,
            refinementLevels
        } as WorkerRequest);

        return runId;
    }
};
