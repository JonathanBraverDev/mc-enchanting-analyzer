import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import type { WorkerResponse, WorkerRequest } from '#worker/protocol.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

function sendMessage(data: WorkerRequest): void {
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
    throw new Error(`Timeout waiting for message. Captured so far: ${JSON.stringify(captured.map(m => m.type))}`);
}

describe('Worker: top-worker handler', () => {
    const captured: WorkerResponse[] = [];
    let originalPostMessage: typeof globalThis.postMessage | undefined;

    before(async () => {
        originalPostMessage = (globalThis as any).postMessage;
        (globalThis as any).self = globalThis;
        (globalThis as any).postMessage = (msg: unknown, _transfer?: unknown) => {
            captured.push(msg as WorkerResponse);
        };

        // Import the worker to register self.onmessage
        await import('#worker/top-worker.js');

        // Initialize the engine inside the worker
        sendMessage({ type: 'init', requestId: 0, version: TEST_DATA.VERSIONS.MODERN });
        await waitForMessage(captured, m => m.type === 'ready');
    });

    afterEach(async () => {
        captured.length = 0;
        sendMessage({ type: 'init', requestId: 0, version: TEST_DATA.VERSIONS.MODERN });
        await waitForMessage(captured, m => m.type === 'ready');
        captured.length = 0;
    });

    after(() => {
        if (originalPostMessage !== undefined) {
            (globalThis as any).postMessage = originalPostMessage;
        } else {
            delete (globalThis as any).postMessage;
        }
    });

    it('topRunStart returns topUpdate with valid view', async () => {
        const requestId = 10;
        const runId = 'test-run' as any;
        sendMessage({
            type: 'topRunStart',
            requestId,
            runId,
            input: {
                category: TEST_DATA.ITEMS.SWORD,
                xpLevel: 30,
                material: TEST_DATA.MATERIALS.DIAMOND,
                clue: null,
                version: TEST_DATA.VERSIONS.MODERN
            },
            refinement: ['coarse']
        });

        await waitForMessage(captured, m => m.type === 'runAccepted' && m.runId === runId);
        const updateMsg = await waitForMessage(captured, m => m.type === 'topUpdate' && m.runId === runId) as any;

        assert.strictEqual(updateMsg.type, 'topUpdate');
        assert.ok(updateMsg.view, 'topUpdate must carry a view');
        assert.strictEqual(updateMsg.refinementLevel, 'coarse');
    });
});
