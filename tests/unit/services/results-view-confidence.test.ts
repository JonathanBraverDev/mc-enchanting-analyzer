import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getDisplayConfidence } from '#ui/views/ResultsView.js';
import type { TopRunView } from '#types/index.js';

function makeView(
    normalization: TopRunView['normalization'],
    accounting: Partial<TopRunView['accounting']>
): Pick<TopRunView, 'normalization' | 'accounting'> {
    return {
        normalization,
        accounting: {
            resolved: 0,
            clueIncompatible: 0,
            pending: 0,
            sieved: 0,
            overflow: 0,
            capped: 0,
            rounding: 0,
            ...accounting
        }
    };
}

describe('ResultsView confidence display', () => {
    it('uses resolved mass for unconditioned views', () => {
        const confidence = getDisplayConfidence(makeView(
            { domain: 'resolved-mass' },
            { resolved: 0.118, clueIncompatible: 0.882 }
        ));

        assert.strictEqual(confidence, 0.118);
    });

    it('uses classified mass for clue-conditioned views', () => {
        const confidence = getDisplayConfidence(makeView(
            { domain: 'clue-known-space', clue: { knownSpace: 0.071 } },
            { resolved: 0.118, clueIncompatible: 0.882 }
        ));

        assert.strictEqual(confidence, 1);
    });
});
