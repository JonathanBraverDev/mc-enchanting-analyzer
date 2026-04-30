import { 
  TopRunView, 
  ChartCellView, 
  SnapshotRequest, 
  RegistryState, 
  PackedCombo, 
  SearchStateTracker,
  NormalizationView,
  AccountingView,
  TopComboView,
  TopEnchantShareView,
  ChartBucketsView,
  RefinementLevelName,
  TopInputSignature
} from '#types/index.js';
import { ProbUtils, ComboUtils, EnchantUtils } from '#utils/index.js';
import { ClueAnalysisService } from '#services/ClueAnalysisService.js';
import { getFullEnchantName, getEnchantName, getEnchantId } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

export class SearchStateSnapshotFactory {
  public static create(
    state: RegistryState,
    tracker: SearchStateTracker,
    combos: Map<PackedCombo, bigint>,
    request: SnapshotRequest
  ): TopRunView | ChartCellView {
    const { snapshotType, refinementLevel, clue, comboLimit } = request;

    // 1. Resolve clue if present
    let targetClueId: number | null = null;
    if (clue) {
      const parsed = EnchantUtils.parse(clue, state.data.constants.ROMAN_MAP);
      if (parsed) {
        const id = getEnchantId(state, parsed.name);
        if (id !== ENGINE_LIMITS.UNKNOWN_ENCHANT_ID) {
          targetClueId = (id << 8) | parsed.rank;
        }
      }
    }

    // 2. Perform conditioning if needed
    const isConditioned = targetClueId !== null;
    let result: any;
    let clueKnownSpace: number | undefined;

    if (isConditioned) {
      const conditioned = ClueAnalysisService.conditionOnClue(combos, targetClueId!, state.indexToEnchant);
      clueKnownSpace = ProbUtils.toNumber(conditioned.clueKnownSpace);
      result = conditioned;
    } else {
      // For unconditioned, we need any/rank/count masses
      result = {
        combos,
        anyMass: this.calculateAnyMass(combos, state.indexToEnchant),
        rankMass: this.calculateRankMass(combos, state.indexToEnchant),
        countMass: this.calculateCountMass(combos, state.indexToEnchant)
      };
    }

    const accounting = tracker.toPublic();
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
        'pass_placeholder' as any,
        refinementLevel,
        isConditioned,
        normalization,
        result
      );
    }
  }

  private static calculateAnyMass(combos: Map<PackedCombo, bigint>, indexToEnchant: number[]): Map<number, bigint> {
    const mass = new Map<number, bigint>();
    for (const [packed, prob] of combos) {
      const enchants = ComboUtils.unpack(packed, indexToEnchant);
      for (const e of enchants) {
        const id = e >> 8;
        ProbUtils.addItemMass(mass, id, prob);
      }
    }
    return mass;
  }

  private static calculateRankMass(combos: Map<PackedCombo, bigint>, indexToEnchant: number[]): Map<number, bigint> {
    const mass = new Map<number, bigint>();
    for (const [packed, prob] of combos) {
      const enchants = ComboUtils.unpack(packed, indexToEnchant);
      for (const e of enchants) {
        ProbUtils.addItemMass(mass, e, prob);
      }
    }
    return mass;
  }

  private static calculateCountMass(combos: Map<PackedCombo, bigint>, indexToEnchant: number[]): Map<number, bigint> {
    const mass = new Map<number, bigint>();
    for (const [packed, prob] of combos) {
      const count = ComboUtils.unpack(packed, indexToEnchant).length;
      ProbUtils.addItemMass(mass, count, prob);
    }
    return mass;
  }

  private static createTopView(
    state: RegistryState,
    input: TopInputSignature,
    refinementLevel: RefinementLevelName,
    clueConditioned: boolean,
    normalization: NormalizationView,
    accounting: AccountingView,
    result: { combos: Map<PackedCombo, bigint>, anyMass: Map<number, bigint>, rankMass: Map<number, bigint>, countMass: Map<number, bigint> },
    comboLimit: number
  ): TopRunView {
    // Top view needs sorted combos
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
    passId: any,
    refinementLevel: RefinementLevelName,
    clueConditioned: boolean,
    normalization: NormalizationView,
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
      passId,
      refinementLevel,
      clueConditioned,
      normalization,
      buckets
    };
  }
}
