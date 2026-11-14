'use strict';

/**
 * Housekeeping gate: the repository should contain the engine, its specs, its tests and its docs, and
 * nothing else. Everything generated has a home that `.gitignore` covers, every script CI calls exists,
 * and every file that is tracked is either referenced by something or an acknowledged entry point.
 *
 * Run: `node scripts/check_housekeeping.js` (add `--quiet` for exit status only).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const repo = path.resolve(__dirname, '..', '..', '..');
const quiet = process.argv.includes('--quiet');
const problems = [];
const notes = [];

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function relative(file) {
  return file.split(path.sep).join('/');
}

// ── 1. every script package.json and the CI workflow call actually exists ─────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'pptx/native/package.json'), 'utf8'));
const workflowPath = path.join(repo, '.github/workflows/native-ppt.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const calledScripts = Array.from(new Set(Array.from(workflow.matchAll(/npm run ([\w:-]+)/gu), (match) => match[1])));
calledScripts.forEach((name) => {
  if (!pkg.scripts[name]) problems.push('CI runs `npm run ' + name + '`, which package.json does not define');
});
const referencedPaths = Array.from(new Set(Array.from(workflow.matchAll(/pptx\/[\w./-]+\.(?:js|py|pptx|json)/gu), (match) => match[0])));
referencedPaths.forEach((rel) => {
  if (!fs.existsSync(path.join(repo, rel)) && !pkg.scripts[rel]) {
    // decks are generated during the job; only source files have to exist before it starts
    if (!/\.(pptx)$/u.test(rel)) problems.push('CI references ' + rel + ', which is not in the repository');
  }
});

// ── 2. tracked junk: generated files that slipped into git, and references that point nowhere ─────
const tracked = git(['ls-files']).split('\n').filter(Boolean);
// Decks, PDFs and bytecode are output by definition. A photograph that a spec loads is input, so an
// image is only a problem when it sits in a directory the renderers write into.
const binaryOrGenerated = tracked.filter((file) => /\.(pptx|pdf|pyc)$/u.test(file) ||
  (/\.(png|jpg)$/u.test(file) && /(render-|preview\/|golden\/)/u.test(file)));
if (binaryOrGenerated.length) {
  problems.push('tracked binary output that belongs in .gitignore: ' + binaryOrGenerated.join(', '));
}
const imageWeight = tracked.filter((file) => /\.(png|jpg)$/u.test(file)).reduce((sum, file) => {
  try { return sum + fs.statSync(path.join(repo, file)).size; } catch { return sum; }
}, 0);
if (imageWeight > 5 * 1024 * 1024) {
  problems.push('tracked images total ' + (imageWeight / 1024 / 1024).toFixed(1) + ' MB; keep fixtures small');
}

// ── 3. untracked files that neither git nor .gitignore knows about (the real "junk" signal) ──────
const status = git(['status', '--porcelain', '--untracked-files=all']);
const stray = status.split('\n').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
stray.forEach((file) => problems.push('untracked and not ignored: ' + file));

// ── 4. tracked text files nobody mentions (allowlisted entry points are the exceptions) ──────────
const allowUnreferenced = new Set([
  '.gitignore', 'README.md', 'pptx/SKILL.md', 'pptx/native/package-lock.json',
  'pptx/native/index.js', 'pptx/native/cli.js', 'pptx/ooxml/scripts/validation/__init__.py',
  'pptx/ooxml/scripts/pack.py', 'pptx/ooxml/scripts/unpack.py', 'pptx/ooxml/scripts/validate.py',
  'pptx/native/scripts/check_housekeeping.js'
]);
const textFiles = tracked.filter((file) => /\.(md|js|json|py|yml|html|css)$/u.test(file) && fs.existsSync(path.join(repo, file)));
const contents = new Map(textFiles.map((file) => [file, fs.readFileSync(path.join(repo, file), 'utf8')]));
const orphans = [];
textFiles.forEach((file) => {
  // pptx/ooxml/ is the upstream OOXML validator, copied in whole; it imports its own modules.
  if (allowUnreferenced.has(file) || file.startsWith('pptx/tests/') || file.startsWith('pptx/ooxml/')) return;
  const base = path.basename(file);
  const stem = base.replace(/\.[^.]+$/u, '');
  const mentioned = Array.from(contents.entries()).some(([other, text]) => other !== file &&
    (text.includes(base) || (stem.length >= 3 && text.includes(stem))));
  if (!mentioned) orphans.push(file);
});
if (orphans.length) problems.push('tracked files nothing refers to: ' + orphans.join(', '));

// ── 5. informational: what is on disk but deliberately not in git ────────────────────────────────
const ignored = git(['status', '--porcelain', '--ignored=matching']).split('\n')
  .filter((line) => line.startsWith('!! ')).map((line) => line.slice(3)).filter((line) => line !== 'pptx/native/node_modules/');
let ignoredBytes = 0;
ignored.forEach((rel) => {
  const full = path.join(repo, rel);
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const stack = [full];
      while (stack.length) {
        const current = stack.pop();
        fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
          const next = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(next);
          else ignoredBytes += fs.statSync(next).size;
        });
      }
    } else {
      ignoredBytes += stat.size;
    }
  } catch { /* a broken ignored path is not a gate failure */ }
});

if (!quiet) {
  console.log('tracked files:   ' + tracked.length + ' (' + (tracked.reduce((sum, file) => {
    try { return sum + fs.statSync(path.join(repo, file)).size; } catch { return sum; }
  }, 0) / 1024 / 1024).toFixed(2) + ' MB)');
  console.log('generated, kept out of git: ' + ignored.length + ' path(s), ' + (ignoredBytes / 1024 / 1024).toFixed(1) + ' MB');
  ignored.sort().forEach((rel) => { if (!rel.endsWith('/')) notes.push('ignored  ' + rel); });
  notes.forEach((line) => console.log('  ' + line));
  if (problems.length) {
    console.log('\n' + problems.length + ' housekeeping problem(s):');
    problems.forEach((problem) => console.log('  - ' + problem));
  } else {
    console.log('\nhousekeeping clean: no stray file, no dead reference, no missing CI script');
  }
}

process.exit(problems.length ? 1 : 0);
