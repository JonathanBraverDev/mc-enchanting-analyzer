import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import { RankPoolStore } from '#lib/search/flex/index.js';

describe('RankPoolStore', () => {
    it('interns exact ranked pools by signature', () => {
        const kernel = new RegistryKernel({
            registry: RegistryFactory.build('1.21.11'),
            item: 'book',
            material: 'book'
        });
        const firstPool = kernel.getPool(30);
        const samePool = kernel.getPool(30);
        const store = new RankPoolStore();

        const first = store.getOrCreate(firstPool);
        const same = store.getOrCreate(samePool);

        assert.strictEqual(first, same);
        assert.strictEqual(store.getSignature(first), firstPool.signature);
        assert.deepStrictEqual(store.getMemoryStats(), { poolCount: 1 });
    });

    it('resolves abstract enchant IDs to exact packed enchants', () => {
        const kernel = new RegistryKernel({
            registry: RegistryFactory.build('1.21.11'),
            item: 'book',
            material: 'book'
        });
        const pool = kernel.getPool(30);
        const store = new RankPoolStore();
        const rankPoolId = store.getOrCreate(pool);
        const firstEntry = pool.entries[0]!;

        assert.strictEqual(store.resolve(rankPoolId, firstEntry.enchantId), firstEntry.packedEnchant);
        assert.strictEqual(store.resolve(rankPoolId, -1), null);
    });

    it('keeps rank-variant family pools as separate exact rank pools', () => {
        const kernel = new RegistryKernel({
            registry: RegistryFactory.build('1.21.11'),
            item: 'book',
            material: 'book'
        });
        const pair = findRankVariantPoolPair(kernel);
        assert.ok(pair, 'fixture should include rank-variant book pools');

        const store = new RankPoolStore();
        const first = store.getOrCreate(pair.a);
        const second = store.getOrCreate(pair.b);

        assert.notStrictEqual(first, second);
        assert.strictEqual(pair.a.familySignature, pair.b.familySignature);
        assert.strictEqual(store.getMemoryStats().poolCount, 2);
    });
});

function findRankVariantPoolPair(kernel: RegistryKernel): { a: ReturnType<RegistryKernel['getPool']>; b: ReturnType<RegistryKernel['getPool']> } | undefined {
    const byFamily = new Map<string, ReturnType<RegistryKernel['getPool']>[]>();
    for (let level = 1; level <= 50; level++) {
        const pool = kernel.getPool(level);
        let family = byFamily.get(pool.familySignature);
        if (!family) {
            family = [];
            byFamily.set(pool.familySignature, family);
        }
        if (!family.some(candidate => candidate.signature === pool.signature)) family.push(pool);
    }

    for (const pools of byFamily.values()) {
        if (pools.length >= 2) return { a: pools[0]!, b: pools[1]! };
    }
    return undefined;
}
