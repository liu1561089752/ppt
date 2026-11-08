#!/usr/bin/env node
'use strict';

/**
 * CLI for the HTML → Native pipeline.
 *
 *   node pipeline/cli.js input.html
 *   node pipeline/cli.js input.html --out deck.json --pptx out.pptx --report report.json
 */

const path = require('node:path');
const { convertFile } = require('./index');

function parseArgs(argv) {
  const options = { input: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--out') options.out = argv[++index];
    else if (token === '--pptx') options.pptx = argv[++index];
    else if (token === '--report') options.reportPath = argv[++index];
    else if (token === '--layout-out') options.layoutPath = argv[++index];
    else if (token === '--title') options.title = argv[++index];
    else if (token === '--language') options.language = argv[++index];
    else if (token === '--page-size') options.pageSize = argv[++index];
    else if (token === '--json') options.json = true;
    else if (token === '--allow-layout-issues') options.allowLayoutIssues = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (!token.startsWith('--') && !options.input) options.input = token;
    else throw new Error('Unknown argument: ' + token);
  }
  return options;
}

function printUnsupported(report) {
  const groups = new Map();
  (report.unsupportedDetails || []).forEach((entry) => {
    const key = entry.property + ' (' + entry.reason + ')';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  if (!groups.size) {
    process.stdout.write('No unsupported CSS features detected.\n');
    return;
  }
  process.stdout.write('Unsupported CSS features (not translated):\n');
  groups.forEach((entries, key) => {
    const sample = entries[0];
    process.stdout.write('  - ' + key + ' · ' + entries.length + ' occurrence(s)' +
      (sample.tag ? ' · e.g. <' + sample.tag + '>' : '') + '\n');
  });
}

function printLayoutIssues(report) {
  const layout = report.layout;
  if (!layout || !layout.total) {
    process.stdout.write('No box collisions or content overflows detected.\n');
    return 0;
  }
  process.stdout.write('Layout issues (boxes that collide or content that spills out):\n');
  layout.slides.forEach((slide) => {
    slide.collisions.forEach((entry) => {
      process.stdout.write('  - slide ' + slide.slide + ': ' + entry.a + ' overlaps ' + entry.b
        + ' (' + entry.area + 'in², inside ' + entry.parent + ')\n');
    });
    (slide.overflows || []).forEach((entry) => {
      process.stdout.write('  - slide ' + slide.slide + ': ' + entry.node + ' content exceeds its box by '
        + entry.over + 'in on ' + entry.axis + '\n');
    });
    (slide.beyond || []).forEach((entry) => {
      process.stdout.write('  - slide ' + slide.slide + ': ' + entry.node + ' runs ' + entry.over
        + 'in past the ' + entry.side + ' edge of the slide\n');
    });
  });
  return layout.total;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.input) {
    process.stdout.write('Usage: node pipeline/cli.js <input.html> [--out deck.json] [--pptx out.pptx] ' +
      '[--report report.json] [--layout-out layout.json] [--title T] [--language zh-CN] [--page-size wide|standard] [--json]\n');
    return options.help ? 0 : 1;
  }

  const result = await convertFile(options.input, options);
  if (options.json) {
    process.stdout.write(JSON.stringify({
      input: path.resolve(options.input),
      output: result.output || null,
      report: result.report,
      errors: result.errors
    }, null, 2) + '\n');
    return result.errors.length ? 1 : 0;
  }

  process.stdout.write('Input:  ' + path.resolve(options.input) + '\n');
  process.stdout.write('Slides: ' + result.report.slides +
    ' | text: ' + result.report.textElements +
    ' (rich ' + result.report.richTextElements + ')' +
    ' | shapes: ' + result.report.shapes +
    ' | images: ' + result.report.images +
    ' | tables: ' + result.report.tables +
    ' | charts: ' + (result.report.charts || 0) +
    ' | lines: ' + result.report.lines + '\n');
  process.stdout.write('Layout: ' + result.report.declarativeContainers + ' declarative container(s), ' +
    result.report.absoluteGroups + ' absolutely positioned group(s)' +
    ' | engine/analyzer max delta ' + Number(result.report.maxBoxDelta).toFixed(4) + 'in\n');
  if (result.report.droppedDecorations) {
    process.stdout.write('Warning: ' + result.report.droppedDecorations +
      ' ::before/::after decoration(s) belong to a plain element that cannot host an overlay\n');
  }
  if (result.report.rotatedGroups) {
    process.stdout.write('Warning: ' + result.report.rotatedGroups +
      ' rotated group(s) keep their children unrotated (a container cannot carry a rotation)\n');
  }
  if (result.output) process.stdout.write('PPTX:   ' + result.output.pptx + '\n');
  if (options.out) process.stdout.write('Deck:   ' + path.resolve(options.out) + '\n');
  printUnsupported(result.report);
  const layoutIssues = printLayoutIssues(result.report);
  (result.report.notes || []).forEach((note) => process.stdout.write('Note: ' + note + '\n'));
  if (result.errors.length) {
    process.stdout.write('Deck spec validation failed:\n');
    result.errors.forEach((error) => process.stdout.write('  - ' + error + '\n'));
    return 1;
  }
  // A colliding box is a real defect that a wrong measurement produced, so the
  // pipeline fails on it instead of shipping it. `--allow-layout-issues` opts out.
  if (layoutIssues && !options.allowLayoutIssues) {
    process.stdout.write('FAIL: ' + layoutIssues + ' layout issue(s); pass --allow-layout-issues to ignore.\n');
    return 1;
  }
  process.stdout.write('OK: deck spec is valid.\n');
  return 0;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
