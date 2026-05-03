import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DATA } from '#data/index.js';
import { RegistryFactory } from '#core/factory.js';
import { CACHE_CONFIG, ENGINE_LIMITS } from '#constants/engine.js';
import { CacheManager } from '#engine/cache/CacheManager.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import { SearchService } from '#engine/search/SearchService.js';
import { type SearchIdentityMode } from '#engine/search/SearchPoolPlan.js';
import { SearchState } from '#types/index.js';
import { ProbUtils } from '#utils/index.js';

const registry = RegistryFactory.build(DATA, '1.21.11');

function createCache(): CacheManager {
    return new CacheManager({
        comboOtherSize: CACHE_CONFIG.COMBO_OTHER_SIZE,
        comboBookSize: CACHE_CONFIG.COMBO_BOOK_SIZE,
        statsSize: CACHE_CONFIG.STATS_SIZE,
        poolSize: CACHE_CONFIG.POOL_SIZE
    });
}

async function searchCurrentBookPool(identityModeOverride?: SearchIdentityMode): Promise<SearchState> {
    const service = new SearchService(
        createCache(),
        new ModifiedLevelDistributionService(1024),
        { identityModeOverride }
    );

    return service.searchModifiedLevel({
        registry,
        cat: 'book',
        mat: 'book',
        modLevel: 30,
        threshold: ProbUtils.toBigInt(0.001),
        limit: ENGINE_LIMITS.MAX_ITERATIONS_UNBOUNDED,
        resultsLimit: ENGINE_LIMITS.MAX_RESULTS_SIZE
    });
}

function sortedResults(state: SearchState): [number, string][] {
    return [...state.results.entries()]
        .map(([combo, mass]) => [combo, mass.toString()] as [number, string])
        .sort((a, b) => a[0] - b[0]);
}

function sortedFrontier(state: SearchState): [number, string, number, string][] {
    const rows: [number, string, number, string][] = [];
    state.queue.forEachNode((nodeId, prob) => {
        rows.push([
            state.graph.getCombo(nodeId),
            state.graph.getMeta(nodeId).toString(),
            state.graph.getCount(nodeId),
            prob.toString()
        ]);
    });
    return rows.sort((a, b) => {
        if (a[0] !== b[0]) return a[0] - b[0];
        if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
        if (a[2] !== b[2]) return a[2] - b[2];
        return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
    });
}

describe('Search identity mode parity', () => {
    it('BigInt64 mode returns the same current book-pool search data as number53 mode', async () => {
        const numberState = await searchCurrentBookPool();
        const bigintState = await searchCurrentBookPool('bigint64');

        assert.ok(bigintState.graph.size > 1, 'expected search to create non-root graph nodes');
        assert.strictEqual(bigintState.graph.isNumericNode(1), false, 'forced BigInt64 mode should store non-root nodes as BigInt identity');

        assert.deepStrictEqual(sortedResults(bigintState), sortedResults(numberState));
        assert.deepStrictEqual(bigintState.tracker.mass.getBookkeeping(), numberState.tracker.mass.getBookkeeping());
        assert.deepStrictEqual(sortedFrontier(bigintState), sortedFrontier(numberState));
        assert.strictEqual(bigintState.exitReason, numberState.exitReason);
        assert.strictEqual(bigintState.threshold, numberState.threshold);
    });
});
