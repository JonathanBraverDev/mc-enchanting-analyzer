import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RegistryFactory } from '#core/factory.js';
import { RegistryKernel } from '#lib/search/index.js';
import { FlexRankProfileStore } from '#lib/search/flex/index.js';

describe('FlexRankProfileStore', () => {
    it('builds stable rank profiles from converged exact-pool sources', () => {
        const registry = RegistryFactory.build('1.21.11');
        const kernel = new RegistryKernel({ registry, item: 'pickaxe', material: 'diamond' });
        const level10Pool = kernel.getPool(10);
        const level11Pool = kernel.getPool(11);
        const childLevel = Math.floor(10 / kernel.additionalEnchantmentLevelDivisor);
        const store = new FlexRankProfileStore();

        const profile = store.getOrCreate({
            familyKey: level10Pool.familySignature,
            childLevel,
            sources: [
                { pool: level10Pool, level: 10, sourceMass: 20n, profileWeight: 2n },
                { pool: level11Pool, level: 11, sourceMass: 30n, profileWeight: 3n }
            ]
        });
        const sameProfile = store.getOrCreate({
            familyKey: level10Pool.familySignature,
            childLevel,
            sources: [
                { pool: level11Pool, level: 11, sourceMass: 30n, profileWeight: 3n },
                { pool: level10Pool, level: 10, sourceMass: 20n, profileWeight: 2n }
            ]
        });

        assert.strictEqual(sameProfile.id, profile.id);
        assert.strictEqual(profile.childLevel, childLevel);
        assert.strictEqual(profile.sources.length, 2);
        assert.strictEqual(profile.totalSourceMass, 50n);
        assert.strictEqual(profile.totalWeight, 5n);
        assert.strictEqual(profile.weightGcd, 1n);

        const rankVariantEnchants = profile.enchants.filter(enchant => enchant.alternatives.length > 1);
        assert.strictEqual(rankVariantEnchants.length, 1);
        assert.strictEqual(profile.rankVariantEnchantCount, 1);
        assert.strictEqual(
            rankVariantEnchants[0]!.alternatives.reduce((total, alternative) => total + alternative.weight, 0n),
            profile.totalWeight
        );

        assert.deepStrictEqual(store.getMemoryStats(), {
            profileCount: 1,
            sourceExactPoolCount: 2,
            sourceLevelCount: 2,
            sourceMass: 50n,
            profileWeight: 5n,
            rankVariantEnchantCount: 1,
            rankAlternativeCount: profile.rankAlternativeCount,
            maxExactPoolCount: 2,
            maxLevelCount: 2,
            maxRankVariantEnchantCount: 1,
            maxRankAlternativeCount: profile.rankAlternativeCount
        });
    });
});
