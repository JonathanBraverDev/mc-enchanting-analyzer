import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PackedCombo, PackedEnchant } from '#types/index.js';
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
        assert.strictEqual(projected.projectionLoss, 0n);
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
});
