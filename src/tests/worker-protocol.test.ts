/**
 * Tests for the worker protocol — getFullStatsProgressive handler.
 *
 * worker.ts registers self.onmessage at module load time and uses
 * workerScope (= self = globalThis in Node.js) to postMessage.
 * We mock globalThis.postMessage to intercept outbound messages and
 * drive the handler synchronously through synthetic MessageEvents.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from '../engine/index.js';
import { DATA } from '../data/index.js';
import { SerializationService } from '../services/index.js';
import type { WorkerResponse } from '../worker/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendMessage(data: unknown): void {
    const handler = (self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage;
    handler({ data } as MessageEvent);
}

async function waitForMessage(
    captured: WorkerResponse[],
    predicate: (msg: WorkerResponse) => boolean,
    timeoutMs = 5000
): Promise<WorkerResponse> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const msg = captured.find(predicate);
        if (msg) return msg;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timeout waiting for message. Captured so far: ${JSON.stringify(captured)}`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Worker: getFullStatsProgressive handler', () => {
    const captured: WorkerResponse[] = [];
    let originalPostMessage: typeof globalThis.postMessage | undefined;

    before(async () => {
        originalPostMessage = (globalThis as any).postMessage;

        // worker.ts uses `self` (DedicatedWorkerGlobalScope alias). In Node.js,
        // `self` is not defined, so we alias it to globalThis before import.
        (globalThis as any).self = globalThis;

        // Mock postMessage — handler uses workerScope.postMessage(msg, transfer)
        // and self.postMessage(msg). Both resolve to globalThis.postMessage.
        (globalThis as any).postMessage = (msg: unknown, _transfer?: unknown) => {
            captured.push(msg as WorkerResponse);
        };

        // Import the worker to register self.onmessage
        await import('../worker/worker.js');

        // Initialize the engine inside the worker
        sendMessage({ type: 'init', id: 0, payload: { version: '1.21' } });
        await waitForMessage(captured, m => m.type === 'ready' && m.id === 0);
    });

    afterEach(() => {
        captured.length = 0;
    });

    after(() => {
        if (originalPostMessage !== undefined) {
            (globalThis as any).postMessage = originalPostMessage;
        } else {
            delete (globalThis as any).postMessage;
        }
    });

    // -------------------------------------------------------------------------
    // Test 1: tier callbacks fire as 'progress' messages
    // -------------------------------------------------------------------------
    it('progressive worker request fires tier callbacks as progress', async () => {
        const id = 10;
        sendMessage({
            type: 'getFullStatsProgressive',
            id,
            payload: {
                cat: 'sword',
                xp: 30,
                mat: 'diamond',
                guaranteedFirst: null,
                source: 'test-prog',
                tiers: [
                    { threshold: 0.01,   limit: 500 },
                    { threshold: 0.0001, limit: 5000 },
                ],
            },
        });

        // Wait for the final result so all progress messages have been posted
        await waitForMessage(captured, m => m.type === 'result' && m.id === id);

        const progressMsgs = captured.filter(m => m.type === 'progress' && m.id === id);
        assert.ok(
            progressMsgs.length >= 1,
            `Expected at least 1 progress message, got ${progressMsgs.length}`
        );

        // Each progress message must carry a valid stats payload
        for (const msg of progressMsgs) {
            assert.ok(
                msg.type === 'progress' && msg.payload?.stats,
                'Each progress message must have a stats payload'
            );
        }
    });

    // -------------------------------------------------------------------------
    // Test 2: final result matches direct engine call
    // -------------------------------------------------------------------------
    it('progressive worker request returns final result', async () => {
        const id = 11;
        sendMessage({
            type: 'getFullStatsProgressive',
            id,
            payload: {
                cat: 'sword',
                xp: 30,
                mat: 'diamond',
                guaranteedFirst: null,
                source: 'test-prog-final',
                tiers: [
                    { threshold: 0.01,   limit: 500 },
                    { threshold: 0.0001, limit: 5000 },
                ],
            },
        });

        const resultMsg = await waitForMessage(captured, m => m.type === 'result' && m.id === id);
        assert.strictEqual(resultMsg.type, 'result');
        assert.ok(resultMsg.payload?.stats, 'result message must carry stats');

        const workerStats = SerializationService.deserialize(resultMsg.payload.stats);

        // Compare against a fresh direct engine call
        const engine = new EnchantEngine(DATA, '1.21');
        const directStats = await engine.getFullStatsProgressive(
            'sword', 30, 'diamond', null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: 0.0001, limit: 5000 },
            ],
            () => {}
        );
        EnchantEngine.clearAllEngines();

        const uncertaintyDiff = Math.abs(workerStats.uncertainty - directStats.uncertainty);
        assert.ok(
            uncertaintyDiff < 0.001,
            `Worker uncertainty (${workerStats.uncertainty}) must match direct engine (${directStats.uncertainty}); diff=${uncertaintyDiff}`
        );
        assert.strictEqual(
            Object.keys(workerStats.combos).length,
            Object.keys(directStats.combos).length,
            'Worker and direct engine must produce the same number of combos'
        );
    });
});
