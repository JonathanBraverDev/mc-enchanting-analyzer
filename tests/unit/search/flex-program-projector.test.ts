import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PackedCombo, PackedEnchant } from '#types/index.js';
import type { PendingFrontierAggregates } from '#lib/search/SearchRun.js';
import { ComboUtils } from '#utils/index.js';
import {
    FlexProgramStore,
    FlexProjector,
    type FlexNodeId,
    type FlexPendingEntry
} from '#lib/search/flex/index.js';

const packed = (id: number, rank = 1): PackedEnchant => ((id << 8) | rank) as PackedEnchant;
const nodeId = (id: number): FlexNodeId => id as FlexNodeId;

const sharpness = packed(1, 4);
const smite = packed(2, 4);
const looting = packed(3, 3);
const unbreaking = packed(4, 3);
const sharpnessThree = packed(1, 3);
const enchantToIndex = new Map<number, number>([
    [sharpness, 1],
    [smite, 2],
    [looting, 3],
    [unbreaking, 4]
]);

const combo = (...enchants: PackedEnchant[]) => ComboUtils.pack([...enchants], enchantToIndex);

describe('FlexProgramStore', () => {
    it('interns equivalent scoped program transitions without module-global identity', () => {
        const first = new FlexProgramStore();
        const fixed = first.appendFixed(first.empty, sharpness);
        const sameFixed = first.appendFixed(first.empty, sharpness);
        const choice = first.appendChoice(first.empty, [
            { packedEnchant: smite, weight: 2 },
            { packedEnchant: sharpness, weight: 1 }
        ]);
        const sameChoice = first.appendChoice(first.empty, [
            { packedEnchant: sharpness, weight: 1 },
            { packedEnchant: smite, weight: 2 }
        ]);

        assert.strictEqual(fixed, sameFixed);
        assert.strictEqual(choice, sameChoice);

        const choiceEmission = first.getProgram(choice)[0];
        assert.strictEqual(choiceEmission?.kind, 'choice');
        if (choiceEmission?.kind === 'choice') {
            assert.deepStrictEqual(
                choiceEmission.alternatives.map(alternative => alternative.packedEnchant),
                [sharpness, smite]
            );
            assert.strictEqual(choiceEmission.totalWeight, 3);
        }

        const second = new FlexProgramStore();
        assert.strictEqual(second.appendFixed(second.empty, sharpness), fixed);
    });

    it('canonicalizes equivalent program emission order when requested', () => {
        const store = new FlexProgramStore({ canonicalizeProgramOrder: true });
        const sharpThenChoice = store.appendChoice(store.appendFixed(store.empty, sharpness), [
            { packedEnchant: looting, weight: 1 },
            { packedEnchant: unbreaking, weight: 3 }
        ]);
        const choiceThenSharp = store.appendFixed(store.appendChoice(store.empty, [
            { packedEnchant: unbreaking, weight: 3 },
            { packedEnchant: looting, weight: 1 }
        ]), sharpness);

        assert.strictEqual(sharpThenChoice, choiceThenSharp);
        assert.deepStrictEqual(store.getProgram(sharpThenChoice).map(emission => emission.kind), ['fixed', 'choice']);
    });

    it('uses already-canonical grouped choices without changing choice identity', () => {
        const store = new FlexProgramStore();
        const canonical = store.appendCanonicalChoice(store.empty, [
            { packedEnchant: sharpness, weight: 1 },
            { packedEnchant: smite, weight: 2 }
        ]);
        const normalized = store.appendChoice(store.empty, [
            { packedEnchant: smite, weight: 2 },
            { packedEnchant: sharpness, weight: 1 }
        ]);

        assert.strictEqual(canonical, normalized);
        assert.throws(
            () => store.appendCanonicalChoice(store.empty, [
                { packedEnchant: smite, weight: 2 },
                { packedEnchant: sharpness, weight: 1 }
            ]),
            /unique and sorted/
        );
    });

    it('classifies SolidNode and PlexNode variants from program contents', () => {
        const store = new FlexProgramStore();
        const solidProgram = store.appendFixed(store.empty, sharpness);
        const plexProgram = store.appendChoice(solidProgram, [
            { packedEnchant: looting, weight: 1 },
            { packedEnchant: unbreaking, weight: 1 }
        ]);
        const solidAfterPlexProgram = store.appendFixed(plexProgram, smite);

        assert.strictEqual(store.createNode(nodeId(1), solidProgram).kind, 'solid');
        assert.strictEqual(store.createNode(nodeId(2), plexProgram).kind, 'plex');
        assert.strictEqual(store.createNode(nodeId(3), solidAfterPlexProgram).kind, 'plex');
    });
});

describe('FlexProjector', () => {
    it('projects fixed-only programs to one concrete combo row', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex);
        const program = store.appendFixed(store.empty, sharpness);
        const projected = projector.projectResults(new Map([[program, 10n]]));

        assert.strictEqual(projected.results.get(combo(sharpness)), 10n);
        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('projects weighted choices and records integer projection loss', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex);
        const program = store.appendChoice(store.empty, [
            { packedEnchant: sharpness, weight: 1 },
            { packedEnchant: smite, weight: 2 }
        ]);
        const projected = projector.projectResults(new Map([[program, 10n]]));

        assert.strictEqual(projected.results.get(combo(sharpness)), 3n);
        assert.strictEqual(projected.results.get(combo(smite)), 6n);
        assert.strictEqual(projected.projectedMass, 9n);
        assert.strictEqual(projected.projectionLoss, 1n);
    });

    it('projects independent choice factors as a product', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex);
        const damage = store.appendChoice(store.empty, [
            { packedEnchant: sharpness, weight: 1 },
            { packedEnchant: smite, weight: 1 }
        ]);
        const fullProgram = store.appendChoice(damage, [
            { packedEnchant: looting, weight: 1 },
            { packedEnchant: unbreaking, weight: 3 }
        ]);

        const projected = projector.projectResults(new Map([[fullProgram, 24n]]));

        assert.strictEqual(projected.results.get(combo(sharpness, looting)), 3n);
        assert.strictEqual(projected.results.get(combo(sharpness, unbreaking)), 9n);
        assert.strictEqual(projected.results.get(combo(smite, looting)), 3n);
        assert.strictEqual(projected.results.get(combo(smite, unbreaking)), 9n);
        assert.strictEqual(projected.projectedMass, 24n);
        assert.strictEqual(projected.clueIncompatible, 0n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('keeps only exact clue matches inside a choice emission', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { targetClueId: sharpness });
        const fixed = store.appendFixed(store.empty, looting);
        const program = store.appendChoice(fixed, [
            { packedEnchant: sharpness, weight: 2 },
            { packedEnchant: smite, weight: 1 }
        ]);

        const projected = projector.projectResults(new Map([[program, 12n]]));

        assert.strictEqual(projected.results.get(combo(sharpness, looting)), 8n);
        assert.strictEqual(projected.results.has(combo(smite, looting)), false);
        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.clueIncompatible, 4n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('lets a fixed matching clue survive all choice alternatives', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { targetClueId: sharpness });
        const fixed = store.appendFixed(store.empty, sharpness);
        const program = store.appendChoice(fixed, [
            { packedEnchant: looting, weight: 1 },
            { packedEnchant: unbreaking, weight: 3 }
        ]);

        const projected = projector.projectResults(new Map([[program, 12n]]));

        assert.strictEqual(projected.results.get(combo(sharpness, looting)), 3n);
        assert.strictEqual(projected.results.get(combo(sharpness, unbreaking)), 9n);
        assert.strictEqual(projected.clueIncompatible, 0n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('does not treat higher ranks as matching a lower exact table clue', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { targetClueId: sharpnessThree });
        const program = store.appendFixed(store.empty, sharpness);

        const projected = projector.projectResults(new Map([[program, 10n]]));

        assert.strictEqual(projected.results.size, 0);
        assert.strictEqual(projected.projectedMass, 0n);
        assert.strictEqual(projected.clueIncompatible, 10n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('applies book removal uniformly across fixed generated slots', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { applyBookRemoval: true });
        const first = store.appendFixed(store.empty, sharpness);
        const program = store.appendFixed(first, smite);

        const projected = projector.projectResults(new Map([[program, 11n]]));

        assert.strictEqual(projected.results.get(combo(sharpness)), 5n);
        assert.strictEqual(projected.results.get(combo(smite)), 5n);
        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.projectionLoss, 1n);
        assert.strictEqual(projected.projectedMass + projected.projectionLoss, projected.sourceMass);
    });

    it('treats a weighted choice as one removable book slot', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { applyBookRemoval: true });
        const first = store.appendFixed(store.empty, sharpness);
        const program = store.appendChoice(first, [
            { packedEnchant: looting, weight: 1 },
            { packedEnchant: unbreaking, weight: 3 }
        ]);

        const projected = projector.projectResults(new Map([[program, 24n]]));

        assert.strictEqual(projected.results.get(combo(sharpness)), 12n);
        assert.strictEqual(projected.results.get(combo(looting)), 3n);
        assert.strictEqual(projected.results.get(combo(unbreaking)), 9n);
        assert.strictEqual(projected.projectedMass, 24n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('treats book-removal outcomes that drop the exact clue as clue-incompatible', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, {
            applyBookRemoval: true,
            targetClueId: sharpness
        });
        const first = store.appendFixed(store.empty, sharpness);
        const program = store.appendFixed(first, smite);

        const projected = projector.projectResults(new Map([[program, 10n]]));

        assert.strictEqual(projected.results.get(combo(sharpness)), 5n);
        assert.strictEqual(projected.results.has(combo(smite)), false);
        assert.strictEqual(projected.projectedMass, 5n);
        assert.strictEqual(projected.clueIncompatible, 5n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('does not expose the empty program as public combo row zero', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex);
        const projected = projector.projectResults(new Map([[store.empty, 5n]]));

        assert.strictEqual(projected.results.has(0 as PackedCombo), false);
        assert.strictEqual(projected.projectedMass, 5n);
    });

    it('projects pending factorized programs into concrete-compatible pending rows', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex);
        const program = store.appendChoice(store.empty, [
            { packedEnchant: sharpness, weight: 1 },
            { packedEnchant: smite, weight: 2 }
        ]);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(7),
            programId: program,
            mass: 10n,
            count: 1,
            nodeKind: 'plex'
        }];

        const projected = projector.projectPending(pending);

        assert.deepStrictEqual(
            projected.map(entry => ({ combo: entry.combo, mass: entry.mass, count: entry.count })),
            [
                { combo: combo(sharpness), mass: 3n, count: 1 },
                { combo: combo(smite), mass: 6n, count: 1 }
            ]
        );
    });

    it('keeps pending projection pre-book-removal', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { applyBookRemoval: true });
        const first = store.appendFixed(store.empty, sharpness);
        const program = store.appendFixed(first, smite);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(11),
            programId: program,
            mass: 10n,
            count: 2,
            nodeKind: 'solid'
        }];

        const projected = projector.projectPending(pending);

        assert.deepStrictEqual(
            projected.map(entry => ({ combo: entry.combo, mass: entry.mass, count: entry.count })),
            [{ combo: combo(sharpness, smite), mass: 10n, count: 2 }]
        );
    });

    it('harvests aggregate pending stats without materializing pending rows', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex);
        const fixed = store.appendFixed(store.empty, sharpness);
        const program = store.appendChoice(fixed, [
            { packedEnchant: smite, weight: 1 },
            { packedEnchant: looting, weight: 3 }
        ]);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(12),
            programId: program,
            mass: 8n,
            count: 2,
            nodeKind: 'plex'
        }];

        const projected = projector.projectPendingAggregates(pending);

        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingAggregates.any[sharpness >> 8], 8n);
        assert.strictEqual(projected.pendingAggregates.any[smite >> 8], 2n);
        assert.strictEqual(projected.pendingAggregates.any[looting >> 8], 6n);
        assert.strictEqual(projected.pendingAggregates.ranks[sharpness], 8n);
        assert.strictEqual(projected.pendingAggregates.ranks[smite], 2n);
        assert.strictEqual(projected.pendingAggregates.ranks[looting], 6n);
        assert.strictEqual(projected.pendingAggregates.count[2], 8n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(sharpness), 4n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(smite), 1n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(looting), 3n);
    });

    it('uses book pending aggregate survival rates without applying result book removal', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { applyBookRemoval: true });
        const first = store.appendFixed(store.empty, sharpness);
        const program = store.appendFixed(first, smite);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(14),
            programId: program,
            mass: 10n,
            count: 2,
            nodeKind: 'solid'
        }];

        const projected = projector.projectPendingAggregates(pending);

        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingAggregates.any[sharpness >> 8], 5n);
        assert.strictEqual(projected.pendingAggregates.any[smite >> 8], 5n);
        assert.strictEqual(projected.pendingAggregates.ranks[sharpness], 5n);
        assert.strictEqual(projected.pendingAggregates.ranks[smite], 5n);
        assert.strictEqual(projected.pendingAggregates.count[1], 10n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(sharpness), 5n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(smite), 5n);
    });

    it('splits clue-choice pending aggregates without expanding independent alternatives', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { targetClueId: sharpness });
        const fixed = store.appendFixed(store.empty, looting);
        const program = store.appendChoice(fixed, [
            { packedEnchant: sharpness, weight: 2 },
            { packedEnchant: smite, weight: 1 }
        ]);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(15),
            programId: program,
            mass: 12n,
            count: 2,
            nodeKind: 'plex',
            targetClueReachable: false
        }];

        const projected = projector.projectPendingAggregates(pending);
        const clueJoint = projected.pendingAggregates.clueJoint;

        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.clueIncompatible, 4n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(sharpness), 4n);
        assert.ok(clueJoint);
        assert.strictEqual(clueJoint.targetClueId, sharpness);
        assert.strictEqual(clueJoint.knownSpace, 4n);
        assert.strictEqual(clueJoint.count[2], 4n);
        assert.strictEqual(clueJoint.any[sharpness >> 8], 4n);
        assert.strictEqual(clueJoint.any[looting >> 8], 4n);
        assert.strictEqual(clueJoint.any[smite >> 8] ?? 0n, 0n);
        assert.strictEqual(clueJoint.ranks[sharpness], 4n);
        assert.strictEqual(clueJoint.ranks[looting], 4n);
    });

    it('tracks clue-incompatible pending source mass without book removal', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, {
            applyBookRemoval: true,
            targetClueId: sharpness
        });
        const fixed = store.appendFixed(store.empty, looting);
        const program = store.appendChoice(fixed, [
            { packedEnchant: sharpness, weight: 2 },
            { packedEnchant: smite, weight: 1 }
        ]);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(13),
            programId: program,
            mass: 12n,
            count: 2,
            nodeKind: 'plex'
        }];

        const projected = projector.projectPendingWithDiagnostics(pending);

        assert.deepStrictEqual(
            projected.pendingEntries.map(entry => ({ combo: entry.combo, mass: entry.mass, count: entry.count })),
            [
                { combo: combo(sharpness, looting), mass: 8n, count: 2 }
            ]
        );
        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.clueIncompatible, 4n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('keeps pending branches that can still reach the exact clue', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { targetClueId: sharpness });
        const program = store.appendFixed(store.empty, looting);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(17),
            programId: program,
            mass: 10n,
            count: 1,
            nodeKind: 'solid',
            targetClueReachable: true
        }];

        const projected = projector.projectPendingWithDiagnostics(pending);

        assert.deepStrictEqual(
            projected.pendingEntries.map(entry => ({ combo: entry.combo, mass: entry.mass, count: entry.count })),
            [{ combo: combo(looting), mass: 10n, count: 1 }]
        );
        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.clueIncompatible, 0n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('builds lazy pending aggregate buckets only when read and reuses them', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { applyBookRemoval: true });
        const fixed = store.appendFixed(store.empty, sharpness);
        const program = store.appendChoice(fixed, [
            { packedEnchant: smite, weight: 1 },
            { packedEnchant: looting, weight: 3 }
        ]);
        const pending: FlexPendingEntry[] = [
            {
                graphId: 0,
                nodeId: nodeId(18),
                programId: program,
                mass: 24n,
                count: 2,
                nodeKind: 'plex'
            },
            {
                graphId: 0,
                nodeId: nodeId(19),
                programId: fixed,
                mass: 5n,
                count: 1,
                nodeKind: 'solid'
            }
        ];

        const eager = projector.projectPendingAggregates(pending);
        let buildCount = 0;
        const lazy = projector.projectPendingLazyAggregatesFromCursor(visitor => {
            for (const entry of pending) visitor(entry.programId, entry.mass, entry.count, entry.targetClueReachable);
        }, {
            onBuild: () => { buildCount++; }
        });

        assert.strictEqual(lazy.sourceMass, eager.sourceMass);
        assert.strictEqual(lazy.projectedMass, eager.projectedMass);
        assert.strictEqual(lazy.clueIncompatible, eager.clueIncompatible);
        assert.strictEqual(lazy.projectionLoss, eager.projectionLoss);
        assert.strictEqual(buildCount, 0);
        assert.deepStrictEqual(Object.keys(lazy.pendingAggregates), ['any', 'ranks', 'count', 'shownClueDistribution']);

        assertAggregatesEqual(lazy.pendingAggregates, eager.pendingAggregates);
        assert.strictEqual(buildCount, 1);
        assert.strictEqual(lazy.pendingAggregates.any, lazy.pendingAggregates.any);
        assert.strictEqual(lazy.pendingAggregates.shownClueDistribution, lazy.pendingAggregates.shownClueDistribution);
        assert.strictEqual(buildCount, 1);
    });

    it('keeps lazy clue pending aggregates exact and snapshot-stable', () => {
        const store = new FlexProgramStore();
        const projector = new FlexProjector(store, enchantToIndex, { targetClueId: sharpness });
        const fixed = store.appendFixed(store.empty, looting);
        const program = store.appendChoice(fixed, [
            { packedEnchant: sharpness, weight: 2 },
            { packedEnchant: smite, weight: 1 }
        ]);
        const pending: FlexPendingEntry[] = [{
            graphId: 0,
            nodeId: nodeId(20),
            programId: program,
            mass: 13n,
            count: 2,
            nodeKind: 'plex',
            targetClueReachable: false
        }];

        const eager = projector.projectPendingAggregates(pending);
        let buildCount = 0;
        const lazy = projector.projectPendingLazyAggregatesFromCursor(visitor => {
            for (const entry of pending) visitor(entry.programId, entry.mass, entry.count, entry.targetClueReachable);
        }, {
            onBuild: () => { buildCount++; }
        });
        pending[0] = { ...pending[0]!, mass: 999n };

        assert.strictEqual(buildCount, 0);
        assert.deepStrictEqual(Object.keys(lazy.pendingAggregates), ['any', 'ranks', 'count', 'shownClueDistribution', 'clueJoint']);
        assertAggregatesEqual(lazy.pendingAggregates, eager.pendingAggregates);
        assert.strictEqual(buildCount, 1);
        assert.strictEqual(lazy.pendingAggregates.clueJoint, lazy.pendingAggregates.clueJoint);
        assert.strictEqual(buildCount, 1);
    });
});

function assertAggregatesEqual(
    actual: PendingFrontierAggregates,
    expected: PendingFrontierAggregates
): void {
    assert.deepStrictEqual(toDenseRecord(actual.any), toDenseRecord(expected.any));
    assert.deepStrictEqual(toDenseRecord(actual.ranks), toDenseRecord(expected.ranks));
    assert.deepStrictEqual(toDenseRecord(actual.count), toDenseRecord(expected.count));
    assert.deepStrictEqual(toMapRecord(actual.shownClueDistribution), toMapRecord(expected.shownClueDistribution));
    assert.strictEqual(actual.clueJoint?.targetClueId, expected.clueJoint?.targetClueId);
    assert.strictEqual(actual.clueJoint?.knownSpace, expected.clueJoint?.knownSpace);
    assert.deepStrictEqual(toDenseRecord(actual.clueJoint?.any ?? []), toDenseRecord(expected.clueJoint?.any ?? []));
    assert.deepStrictEqual(toDenseRecord(actual.clueJoint?.ranks ?? []), toDenseRecord(expected.clueJoint?.ranks ?? []));
    assert.deepStrictEqual(toDenseRecord(actual.clueJoint?.count ?? []), toDenseRecord(expected.clueJoint?.count ?? []));
}

function toDenseRecord(source: readonly bigint[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let index = 0; index < source.length; index++) {
        const mass = source[index];
        if (mass !== undefined && mass !== 0n) result[index] = mass.toString();
    }
    return result;
}

function toMapRecord(source: ReadonlyMap<number, bigint>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, mass] of source) {
        if (mass !== 0n) result[key] = mass.toString();
    }
    return result;
}
