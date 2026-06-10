const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_ROOT = 'tests/snapshots/';
const MAX_TABLE_ROWS = 16;
const MAX_LIST_ITEMS = 8;
const MAX_MOVERS = 5;
const NUMERIC_EPSILON = 1e-12;
const SIGNAL_EPSILON = 1e-9;
const INVARIANT_EPSILON = 1e-6;
const ACCOUNTING_BUCKETS = [
  'resolved',
  'clueIncompatible',
  'pending',
  'sieved',
  'overflow',
  'capped',
  'rounding',
  'recoveredRounding',
  'recoveredSieved',
];
const RESULT_SURFACE_KEYS = ['any', 'count', 'ranks', 'shownClueDistribution', 'clue'];
const METADATA_SIGNALS = new Set([
  'diagnostics changed',
  'accounting details changed',
  'human snapshot changed',
  'new/unmapped paths',
]);
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'accounting',
  'accuracy',
  'any',
  'clue',
  'combos',
  'count',
  'diagnostics',
  'ranks',
  'shownClueDistribution',
]);
const KNOWN_DIAGNOSTIC_PATHS = new Set([
  'diagnostics.engine.exitReason',
  'diagnostics.engine.fullyResolved',
  'diagnostics.engine.levelsFullyResolved',
  'diagnostics.engine.levelsProcessed',
  'diagnostics.engine.queueSize',
  'diagnostics.engine.resultsSize',
  'diagnostics.engine.roundingErrorEvents',
  'diagnostics.engine.totalIterations',
  'diagnostics.search.activeResidueCount',
  'diagnostics.search.activeResidueMass',
  'diagnostics.search.canImprove',
  'diagnostics.search.flexChoiceGroupCount',
  'diagnostics.search.flexExpandedPlexNodeCount',
  'diagnostics.search.flexExpandedSolidNodeCount',
  'diagnostics.search.flexGroupedAlternativeCount',
  'diagnostics.search.flexPlexNodeCount',
  'diagnostics.search.flexProjectionClueIncompatible',
  'diagnostics.search.flexProjectionLoss',
  'diagnostics.search.flexSingletonGroupCount',
  'diagnostics.search.flexSolidNodeCount',
  'diagnostics.search.graphCount',
  'diagnostics.search.largestPendingMass',
  'diagnostics.search.lastExpandedMass',
  'diagnostics.search.pendingEntryCount',
  'diagnostics.search.factorCount',
  'diagnostics.search.factorSetCount',
  'diagnostics.search.lateForwardCount',
  'diagnostics.search.pendingMergeCount',
  'diagnostics.search.rankPoolMixCount',
  'diagnostics.search.projectionLoss',
  'diagnostics.search.searchRoundingLoss',
  'diagnostics.search.selectionCount',
  'diagnostics.search.exactPoolCount',
  'diagnostics.search.sharedGraphCount',
  'diagnostics.search.mergedPoolCount',
  'diagnostics.search.seededLevelCount',
]);
const ACCOUNTING_DETAIL_PATH_PATTERN = /^accounting\.details\.stages\.(search|projection)\.(buckets\.[^.]+|operations\.[^.]+\.buckets\.[^.]+)\.(units|value)$/;

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 300,
    ...options,
  }).trim();
}

function normalizePath(file) {
  return file.replace(/\\/g, '/');
}

function gitLines(args, options = {}) {
  const output = git(args, options);
  return output ? output.split(/\r?\n/).filter(Boolean).map(normalizePath) : [];
}

function snapshotId(file) {
  return path.basename(file).replace(/\.human\.json$/, '').replace(/\.json$/, '');
}

function isSnapshot(file) {
  return normalizePath(file).startsWith(SNAPSHOT_ROOT) && file.endsWith('.json');
}

function isHumanSnapshot(file) {
  return file.endsWith('.human.json');
}

function humanPathForRaw(file) {
  return file.replace(/\.json$/, '.human.json');
}

function readRefText(ref, file, options = {}) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 300,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readRefJson(ref, file, options = {}) {
  const text = readRefText(ref, file, options);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function changedSnapshotFiles(baseRef, headRef, options = {}) {
  const files = new Set();
  for (const line of gitLines(['diff', '--name-status', `${baseRef}...${headRef}`, '--', SNAPSHOT_ROOT], options)) {
    const parts = line.split(/\t/);
    if (parts[0]?.startsWith('R')) {
      if (isSnapshot(parts[1])) files.add(parts[1]);
      if (isSnapshot(parts[2])) files.add(parts[2]);
    } else if (isSnapshot(parts[1])) {
      files.add(parts[1]);
    }
  }
  return [...files].sort();
}

function diffVolume(baseRef, headRef, options = {}) {
  let insertions = 0;
  let deletions = 0;

  for (const line of gitLines(['diff', '--numstat', `${baseRef}...${headRef}`, '--', SNAPSHOT_ROOT], options)) {
    const [added, removed] = line.split(/\t/);
    insertions += Number.isFinite(Number(added)) ? Number(added) : 0;
    deletions += Number.isFinite(Number(removed)) ? Number(removed) : 0;
  }

  return { insertions, deletions };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function objectKeyCount(value) {
  return isPlainObject(value) ? Object.keys(value).length : 0;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function flattenNumericLeaves(value, prefix = '', out = {}) {
  const number = asNumber(value);
  if (number != null && prefix) {
    out[prefix] = number;
    return out;
  }

  if (!isPlainObject(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    flattenNumericLeaves(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function collectLeafPaths(value, prefix = '', out = []) {
  if (!isPlainObject(value)) {
    if (prefix) out.push(prefix);
    return out;
  }

  for (const [key, child] of Object.entries(value)) {
    collectLeafPaths(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function sumValues(map) {
  return Object.values(map).reduce((sum, value) => {
    const number = asNumber(value);
    return number == null ? sum : sum + number;
  }, 0);
}

function compareNumericMaps(beforeMap = {}, afterMap = {}) {
  const beforeKeys = new Set(Object.keys(beforeMap));
  const afterKeys = new Set(Object.keys(afterMap));
  const added = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort();
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort();
  const changed = [];

  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) continue;
    const before = asNumber(beforeMap[key]);
    const after = asNumber(afterMap[key]);
    if (before == null || after == null) {
      if (JSON.stringify(beforeMap[key]) !== JSON.stringify(afterMap[key])) {
        changed.push({ key, before: beforeMap[key], after: afterMap[key], delta: null, absDelta: Number.POSITIVE_INFINITY });
      }
      continue;
    }

    const delta = after - before;
    if (Math.abs(delta) > NUMERIC_EPSILON) {
      changed.push({ key, before, after, delta, absDelta: Math.abs(delta) });
    }
  }

  changed.sort((a, b) => b.absDelta - a.absDelta || a.key.localeCompare(b.key));

  return {
    before: beforeKeys.size,
    after: afterKeys.size,
    added,
    removed,
    changed,
    shared: [...beforeKeys].filter((key) => afterKeys.has(key)).length,
    totalBefore: sumValues(beforeMap),
    totalAfter: sumValues(afterMap),
    totalAbsDelta: changed.reduce((sum, item) => Number.isFinite(item.absDelta) ? sum + item.absDelta : sum, 0),
  };
}

function comboSummary(before, after) {
  const beforeCombos = isPlainObject(before?.combos) ? before.combos : {};
  const afterCombos = isPlainObject(after?.combos) ? after.combos : {};
  const comparison = compareNumericMaps(beforeCombos, afterCombos);

  return {
    before: before ? comparison.before : null,
    after: after ? comparison.after : null,
    added: comparison.added.length,
    removed: comparison.removed.length,
    changed: comparison.changed.length,
    shared: comparison.shared,
    addedKeys: comparison.added.slice(0, MAX_MOVERS),
    removedKeys: comparison.removed.slice(0, MAX_MOVERS),
    topMovers: comparison.changed.slice(0, MAX_MOVERS),
    massBefore: before ? comparison.totalBefore : null,
    massAfter: after ? comparison.totalAfter : null,
    massMoved: comparison.totalAbsDelta / 2,
  };
}

function compareNestedSurface(before, after, key) {
  const beforeLeaves = flattenNumericLeaves(before?.[key]);
  const afterLeaves = flattenNumericLeaves(after?.[key]);
  return compareNumericMaps(beforeLeaves, afterLeaves);
}

function weightedBucketAverage(map) {
  let total = 0;
  let weighted = 0;
  for (const [key, value] of Object.entries(map ?? {})) {
    const bucket = Number(key);
    const amount = asNumber(value);
    if (!Number.isFinite(bucket) || amount == null) continue;
    total += amount;
    weighted += bucket * amount;
  }
  return total > 0 ? weighted / total : null;
}

function distributionSummary(before, after) {
  const summaries = [];

  for (const key of RESULT_SURFACE_KEYS) {
    const comparison = compareNestedSurface(before, after, key);
    if (comparison.added.length === 0 && comparison.removed.length === 0 && comparison.changed.length === 0) {
      continue;
    }

    const summary = {
      key,
      added: comparison.added.length,
      removed: comparison.removed.length,
      changed: comparison.changed.length,
      topMovers: comparison.changed.slice(0, MAX_MOVERS),
    };

    if (key === 'count') {
      const beforeAverage = weightedBucketAverage(before?.count);
      const afterAverage = weightedBucketAverage(after?.count);
      if (beforeAverage != null && afterAverage != null && Math.abs(afterAverage - beforeAverage) > NUMERIC_EPSILON) {
        summary.averageBefore = beforeAverage;
        summary.averageAfter = afterAverage;
        summary.direction = afterAverage > beforeAverage ? 'higher' : 'lower';
      }
    }

    summaries.push(summary);
  }

  return summaries;
}

function accountingSummary(before, after) {
  const beforeBuckets = {};
  const afterBuckets = {};

  for (const key of ACCOUNTING_BUCKETS) {
    const beforeValue = asNumber(before?.accounting?.[key]);
    const afterValue = asNumber(after?.accounting?.[key]);
    if (beforeValue != null) beforeBuckets[key] = beforeValue;
    if (afterValue != null) afterBuckets[key] = afterValue;
  }

  const comparison = compareNumericMaps(beforeBuckets, afterBuckets);
  const addedMovers = comparison.added.map((key) => ({
    key,
    before: 0,
    after: afterBuckets[key],
    delta: afterBuckets[key],
    absDelta: Math.abs(afterBuckets[key] ?? 0),
  }));
  const removedMovers = comparison.removed.map((key) => ({
    key,
    before: beforeBuckets[key],
    after: 0,
    delta: -beforeBuckets[key],
    absDelta: Math.abs(beforeBuckets[key] ?? 0),
  }));
  const topMovers = [...comparison.changed, ...addedMovers, ...removedMovers]
    .sort((a, b) => b.absDelta - a.absDelta || a.key.localeCompare(b.key))
    .slice(0, MAX_MOVERS);

  return {
    changed: comparison.changed,
    added: comparison.added,
    removed: comparison.removed,
    topMovers,
    totalBefore: comparison.totalBefore,
    totalAfter: comparison.totalAfter,
  };
}

function pathSummary(beforeValue, afterValue, prefix) {
  const beforePaths = new Set(collectLeafPaths(beforeValue).map((leaf) => `${prefix}.${leaf}`));
  const afterPaths = new Set(collectLeafPaths(afterValue).map((leaf) => `${prefix}.${leaf}`));
  const beforeNumbers = flattenNumericLeaves(beforeValue, prefix);
  const afterNumbers = flattenNumericLeaves(afterValue, prefix);
  const comparison = compareNumericMaps(beforeNumbers, afterNumbers);

  return {
    added: [...afterPaths].filter((item) => !beforePaths.has(item)).sort(),
    removed: [...beforePaths].filter((item) => !afterPaths.has(item)).sort(),
    topMovers: comparison.changed.slice(0, MAX_MOVERS),
  };
}

function splitKnownPaths(paths, isKnown) {
  const known = [];
  const unknown = [];

  for (const item of paths) {
    if (isKnown(item)) {
      known.push(item);
    } else {
      unknown.push(item);
    }
  }

  return { known, unknown };
}

function isKnownDiagnosticPath(item) {
  return KNOWN_DIAGNOSTIC_PATHS.has(item);
}

function isKnownAccountingDetailPath(item) {
  return ACCOUNTING_DETAIL_PATH_PATTERN.test(item);
}

function topLevelPathSummary(before, after) {
  const beforeKeys = new Set(before ? Object.keys(before) : []);
  const afterKeys = new Set(after ? Object.keys(after) : []);
  const added = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort();
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort();

  return {
    added,
    removed,
    unmappedAdded: added.filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key)),
    unmappedRemoved: removed.filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key)),
  };
}

function accountingActiveMass(snapshot) {
  if (!snapshot?.accounting) return null;
  let found = false;
  let total = 0;
  for (const key of ['resolved', 'clueIncompatible', 'pending', 'sieved', 'overflow', 'capped', 'rounding']) {
    const value = asNumber(snapshot.accounting[key]);
    if (value == null) continue;
    found = true;
    total += value;
  }
  return found ? total : null;
}

function invariantWarnings(snapshot, comboMass) {
  const warnings = [];
  if (!snapshot) return warnings;

  const activeMass = accountingActiveMass(snapshot);
  if (activeMass != null && Math.abs(activeMass - 1) > INVARIANT_EPSILON) {
    warnings.push(`accounting active bucket mass sums to ${formatCompactNumber(activeMass)}, expected about 1`);
  }

  const resolved = asNumber(snapshot.accounting?.resolved);
  if (!snapshot.clue && resolved != null && comboMass != null && Math.abs(resolved - comboMass) > INVARIANT_EPSILON) {
    warnings.push(`combo mass ${formatCompactNumber(comboMass)} differs from accounting.resolved ${formatCompactNumber(resolved)}`);
  }

  return warnings;
}

function humanPairSummary({ file, baseRef, headRef, cwd }) {
  const humanFile = humanPathForRaw(file);
  const before = readRefText(baseRef, humanFile, { cwd });
  const after = readRefText(headRef, humanFile, { cwd });

  return {
    file: humanFile,
    beforeExists: before != null,
    afterExists: after != null,
    changed: before !== after,
  };
}

function summarizeRawSnapshot({ file, baseRef, headRef, cwd }) {
  const before = readRefJson(baseRef, file, { cwd });
  const after = readRefJson(headRef, file, { cwd });
  const status = before && after ? 'modified' : before ? 'removed' : 'added';
  const topLevel = topLevelPathSummary(before, after);
  const combos = comboSummary(before, after);
  const distributions = status === 'modified' ? distributionSummary(before, after) : [];
  const accounting = status === 'modified' ? accountingSummary(before, after) : {
    changed: [],
    added: [],
    removed: [],
    topMovers: [],
    totalBefore: null,
    totalAfter: null,
  };
  const diagnostics = pathSummary(before?.diagnostics, after?.diagnostics, 'diagnostics');
  const accountingDetails = pathSummary(before?.accounting?.details, after?.accounting?.details, 'accounting.details');
  const diagnosticPathsAdded = splitKnownPaths(diagnostics.added, isKnownDiagnosticPath);
  const diagnosticPathsRemoved = splitKnownPaths(diagnostics.removed, isKnownDiagnosticPath);
  const accountingDetailPathsAdded = splitKnownPaths(accountingDetails.added, isKnownAccountingDetailPath);
  const accountingDetailPathsRemoved = splitKnownPaths(accountingDetails.removed, isKnownAccountingDetailPath);
  const humanPair = humanPairSummary({ file, baseRef, headRef, cwd });
  const accuracyBefore = before?.accuracy ?? null;
  const accuracyAfter = after?.accuracy ?? null;
  const accuracyDelta = asNumber(accuracyBefore) != null && asNumber(accuracyAfter) != null
    ? accuracyAfter - accuracyBefore
    : null;
  const warnings = [
    ...invariantWarnings(before, combos.massBefore).map((warning) => `before: ${warning}`),
    ...invariantWarnings(after, combos.massAfter).map((warning) => `after: ${warning}`),
  ];
  const schemaPathsAdded = [
    ...diagnosticPathsAdded.unknown,
    ...accountingDetailPathsAdded.unknown,
    ...topLevel.unmappedAdded.map((key) => key),
  ];
  const schemaPathsRemoved = [
    ...diagnosticPathsRemoved.unknown,
    ...accountingDetailPathsRemoved.unknown,
    ...topLevel.unmappedRemoved.map((key) => key),
  ];
  const signals = [];

  if (status !== 'modified') {
    signals.push(status === 'added' ? 'new fixture' : 'removed fixture');
  } else {
    if (accuracyDelta != null && Math.abs(accuracyDelta) > SIGNAL_EPSILON) signals.push('accuracy changed');
    if (combos.added > 0 || combos.removed > 0) signals.push('combo keys changed');
    if (combos.changed > 0) signals.push('combo mass moved');
    if (distributions.length > 0) signals.push('distribution shifted');
    if (accounting.changed.length > 0 || accounting.added.length > 0 || accounting.removed.length > 0) signals.push('accounting shifted');
  }
  if (diagnostics.added.length > 0 || diagnostics.removed.length > 0 || diagnostics.topMovers.length > 0) signals.push('diagnostics changed');
  if (accountingDetails.added.length > 0 || accountingDetails.removed.length > 0 || accountingDetails.topMovers.length > 0) signals.push('accounting details changed');
  if (warnings.length > 0) signals.push('invariant warning');
  if (humanPair.changed) signals.push('human snapshot changed');
  if (schemaPathsAdded.length > 0 || schemaPathsRemoved.length > 0) signals.push('new/unmapped paths');

  const resultBearing = status === 'modified' && (
    Math.abs(accuracyDelta ?? 0) > SIGNAL_EPSILON
    || combos.added > 0
    || combos.removed > 0
    || combos.changed > 0
    || distributions.length > 0
    || accounting.changed.length > 0
    || accounting.added.length > 0
    || accounting.removed.length > 0
    || warnings.length > 0
  );
  let reviewKind = 'schema/diagnostic-only';
  if (status === 'added') {
    reviewKind = 'fixture-added';
  } else if (status === 'removed') {
    reviewKind = 'fixture-removed';
  } else if (resultBearing) {
    reviewKind = 'result-bearing';
  }

  return {
    id: snapshotId(file),
    file,
    status,
    reviewKind,
    signals,
    accuracyBefore,
    accuracyAfter,
    accuracyDelta,
    comboCountBefore: combos.before,
    comboCountAfter: combos.after,
    comboKeysAdded: combos.added,
    comboKeysRemoved: combos.removed,
    comboValuesChanged: combos.changed,
    comboKeysShared: combos.shared,
    comboMassBefore: combos.massBefore,
    comboMassAfter: combos.massAfter,
    comboMassMoved: combos.massMoved,
    comboTopMovers: combos.topMovers,
    comboKeysAddedExamples: combos.addedKeys,
    comboKeysRemovedExamples: combos.removedKeys,
    accountingDetailsAdded: !before?.accounting?.details && Boolean(after?.accounting?.details),
    diagnosticsAdded: !before?.diagnostics && Boolean(after?.diagnostics),
    diagnostics,
    diagnosticPathsKnownAdded: diagnosticPathsAdded.known,
    diagnosticPathsKnownRemoved: diagnosticPathsRemoved.known,
    accounting,
    accountingDetails,
    accountingDetailPathsKnownAdded: accountingDetailPathsAdded.known,
    accountingDetailPathsKnownRemoved: accountingDetailPathsRemoved.known,
    distributions,
    invariantWarnings: warnings,
    humanSnapshotChanged: humanPair.changed,
    topLevelKeysAdded: topLevel.added,
    topLevelKeysRemoved: topLevel.removed,
    unmappedPathsAdded: schemaPathsAdded,
    unmappedPathsRemoved: schemaPathsRemoved,
    ranksBefore: before ? objectKeyCount(before.ranks) : null,
    ranksAfter: after ? objectKeyCount(after.ranks) : null,
    anyBefore: before ? objectKeyCount(before.any) : null,
    anyAfter: after ? objectKeyCount(after.any) : null,
    countBucketsBefore: before ? objectKeyCount(before.count) : null,
    countBucketsAfter: after ? objectKeyCount(after.count) : null,
  };
}

function classifySnapshotChanges({ baseRef, headRef, cwd = process.cwd() }) {
  const files = changedSnapshotFiles(baseRef, headRef, { cwd });
  const rawFiles = files.filter((file) => !isHumanSnapshot(file));
  const humanFiles = files.filter(isHumanSnapshot);
  const rawSnapshots = rawFiles.map((file) => summarizeRawSnapshot({ file, baseRef, headRef, cwd }));
  const statusCounts = rawSnapshots.reduce((counts, snapshot) => {
    counts[snapshot.status] = (counts[snapshot.status] ?? 0) + 1;
    return counts;
  }, {});

  return {
    baseRef,
    headRef,
    diff: diffVolume(baseRef, headRef, { cwd }),
    files: {
      raw: rawFiles,
      human: humanFiles,
    },
    counts: {
      raw: rawFiles.length,
      human: humanFiles.length,
      added: statusCounts.added ?? 0,
      modified: statusCounts.modified ?? 0,
      removed: statusCounts.removed ?? 0,
      diagnosticsAdded: rawSnapshots.filter((snapshot) => snapshot.diagnosticsAdded).length,
      accountingDetailsAdded: rawSnapshots.filter((snapshot) => snapshot.accountingDetailsAdded).length,
      knownDiagnosticFieldSnapshots: rawSnapshots.filter((snapshot) => (
        snapshot.diagnosticPathsKnownAdded.length > 0 || snapshot.diagnosticPathsKnownRemoved.length > 0
      )).length,
      knownAccountingDetailSnapshots: rawSnapshots.filter((snapshot) => (
        snapshot.accountingDetailPathsKnownAdded.length > 0 || snapshot.accountingDetailPathsKnownRemoved.length > 0
      )).length,
      resultBearing: rawSnapshots.filter((snapshot) => snapshot.reviewKind === 'result-bearing').length,
      fixtureAdded: rawSnapshots.filter((snapshot) => snapshot.reviewKind === 'fixture-added').length,
      fixtureRemoved: rawSnapshots.filter((snapshot) => snapshot.reviewKind === 'fixture-removed').length,
      schemaOnly: rawSnapshots.filter((snapshot) => snapshot.reviewKind === 'schema/diagnostic-only').length,
      invariantWarnings: rawSnapshots.reduce((count, snapshot) => count + snapshot.invariantWarnings.length, 0),
      unmappedPathSnapshots: rawSnapshots.filter((snapshot) => snapshot.unmappedPathsAdded.length > 0 || snapshot.unmappedPathsRemoved.length > 0).length,
    },
    rawSnapshots,
  };
}

function hasSnapshotChanges(classification) {
  return classification.files.raw.length > 0 || classification.files.human.length > 0;
}

function formatNumber(value) {
  return value == null ? '-' : value.toLocaleString('en-US');
}

function formatCompactNumber(value) {
  if (value == null) return '-';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number === 0) return '0';
  if (Math.abs(number) >= 0.001 && Math.abs(number) < 1000) {
    return number.toPrecision(6).replace(/\.?0+$/, '');
  }
  return number.toExponential(3);
}

function formatDelta(before, after) {
  if (before == null && after == null) return '-';
  if (before == null) return `new ${formatNumber(after)}`;
  if (after == null) return `removed ${formatNumber(before)}`;
  const delta = after - before;
  if (delta === 0) return 'stable';
  const sign = delta > 0 ? '+' : '';
  return `${formatNumber(before)} -> ${formatNumber(after)} (${sign}${formatNumber(delta)})`;
}

function formatAccuracy(before, after) {
  if (before == null && after == null) return '-';
  if (before == null) return `new ${Number(after).toFixed(12)}`;
  if (after == null) return `removed ${Number(before).toFixed(12)}`;
  const delta = after - before;
  if (Math.abs(delta) <= SIGNAL_EPSILON) return 'stable';
  const sign = delta > 0 ? '+' : '';
  return `${Number(before).toFixed(12)} -> ${Number(after).toFixed(12)} (${sign}${delta.toExponential(2)})`;
}

function escapeTable(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function comparisonReview(snapshot) {
  const notes = [];
  const signals = new Set(snapshot.signals);
  if (signals.has('accuracy changed')) notes.push('accuracy changed');
  if (snapshot.comboKeysAdded || snapshot.comboKeysRemoved) {
    notes.push('combo key set changed');
  }
  if (snapshot.comboValuesChanged) {
    notes.push('shared combo masses changed');
  }
  const countDistribution = snapshot.distributions.find((distribution) => distribution.key === 'count' && distribution.direction);
  if (countDistribution) {
    notes.push(`count distribution shifted ${countDistribution.direction}`);
  }
  const otherDistributionCount = snapshot.distributions.filter((distribution) => distribution.key !== 'count').length;
  if (otherDistributionCount > 0) {
    notes.push('other result distributions shifted');
  } else if (signals.has('distribution shifted') && !countDistribution) {
    notes.push('result distribution shifted');
  }
  if (signals.has('accounting shifted')) {
    notes.push('accounting buckets shifted');
  }
  if (snapshot.humanSnapshotChanged) notes.push('human snapshot changed');
  if (signals.has('new/unmapped paths')) {
    notes.push('unknown snapshot paths changed');
  }
  if (snapshot.invariantWarnings.length > 0) {
    notes.push(`${snapshot.invariantWarnings.length} invariant warning${snapshot.invariantWarnings.length === 1 ? '' : 's'}`);
  }
  return notes.filter((note, index) => note && notes.indexOf(note) === index).join('; ') || '-';
}

function fixtureReview(snapshot) {
  const notes = [];
  if (snapshot.humanSnapshotChanged) {
    notes.push(snapshot.status === 'added' ? 'human snapshot added' : 'human snapshot removed');
  }
  if (snapshot.diagnosticPathsKnownAdded.length > 0) notes.push('known diagnostics added');
  if (snapshot.diagnosticPathsKnownRemoved.length > 0) notes.push('known diagnostics removed');
  if (snapshot.accountingDetailPathsKnownAdded.length > 0) notes.push('known accounting details added');
  if (snapshot.accountingDetailPathsKnownRemoved.length > 0) notes.push('known accounting details removed');
  if (snapshot.unmappedPathsAdded.length > 0) notes.push(`unknown paths added ${formatPathList(snapshot.unmappedPathsAdded)}`);
  if (snapshot.unmappedPathsRemoved.length > 0) notes.push(`unknown paths removed ${formatPathList(snapshot.unmappedPathsRemoved)}`);
  return notes.join('; ') || '-';
}

function formatPathList(paths) {
  if (paths.length === 0) return '-';
  const shown = paths.slice(0, MAX_LIST_ITEMS).map((item) => `\`${item}\``).join(', ');
  const suffix = paths.length > MAX_LIST_ITEMS ? `, and ${paths.length - MAX_LIST_ITEMS} more` : '';
  return `${shown}${suffix}`;
}

function snapshotHasKnownInstrumentation(snapshot) {
  return snapshot.diagnosticPathsKnownAdded.length > 0
    || snapshot.diagnosticPathsKnownRemoved.length > 0
    || snapshot.accountingDetailPathsKnownAdded.length > 0
    || snapshot.accountingDetailPathsKnownRemoved.length > 0;
}

function formatInstrumentationSummary(rawSnapshots) {
  const snapshots = rawSnapshots.filter(snapshotHasKnownInstrumentation);
  if (snapshots.length === 0) return [];

  const diagnostics = rawSnapshots.filter((snapshot) => (
    snapshot.diagnosticPathsKnownAdded.length > 0 || snapshot.diagnosticPathsKnownRemoved.length > 0
  ));
  const accountingDetails = rawSnapshots.filter((snapshot) => (
    snapshot.accountingDetailPathsKnownAdded.length > 0 || snapshot.accountingDetailPathsKnownRemoved.length > 0
  ));
  const lines = ['', '## Instrumentation Additions', ''];

  if (diagnostics.length > 0) {
    lines.push([
      `- Engine/search diagnostics changed in ${diagnostics.length} snapshot${diagnostics.length === 1 ? '' : 's'}:`,
      'engine iteration/queue/result counters, exit status, search graph/frontier counts, Flex grouping counts, and projection-loss counters.',
    ].join(' '));
  }

  if (accountingDetails.length > 0) {
    lines.push([
      `- Accounting details changed in ${accountingDetails.length} snapshot${accountingDetails.length === 1 ? '' : 's'}:`,
      'search/projection bucket totals plus operation-level bucket totals for seed, resolve, frontier, clue prune, overflow, residue, and projection operations.',
    ].join(' '));
  }

  const instrumentationOnly = rawSnapshots.filter((snapshot) => (
    snapshot.reviewKind === 'schema/diagnostic-only' || (
      snapshotHasKnownInstrumentation(snapshot)
      && snapshot.signals.filter((signal) => !METADATA_SIGNALS.has(signal)).length === 0
    )
  ));
  if (instrumentationOnly.length > 0) {
    lines.push(`- Instrumentation/human-output-only snapshots: ${instrumentationOnly.slice(0, MAX_LIST_ITEMS).map((snapshot) => `\`${snapshot.id}\``).join(', ')}${instrumentationOnly.length > MAX_LIST_ITEMS ? `, and ${instrumentationOnly.length - MAX_LIST_ITEMS} more` : ''}`);
  }

  return lines;
}

function formatFixtureChanges(rawSnapshots) {
  const fixtures = rawSnapshots.filter((snapshot) => (
    snapshot.reviewKind === 'fixture-added' || snapshot.reviewKind === 'fixture-removed'
  ));
  if (fixtures.length === 0) return [];

  const lines = ['', '## New Or Removed Snapshots', ''];
  lines.push('| Snapshot | Status | Accuracy | Combos | Review |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const snapshot of fixtures.slice(0, MAX_TABLE_ROWS)) {
    lines.push([
      `| \`${snapshot.id}\``,
      snapshot.status,
      escapeTable(formatAccuracy(snapshot.accuracyBefore, snapshot.accuracyAfter)),
      escapeTable(formatDelta(snapshot.comboCountBefore, snapshot.comboCountAfter)),
      `${escapeTable(fixtureReview(snapshot))} |`,
    ].join(' | '));
  }

  if (fixtures.length > MAX_TABLE_ROWS) {
    lines.push('', `_Showing ${MAX_TABLE_ROWS} of ${fixtures.length} fixture changes._`);
  }

  return lines;
}

function formatMarkdown(classification) {
  if (!hasSnapshotChanges(classification)) {
    return 'No snapshot files changed.\n';
  }

  const { counts, diff, rawSnapshots } = classification;
  const lines = [
    'Snapshot outputs changed. This is a red advisory: review generated output changes before merging.',
    '',
    '## TLDR',
    '',
    `- Raw snapshots changed: ${counts.raw} (${counts.added} added, ${counts.modified} modified, ${counts.removed} removed)`,
    `- Human-readable snapshot files changed: ${counts.human}`,
    `- Comparable result changes: ${counts.resultBearing}`,
    `- New/removed snapshots: ${counts.fixtureAdded} added, ${counts.fixtureRemoved} removed`,
    `- Schema/diagnostic/human-only changes: ${counts.schemaOnly}`,
    `- Invariant warnings: ${counts.invariantWarnings}`,
    `- Snapshots with unknown paths: ${counts.unmappedPathSnapshots}`,
    `- Snapshot diff volume: +${formatNumber(diff.insertions)} / -${formatNumber(diff.deletions)} lines`,
  ];

  if (counts.diagnosticsAdded > 0 || counts.accountingDetailsAdded > 0) {
    lines.push(`- Diagnostics/accounting detail fields added: diagnostics ${counts.diagnosticsAdded}, accounting details ${counts.accountingDetailsAdded}`);
  }

  const resultSnapshots = rawSnapshots.filter((snapshot) => snapshot.reviewKind === 'result-bearing');
  if (resultSnapshots.length > 0) {
    lines.push('', '## Result Changes', '');
    lines.push('| Snapshot | Accuracy | Combos | Review |');
    lines.push('| --- | --- | --- | --- |');

    for (const snapshot of resultSnapshots.slice(0, MAX_TABLE_ROWS)) {
      lines.push([
        `| \`${snapshot.id}\``,
        escapeTable(formatAccuracy(snapshot.accuracyBefore, snapshot.accuracyAfter)),
        escapeTable(formatDelta(snapshot.comboCountBefore, snapshot.comboCountAfter)),
        `${escapeTable(comparisonReview(snapshot))} |`,
      ].join(' | '));
    }

    if (resultSnapshots.length > MAX_TABLE_ROWS) {
      lines.push('', `_Showing ${MAX_TABLE_ROWS} of ${resultSnapshots.length} result-bearing snapshot changes._`);
    }
  }

  lines.push(...formatFixtureChanges(rawSnapshots));
  lines.push(...formatInstrumentationSummary(rawSnapshots));

  const schemaSnapshots = rawSnapshots.filter((snapshot) => snapshot.reviewKind === 'schema/diagnostic-only');
  if (schemaSnapshots.length > 0) {
    lines.push('', '## Schema And Diagnostics Changes', '');
    for (const snapshot of schemaSnapshots.slice(0, MAX_LIST_ITEMS)) {
      const addedPaths = [
        ...snapshot.unmappedPathsAdded,
      ];
      const knownNotes = [];
      if (snapshot.diagnosticPathsKnownAdded.length > 0) knownNotes.push('known engine/search diagnostics');
      if (snapshot.accountingDetailPathsKnownAdded.length > 0) knownNotes.push('known accounting details');
      const unknownNote = addedPaths.length > 0 ? `unknown paths ${formatPathList(addedPaths)}` : 'no unknown paths';
      lines.push(`- \`${snapshot.id}\`: ${[...knownNotes, unknownNote].join('; ')}`);
    }
    if (schemaSnapshots.length > MAX_LIST_ITEMS) {
      lines.push(`- and ${schemaSnapshots.length - MAX_LIST_ITEMS} more schema/diagnostic-only snapshots`);
    }
  }

  const warnings = rawSnapshots
    .flatMap((snapshot) => snapshot.invariantWarnings.map((warning) => ({ id: snapshot.id, warning })))
    .slice(0, MAX_LIST_ITEMS);
  if (warnings.length > 0) {
    lines.push('', '## Invariant Warnings', '');
    for (const { id, warning } of warnings) {
      lines.push(`- \`${id}\`: ${warning}`);
    }
  }

  const pathSnapshots = rawSnapshots
    .filter((snapshot) => snapshot.unmappedPathsAdded.length > 0 || snapshot.unmappedPathsRemoved.length > 0)
    .slice(0, MAX_LIST_ITEMS);
  if (pathSnapshots.length > 0) {
    lines.push('', '## Unknown Paths', '');
    for (const snapshot of pathSnapshots) {
      lines.push(`- \`${snapshot.id}\`: added ${formatPathList(snapshot.unmappedPathsAdded)}; removed ${formatPathList(snapshot.unmappedPathsRemoved)}`);
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function parseCliArgs(argv) {
  const args = [...argv];
  const baseRef = args.shift();
  const headRef = args.shift();
  const options = {};

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--body-file') {
      options.bodyFile = args.shift();
    } else if (arg === '--json-file') {
      options.jsonFile = args.shift();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!baseRef || !headRef) {
    throw new Error('Usage: node scripts/classify-snapshot-changes.cjs <base-ref> <head-ref> [--body-file path] [--json-file path]');
  }

  return { baseRef, headRef, options };
}

function writeFileIfRequested(file, content) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

if (require.main === module) {
  try {
    const { baseRef, headRef, options } = parseCliArgs(process.argv.slice(2));
    const classification = classifySnapshotChanges({ baseRef, headRef });
    const changed = hasSnapshotChanges(classification);
    const markdown = changed ? formatMarkdown(classification) : '';

    writeFileIfRequested(options.jsonFile, `${JSON.stringify(classification, null, 2)}\n`);
    writeFileIfRequested(options.bodyFile, markdown);

    if (changed) {
      console.log(markdown);
    } else {
      console.log('No snapshot files changed.');
    }

    process.exit(changed ? 1 : 0);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

module.exports = {
  classifySnapshotChanges,
  formatMarkdown,
  hasSnapshotChanges,
};
