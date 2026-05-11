import assert from 'node:assert';
import { ClueValidator } from '#core/clue.js';
import { EngineFactory } from '#engine/factory.js';
import { SummaryService } from '#services/SummaryService.js';
import { TEST_DATA } from '#tests/infra/test-data.js';
import type { CalculationStats } from '#types/index.js';

type TestEngine = ReturnType<typeof EngineFactory.createForVersion>;
type CheckpointResult = Awaited<ReturnType<TestEngine['searchToCheckpoint']>>;

export function compareConditionedMaps(
    actual: Record<string, number>,
    expected: Record<string, number>,
    label: string
): void {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const key of keys) {
        const actualValue = actual[key] ?? 0;
        const expectedValue = expected[key] ?? 0;
        assert.ok(
            Math.abs(actualValue - expectedValue) < 1e-8,
            `${label}[${key}] expected ${expectedValue}, got ${actualValue}`
        );
    }
}

export async function calculateByFullSearchThenCondition(
    item: string,
    material: string,
    clue: string,
    threshold: number,
    xp = 30
): Promise<CalculationStats> {
    const engine = EngineFactory.createForVersion('1.21.11');
    engine.resetCaches();
    const targetClueId = ClueValidator.validate(engine.registry, item, clue);
    const fullSearch = await engine.searchToCheckpoint({
        item,
        xp,
        material,
        threshold,
        useCache: false
    });

    return SummaryService.summarizeConditioned({
        combos: fullSearch.combos,
        snapshot: fullSearch.snapshot,
        indexToEnchant: engine.registry.indexToEnchant,
        targetClueId,
        isBook: item === TEST_DATA.ITEMS.BOOK,
        comboLimit: 1000
    });
}

export async function calculateWithPruning(
    item: string,
    material: string,
    clue: string,
    threshold: number
): Promise<CalculationStats> {
    const engine = EngineFactory.createForVersion('1.21.11');
    engine.resetCaches();
    return engine.getStats({
        item,
        xp: 30,
        material,
        clue,
        threshold,
        useCache: false,
        summaryLimit: 1000
    });
}

export function summarizeCheckpoint(
    engine: TestEngine,
    result: CheckpointResult,
    item: string,
    clue: string
): CalculationStats {
    const targetClueId = ClueValidator.validate(engine.registry, item, clue);

    return SummaryService.summarizeConditioned({
        combos: result.combos,
        snapshot: result.snapshot,
        indexToEnchant: engine.registry.indexToEnchant,
        targetClueId,
        isBook: item === TEST_DATA.ITEMS.BOOK,
        comboLimit: 1000
    });
}
