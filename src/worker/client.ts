import { SerializationService } from '../services/index.js';
import type { WorkerResponse } from './protocol.js';

/**
 * Client wrapper around the Enchant Engine Web Worker.
 * Manages request/response lifecycle and progress callbacks.
 */
/**
 * Client wrapper around the Enchant Engine Web Workers.
 * Manages dual workers (Main and Chart) to enable parallel refinement and sweeps.
 */
export const WorkerClient = {
    workers: {
        main: null as Worker | null,
        chart: null as Worker | null
    },
    pendingRequests: new Map<string, { resolve: (data: any) => void, reject: (err: any) => void }>(),
    requestId: 0,

    async init(version: string): Promise<void> {
        await Promise.all([
            this.initWorker('main', version),
            this.initWorker('chart', version)
        ]);
    },

    drainPendingForWorker(type: string): void {
        const prefix = `${type}_`;
        for (const [key, req] of [...this.pendingRequests.entries()]) {
            if (key.startsWith(prefix)) {
                req.reject(new Error(`Worker ${type} re-initialized`));
                this.pendingRequests.delete(key);
            }
        }
    },

    initWorker(type: 'main' | 'chart', version: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.drainPendingForWorker(type);
            if (this.workers[type]) this.workers[type]!.terminate();
            
            this.workers[type] = new Worker('dist/worker.js');
            const timeout = setTimeout(() => reject(new Error(`Worker ${type} initialization timed out`)), 10000);

            this.workers[type]!.onmessage = (e: MessageEvent<WorkerResponse>) => {
                const { type: msgType, id, payload } = e.data;
                const reqKey = `${type}_${id}`;
                const req = this.pendingRequests.get(reqKey);
                
                if (msgType === 'ready') {
                    clearTimeout(timeout);
                    resolve();
                    return;
                }

                if (msgType === 'result') {
                    const { stats, human } = payload || {};
                    const finalStats = (stats && stats.comboKeys) ? SerializationService.deserialize(stats) : stats;
                    
                    if (req) {
                        req.resolve({ stats: finalStats, human });
                        this.pendingRequests.delete(reqKey);
                        this.pendingRequests.delete(`${reqKey}_progress`);
                    }
                } else if (msgType === 'progress') {
                    const { stats, human } = payload || {};
                    const finalStats = (stats && stats.comboKeys) ? SerializationService.deserialize(stats) : stats;
                    
                    const progCb = this.pendingRequests.get(`${reqKey}_progress`);
                    if (progCb) (progCb as any)({ stats: finalStats, human });
                } else if (msgType === 'error') {
                    if (req) {
                        req.reject(payload);
                        this.pendingRequests.delete(reqKey);
                        this.pendingRequests.delete(`${reqKey}_progress`);
                    }
                }
            };

            const id = ++this.requestId;
            this.workers[type]!.postMessage({ type: 'init', id, payload: { version } });
        });
    },

    request(type: string, payload: any, onProgress?: (data: any) => void): Promise<any> {
        return new Promise((resolve, reject) => {
            const source: 'main' | 'chart' = (payload.source === 'chart') ? 'chart' : 'main';
            const worker = this.workers[source];
            
            if (!worker) return reject(new Error(`Worker ${source} not initialized`));
            
            const id = ++this.requestId;
            const reqKey = `${source}_${id}`;
            
            this.pendingRequests.set(reqKey, { resolve, reject });
            if (onProgress) {
                this.pendingRequests.set(`${reqKey}_progress`, onProgress as any);
            }
            
            worker.postMessage({ type, id, payload });
        });
    }
};
