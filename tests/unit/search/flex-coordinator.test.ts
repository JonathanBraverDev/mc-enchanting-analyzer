import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENGINE_LIMITS } from '#constants/engine.js';
import type { PackedEnchant } from '#types/index.js';
import { PRECISION, ProbUtils } from '#utils/index.js';
import {
    FlexCoordinator,
    FlexProgramStore,
    type FlexExpansion,
    type FlexGraph,
    type FlexNodeId
} from '#lib/search/flex/index.js';

const packed = (id: number, rank = 1): PackedEnchant => ((id << 8) | rank) as PackedEnchant;
const nodeId = (id: number): FlexNodeId => id as FlexNodeId;
const units = (snapshot: ReturnType<FlexCoordinator['snapshot']>) => snapshot.mass.units!;
const SYSTEM_FLOOR_UNITS = ProbUtils.toBigInt(ENGINE_LIMITS.SYSTEM_THRESHOLD_FLOOR);

class TestFlexGraph implements FlexGraph {
    private readonly expansions = new Map<number, FlexExpansion>();

    public set(nodeIdValue: FlexNodeId, expansion: FlexExpansion): void {
        this.expansions.set(nodeIdValue as number, expansion);
    }

    public getExpansion(nodeIdValue: FlexNodeId): FlexExpansion {
        const expansion = this.expansions.get(nodeIdValue as number);
        if (!expansion) throw new Error(`Missing test expansion ${String(nodeIdValue)}.`);
        return expansion;
    }

    public getNode(nodeIdValue: FlexNodeId): FlexExpansion['node'] {
        return this.getExpansion(nodeIdValue).node;
    }
}

function terminalExpansion(store: FlexProgramStore, id: FlexNodeId, programId = store.empty): FlexExpansion {
    return Object.freeze({
        node: store.createNode(id, programId),
        probContinue: 0n,
        totalWeight: 0,
        edges: Object.freeze([]),
        terminalReason: null
    });
}

describe('FlexCoordinator', () => {
    it('expands highest-mass pending nodes first and records stop mass by program ID', () => {
        const store = new FlexProgramStore();
        const sharpnessProgram = store.appendFixed(store.empty, packed(1));
        const smiteProgram = store.appendFixed(store.empty, packed(2));
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION,
            totalWeight: 4,
            edges: Object.freeze([
                { weight: 3, childId: nodeId(1) },
                { weight: 1, childId: nodeId(2) }
            ]),
            terminalReason: null
        }));
        graph.set(nodeId(1), terminalExpansion(store, nodeId(1), sharpnessProgram));
        graph.set(nodeId(2), terminalExpansion(store, nodeId(2), smiteProgram));

        const run = new FlexCoordinator([graph]);
        run.seedPending(0, nodeId(0), 100n);
        const snapshot = run.searchToCheckpoint({ maxIterations: 2 });

        assert.strictEqual(snapshot.exitReason, 'iterations');
        assert.strictEqual(snapshot.iterations, 2);
        assert.strictEqual(snapshot.results.get(sharpnessProgram), 75n);
        assert.strictEqual(snapshot.results.get(smiteProgram), undefined);
        assert.strictEqual(snapshot.pendingEntries.length, 1);
        assert.strictEqual(snapshot.pendingEntries[0]!.programId, smiteProgram);
        assert.strictEqual(snapshot.pendingEntries[0]!.mass, 25n);
        assert.strictEqual(snapshot.lastExpandedMass, 75n);
    });

    it('counts expanded Solid and Plex nodes for diagnostics', () => {
        const store = new FlexProgramStore();
        const choiceProgram = store.appendChoice(store.empty, [
            { packedEnchant: packed(1), weight: 1 },
            { packedEnchant: packed(2), weight: 1 }
        ]);
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION,
            totalWeight: 1,
            edges: Object.freeze([{ weight: 1, childId: nodeId(1) }]),
            terminalReason: null
        }));
        graph.set(nodeId(1), terminalExpansion(store, nodeId(1), choiceProgram));

        const run = new FlexCoordinator([graph]);
        run.seedPending(0, nodeId(0), 100n);
        const snapshot = run.searchToCheckpoint({ maxIterations: 2 });
        const stats = run.getMemoryStats();

        assert.strictEqual(snapshot.iterations, 2);
        assert.strictEqual(stats.expandedSolidNodeCount, 1);
        assert.strictEqual(stats.expandedPlexNodeCount, 1);
    });

    it('can drain the equal-mass frontier band after an iteration cap', () => {
        const store = new FlexProgramStore();
        const firstProgram = store.appendFixed(store.empty, packed(1));
        const secondProgram = store.appendFixed(store.empty, packed(2));
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION,
            totalWeight: 2,
            edges: Object.freeze([
                { weight: 1, childId: nodeId(1) },
                { weight: 1, childId: nodeId(2) }
            ]),
            terminalReason: null
        }));
        graph.set(nodeId(1), terminalExpansion(store, nodeId(1), firstProgram));
        graph.set(nodeId(2), terminalExpansion(store, nodeId(2), secondProgram));

        const capped = new FlexCoordinator([graph]);
        capped.seedPending(0, nodeId(0), 100n);
        const cappedSnapshot = capped.searchToCheckpoint({ maxIterations: 2 });
        assert.strictEqual(cappedSnapshot.exitReason, 'iterations');
        assert.strictEqual(cappedSnapshot.iterations, 2);
        assert.strictEqual(cappedSnapshot.pendingEntries.length, 1);

        const drained = new FlexCoordinator([graph]);
        drained.seedPending(0, nodeId(0), 100n);
        const drainedSnapshot = drained.searchToCheckpoint({
            maxIterations: 2,
            drainEqualMassBand: true
        });
        assert.strictEqual(drainedSnapshot.exitReason, 'empty');
        assert.strictEqual(drainedSnapshot.iterations, 3);
        assert.strictEqual(drainedSnapshot.results.get(firstProgram), 50n);
        assert.strictEqual(drainedSnapshot.results.get(secondProgram), 50n);
        assert.strictEqual(drainedSnapshot.pendingCount, 0);
    });

    it('asynchronously advances through scheduler chunks to the same checkpoint', async () => {
        const store = new FlexProgramStore();
        const firstProgram = store.appendFixed(store.empty, packed(1));
        const secondProgram = store.appendFixed(firstProgram, packed(2));
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION,
            totalWeight: 1,
            edges: Object.freeze([{ weight: 1, childId: nodeId(1) }]),
            terminalReason: null
        }));
        graph.set(nodeId(1), Object.freeze({
            node: store.createNode(nodeId(1), firstProgram),
            probContinue: PRECISION,
            totalWeight: 1,
            edges: Object.freeze([{ weight: 1, childId: nodeId(2) }]),
            terminalReason: null
        }));
        graph.set(nodeId(2), terminalExpansion(store, nodeId(2), secondProgram));

        const run = new FlexCoordinator([graph]);
        run.seedPending(0, nodeId(0), 100n);
        const snapshot = await run.searchToCheckpointAsync({
            maxIterations: 3,
            yieldEveryIterations: 1,
            probabilityFloor: 0n
        });

        assert.strictEqual(snapshot.exitReason, 'empty');
        assert.strictEqual(snapshot.iterations, 3);
        assert.strictEqual(snapshot.results.get(secondProgram), 100n);
        assert.strictEqual(snapshot.pendingCount, 0);
    });

    it('forwards edge residues with V7 rounding and recovered-rounding semantics', () => {
        const store = new FlexProgramStore();
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION,
            totalWeight: 2,
            edges: Object.freeze([
                { weight: 1, childId: nodeId(1) },
                { weight: 1, childId: nodeId(2) }
            ]),
            terminalReason: null
        }));
        graph.set(nodeId(1), terminalExpansion(store, nodeId(1)));
        graph.set(nodeId(2), terminalExpansion(store, nodeId(2)));

        const run = new FlexCoordinator([graph]);
        run.seedPending(0, nodeId(0), 1n);
        const first = run.searchToCheckpoint({ maxIterations: 1 });

        assert.strictEqual(first.exitReason, 'empty');
        assert.strictEqual(first.activeResidueMass, 1n);
        assert.strictEqual(units(first).rounding, '1');

        run.seedPending(0, nodeId(0), 1n);
        const second = run.searchToCheckpoint({ maxIterations: 2 });

        assert.strictEqual(second.exitReason, 'iterations');
        assert.strictEqual(second.activeResidueMass, 0n);
        assert.strictEqual(units(second).pending, '2');
        assert.strictEqual(units(second).rounding, '0');
        assert.strictEqual(units(second).recoveredRounding, '2');
    });

    it('reports threshold, mass, and empty checkpoint exits', () => {
        const store = new FlexProgramStore();
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), terminalExpansion(store, nodeId(0)));

        const thresholdRun = new FlexCoordinator([graph]);
        thresholdRun.seedPending(0, nodeId(0), 1n);
        const threshold = thresholdRun.searchToCheckpoint({ threshold: 2n });
        assert.strictEqual(threshold.exitReason, 'threshold');
        assert.strictEqual(threshold.iterations, 0);
        assert.strictEqual(units(threshold).pending, '1');
        assert.strictEqual(units(threshold).sieved, '0');

        const massGraph = new TestFlexGraph();
        massGraph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION / 2n,
            totalWeight: 1,
            edges: Object.freeze([{ weight: 1, childId: nodeId(1) }]),
            terminalReason: null
        }));
        massGraph.set(nodeId(1), terminalExpansion(store, nodeId(1)));
        const massRun = new FlexCoordinator([massGraph]);
        massRun.seedPending(0, nodeId(0), 10n);
        const mass = massRun.searchToCheckpoint({ targetClassifiedMass: 5n, maxIterations: 10 });
        assert.strictEqual(mass.exitReason, 'mass');
        assert.strictEqual(mass.results.get(store.empty), 5n);

        const emptyRun = new FlexCoordinator([graph]);
        emptyRun.seedPending(0, nodeId(0), 4n);
        const empty = emptyRun.searchToCheckpoint({ exhaustive: true });
        assert.strictEqual(empty.exitReason, 'empty');
        assert.strictEqual(empty.fullyResolved, true);
    });

    it('keeps checkpoint threshold separate from probability-floor sieving', () => {
        const store = new FlexProgramStore();
        const childProgram = store.appendFixed(store.empty, packed(1));
        const pendingMass = SYSTEM_FLOOR_UNITS - 1n;
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION,
            totalWeight: 1,
            edges: Object.freeze([{ weight: 1, childId: nodeId(1) }]),
            terminalReason: null
        }));
        graph.set(nodeId(1), terminalExpansion(store, nodeId(1), childProgram));

        const run = new FlexCoordinator([graph]);
        run.seedPending(0, nodeId(0), pendingMass);
        const snapshot = run.searchToCheckpoint({
            threshold: SYSTEM_FLOOR_UNITS,
            maxIterations: 10
        });

        assert.strictEqual(snapshot.exitReason, 'threshold');
        assert.strictEqual(snapshot.iterations, 0);
        assert.strictEqual(snapshot.pendingEntries.length, 1);
        assert.strictEqual(units(snapshot).pending, String(pendingMass));
        assert.strictEqual(units(snapshot).sieved, '0');
    });

    it('records non-root continue mass below the probability floor as sieved', () => {
        const store = new FlexProgramStore();
        const firstProgram = store.appendFixed(store.empty, packed(1));
        const secondProgram = store.appendFixed(firstProgram, packed(2));
        const belowFloorMass = SYSTEM_FLOOR_UNITS - 1n;
        const graph = new TestFlexGraph();
        graph.set(nodeId(0), Object.freeze({
            node: store.createNode(nodeId(0), store.empty),
            probContinue: PRECISION,
            totalWeight: 1,
            edges: Object.freeze([{ weight: 1, childId: nodeId(1) }]),
            terminalReason: null
        }));
        graph.set(nodeId(1), Object.freeze({
            node: store.createNode(nodeId(1), firstProgram),
            probContinue: PRECISION,
            totalWeight: 1,
            edges: Object.freeze([{ weight: 1, childId: nodeId(2) }]),
            terminalReason: null
        }));
        graph.set(nodeId(2), terminalExpansion(store, nodeId(2), secondProgram));

        const run = new FlexCoordinator([graph]);
        run.seedPending(0, nodeId(0), belowFloorMass);
        const snapshot = run.searchToCheckpoint({ threshold: 0n, maxIterations: 10 });

        assert.strictEqual(snapshot.exitReason, 'empty');
        assert.strictEqual(snapshot.iterations, 2);
        assert.strictEqual(snapshot.lastExpandedMass, belowFloorMass);
        assert.strictEqual(snapshot.results.size, 0);
        assert.strictEqual(units(snapshot).pending, '0');
        assert.strictEqual(units(snapshot).resolved, '0');
        assert.strictEqual(units(snapshot).sieved, String(belowFloorMass));

        const parityRun = new FlexCoordinator([graph]);
        parityRun.seedPending(0, nodeId(0), belowFloorMass);
        const paritySnapshot = parityRun.searchToCheckpoint({
            threshold: 0n,
            maxIterations: 10,
            probabilityFloor: 0n
        });

        assert.strictEqual(paritySnapshot.exitReason, 'empty');
        assert.strictEqual(paritySnapshot.iterations, 3);
        assert.strictEqual(paritySnapshot.results.get(secondProgram), belowFloorMass);
        assert.strictEqual(units(paritySnapshot).resolved, String(belowFloorMass));
        assert.strictEqual(units(paritySnapshot).sieved, '0');
    });
});
