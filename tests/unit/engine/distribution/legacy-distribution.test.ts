import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';

describe('Legacy Distribution & Mechanics (Beta 1.9 - 1.2.5)', () => {
    it('should support XP levels up to 50 for version 1.1', async () => {
        const engine = EngineFactory.create(DATA, '1.1');

        // This should not throw
        const dist = engine.getModifiedLevelDist(50, 10);

        const totalProb = Object.values(dist).reduce((a, b) => a + b, 0n);
        assert.ok(totalProb > 0n, 'Distribution should have probability mass');
    });

    it('should use flat distribution (divisor 2) for legacy versions', async () => {
        const engine = EngineFactory.create(DATA, '1.1');

        // At level 1, enchantability 10, divisor 2:
        // base = floor(10 / 2) + 1 = 6
        // base distribution is xp + 1 + [0...2*6-2] = 1 + 1 + [0...10] = [2...12]
        // But if it were modern (divisor 4):
        // base = floor(10 / 4) + 1 = 3
        // base distribution is [2...6]

        const dist = engine.getModifiedLevelDist(1, 10);
        const levels = Object.keys(dist).map(Number);
        const maxLevel = Math.max(...levels);

        // With divisor 2, levels go much higher
        assert.ok(maxLevel > 10, `Legacy distribution should reach higher levels (max: ${maxLevel})`);
    });

    it('should enforce XP cap of 30 for modern versions (1.21)', async () => {
        const engine = EngineFactory.create(DATA, '1.21');

        await assert.rejects(async () => {
            await engine.calculate('sword', 31, 'diamond');
        }, /XP level 31 exceeds the maximum/);
    });
});
