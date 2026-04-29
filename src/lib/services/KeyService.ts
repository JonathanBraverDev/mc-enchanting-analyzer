import { RegistryState } from '#types/index.js';
import { getCategoryId, getMaterialId } from '#core/registry.js';
import { KeyUtils } from '#utils/index.js';


/**
 * Service for generating complex cache keys using registry-aware lookups.
 */
export class KeyService {
    /**
     * Generates a packed key for combination calculations.
     */
    public getPackedKey(registry: RegistryState, cat: string, modLevel: number, mat: string): number {
        const catId = getCategoryId(registry, cat);
        const matId = getMaterialId(registry, mat);

        return KeyUtils.getPackedKey(catId, matId, modLevel);
    }

    /**
     * Generates a packed key for full statistics calculation.
     */
    public getStatsKey(registry: RegistryState, cat: string, xp: number, mat: string, packedClue: number | null = null): number {
        const catId = getCategoryId(registry, cat);
        const matId = getMaterialId(registry, mat);

        let key = KeyUtils.getStatsKey(catId, matId, xp);
        if (packedClue !== null) {
            // Encode the clue into the high bits (above 18 bits used for cat/mat/level)
            key |= (packedClue << 18);
        }
        return key;
    }
}
