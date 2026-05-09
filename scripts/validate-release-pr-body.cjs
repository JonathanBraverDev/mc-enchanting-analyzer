const fs = require('node:fs');

const [, , tagArg, bodyPath, changelogPath = 'CHANGELOG.md'] = process.argv;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function normalize(text) {
  return text.replace(/\r\n?/g, '\n').trim();
}

function withoutHeaderDate(entry) {
  const lines = entry.split('\n');
  lines[0] = lines[0].replace(/\s*\([^)\n]*\)\s*$/, '');
  return lines.join('\n').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (!tagArg || !bodyPath) {
  fail('Usage: node scripts/validate-release-pr-body.cjs <vX.Y.Z> <pr-body-file> [CHANGELOG.md]');
}

const tag = tagArg.startsWith('v') ? tagArg : `v${tagArg}`;
const body = normalize(fs.readFileSync(bodyPath, 'utf8'));
const changelog = normalize(fs.readFileSync(changelogPath, 'utf8'));

if (body.length < 10) {
  fail('PR description is too short or empty. Please provide release notes from CHANGELOG.md.');
}

const escapedTag = escapeRegExp(tag);
const headerPattern = new RegExp(`^##\\s+(?:\\[${escapedTag}\\]|${escapedTag})(?:\\s*\\([^\\n]*\\))?\\s*$`, 'm');
const headerMatch = headerPattern.exec(changelog);

if (!headerMatch) {
  fail(`CHANGELOG.md does not contain a header for ${tag} (expected '## [${tag}]' or '## ${tag}')`);
}

const entryStart = headerMatch.index;
const afterHeader = entryStart + headerMatch[0].length;
const nextHeaderOffset = changelog.slice(afterHeader).search(/^##\s+/m);
const entryEnd = nextHeaderOffset === -1 ? changelog.length : afterHeader + nextHeaderOffset;
const changelogEntry = changelog.slice(entryStart, entryEnd).trim();
const changelogEntryWithoutHeaderDate = withoutHeaderDate(changelogEntry);

const acceptedEntries = Array.from(new Set([changelogEntry, changelogEntryWithoutHeaderDate]));
const matchesEntryBoundary = acceptedEntries.some((entry) => {
  const startsWithEntry = body === entry || body.startsWith(`${entry}\n`);
  const endsWithEntry = body === entry || body.endsWith(`\n${entry}`);
  return startsWithEntry || endsWithEntry;
});

if (!matchesEntryBoundary) {
  fail(`PR description must start or end with the CHANGELOG.md entry for ${tag}. The release heading date may be omitted from the PR body, but the rest of the changelog block must match.`);
}

console.log(`PR description includes the CHANGELOG.md entry for ${tag}.`);
