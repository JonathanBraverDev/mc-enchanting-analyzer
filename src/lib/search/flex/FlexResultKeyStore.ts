import type {
    FlexPoolProfileId,
    FlexProgramId,
    FlexResultId,
    FlexResultKey
} from '#lib/search/flex/FlexTypes.js';

const EMPTY_RESULT_ID = 0 as FlexResultId;

export class FlexResultKeyStore {
    public readonly empty: FlexResultId = EMPTY_RESULT_ID;

    private readonly records: FlexResultKey[] = [Object.freeze({
        id: EMPTY_RESULT_ID,
        programId: 0 as FlexProgramId,
        poolProfileId: 0 as FlexPoolProfileId
    })];
    private readonly idsByKey = new Map<string, FlexResultId>([['0:0', EMPTY_RESULT_ID]]);

    public getOrCreate(programId: FlexProgramId, poolProfileId: FlexPoolProfileId): FlexResultId {
        const key = createKey(programId, poolProfileId);
        const existing = this.idsByKey.get(key);
        if (existing !== undefined) return existing;

        const id = this.records.length as FlexResultId;
        this.records.push(Object.freeze({ id, programId, poolProfileId }));
        this.idsByKey.set(key, id);
        return id;
    }

    public get(id: FlexResultId): FlexResultKey {
        const record = this.records[id as number];
        if (!record) throw new Error(`Unknown Flex result key ID ${String(id)}.`);
        return record;
    }
}

function createKey(programId: FlexProgramId, poolProfileId: FlexPoolProfileId): string {
    return `${String(programId)}:${String(poolProfileId)}`;
}
