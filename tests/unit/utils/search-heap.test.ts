import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SearchHeap } from '#utils/collections/SearchHeap.js';

type HeapItem = { meta: bigint; prob: bigint; level: number; combo: number };

function drain(heap: SearchHeap): HeapItem[] {
    const out: HeapItem[] = [];
    while (heap.size() > 0) {
        const item = heap.pop();
        assert.ok(item, 'pop() should return an item while heap is non-empty');
        out.push(item);
    }
    return out;
}

function snapshotByDrain(heap: SearchHeap): Array<{ meta: bigint; prob: bigint; combo: number }> {
    return drain(heap.clone()).map(({ meta, prob, combo }) => ({ meta, prob, combo }));
}

function makeDeterministicRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function findMetaForBucket(heap: SearchHeap, targetBucket: number): bigint {
    const internal = heap as any;
    for (let meta = 1n; meta < 10_000n; meta++) {
        if (internal.getHash(meta) === targetBucket) return meta;
    }
    throw new Error(`Could not find meta for bucket ${targetBucket}`);
}

function getReferenceMax(ref: Map<bigint, { prob: bigint; combo: number }>): { maxProb: bigint; metas: bigint[] } {
    let maxProb = -1n;
    const metas: bigint[] = [];

    for (const [meta, value] of ref.entries()) {
        if (value.prob > maxProb) {
            maxProb = value.prob;
            metas.length = 0;
            metas.push(meta);
        } else if (value.prob === maxProb) {
            metas.push(meta);
        }
    }

    return { maxProb, metas };
}

describe('SearchHeap', () => {
    it('pop returns items in descending prob order (max-heap)', () => {
        const heap = new SearchHeap(4);
        heap.pushOrMerge(1n, 10n, 1);
        heap.pushOrMerge(2n, 5n, 2);
        heap.pushOrMerge(3n, 20n, 3);
        heap.pushOrMerge(4n, 1n, 4);
        heap.pushOrMerge(5n, 15n, 5);

        const out = drain(heap).map(item => item.prob);
        assert.deepStrictEqual(out, [20n, 15n, 10n, 5n, 1n]);
    });

    it('peekProb returns max without removing', () => {
        const heap = new SearchHeap(4);
        heap.pushOrMerge(1n, 5n, 1);
        heap.pushOrMerge(2n, 10n, 2);

        assert.strictEqual(heap.peekProb(), 10n);
        assert.strictEqual(heap.size(), 2);
        assert.strictEqual(heap.peekProb(), 10n);
    });

    it('pop on empty heap returns undefined', () => {
        const heap = new SearchHeap(4);
        assert.strictEqual(heap.pop(), undefined);
        assert.strictEqual(heap.peekProb(), 0n);
    });

    it('size tracks insertions, merges, and removals', () => {
        const heap = new SearchHeap(4);
        assert.strictEqual(heap.size(), 0);

        heap.pushOrMerge(1n, 1n, 1);
        assert.strictEqual(heap.size(), 1);

        heap.pushOrMerge(2n, 2n, 2);
        assert.strictEqual(heap.size(), 2);

        heap.pushOrMerge(1n, 3n, 1);
        assert.strictEqual(heap.size(), 2, 'duplicate meta should merge, not add a new entry');

        heap.pop();
        assert.strictEqual(heap.size(), 1);
    });

    it('merges probability for duplicate meta', () => {
        const heap = new SearchHeap(4);
        heap.pushOrMerge(1n, 10n, 1);
        heap.pushOrMerge(2n, 5n, 2);
        heap.pushOrMerge(1n, 3n, 999);

        assert.strictEqual(heap.size(), 2);

        const top = heap.pop();
        assert.ok(top);
        assert.strictEqual(top.meta, 1n);
        assert.strictEqual(top.prob, 13n);
        assert.strictEqual(top.combo, 1, 'merge should retain the original combo payload');

        const next = heap.pop();
        assert.ok(next);
        assert.strictEqual(next.meta, 2n);
        assert.strictEqual(next.prob, 5n);
    });

    it('merged item bubbles up to the correct position', () => {
        const heap = new SearchHeap(4);
        heap.pushOrMerge(1n, 5n, 1);
        heap.pushOrMerge(2n, 10n, 2);
        heap.pushOrMerge(1n, 10n, 1);

        assert.strictEqual(heap.peekProb(), 15n);
        const top = heap.pop();
        assert.ok(top);
        assert.strictEqual(top.meta, 1n);
        assert.strictEqual(top.prob, 15n);
    });

    it('clone produces an independent deep copy', () => {
        const heap = new SearchHeap(4);
        heap.pushOrMerge(10n, 10n, 10);
        heap.pushOrMerge(20n, 5n, 20);

        const clone = heap.clone();
        clone.pushOrMerge(30n, 100n, 30);

        assert.strictEqual(heap.size(), 2);
        assert.strictEqual(clone.size(), 3);
        assert.strictEqual(heap.peekProb(), 10n);
        assert.strictEqual(clone.peekProb(), 100n);
    });

    it('grows and rehashes without losing ordering or dedupe behavior', () => {
        const heap = new SearchHeap(2);

        for (let i = 0; i < 20; i++) {
            heap.pushOrMerge(BigInt(i), BigInt(i + 1), i);
        }
        for (let i = 0; i < 20; i += 3) {
            heap.pushOrMerge(BigInt(i), 100n, i);
        }

        assert.strictEqual(heap.size(), 20);
        assert.strictEqual(heap.indexMapSize, 20);

        const drained = drain(heap);
        for (let i = 1; i < drained.length; i++) {
            assert.ok(drained[i - 1]!.prob >= drained[i]!.prob, 'heap order should remain descending after grow/rehash');
        }

        const boosted = new Map(drained.map(item => [item.meta, item.prob]));
        assert.strictEqual(boosted.get(0n), 101n);
        assert.strictEqual(boosted.get(3n), 104n);
        assert.strictEqual(boosted.get(18n), 119n);
    });

    it('copyTo can copy into a smaller destination heap after source growth', () => {
        const source = new SearchHeap(2);
        for (let i = 0; i < 12; i++) {
            source.pushOrMerge(BigInt(i), BigInt(50 - i), i + 0.5);
        }

        const destination = new SearchHeap(2);
        assert.doesNotThrow(() => source.copyTo(destination));
        assert.deepStrictEqual(snapshotByDrain(destination), snapshotByDrain(source));
    });

    it('copyTo overwrites a larger dirty destination with an exact clone of the source', () => {
        const source = new SearchHeap(2);
        for (let i = 0; i < 8; i++) {
            source.pushOrMerge(BigInt(i), BigInt(40 - i), i + 0.25);
        }

        const destination = new SearchHeap(32);
        for (let i = 0; i < 20; i++) {
            destination.pushOrMerge(BigInt(100 + i), BigInt(i + 1), i + 0.75);
        }

        assert.doesNotThrow(() => source.copyTo(destination));
        assert.strictEqual(destination.indexMapSize, source.indexMapSize);
        assert.deepStrictEqual(snapshotByDrain(destination), snapshotByDrain(source));
    });

    it('reuses tombstones even when a tiny heap hash table has no empty buckets left', () => {
        const heap = new SearchHeap(1);
        const bucket0 = findMetaForBucket(heap, 0);
        const bucket1 = findMetaForBucket(heap, 1);
        const bucket0Replacement = bucket0 === 1n || bucket1 === 1n ? 3n : 1n;

        heap.pushOrMerge(bucket0, 1n, 10);
        heap.pop();

        heap.pushOrMerge(bucket1, 1n, 20);
        heap.pop();

        assert.strictEqual(heap.size(), 0);
        assert.strictEqual(heap.indexMapSize, 0);

        assert.doesNotThrow(() => heap.pushOrMerge(bucket0Replacement, 7n, 30));

        const item = heap.pop();
        assert.ok(item);
        assert.strictEqual(item.meta, bucket0Replacement);
        assert.strictEqual(item.prob, 7n);
        assert.strictEqual(item.combo, 30);
    });

    it('matches a reference model across deterministic random operations', () => {
        const heap = new SearchHeap(4);
        const ref = new Map<bigint, { prob: bigint; combo: number }>();
        const rand = makeDeterministicRng(0xC0FFEE);

        for (let step = 0; step < 400; step++) {
            const doPush = ref.size === 0 || rand() < 0.72;

            if (doPush) {
                const meta = BigInt(Math.floor(rand() * 25));
                const prob = BigInt(1 + Math.floor(rand() * 11));
                const combo = Math.floor(rand() * 1000);

                heap.pushOrMerge(meta, prob, combo);
                const existing = ref.get(meta);
                if (existing) {
                    existing.prob += prob;
                } else {
                    ref.set(meta, { prob, combo });
                }
            } else {
                const expected = getReferenceMax(ref);
                const popped = heap.pop();
                assert.ok(popped, 'heap should pop when reference model is non-empty');
                assert.strictEqual(popped.prob, expected.maxProb);
                assert.ok(expected.metas.includes(popped.meta), 'popped meta should be one of the reference maxima');
                ref.delete(popped.meta);
            }

            assert.strictEqual(heap.size(), ref.size);
            assert.strictEqual(heap.indexMapSize, ref.size);
        }

        while (ref.size > 0) {
            const expected = getReferenceMax(ref);
            const popped = heap.pop();
            assert.ok(popped);
            assert.strictEqual(popped.prob, expected.maxProb);
            assert.ok(expected.metas.includes(popped.meta));
            ref.delete(popped.meta);
        }

        assert.strictEqual(heap.size(), 0);
        assert.strictEqual(heap.indexMapSize, 0);
        assert.strictEqual(heap.pop(), undefined);
    });
});
