import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PackedCombo, PackedEnchant } from '#types/index.js';
import type { PendingFrontierAggregates } from '#lib/search/SearchSnapshot.js';
import type { SearchPool, SearchPoolFamilySignature, SearchPoolSignature } from '#lib/search/registry/RegistryKernel.js';
import { ComboUtils } from '#utils/index.js';
import {
    FLEX_MERGE_FLAGS_CONFLICT,
    FLEX_MERGE_FLAGS_NONE,
    FLEX_MERGE_FLAGS_RANK,
    FlexPoolProfileStore,
    FlexProgramStore,
    FlexProjector,
    FlexResultKeyStore,
    hasFlexRankMerge,
    type FlexNodeId,
    type FlexPendingEntry,
    type FlexPoolProfileId,
    type FlexProgramId,
    type FlexProjectionOptions
} from '#lib/search/flex/index.js';

const packed = (id: number, rank = 1): PackedEnchant => ((id << 8) | rank) as PackedEnchant;
const enchantId = (packedEnchant: PackedEnchant): number => packedEnchant >> 8;
const nodeId = (id: number): FlexNodeId => id as FlexNodeId;
const testProfileId = 0 as FlexPoolProfileId;

const SHARPNESS_ID = 1;
const SMITE_ID = 2;
const LOOTING_ID = 3;
const UNBREAKING_ID = 4;

const sharpness = packed(SHARPNESS_ID, 4);
const smite = packed(SMITE_ID, 4);
const looting = packed(LOOTING_ID, 3);
const unbreaking = packed(UNBREAKING_ID, 3);
const sharpnessThree = packed(SHARPNESS_ID, 3);
const unbreakingTwo = packed(UNBREAKING_ID, 2);
const enchantToIndex = new Map<number, number>([
    [sharpness, 1],
    [smite, 2],
    [looting, 3],
    [unbreaking, 4],
    [sharpnessThree, 5],
    [unbreakingTwo, 6]
]);

const exactPool = createPool('exact', [sharpness, smite, looting, unbreaking]);
const rankPoolLow = createPool('rank-low', [sharpnessThree, smite, looting, unbreakingTwo]);
const rankPoolHigh = createPool('rank-high', [sharpness, smite, looting, unbreaking]);

const combo = (...enchants: PackedEnchant[]) => ComboUtils.pack([...enchants], enchantToIndex);
const alt = (packedEnchant: PackedEnchant, weight: number) => ({ enchantId: enchantId(packedEnchant), weight });

describe('FlexProgramStore', () => {
    it('interns equivalent scoped structural transitions without module-global identity', () => {
        const first = new FlexProgramStore();
        const fixed = first.appendFixed(first.empty, SHARPNESS_ID);
        const sameFixed = first.appendFixed(first.empty, SHARPNESS_ID);
        const choice = first.appendChoice(first.empty, [
            { enchantId: SMITE_ID, weight: 2 },
            { enchantId: SHARPNESS_ID, weight: 1 }
        ]);
        const sameChoice = first.appendChoice(first.empty, [
            { enchantId: SHARPNESS_ID, weight: 1 },
            { enchantId: SMITE_ID, weight: 2 }
        ]);

        assert.strictEqual(fixed, sameFixed);
        assert.strictEqual(choice, sameChoice);

        const choiceEmission = first.getProgram(choice)[0];
        assert.strictEqual(choiceEmission?.kind, 'choice');
        if (choiceEmission?.kind === 'choice') {
            assert.deepStrictEqual(
                choiceEmission.alternatives.map(alternative => alternative.enchantId),
                [SHARPNESS_ID, SMITE_ID]
            );
            assert.strictEqual(choiceEmission.totalWeight, 3);
        }

        const second = new FlexProgramStore();
        assert.strictEqual(second.appendFixed(second.empty, SHARPNESS_ID), fixed);
    });

    it('canonicalizes equivalent structural program emission order when requested', () => {
        const store = new FlexProgramStore({ canonicalizeProgramOrder: true });
        const sharpThenChoice = store.appendChoice(store.appendFixed(store.empty, SHARPNESS_ID), [
            { enchantId: LOOTING_ID, weight: 1 },
            { enchantId: UNBREAKING_ID, weight: 3 }
        ]);
        const choiceThenSharp = store.appendFixed(store.appendChoice(store.empty, [
            { enchantId: UNBREAKING_ID, weight: 3 },
            { enchantId: LOOTING_ID, weight: 1 }
        ]), SHARPNESS_ID);

        assert.strictEqual(sharpThenChoice, choiceThenSharp);
        assert.deepStrictEqual(store.getProgram(sharpThenChoice).map(emission => emission.kind), ['fixed', 'choice']);
    });

    it('uses already-canonical grouped choices without changing choice identity', () => {
        const store = new FlexProgramStore();
        const canonical = store.appendCanonicalChoice(store.empty, [
            { enchantId: SHARPNESS_ID, weight: 1 },
            { enchantId: SMITE_ID, weight: 2 }
        ]);
        const normalized = store.appendChoice(store.empty, [
            { enchantId: SMITE_ID, weight: 2 },
            { enchantId: SHARPNESS_ID, weight: 1 }
        ]);

        assert.strictEqual(canonical, normalized);
        assert.throws(
            () => store.appendCanonicalChoice(store.empty, [
                { enchantId: SMITE_ID, weight: 2 },
                { enchantId: SHARPNESS_ID, weight: 1 }
            ]),
            /unique and sorted/
        );
    });

    it('classifies legacy node kind from sticky conflict merge flags', () => {
        const store = new FlexProgramStore();
        const solidProgram = store.appendFixed(store.empty, SHARPNESS_ID);
        const plexProgram = store.appendChoice(solidProgram, [
            { enchantId: LOOTING_ID, weight: 1 },
            { enchantId: UNBREAKING_ID, weight: 1 }
        ]);
        const solidAfterPlexProgram = store.appendFixed(plexProgram, SMITE_ID);

        const solidNode = createProgramNode(store, nodeId(1), solidProgram);
        const plexNode = createProgramNode(store, nodeId(2), plexProgram);
        const solidAfterPlexNode = createProgramNode(store, nodeId(3), solidAfterPlexProgram);

        assert.strictEqual(solidNode.mergeFlags, FLEX_MERGE_FLAGS_NONE);
        assert.strictEqual(plexNode.mergeFlags, FLEX_MERGE_FLAGS_CONFLICT);
        assert.strictEqual(solidAfterPlexNode.mergeFlags, FLEX_MERGE_FLAGS_CONFLICT);
        assert.strictEqual(solidNode.kind, 'solid');
        assert.strictEqual(plexNode.kind, 'plex');
        assert.strictEqual(solidAfterPlexNode.kind, 'plex');
    });

    it('treats Rank as profile metadata instead of a program emission kind', () => {
        const store = new FlexProgramStore();
        const sharpProgram = store.appendFixed(store.empty, SHARPNESS_ID);
        const rankNode = createProgramNode(store, nodeId(1), sharpProgram, FLEX_MERGE_FLAGS_RANK);

        assert.strictEqual(rankNode.mergeFlags, FLEX_MERGE_FLAGS_RANK);
        assert.strictEqual(rankNode.kind, 'solid');
        assert.strictEqual(store.hasChoice(sharpProgram), false);
        assert.strictEqual(store.hasRankMerge(sharpProgram), false);
        assert.strictEqual(store.getFamilyId(sharpProgram), store.getFamilyId(store.appendFixed(store.empty, SHARPNESS_ID)));
    });

    it('uses structural enchant identity for ranks that differ only by pool profile', () => {
        const store = new FlexProgramStore();
        const sharpFourChoice = store.appendChoice(store.empty, [
            { enchantId: enchantId(sharpness), weight: 1 },
            { enchantId: enchantId(smite), weight: 2 }
        ]);
        const sharpThreeChoice = store.appendChoice(store.empty, [
            { enchantId: enchantId(sharpnessThree), weight: 1 },
            { enchantId: enchantId(smite), weight: 2 }
        ]);

        assert.strictEqual(sharpFourChoice, sharpThreeChoice);
        assert.strictEqual(store.getFamilyId(sharpFourChoice), store.getFamilyId(sharpThreeChoice));
    });
});

describe('FlexProjector', () => {
    it('projects fixed-only programs to one concrete combo row', () => {
        const fixture = createProjectionFixture();
        const program = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const projected = projectResults(fixture, program, 10n);

        assert.strictEqual(projected.results.get(combo(sharpness)), 10n);
        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('projects weighted choices and records integer projection loss', () => {
        const fixture = createProjectionFixture();
        const program = fixture.store.appendChoice(fixture.store.empty, [
            alt(sharpness, 1),
            alt(smite, 2)
        ]);
        const projected = projectResults(fixture, program, 10n);

        assert.strictEqual(projected.results.get(combo(sharpness)), 3n);
        assert.strictEqual(projected.results.get(combo(smite)), 6n);
        assert.strictEqual(projected.projectedMass, 9n);
        assert.strictEqual(projected.projectionLoss, 1n);
    });

    it('projects independent choice factors as a product', () => {
        const fixture = createProjectionFixture();
        const damage = fixture.store.appendChoice(fixture.store.empty, [
            alt(sharpness, 1),
            alt(smite, 1)
        ]);
        const fullProgram = fixture.store.appendChoice(damage, [
            alt(looting, 1),
            alt(unbreaking, 3)
        ]);

        const projected = projectResults(fixture, fullProgram, 24n);

        assert.strictEqual(projected.results.get(combo(sharpness, looting)), 3n);
        assert.strictEqual(projected.results.get(combo(sharpness, unbreaking)), 9n);
        assert.strictEqual(projected.results.get(combo(smite, looting)), 3n);
        assert.strictEqual(projected.results.get(combo(smite, unbreaking)), 9n);
        assert.strictEqual(projected.projectedMass, 24n);
        assert.strictEqual(projected.clueIncompatible, 0n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('projects Rank profiles with source-level correlation', () => {
        const fixture = createProjectionFixture();
        const profile = createRankProfile(fixture.poolProfiles);
        const damage = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const fullProgram = fixture.store.appendFixed(damage, UNBREAKING_ID);

        const projected = projectResults(fixture, fullProgram, 50n, profile.id);

        assert.strictEqual(projected.results.get(combo(sharpnessThree, unbreakingTwo)), 20n);
        assert.strictEqual(projected.results.get(combo(sharpness, unbreaking)), 30n);
        assert.strictEqual(projected.results.has(combo(sharpnessThree, unbreaking)), false);
        assert.strictEqual(projected.results.has(combo(sharpness, unbreakingTwo)), false);
        assert.strictEqual(projected.projectedMass, 50n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(hasFlexRankMerge(profile.mergeFlags), true);
    });

    it('projects combined Rank and Conflict choices with profile-level correlation', () => {
        const fixture = createProjectionFixture();
        const profile = createRankProfile(fixture.poolProfiles);
        const damage = fixture.store.appendChoice(fixture.store.empty, [
            { enchantId: SHARPNESS_ID, weight: 1 },
            { enchantId: SMITE_ID, weight: 2 }
        ]);
        const fullProgram = fixture.store.appendFixed(damage, UNBREAKING_ID);

        const projected = projectResults(fixture, fullProgram, 150n, profile.id);

        assert.strictEqual(projected.results.get(combo(sharpnessThree, unbreakingTwo)), 20n);
        assert.strictEqual(projected.results.get(combo(smite, unbreakingTwo)), 40n);
        assert.strictEqual(projected.results.get(combo(sharpness, unbreaking)), 30n);
        assert.strictEqual(projected.results.get(combo(smite, unbreaking)), 60n);
        assert.strictEqual(projected.results.has(combo(sharpnessThree, unbreaking)), false);
        assert.strictEqual(projected.results.has(combo(sharpness, unbreakingTwo)), false);
        assert.strictEqual(projected.projectedMass, 150n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(fixture.store.hasChoice(fullProgram), true);
        assert.strictEqual(hasFlexRankMerge(profile.mergeFlags), true);
    });

    it('keeps only exact clue matches inside a choice emission', () => {
        const fixture = createProjectionFixture({ targetClueId: sharpness });
        const fixed = fixture.store.appendFixed(fixture.store.empty, LOOTING_ID);
        const program = fixture.store.appendChoice(fixed, [
            alt(sharpness, 2),
            alt(smite, 1)
        ]);

        const projected = projectResults(fixture, program, 12n);

        assert.strictEqual(projected.results.get(combo(sharpness, looting)), 8n);
        assert.strictEqual(projected.results.has(combo(smite, looting)), false);
        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.clueIncompatible, 4n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('lets a fixed matching clue survive all choice alternatives', () => {
        const fixture = createProjectionFixture({ targetClueId: sharpness });
        const fixed = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const program = fixture.store.appendChoice(fixed, [
            alt(looting, 1),
            alt(unbreaking, 3)
        ]);

        const projected = projectResults(fixture, program, 12n);

        assert.strictEqual(projected.results.get(combo(sharpness, looting)), 3n);
        assert.strictEqual(projected.results.get(combo(sharpness, unbreaking)), 9n);
        assert.strictEqual(projected.clueIncompatible, 0n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('does not treat higher ranks as matching a lower exact table clue', () => {
        const fixture = createProjectionFixture({ targetClueId: sharpnessThree });
        const program = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);

        const projected = projectResults(fixture, program, 10n);

        assert.strictEqual(projected.results.size, 0);
        assert.strictEqual(projected.projectedMass, 0n);
        assert.strictEqual(projected.clueIncompatible, 10n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('applies book removal uniformly across fixed generated slots', () => {
        const fixture = createProjectionFixture({ applyBookRemoval: true });
        const first = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const program = fixture.store.appendFixed(first, SMITE_ID);

        const projected = projectResults(fixture, program, 11n);

        assert.strictEqual(projected.results.get(combo(sharpness)), 5n);
        assert.strictEqual(projected.results.get(combo(smite)), 5n);
        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.projectionLoss, 1n);
        assert.strictEqual(projected.projectedMass + projected.projectionLoss, projected.sourceMass);
    });

    it('treats a weighted choice as one removable book slot', () => {
        const fixture = createProjectionFixture({ applyBookRemoval: true });
        const first = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const program = fixture.store.appendChoice(first, [
            alt(looting, 1),
            alt(unbreaking, 3)
        ]);

        const projected = projectResults(fixture, program, 24n);

        assert.strictEqual(projected.results.get(combo(sharpness)), 12n);
        assert.strictEqual(projected.results.get(combo(looting)), 3n);
        assert.strictEqual(projected.results.get(combo(unbreaking)), 9n);
        assert.strictEqual(projected.projectedMass, 24n);
        assert.strictEqual(projected.projectionLoss, 0n);
    });

    it('treats book-removal outcomes that drop the exact clue as clue-incompatible', () => {
        const fixture = createProjectionFixture({
            applyBookRemoval: true,
            targetClueId: sharpness
        });
        const first = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const program = fixture.store.appendFixed(first, SMITE_ID);

        const projected = projectResults(fixture, program, 10n);

        assert.strictEqual(projected.results.get(combo(sharpness)), 5n);
        assert.strictEqual(projected.results.has(combo(smite)), false);
        assert.strictEqual(projected.projectedMass, 5n);
        assert.strictEqual(projected.clueIncompatible, 5n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('does not expose the empty program as public combo row zero', () => {
        const fixture = createProjectionFixture();
        const projected = projectResults(fixture, fixture.store.empty, 5n);

        assert.strictEqual(projected.results.has(0 as PackedCombo), false);
        assert.strictEqual(projected.projectedMass, 5n);
    });

    it('harvests aggregate pending stats without materializing pending rows', () => {
        const fixture = createProjectionFixture();
        const fixed = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const program = fixture.store.appendChoice(fixed, [
            alt(smite, 1),
            alt(looting, 3)
        ]);
        const pending: FlexPendingEntry[] = [createPendingEntry(fixture, program, 8n, 2, 'plex')];

        const projected = fixture.projector.projectPendingAggregates(pending);

        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingAggregates.any[SHARPNESS_ID], 8n);
        assert.strictEqual(projected.pendingAggregates.any[SMITE_ID], 2n);
        assert.strictEqual(projected.pendingAggregates.any[LOOTING_ID], 6n);
        assert.strictEqual(projected.pendingAggregates.ranks[sharpness], 8n);
        assert.strictEqual(projected.pendingAggregates.ranks[smite], 2n);
        assert.strictEqual(projected.pendingAggregates.ranks[looting], 6n);
        assert.strictEqual(projected.pendingAggregates.count[2], 8n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(sharpness), 4n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(smite), 1n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(looting), 3n);
    });

    it('uses book pending aggregate survival rates without applying result book removal', () => {
        const fixture = createProjectionFixture({ applyBookRemoval: true });
        const first = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const program = fixture.store.appendFixed(first, SMITE_ID);
        const pending: FlexPendingEntry[] = [createPendingEntry(fixture, program, 10n, 2, 'solid')];

        const projected = fixture.projector.projectPendingAggregates(pending);

        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingAggregates.any[SHARPNESS_ID], 5n);
        assert.strictEqual(projected.pendingAggregates.any[SMITE_ID], 5n);
        assert.strictEqual(projected.pendingAggregates.ranks[sharpness], 5n);
        assert.strictEqual(projected.pendingAggregates.ranks[smite], 5n);
        assert.strictEqual(projected.pendingAggregates.count[1], 10n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(sharpness), 5n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(smite), 5n);
    });

    it('splits clue-choice pending aggregates without expanding independent alternatives', () => {
        const fixture = createProjectionFixture({ targetClueId: sharpness });
        const fixed = fixture.store.appendFixed(fixture.store.empty, LOOTING_ID);
        const program = fixture.store.appendChoice(fixed, [
            alt(sharpness, 2),
            alt(smite, 1)
        ]);
        const pending: FlexPendingEntry[] = [{
            ...createPendingEntry(fixture, program, 12n, 2, 'plex'),
            targetClueReachable: false
        }];

        const projected = fixture.projector.projectPendingAggregates(pending);
        const clueJoint = projected.pendingAggregates.clueJoint;

        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.clueIncompatible, 4n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(sharpness), 4n);
        assert.ok(clueJoint);
        assert.strictEqual(clueJoint.targetClueId, sharpness);
        assert.strictEqual(clueJoint.knownSpace, 4n);
        assert.strictEqual(clueJoint.count[2], 4n);
        assert.strictEqual(clueJoint.any[SHARPNESS_ID], 4n);
        assert.strictEqual(clueJoint.any[LOOTING_ID], 4n);
        assert.strictEqual(clueJoint.any[SMITE_ID] ?? 0n, 0n);
        assert.strictEqual(clueJoint.ranks[sharpness], 4n);
        assert.strictEqual(clueJoint.ranks[looting], 4n);
    });

    it('tracks clue-incompatible pending source mass without book removal', () => {
        const fixture = createProjectionFixture({
            applyBookRemoval: true,
            targetClueId: sharpness
        });
        const fixed = fixture.store.appendFixed(fixture.store.empty, LOOTING_ID);
        const program = fixture.store.appendChoice(fixed, [
            alt(sharpness, 2),
            alt(smite, 1)
        ]);
        const pending: FlexPendingEntry[] = [createPendingEntry(fixture, program, 12n, 2, 'plex')];

        const projected = fixture.projector.projectPendingAggregates(pending);
        const clueJoint = projected.pendingAggregates.clueJoint;

        assert.strictEqual(projected.projectedMass, 8n);
        assert.strictEqual(projected.clueIncompatible, 4n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
        assert.strictEqual(projected.pendingAggregates.shownClueDistribution.get(sharpness), 4n);
        assert.ok(clueJoint);
        assert.strictEqual(clueJoint.knownSpace, 4n);
    });

    it('keeps pending branches that can still reach the exact clue', () => {
        const fixture = createProjectionFixture({ targetClueId: sharpness });
        const program = fixture.store.appendFixed(fixture.store.empty, LOOTING_ID);
        const pending: FlexPendingEntry[] = [{
            ...createPendingEntry(fixture, program, 10n, 1, 'solid'),
            targetClueReachable: true
        }];

        const projected = fixture.projector.projectPendingAggregates(pending);

        assert.strictEqual(projected.projectedMass, 10n);
        assert.strictEqual(projected.clueIncompatible, 0n);
        assert.strictEqual(projected.projectionLoss, 0n);
        assert.strictEqual(projected.projectedMass + projected.clueIncompatible + projected.projectionLoss, projected.sourceMass);
    });

    it('builds lazy pending aggregate buckets only when read and reuses them', () => {
        const fixture = createProjectionFixture({ applyBookRemoval: true });
        const fixed = fixture.store.appendFixed(fixture.store.empty, SHARPNESS_ID);
        const program = fixture.store.appendChoice(fixed, [
            alt(smite, 1),
            alt(looting, 3)
        ]);
        const pending: FlexPendingEntry[] = [
            createPendingEntry(fixture, program, 24n, 2, 'plex'),
            createPendingEntry(fixture, fixed, 5n, 1, 'solid')
        ];

        const eager = fixture.projector.projectPendingAggregates(pending);
        let buildCount = 0;
        const lazy = fixture.projector.projectPendingLazyAggregatesFromCursor(visitor => {
            for (const entry of pending) {
                visitor(entry.programId, entry.poolProfileId, entry.mass, entry.count, entry.targetClueReachable);
            }
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
        const fixture = createProjectionFixture({ targetClueId: sharpness });
        const fixed = fixture.store.appendFixed(fixture.store.empty, LOOTING_ID);
        const program = fixture.store.appendChoice(fixed, [
            alt(sharpness, 2),
            alt(smite, 1)
        ]);
        const pending: FlexPendingEntry[] = [{
            ...createPendingEntry(fixture, program, 13n, 2, 'plex'),
            targetClueReachable: false
        }];

        const eager = fixture.projector.projectPendingAggregates(pending);
        let buildCount = 0;
        const lazy = fixture.projector.projectPendingLazyAggregatesFromCursor(visitor => {
            for (const entry of pending) {
                visitor(entry.programId, entry.poolProfileId, entry.mass, entry.count, entry.targetClueReachable);
            }
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

interface ProjectionFixture {
    readonly store: FlexProgramStore;
    readonly poolProfiles: FlexPoolProfileStore;
    readonly resultKeys: FlexResultKeyStore;
    readonly profileId: FlexPoolProfileId;
    readonly projector: FlexProjector;
}

function createProjectionFixture(
    options: Omit<FlexProjectionOptions, 'poolProfiles' | 'resultKeys'> = {}
): ProjectionFixture {
    const store = new FlexProgramStore();
    const poolProfiles = new FlexPoolProfileStore();
    const resultKeys = new FlexResultKeyStore();
    const profile = poolProfiles.getOrCreateSingle(exactPool);
    const projector = new FlexProjector(store, enchantToIndex, {
        poolProfiles,
        resultKeys,
        ...options
    });

    return {
        store,
        poolProfiles,
        resultKeys,
        profileId: profile.id,
        projector
    };
}

function projectResults(
    fixture: ProjectionFixture,
    programId: FlexProgramId,
    mass: bigint,
    poolProfileId = fixture.profileId
): ReturnType<FlexProjector['projectResults']> {
    return fixture.projector.projectResults(new Map([
        [fixture.resultKeys.getOrCreate(programId, poolProfileId), mass]
    ]));
}

function createPendingEntry(
    fixture: ProjectionFixture,
    programId: FlexProgramId,
    mass: bigint,
    count: number,
    nodeKind: FlexPendingEntry['nodeKind']
): FlexPendingEntry {
    return Object.freeze({
        graphId: 0,
        nodeId: nodeId(12),
        programId,
        poolProfileId: fixture.profileId,
        mass,
        count,
        nodeKind
    });
}

function createProgramNode(
    store: FlexProgramStore,
    id: FlexNodeId,
    programId: FlexProgramId,
    mergeFlags = store.getMergeFlags(programId)
) {
    return store.createNode(id, programId, testProfileId, mergeFlags);
}

function createRankProfile(poolProfiles: FlexPoolProfileStore) {
    return poolProfiles.getOrCreate({
        familyKey: 'test-family',
        childLevel: 5,
        sources: Object.freeze([
            Object.freeze({
                pool: rankPoolLow,
                level: 10,
                sourceMass: 20n,
                profileWeight: 2n
            }),
            Object.freeze({
                pool: rankPoolHigh,
                level: 11,
                sourceMass: 30n,
                profileWeight: 3n
            })
        ])
    });
}

function createPool(signature: string, packedEnchants: readonly PackedEnchant[]): SearchPool {
    const entries = packedEnchants.map((packedEnchant, index) => {
        const idBit = 1n << BigInt(index);
        return Object.freeze({
            packedEnchant,
            enchantId: enchantId(packedEnchant),
            rank: packedEnchant & 0xff,
            weight: 1,
            comboIndex: enchantToIndex.get(packedEnchant) ?? 0,
            idBit,
            conflictBitset: 0n,
            blocksBitset: idBit
        });
    });

    return Object.freeze({
        item: 'test',
        level: 5,
        signature: signature as SearchPoolSignature,
        familySignature: 'test-family' as SearchPoolFamilySignature,
        entries: Object.freeze(entries),
        totalWeight: entries.length
    });
}

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
