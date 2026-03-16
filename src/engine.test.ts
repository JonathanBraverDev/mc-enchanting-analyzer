import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { EnchantEngine } from './engine.js';
import { DATA } from './data.js';

// Polyfill for requestAnimationFrame in Node (Sync version for tests)
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: Function) => callback(Date.now());
}

describe('EnchantEngine Baselines', () => {
    
    describe('1.8+ Mechanics', () => {
        const engine = new EnchantEngine(DATA, '1.8');

        it('should show Sharpness as possible on Diamond Swords', async () => {
            const stats = await engine.getFullStats('sword', 30, 'diamond');
            assert.ok((stats.any['Sharpness'] || 0) > 0, 'Sharpness 1.8 should be possible');
        });
    });

    describe('1.14 Protection "God Armor" window', () => {
        const engine114 = new EnchantEngine(DATA, '1.14');
        const engine1143 = new EnchantEngine(DATA, '1.14.3');

        it('1.14: protections should NOT conflict', async () => {
            const stats = await engine114.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const combos = Object.keys(stats.combos);
            
            const protTypes = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const multiProts = combos.filter(c => {
                const parts = c.split(",").map(nStr => {
                    const n = parseInt(nStr);
                    return engine114.revIdMap[n >> 8];
                });
                const found = protTypes.filter(t => parts.includes(t));
                return found.length > 1;
            });

            assert.ok(multiProts.length > 0, '1.14 should allow multiple protections in one combo');
        });

        it('1.14.3: protections SHOULD conflict', async () => {
            const stats = await engine1143.getFullStats('chestplate', 30, 'diamond', null, 0.0001);
            const combos = Object.keys(stats.combos);
            
            const protTypes = ["Protection", "Fire Protection", "Blast Protection", "Projectile Protection"];
            const hasConflict = combos.some(c => {
                const parts = c.split(",").map(nStr => {
                    const n = parseInt(nStr);
                    return engine1143.revIdMap[n >> 8];
                });
                const found = protTypes.filter(t => parts.includes(t));
                return found.length > 1;
            });

            assert.ok(!hasConflict, '1.14.3 should NOT allow multiple protections in one combo');
        });
    });

    describe('General Engine Integrity', () => {
        const engine = new EnchantEngine(DATA, '1.21');

        it('Total probability of Modified Level Distribution should be ~1.0', () => {
            const dist = engine.getModifiedLevelDist(30, 10);
            const totalProb = Object.values(dist).reduce((a, b) => a + b, 0);
            assert.ok(Math.abs(totalProb - 1.0) < 0.001);
        });

        it('Impossible seeds should return empty stats', async () => {
            const stats = await engine.getFullStats('sword', 30, 'diamond', 'Efficiency IV');
            assert.strictEqual(Object.keys(stats.combos).length, 0);
            assert.strictEqual(stats.residual, 1.0);
        });
    });
});
