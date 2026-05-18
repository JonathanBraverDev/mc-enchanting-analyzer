#!/usr/bin/env node
const { execFileSync } = require('node:child_process');

const [baseRefArg = 'origin/main', headRefArg = 'HEAD'] = process.argv.slice(2);

const SNAPSHOT_PATH_PATTERN = /^tests\/snapshots\//;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function gitLines(args) {
  const output = git(args);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function formatList(files) {
  return files.map((file) => `  - ${file}`).join('\n');
}

const baseRef = baseRefArg;
const headRef = headRefArg;
const commits = gitLines(['rev-list', '--reverse', `${baseRef}..${headRef}`]);

if (commits.length === 0) {
  console.log(`No commits to check between ${baseRef} and ${headRef}.`);
  process.exit(0);
}

const violations = [];

for (const commit of commits) {
  const changedFiles = gitLines(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]);
  const snapshotFiles = changedFiles.filter((file) => SNAPSHOT_PATH_PATTERN.test(file));
  if (snapshotFiles.length === 0) continue;

  const nonSnapshotFiles = changedFiles.filter((file) => !SNAPSHOT_PATH_PATTERN.test(file));
  if (nonSnapshotFiles.length === 0) continue;

  const subject = git(['show', '-s', '--format=%s', commit]);
  violations.push({
    commit,
    short: commit.slice(0, 12),
    subject,
    snapshotFiles,
    nonSnapshotFiles,
  });
}

if (violations.length > 0) {
  const details = violations.map((violation) => [
    `${violation.short} ${violation.subject}`,
    'Snapshot files:',
    formatList(violation.snapshotFiles),
    'Non-snapshot files:',
    formatList(violation.nonSnapshotFiles),
  ].join('\n')).join('\n\n');

  fail([
    'Snapshot updates must be isolated in their own commits.',
    'Commits that touch tests/snapshots/** may not touch source, tests, docs, package metadata, or other files.',
    'Split snapshot refreshes into a dedicated commit so large generated diffs do not hide code changes.',
    '',
    details,
  ].join('\n'));
}

console.log(`Snapshot commit isolation passed for ${commits.length} commit(s) between ${baseRef} and ${headRef}.`);
