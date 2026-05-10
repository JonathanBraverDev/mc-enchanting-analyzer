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
  SearchFrontierSnapshot,
  ClueSignalAdvisorView,
  TargetClueAdvisorView,
  TargetDiagnosticsView
} from '#types/index.js';
import { SearchStateTracker } from '#engine/search/SearchStateTracker.js';
import { ProbUtils, ComboUtils } from '#utils/index.js';
import { ClueAnalysisService } from '#services/ClueAnalysisService.js';
import { getFullEnchantName, getEnchantName } from '#core/registry.js';
import { ENGINE_LIMITS } from '#constants/engine.js';
import { ClueValidator } from '#core/clue.js';
import { SummaryAggregationService } from '#services/SummaryAggregationService.js';
import { TargetAnalysisService } from '#services/TargetAnalysisService.js';
import { TargetClueAdvisorService } from '#services/TargetClueAdvisorService.js';
import { ClueSignalAdvisorService } from '#services/ClueSignalAdvisorService.js';
import type { V7SearchRunSnapshot } from '#lib/v7/search/SearchRun.js';


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
    frontiers: SearchFrontierSnapshot[] = [],
    v7Snapshot?: V7SearchRunSnapshot | undefined
  ): TopRunView | ChartCellView {
    const { snapshotType, refinementLevel, clue, comboLimit } = request;
    const includeCombos = request.includeCombos ?? snapshotType === 'top';
    const isBook = request.input.item === 'book';

    // Resolve clue here as a final guard against invalid worker or test input.
    let targetClueId: number | null = null;
    if (clue) {
      try {
        targetClueId = ClueValidator.validate(state, request.input.item, clue);
      } catch (err) {
        // If worker didn't catch it, or if factory is used in a context where invalid clue input
        // might slip in, we throw here to prevent silent unconditioned fallback.
        throw new Error(`Snapshot projection failed: Invalid clue "${clue}". ${err instanceof Error ? err.message : ''}`);
      }
    }

    // 2. Perform conditioning if needed
    const isConditioned = targetClueId !== null;
    let result: any;
    let knownSpace: number | undefined;

    if (isConditioned) {
      // Conditioned views derive from top combos and any pending frontier mass.
      const conditioned = ClueAnalysisService.conditionOnClue(
        combos,
        targetClueId!,
        state.indexToEnchant,
        v7Snapshot ? [] : frontiers,
        isBook,
        v7Snapshot?.pendingEntries
      );
      knownSpace = ProbUtils.toNumber(conditioned.knownSpace);
      result = conditioned;
    } else {
      // Unconditioned views derive aggregate stats from combos + frontiers.
      const derived = SummaryAggregationService.aggregate({
        combos,
        indexToEnchant: state.indexToEnchant,
        frontiers: v7Snapshot ? [] : frontiers,
        v7PendingEntries: v7Snapshot?.pendingEntries,
        isBook,
        includeShownClueDistribution: false
      });
      result = {
        combos,
        anyMass: this.toMassMap(derived.any),
        rankMass: this.toMassMap(derived.ranks),
        countMass: this.toMassMap(derived.count)
      };
    }

    const packedTargets = TargetAnalysisService.packTargets(state, request.input.item, request.input.targets);
    const targetsPossibleAtLevel = packedTargets.length === 0 || TargetClueAdvisorService.supportsTargetsAtXp(
      state,
      request.input.item,
      request.input.material,
      request.input.xpLevel,
      packedTargets
    );
    const targetAnalysis = TargetAnalysisService.aggregate({
      combos: result.combos,
      indexToEnchant: state.indexToEnchant,
      targets: packedTargets,
      frontiers: isConditioned || v7Snapshot ? [] : frontiers,
      v7PendingEntries: isConditioned ? [] : v7Snapshot?.pendingEntries,
      comboLimit: includeCombos ? comboLimit ?? ENGINE_LIMITS.MAX_RESULTS_SUMMARY : 0,
      registry: state,
      isBook
    });
    const targetDiagnostics: TargetDiagnosticsView | undefined = targetAnalysis
      ? {
        labels: packedTargets.map(target => target.label),
        tablePossibleAtLevel: targetsPossibleAtLevel,
        matchShare: ProbUtils.toNumber(targetAnalysis.matchMass),
        matchingComboCount: targetAnalysis.matchingComboCount,
        nearMissShare: ProbUtils.toNumber(targetAnalysis.nearMissMass),
        nearMissComboCount: targetAnalysis.nearMissComboCount,
        blockedShare: ProbUtils.toNumber(targetAnalysis.blockedMass),
        blockedComboCount: targetAnalysis.blockedComboCount
      }
      : undefined;
    const clueAdvice = !isConditioned && targetsPossibleAtLevel && packedTargets.length > 0
      ? TargetClueAdvisorService.recommend({
        combos,
        indexToEnchant: state.indexToEnchant,
        targets: packedTargets,
        registry: state,
        frontiers: v7Snapshot ? [] : frontiers,
        v7PendingEntries: v7Snapshot?.pendingEntries,
        limit: 5
      })
      : undefined;
    const clueAdvisor: TargetClueAdvisorView | undefined = clueAdvice
      ? {
        recommendations: clueAdvice.recommendations.map(recommendation => ({
          idAndRank: recommendation.idAndRank,
          label: recommendation.label,
          targetChance: ProbUtils.toNumber(recommendation.targetChanceMass),
          clueShare: ProbUtils.toNumber(recommendation.clueMass),
          targetAndClueShare: ProbUtils.toNumber(recommendation.targetAndClueMass),
          anyBaselineChance: ProbUtils.toNumber(recommendation.anyBaselineChanceMass),
          liftOverAnyBaseline: recommendation.liftOverAnyBaseline,
          compatibleBaselineChance: ProbUtils.toNumber(recommendation.compatibleBaselineChanceMass),
          liftOverCompatibleBaseline: recommendation.liftOverCompatibleBaseline
        }))
      }
      : undefined;
    const clueSignalAdvisor: ClueSignalAdvisorView | undefined = !isConditioned && packedTargets.length === 0
      ? ClueSignalAdvisorService.recommend(
        state,
        request.input.item,
        request.input.material,
        request.input.xpLevel,
        5
      )
      : undefined;
    const displayResult = targetAnalysis
      ? { ...result, combos: targetAnalysis.combos }
      : result;

    const accounting = tracker.mass.toPublic();
    const normalization: NormalizationView = {
      domain: isConditioned ? 'clue-known-space' : 'resolved-mass',
      ...(knownSpace !== undefined ? { clue: { knownSpace } } : {})
    };

    if (snapshotType === 'top') {
      return this.createTopView(
        state,
        request.input as TopInputSignature,
        refinementLevel,
        isConditioned,
        normalization,
        accounting,
        displayResult,
        comboLimit ?? ENGINE_LIMITS.MAX_RESULTS_SUMMARY,
        targetDiagnostics,
        clueAdvisor,
        clueSignalAdvisor
      );
    } else {
      return this.createChartCellView(
        request.input.xpLevel as number,
        refinementLevel,
        isConditioned,
        normalization,
        accounting,
        result,
        targetDiagnostics,
        clueAdvisor,
        clueSignalAdvisor
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
    comboLimit: number,
    target?: TargetDiagnosticsView,
    clueAdvisor?: TargetClueAdvisorView,
    clueSignalAdvisor?: ClueSignalAdvisorView
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
      enchants,
      target,
      clueAdvisor,
      clueSignalAdvisor
    };
  }

  private static createChartCellView(
    xpLevel: number,
    refinementLevel: RefinementLevelName,
    clueConditioned: boolean,
    normalization: NormalizationView,
    accounting: AccountingView,
    result: { anyMass: Map<number, bigint>, rankMass: Map<number, bigint>, countMass: Map<number, bigint> },
    target?: TargetDiagnosticsView,
    clueAdvisor?: TargetClueAdvisorView,
    clueSignalAdvisor?: ClueSignalAdvisorView
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
      buckets,
      target,
      clueAdvisor,
      clueSignalAdvisor
    };
  }
}
