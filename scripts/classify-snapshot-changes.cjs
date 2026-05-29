const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_ROOT = 'tests/snapshots/';
const MAX_TABLE_ROWS = 16;
const MAX_LIST_ITEMS = 8;

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

function readRefJson(ref, file, options = {}) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 300,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
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

function objectKeyCount(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

function comboSummary(before, after) {
  const beforeCombos = before?.combos ?? {};
  const afterCombos = after?.combos ?? {};
  const beforeKeys = new Set(Object.keys(beforeCombos));
  const afterKeys = new Set(Object.keys(afterCombos));
  let shared = 0;
  let changed = 0;

  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) continue;
    shared += 1;
    if (JSON.stringify(beforeCombos[key]) !== JSON.stringify(afterCombos[key])) {
      changed += 1;
    }
  }

  return {
    before: before ? beforeKeys.size : null,
    after: after ? afterKeys.size : null,
    added: [...afterKeys].filter((key) => !beforeKeys.has(key)).length,
    removed: [...beforeKeys].filter((key) => !afterKeys.has(key)).length,
    changed,
    shared,
  };
}

function summarizeRawSnapshot({ file, baseRef, headRef, cwd }) {
  const before = readRefJson(baseRef, file, { cwd });
  const after = readRefJson(headRef, file, { cwd });
  const beforeKeys = new Set(before ? Object.keys(before) : []);
  const afterKeys = new Set(after ? Object.keys(after) : []);
  const addedTopLevelKeys = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort();
  const removedTopLevelKeys = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort();
  const combos = comboSummary(before, after);
  const status = before && after ? 'modified' : before ? 'removed' : 'added';

  return {
    id: snapshotId(file),
    file,
    status,
    accuracyBefore: before?.accuracy ?? null,
    accuracyAfter: after?.accuracy ?? null,
    comboCountBefore: combos.before,
    comboCountAfter: combos.after,
    comboKeysAdded: combos.added,
    comboKeysRemoved: combos.removed,
    comboValuesChanged: combos.changed,
    comboKeysShared: combos.shared,
    accountingDetailsAdded: !before?.accounting?.details && Boolean(after?.accounting?.details),
    diagnosticsAdded: !before?.diagnostics && Boolean(after?.diagnostics),
    topLevelKeysAdded: addedTopLevelKeys,
    topLevelKeysRemoved: removedTopLevelKeys,
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

function formatDelta(before, after) {
  if (before == null && after == null) return '-';
  if (before == null) return `new ${formatNumber(after)}`;
  if (after == null) return `removed ${formatNumber(before)}`;
  const delta = after - before;
  const sign = delta > 0 ? '+' : '';
  return `${formatNumber(before)} -> ${formatNumber(after)} (${sign}${formatNumber(delta)})`;
}

function formatAccuracy(before, after) {
  if (before == null && after == null) return '-';
  if (before == null) return `new ${Number(after).toFixed(12)}`;
  if (after == null) return `removed ${Number(before).toFixed(12)}`;
  const delta = after - before;
  const sign = delta > 0 ? '+' : '';
  return `${Number(before).toFixed(12)} -> ${Number(after).toFixed(12)} (${sign}${delta.toExponential(2)})`;
}

function listItems(label, values) {
  if (values.length === 0) return [];
  const shown = values.slice(0, MAX_LIST_ITEMS);
  const suffix = values.length > shown.length ? `, and ${values.length - shown.length} more` : '';
  return [`- ${label}: ${shown.map((item) => `\`${item}\``).join(', ')}${suffix}`];
}

function snapshotNotes(snapshot) {
  const notes = [];
  if (snapshot.status !== 'modified') notes.push(snapshot.status);
  if (snapshot.diagnosticsAdded) notes.push('diagnostics added');
  if (snapshot.accountingDetailsAdded) notes.push('accounting details added');
  if (snapshot.topLevelKeysAdded.length > 0) {
    notes.push(`top-level +${snapshot.topLevelKeysAdded.join(', ')}`);
  }
  if (snapshot.comboKeysAdded || snapshot.comboKeysRemoved) {
    notes.push(`combo keys +${formatNumber(snapshot.comboKeysAdded)}/-${formatNumber(snapshot.comboKeysRemoved)}`);
  }
  if (snapshot.comboValuesChanged) {
    notes.push(`${formatNumber(snapshot.comboValuesChanged)} shared combo values changed`);
  }
  return notes.join('; ') || '-';
}

function formatMarkdown(classification) {
  if (!hasSnapshotChanges(classification)) {
    return 'No snapshot files changed.\n';
  }

  const { counts, diff, rawSnapshots } = classification;
  const lines = [
    'Snapshot outputs changed. Use this as a review map for generated diff volume, not as a pass/fail signal.',
    '',
    '## TLDR',
    '',
    `- Raw snapshots changed: ${counts.raw} (${counts.added} added, ${counts.modified} modified, ${counts.removed} removed)`,
    `- Human-readable snapshot files changed: ${counts.human}`,
    `- Snapshot diff volume: +${formatNumber(diff.insertions)} / -${formatNumber(diff.deletions)} lines`,
  ];

  if (counts.diagnosticsAdded > 0 || counts.accountingDetailsAdded > 0) {
    lines.push(`- Diagnostics/accounting detail fields added: diagnostics ${counts.diagnosticsAdded}, accounting details ${counts.accountingDetailsAdded}`);
  }

  const added = rawSnapshots.filter((snapshot) => snapshot.status === 'added').map((snapshot) => snapshot.id);
  const removed = rawSnapshots.filter((snapshot) => snapshot.status === 'removed').map((snapshot) => snapshot.id);
  lines.push(...listItems('Added raw snapshots', added));
  lines.push(...listItems('Removed raw snapshots', removed));

  const largestComboChanges = [...rawSnapshots]
    .filter((snapshot) => snapshot.comboKeysAdded || snapshot.comboKeysRemoved || snapshot.comboValuesChanged)
    .sort((a, b) => {
      const score = (snapshot) => snapshot.comboKeysAdded + snapshot.comboKeysRemoved + snapshot.comboValuesChanged;
      return score(b) - score(a);
    })
    .slice(0, 3);

  if (largestComboChanges.length > 0) {
    lines.push('- Largest combo churn:');
    for (const snapshot of largestComboChanges) {
      lines.push(`  - \`${snapshot.id}\`: ${formatDelta(snapshot.comboCountBefore, snapshot.comboCountAfter)}, ${formatNumber(snapshot.comboValuesChanged)} shared values changed`);
    }
  }

  lines.push('', '## Snapshot Summary', '');
  lines.push('| Snapshot | Status | Accuracy | Combo count | Combo key churn | Notes |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const snapshot of rawSnapshots.slice(0, MAX_TABLE_ROWS)) {
    lines.push([
      `| \`${snapshot.id}\``,
      snapshot.status,
      formatAccuracy(snapshot.accuracyBefore, snapshot.accuracyAfter),
      formatDelta(snapshot.comboCountBefore, snapshot.comboCountAfter),
      `+${formatNumber(snapshot.comboKeysAdded)} / -${formatNumber(snapshot.comboKeysRemoved)}`,
      `${snapshotNotes(snapshot)} |`,
    ].join(' | '));
  }

  if (rawSnapshots.length > MAX_TABLE_ROWS) {
    lines.push('', `_Showing ${MAX_TABLE_ROWS} of ${rawSnapshots.length} raw snapshot changes._`);
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
