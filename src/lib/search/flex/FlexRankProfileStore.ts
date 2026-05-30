import type { PackedEnchant } from '#types/index.js';
import type { SearchPool, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import type {
    FlexRankProfile,
    FlexRankProfileAlternative,
    FlexRankProfileEnchant,
    FlexRankProfileId,
    FlexRankProfileSource,
    FlexRankProfileStoreMemoryStats
} from '#lib/search/flex/FlexTypes.js';

export interface FlexRankProfileSourceInput {
    readonly pool: SearchPool;
    readonly level: number;
    readonly sourceMass: bigint;
    readonly profileWeight: bigint;
}

export interface FlexRankProfileRequest {
    readonly familyKey: string;
    readonly childLevel: number;
    readonly sources: readonly FlexRankProfileSourceInput[];
}

interface MutableSource {
    readonly exactKey: SearchPoolSignature;
    readonly pool: SearchPool;
    levelCount: number;
    sourceMass: bigint;
    profileWeight: bigint;
}

export class FlexRankProfileStore {
    private readonly records: FlexRankProfile[] = [];
    private readonly idsByKey = new Map<string, FlexRankProfileId>();

    public get size(): number {
        return this.records.length;
    }

    public getOrCreate(request: FlexRankProfileRequest): FlexRankProfile {
        const sources = this.createSources(request.sources);
        if (sources.length === 0) {
            throw new Error('Cannot create a rank profile without positive profile-weight sources.');
        }

        const key = this.createProfileKey(request.familyKey, request.childLevel, sources);
        const existing = this.idsByKey.get(key);
        if (existing !== undefined) return this.get(existing);

        const profile = this.createProfile(request.familyKey, request.childLevel, sources);
        this.records.push(profile);
        this.idsByKey.set(key, profile.id);
        return profile;
    }

    public get(id: FlexRankProfileId): FlexRankProfile {
        const profile = this.records[id as number];
        if (!profile) throw new Error(`Unknown Flex rank profile ID ${String(id)}.`);
        return profile;
    }

    public getMemoryStats(): FlexRankProfileStoreMemoryStats {
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

    private createSources(inputs: readonly FlexRankProfileSourceInput[]): readonly MutableSource[] {
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
    ): FlexRankProfile {
        const sources = Object.freeze(mutableSources.map(source => Object.freeze({
            exactKey: source.exactKey,
            levelCount: source.levelCount,
            sourceMass: source.sourceMass,
            profileWeight: source.profileWeight
        } satisfies FlexRankProfileSource)));
        const totalSourceMass = sources.reduce((total, source) => total + source.sourceMass, 0n);
        const totalWeight = sources.reduce((total, source) => total + source.profileWeight, 0n);
        const weightGcd = sources.reduce((current, source) => gcdBigInt(current, source.profileWeight), 0n);
        const enchants = this.createEnchantProfiles(mutableSources, totalWeight);
        const rankVariantEnchantCount = enchants.filter(enchant => enchant.alternatives.length > 1).length;
        const rankAlternativeCount = enchants.reduce((total, enchant) => total + enchant.alternatives.length, 0);

        return Object.freeze({
            id: this.records.length as FlexRankProfileId,
            familyKey,
            childLevel,
            sources,
            totalSourceMass,
            totalWeight,
            weightGcd,
            enchants,
            rankVariantEnchantCount,
            rankAlternativeCount
        });
    }

    private createEnchantProfiles(
        sources: readonly MutableSource[],
        totalWeight: bigint
    ): readonly FlexRankProfileEnchant[] {
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
                        throw new Error(`Rank profile source ${source.exactKey} is missing enchant ${String(enchantId)}.`);
                    }
                    return entry.packedEnchant;
                }));
                const alternatives = Object.freeze([...weightsByPacked.entries()]
                    .sort(([left], [right]) => Number(left) - Number(right))
                    .map(([packedEnchant, weight]) => Object.freeze({
                        packedEnchant,
                        weight
                    } satisfies FlexRankProfileAlternative)));
                const coveredWeight = alternatives.reduce((total, alternative) => total + alternative.weight, 0n);
                if (coveredWeight !== totalWeight) {
                    throw new Error(`Rank profile enchant ${String(enchantId)} does not cover every profile source.`);
                }
                return Object.freeze({
                    enchantId,
                    alternatives,
                    sourcePackedEnchants
                } satisfies FlexRankProfileEnchant);
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
