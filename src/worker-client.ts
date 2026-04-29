import { ResultProcessor } from './utils.js';

/**
 * Client wrapper around the Enchant Engine Web Worker.
 * Manages request/response lifecycle and progress callbacks.
 */
export const WorkerClient = {
    worker: null as Worker | null,
    pendingRequests: new Map<number, (data: any) => void>(),
    requestId: 0,

    init(version: string): Promise<void> {
        return new Promise((resolve) => {
            if (this.worker) this.worker.terminate();
            
            // For production/main analyzer.html, worker.js is in dist/
            // Inline-assets.js will replace this with a Blob URL for standalone
            this.worker = new Worker('dist/worker.js');
            
            this.worker.onmessage = (e) => {
                const { type, id, payload } = e.data;
                const cb = this.pendingRequests.get(id);
                
                if (type === 'ready') {
                    if (cb) {
                        cb({ stats: null, human: null });
                        this.pendingRequests.delete(id);
                    }
                    resolve();
                    return;
                }

                if (type === 'result') {
                    const { stats, human } = payload || {};
                    const finalStats = (stats && stats.comboKeys) ? ResultProcessor.deserialize(stats) : stats;
                    
                    if (cb) {
                        cb({ stats: finalStats, human });
                        this.pendingRequests.delete(id);
                    }
                } else if (type === 'progress') {
                    const { stats, human } = payload || {};
                    const finalStats = (stats && stats.comboKeys) ? ResultProcessor.deserialize(stats) : stats;
                    
                    const progCb = (this.pendingRequests as any).get(`${id}_progress`);
                    if (progCb) progCb({ stats: finalStats, human });
                } else if (type === 'error') {
                    console.error("Worker Error:", payload);
                }
            };

            const id = ++this.requestId;
            this.pendingRequests.set(id, () => {}); // No-op for init ready
            this.worker.postMessage({ type: 'init', id, payload: { version } });
        });
    },

    request(type: string, payload: any, onProgress?: (data: any) => void): Promise<any> {
        return new Promise((resolve) => {
            if (!this.worker) return resolve(null);
            const id = ++this.requestId;
            this.pendingRequests.set(id, resolve);
            if (onProgress) {
                (this.pendingRequests as any).set(`${id}_progress`, onProgress);
            }
            this.worker.postMessage({ type, id, payload: { ...payload, source: payload.source || 'main' } });
        });
    }
};
