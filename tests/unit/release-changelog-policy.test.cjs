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
const {
  classifyCiChanges,
  hasCiChanges,
} = require('../../scripts/classify-ci-changes.cjs');
const {
  classifySnapshotChanges,
  formatMarkdown: formatSnapshotMarkdown,
  hasSnapshotChanges,
} = require('../../scripts/classify-snapshot-changes.cjs');

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

  it('allows release branches that mix CI policy changes with product changes', () => {
    const tmpDir = createReleaseRepo();
    const scriptPath = path.resolve(__dirname, '../../scripts/validate-release-head-commit.cjs');

    writeCiPolicyChange(tmpDir, { mixedProductChange: true });
    writePatchReleaseMetadata(tmpDir);

    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [scriptPath, 'v1.2.4', 'HEAD', 'base'], { cwd: tmpDir, stdio: 'pipe' });
    });
  });
});

describe('CI change advisory classification', () => {
  function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function writeFixtureFile(root, file, content) {
    const fullPath = path.join(root, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  function writePackage(root, packageJson = {}) {
    const { scripts = {}, ...packageFields } = packageJson;
    writeFixtureFile(root, 'package.json', `${JSON.stringify({
      name: 'ci-advisory-fixture',
      version: '1.0.0',
      ...packageFields,
      scripts: {
        build: 'vite build',
        lint: 'eslint .',
        'lint:imports': 'node scripts/lint-imports.cjs',
        'test:release-policy': 'node --test tests/unit/release-changelog-policy.test.cjs',
        ...scripts,
      },
    }, null, 2)}\n`);
  }

  function createCiAdvisoryRepo() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-advisory-check-'));
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test User']);

    writePackage(tmpDir);
    writeFixtureFile(tmpDir, '.github/workflows/dev-test.yml', [
      'name: Dev Test',
      '',
      'on:',
      '  pull_request:',
      '',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm run lint',
      '      - run: npm run lint:imports',
      '      - run: npm run test:release-policy',
      '      - run: npm run build',
      '',
    ].join('\n'));
    writeFixtureFile(tmpDir, 'scripts/lint-imports.cjs', 'console.log("lint imports");\n');
    writeFixtureFile(tmpDir, 'tests/unit/release-changelog-policy.test.cjs', 'console.log("release policy");\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'initial']);
    git(tmpDir, ['branch', 'base']);
    return tmpDir;
  }

  function classify(root) {
    return classifyCiChanges({ baseRef: 'base', headRef: 'HEAD', cwd: root });
  }

  it('reports workflow-called build script changes', () => {
    const tmpDir = createCiAdvisoryRepo();

    writePackage(tmpDir, { scripts: { build: 'vite build --mode production' } });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'change build script']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), true);
    assert.deepEqual(classification.packageScripts.map((script) => script.name), ['build']);
  });

  it('reports transitive workflow-called package script additions', () => {
    const tmpDir = createCiAdvisoryRepo();

    writePackage(tmpDir, {
      scripts: {
        build: 'npm run build:types && vite build',
        'build:types': 'tsc -p tsconfig.api.json',
      },
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'add type build']);

    const classification = classify(tmpDir);
    assert.deepEqual(classification.packageScripts.map((script) => script.name), ['build', 'build:types']);
  });

  it('ignores package scripts that workflows do not call', () => {
    const tmpDir = createCiAdvisoryRepo();

    writePackage(tmpDir, {
      scripts: {
        cli: 'node src/cli/index.js',
        'test:public': 'node --test tests/public/*.test.cjs',
      },
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'add public scripts']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), false);
    assert.deepEqual(classification.packageScripts, []);
  });

  it('reports workflow file changes', () => {
    const tmpDir = createCiAdvisoryRepo();
    const bodyPath = path.join(tmpDir, 'advisory.md');
    const scriptPath = path.resolve(__dirname, '../../scripts/classify-ci-changes.cjs');

    writeFixtureFile(tmpDir, '.github/workflows/dev-test.yml', [
      'name: Dev Test',
      '',
      'on:',
      '  pull_request:',
      '  push:',
      '',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm run lint',
      '      - run: npm run lint:imports',
      '      - run: npm run test:release-policy',
      '      - run: npm run build',
      '',
    ].join('\n'));
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'change workflow']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), true);
    assert.deepEqual(classification.workflowFiles, ['.github/workflows/dev-test.yml']);
    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, 'base', 'HEAD', '--body-file', bodyPath], {
        cwd: tmpDir,
        stdio: 'pipe',
      }),
      { status: 1 }
    );

    assert.deepEqual(classification.workflowBehaviorChanges.map((change) => ({
      file: change.file,
      status: change.status,
      changedCategories: change.changedCategories,
    })), [
      {
        file: '.github/workflows/dev-test.yml',
        status: 'M',
        changedCategories: ['triggers'],
      },
    ]);

    const advisoryBody = fs.readFileSync(bodyPath, 'utf8');
    assert.match(advisoryBody, /Workflow behavior summary/);
    assert.match(advisoryBody, /Changed behavior categories: `triggers`/);
    assert.match(advisoryBody, /Before triggers:/);
    assert.match(advisoryBody, /After triggers:/);
    assert.match(advisoryBody, /pull_request:/);
    assert.match(advisoryBody, /push:/);
    assert.doesNotMatch(advisoryBody, /Critical existing workflow setting changes:/);
  });

  it('summarizes newly added workflow behavior instead of showing critical line excerpts', () => {
    const tmpDir = createCiAdvisoryRepo();
    const bodyPath = path.join(tmpDir, 'advisory.md');
    const scriptPath = path.resolve(__dirname, '../../scripts/classify-ci-changes.cjs');

    writeFixtureFile(tmpDir, '.github/workflows/snapshot-advisory.yml', [
      'name: Snapshot Advisory',
      '',
      'on:',
      '  pull_request_target:',
      '    branches:',
      '      - main',
      '',
      'permissions:',
      '  contents: read',
      '  pull-requests: write',
      '',
      'concurrency:',
      '  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      '',
      'jobs:',
      '  snapshot-advisory:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          ref: ${{ github.event.pull_request.base.ref }}',
      '          persist-credentials: false',
      '      - run: node scripts/classify-snapshot-changes.cjs origin/main HEAD',
      '',
    ].join('\n'));
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'add snapshot advisory workflow']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), true);
    assert.deepEqual(classification.workflowFileChanges, [
      { file: '.github/workflows/snapshot-advisory.yml', status: 'A' },
    ]);
    assert.deepEqual(classification.workflowBehaviorChanges.map((change) => ({
      file: change.file,
      status: change.status,
      changedCategories: change.changedCategories,
    })), [
      {
        file: '.github/workflows/snapshot-advisory.yml',
        status: 'A',
        changedCategories: ['triggers', 'permissions', 'concurrency', 'jobs', 'checkoutTargets', 'invocations'],
      },
    ]);
    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, 'base', 'HEAD', '--body-file', bodyPath], {
        cwd: tmpDir,
        stdio: 'pipe',
      }),
      { status: 1 }
    );

    const advisoryBody = fs.readFileSync(bodyPath, 'utf8');
    assert.match(advisoryBody, /Workflow behavior summary/);
    assert.match(advisoryBody, /`\.github\/workflows\/snapshot-advisory\.yml` \(added\)/);
    assert.match(advisoryBody, /New workflow behavior:/);
    assert.match(advisoryBody, /pull_request_target:/);
    assert.match(advisoryBody, /branches:/);
    assert.match(advisoryBody, /contents: read/);
    assert.match(advisoryBody, /pull-requests: write/);
    assert.match(advisoryBody, /Checkout targets:/);
    assert.match(advisoryBody, /ref `\$\{\{ github\.event\.pull_request\.base\.ref \}\}`/);
    assert.match(advisoryBody, /persist-credentials `false`/);
    assert.match(advisoryBody, /CI entrypoints:/);
    assert.match(advisoryBody, /`node scripts\/classify-snapshot-changes\.cjs`/);
    assert.doesNotMatch(advisoryBody, /Critical existing workflow setting changes:/);
    assert.doesNotMatch(advisoryBody, /```diff/);
  });

  it('shows job-level permissions when workflow permissions move there', () => {
    const tmpDir = createCiAdvisoryRepo();
    const bodyPath = path.join(tmpDir, 'advisory.md');
    const scriptPath = path.resolve(__dirname, '../../scripts/classify-ci-changes.cjs');

    writeFixtureFile(tmpDir, '.github/workflows/dev-test.yml', [
      'name: Dev Test',
      '',
      'on:',
      '  pull_request_target:',
      '',
      'permissions:',
      '  contents: read',
      '',
      'jobs:',
      '  test:',
      '    permissions:',
      '      contents: read',
      '      pull-requests: write',
      '      issues: write',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm run lint',
      '',
    ].join('\n'));
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'move permissions to job']);

    const classification = classify(tmpDir);
    assert.deepEqual(new Set(classification.workflowBehaviorChanges[0].changedCategories), new Set(['triggers', 'permissions', 'jobs', 'invocations']));
    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, 'base', 'HEAD', '--body-file', bodyPath], {
        cwd: tmpDir,
        stdio: 'pipe',
      }),
      { status: 1 }
    );

    const advisoryBody = fs.readFileSync(bodyPath, 'utf8');
    assert.match(advisoryBody, /After jobs:/);
    assert.match(advisoryBody, /permissions `contents: read, pull-requests: write, issues: write`/);
  });

  it('reports direct CI support script changes', () => {
    const tmpDir = createCiAdvisoryRepo();
    const bodyPath = path.join(tmpDir, 'advisory.md');
    const scriptPath = path.resolve(__dirname, '../../scripts/classify-ci-changes.cjs');

    writeFixtureFile(tmpDir, 'scripts/validate-release-head-commit.cjs', 'console.log("release validator");\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'change release validator']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), true);
    assert.deepEqual(classification.supportScripts, ['scripts/validate-release-head-commit.cjs']);
    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, 'base', 'HEAD', '--body-file', bodyPath], {
        cwd: tmpDir,
        stdio: 'pipe',
      }),
      { status: 1 }
    );

    const advisoryBody = fs.readFileSync(bodyPath, 'utf8');
    assert.doesNotMatch(advisoryBody, /```diff/);
  });

  it('ignores package metadata-only changes', () => {
    const tmpDir = createCiAdvisoryRepo();

    writePackage(tmpDir, {
      version: '1.0.1',
      bin: { 'ci-advisory-fixture': './bin/fixture.js' },
      files: ['dist'],
      exports: { '.': './dist/index.js' },
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'change package metadata']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), false);
    assert.deepEqual(classification.packageScripts, []);
  });

  it('reports scripts once CI files start calling them', () => {
    const tmpDir = createCiAdvisoryRepo();

    writePackage(tmpDir, {
      scripts: {
        'test:public': 'node --test tests/public/*.test.cjs',
      },
    });
    writeFixtureFile(tmpDir, '.github/workflows/dev-test.yml', [
      'name: Dev Test',
      '',
      'on:',
      '  pull_request:',
      '',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm run lint',
      '      - run: npm run lint:imports',
      '      - run: npm run test:release-policy',
      '      - run: npm run build',
      '      - run: npm run test:public',
      '',
    ].join('\n'));
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'call public tests from ci']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), true);
    assert.deepEqual(classification.packageScripts.map((script) => script.name), ['test:public']);
    assert.deepEqual(classification.workflowFiles, ['.github/workflows/dev-test.yml']);
  });

  it('reports changed files executed by workflow-called package scripts', () => {
    const tmpDir = createCiAdvisoryRepo();

    writePackage(tmpDir, {
      scripts: {
        build: 'npm run build:js',
        'build:js': 'node scripts/build.js',
      },
    });
    writeFixtureFile(tmpDir, 'scripts/build.js', 'console.log("build");\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'add build script']);
    git(tmpDir, ['branch', '-f', 'base', 'HEAD']);

    writeFixtureFile(tmpDir, 'scripts/build.js', 'console.log("build changed");\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'change build helper']);

    const classification = classify(tmpDir);
    assert.equal(hasCiChanges(classification), true);
    assert.deepEqual(classification.executedScriptFiles, ['scripts/build.js']);
  });
});

describe('advisory preview workflows', () => {
  function workflow(name) {
    return fs.readFileSync(path.resolve(__dirname, `../../.github/workflows/${name}`), 'utf8');
  }

  function jobBlock(contents, jobName) {
    const start = contents.indexOf(`  ${jobName}:`);
    assert.notEqual(start, -1, `missing workflow job ${jobName}`);
    const rest = contents.slice(start + 1);
    const next = rest.search(/\n  [a-zA-Z0-9_-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('keeps trusted advisory jobs comment-writing and base-authored', () => {
    for (const file of ['ci-change-advisory.yml', 'snapshot-advisory.yml']) {
      const contents = workflow(file);
      const trustedJob = file === 'ci-change-advisory.yml' ? 'ci-change-advisory' : 'snapshot-advisory';
      const block = jobBlock(contents, trustedJob);

      assert.match(contents, /pull_request_target:/);
      assert.doesNotMatch(contents, /^\s*pull_request:/m);
      assert.match(block, /pull-requests: write/);
      assert.match(block, /issues: write/);
      assert.match(block, /scripts\/pr-marker-comment\.cjs/);
      assert.match(block, /github\.event\.pull_request\.base\.ref/);
      assert.match(block, /if \[ "\$advisory_status" -eq 0 \]/);
      assert.match(block, /resolve_active_comment/);
      assert.match(block, /exit 0/);
    }
  });

  it('keeps branch-authored advisory previews read-only and summary-only', () => {
    for (const file of ['ci-change-advisory-preview.yml', 'snapshot-advisory-preview.yml']) {
      const contents = workflow(file);
      const previewJob = file === 'ci-change-advisory-preview.yml'
        ? 'ci-change-advisory-preview'
        : 'snapshot-advisory-preview';
      const block = jobBlock(contents, previewJob);

      assert.match(contents, /pull_request:/);
      assert.doesNotMatch(contents, /pull_request_target:/);
      assert.match(block, /contents: read/);
      assert.match(block, /GITHUB_STEP_SUMMARY/);
      assert.match(block, /Branch-authored preview/);
      assert.doesNotMatch(block, /pull-requests: write/);
      assert.doesNotMatch(block, /issues: write/);
      assert.doesNotMatch(block, /scripts\/pr-marker-comment\.cjs/);
      assert.match(block, /if \[ "\$advisory_status" -eq 0 \]/);
      assert.match(block, /exit 0/);
    }
  });
});

describe('snapshot advisory classification', () => {
  function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function writeFixtureFile(root, file, content) {
    const fullPath = path.join(root, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  function writeSnapshot(root, file, snapshot) {
    writeFixtureFile(root, file, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  function createSnapshotAdvisoryRepo() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-advisory-check-'));
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test User']);

    writeSnapshot(tmpDir, 'tests/snapshots/example.json', {
      ranks: { sharpness: { 1: 0.5 } },
      any: { sharpness: 0.5 },
      count: { 1: 1 },
      combos: {
        'sharpness:1': 0.5,
        'smite:1': 0.25,
      },
      accuracy: 0.75,
      accounting: { resolved: 0.75 },
    });
    writeSnapshot(tmpDir, 'tests/snapshots/example.human.json', {
      summary: 'fixture',
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'initial']);
    git(tmpDir, ['branch', 'base']);
    return tmpDir;
  }

  it('summarizes added and modified snapshot outputs', () => {
    const tmpDir = createSnapshotAdvisoryRepo();

    writeSnapshot(tmpDir, 'tests/snapshots/example.json', {
      ranks: { sharpness: { 1: 0.6 } },
      any: { sharpness: 0.6 },
      count: { 1: 1 },
      combos: {
        'sharpness:1': 0.6,
        'looting:1': 0.1,
      },
      accuracy: 0.7,
      accounting: {
        resolved: 0.7,
        details: { stages: { search: { buckets: { resolved: { value: 0.7 } } } } },
      },
      diagnostics: { engine: { exitReason: 'empty' } },
    });
    writeSnapshot(tmpDir, 'tests/snapshots/example.human.json', {
      summary: 'fixture changed',
    });
    writeSnapshot(tmpDir, 'tests/snapshots/new-case.json', {
      ranks: { efficiency: { 1: 1 } },
      any: { efficiency: 1 },
      count: { 1: 1 },
      combos: { 'efficiency:1': 1 },
      accuracy: 1,
      accounting: {
        resolved: 1,
        details: { stages: { search: { buckets: { resolved: { value: 1 } } } } },
      },
      diagnostics: { engine: { exitReason: 'empty' } },
    });
    writeSnapshot(tmpDir, 'tests/snapshots/new-case.human.json', {
      summary: 'new fixture',
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'update snapshots']);

    const classification = classifySnapshotChanges({ baseRef: 'base', headRef: 'HEAD', cwd: tmpDir });
    assert.equal(hasSnapshotChanges(classification), true);
    assert.equal(classification.counts.raw, 2);
    assert.equal(classification.counts.human, 2);
    assert.equal(classification.counts.added, 1);
    assert.equal(classification.counts.modified, 1);
    assert.equal(classification.counts.diagnosticsAdded, 2);
    assert.equal(classification.counts.accountingDetailsAdded, 2);
    assert.equal(classification.counts.resultBearing, 1);
    assert.equal(classification.counts.fixtureAdded, 1);
    assert.equal(classification.counts.fixtureRemoved, 0);

    const example = classification.rawSnapshots.find((snapshot) => snapshot.id === 'example');
    assert.equal(example.reviewKind, 'result-bearing');
    assert.equal(example.comboCountBefore, 2);
    assert.equal(example.comboCountAfter, 2);
    assert.equal(example.comboKeysAdded, 1);
    assert.equal(example.comboKeysRemoved, 1);
    assert.equal(example.comboValuesChanged, 1);
    assert.deepEqual(example.signals.filter((signal) => [
      'accuracy changed',
      'combo keys changed',
      'combo mass moved',
      'distribution shifted',
      'accounting shifted',
      'diagnostics changed',
      'accounting details changed',
      'human snapshot changed',
    ].includes(signal)), [
      'accuracy changed',
      'combo keys changed',
      'combo mass moved',
      'distribution shifted',
      'accounting shifted',
      'diagnostics changed',
      'accounting details changed',
      'human snapshot changed',
    ]);
    assert.equal(example.distributions.some((distribution) => distribution.key === 'any'), true);
    assert.equal(example.accounting.topMovers[0].key, 'resolved');
    assert.match(example.diagnosticPathsKnownAdded.join('\n'), /diagnostics\.engine\.exitReason/);
    assert.match(example.accountingDetailPathsKnownAdded.join('\n'), /accounting\.details\.stages\.search\.buckets\.resolved\.value/);
    assert.deepEqual(example.unmappedPathsAdded, []);

    const newCase = classification.rawSnapshots.find((snapshot) => snapshot.id === 'new-case');
    assert.equal(newCase.reviewKind, 'fixture-added');
    assert.match(newCase.signals.join(', '), /new fixture/);
    assert.doesNotMatch(newCase.signals.join(', '), /combo keys changed/);

    const markdown = formatSnapshotMarkdown(classification);
    assert.match(markdown, /Snapshot outputs changed/);
    assert.match(markdown, /Raw snapshots changed: 2 \(1 added, 1 modified, 0 removed\)/);
    assert.match(markdown, /Diagnostics\/accounting detail fields added/);
    assert.match(markdown, /Comparable result changes: 1/);
    assert.match(markdown, /New\/removed snapshots: 1 added, 0 removed/);
    assert.match(markdown, /New Or Removed Snapshots/);
    assert.match(markdown, /Result Changes/);
    assert.match(markdown, /Instrumentation Additions/);
    assert.match(markdown, /Engine\/search diagnostics changed/);
    assert.match(markdown, /Accounting details changed/);
    assert.doesNotMatch(markdown, /diagnostics\.engine\.exitReason/);
    const resultSection = markdown.slice(markdown.indexOf('## Result Changes'), markdown.indexOf('## New Or Removed Snapshots'));
    const fixtureSection = markdown.slice(markdown.indexOf('## New Or Removed Snapshots'), markdown.indexOf('## Instrumentation Additions'));
    assert.equal(markdown.indexOf('## Result Changes') < markdown.indexOf('## New Or Removed Snapshots'), true);
    assert.match(fixtureSection, /`new-case`/);
    assert.match(fixtureSection, /\| Snapshot \| Status \| Accuracy \| Combos \| Review \|/);
    assert.doesNotMatch(fixtureSection, /combo keys changed/);
    assert.doesNotMatch(resultSection, /`new-case`/);
    assert.match(resultSection, /\| Snapshot \| Accuracy \| Combos \| Review \|/);
    assert.match(resultSection, /combo key set changed/);
    assert.doesNotMatch(resultSection, /combo keys \+1\/-1/);
  });

  it('reports same combo keys with mass movement separately from key churn', () => {
    const tmpDir = createSnapshotAdvisoryRepo();

    writeSnapshot(tmpDir, 'tests/snapshots/example.json', {
      ranks: { sharpness: { 1: 0.4 }, smite: { 1: 0.35 } },
      any: { sharpness: 0.4, smite: 0.35 },
      count: { 1: 0.5, 2: 0.25 },
      combos: {
        'sharpness:1': 0.4,
        'smite:1': 0.35,
      },
      accuracy: 0.75,
      accounting: { resolved: 0.75 },
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'move mass']);

    const classification = classifySnapshotChanges({ baseRef: 'base', headRef: 'HEAD', cwd: tmpDir });
    const example = classification.rawSnapshots.find((snapshot) => snapshot.id === 'example');

    assert.equal(example.comboKeysAdded, 0);
    assert.equal(example.comboKeysRemoved, 0);
    assert.equal(example.comboValuesChanged, 2);
    assert.match(example.signals.join(', '), /combo mass moved/);
    assert.doesNotMatch(example.signals.join(', '), /combo keys changed/);
  });

  it('lists removed snapshots as fixture changes instead of comparable result changes', () => {
    const tmpDir = createSnapshotAdvisoryRepo();

    fs.unlinkSync(path.join(tmpDir, 'tests/snapshots/example.json'));
    fs.unlinkSync(path.join(tmpDir, 'tests/snapshots/example.human.json'));
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'remove snapshot fixture']);

    const classification = classifySnapshotChanges({ baseRef: 'base', headRef: 'HEAD', cwd: tmpDir });
    const example = classification.rawSnapshots.find((snapshot) => snapshot.id === 'example');
    const markdown = formatSnapshotMarkdown(classification);

    assert.equal(classification.counts.resultBearing, 0);
    assert.equal(classification.counts.fixtureAdded, 0);
    assert.equal(classification.counts.fixtureRemoved, 1);
    assert.equal(example.reviewKind, 'fixture-removed');
    assert.match(example.signals.join(', '), /removed fixture/);
    assert.doesNotMatch(example.signals.join(', '), /combo keys changed/);
    assert.match(markdown, /New\/removed snapshots: 0 added, 1 removed/);
    assert.match(markdown, /New Or Removed Snapshots/);
    assert.doesNotMatch(markdown, /Result Changes/);
  });

  it('reports distribution shifts and accounting bucket shifts', () => {
    const tmpDir = createSnapshotAdvisoryRepo();

    writeSnapshot(tmpDir, 'tests/snapshots/example.json', {
      ranks: { sharpness: { 1: 0.5 } },
      any: { sharpness: 0.5 },
      count: { 1: 0.25, 3: 0.5 },
      combos: {
        'sharpness:1': 0.5,
        'smite:1': 0.25,
      },
      accuracy: 0.75,
      accounting: { resolved: 0.7, rounding: 0.05 },
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'shift buckets']);

    const classification = classifySnapshotChanges({ baseRef: 'base', headRef: 'HEAD', cwd: tmpDir });
    const example = classification.rawSnapshots.find((snapshot) => snapshot.id === 'example');
    const countDistribution = example.distributions.find((distribution) => distribution.key === 'count');
    const markdown = formatSnapshotMarkdown(classification);

    assert.equal(countDistribution.direction, 'higher');
    assert.match(example.signals.join(', '), /distribution shifted/);
    assert.match(example.signals.join(', '), /accounting shifted/);
    assert.deepEqual(example.accounting.topMovers.map((mover) => mover.key), ['resolved', 'rounding']);
    assert.match(markdown, /\| `example` \| stable \| stable \| .* \|/);
    assert.doesNotMatch(markdown, /0\.750000000000 -> 0\.750000000000/);
    assert.doesNotMatch(markdown, /2 -> 2 \(0\)/);
    assert.doesNotMatch(markdown, /movers:/);
  });

  it('reports invariant warnings without diagnosing the cause', () => {
    const tmpDir = createSnapshotAdvisoryRepo();

    writeSnapshot(tmpDir, 'tests/snapshots/example.json', {
      ranks: { sharpness: { 1: 0.5 } },
      any: { sharpness: 0.5 },
      count: { 1: 1 },
      combos: {
        'sharpness:1': 0.4,
        'smite:1': 0.2,
      },
      accuracy: 0.75,
      accounting: { resolved: 0.75, pending: 0.4 },
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'break invariant']);

    const classification = classifySnapshotChanges({ baseRef: 'base', headRef: 'HEAD', cwd: tmpDir });
    const example = classification.rawSnapshots.find((snapshot) => snapshot.id === 'example');
    const markdown = formatSnapshotMarkdown(classification);

    assert.match(example.signals.join(', '), /invariant warning/);
    assert.equal(example.invariantWarnings.length >= 1, true);
    assert.match(markdown, /Invariant Warnings/);
  });

  it('reports generic unknown snapshot paths', () => {
    const tmpDir = createSnapshotAdvisoryRepo();

    writeSnapshot(tmpDir, 'tests/snapshots/example.json', {
      ranks: { sharpness: { 1: 0.5 } },
      any: { sharpness: 0.5 },
      count: { 1: 1 },
      combos: {
        'sharpness:1': 0.5,
        'smite:1': 0.25,
      },
      accuracy: 0.75,
      accounting: { resolved: 0.75 },
      futureSurface: { nested: true },
    });
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-qm', 'add unknown path']);

    const classification = classifySnapshotChanges({ baseRef: 'base', headRef: 'HEAD', cwd: tmpDir });
    const example = classification.rawSnapshots.find((snapshot) => snapshot.id === 'example');
    const markdown = formatSnapshotMarkdown(classification);

    assert.deepEqual(example.unmappedPathsAdded, ['futureSurface']);
    assert.match(example.signals.join(', '), /new\/unmapped paths/);
    assert.match(markdown, /Unknown Paths/);
    assert.match(markdown, /futureSurface/);
  });

  it('reports no changes when snapshots are untouched', () => {
    const tmpDir = createSnapshotAdvisoryRepo();
    const classification = classifySnapshotChanges({ baseRef: 'base', headRef: 'HEAD', cwd: tmpDir });

    assert.equal(hasSnapshotChanges(classification), false);
    assert.equal(formatSnapshotMarkdown(classification), 'No snapshot files changed.\n');
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
