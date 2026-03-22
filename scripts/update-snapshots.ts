
import { EnchantEngine } from '../src/engine.js';
import { DATA } from '../src/data.js';
import { SnapshotUtils } from '../src/test-utils.js';
import { ENGINE_DEFAULTS } from '../src/config.js';

async function updateSnapshots() {
    console.log('Updating Regression Snapshots...');

    // 1.8 Diamond Sword @ Level 30
    console.log('Generating 1.8_sword_30_diamond...');
    const e18 = new EnchantEngine(DATA, '1.8');
    const s18 = await e18.getFullStats('sword', 30, 'diamond', null, 0.0001, undefined, undefined, false, undefined, ENGINE_DEFAULTS.MAX_RESULTS_SNAPSHOT);
    await SnapshotUtils.saveSnapshot('1.8_sword_30_diamond', s18);

    // 1.21 Mace @ Level 30
    console.log('Generating 1.21_mace_30_mace...');
    const v121 = new EnchantEngine(DATA, '1.21');
    const s121 = await v121.getFullStats('mace', 30, 'mace', null, 0.0001, undefined, undefined, false, undefined, ENGINE_DEFAULTS.MAX_RESULTS_SNAPSHOT);
    await SnapshotUtils.saveSnapshot('1.21_mace_30_mace', s121);

    // 1.7.2 Multi-Enchant Book @ Level 30
    console.log('Generating 1.7.2_book_30_book...');
    const v172 = new EnchantEngine(DATA, '1.7.2');
    const s172 = await v172.getFullStats('book', 30, 'book', null, 0.0001, undefined, undefined, false, undefined, ENGINE_DEFAULTS.MAX_RESULTS_SNAPSHOT);
    await SnapshotUtils.saveSnapshot('1.7.2_book_30_book', s172);

    // 1.21.11 Spear @ Level 30
    console.log('Generating 1.21.11_spear_30_diamond...');
    const v12111s = new EnchantEngine(DATA, '1.21.11');
    const s12111s = await v12111s.getFullStats('spear', 30, 'diamond', null, 0.0001, undefined, undefined, false, undefined, ENGINE_DEFAULTS.MAX_RESULTS_SNAPSHOT);
    await SnapshotUtils.saveSnapshot('1.21.11_spear_30_diamond', s12111s);

    // 1.21.11 Book @ Level 30
    console.log('Generating 1.21.11_book_30_book...');
    const v12111b = new EnchantEngine(DATA, '1.21.11');
    const s12111b = await v12111b.getFullStats('book', 30, 'book', null, 0.0001, undefined, undefined, false, undefined, ENGINE_DEFAULTS.MAX_RESULTS_SNAPSHOT);
    await SnapshotUtils.saveSnapshot('1.21.11_book_30_book', s12111b);

    console.log('Snapshots updated successfully.');
}

updateSnapshots().catch(err => {
    console.error('Failed to update snapshots:', err);
    process.exit(1);
});
