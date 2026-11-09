#!/usr/bin/env node
/**
 * A small static gate for this package: no new dependency, no network.
 *
 * The pipeline is plain CommonJS with a house style, and the rules below are the ones a
 * reviewer keeps repeating by hand. Each rule must be true of the code *and* cheap to check;
 * anything that needs type information belongs in the tests, not here.
 *
 * Usage: node scripts/lint_static.js [--quiet]
 *   --quiet  only print the summary (still exits non-zero on a violation)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'pipeline-converted', 'render-check', 'render-wps', 'preview',
  'golden', 'baselines', 'tests', '.git'
]);
/** Library code must not print to stdout: it reports through the deck's report. */
const LIBRARY_DIRECTORIES = ['pipeline', 'engine', 'core', 'components', 'templates'];
const MAX_LINE = 200;

function javascriptFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...javascriptFiles(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/**
 * A `/` starts a regular expression only where an operand is expected. After a value it is a
 * division, and treating it as a pattern would swallow the rest of the line.
 */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+',
  '-', '*', '%', '<', '>', '~', '^']);
function startsRegex(codeSoFar) {
  const trimmed = codeSoFar.replace(/\s+$/u, '');
  if (!trimmed) return true;
  return REGEX_AFTER.has(trimmed[trimmed.length - 1]) || trimmed.endsWith('return');
}

/**
 * Blank out string, comment and regex content while keeping every line break, so a rule can
 * look at code only. Quotes, escapes, template literals with `${}` nesting, both comment
 * forms, regex literals and their character classes are tracked; the one thing left out is a
 * regex *pattern* that itself looks like code, which cannot happen here.
 */
function stripStringsAndComments(source) {
  const out = [];
  // Frames, innermost last: a string, a comment, a regex, a regex character class, a
  // template, or the `${...}` expression inside one (which counts braces so the closing
  // brace that ends it is not mistaken for code).
  const stack = [];
  const top = () => stack[stack.length - 1];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    const frame = top();
    const blank = (keepNewline) => out.push(character === '\n' ? '\n' : ' ');
    if (frame && frame.kind === 'line-comment') {
      if (character === '\n') { stack.pop(); out.push(character); } else blank();
      continue;
    }
    if (frame && frame.kind === 'block-comment') {
      if (character === '*' && next === '/') { stack.pop(); out.push('  '); index += 1; continue; }
      blank();
      continue;
    }
    if (frame && (frame.kind === 'single' || frame.kind === 'double' || frame.kind === 'regex')) {
      const closer = frame.kind === 'single' ? "'" : (frame.kind === 'double' ? '"' : null);
      if (character === '\\') { out.push(' '); index += 1; blank(); continue; }
      if (frame.kind === 'regex' && character === '[') { stack.push({ kind: 'class' }); out.push(' '); continue; }
      if (closer && character === closer) { stack.pop(); out.push(' '); continue; }
      if (!closer && character === '/') { stack.pop(); out.push(' '); continue; }
      blank();
      continue;
    }
    if (frame && frame.kind === 'class') {
      if (character === '\\') { out.push(' '); index += 1; blank(); continue; }
      if (character === ']') { stack.pop(); out.push(' '); continue; }
      blank();
      continue;
    }
    if (frame && frame.kind === 'template') {
      if (character === '\\') { out.push(' '); index += 1; blank(); continue; }
      if (character === '`') { stack.pop(); out.push(' '); continue; }
      if (character === '$' && next === '{') { stack.push({ kind: 'template-expr', depth: 0 }); out.push('  '); index += 1; continue; }
      blank();
      continue;
    }
    // Code, or the expression inside a template.
    if (character === '/' && next === '/') { stack.push({ kind: 'line-comment' }); out.push('  '); index += 1; continue; }
    if (character === '/' && next === '*') { stack.push({ kind: 'block-comment' }); out.push('  '); index += 1; continue; }
    if (character === '/' && startsRegex(out.join(''))) { stack.push({ kind: 'regex' }); out.push(' '); continue; }
    if (character === "'") { stack.push({ kind: 'single' }); out.push(' '); continue; }
    if (character === '"') { stack.push({ kind: 'double' }); out.push(' '); continue; }
    if (character === '`') { stack.push({ kind: 'template' }); out.push(' '); continue; }
    if (frame && frame.kind === 'template-expr') {
      if (character === '{') { frame.depth += 1; out.push(character); continue; }
      if (character === '}') {
        if (frame.depth === 0) { stack.pop(); out.push(' '); continue; }
        frame.depth -= 1;
        out.push(character);
        continue;
      }
    }
    out.push(character);
  }
  return out.join('');
}
const RULES = [
  {
    name: 'double-equals',
    test: (line) => /(^|[^=!<>+\-*/%&|^])(==|!=)([^=]|$)/u.exec(line),
    message: 'use === / !== - a loose comparison is a bug waiting for a type change'
  },
  {
    name: 'var',
    test: (line) => /^\s*var\s/u.exec(line),
    message: 'const/let, not var'
  },
  {
    name: 'debugger',
    test: (line) => /\bdebugger\b/u.exec(line),
    message: 'a debugger statement must not be committed'
  },
  {
    name: 'line-length',
    test: (line) => line.length > MAX_LINE ? [line] : null,
    message: 'no line longer than ' + MAX_LINE + ' characters'
  }
];

const LIBRARY_RULES = [
  {
    name: 'stdout-in-library',
    test: (line) => /\bconsole\s*\.\s*(log|info|warn)\s*\(/u.exec(line),
    message: 'library code reports through the deck report; write diagnostics to stderr'
  }
];

function lintFile(file) {
  const problems = [];
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  try {
    // Parsing is the strongest check available without a dependency: a file that does not
    // compile cannot be shipped, and the syntax pass costs one call.
    new vm.Script(source, { filename: relative });
  } catch (error) {
    problems.push({ file: relative, line: 1, rule: 'syntax', message: error.message });
    return problems;
  }
  if (!source.endsWith('\n')) {
    problems.push({ file: relative, line: source.split('\n').length, rule: 'final-newline', message: 'file must end with a newline' });
  }
  const rawLines = source.split('\n');
  const codeLines = stripStringsAndComments(source).split('\n');
  const isLibrary = LIBRARY_DIRECTORIES.some((directory) => relative.startsWith(directory + '/'));
  const rules = isLibrary ? RULES.concat(LIBRARY_RULES) : RULES;
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const code = codeLines[index] === undefined ? '' : codeLines[index];
    if (/\t/u.test(raw)) problems.push({ file: relative, line: index + 1, rule: 'tabs', message: 'indent with spaces' });
    if (/[ \t]+$/u.test(raw)) problems.push({ file: relative, line: index + 1, rule: 'trailing-space', message: 'trailing whitespace' });
    for (const rule of rules) {
      if (!rule.test(code)) continue;
      problems.push({ file: relative, line: index + 1, rule: rule.name, message: rule.message });
    }
  }
  return problems;
}

function main(argv) {
  const quiet = argv.includes('--quiet');
  const files = javascriptFiles(ROOT);
  const problems = [];
  for (const file of files) problems.push(...lintFile(file));
  if (!quiet) {
    for (const problem of problems) {
      process.stdout.write(problem.file + ':' + problem.line + ': ' + problem.rule + ' - ' + problem.message + '\n');
    }
  }
  const summary = problems.length
    ? 'lint: ' + problems.length + ' problem(s) in ' + files.length + ' file(s)'
    : 'lint: ' + files.length + ' file(s) clean';
  process.stdout.write(summary + '\n');
  return problems.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { lintFile, javascriptFiles, stripStringsAndComments, MAX_LINE };
