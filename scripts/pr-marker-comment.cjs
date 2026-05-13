const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const args = process.argv.slice(2);
const mode = args.shift();

function option(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function warn(message) {
  console.warn(`::warning title=PR marker comment skipped::${message}`);
}

function ghApi(apiArgs) {
  return execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8' }).trim();
}

function readBody(path, label) {
  if (!path) throw new Error(`Missing --${label}`);
  return fs.readFileSync(path, 'utf8');
}

if (!['upsert', 'resolve'].includes(mode ?? '')) {
  console.error('Usage: node scripts/pr-marker-comment.cjs <upsert|resolve> --repo OWNER/REPO --pr NUMBER --marker MARKER --body-file FILE [--stale-body-file FILE]');
  process.exit(2);
}

const repo = option('repo');
const prNumber = option('pr');
const marker = option('marker');
const bodyFile = option('body-file');
const staleBodyFile = option('stale-body-file');

if (!repo || !prNumber || !marker || !bodyFile) {
  console.error('Missing required options: --repo, --pr, --marker, --body-file');
  process.exit(2);
}

let comments = [];
try {
  const raw = ghApi([`repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp']);
  comments = JSON.parse(raw).flat();
} catch (error) {
  warn(`Could not list existing PR comments for marker ${marker}: ${error.message}`);
}

const activeComments = comments.filter((comment) => {
  const body = comment.body ?? '';
  return body.includes(marker) &&
    !body.includes('<!-- status:resolved -->') &&
    !body.includes('<!-- status:stale -->');
});

const activeComment = activeComments.at(-1);
const staleComments = activeComments.slice(0, -1);

if (staleComments.length > 0 && staleBodyFile) {
  const staleBody = readBody(staleBodyFile, 'stale-body-file');
  for (const comment of staleComments) {
    try {
      ghApi(['-X', 'PATCH', `repos/${repo}/issues/comments/${comment.id}`, '-f', `body=${staleBody}`]);
    } catch (error) {
      warn(`Could not mark stale PR comment ${comment.id}: ${error.message}`);
    }
  }
}

const body = readBody(bodyFile, 'body-file');

try {
  if (mode === 'resolve') {
    if (activeComment) {
      ghApi(['-X', 'PATCH', `repos/${repo}/issues/comments/${activeComment.id}`, '-f', `body=${body}`]);
    }
  } else if (activeComment) {
    ghApi(['-X', 'PATCH', `repos/${repo}/issues/comments/${activeComment.id}`, '-f', `body=${body}`]);
  } else {
    ghApi(['-X', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '-f', `body=${body}`]);
  }
} catch (error) {
  const action = mode === 'resolve' ? 'update' : activeComment ? 'update' : 'create';
  warn(`Could not ${action} PR comment for marker ${marker}: ${error.message}`);
}
