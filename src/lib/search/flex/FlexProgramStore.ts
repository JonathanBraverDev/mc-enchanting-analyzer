import type { PackedEnchant } from '#types/index.js';
import {
    type FlexAlternative,
    type FlexChoiceEmission,
    type FlexEmission,
    type FlexFixedEmission,
    type FlexNode,
    type FlexNodeId,
    type FlexProgram,
    type FlexProgramId,
    type FlexProgramStoreMemoryStats
} from '#lib/search/flex/FlexTypes.js';

interface FlexProgramRecord {
    readonly id: FlexProgramId;
    readonly parentId: FlexProgramId | null;
    readonly emission: FlexEmission | null;
    readonly hasChoice: boolean;
    readonly slotCount: number;
}

export interface FlexProgramStoreOptions {
    /**
     * Canonicalizes full program emission order so conservative program-aware
     * frontier identity can merge equivalent histories reached in different orders.
     * The reduced Flex path keeps the cheaper parent+emission transition identity.
     */
    readonly canonicalizeProgramOrder?: boolean | undefined;
}

interface FlexChoiceInternNode {
    children?: Map<number, FlexChoiceInternNode> | undefined;
    emission?: FlexChoiceEmission | undefined;
}

interface FlexProgramInternNode {
    children?: Map<number, FlexProgramInternNode> | undefined;
    programId?: FlexProgramId | undefined;
}

type FlexEmissionVisitor = (emission: FlexEmission, index: number) => false | void;

interface FlexEmissionVisitResult {
    readonly nextIndex: number;
    readonly stopped: boolean;
}

const EMPTY_PROGRAM_ID = 0 as FlexProgramId;
const FIRST_EMISSION_ID = 1;

export class FlexProgramStore {
    public readonly empty: FlexProgramId = EMPTY_PROGRAM_ID;

    private readonly records: FlexProgramRecord[] = [Object.freeze({
        id: EMPTY_PROGRAM_ID,
        parentId: null,
        emission: null,
        hasChoice: false,
        slotCount: 0
    })];
    private readonly idsByTransition: Array<Array<FlexProgramId | undefined> | undefined> = [];
    private readonly fixedEmissions = new Map<PackedEnchant, FlexFixedEmission>();
    private readonly choiceInternRoot: FlexChoiceInternNode = {};
    private readonly programInternRoot: FlexProgramInternNode = { programId: EMPTY_PROGRAM_ID };
    private readonly emissionIds = new WeakMap<FlexEmission, number>();
    private readonly programCache: Array<FlexProgram | undefined> = [Object.freeze([])];
    private nextEmissionId = FIRST_EMISSION_ID;

    public constructor(private readonly options: FlexProgramStoreOptions = {}) {}

    public appendFixed(parentId: FlexProgramId, packedEnchant: PackedEnchant): FlexProgramId {
        return this.appendEmission(parentId, this.getFixedEmission(packedEnchant));
    }

    public appendChoice(
        parentId: FlexProgramId,
        alternatives: readonly FlexAlternative[]
    ): FlexProgramId {
        return this.appendEmission(parentId, this.canonicalizeChoice(alternatives));
    }

    public appendCanonicalChoice(
        parentId: FlexProgramId,
        alternatives: readonly FlexAlternative[]
    ): FlexProgramId {
        return this.appendCanonicalEmission(parentId, this.getChoiceEmission(alternatives));
    }

    public appendCanonicalChoiceFromArrays(
        parentId: FlexProgramId,
        packedEnchants: ArrayLike<number>,
        weights: ArrayLike<number>,
        length: number
    ): FlexProgramId {
        return this.appendCanonicalEmission(parentId, this.getChoiceEmissionFromArrays(packedEnchants, weights, length));
    }

    public appendPreparedEmission(parentId: FlexProgramId, emission: FlexEmission): FlexProgramId {
        return this.appendCanonicalEmission(parentId, emission);
    }

    public prepareFixedEmission(packedEnchant: PackedEnchant): FlexFixedEmission {
        return this.getFixedEmission(packedEnchant);
    }

    public prepareCanonicalChoiceFromArrays(
        packedEnchants: ArrayLike<number>,
        weights: ArrayLike<number>,
        length: number
    ): FlexChoiceEmission {
        return this.getChoiceEmissionFromArrays(packedEnchants, weights, length);
    }

    public appendEmission(parentId: FlexProgramId, emission: FlexEmission): FlexProgramId {
        this.assertProgram(parentId);
        const canonical = this.canonicalizeEmission(emission);
        return this.appendCanonicalEmission(parentId, canonical);
    }

    private appendCanonicalEmission(parentId: FlexProgramId, canonical: FlexEmission): FlexProgramId {
        this.assertProgram(parentId);
        if (this.options.canonicalizeProgramOrder) {
            const nextProgram = this.insertCanonicalEmission(this.getProgram(parentId), canonical);
            return this.getOrCreateProgram(nextProgram);
        }

        const emissionId = this.getEmissionId(canonical);
        let transitions = this.idsByTransition[parentId];
        const existing = transitions?.[emissionId];
        if (existing !== undefined) return existing;

        const parent = this.records[parentId]!;
        const id = this.records.length as FlexProgramId;
        const record = Object.freeze({
            id,
            parentId,
            emission: canonical,
            hasChoice: parent.hasChoice || canonical.kind === 'choice',
            slotCount: parent.slotCount + 1
        });
        this.records.push(record);
        if (!transitions) {
            transitions = [];
            this.idsByTransition[parentId] = transitions;
        }
        transitions[emissionId] = id;
        this.programCache.push(undefined);
        return id;
    }

    public getProgram(id: FlexProgramId): FlexProgram {
        this.assertProgram(id);
        const cached = this.programCache[id];
        if (cached) return cached;

        const record = this.records[id]!;
        if (record.parentId === null || record.emission === null) return this.programCache[0]!;
        const program = Object.freeze([...this.getProgram(record.parentId), record.emission]);
        this.programCache[id] = program;
        return program;
    }

    public forEachEmission(id: FlexProgramId, visitor: FlexEmissionVisitor): void {
        this.assertProgram(id);
        this.visitEmissionChain(id, 0, visitor);
    }

    public writeProgramEmissions(id: FlexProgramId, target: FlexEmission[]): number {
        this.assertProgram(id);
        const slotCount = this.getSlotCount(id);
        target.length = slotCount;
        let cursor = slotCount - 1;
        let currentId: FlexProgramId | null = id;

        while (currentId !== null) {
            const record: FlexProgramRecord = this.records[currentId]!;
            if (record.emission !== null) target[cursor--] = record.emission;
            currentId = record.parentId;
        }

        return slotCount;
    }

    public guaranteesTargetClue(id: FlexProgramId, targetClueId: number): boolean {
        let guaranteed = false;
        this.forEachEmission(id, emission => {
            if (emission.kind === 'fixed') {
                if (emission.packedEnchant === targetClueId) {
                    guaranteed = true;
                    return false;
                }
                return;
            }

            if (emission.alternatives.length > 0
                && emission.alternatives.every(alternative => alternative.packedEnchant === targetClueId)) {
                guaranteed = true;
                return false;
            }
            return;
        });
        return guaranteed;
    }

    public hasChoice(id: FlexProgramId): boolean {
        this.assertProgram(id);
        return this.records[id]!.hasChoice;
    }

    public getSlotCount(id: FlexProgramId): number {
        this.assertProgram(id);
        return this.records[id]!.slotCount;
    }

    public createNode(id: FlexNodeId, programId: FlexProgramId): FlexNode {
        const count = this.getSlotCount(programId);
        return Object.freeze(this.hasChoice(programId)
            ? { kind: 'plex', id, programId, count }
            : { kind: 'solid', id, programId, count });
    }

    public getMemoryStats(): FlexProgramStoreMemoryStats {
        let cachedProgramCount = 0;
        for (const program of this.programCache) {
            if (program !== undefined) cachedProgramCount++;
        }

        return {
            programCount: this.records.length,
            cachedProgramCount
        };
    }

    private canonicalizeEmission(emission: FlexEmission): FlexEmission {
        if (emission.kind === 'fixed') {
            return this.getFixedEmission(emission.packedEnchant);
        }

        const canonical = this.canonicalizeChoice(emission.alternatives);
        if (canonical.totalWeight !== emission.totalWeight) {
            throw new Error(`Flex choice total weight ${emission.totalWeight} does not match alternatives total ${canonical.totalWeight}.`);
        }
        return canonical;
    }

    private canonicalizeChoice(alternatives: readonly FlexAlternative[]): FlexChoiceEmission {
        if (alternatives.length === 0) throw new Error('Cannot create an empty Flex choice emission.');

        const weightsByEnchant = new Map<PackedEnchant, number>();
        for (const alternative of alternatives) {
            if (!Number.isInteger(alternative.weight) || alternative.weight <= 0) {
                throw new Error('Flex choice weights must be positive integers.');
            }
            weightsByEnchant.set(
                alternative.packedEnchant,
                (weightsByEnchant.get(alternative.packedEnchant) ?? 0) + alternative.weight
            );
        }

        const canonicalAlternatives = [...weightsByEnchant.entries()]
            .sort(([left], [right]) => Number(left) - Number(right))
            .map(([packedEnchant, weight]) => Object.freeze({ packedEnchant, weight }));
        return this.getChoiceEmission(canonicalAlternatives);
    }

    private getFixedEmission(packedEnchant: PackedEnchant): FlexFixedEmission {
        const existing = this.fixedEmissions.get(packedEnchant);
        if (existing) return existing;

        const emission = Object.freeze({
            kind: 'fixed' as const,
            packedEnchant
        });
        this.fixedEmissions.set(packedEnchant, emission);
        this.emissionIds.set(emission, this.nextEmissionId++);
        return emission;
    }

    private getChoiceEmission(alternatives: readonly FlexAlternative[]): FlexChoiceEmission {
        this.assertCanonicalChoiceAlternatives(alternatives);
        let node = this.choiceInternRoot;
        let totalWeight = 0;
        for (const alternative of alternatives) {
            node = getOrCreateChoiceInternNode(node, Number(alternative.packedEnchant));
            node = getOrCreateChoiceInternNode(node, alternative.weight);
            totalWeight += alternative.weight;
        }

        if (node.emission) return node.emission;

        const canonicalAlternatives = Object.freeze([...alternatives]);
        const emission = Object.freeze({
            kind: 'choice' as const,
            alternatives: canonicalAlternatives,
            totalWeight
        });
        node.emission = emission;
        this.emissionIds.set(emission, this.nextEmissionId++);
        return emission;
    }

    private getChoiceEmissionFromArrays(
        packedEnchants: ArrayLike<number>,
        weights: ArrayLike<number>,
        length: number
    ): FlexChoiceEmission {
        this.assertCanonicalChoiceArrays(packedEnchants, weights, length);
        let node = this.choiceInternRoot;
        let totalWeight = 0;
        for (let index = 0; index < length; index++) {
            const packedEnchant = packedEnchants[index]!;
            const weight = weights[index]!;
            node = getOrCreateChoiceInternNode(node, packedEnchant);
            node = getOrCreateChoiceInternNode(node, weight);
            totalWeight += weight;
        }

        if (node.emission) return node.emission;

        const canonicalAlternatives = new Array<FlexAlternative>(length);
        for (let index = 0; index < length; index++) {
            canonicalAlternatives[index] = Object.freeze({
                packedEnchant: packedEnchants[index]! as PackedEnchant,
                weight: weights[index]!
            });
        }

        const emission = Object.freeze({
            kind: 'choice' as const,
            alternatives: Object.freeze(canonicalAlternatives),
            totalWeight
        });
        node.emission = emission;
        this.emissionIds.set(emission, this.nextEmissionId++);
        return emission;
    }

    private assertCanonicalChoiceAlternatives(alternatives: readonly FlexAlternative[]): void {
        if (alternatives.length === 0) throw new Error('Cannot create an empty Flex choice emission.');

        let previousPackedEnchant: PackedEnchant | undefined;
        for (const alternative of alternatives) {
            if (!Number.isInteger(alternative.weight) || alternative.weight <= 0) {
                throw new Error('Flex choice weights must be positive integers.');
            }
            if (previousPackedEnchant !== undefined && alternative.packedEnchant <= previousPackedEnchant) {
                throw new Error('Flex canonical choice alternatives must be unique and sorted by packed enchant.');
            }
            previousPackedEnchant = alternative.packedEnchant;
        }
    }

    private assertCanonicalChoiceArrays(
        packedEnchants: ArrayLike<number>,
        weights: ArrayLike<number>,
        length: number
    ): void {
        if (length <= 0) throw new Error('Cannot create an empty Flex choice emission.');

        let previousPackedEnchant: number | undefined;
        for (let index = 0; index < length; index++) {
            const packedEnchant = packedEnchants[index]!;
            const weight = weights[index]!;
            if (!Number.isInteger(weight) || weight <= 0) {
                throw new Error('Flex choice weights must be positive integers.');
            }
            if (previousPackedEnchant !== undefined && packedEnchant <= previousPackedEnchant) {
                throw new Error('Flex canonical choice alternatives must be unique and sorted by packed enchant.');
            }
            previousPackedEnchant = packedEnchant;
        }
    }

    private getOrCreateProgram(program: readonly FlexEmission[]): FlexProgramId {
        if (program.length === 0) return EMPTY_PROGRAM_ID;
        const node = this.getProgramInternNode(program);
        const existing = node.programId;
        if (existing !== undefined) return existing;

        const parentId = this.getOrCreateProgram(program.slice(0, -1));
        const parent = this.records[parentId]!;
        const emission = program[program.length - 1]!;
        const id = this.records.length as FlexProgramId;
        const record = Object.freeze({
            id,
            parentId,
            emission,
            hasChoice: parent.hasChoice || emission.kind === 'choice',
            slotCount: parent.slotCount + 1
        });
        this.records.push(record);
        node.programId = id;
        this.programCache.push(undefined);
        return id;
    }

    private getProgramInternNode(program: readonly FlexEmission[]): FlexProgramInternNode {
        let node = this.programInternRoot;
        for (const emission of program) {
            const emissionId = this.getEmissionId(emission);
            let children = node.children;
            if (!children) {
                children = new Map<number, FlexProgramInternNode>();
                node.children = children;
            }
            let child = children.get(emissionId);
            if (!child) {
                child = {};
                children.set(emissionId, child);
            }
            node = child;
        }
        return node;
    }

    private insertCanonicalEmission(program: FlexProgram, emission: FlexEmission): readonly FlexEmission[] {
        const next = program.slice();
        let index = 0;
        while (index < next.length && this.compareEmissions(next[index]!, emission) <= 0) index++;
        next.splice(index, 0, emission);
        return Object.freeze(next);
    }

    private compareEmissions(left: FlexEmission, right: FlexEmission): number {
        if (left.kind !== right.kind) return left.kind === 'fixed' ? -1 : 1;
        if (left.kind === 'fixed' && right.kind === 'fixed') return Number(left.packedEnchant) - Number(right.packedEnchant);
        return this.createEmissionKey(left).localeCompare(this.createEmissionKey(right));
    }

    private createEmissionKey(emission: FlexEmission): string {
        if (emission.kind === 'fixed') return `f:${String(emission.packedEnchant)}`;
        return `c:${emission.alternatives
            .map(alternative => `${String(alternative.packedEnchant)}:${alternative.weight}`)
            .join(',')}`;
    }

    private getEmissionId(emission: FlexEmission): number {
        const id = this.emissionIds.get(emission);
        if (id === undefined) throw new Error('Flex emission was not interned before use.');
        return id;
    }

    private visitEmissionChain(
        id: FlexProgramId,
        startIndex: number,
        visitor: FlexEmissionVisitor
    ): FlexEmissionVisitResult {
        const record = this.records[id]!;
        let nextIndex = startIndex;

        if (record.parentId !== null) {
            const parentResult = this.visitEmissionChain(record.parentId, startIndex, visitor);
            if (parentResult.stopped) return parentResult;
            nextIndex = parentResult.nextIndex;
        }

        if (record.emission === null) return { nextIndex, stopped: false };
        const stopped = visitor(record.emission, nextIndex) === false;
        return { nextIndex: nextIndex + 1, stopped };
    }

    private assertProgram(id: FlexProgramId): void {
        if (id < 0 || id >= this.records.length) {
            throw new Error(`Unknown Flex program ID ${String(id)}.`);
        }
    }
}

function getOrCreateChoiceInternNode(parent: FlexChoiceInternNode, key: number): FlexChoiceInternNode {
    let children = parent.children;
    if (!children) {
        children = new Map<number, FlexChoiceInternNode>();
        parent.children = children;
    }

    let child = children.get(key);
    if (!child) {
        child = {};
        children.set(key, child);
    }
    return child;
}
