import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RankPoolId } from '#lib/search/flex/index.js';
import { RankSelectionStore } from '#lib/search/flex/index.js';

const rankPoolId = (id: number): RankPoolId => id as RankPoolId;

describe('RankSelectionStore', () => {
    it('interns equivalent abstract pick factors without rank identity', () => {
        const store = new RankSelectionStore();
        const first = store.getOrCreateFactor([
            { enchantId: 3, weight: 1 },
            { enchantId: 1, weight: 2 }
        ]);
        const same = store.getOrCreateFactor([
            { enchantId: 1, weight: 1 },
            { enchantId: 3, weight: 1 },
            { enchantId: 1, weight: 1 }
        ]);
        const factor = store.getFactor(first);

        assert.strictEqual(first, same);
        assert.deepStrictEqual(factor.alternatives, [
            { enchantId: 1, weight: 2 },
            { enchantId: 3, weight: 1 }
        ]);
        assert.strictEqual(factor.totalWeight, 3);
    });

    it('interns rank-pool mixes independent of input order', () => {
        const store = new RankSelectionStore();
        const first = store.getOrCreateRankPoolMix([
            { rankPoolId: rankPoolId(2), weight: 5n },
            { rankPoolId: rankPoolId(1), weight: 3n }
        ]);
        const same = store.getOrCreateRankPoolMix([
            { rankPoolId: rankPoolId(1), weight: 1n },
            { rankPoolId: rankPoolId(2), weight: 5n },
            { rankPoolId: rankPoolId(1), weight: 2n }
        ]);
        const mix = store.getRankPoolMix(first);

        assert.strictEqual(first, same);
        assert.deepStrictEqual(mix.pools, [
            { rankPoolId: rankPoolId(1), weight: 3n },
            { rankPoolId: rankPoolId(2), weight: 5n }
        ]);
        assert.strictEqual(mix.totalWeight, 8n);
    });

    it('converges selected states reached in different factor orders', () => {
        const store = new RankSelectionStore();
        const rankPoolMixId = store.getOrCreateSinglePoolMix(rankPoolId(7), 11n);
        const unbreaking = store.getOrCreateSingletonFactor(1, 5);
        const fortuneOrSilk = store.getOrCreateFactor([
            { enchantId: 2, weight: 2 },
            { enchantId: 3, weight: 1 }
        ]);

        const firstPath = store.getOrCreateSelection(rankPoolMixId, [unbreaking, fortuneOrSilk]);
        const secondPath = store.getOrCreateSelection(rankPoolMixId, [fortuneOrSilk, unbreaking]);
        const selection = store.getSelection(firstPath);

        assert.strictEqual(firstPath, secondPath);
        assert.deepStrictEqual(selection.factors, [unbreaking, fortuneOrSilk]);
        assert.strictEqual(selection.rankPoolMixId, rankPoolMixId);
    });

    it('keeps equivalent factor sets separate when rank-pool mix differs', () => {
        const store = new RankSelectionStore();
        const firstMix = store.getOrCreateSinglePoolMix(rankPoolId(1), 1n);
        const secondMix = store.getOrCreateSinglePoolMix(rankPoolId(2), 1n);
        const factor = store.getOrCreateSingletonFactor(4, 9);

        assert.notStrictEqual(
            store.getOrCreateSelection(firstMix, [factor]),
            store.getOrCreateSelection(secondMix, [factor])
        );
    });

    it('appends factors while preserving selected-state convergence', () => {
        const store = new RankSelectionStore();
        const rankPoolMixId = store.getOrCreateSinglePoolMix(rankPoolId(4), 1n);
        const base = store.getOrCreateSelection(rankPoolMixId, []);
        const first = store.getOrCreateSingletonFactor(1, 1);
        const second = store.getOrCreateSingletonFactor(2, 1);

        const firstThenSecond = store.appendFactor(store.appendFactor(base, first), second);
        const secondThenFirst = store.appendFactor(store.appendFactor(base, second), first);

        assert.strictEqual(firstThenSecond, secondThenFirst);
        assert.throws(() => store.appendFactor(firstThenSecond, first), /already contains factor/);
    });
});
