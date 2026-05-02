import {
  TopRunView,
  ChartCellView,
  SnapshotRequest,
  RegistryState,
  PackedCombo,
  TopInputSignature,
  NormalizationView,
  AccountingView,
  TopComboView,
  TopEnchantShareView,
  ChartBucketsView,
  RefinementLevelName,
  SearchFrontierSnapshot
} from '#types/index.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ProbUtils, ComboUtils } from '#utils/index.js';
import { ClueAnalysisService } from '#services/ClueAnalysisService.js';
import { getFullEnchantName, getEnchantName } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { ClueValidator } from '#core/clue.js';
import { SummaryService } from '#services/SummaryService.js';


export class SnapshotService {
  /**
   * Creates a display-oriented snapshot view of the engine state.
   *
   * @param state Registry state for name lookups.
   * @param tracker Tracker for accounting metrics.
   * @param combos Top combinations map.
   * @param request View configuration.
   * @param authoritative Optional authoritative masses from the engine. If provided,
   *                      unconditioned views will use these instead of re-deriving from combos.
   */
  public static create(
    state: RegistryState,
    tracker: SearchStateTracker,
    combos: Map<PackedCombo, bigint>,
    request: SnapshotRequest,
    frontiers: SearchFrontierSnapshot[] = []
  ): TopRunView | ChartCellView {
    const { snapshotType, refinementLevel, clue, comboLimit } = request;
    const isBook = request.input.category === 'book';

    // 1. Resolve clue if present (Correction 5: use centralized validation)
    let targetClueId: number | null = null;
    if (clue) {
      try {
        targetClueId = ClueValidator.validate(state, request.input.category, clue);
      } catch (err) {
        // If worker didn't catch it, or if factory is used in a context where invalid clues
        // might slip in, we throw here to prevent silent unconditioned fallback.
        throw new Error(`Snapshot projection failed: Invalid clue "${clue}". ${err instanceof Error ? err.message : ''}`);
      }
    }

    // 2. Perform conditioning if needed
    const isConditioned = targetClueId !== null;
    let result: any;
    let clueKnownSpace: number | undefined;

    if (isConditioned) {
      // Conditioned views derive from top combos (representing the posterior)
      // Note: frontiers are passed to conditionOnClue which now handles them
      const conditioned = ClueAnalysisService.conditionOnClue(combos, targetClueId!, state.indexToEnchant, frontiers);
      clueKnownSpace = ProbUtils.toNumber(conditioned.clueKnownSpace);
      result = conditioned;
    } else {
      // Unconditioned views derive aggregate stats from combos + frontiers (SSoT)
      const derived = SummaryService.deriveAggregateMasses(combos, state.indexToEnchant, frontiers, isBook);
      result = {
        combos,
        anyMass: this.toMassMap(derived.any),
        rankMass: this.toMassMap(derived.ranks),
        countMass: this.toMassMap(derived.count)
      };
    }

    const accounting = tracker.mass.toPublic();
    const normalization: NormalizationView = {
      domain: isConditioned ? 'clue-known-space' : 'resolved-mass',
      ...(clueKnownSpace !== undefined ? { clueKnownSpace } : {})
    };

    if (snapshotType === 'top') {
      return this.createTopView(
        state,
        request.input as TopInputSignature,
        refinementLevel,
        isConditioned,
        normalization,
        accounting,
        result,
        comboLimit ?? ENGINE_LIMITS.MAX_RESULTS_SUMMARY
      );
    } else {
      return this.createChartCellView(
        request.input.xpLevel as number,
        refinementLevel,
        isConditioned,
        normalization,
        accounting,
        result
      );
    }
  }

  private static toMassMap(masses: bigint[]): Map<number, bigint> {
    const map = new Map<number, bigint>();
    for (let i = 0; i < masses.length; i++) {
      const val = masses[i];
      if (val !== undefined && val > 0n) {
        map.set(i, val);
      }
    }
    return map;
  }

  private static createTopView(
    state: RegistryState,
    input: TopInputSignature,
    refinementLevel: RefinementLevelName,
    clueConditioned: boolean,
    normalization: NormalizationView,
    accounting: AccountingView,
    result: { anyMass: Map<number, bigint>, rankMass: Map<number, bigint>, countMass: Map<number, bigint>, combos: Map<PackedCombo, bigint> },
    comboLimit: number
  ): TopRunView {
    const combos: TopComboView[] = [];
    const entries = [...result.combos.entries()].sort((a, b) => b[1] > a[1] ? 1 : (b[1] < a[1] ? -1 : 0));

    const limitedEntries = comboLimit > 0 ? entries.slice(0, comboLimit) : entries;

    for (const [packed, mass] of limitedEntries) {
      const enchants = ComboUtils.unpack(packed, state.indexToEnchant);
      combos.push({
        enchants: enchants.map(e => getFullEnchantName(state, e)),
        share: ProbUtils.toNumber(mass),
        enchantCount: enchants.length,
        rankSum: enchants.reduce((sum, e) => sum + (e & 0xFF), 0)
      });
    }

    const enchants: TopEnchantShareView[] = [];
    for (const [id, mass] of result.anyMass) {
      enchants.push({
        enchantId: id,
        label: getEnchantName(state, id),
        share: ProbUtils.toNumber(mass)
      });
    }
    enchants.sort((a, b) => b.share - a.share);

    return {
      input,
      refinementLevel,
      clueConditioned,
      normalization,
      accounting,
      combos,
      enchants
    };
  }

  private static createChartCellView(
    xpLevel: number,
    refinementLevel: RefinementLevelName,
    clueConditioned: boolean,
    normalization: NormalizationView,
    accounting: AccountingView,
    result: { anyMass: Map<number, bigint>, rankMass: Map<number, bigint>, countMass: Map<number, bigint> }
  ): ChartCellView {
    const buckets: ChartBucketsView = {
      anyByEnchantId: {},
      rankByIdAndRank: {},
      countBySize: {}
    };

    for (const [id, mass] of result.anyMass) {
      buckets.anyByEnchantId[id] = ProbUtils.toNumber(mass);
    }

    for (const [idAndRank, mass] of result.rankMass) {
      buckets.rankByIdAndRank[idAndRank] = ProbUtils.toNumber(mass);
    }

    for (const [count, mass] of result.countMass) {
      buckets.countBySize[count] = ProbUtils.toNumber(mass);
    }

    return {
      xpLevel,
      refinementLevel,
      clueConditioned,
      normalization,
      accounting,
      buckets
    };
  }
}
