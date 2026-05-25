import { ENGINE_LIMITS } from '#constants/engine.js';
import { ModifiedLevelDistributionService } from '#engine/distribution/ModifiedLevelDistributionService.js';
import type { FlexAlternative, FlexEmission, FlexProgram, FlexProgramId } from '#lib/search/flex/FlexTypes.js';
import { FlexProgramStore } from '#lib/search/flex/FlexProgramStore.js';
import { FLEX_GRAPH_TRAVERSAL, FLEX_REDUCED_KEY_INVARIANT_LIMITS } from '#lib/search/flex/FlexConstants.js';
import { RegistryKernel, type SearchPool, type SearchPoolEntry, type SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';

export interface FlexReducedKeyInvariantRequest {
    readonly kernel: RegistryKernel;
    readonly xp: number;
    readonly distributionService?: ModifiedLevelDistributionService | undefined;
    readonly maxConflicts?: number | undefined;
}

export interface FlexReducedKeyInvariantConflict {
    readonly graphId: number;
    readonly stateKey: string;
    readonly firstProgram: string;
    readonly nextProgram: string;
}

export interface FlexReducedKeyInvariantResult {
    readonly ok: boolean;
    readonly conflicts: readonly FlexReducedKeyInvariantConflict[];
    readonly checkedStateCount: number;
    readonly transitionCount: number;
    readonly graphCount: number;
}

interface PendingGroupedEdge {
    readonly childExclusionMask: bigint;
    readonly alternatives: FlexAlternative[];
    weight: number;
}

interface FlexInvariantWorkItem {
    readonly graphId: number;
    readonly pool: SearchPool;
    readonly exclusionMask: bigint;
    readonly currentLevel: number;
    readonly count: number;
    readonly programId: FlexProgramId;
}

interface FlexInvariantGraphRecord {
    readonly id: number;
    readonly pool: SearchPool;
}

/**
 * Verifies the reduced Flex graph-key invariant for one registry/item/material/XP cell.
 *
 * Grouped Flex nodes are structurally keyed by `(exclusionMask, currentLevel, count)`.
 * This is safe only when every path that reaches the same structural state carries a
 * projection-equivalent program history. Program IDs are intentionally not compared
 * directly: vanilla data can reach the same state with order-only differences, and Flex
 * projection treats fixed emissions and independent choices as unordered factors.
 */
export function checkFlexReducedKeyInvariant(request: FlexReducedKeyInvariantRequest): FlexReducedKeyInvariantResult {
    const distributionService = request.distributionService ?? new ModifiedLevelDistributionService();
    const programs = new FlexProgramStore();
    const graphsBySignature = new Map<SearchPoolSignature, FlexInvariantGraphRecord>();
    const graphs: FlexInvariantGraphRecord[] = [];
    const programByState = new Map<string, string>();
    const stack: FlexInvariantWorkItem[] = [];
    const conflicts: FlexReducedKeyInvariantConflict[] = [];
    const maxConflicts = Math.max(
        FLEX_REDUCED_KEY_INVARIANT_LIMITS.MIN_CONFLICTS,
        request.maxConflicts ?? FLEX_REDUCED_KEY_INVARIANT_LIMITS.DEFAULT_MAX_CONFLICTS
    );
    let transitionCount = 0;

    const distribution = distributionService.getModifiedLevelDist(
        request.kernel.registry,
        request.xp,
        request.kernel.enchantability
    );

    for (const [levelText, rootMass] of Object.entries(distribution)) {
        if (rootMass === 0n) continue;
        const level = Number(levelText);
        const graph = getGraphRecord(request.kernel.getPool(level), graphsBySignature, graphs);
        stack.push(Object.freeze({
            graphId: graph.id,
            pool: graph.pool,
            exclusionMask: FLEX_GRAPH_TRAVERSAL.ROOT_EXCLUSION_MASK,
            currentLevel: level,
            count: FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT,
            programId: programs.empty
        }));
    }

    while (stack.length > 0 && conflicts.length < maxConflicts) {
        const current = stack.pop()!;
        const stateKey = createStateKey(current.graphId, current.exclusionMask, current.currentLevel, current.count);
        const programKey = createCanonicalProgramKey(programs.getProgram(current.programId));
        const existing = programByState.get(stateKey);
        if (existing !== undefined) {
            if (existing !== programKey) {
                conflicts.push(Object.freeze({
                    graphId: current.graphId,
                    stateKey,
                    firstProgram: existing,
                    nextProgram: programKey
                }));
            }
            continue;
        }
        programByState.set(stateKey, programKey);

        if (isTerminalState(request.kernel, current.count)) continue;

        const entries = current.count === FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT
            ? current.pool.entries
            : current.pool.entries.filter(entry => (current.exclusionMask & entry.idBit) === 0n);
        if (entries.length === 0) continue;

        const childLevel = current.count === FLEX_GRAPH_TRAVERSAL.ROOT_ENCHANT_COUNT
            ? current.currentLevel
            : Math.floor(current.currentLevel / FLEX_GRAPH_TRAVERSAL.LEVEL_DECAY_DIVISOR);
        const childCount = current.count + FLEX_GRAPH_TRAVERSAL.FIRST_CHILD_ENCHANT_COUNT;
        const groupedEdges = buildGroupedEdges(entries, current.exclusionMask);

        for (const edge of groupedEdges) {
            transitionCount++;
            const childProgramId = edge.alternatives.length === 1
                ? programs.appendFixed(current.programId, edge.alternatives[0]!.packedEnchant)
                : programs.appendChoice(current.programId, edge.alternatives);
            stack.push(Object.freeze({
                graphId: current.graphId,
                pool: current.pool,
                exclusionMask: edge.childExclusionMask,
                currentLevel: childLevel,
                count: childCount,
                programId: childProgramId
            }));
        }
    }

    return Object.freeze({
        ok: conflicts.length === 0,
        conflicts: Object.freeze(conflicts),
        checkedStateCount: programByState.size,
        transitionCount,
        graphCount: graphs.length
    });
}

function getGraphRecord(
    pool: SearchPool,
    graphsBySignature: Map<SearchPoolSignature, FlexInvariantGraphRecord>,
    graphs: FlexInvariantGraphRecord[]
): FlexInvariantGraphRecord {
    const cached = graphsBySignature.get(pool.signature);
    if (cached) return cached;

    const record = Object.freeze({
        id: graphs.length,
        pool
    });
    graphs.push(record);
    graphsBySignature.set(pool.signature, record);
    return record;
}

function buildGroupedEdges(entries: readonly SearchPoolEntry[], parentExclusionMask: bigint): readonly PendingGroupedEdge[] {
    const groups: PendingGroupedEdge[] = [];

    for (const entry of entries) {
        const childExclusionMask = parentExclusionMask | entry.blocksBitset;
        let group = groups.find(candidate => candidate.childExclusionMask === childExclusionMask);
        if (!group) {
            group = {
                childExclusionMask,
                alternatives: [],
                weight: 0
            };
            groups.push(group);
        }

        addAlternative(group, entry);
        group.weight += entry.weight;
    }

    return Object.freeze(groups);
}

function addAlternative(group: PendingGroupedEdge, entry: SearchPoolEntry): void {
    const existing = group.alternatives.find(alternative => alternative.packedEnchant === entry.packedEnchant);
    if (existing) {
        const index = group.alternatives.indexOf(existing);
        group.alternatives[index] = Object.freeze({
            packedEnchant: entry.packedEnchant,
            weight: existing.weight + entry.weight
        });
        return;
    }

    group.alternatives.push(Object.freeze({ packedEnchant: entry.packedEnchant, weight: entry.weight }));
}

function isTerminalState(kernel: RegistryKernel, count: number): boolean {
    if (kernel.item === 'book' && !kernel.multiEnchantBooks && count >= FLEX_GRAPH_TRAVERSAL.SINGLE_ENCHANT_BOOK_MAX_COUNT) return true;
    return count >= ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM;
}

function createStateKey(graphId: number, exclusionMask: bigint, currentLevel: number, count: number): string {
    return `${String(graphId)}:${exclusionMask.toString(16)}:${String(currentLevel)}:${String(count)}`;
}

function createCanonicalProgramKey(program: FlexProgram): string {
    const fixed = program
        .filter((emission): emission is Extract<FlexEmission, { readonly kind: 'fixed' }> => emission.kind === 'fixed')
        .map(emission => String(emission.packedEnchant))
        .sort((left, right) => Number(left) - Number(right));
    const choices = program
        .filter((emission): emission is Extract<FlexEmission, { readonly kind: 'choice' }> => emission.kind === 'choice')
        .map(createChoiceEmissionKey)
        .sort();

    return `f=${fixed.join(',')}|c=${choices.join('/')}`;
}

function createChoiceEmissionKey(emission: Extract<FlexEmission, { readonly kind: 'choice' }>): string {
    return emission.alternatives
        .map(alternative => `${String(alternative.packedEnchant)}:${String(alternative.weight)}`)
        .join(',');
}
