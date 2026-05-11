import { EngineFactory } from '#engine/index.js';
import * as fs from 'node:fs';
import * as assert from 'node:assert';
import { CalculationStats } from '#types/index.js';

async function debug() {
    const engine = EngineFactory.createForVersion('1.7.2');
    const item = 'book';
    const level = 30;
    const material = 'book';

    console.log(`Profiling 1.7.2 Book search...`);

    const instrumentation: any = {
        statsCache: { hits: 0, misses: 0 },
        poolCache: { hits: 0, misses: 0 },
        distCache: { hits: 0, misses: 0 }
    };

    await engine.calculate({
        item,
        xp: level,
        material,
        threshold: 0.000000001,
        maxIterations: 1000000,
        instrumentation,
        onProgress: (s: any) => {
            if (s.instrumentation) {
                const { totalIterations, resultsSize, memoryMB, globalResultsSize, globalCacheNodes } = s.instrumentation;
                const mem = memoryMB ? `${memoryMB}MB` : 'N/A';
                const gRes = globalResultsSize ?? 'N/A';
                const gCache = globalCacheNodes ?? 'N/A';
                process.stdout.write(`\r Iter: ${totalIterations.toLocaleString()} | Res: ${resultsSize} | globalRes: ${gRes} | Cache: ${gCache} | Mem: ${mem}`);
            }
        }
    });

    console.log('\nSearch Complete.');

    const snapshotPath = '../tests/snapshots/1.7.2_book_30_book.json';
    if (fs.existsSync(snapshotPath)) {
        console.log('\nSimulating Snapshot Comparison (Deep Equality Check)...');
        const existing: CalculationStats = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

        try {
            console.log('Simulating a MISMATCH in assert.deepStrictEqual (67k+ entries)...');
            const statsMismatch: CalculationStats = JSON.parse(JSON.stringify(existing));
            const firstKey = Object.keys(statsMismatch.combos)[0];
            if (firstKey !== undefined) {
                statsMismatch.combos[firstKey] = (statsMismatch.combos[firstKey] || 0) + 0.000000000001;
            }

            console.log('Comparing... (This triggers AssertionError generation)');
            assert.deepStrictEqual(statsMismatch, existing);
        } catch (e: any) {
            console.log('Assertion Failed.');
            console.log('Memory after failure (before logging message):', process.memoryUsage().heapUsed / 1024 / 1024, 'MB');

            console.log('Generating assertion message (this might take gigabytes)...');
            const messageLength = e.message.length;
            console.log('Assertion message length:', messageLength.toLocaleString(), 'chars');
            console.log('Memory after generating message:', process.memoryUsage().heapUsed / 1024 / 1024, 'MB');
        }
    }
}

debug().catch(console.error);
