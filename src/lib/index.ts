/**
 * Supported package entry point for application and tool callers.
 *
 * @packageDocumentation
 */

export { EnchantingAnalyzer } from '#lib/api/EnchantingAnalyzer.js';
export type {
    AnalyzerCacheCounter,
    AnalyzerCacheMetrics,
    AnalyzerOptions,
    AnalyzerRegistryInfo,
    AnalyzerRequest,
    AnalyzerSearchControls,
    AnalyzerSearchMode,
    AnalyzerSearchPreset
} from '#lib/api/EnchantingAnalyzer.js';

export type {
    ConflictRule,
    ConflictRuleSelector,
    EnchantabilityTable,
    EnchantableItemRule,
    EnchantableItemRuleSelector,
    Enchantment,
    EnchantmentGroupRule,
    EnchantmentGroupRuleSelector,
    EnchantmentLevels,
    MaterialRule,
    MaterialRuleSelector,
    RegistryMutation,
    VersionMechanics
} from './types/domain.js';
export type {
    MassAccountingBreakdown,
    MassAccountingDetailBucket,
    MassAccountingDetails,
    MassAccountingOperationDetails,
    MassAccountingStageDetails,
    MassBucketName,
    MassBucketUnits
} from '#types/index.js';
