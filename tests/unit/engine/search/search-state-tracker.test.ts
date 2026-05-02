import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MassForwardingEngine } from '#engine/search/MassForwardingEngine.js';
import { SearchNodeGraph } from '#engine/search/SearchNodeGraph.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ExpansionBlueprint } from '#types/index.js';
import { PRECISION } from '#utils/index.js';

describe('SearchStateTracker', () => {

    it('should initialize with empty mass bookkeeping', () => {
        const tracker = new SearchStateTracker();
        const mass = tracker.mass.toPublic();
        assert.strictEqual(mass.resolved, 0);
        assert.strictEqual(mass.pending, 0);
    });

    it('should record mass events correctly', () => {
        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', PRECISION / 2n);
        assert.strictEqual(tracker.mass.toPublic().resolved, 0.5);
    });

    it('should handle cloning correctly', () => {
        const tracker = new SearchStateTracker();
        tracker.mass.record('resolved', PRECISION / 4n);
        const clone = tracker.clone();
        assert.strictEqual(clone.mass.toPublic().resolved, 0.25);
        clone.mass.record('resolved', PRECISION / 4n);
        assert.strictEqual(clone.mass.toPublic().resolved, 0.5);
        assert.strictEqual(tracker.mass.toPublic().resolved, 0.25);
    });

    it('should register and retrieve graph expansion blueprints', () => {
        const graph = new SearchNodeGraph();
        const nodeId = graph.getOrCreateNode(1n, 0 as any, 0);
        const mockBlueprint: ExpansionBlueprint = {
            probContinue: 0n,
            totalWeight: 100,
            eligibleCount: 1,
            eligibleWeights: new Int32Array([100]),
            childIds: new Uint32Array([nodeId]),
            currentCount: 0,
            currentCombo: 0 as any,
            currentEnchants: []
        };
        graph.setBlueprint(nodeId, mockBlueprint);
        assert.ok(graph.hasBlueprint(nodeId));
        assert.deepStrictEqual(graph.getBlueprint(nodeId), mockBlueprint);
        assert.strictEqual(graph.size, 1);
    });

    it('should recover rounding residue from blueprints during mass distribution', () => {
        const tracker = new SearchStateTracker();
        const graph = new SearchNodeGraph();
        const nodeId = graph.getOrCreateNode(99n, 0 as any, 1);
        const childA = graph.getOrCreateNode(1n, 1 as any, 2);
        const childB = graph.getOrCreateNode(2n, 2 as any, 2);
        const weights = new Int32Array([10, 10]);
        // With totalWeight 20, a prob of 15 would have individualRemainder 15.
        // If we have a residue of 5 already, then 15 + 5 = 20, which divides perfectly.
        // Recovered mass should be 15 (the remainder that was 'saved').

        const blueprint: ExpansionBlueprint = {
            probContinue: PRECISION, // 100% forward
            totalWeight: 20,
            eligibleCount: 2,
            eligibleWeights: weights,
            childIds: new Uint32Array([childA, childB]),
            currentCount: 1,
            currentCombo: 0 as any,
            currentEnchants: []
        };
        graph.setBlueprint(nodeId, blueprint);
        graph.getForwardingResidue(nodeId).residue = 15n; // High residue from previous arrival

        const ctx: any = {
            registry: { enchantToIndex: new Map(), multiEnchantBooks: true },
            timing: {},
            resultsLimit: 100,
            queue: { pushOrMerge: () => {} },
            graph,
            instrumentation: {},
            cat: 'sword',
            results: new Map()
        };

        MassForwardingEngine.forwardMass(PRECISION, nodeId, ctx, tracker);

        const bk = tracker.mass.getBookkeeping();
        assert.ok(bk.recoveredRounding > 0n || bk.resolved > 0n, 'Should have accounted for recovered mass or resolved it');
    });
});
