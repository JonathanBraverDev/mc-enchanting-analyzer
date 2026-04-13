/**
 * Utility for asynchronous operations.
 */
export class AsyncUtils {
    private static _channel: MessageChannel | null = null;

    private static get channel(): MessageChannel {
        if (!this._channel) this._channel = new MessageChannel();
        return this._channel;
    }

    /**
     * Yields execution to the macro-task queue.
     * Uses setImmediate in Node.js (~0ms) and MessageChannel in browsers (~0.1ms).
     * Both are significantly faster than setTimeout (~4ms), safe for hot-path yielding.
     */
    static yield(): Promise<void> {
        // Node.js: setImmediate yields after I/O without the MessageChannel port complexity
        if (typeof setImmediate !== 'undefined') {
            return new Promise(r => setImmediate(r));
        }
        // Browser/Worker: MessageChannel for low-latency macro-task yield
        const ch = this.channel;
        return new Promise(r => { ch.port1.onmessage = () => r(); ch.port2.postMessage(null); });
    }
}
