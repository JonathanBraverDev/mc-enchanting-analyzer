import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../data/index.js';
import { SerializationService } from '../services/index.js';
import type { WorkerRequest } from './protocol.js';

// TypeScript lib "DOM" types `self` as Window, but at runtime in a worker it's DedicatedWorkerGlobalScope.
// This minimal interface lets us call postMessage with Transferable[] without widening to `any`.
interface WorkerPostable {
    postMessage(message: unknown, transfer: Transferable[]): void;
}
const workerScope = self as unknown as WorkerPostable;

let engine: EnchantEngine | null = null;
const abortControllers = new Map<string, AbortController>();

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    const { type, payload, id } = e.data;

    try {
        if (type === 'init') {
            if (engine) engine.destroy();
            engine = new EnchantEngine(DATA, payload.version);
            self.postMessage({ type: 'ready', id });
            return;
        }

        if (!engine) {
            throw new Error("Worker not initialized");
        }

        switch (type) {
            case 'getFullStats': {
                const source = payload.source || 'main';

                // Cancel previous search of the SAME source if it exists
                const existing = abortControllers.get(source);
                if (existing) {
                    existing.abort();
                }

                const ctrl = new AbortController();
                abortControllers.set(source, ctrl);
                const signal = ctrl.signal;

                try {
                    const stats = await engine.getFullStats(
                        payload.cat,
                        payload.xp,
                        payload.mat,
                        {
                            guaranteedFirst: payload.guaranteedFirst,
                            threshold: payload.threshold,
                            signal,
                            onProgress: (partialStats) => {
                                const { compact, transferables } = SerializationService.serialize(partialStats);
                                workerScope.postMessage({ type: 'progress', id, payload: { stats: compact } }, transferables);
                            },
                            maxIterations: payload.maxIterations
                        }
                    );

                    const { compact, transferables } = SerializationService.serialize(stats);

                    workerScope.postMessage({
                        type: 'result',
                        id,
                        payload: { stats: compact }
                    }, transferables);
                } catch (err: unknown) {
                    if (err instanceof Error && err.message === "Aborted") {
                        self.postMessage({ type: 'error', id, payload: 'Aborted' });
                        return;
                    }
                    throw err;
                } finally {
                    if (abortControllers.get(source) === ctrl) {
                        abortControllers.delete(source);
                    }
                }
                break;
            }

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (err: unknown) {
        self.postMessage({ type: 'error', id, payload: err instanceof Error ? err.message : String(err) });
    }
};
