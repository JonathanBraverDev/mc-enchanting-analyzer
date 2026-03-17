import { EnchantEngine } from './engine.js';
import { DATA } from './data.js';

let engine: EnchantEngine | null = null;

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
                const stats = await engine.getFullStats(
                    payload.cat,
                    payload.xp,
                    payload.mat,
                    payload.seed,
                    payload.threshold
                );
                self.postMessage({ type: 'result', id, payload: stats });
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
