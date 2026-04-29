import { SerializationService } from '../services/index.js';

/**
 * Client wrapper around the Enchant Engine Web Worker.
 * Manages request/response lifecycle and progress callbacks.
 */
export const WorkerClient = {
    worker: null as Worker | null,
    pendingRequests: new Map<number, { resolve: (data: any) => void, reject: (err: any) => void }>(),
    requestId: 0,

    init(version: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.worker) this.worker.terminate();
            
            this.worker = new Worker('dist/worker.js');
            const timeout = setTimeout(() => reject(new Error("Worker initialization timed out")), 10000);

            this.worker.onmessage = (e) => {
                const { type, id, payload } = e.data;
                const req = this.pendingRequests.get(id);
                
                if (type === 'ready') {
                    clearTimeout(timeout);
                    if (req) {
                        req.resolve({ stats: null, human: null });
                        this.pendingRequests.delete(id);
                    }
                    resolve();
                    return;
                }

                if (type === 'result') {
                    const { stats, human } = payload || {};
                    const finalStats = (stats && stats.comboKeys) ? SerializationService.deserialize(stats) : stats;
                    
                    if (req) {
                        req.resolve({ stats: finalStats, human });
                        this.pendingRequests.delete(id);
                        (this.pendingRequests as any).delete(`${id}_progress`);
                    }
                } else if (type === 'progress') {
                    const { stats, human } = payload || {};
                    const finalStats = (stats && stats.comboKeys) ? SerializationService.deserialize(stats) : stats;
                    
                    const progCb = (this.pendingRequests as any).get(`${id}_progress`);
                    if (progCb) progCb({ stats: finalStats, human });
                } else if (type === 'error') {
                    if (req) {
                        req.reject(payload);
                        this.pendingRequests.delete(id);
                        (this.pendingRequests as any).delete(`${id}_progress`);
                    }
                    console.error("Worker Error:", payload);
                }
            };

            const id = ++this.requestId;
            this.pendingRequests.set(id, { resolve: () => {}, reject }); 
            this.worker.postMessage({ type: 'init', id, payload: { version } });
        });
    },

    request(type: string, payload: any, onProgress?: (data: any) => void): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.worker) return reject(new Error("Worker not initialized"));
            const id = ++this.requestId;
            this.pendingRequests.set(id, { resolve, reject });
            if (onProgress) {
                (this.pendingRequests as any).set(`${id}_progress`, onProgress);
            }
            this.worker.postMessage({ type, id, payload: { ...payload, source: payload.source || 'main' } });
        });
    }
};
