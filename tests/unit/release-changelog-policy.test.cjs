const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  analyzeChangelogSections,
  extractChangelogEntry,
  extractMajorReleaseName,
  releaseBump,
} = require('../../scripts/release-changelog-policy.cjs');

function entryFor(sections, options = {}) {
  const releaseNameSection = options.releaseName ? [`### ${options.releaseName}`, ''] : [];
  const releaseNameLabel = options.releaseLabel ? [options.releaseLabel, ''] : [];
  return [
    '## [v2.0.0]',
    '',
    ...releaseNameSection,
    ...releaseNameLabel,
    ...sections.flatMap((section) => [`### ${section}`, '- Fixture item.', '']),
  ].join('\n');
}

function policyIssue(bump, sections, options = {}) {
  return analyzeChangelogSections({
    bump,
    tag: 'v2.0.0',
    entry: entryFor(sections, options),
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
    assert.equal(policyIssue('patch', ['Performance']), null);
    assert.equal(policyIssue('patch', ['Developer Experience']), null);
    assert.equal(policyIssue('patch', ['Documentation']), null);
    assert.equal(policyIssue('patch', ['Cleanup']), null);
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
    assert.match(policyIssue('minor', ['Performance']), /Minor releases must include/);
    assert.match(policyIssue('minor', ['Documentation']), /Minor releases must include/);
    assert.match(policyIssue('minor', ['Cleanup']), /Minor releases must include/);
  });

  it('requires Breaking only for major releases', () => {
    assert.equal(policyIssue('major', ['Breaking']), null);
    assert.equal(policyIssue('major', ['Breaking'], { releaseName: 'The "Fixture" Update' }), null);
    assert.match(policyIssue('major', ['Added']), /Major releases must include/);
    assert.match(policyIssue('minor', ['Breaking']), /requires a major release/);
    assert.match(policyIssue('patch', ['Breaking']), /requires a major release/);
  });

  it('treats release names as major-release metadata', () => {
    assert.equal(policyIssue('major', ['Breaking'], { releaseLabel: '_"Fixture" release._' }), null);
    assert.match(policyIssue('minor', ['Added'], { releaseName: 'The "Fixture" Update' }), /reserved for major releases/);
    assert.match(policyIssue('patch', ['Fixed'], { releaseLabel: '_"Fixture" release._' }), /reserved for major releases/);
    assert.match(
      policyIssue('major', ['Breaking'], {
        releaseName: 'The "Fixture" Update',
        releaseLabel: '_"Fixture" release._',
      }),
      /only one release name/
    );
  });

  it('extracts major release names from heading and label formats', () => {
    assert.equal(
      extractMajorReleaseName(entryFor(['Breaking'], { releaseName: 'The "Divide & Conquer" Update' })),
      'Divide & Conquer'
    );
    assert.equal(
      extractMajorReleaseName(entryFor(['Breaking'], { releaseLabel: '_"Mental Gymnastics" release._' })),
      'Mental Gymnastics'
    );
    assert.equal(extractMajorReleaseName(entryFor(['Fixed'])), null);
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

describe('release metadata validation', () => {
  function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function writeFixtureFile(root, file, content) {
    const fullPath = path.join(root, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  function createReleaseRepo() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-metadata-check-'));
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test User']);

    writeFixtureFile(tmpDir, 'package.json', JSON.stringify({ version: '1.2.3' }, null, 2));
    writeFixtureFile(tmpDir, 'package-lock.json', JSON.stringify({
      version: '1.2.3',
      packages: { '': { version: '1.2.3' } },
    }, null, 2));
    writeFixtureFile(tmpDir, 'CHANGELOG.md', [
      '# Changelog',
      '',
      '## v1.2.3',
      '',
      '### Fixed',
      '- Previous fixture.',
    ].join('\n'));
    writeFixtureFile(tmpDir, 'ARCHITECTURE.md', '# Architecture\n');
    writeFixtureFile(tmpDir, 'docs/public-api.md', '# Public API\n');
    writeFixtureFile(tmpDir, 'docs/search-engine.md', '# Search Engine\n');
    writeFixtureFile(tmpDir, '.github/workflows/dev-test.yml', 'name: Dev Test\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'initial']);
    git(tmpDir, ['tag', 'v1.2.3']);
    git(tmpDir, ['branch', 'base']);
    return tmpDir;
  }

  function writeMajorReleaseMetadata(root, { updatePublicApi = true } = {}) {
    writeFixtureFile(root, 'package.json', JSON.stringify({ version: '2.0.0' }, null, 2));
    writeFixtureFile(root, 'package-lock.json', JSON.stringify({
      version: '2.0.0',
      packages: { '': { version: '2.0.0' } },
    }, null, 2));
    writeFixtureFile(root, 'CHANGELOG.md', [
      '# Changelog',
      '',
      '## v2.0.0',
      '',
      '### The "Fixture" Update',
      '',
      '### Breaking',
      '- Fixture breaking change.',
      '',
      '## v1.2.3',
      '',
      '### Fixed',
      '- Previous fixture.',
    ].join('\n'));
    writeFixtureFile(root, 'ARCHITECTURE.md', '# Architecture\n\nReviewed for v2.0.0.\n');
    writeFixtureFile(root, 'docs/search-engine.md', '# Search Engine\n\nReviewed for v2.0.0.\n');
    if (updatePublicApi) {
      writeFixtureFile(root, 'docs/public-api.md', '# Public API\n\nReviewed for v2.0.0.\n');
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'chore(release): prepare v2.0.0']);
  }

  function writeCiPolicyChange(root, { mixedProductChange = false } = {}) {
    writeFixtureFile(root, '.github/workflows/dev-test.yml', [
      'name: Dev Test',
      '',
      'on:',
      '  pull_request:',
      '',
    ].join('\n'));
    if (mixedProductChange) {
      writeFixtureFile(root, 'src/lib/example.ts', 'export const mixedProductChange = true;\n');
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'ci: refine release policy checks']);
  }

  function writePatchReleaseMetadata(root) {
    writeFixtureFile(root, 'package.json', JSON.stringify({ version: '1.2.4' }, null, 2));
    writeFixtureFile(root, 'package-lock.json', JSON.stringify({
      version: '1.2.4',
      packages: { '': { version: '1.2.4' } },
    }, null, 2));
    writeFixtureFile(root, 'CHANGELOG.md', [
      '# Changelog',
      '',
      '## v1.2.4',
      '',
      '### Developer Experience',
      '- Fixture CI policy change.',
      '',
      '## v1.2.3',
      '',
      '### Fixed',
      '- Previous fixture.',
    ].join('\n'));
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'chore(release): prepare v1.2.4']);
  }

  it('allows major release names and release docs in final metadata commits', () => {
    const tmpDir = createReleaseRepo();
    const scriptPath = path.resolve(__dirname, '../../scripts/validate-release-head-commit.cjs');

    writeMajorReleaseMetadata(tmpDir);

    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [scriptPath, 'v2.0.0', 'HEAD', 'base'], { cwd: tmpDir, stdio: 'pipe' });
    });
  });

  it('requires public API docs somewhere in minor and major release branches', () => {
    const tmpDir = createReleaseRepo();
    const scriptPath = path.resolve(__dirname, '../../scripts/validate-release-head-commit.cjs');

    writeMajorReleaseMetadata(tmpDir, { updatePublicApi: false });

    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, 'v2.0.0', 'HEAD', 'base'], { cwd: tmpDir, stdio: 'pipe' }),
      /docs\/public-api\.md/
    );
  });

  it('allows isolated CI policy release branches', () => {
    const tmpDir = createReleaseRepo();
    const scriptPath = path.resolve(__dirname, '../../scripts/validate-release-head-commit.cjs');

    writeCiPolicyChange(tmpDir);
    writePatchReleaseMetadata(tmpDir);

    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [scriptPath, 'v1.2.4', 'HEAD', 'base'], { cwd: tmpDir, stdio: 'pipe' });
    });
  });

  it('rejects release branches that mix CI policy changes with product changes', () => {
    const tmpDir = createReleaseRepo();
    const scriptPath = path.resolve(__dirname, '../../scripts/validate-release-head-commit.cjs');

    writeCiPolicyChange(tmpDir, { mixedProductChange: true });
    writePatchReleaseMetadata(tmpDir);

    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, 'v1.2.4', 'HEAD', 'base'], { cwd: tmpDir, stdio: 'pipe' }),
      /CI-sensitive release changes must be isolated/
    );
  });
});

describe('snapshot commit isolation validation', () => {
  function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function writeFixtureFile(root, file, content) {
    const fullPath = path.join(root, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  function createSnapshotCommitRepo() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-commit-check-'));
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test User']);

    writeFixtureFile(tmpDir, 'README.md', '# fixture\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'initial']);
    git(tmpDir, ['branch', 'base']);
    return tmpDir;
  }

  it('accepts dedicated snapshot commits', () => {
    const tmpDir = createSnapshotCommitRepo();
    const scriptPath = path.resolve(__dirname, '../../scripts/validate-snapshot-commits.cjs');

    writeFixtureFile(tmpDir, 'tests/snapshots/example.json', '{"ok":true}\n');
    writeFixtureFile(tmpDir, 'tests/snapshots/example.human.json', '{"ok":"human"}\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'Update snapshots']);

    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [scriptPath, 'base', 'HEAD'], { cwd: tmpDir });
    });
  });

  it('rejects commits that mix snapshots with other files', () => {
    const tmpDir = createSnapshotCommitRepo();
    const scriptPath = path.resolve(__dirname, '../../scripts/validate-snapshot-commits.cjs');

    writeFixtureFile(tmpDir, 'tests/snapshots/example.json', '{"ok":true}\n');
    writeFixtureFile(tmpDir, 'src/lib/example.ts', 'export const fixture = true;\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'Mix code and snapshots']);

    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, 'base', 'HEAD'], { cwd: tmpDir, stdio: 'pipe' }),
      /Snapshot updates must be isolated/
    );
  });
});
