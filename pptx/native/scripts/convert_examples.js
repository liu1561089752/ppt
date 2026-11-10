#!/usr/bin/env node
/**
 * Convert every example deck, so a gate has something to look at.
 *
 * The gates downstream of conversion - the packaged-deck checks, the two-reader comparison, the
 * object counting - all read `pipeline-converted/`, which is generated and therefore not in the
 * repository. On a fresh clone those gates had nothing to read and said so in the least helpful
 * way possible ("nothing to check"), which is a gate that looks broken on the machine of whoever
 * just cloned it.
 *
 * So conversion is one command: every `examples/pipeline-*.html` becomes a deck and its spec, named
 * after the example, and a summary says what happened. `--only <prefix>` narrows it, `--keep` skips
 * examples whose deck is already newer, and a failure names the example and exits non-zero - a
 * corpus that is quietly missing a deck is worse than none.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXAMPLES = path.join(ROOT, '..', 'examples');
const OUTPUT = path.join(ROOT, 'pipeline-converted');

async function main() {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : '';
  const keep = args.includes('--keep');
  const list = args.includes('--list');

  const { convertFile } = require('../pipeline');
  const { generatePptx } = require('../engine/native_pptx');

  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });
  const examples = fs.readdirSync(EXAMPLES)
    .filter((name) => /^pipeline-.*\.html$/u.test(name))
    .filter((name) => !only || name.startsWith(only))
    .sort();
  if (!examples.length) {
    console.log('no example matched' + (only ? ' --only ' + only : ''));
    return 1;
  }
  if (list) {
    examples.forEach((name) => console.log(name.replace(/\.html$/u, '')));
    return 0;
  }

  const failures = [];
  let written = 0;
  for (const name of examples) {
    const source = path.join(EXAMPLES, name);
    const stem = name.replace(/\.html$/u, '');
    const deckPath = path.join(OUTPUT, stem + '.pptx');
    const specPath = path.join(OUTPUT, stem + '.json');
    if (keep && fs.existsSync(deckPath) && fs.statSync(deckPath).mtimeMs >= fs.statSync(source).mtimeMs) continue;
    try {
      const result = await convertFile(source, {});
      fs.writeFileSync(specPath, JSON.stringify(result.deck, null, 1));
      await generatePptx(result.deck, deckPath);
      written += 1;
      const slides = (result.deck.slides || []).length;
      const reported = (result.report.unsupportedDetails || []).length;
      console.log('  ' + stem.padEnd(26) + slides + ' slide(s), ' + reported + ' report(s)');
    } catch (error) {
      failures.push(stem + ': ' + error.message);
    }
  }
  console.log(written + ' deck(s) written to ' + path.relative(ROOT, OUTPUT) + ', ' + failures.length + ' failure(s)');
  for (const failure of failures) console.log('  ! ' + failure);
  return failures.length ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { EXAMPLES, OUTPUT };
