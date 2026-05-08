import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
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
 *   workerScope.onmessage = async (e) => shell.dispatchEvent(e);
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
     * Accepts same-origin worker messages from the owning UI context.
     * Dedicated worker messages may omit `origin`, so only a mismatched value is rejected.
     */
    public async dispatchEvent(event: MessageEvent<WorkerRequest>): Promise<void> {
        if (!this.isTrustedMessage(event)) return;
        await this.dispatch(event.data);
    }

    /**
     * Routes an incoming worker message to the correct handler.
     * Wraps all errors in a uniform error + terminal message pair.
     */
    public async dispatch(msg: WorkerRequest): Promise<void> {
        try {
            if (msg.type === 'init') {
                this.initializeEngine(msg);
                return;
            }

            if (!this.engine) throw new Error('Worker not initialized');

            await this.startRun(msg);
        } catch (err: any) {
            this.broadcastError(err);
        }
    }

    private isTrustedMessage(event: MessageEvent<WorkerRequest>): boolean {
        const origin = event.origin;
        const expectedOrigin = this.scope.location?.origin;

        return !origin || !expectedOrigin || origin === expectedOrigin;
    }

    /**
     * Begins a new run, aborting any in-progress run first.
     * Delegates the actual calculation to `onRun`.
     */
    private async startRun(msg: WorkerRequest): Promise<void> {
        const runId = (msg as any).runId as RunId;

        this.supersedeActiveRun(runId);
        const signal = this.startAbortableRun(runId);

        try {
            await this.onRun?.(msg, this.engine!, signal);
            this.completeRun(runId, signal);
        } catch (err: any) {
            if (err.name === 'AbortError' || err.message === 'Aborted') return;
            throw err; // re-throw to be caught by dispatch()
        }
    }

    private initializeEngine(msg: WorkerRequest & { type: 'init' }): void {
        if (msg.bootstrapData) {
            (globalThis as any).ENCHANTING_DATA = msg.bootstrapData;
        }

        this.engine = EngineFactory.createForVersion(msg.version);
        const ready: WorkerReadyResponse = {
            type: 'ready',
            requestId: msg.requestId,
            worker: this.workerName,
            version: msg.version
        };
        this.scope.postMessage(ready);
        this.onInit?.(this.engine, msg);
    }

    private supersedeActiveRun(nextRunId: RunId): void {
        if (!this.currentRunId || this.currentRunId === nextRunId) return;

        this.currentAbortController?.abort();
        this.postTerminal(this.currentRunId, 'superseded');
    }

    private startAbortableRun(runId: RunId): AbortSignal {
        this.currentRunId = runId;
        this.currentAbortController = new AbortController();

        return this.currentAbortController.signal;
    }

    private completeRun(runId: RunId, signal: AbortSignal): void {
        if (this.currentRunId === runId && !signal.aborted) {
            this.postTerminal(runId, 'done');
        }
    }

    private postTerminal(runId: RunId, status: RunTerminalResponse['status'], error?: string): void {
        const terminal: RunTerminalResponse = {
            type: 'terminal',
            worker: this.workerName,
            runId,
            status
        };
        if (error !== undefined) terminal.error = error;
        this.scope.postMessage(terminal);
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
            this.postTerminal(this.currentRunId, 'error', err.message);
        }
    }
}
