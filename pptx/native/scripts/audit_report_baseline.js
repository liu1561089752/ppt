'use strict';

/**
 * The honesty contract, held to account by a diff.
 *
 * Every example deck is converted and every declaration the engine could not translate is
 * collected. The list is compared with a baseline: a *new* entry means a design that used to
 * come through whole now loses something, and a *missing* entry means the engine learned
 * something (the baseline then has to be updated on purpose, not by accident).
 *
 * Usage:
 *   node scripts/audit_report_baseline.js            # compare, exit 1 on a difference
 *   node scripts/audit_report_baseline.js --update   # write the baseline
 *   node scripts/audit_report_baseline.js --json     # the report as JSON
 */

const fs = require('node:fs');
const path = require('node:path');
const pipeline = require('../pipeline');

const EXAMPLES = path.join(__dirname, '..', '..', 'examples');
const BASELINE = path.join(__dirname, '..', 'baselines', 'reports.json');

/** One entry per named declaration: which deck, which property, and the reason it is named. */
async function collectEntries() {
  const files = fs.readdirSync(EXAMPLES)
    .filter((name) => /^pipeline-.*\.html$/u.test(name))
    .sort();
  const entries = [];
  for (const name of files) {
    const result = await pipeline.convertFile(path.join(EXAMPLES, name), {});
    ((result.report && result.report.unsupportedDetails) || []).forEach((detail) => {
      entries.push({
        deck: name,
        property: String(detail.property),
        reason: String(detail.reason || '').replace(/\s+/gu, ' ').trim()
      });
    });
  }
  // The order a deck happens to be walked in is not part of the contract.
  return entries.sort((left, right) => (left.deck + left.property + left.reason)
    .localeCompare(right.deck + right.property + right.reason));
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : null;
  } catch (_) {
    return null;
  }
}

async function main(argv) {
  const entries = await collectEntries();
  const update = argv.includes('--update');
  const json = argv.includes('--json');

  if (update) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({
      note: 'Declarations the engine knowingly does not translate, one entry per deck. Refresh with --update.',
      entries
    }, null, 2) + '\n', 'utf8');
    process.stdout.write('baseline written: ' + entries.length + ' named declaration(s)\n');
    return 0;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ entries }, null, 2) + '\n');
    return 0;
  }

  const baseline = readBaseline();
  if (!baseline) {
    process.stdout.write('no baseline yet: run node scripts/audit_report_baseline.js --update\n');
    return 1;
  }
  const key = (entry) => entry.deck + '|' + entry.property + '|' + entry.reason;
  const known = new Set(baseline.map(key));
  const current = new Set(entries.map(key));
  const added = entries.filter((entry) => !known.has(key(entry)));
  const dropped = baseline.filter((entry) => !current.has(key(entry)));

  if (!added.length && !dropped.length) {
    process.stdout.write('reports unchanged: ' + entries.length + ' named declaration(s)\n');
    return 0;
  }
  if (added.length) {
    process.stdout.write('NEW report(s) - a design that used to come through now loses something:\n');
    added.forEach((entry) => {
      process.stdout.write('  + ' + entry.deck + '  ' + entry.property + '  ' + entry.reason.slice(0, 110) + '\n');
    });
  }
  if (dropped.length) {
    process.stdout.write('report(s) no longer raised - the engine learned something, bless it:\n');
    dropped.forEach((entry) => {
      process.stdout.write('  - ' + entry.deck + '  ' + entry.property + '  ' + entry.reason.slice(0, 110) + '\n');
    });
  }
  process.stdout.write('run with --update once the change is understood\n');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write((error && error.stack) || String(error));
    process.exitCode = 1;
  });
}

module.exports = { collectEntries, readBaseline, EXAMPLES, BASELINE };
