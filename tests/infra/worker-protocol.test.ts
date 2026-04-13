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
import { EnchantEngine, EnchantEngine } from '../../src/lib/engine/index.js'; import { EngineFactory } from '../../src/lib/engine/factory.js';
import { DATA } from '../../src/lib/data/index.js';
import { SerializationService } from '../../src/lib/services/index.js';
import type { WorkerResponse } from '../../src/worker/protocol.js';
import { TEST_DATA } from '../infra/test-data.js';

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
        await import('../../src/worker/worker.js');

        // Initialize the engine inside the worker
        sendMessage({ type: 'init', id: 0, payload: { version: TEST_DATA.VERSIONS.MODERN } });
        await waitForMessage(captured, m => m.type === 'ready' && m.id === 0);
    });

    afterEach(async () => {
        captured.length = 0;
        // sendMessage({ type: 'init' }) recreates the engine, clearing its caches.
        // This ensures the next test doesn't get a cached 'result' without 'progress' callbacks.
        sendMessage({ type: 'init', id: 0, payload: { version: TEST_DATA.VERSIONS.MODERN } });
        await waitForMessage(captured, m => m.type === 'ready' && m.id === 0);
        captured.length = 0; // Clear the 'ready' msg
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
                cat: TEST_DATA.ITEMS.SWORD,
                xp: 30,
                mat: TEST_DATA.MATERIALS.DIAMOND,
                guaranteedFirst: null,
                source: 'test-prog',
                tiers: [
                    { threshold: 0.01,   limit: 500 },
                    { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 5000 },
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
                cat: TEST_DATA.ITEMS.SWORD,
                xp: 30,
                mat: TEST_DATA.MATERIALS.DIAMOND,
                guaranteedFirst: null,
                source: 'test-prog-final',
                tiers: [
                    { threshold: 0.01,   limit: 500 },
                    { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 5000 },
                ],
            },
        });

        const resultMsg = await waitForMessage(captured, m => m.type === 'result' && m.id === id);
        assert.strictEqual(resultMsg.type, 'result');
        assert.ok(resultMsg.payload?.stats, 'result message must carry stats');

        const workerStats = SerializationService.deserialize(resultMsg.payload.stats);

        // Compare against a fresh direct engine call
        const engine = EngineFactory.create(DATA, TEST_DATA.VERSIONS.MODERN);
        const directStats = await engine.getFullStatsProgressive(
            TEST_DATA.ITEMS.SWORD, 30, TEST_DATA.MATERIALS.DIAMOND, null,
            [
                { threshold: 0.01,   limit: 500 },
                { threshold: TEST_DATA.THRESHOLDS.PROB_MIN, limit: 5000 },
            ],
            () => {}
        );
        engine.resetCaches();

        const accuracyDiff = Math.abs(workerStats.accuracy - directStats.accuracy);
        assert.ok(
            accuracyDiff < 0.001,
            `Worker accuracy (${workerStats.accuracy}) must match direct engine (${directStats.accuracy}); diff=${accuracyDiff}`
        );
        assert.strictEqual(
            Object.keys(workerStats.combos).length,
            Object.keys(directStats.combos).length,
            'Worker and direct engine must produce the same number of combos'
        );
    });
});


