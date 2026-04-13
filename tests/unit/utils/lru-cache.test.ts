/**
 * Unit tests for LRUCache.
 *
 * Verifies basic operations, eviction policy (least-recently-used entry
 * is evicted when capacity is exceeded), and access-order refresh semantics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LRUCache } from '../../../src/lib/utils/collections/LRUCache.js';

describe('LRUCache', () => {
    // ── Basic operations ──────────────────────────────────────────────────

    it('get returns undefined for a missing key', () => {
        const cache = new LRUCache<string, number>();
        assert.strictEqual(cache.get('missing'), undefined);
    });

    it('set and get round-trip', () => {
        const cache = new LRUCache<string, number>();
        cache.set('a', 42);
        assert.strictEqual(cache.get('a'), 42);
    });

    it('has returns true for a present key', () => {
        const cache = new LRUCache<string, number>();
        cache.set('x', 1);
        assert.strictEqual(cache.has('x'), true);
    });

    it('has returns false for an absent key', () => {
        const cache = new LRUCache<string, number>();
        assert.strictEqual(cache.has('y'), false);
    });

    it('size is 0 on a fresh cache', () => {
        const cache = new LRUCache<string, number>();
        assert.strictEqual(cache.size, 0);
    });

    it('size reflects the number of entries', () => {
        const cache = new LRUCache<string, number>();
        cache.set('a', 1);
        assert.strictEqual(cache.size, 1);
        cache.set('b', 2);
        assert.strictEqual(cache.size, 2);
    });

    it('clear empties the cache', () => {
        const cache = new LRUCache<string, number>();
        cache.set('a', 1);
        cache.set('b', 2);
        cache.clear();
        assert.strictEqual(cache.size, 0);
        assert.strictEqual(cache.has('a'), false);
        assert.strictEqual(cache.has('b'), false);
    });

    it('set on an existing key replaces the value', () => {
        const cache = new LRUCache<string, number>();
        cache.set('a', 1);
        cache.set('a', 99);
        assert.strictEqual(cache.get('a'), 99);
        assert.strictEqual(cache.size, 1);
    });

    // ── Eviction ──────────────────────────────────────────────────────────

    it('evicts the oldest entry when capacity is exceeded', () => {
        const cache = new LRUCache<string, number>(3);
        cache.set('a', 1); // oldest
        cache.set('b', 2);
        cache.set('c', 3);
        // Inserting 'd' should evict 'a'
        cache.set('d', 4);
        assert.strictEqual(cache.size, 3);
        assert.strictEqual(cache.has('a'), false, '"a" (oldest) should be evicted');
        assert.strictEqual(cache.get('b'), 2);
        assert.strictEqual(cache.get('c'), 3);
        assert.strictEqual(cache.get('d'), 4);
    });

    it('evicts second-oldest when oldest was accessed after insertion', () => {
        const cache = new LRUCache<string, number>(3);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        // Access 'a' — it is now the most-recently-used
        cache.get('a');
        // Insert 'd': 'b' is now the LRU, so it should be evicted
        cache.set('d', 4);
        assert.strictEqual(cache.has('b'), false, '"b" should be evicted (LRU)');
        assert.strictEqual(cache.get('a'), 1, '"a" should survive (was refreshed)');
        assert.strictEqual(cache.get('c'), 3);
        assert.strictEqual(cache.get('d'), 4);
    });

    it('re-setting an existing key refreshes its position (oldest is then evicted)', () => {
        const cache = new LRUCache<string, number>(3);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        // Re-set 'a' — it moves to front (MRU)
        cache.set('a', 10);
        // Insert 'd': 'b' is now the LRU
        cache.set('d', 4);
        assert.strictEqual(cache.has('b'), false, '"b" should be evicted');
        assert.strictEqual(cache.get('a'), 10, '"a" should have updated value');
        assert.strictEqual(cache.get('c'), 3);
        assert.strictEqual(cache.get('d'), 4);
    });

    it('never exceeds maxEntries (default 500)', () => {
        const cache = new LRUCache<number, number>();
        for (let i = 0; i < 600; i++) cache.set(i, i);
        assert.strictEqual(cache.size, 500);
        // The 100 oldest entries (0-99) should be gone
        assert.strictEqual(cache.has(0), false, 'entry 0 should have been evicted');
        assert.strictEqual(cache.has(99), false, 'entry 99 should have been evicted');
        assert.strictEqual(cache.has(100), true, 'entry 100 should survive');
        assert.strictEqual(cache.has(599), true, 'newest entry should survive');
    });

    it('custom maxEntries is respected', () => {
        const cache = new LRUCache<number, number>(5);
        for (let i = 0; i < 6; i++) cache.set(i, i);
        assert.strictEqual(cache.size, 5);
        assert.strictEqual(cache.has(0), false, 'entry 0 should be evicted with maxEntries=5');
    });
});

