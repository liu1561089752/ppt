/**
 * The scale gate: one deck large enough that a regression in the layout maths or in the
 * writer stops being invisible.
 *
 * `npm run stress:html` proves that forty generated pages keep every invariant, and
 * `gate:big` pushes that to a hundred and twenty. Neither of them would notice a change
 * that costs linear time twice over - a deck of forty pages still finishes in seconds
 * because it is small. This gate asks the same questions about three hundred pages and
 * adds the one invariant the smaller runs cannot see: the whole thing has to finish
 * inside a budget, measured, not assumed.
 *
 * The budget is deliberately generous (three hundred pages in three minutes on a laptop)
 * because it is a regression alarm, not a benchmark. A machine that is slower than the
 * one the number was measured on should raise the number in package.json, and the report
 * prints the measured time so the next reader can see how much headroom is left.
 *
 * Deterministic: the seed decides the deck, so the same numbers come back every run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { generate, checkDeck } = require('./stress_html');

function flag(args, name, fallback) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const slides = Number(flag(args, 'slides', 300));
  const seed = Number(flag(args, 'seed', 21));
  const budgetSeconds = Number(flag(args, 'budget', 180));
  const folder = flag(args, 'dir', path.join(process.env.TEMP || '.', 'scale-gate'));
  fs.mkdirSync(folder, { recursive: true });
  const htmlPath = path.join(folder, 'scale' + slides + '.html');
  const pptxPath = path.join(folder, 'scale' + slides + '.pptx');

  const started = Date.now();
  const html = generate({ slides, seed });
  fs.writeFileSync(htmlPath, html);
  const generated = Date.now() - started;

  const pipeline = require('../pipeline');
  const analysedAt = Date.now();
  const result = pipeline.convertHtml(html);
  const analysed = Date.now() - analysedAt;

  const { generatePptx } = require('../engine/native_pptx');
  const writtenAt = Date.now();
  await generatePptx(result.deck, pptxPath);
  const written = Date.now() - writtenAt;
  const total = Date.now() - started;

  const problems = checkDeck(result, { slides });
  const shapes = result.deck.slides.reduce((sum, slide) => sum + (slide.elements || []).length, 0);
  const bytes = fs.statSync(pptxPath).size;
  const budgetMs = budgetSeconds * 1000;

  console.log('scale gate: ' + result.deck.slides.length + ' slide(s), ' + shapes + ' element(s), '
    + result.report.tables + ' table(s), ' + result.report.charts + ' chart(s)');
  console.log('  generate ' + generated + 'ms  analyse ' + analysed + 'ms  write ' + written + 'ms  total '
    + total + 'ms  budget ' + budgetMs + 'ms (' + Math.round((total / budgetMs) * 100) + '% used)');
  console.log('  package ' + path.relative(process.cwd(), pptxPath) + ' (' + Math.round(bytes / 1024) + 'KB)');

  if (result.deck.slides.length !== slides) {
    problems.push({ kind: 'slide-count', details: ['expected ' + slides + ', produced ' + result.deck.slides.length] });
  }
  if (total > budgetMs) {
    problems.push({ kind: 'over-budget', details: [total + 'ms exceeds ' + budgetMs + 'ms'] });
  }
  if (problems.length) {
    console.log('PROBLEM: ' + problems.length + ' issue(s)');
    problems.slice(0, 8).forEach((problem) => {
      console.log('  - ' + problem.kind + ': ' + (problem.details || []).join('; '));
    });
    process.exit(1);
  }
  // The invariants of the smaller runs, on the big one: nothing leaves the canvas, every
  // page keeps its elements, and no page silently fell back to absolute boxes.
  console.log('OK: ' + slides + ' generated page(s) kept every invariant inside the budget');
}

main().catch((error) => {
  console.log('PROBLEM: ' + error.message);
  process.exit(1);
});
