import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import {
    WorkerRequest,
    RunId,
    RunTerminalResponse,
    WorkerReadyResponse,
    WorkerErrorResponse
} from '#types/index.js';

type WorkerName = 'top' | 'chart';

/**
 * Manages the shared lifecycle state for a web worker:
 * - Engine initialization
 * - Run tracking (current runId + abort controller)
 * - Supersede / abort flow when a new run pre-empts an existing one
 * - Uniform error wrapping with terminal + error messages
 *
 * Usage:
 *   const shell = new WorkerShell('top');
 *   workerScope.onmessage = async (e) => shell.dispatch(e.data);
 *   shell.onInit = (msg) => { ... };
 *   shell.onRun  = async (msg, signal) => { ... };
 */
export class WorkerShell {
    private engine: EnchantEngine | null = null;
    private currentRunId: RunId | null = null;
    private currentAbortController: AbortController | null = null;

    /** Called when the engine is ready. Subclass or assign to handle init completion. */
    public onInit?: (engine: EnchantEngine, msg: WorkerRequest & { type: 'init' }) => void;

    /** Called for each incoming run message. Implement the actual calculation here. */
    public onRun?: (msg: WorkerRequest, engine: EnchantEngine, signal: AbortSignal) => Promise<void>;

    constructor(private readonly workerName: WorkerName, private readonly scope: any) {}

    /** Returns the currently active engine (or throws if not yet initialized). */
    public get activeEngine(): EnchantEngine {
        if (!this.engine) throw new Error('Worker not initialized');
        return this.engine;
    }

    /** Returns the currently active runId. */
    public get runId(): RunId | null {
        return this.currentRunId;
    }

    /**
     * Routes an incoming worker message to the correct handler.
     * Wraps all errors in a uniform error + terminal message pair.
     */
    public async dispatch(msg: WorkerRequest): Promise<void> {
        try {
            if (msg.type === 'init') {
                if (msg.data) {
                    (globalThis as any).ENCHANTING_DATA = msg.data;
                }
                this.engine = EngineFactory.create(DATA, msg.version);
                const ready: WorkerReadyResponse = {
                    type: 'ready',
                    requestId: msg.requestId,
                    worker: this.workerName,
                    version: msg.version
                };
                this.scope.postMessage(ready);
                this.onInit?.(this.engine, msg as any);
                return;
            }

            if (!this.engine) throw new Error('Worker not initialized');

            await this.startRun(msg);
        } catch (err: any) {
            this.broadcastError(err);
        }
    }

    /**
     * Begins a new run, aborting any in-progress run first.
     * Delegates the actual calculation to `onRun`.
     */
    private async startRun(msg: WorkerRequest): Promise<void> {
        const runId = (msg as any).runId as RunId;

        // Abort the previous run if it's a different one
        if (this.currentRunId && this.currentRunId !== runId) {
            this.currentAbortController?.abort();
            const superseded: RunTerminalResponse = {
                type: 'terminal',
                worker: this.workerName,
                runId: this.currentRunId,
                status: 'superseded'
            };
            this.scope.postMessage(superseded);
        }

        this.currentRunId = runId;
        this.currentAbortController = new AbortController();
        const signal = this.currentAbortController.signal;

        try {
            await this.onRun?.(msg, this.engine!, signal);

            // Send terminal "done" if the run completed normally
            if (this.currentRunId === runId && !signal.aborted) {
                const terminal: RunTerminalResponse = {
                    type: 'terminal',
                    worker: this.workerName,
                    runId,
                    status: 'done'
                };
                this.scope.postMessage(terminal);
            }
        } catch (err: any) {
            if (err.name === 'AbortError' || err.message === 'Aborted') return;
            throw err; // re-throw to be caught by dispatch()
        }
    }

    /**
     * Posts an error message followed by a terminal message to the UI thread.
     */
    public broadcastError(err: any): void {
        const errorMsg: WorkerErrorResponse = {
            type: 'error',
            worker: this.workerName,
            runId: this.currentRunId as any,
            error: err.message
        };
        this.scope.postMessage(errorMsg);

        if (this.currentRunId) {
            const terminal: RunTerminalResponse = {
                type: 'terminal',
                worker: this.workerName,
                runId: this.currentRunId,
                status: 'error',
                error: err.message
            };
            this.scope.postMessage(terminal);
        }
    }
}
