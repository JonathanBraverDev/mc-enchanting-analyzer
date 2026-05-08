import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import type { WorkerResponse, WorkerRequest, RunId } from '#types/index.js';
import { TEST_DATA } from '#tests/infra/test-data.js';

function sendMessage(data: WorkerRequest): void {
    const handler = (self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage;
    if (!handler) throw new Error("No onmessage handler registered");
    handler({ data } as MessageEvent);
}

async function waitForMessages(
    captured: WorkerResponse[],
    type: string,
    count: number,
    timeoutMs = 5000
): Promise<WorkerResponse[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const matches = captured.filter(m => m.type === type);
        if (matches.length >= count) return matches;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timeout waiting for ${count} messages of type ${type}. Captured so far types: ${JSON.stringify(captured.map(m => m.type))}`);
}

async function waitForTerminal(
    captured: WorkerResponse[],
    runId: RunId,
    timeoutMs = 5000
): Promise<WorkerResponse> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const msg = captured.find(m => m.type === 'terminal' && m.runId === runId);
        if (msg) return msg;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timeout waiting for terminal for ${runId}.`);
}

describe('Worker: Protocol Hardening', () => {
    const captured: WorkerResponse[] = [];
    let originalPostMessage: typeof globalThis.postMessage | undefined;

    before(() => {
        originalPostMessage = (globalThis as any).postMessage;
        (globalThis as any).self = globalThis;
        (globalThis as any).postMessage = (msg: unknown, _transfer?: unknown) => {
            captured.push(msg as WorkerResponse);
        };
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

    describe('top-worker protocol', () => {
        before(async () => {
            // Register top-worker handler
            await import('#worker/top-worker.js?t=' + Date.now());
        });

        it('should stream multiple refinement levels and send terminal', async () => {
            sendMessage({ type: 'init', requestId: 1, version: TEST_DATA.VERSIONS.MODERN });
            await waitForMessages(captured, 'ready', 1);
            captured.length = 0;

            const runId = 'run-1' as RunId;
            sendMessage({
                type: 'topRunStart',
                requestId: 2,
                runId,
                input: {
                    item: TEST_DATA.ITEMS.SWORD,
                    xpLevel: 30,
                    material: TEST_DATA.MATERIALS.DIAMOND,
                    clue: null,
                    version: TEST_DATA.VERSIONS.MODERN
                },
                refinementLevels: ['coarse', 'standard']
            });

            await waitForMessages(captured, 'runAccepted', 1);
            const updates = await waitForMessages(captured, 'topUpdate', 2);
            assert.strictEqual(updates[0]!.type, 'topUpdate');
            assert.strictEqual((updates[0] as any).refinementLevel, 'coarse');
            assert.strictEqual((updates[1] as any).refinementLevel, 'standard');

            const terminal = await waitForTerminal(captured, runId) as any;
            assert.strictEqual(terminal.status, 'done');
        });

        it('should report error for invalid clue', async () => {
            const runId = 'run-err' as RunId;
            sendMessage({
                type: 'topRunStart',
                requestId: 3,
                runId,
                input: {
                    item: TEST_DATA.ITEMS.SWORD,
                    xpLevel: 30,
                    material: TEST_DATA.MATERIALS.DIAMOND,
                    clue: 'FakeEnchant X',
                    version: TEST_DATA.VERSIONS.MODERN
                },
                refinementLevels: ['coarse']
            });

            const terminal = await waitForTerminal(captured, runId) as any;
            assert.strictEqual(terminal.status, 'error');
            assert.match(terminal.error, /Unknown enchantment/);
        });

        it('should re-project target-only top changes from the cached checkpoint result', async () => {
            const baseRunId = 'run-target-base' as RunId;
            const baseInput = {
                item: TEST_DATA.ITEMS.SWORD,
                xpLevel: 30,
                material: TEST_DATA.MATERIALS.DIAMOND,
                clue: null,
                version: TEST_DATA.VERSIONS.MODERN
            };

            sendMessage({
                type: 'topRunStart',
                requestId: 4,
                runId: baseRunId,
                input: baseInput,
                refinementLevels: ['coarse']
            });
            await waitForMessages(captured, 'topUpdate', 1);
            await waitForTerminal(captured, baseRunId);
            captured.length = 0;

            const projectRunId = 'run-target-project' as RunId;
            sendMessage({
                type: 'topRunProject',
                requestId: 5,
                runId: projectRunId,
                input: {
                    ...baseInput,
                    targets: [{ enchantment: 'Sharpness', rank: 1, rankMode: 'atLeast' }]
                },
                refinementLevels: ['coarse']
            });

            const updates = await waitForMessages(captured, 'topUpdate', 1) as any;
            assert.strictEqual(updates[0].runId, projectRunId);
            assert.ok(updates[0].view.target, 'projected view should include target diagnostics');
            assert.strictEqual(updates[0].view.target.labels[0], 'Sharpness I+');
            assert.ok(updates[0].view.target.matchShare > 0);
            assert.ok(updates[0].view.combos.every((combo: any) => combo.enchants.some((name: string) => name.startsWith('Sharpness '))));

            const terminal = await waitForTerminal(captured, projectRunId) as any;
            assert.strictEqual(terminal.status, 'done');
        });
    });

    describe('chart-worker protocol', () => {
        before(async () => {
            // Register chart-worker handler (overwrites top-worker)
            await import('#worker/chart-worker.js?t=' + Date.now());
        });

        it('should include chart envelope and stream all cells', async () => {
            sendMessage({ type: 'init', requestId: 6, version: TEST_DATA.VERSIONS.MODERN });
            await waitForMessages(captured, 'ready', 1);
            captured.length = 0;

            const runId = 'run-chart' as RunId;
            sendMessage({
                type: 'chartRunStart',
                requestId: 7,
                runId,
                input: {
                    item: TEST_DATA.ITEMS.SWORD,
                    material: TEST_DATA.MATERIALS.DIAMOND,
                    clue: null,
                    version: TEST_DATA.VERSIONS.MODERN
                },
                refinementLevels: ['coarse']
            });

            const accepted = await waitForMessages(captured, 'runAccepted', 1) as any;
            assert.ok(accepted[0].chart, 'runAccepted must carry chart envelope');
            assert.strictEqual(accepted[0].chart.maxXpLevel, 30);

            const updates = await waitForMessages(captured, 'chartUpdate', 1) as any;
            assert.strictEqual(updates[0].runId, runId);
            assert.ok(updates[0].cell, 'chartUpdate must carry a cell');

            const terminal = await waitForTerminal(captured, runId) as any;
            assert.strictEqual(terminal.status, 'done');
        });

        it('should include target diagnostics during normal chart runs', async () => {
            const runId = 'run-chart-target' as RunId;
            sendMessage({
                type: 'chartRunStart',
                requestId: 8,
                runId,
                input: {
                    item: TEST_DATA.ITEMS.SWORD,
                    material: TEST_DATA.MATERIALS.DIAMOND,
                    clue: null,
                    version: TEST_DATA.VERSIONS.MODERN,
                    targets: [{ enchantment: 'Sharpness', rank: 1, rankMode: 'atLeast' }]
                },
                refinementLevels: ['coarse']
            });

            const updates = await waitForMessages(captured, 'chartUpdate', 1) as any;
            assert.ok(updates[0].cell.target, 'chart cell should include target diagnostics');
            assert.strictEqual(updates[0].cell.target.labels[0], 'Sharpness I+');

            const terminal = await waitForTerminal(captured, runId) as any;
            assert.strictEqual(terminal.status, 'done');
        });
    });
});
