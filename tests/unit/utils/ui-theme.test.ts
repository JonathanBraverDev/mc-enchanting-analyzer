import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DATA } from '#data/index.js';
import { EngineFactory } from '#engine/factory.js';
import { ThemeManager } from '#ui/theme.js';

const registry = EngineFactory.create(DATA, '1.21.11').registry;

describe('ThemeManager', () => {
    it('keeps enchantment color stable across ranks', () => {
        assert.strictEqual(
            ThemeManager.getEnchantColor('Sharpness I', registry),
            ThemeManager.getEnchantColor('Sharpness V', registry)
        );
    });

    it('uses rank line dash patterns without changing line weight', () => {
        const rankI = ThemeManager.getRankLineStyle('Sharpness I', registry);
        const rankIII = ThemeManager.getRankLineStyle('Sharpness III', registry);
        const rankV = ThemeManager.getRankLineStyle('Sharpness V', registry);

        assert.deepStrictEqual(rankI.borderDash, []);
        assert.deepStrictEqual(rankIII.borderDash, [4, 4]);
        assert.deepStrictEqual(rankV.borderDash, [14, 3, 3, 3]);
        assert.strictEqual(rankI.borderWidth, 2);
        assert.strictEqual(rankIII.borderWidth, 2);
        assert.strictEqual(rankV.borderWidth, 2);
        assert.strictEqual(rankI.color, rankIII.color);
    });

    it('adds alpha to supported chart colors', () => {
        assert.strictEqual(ThemeManager.withAlpha('hsl(210, 65%, 60%)', 0.25), 'hsla(210, 65%, 60%, 0.25)');
        assert.strictEqual(ThemeManager.withAlpha('rgb(10, 20, 30)', 0.5), 'rgba(10, 20, 30, 0.5)');
        assert.strictEqual(ThemeManager.withAlpha('#ff00ff', 0.5), '#ff00ff');
    });
});
