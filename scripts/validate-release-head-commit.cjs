const { execFileSync } = require('node:child_process');
const {
  analyzeChangelogSections,
  changelogHeaderPattern,
  extractChangelogEntry,
  releaseBump,
} = require('./release-changelog-policy.cjs');

const args = process.argv.slice(2);
const changelogOnly = args.includes('--changelog-only');
const positionalArgs = args.filter((arg) => !arg.startsWith('--'));
const [tagArg, headRefArg, baseRefArg = 'origin/main'] = positionalArgs;

const KNOWN_RELEASE_DOCS = new Set([
  'ARCHITECTURE.md',
  'README.md',
  'MASS_HANDLING.md',
  'CONTRIBUTING.md',
  'docs/public-api.md',
  'docs/search-engine.md',
]);
const REQUIRED_RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json'];
const REQUIRED_MINOR_PLUS_API_DOC = 'docs/public-api.md';
const ALLOWED_HEAD_FILES = new Set([...REQUIRED_RELEASE_FILES, ...KNOWN_RELEASE_DOCS]);
const SNAPSHOT_PATH_PATTERN = /^tests\/snapshots\//;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`::warning::${message}`);
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function gitLines(args) {
  const output = git(args);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function readRefFile(ref, file) {
  return git(['show', `${ref}:${file}`]);
}

function readRefJson(ref, file) {
  return JSON.parse(readRefFile(ref, file));
}


function validateSnapshotCommitIsolation(baseRef, headRef) {
  const commits = gitLines(['rev-list', '--reverse', `${baseRef}..${headRef}`]);
  const violations = [];

  for (const commit of commits) {
    const changedFiles = gitLines(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]);
    const snapshotFiles = changedFiles.filter((file) => SNAPSHOT_PATH_PATTERN.test(file));
    if (snapshotFiles.length === 0) continue;

    const nonSnapshotFiles = changedFiles.filter((file) => !SNAPSHOT_PATH_PATTERN.test(file));
    if (nonSnapshotFiles.length === 0) continue;

    const subject = git(['show', '-s', '--format=%s', commit]);
    violations.push({
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
      violation.snapshotFiles.map((file) => `  - ${file}`).join('\n'),
      'Non-snapshot files:',
      violation.nonSnapshotFiles.map((file) => `  - ${file}`).join('\n'),
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
}

function validateChangelogSections(bump, tag, entry) {
  const { sections, issue } = analyzeChangelogSections({ bump, tag, entry });

  if (issue) {
    fail(issue.validatorMessage);
  }

  console.log(`Changelog section validation passed for ${bump} release ${tag}: ${sections.join(', ')}`);
}

if (!tagArg || !headRefArg) {
  fail('Usage: node scripts/validate-release-head-commit.cjs <vX.Y.Z> <head-ref> [base-ref] [--changelog-only]');
}

const tag = tagArg.startsWith('v') ? tagArg : `v${tagArg}`;
const proposedVersion = tag.slice(1);
const headRef = headRefArg;
const parentRef = `${headRef}^`;
const baseRef = baseRefArg;

if (changelogOnly) {
  const headChangelog = readRefFile(headRef, 'CHANGELOG.md');
  const changelogEntry = extractChangelogEntry(headChangelog, tag);

  if (!changelogEntry) {
    fail(`CHANGELOG.md does not contain a release entry for ${tag}.`);
  }

  const latestTag = gitLines(['tag', '-l', 'v[0-9]*', '--sort=v:refname'])
    .filter((candidate) => /^v\d+\.\d+\.\d+$/.test(candidate))
    .at(-1);
  const bump = releaseBump(latestTag, tag);

  console.log(`Detected release bump: ${bump}`);
  validateChangelogSections(bump, tag, changelogEntry);
  process.exit(0);
}

const lastCommitFiles = gitLines(['diff-tree', '--no-commit-id', '--name-only', '-r', headRef]);
console.log('Files changed in release branch head commit:');
console.log(lastCommitFiles.join('\n'));

for (const requiredFile of REQUIRED_RELEASE_FILES) {
  if (!lastCommitFiles.includes(requiredFile)) {
    fail(`The final release PR commit must edit ${requiredFile}.`);
  }
}

const disallowedFiles = lastCommitFiles.filter((file) => !ALLOWED_HEAD_FILES.has(file));
if (disallowedFiles.length > 0) {
  fail(`The final release PR commit may only touch release metadata and known docs: ${[...ALLOWED_HEAD_FILES].join(', ')}. Disallowed files:\n${disallowedFiles.join('\n')}`);
}

const headPackage = readRefJson(headRef, 'package.json');
const headLock = readRefJson(headRef, 'package-lock.json');
const parentPackage = readRefJson(parentRef, 'package.json');
const parentLock = readRefJson(parentRef, 'package-lock.json');

if (headPackage.version !== proposedVersion) {
  fail(`package.json version ${headPackage.version} does not match ${tag}.`);
}

if (headLock.version !== proposedVersion || headLock.packages?.['']?.version !== proposedVersion) {
  fail(`package-lock.json versions do not match ${tag}.`);
}

if (
  parentPackage.version === proposedVersion ||
  parentLock.version === proposedVersion ||
  parentLock.packages?.['']?.version === proposedVersion
) {
  fail(`The final release PR commit must bump package.json and package-lock.json to ${proposedVersion} from a previous version.`);
}

const headerPattern = changelogHeaderPattern(tag);
const headChangelog = readRefFile(headRef, 'CHANGELOG.md');
const parentChangelog = readRefFile(parentRef, 'CHANGELOG.md');

if (!headerPattern.test(headChangelog)) {
  fail(`CHANGELOG.md does not contain a release entry for ${tag}.`);
}

if (headerPattern.test(parentChangelog)) {
  fail(`The final release PR commit must add the CHANGELOG.md release entry for ${tag}.`);
}

const latestTag = gitLines(['tag', '-l', 'v[0-9]*', '--sort=v:refname'])
  .filter((candidate) => /^v\d+\.\d+\.\d+$/.test(candidate))
  .at(-1);
const bump = releaseBump(latestTag, tag);
validateSnapshotCommitIsolation(baseRef, headRef);

const changedFiles = gitLines(['diff', '--name-only', baseRef, headRef]);

console.log(`Detected release bump: ${bump}`);

if (bump === 'major' && !lastCommitFiles.includes('ARCHITECTURE.md')) {
  fail('Major releases must update ARCHITECTURE.md in the final release metadata commit.');
}

if ((bump === 'major' || bump === 'minor') && !changedFiles.includes(REQUIRED_MINOR_PLUS_API_DOC)) {
  fail(`Minor and major releases must update ${REQUIRED_MINOR_PLUS_API_DOC} somewhere in the release branch so supported API policy stays current.`);
}

console.log(`Final release PR commit bumps package metadata and adds the ${tag} changelog entry.`);
