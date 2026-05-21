import type { PackedEnchant } from '#types/index.js';
import {
    type FlexAlternative,
    type FlexChoiceEmission,
    type FlexEmission,
    type FlexNode,
    type FlexNodeId,
    type FlexProgram,
    type FlexProgramId
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

const EMPTY_PROGRAM_ID = 0 as FlexProgramId;

export class FlexProgramStore {
    public readonly empty: FlexProgramId = EMPTY_PROGRAM_ID;

    private readonly records: FlexProgramRecord[] = [Object.freeze({
        id: EMPTY_PROGRAM_ID,
        parentId: null,
        emission: null,
        hasChoice: false,
        slotCount: 0
    })];
    private readonly idsByTransition = new Map<string, FlexProgramId>();
    private readonly idsByProgramKey = new Map<string, FlexProgramId>([['', EMPTY_PROGRAM_ID]]);
    private readonly programCache: Array<FlexProgram | undefined> = [Object.freeze([])];

    public constructor(private readonly options: FlexProgramStoreOptions = {}) {}

    public appendFixed(parentId: FlexProgramId, packedEnchant: PackedEnchant): FlexProgramId {
        return this.appendEmission(parentId, Object.freeze({
            kind: 'fixed',
            packedEnchant
        }));
    }

    public appendChoice(
        parentId: FlexProgramId,
        alternatives: readonly FlexAlternative[]
    ): FlexProgramId {
        return this.appendEmission(parentId, this.canonicalizeChoice(alternatives));
    }

    public appendEmission(parentId: FlexProgramId, emission: FlexEmission): FlexProgramId {
        this.assertProgram(parentId);
        const canonical = this.canonicalizeEmission(emission);
        if (this.options.canonicalizeProgramOrder) {
            const nextProgram = this.insertCanonicalEmission(this.getProgram(parentId), canonical);
            return this.getOrCreateProgram(nextProgram);
        }

        const transitionKey = `${String(parentId)}|${this.createEmissionKey(canonical)}`;
        const existing = this.idsByTransition.get(transitionKey);
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
        this.idsByTransition.set(transitionKey, id);
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

    private canonicalizeEmission(emission: FlexEmission): FlexEmission {
        if (emission.kind === 'fixed') {
            return Object.freeze({
                kind: 'fixed',
                packedEnchant: emission.packedEnchant
            });
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

        const canonicalAlternatives = Object.freeze([...weightsByEnchant.entries()]
            .sort(([left], [right]) => Number(left) - Number(right))
            .map(([packedEnchant, weight]) => Object.freeze({ packedEnchant, weight })));
        return Object.freeze({
            kind: 'choice',
            alternatives: canonicalAlternatives,
            totalWeight: canonicalAlternatives.reduce((sum, alternative) => sum + alternative.weight, 0)
        });
    }

    private getOrCreateProgram(program: readonly FlexEmission[]): FlexProgramId {
        if (program.length === 0) return EMPTY_PROGRAM_ID;
        const key = this.createProgramKey(program);
        const existing = this.idsByProgramKey.get(key);
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
        this.idsByProgramKey.set(key, id);
        this.programCache.push(undefined);
        return id;
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

    private createProgramKey(program: readonly FlexEmission[]): string {
        return program.map(emission => this.createEmissionKey(emission)).join('|');
    }

    private createEmissionKey(emission: FlexEmission): string {
        if (emission.kind === 'fixed') return `f:${String(emission.packedEnchant)}`;
        return `c:${emission.alternatives
            .map(alternative => `${String(alternative.packedEnchant)}:${alternative.weight}`)
            .join(',')}`;
    }

    private assertProgram(id: FlexProgramId): void {
        if (id < 0 || id >= this.records.length) {
            throw new Error(`Unknown Flex program ID ${String(id)}.`);
        }
    }
}
