import { FLEX_MERGE_FLAGS_NONE, FLEX_MERGE_FLAGS_RANK } from '#lib/search/flex/FlexTypes.js';
import type { PackedEnchant } from '#types/index.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import type {
    FlexPoolProfile,
    FlexPoolProfileAlternative,
    FlexPoolProfileEnchant,
    FlexPoolProfileId,
    FlexPoolProfileSource,
    FlexPoolProfileStoreMemoryStats
} from '#lib/search/flex/FlexTypes.js';

const SINGLE_SOURCE_PROFILE_CHILD_LEVEL = -1;

export interface FlexPoolProfileSourceInput {
    readonly pool: SearchPool;
    readonly level: number;
    readonly sourceMass: bigint;
    readonly profileWeight: bigint;
}

export interface FlexPoolProfileRequest {
    readonly familyKey: string;
    readonly childLevel: number;
    readonly sources: readonly FlexPoolProfileSourceInput[];
}

interface MutableSource {
    readonly exactKey: SearchPoolSignature;
    readonly pool: SearchPool;
    levelCount: number;
    sourceMass: bigint;
    profileWeight: bigint;
}

export class FlexPoolProfileStore {
    private readonly records: FlexPoolProfile[] = [];
    private readonly idsByKey = new Map<string, FlexPoolProfileId>();

    public get size(): number {
        return this.records.length;
    }

    public getOrCreateSingle(pool: SearchPool): FlexPoolProfile {
        return this.getOrCreate({
            familyKey: pool.familySignature,
            childLevel: SINGLE_SOURCE_PROFILE_CHILD_LEVEL,
            sources: [Object.freeze({
                pool,
                level: pool.level,
                sourceMass: 0n,
                profileWeight: 1n
            })]
        });
    }

    public getOrCreate(request: FlexPoolProfileRequest): FlexPoolProfile {
        const sources = this.createSources(request.sources);
        if (sources.length === 0) {
            throw new Error('Cannot create a pool profile without positive profile-weight sources.');
        }

        const key = this.createProfileKey(request.familyKey, request.childLevel, sources);
        const existing = this.idsByKey.get(key);
        if (existing !== undefined) return this.get(existing);

        const profile = this.createProfile(request.familyKey, request.childLevel, sources);
        this.records.push(profile);
        this.idsByKey.set(key, profile.id);
        return profile;
    }

    public get(id: FlexPoolProfileId): FlexPoolProfile {
        const profile = this.records[id as number];
        if (!profile) throw new Error(`Unknown Flex pool profile ID ${String(id)}.`);
        return profile;
    }

    public getPackedEnchant(id: FlexPoolProfileId, enchantId: number, sourceIndex: number): PackedEnchant {
        const profile = this.get(id);
        const enchant = profile.enchants.find(candidate => candidate.enchantId === enchantId);
        if (enchant === undefined) {
            throw new Error(`Pool profile ${String(id)} does not include enchant ${String(enchantId)}.`);
        }
        const packedEnchant = enchant.sourcePackedEnchants[sourceIndex];
        if (packedEnchant === undefined) {
            throw new Error(`Pool profile ${String(id)} does not include source ${String(sourceIndex)} for enchant ${String(enchantId)}.`);
        }
        return packedEnchant;
    }

    public getMergeFlags(id: FlexPoolProfileId): number {
        return this.get(id).mergeFlags;
    }

    public guaranteesPackedEnchant(id: FlexPoolProfileId, enchantId: number, packedEnchant: PackedEnchant): boolean {
        const profile = this.get(id);
        const enchant = profile.enchants.find(candidate => candidate.enchantId === enchantId);
        return enchant !== undefined && enchant.sourcePackedEnchants.every(candidate => candidate === packedEnchant);
    }

    public canMaterializePackedEnchant(id: FlexPoolProfileId, enchantId: number, packedEnchant: PackedEnchant): boolean {
        const profile = this.get(id);
        const enchant = profile.enchants.find(candidate => candidate.enchantId === enchantId);
        return enchant !== undefined && enchant.sourcePackedEnchants.some(candidate => candidate === packedEnchant);
    }

    public getMemoryStats(): FlexPoolProfileStoreMemoryStats {
        let sourceExactPoolCount = 0;
        let sourceLevelCount = 0;
        let sourceMass = 0n;
        let profileWeight = 0n;
        let rankVariantEnchantCount = 0;
        let rankAlternativeCount = 0;
        let maxExactPoolCount = 0;
        let maxLevelCount = 0;
        let maxRankVariantEnchantCount = 0;
        let maxRankAlternativeCount = 0;

        for (const profile of this.records) {
            sourceExactPoolCount += profile.sources.length;
            sourceLevelCount += profile.sources.reduce((total, source) => total + source.levelCount, 0);
            sourceMass += profile.totalSourceMass;
            profileWeight += profile.totalWeight;
            rankVariantEnchantCount += profile.rankVariantEnchantCount;
            rankAlternativeCount += profile.rankAlternativeCount;
            maxExactPoolCount = Math.max(maxExactPoolCount, profile.sources.length);
            maxLevelCount = Math.max(maxLevelCount, profile.sources.reduce((total, source) => total + source.levelCount, 0));
            maxRankVariantEnchantCount = Math.max(maxRankVariantEnchantCount, profile.rankVariantEnchantCount);
            maxRankAlternativeCount = Math.max(maxRankAlternativeCount, profile.rankAlternativeCount);
        }

        return Object.freeze({
            profileCount: this.records.length,
            sourceExactPoolCount,
            sourceLevelCount,
            sourceMass,
            profileWeight,
            rankVariantEnchantCount,
            rankAlternativeCount,
            maxExactPoolCount,
            maxLevelCount,
            maxRankVariantEnchantCount,
            maxRankAlternativeCount
        });
    }

    private createSources(inputs: readonly FlexPoolProfileSourceInput[]): readonly MutableSource[] {
        const byExactKey = new Map<SearchPoolSignature, MutableSource>();
        for (const input of inputs) {
            if (input.profileWeight <= 0n) continue;
            const exactKey = input.pool.signature;
            let source = byExactKey.get(exactKey);
            if (!source) {
                source = {
                    exactKey,
                    pool: input.pool,
                    levelCount: 0,
                    sourceMass: 0n,
                    profileWeight: 0n
                };
                byExactKey.set(exactKey, source);
            }
            source.levelCount++;
            source.sourceMass += input.sourceMass;
            source.profileWeight += input.profileWeight;
        }

        return Object.freeze([...byExactKey.values()]
            .sort((left, right) => left.exactKey.localeCompare(right.exactKey)));
    }

    private createProfile(
        familyKey: string,
        childLevel: number,
        mutableSources: readonly MutableSource[]
    ): FlexPoolProfile {
        const sources = Object.freeze(mutableSources.map(source => Object.freeze({
            exactKey: source.exactKey,
            levelCount: source.levelCount,
            sourceMass: source.sourceMass,
            profileWeight: source.profileWeight
        } satisfies FlexPoolProfileSource)));
        const totalSourceMass = sources.reduce((total, source) => total + source.sourceMass, 0n);
        const totalWeight = sources.reduce((total, source) => total + source.profileWeight, 0n);
        const weightGcd = sources.reduce((current, source) => gcdBigInt(current, source.profileWeight), 0n);
        const enchants = this.createEnchantProfiles(mutableSources, totalWeight);
        const rankVariantEnchantCount = enchants.filter(enchant => enchant.alternatives.length > 1).length;
        const rankAlternativeCount = enchants.reduce((total, enchant) => total + enchant.alternatives.length, 0);
        const mergeFlags = mutableSources.length > 1 ? FLEX_MERGE_FLAGS_RANK : FLEX_MERGE_FLAGS_NONE;

        return Object.freeze({
            id: this.records.length as FlexPoolProfileId,
            familyKey,
            childLevel,
            sources,
            totalSourceMass,
            totalWeight,
            weightGcd,
            enchants,
            rankVariantEnchantCount,
            rankAlternativeCount,
            mergeFlags
        });
    }

    private createEnchantProfiles(
        sources: readonly MutableSource[],
        totalWeight: bigint
    ): readonly FlexPoolProfileEnchant[] {
        const weightsByEnchant = new Map<number, Map<PackedEnchant, bigint>>();
        for (const source of sources) {
            for (const entry of source.pool.entries) {
                let weightsByPacked = weightsByEnchant.get(entry.enchantId);
                if (!weightsByPacked) {
                    weightsByPacked = new Map<PackedEnchant, bigint>();
                    weightsByEnchant.set(entry.enchantId, weightsByPacked);
                }
                weightsByPacked.set(
                    entry.packedEnchant,
                    (weightsByPacked.get(entry.packedEnchant) ?? 0n) + source.profileWeight
                );
            }
        }

        return Object.freeze([...weightsByEnchant.entries()]
            .sort(([left], [right]) => left - right)
            .map(([enchantId, weightsByPacked]) => {
                const sourcePackedEnchants = Object.freeze(sources.map(source => {
                    const entry = source.pool.entries.find(candidate => candidate.enchantId === enchantId);
                    if (entry === undefined) {
                        throw new Error(`Pool profile source ${source.exactKey} is missing enchant ${String(enchantId)}.`);
                    }
                    return entry.packedEnchant;
                }));
                const alternatives = Object.freeze([...weightsByPacked.entries()]
                    .sort(([left], [right]) => Number(left) - Number(right))
                    .map(([packedEnchant, weight]) => Object.freeze({
                        packedEnchant,
                        weight
                    } satisfies FlexPoolProfileAlternative)));
                const coveredWeight = alternatives.reduce((total, alternative) => total + alternative.weight, 0n);
                if (coveredWeight !== totalWeight) {
                    throw new Error(`Pool profile enchant ${String(enchantId)} does not cover every profile source.`);
                }
                return Object.freeze({
                    enchantId,
                    alternatives,
                    sourcePackedEnchants
                } satisfies FlexPoolProfileEnchant);
            }));
    }

    private createProfileKey(
        familyKey: string,
        childLevel: number,
        sources: readonly MutableSource[]
    ): string {
        return [
            familyKey,
            String(childLevel),
            ...sources.map(source => `${source.exactKey}:${source.profileWeight.toString()}`)
        ].join('|');
    }
}

function gcdBigInt(left: bigint, right: bigint): bigint {
    let a = left < 0n ? -left : left;
    let b = right < 0n ? -right : right;
    while (b !== 0n) {
        const next = a % b;
        a = b;
        b = next;
    }
    return a;
}
