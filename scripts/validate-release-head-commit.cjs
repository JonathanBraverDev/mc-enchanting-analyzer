const { execFileSync } = require('node:child_process');

const [, , tagArg, headRefArg, baseRefArg = 'origin/main'] = process.argv;

const KNOWN_RELEASE_DOCS = new Set([
  'ARCHITECTURE.md',
  'README.md',
  'MASS_HANDLING.md',
  'CONTRIBUTING.md',
]);
const REQUIRED_RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json'];
const ALLOWED_HEAD_FILES = new Set([...REQUIRED_RELEASE_FILES, ...KNOWN_RELEASE_DOCS]);

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

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function releaseBump(latestTag, proposedTag) {
  const latest = parseVersion(latestTag);
  const proposed = parseVersion(proposedTag);

  if (!latest || !proposed || latestTag === proposedTag) {
    return 'unknown';
  }

  if (proposed.major > latest.major) {
    return 'major';
  }

  if (proposed.major === latest.major && proposed.minor > latest.minor) {
    return 'minor';
  }

  return 'patch';
}

function changelogHeaderPattern(tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+(?:\\[${escapedTag}\\]|${escapedTag})(?:\\s*\\([^\\n]*\\))?\\s*$`, 'm');
}

if (!tagArg || !headRefArg) {
  fail('Usage: node scripts/validate-release-head-commit.cjs <vX.Y.Z> <head-ref> [base-ref]');
}

const tag = tagArg.startsWith('v') ? tagArg : `v${tagArg}`;
const proposedVersion = tag.slice(1);
const headRef = headRefArg;
const parentRef = `${headRef}^`;
const baseRef = baseRefArg;

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
const changedFiles = gitLines(['diff', '--name-only', baseRef, headRef]);

console.log(`Detected release bump: ${bump}`);

if (bump === 'major' && !lastCommitFiles.includes('ARCHITECTURE.md')) {
  fail('Major releases must update ARCHITECTURE.md in the final release metadata commit.');
}

if (bump === 'minor' && !changedFiles.some((file) => KNOWN_RELEASE_DOCS.has(file))) {
  warn('Minor releases should update project docs when behavior, architecture, workflows, or user-facing capabilities changed.');
}

console.log(`Final release PR commit bumps package metadata and adds the ${tag} changelog entry.`);
