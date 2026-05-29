import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const npmExecPath = process.env['npm_execpath'];

function run(command: string, args: string[], cwd: string): string {
    return execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function runNpm(args: string[], cwd: string): string {
    if (npmExecPath) return run(process.execPath, [npmExecPath, ...args], cwd);
    return run('npm', args, cwd);
}

describe('Packed package', () => {
    it('resolves package-root runtime and declaration imports for downstream consumers', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcea-packed-consumer-'));
        const packOutput = runNpm(['pack', '--json', '--pack-destination', tmpDir], root);
        const [pack] = JSON.parse(packOutput) as Array<{ filename: string }>;
        assert.ok(pack?.filename, 'npm pack should report a tarball filename');

        const consumerDir = path.join(tmpDir, 'consumer');
        fs.mkdirSync(consumerDir);
        fs.writeFileSync(path.join(consumerDir, 'package.json'), `${JSON.stringify({
            private: true,
            type: 'module'
        }, null, 2)}\n`);

        runNpm([
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            path.join(tmpDir, pack.filename)
        ], consumerDir);

        fs.writeFileSync(path.join(consumerDir, 'index.ts'), [
            'import { EnchantingAnalyzer } from "mc-enchanting-analyzer";',
            'import type { AnalyzerResult, MassAccountingBreakdown, RegistryMutation } from "mc-enchanting-analyzer";',
            '',
            'const mutations: RegistryMutation[] = [{',
            '    type: "patchEnchantment",',
            '    enchantment: "Sharpness",',
            '    patch: { weight: 12 }',
            '}];',
            '',
            'const accounting: MassAccountingBreakdown = {',
            '    resolved: 1,',
            '    clueIncompatible: 0,',
            '    pending: 0,',
            '    sieved: 0,',
            '    overflow: 0,',
            '    capped: 0,',
            '    rounding: 0,',
            '    recoveredRounding: 0,',
            '    recoveredSieved: 0',
            '};',
            '',
            'const analyzer = EnchantingAnalyzer.forVersion("1.21", { mutations });',
            'const result: AnalyzerResult = analyzer.humanize({',
            '    ranks: {},',
            '    any: {},',
            '    count: {},',
            '    combos: {},',
            '    threshold: 1,',
            '    accuracy: 1,',
            '    accounting',
            '});',
            '',
            'console.log(analyzer.registry.source, result.accuracy);',
            ''
        ].join('\n'));
        fs.writeFileSync(path.join(consumerDir, 'runtime.mjs'), [
            'import { EnchantingAnalyzer } from "mc-enchanting-analyzer";',
            '',
            'const analyzer = EnchantingAnalyzer.forVersion("1.21");',
            'const result = await analyzer.analyze({',
            '    item: "sword",',
            '    material: "diamond",',
            '    xp: 1,',
            '    search: "exhaustive",',
            '    summaryLimit: 0',
            '});',
            '',
            'if (typeof result.accuracy !== "number") {',
            '    throw new Error("expected numeric accuracy");',
            '}',
            ''
        ].join('\n'));
        fs.writeFileSync(path.join(consumerDir, 'tsconfig.json'), `${JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                strict: true,
                skipLibCheck: false,
                types: []
            },
            include: ['index.ts']
        }, null, 2)}\n`);

        const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
        run(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit'], consumerDir);
        run(process.execPath, ['runtime.mjs'], consumerDir);
    });
});
