import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

function runCli(args: string[]) {
    return spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', ...args],
        {
            cwd: process.cwd(),
            encoding: 'utf8'
        }
    );
}

describe('CLI', () => {
    it('prints human-readable text results by default', () => {
        const result = runCli([
            '1.21',
            'pickaxe',
            'diamond',
            '30',
            '-s', 'coarse',
            '-l', '1'
        ]);

        assert.strictEqual(result.status, 0, result.stderr);
        assert.match(result.stdout, /Minecraft Enchanting Analyzer/);
        assert.match(result.stdout, /Top combinations/);
        assert.match(result.stdout, /Efficiency/);
    });

    it('prints raw JSON stats for scripts', () => {
        const result = runCli([
            '--version', '1.21',
            '--item', 'sword',
            '--material', 'diamond',
            '--xp', '30',
            '--search', 'coarse',
            '--summary-limit', '0',
            '--raw'
        ]);

        assert.strictEqual(result.status, 0, result.stderr);
        const parsed = JSON.parse(result.stdout) as { accuracy?: number; combos?: Record<string, number> };
        assert.strictEqual(typeof parsed.accuracy, 'number');
        assert.deepStrictEqual(parsed.combos, {});
    });

    it('accepts full non-boundary versions between registry rule changes', () => {
        const result = runCli([
            '1.14.2',
            'crossbow',
            'crossbow',
            '30',
            '-s', 'coarse',
            '-l', '0'
        ]);

        assert.strictEqual(result.status, 0, result.stderr);
        assert.match(result.stdout, /1\.14\.2 crossbow\/crossbow XP 30/);
    });

    it('accepts non-boundary full Minecraft versions without rounding up', () => {
        const valid = runCli([
            '1.7.1',
            'book',
            'book',
            '30',
            '-s', 'coarse',
            '-l', '0'
        ]);
        const notYetAvailable = runCli([
            '1.7.1',
            'fishing_rod',
            'fishing_rod',
            '30',
            '-s', 'coarse',
            '-l', '0'
        ]);

        assert.strictEqual(valid.status, 0, valid.stderr);
        assert.match(valid.stdout, /1\.7\.1 book\/book XP 30/);
        assert.notStrictEqual(notYetAvailable.status, 0);
        assert.match(notYetAvailable.stderr, /Unknown or unavailable item/);
    });

    it('prints help text', () => {
        const result = runCli(['--help']);

        assert.strictEqual(result.status, 0, result.stderr);
        assert.match(result.stdout, /Usage:/);
        assert.match(result.stdout, /mcenchant 1\.21 pickaxe diamond 30/);
        assert.match(result.stdout, /1\.14\.2/);
        assert.match(result.stdout, /--format/);
    });
});
