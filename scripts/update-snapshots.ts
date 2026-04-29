
import { EnchantEngine } from '../src/engine/index.js';
import { DATA } from '../src/data/index.js';
import { SnapshotUtils } from '../src/tests/test-utils.js';
import { ENGINE_DEFAULTS } from '../src/core/config.js';

async function updateSnapshots() {
    console.log('Updating Regression Snapshots...');

    const HI_RES_LIMIT = ENGINE_DEFAULTS.MAX_RESULTS_HI_RES;
    const HI_RES_THRESHOLD = 0.00000001; // 1e-8: Full accurate resolution

    // 1.8 Diamond Sword @ Level 30
    console.log('Generating 1.8_sword_30_diamond...');
    const e18 = new EnchantEngine(DATA, '1.8');
    const s18 = await e18.getFullStats('sword', 30, 'diamond', null, HI_RES_THRESHOLD, undefined, undefined, false, HI_RES_LIMIT, HI_RES_LIMIT, HI_RES_LIMIT, false);
    await SnapshotUtils.saveSnapshot('1.8_sword_30_diamond', s18);
    EnchantEngine.clearAllCaches();

    // 1.21 Mace @ Level 30
    console.log('Generating 1.21_mace_30_mace...');
    const v121 = new EnchantEngine(DATA, '1.21');
    const s121 = await v121.getFullStats('mace', 30, 'mace', null, HI_RES_THRESHOLD, undefined, undefined, false, HI_RES_LIMIT, HI_RES_LIMIT, HI_RES_LIMIT, false);
    await SnapshotUtils.saveSnapshot('1.21_mace_30_mace', s121);
    EnchantEngine.clearAllCaches();

    // 1.7.2 Multi-Enchant Book @ Level 30
    console.log('Generating 1.7.2_book_30_book...');
    const v172 = new EnchantEngine(DATA, '1.7.2');
    const s172 = await v172.getFullStats('book', 30, 'book', null, HI_RES_THRESHOLD, undefined, undefined, false, HI_RES_LIMIT, HI_RES_LIMIT, HI_RES_LIMIT, false);
    await SnapshotUtils.saveSnapshot('1.7.2_book_30_book', s172);
    EnchantEngine.clearAllCaches();

    // 1.21.11 Spear @ Level 30
    console.log('Generating 1.21.11_spear_30_diamond...');
    const v12111s = new EnchantEngine(DATA, '1.21.11');
    const s12111s = await v12111s.getFullStats('spear', 30, 'diamond', null, HI_RES_THRESHOLD, undefined, undefined, false, HI_RES_LIMIT, HI_RES_LIMIT, HI_RES_LIMIT, false);
    await SnapshotUtils.saveSnapshot('1.21.11_spear_30_diamond', s12111s);
    EnchantEngine.clearAllCaches();

    // 1.21.11 Book @ Level 30
    console.log('Generating 1.21.11_book_30_book...');
    const v12111b = new EnchantEngine(DATA, '1.21.11');
    const s12111b = await v12111b.getFullStats('book', 30, 'book', null, HI_RES_THRESHOLD, undefined, undefined, false, HI_RES_LIMIT, HI_RES_LIMIT, HI_RES_LIMIT, false);
    await SnapshotUtils.saveSnapshot('1.21.11_book_30_book', s12111b);
    EnchantEngine.clearAllCaches();

    console.log('Snapshots updated successfully.');

    console.log('Snapshots updated successfully.');
}

updateSnapshots().catch(err => {
    console.error('Failed to update snapshots:', err);
    process.exit(1);
});
