/**
 * Utility for asynchronous operations.
 */
export class AsyncUtils {
    /**
     * Yields execution to the macro-task queue.
     */
    static yield(): Promise<void> {
        return new Promise(r => setTimeout(r, 0));
    }
}
