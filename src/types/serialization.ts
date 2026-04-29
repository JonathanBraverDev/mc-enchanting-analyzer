import type { MassAccounting } from './mass.js';

/**
 * Compact representation of calculation statistics for efficient transfer.
 */
export interface CompactStats {
    comboKeys: Float64Array;
    comboProbs: Float64Array;
    rankKeys: Uint32Array;
    rankProbs: Float64Array;
    anyKeys: Uint32Array;
    anyProbs: Float64Array;
    counts: Float64Array;
    
    accuracy: number;
    accounting: MassAccounting;
}
