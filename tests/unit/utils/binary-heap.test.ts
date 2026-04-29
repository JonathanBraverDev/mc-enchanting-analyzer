import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BinaryHeap } from '#utils/collections/BinaryHeap.js';

describe('BinaryHeap', () => {
    it('pop returns items in descending prob order (max-heap)', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        for (const p of [10n, 5n, 20n, 1n, 15n]) heap.push({ prob: p });

        const out: bigint[] = [];
        while (heap.size() > 0) out.push(heap.pop()!.prob);

        assert.deepStrictEqual(out, [20n, 15n, 10n, 5n, 1n]);
    });

    it('peek returns max without removing', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        heap.push({ prob: 5n });
        heap.push({ prob: 10n });

        assert.strictEqual(heap.peek()?.prob, 10n);
        assert.strictEqual(heap.size(), 2);
        assert.strictEqual(heap.peek()?.prob, 10n); // idempotent
    });

    it('pop on empty heap returns undefined', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        assert.strictEqual(heap.pop(), undefined);
    });

    it('size tracks insertions and removals', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        assert.strictEqual(heap.size(), 0);
        heap.push({ prob: 1n });
        assert.strictEqual(heap.size(), 1);
        heap.push({ prob: 2n });
        assert.strictEqual(heap.size(), 2);
        heap.pop();
        assert.strictEqual(heap.size(), 1);
    });

    it('items getter exposes all elements', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        heap.push({ prob: 3n });
        heap.push({ prob: 1n });
        heap.push({ prob: 2n });

        assert.strictEqual(heap.items.length, 3);
        assert.ok(heap.items.some(i => i.prob === 3n));
        assert.ok(heap.items.some(i => i.prob === 1n));
        assert.ok(heap.items.some(i => i.prob === 2n));
    });

    it('idSelector merges probability for duplicate ids', () => {
        type Item = { prob: bigint; id: bigint };
        const heap = new BinaryHeap<Item>(item => item.id);

        heap.push({ prob: 10n, id: 1n });
        heap.push({ prob: 5n, id: 2n });
        heap.push({ prob: 3n, id: 1n }); // merges into id=1

        assert.strictEqual(heap.size(), 2);

        const top = heap.pop()!;
        assert.strictEqual(top.id, 1n);
        assert.strictEqual(top.prob, 13n); // 10 + 3

        const next = heap.pop()!;
        assert.strictEqual(next.id, 2n);
        assert.strictEqual(next.prob, 5n);
    });

    it('idSelector: merged item bubbles up to correct position', () => {
        type Item = { prob: bigint; id: bigint };
        const heap = new BinaryHeap<Item>(item => item.id);

        heap.push({ prob: 5n, id: 1n });
        heap.push({ prob: 10n, id: 2n }); // id=2 is current top
        heap.push({ prob: 10n, id: 1n }); // id=1 becomes 15n, should now be top

        assert.strictEqual(heap.peek()?.id, 1n);
        assert.strictEqual(heap.peek()?.prob, 15n);
    });

    it('clone produces independent deep copy', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        heap.push({ prob: 10n });
        heap.push({ prob: 5n });

        const clone = heap.clone();

        // Drain original
        heap.pop();
        heap.pop();

        // Clone is unaffected
        assert.strictEqual(clone.size(), 2);
        assert.strictEqual(clone.peek()?.prob, 10n);
    });

    it('clone with idSelector: structural independence (size/push/pop differ)', () => {
        type Item = { prob: bigint; id: bigint };
        const heap = new BinaryHeap<Item>(item => item.id);
        heap.push({ prob: 7n, id: 10n });
        heap.push({ prob: 3n, id: 20n });

        const clone = heap.clone();

        // Push a brand-new id to clone only
        clone.push({ prob: 100n, id: 30n });

        assert.strictEqual(heap.size(), 2);  // original unaffected
        assert.strictEqual(clone.size(), 3); // clone has the new item

        assert.strictEqual(heap.peek()?.id, 10n);  // original top unchanged
        assert.strictEqual(clone.peek()?.id, 30n); // clone top is new item
    });

    it('maintains max-heap invariant with many insertions', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        const probs = [7n, 3n, 11n, 1n, 5n, 9n, 13n, 2n, 4n, 6n, 8n, 10n, 12n];
        for (const p of probs) heap.push({ prob: p });

        const sorted: bigint[] = [];
        while (heap.size() > 0) sorted.push(heap.pop()!.prob);

        const expected = [...probs].sort((a, b) => (a > b ? -1 : 1));
        assert.deepStrictEqual(sorted, expected);
    });

    it('single element: push then pop returns same item', () => {
        const heap = new BinaryHeap<{ prob: bigint }>();
        heap.push({ prob: 42n });
        const item = heap.pop();
        assert.strictEqual(item?.prob, 42n);
        assert.strictEqual(heap.size(), 0);
    });
});


