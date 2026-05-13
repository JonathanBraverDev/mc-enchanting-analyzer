const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  analyzeChangelogSections,
  extractChangelogEntry,
  releaseBump,
} = require('../../scripts/release-changelog-policy.cjs');

function entryFor(sections) {
  return [
    '## [v2.0.0]',
    '',
    ...sections.flatMap((section) => [`### ${section}`, '- Fixture item.', '']),
  ].join('\n');
}

function policyIssue(bump, sections) {
  return analyzeChangelogSections({
    bump,
    tag: 'v2.0.0',
    entry: entryFor(sections),
  }).issue?.validatorMessage ?? null;
}

describe('release changelog section policy', () => {
  it('classifies semantic version jumps', () => {
    assert.equal(releaseBump('v1.2.3', 'v1.2.4'), 'patch');
    assert.equal(releaseBump('v1.2.3', 'v1.3.0'), 'minor');
    assert.equal(releaseBump('v1.2.3', 'v2.0.0'), 'major');
    assert.equal(releaseBump('', 'v2.0.0'), 'unknown');
  });

  it('extracts bracketed and dated release entries', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [v2.0.0] (2026-05-13)',
      '### Breaking',
      '- Fixture item.',
      '',
      '## [v1.2.3]',
      '### Fixed',
      '- Older item.',
    ].join('\n');

    assert.match(extractChangelogEntry(changelog, 'v2.0.0'), /### Breaking/);
    assert.doesNotMatch(extractChangelogEntry(changelog, 'v2.0.0'), /Older item/);
  });

  it('accepts patch-scope sections for patch releases', () => {
    assert.equal(policyIssue('patch', ['Fixed']), null);
    assert.equal(policyIssue('patch', ['Security']), null);
    assert.equal(policyIssue('patch', ['Developer Experience']), null);
  });

  it('rejects minor-or-larger sections for patch releases', () => {
    for (const section of ['Added', 'Improved', 'Changed', 'Deprecated', 'Removed']) {
      assert.match(policyIssue('patch', [section]), /Patch releases should not include/);
    }
  });

  it('accepts minor-scope sections for minor releases', () => {
    for (const section of ['Added', 'Improved', 'Changed', 'Developer Experience', 'Deprecated']) {
      assert.equal(policyIssue('minor', [section]), null);
    }
  });

  it('rejects patch-only minor releases', () => {
    assert.match(policyIssue('minor', ['Fixed']), /Minor releases must include/);
    assert.match(policyIssue('minor', ['Security']), /Minor releases must include/);
  });

  it('requires Breaking only for major releases', () => {
    assert.equal(policyIssue('major', ['Breaking']), null);
    assert.match(policyIssue('major', ['Added']), /Major releases must include/);
    assert.match(policyIssue('minor', ['Breaking']), /requires a major release/);
    assert.match(policyIssue('patch', ['Breaking']), /requires a major release/);
  });

  it('rejects empty or unknown sections', () => {
    assert.match(policyIssue('patch', []), /must include at least one/);
    assert.match(policyIssue('minor', ['Tweaked']), /unknown section/);
  });
});

describe('release PR body validation', () => {
  it('accepts release notes without the changelog version heading', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pr-body-'));
    const changelogPath = path.join(tmpDir, 'CHANGELOG.md');
    const bodyPath = path.join(tmpDir, 'body.md');

    fs.writeFileSync(changelogPath, [
      '# Changelog',
      '',
      '## v2.0.0 (2026-05-13)',
      '',
      '### Security',
      '- Fixture hardening.',
      '',
      '### Developer Experience',
      '- Fixture workflow note.',
      '',
      '## v1.9.9',
      '',
      '### Fixed',
      '- Older item.',
    ].join('\n'));

    fs.writeFileSync(bodyPath, [
      '### Security',
      '- Fixture hardening.',
      '',
      '### Developer Experience',
      '- Fixture workflow note.',
    ].join('\n'));

    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        ['scripts/validate-release-pr-body.cjs', 'v2.0.0', bodyPath, changelogPath],
        { cwd: path.resolve(__dirname, '../..') }
      );
    });
  });
});
