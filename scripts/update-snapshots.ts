
import { EnchantEngine, EngineFactory } from '#engine/index.js';
import { DATA } from '../src/lib/data/index.js';
import { SnapshotUtils } from '../tests/infra/test-utils.js';
import { ENGINE_DEFAULTS } from '../src/lib/core/config.js';

async function updateSnapshots() {
    console.log('Updating Regression Snapshots...');

    const SNAPSHOT_LIMIT = ENGINE_DEFAULTS.MAX_RESULTS_UNBOUNDED;
    const SNAPSHOT_ITERATIONS = ENGINE_DEFAULTS.MAX_ITERATIONS_UNBOUNDED;
    const HI_RES_THRESHOLD = 0.00000001; // 1e-8: Full accurate resolution

    // Helper to generate snapshots with new API signature
    const getStats = async (engine: EnchantEngine, cat: string, xp: number, mat: string, clue: string | null = null) => {
        return await engine.calculate(cat, xp, mat, {
            clue,
            threshold: HI_RES_THRESHOLD,
            maxIterations: SNAPSHOT_ITERATIONS,
            resultsLimit: SNAPSHOT_LIMIT,
            summaryLimit: SNAPSHOT_LIMIT
        });
    };

    // 1.8 Diamond Sword @ Level 30
    console.log('Generating 1.8_sword_30_diamond...');
    const e18 = EngineFactory.create(DATA, '1.8');
    const s18 = await getStats(e18, 'sword', 30, 'diamond');
    await SnapshotUtils.saveSnapshot('1.8_sword_30_diamond', s18, e18.registry);
    

    // 1.21 Mace @ Level 30
    console.log('Generating 1.21_mace_30_mace...');
    const v121 = EngineFactory.create(DATA, '1.21');
    const s121 = await getStats(v121, 'mace', 30, 'mace');
    await SnapshotUtils.saveSnapshot('1.21_mace_30_mace', s121, v121.registry);
    

    // 1.7.2 Multi-Enchant Book @ Level 30
    console.log('Generating 1.7.2_book_30_book...');
    const v172 = EngineFactory.create(DATA, '1.7.2');
    const s172 = await getStats(v172, 'book', 30, 'book');
    await SnapshotUtils.saveSnapshot('1.7.2_book_30_book', s172, v172.registry);
    

    // 1.21.11 Spear @ Level 30
    console.log('Generating 1.21.11_spear_30_diamond...');
    const v12111s = EngineFactory.create(DATA, '1.21.11');
    const s12111s = await getStats(v12111s, 'spear', 30, 'diamond');
    await SnapshotUtils.saveSnapshot('1.21.11_spear_30_diamond', s12111s, v12111s.registry);
    

    // 1.21.11 Book @ Level 30
    console.log('Generating 1.21.11_book_30_book...');
    const v12111b = EngineFactory.create(DATA, '1.21.11');
    const s12111b = await getStats(v12111b, 'book', 30, 'book');
    await SnapshotUtils.saveSnapshot('1.21.11_book_30_book', s12111b, v12111b.registry);
    

    // 1.21 Sword @ Level 30 with Guaranteed Sharpness IV
    console.log('Generating 1.21_sword_30_diamond_clue_sharpness...');
    const v121g = EngineFactory.create(DATA, '1.21');
    const s121g = await getStats(v121g, 'sword', 30, 'diamond', 'Sharpness IV');
    await SnapshotUtils.saveSnapshot('1.21_sword_30_diamond_clue_sharpness', s121g, v121g.registry);
    
    v121g.resetCaches();

    // 1.8 Bow @ Level 30 with Guaranteed Power IV
    console.log('Generating 1.8_bow_30_bow_clue_power...');
    const e18g = EngineFactory.create(DATA, '1.8');
    const s18g = await getStats(e18g, 'bow', 30, 'bow', 'Power IV');
    await SnapshotUtils.saveSnapshot('1.8_bow_30_bow_clue_power', s18g, e18g.registry);
    e18g.resetCaches();

    console.log('Snapshots updated successfully.');
}

updateSnapshots().catch(err => {
    console.error('Failed to update snapshots:', err);
    process.exit(1);
});
