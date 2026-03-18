import { EnchantEngine } from './engine.js';
import { DATA } from './data.js';

let engine: EnchantEngine | null = null;
const abortControllers = new Map<string, AbortController>();

self.onmessage = async (e: MessageEvent) => {
    const { type, payload, id } = e.data;

    try {
        if (type === 'init') {
            engine = new EnchantEngine(DATA, payload.version);
            self.postMessage({ type: 'ready', id });
            return;
        }

        if (!engine) {
            throw new Error("Worker not initialized");
        }

        switch (type) {
            case 'getFullStats':
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
                        payload.guaranteedFirst,
                        payload.threshold,
                        signal,
                        (partialStats) => {
                            self.postMessage({ type: 'progress', id, payload: partialStats });
                        },
                        payload.useBestCache || false
                    );
                    self.postMessage({ type: 'result', id, payload: stats });
                } catch (err: any) {
                    if (err.message === "Aborted") return; // Silent discard
                    throw err;
                } finally {
                    if (abortControllers.get(source) === ctrl) {
                        abortControllers.delete(source);
                    }
                }
                break;
            
            case 'getModifiedLevelDist':
                const dist = engine.getModifiedLevelDist(payload.xp, payload.enchantability);
                self.postMessage({ type: 'result', id, payload: dist });
                break;

            case 'getEligibleListNumeric':
                const list = engine.getEligibleListNumeric(payload.cat, payload.level, payload.mat, payload.bitset || 0n);
                self.postMessage({ type: 'result', id, payload: list });
                break;

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (err: any) {
        self.postMessage({ type: 'error', id, payload: err.message });
    }
};
