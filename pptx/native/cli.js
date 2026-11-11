#!/usr/bin/env node
'use strict';

/**
 * The native deck tool: a Deck Spec in, a native .pptx out.
 *
 * Nothing on this path parses HTML and nothing rasterises a page. A spec is either a JSON
 * document or a CommonJS module that exports a deck (or a function returning one, which is how a
 * spec can be built from data), and the writer turns every word into a text run, every panel into
 * a shape, every table into a table, and every chart into a chart whose data lives in the
 * workbook embedded beside it.
 *
 *   node cli.js <spec> [out.pptx]
 *   node cli.js ../examples/native-cover.spec.json native-cover.pptx
 *   node cli.js ../examples/native_deck_spec.js native-deck.pptx --report native-deck.json
 *
 * Options
 *   --out <file>     output path (the positional argument does the same)
 *   --report <file>  write the generation report as JSON
 *   --check          validate the spec and stop; writes nothing
 *   --strict         exit non-zero on layout warnings as well as on errors
 *   --json           print one JSON object instead of the human summary
 *   --quiet          print errors only
 *   -h, --help       this text
 *
 * Exit codes: 0 written, 1 the spec was rejected, 2 the writer failed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { generatePptx, validateDeck } = require('./index');
const { validateSlide } = require('./engine/validation');

const USAGE = [
  'The native deck tool: a Deck Spec in, a native .pptx out.',
  '',
  '  node cli.js <spec> [out.pptx] [options]',
  '',
  '  <spec>      a .json document, or a .js/.cjs module exporting a deck',
  '              (or a function that returns one, or { deck })',
  '  [out.pptx]  where to write; defaults to the spec name beside the spec',
  '',
  '  --out <file>     output path, same as the positional argument',
  '  --report <file>  write the generation report as JSON',
  '  --layout-out <f>  write the boxes the writer used (for the text-fit gate)',
  '  --check          validate the spec and stop; writes nothing',
  '  --strict         layout warnings become failures',
  '  --require-face-metrics  also fail when a declared font has no metric file here',
  '  --json           one JSON object instead of the human summary',
  '  --quiet          errors only',
  '  -h, --help       this text'
].join('\n');

function parseArgs(argv) {
  const options = { spec: null, out: null, report: null, layout: null, json: false, check: false, strict: false, quiet: false, faceMetrics: false, help: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') { options.out = argv[index += 1] || null; } else if (arg === '--report') {
      options.report = argv[index += 1] || null;
    } else if (arg === '--layout-out') { options.layout = argv[index += 1] || null; } else if (arg === '--json') { options.json = true; } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--strict') { options.strict = true; } else if (arg === '--require-face-metrics') {
      options.faceMetrics = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '-h' || arg === '--help') { options.help = true; } else if (arg.startsWith('--')) {
      throw new Error('unknown option ' + arg + '\n\n' + USAGE);
    } else { positional.push(arg); }
  }
  options.spec = positional[0] || null;
  options.out = options.out || positional[1] || null;
  return options;
}

/**
 * Load the spec. JSON stays JSON - that is the portable contract, and a spec that needs no code
 * is one a human can review in a diff. A module is allowed because a deck built from a database
 * or a research pass should not have to be serialised first; it may export the deck, a function
 * that returns it, or an object with a `deck` field.
 */
function loadSpec(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error('spec not found: ' + file);
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.json') {
    const text = fs.readFileSync(resolved, 'utf8');
    try {
      return { deck: JSON.parse(text), source: resolved };
    } catch (error) {
      throw new Error('spec is not valid JSON (' + file + '): ' + error.message);
    }
  }
  if (extension !== '.js' && extension !== '.cjs') {
    throw new Error('spec must be .json, .js or .cjs (got ' + extension + '): ' + file);
  }
  const loaded = require(resolved);
  const value = typeof loaded === 'function' ? loaded() : loaded;
  const deck = value && typeof value === 'object' && value.deck ? value.deck : value;
  return { deck, source: resolved };
}

function defaultOutput(source) {
  const parsed = path.parse(source);
  return path.join(parsed.dir, parsed.name.replace(/\.spec$/u, '') + '.pptx');
}

/** Every element that will be drawn, including the children of a container. */
function flatten(elements, into = []) {
  (elements || []).forEach((element) => {
    into.push(element);
    if (element && Array.isArray(element.children)) flatten(element.children, into);
  });
  return into;
}

function census(elements) {
  const counts = {};
  flatten(elements).forEach((element) => {
    const type = (element && element.type) || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  });
  return counts;
}

function describeCensus(counts) {
  return Object.keys(counts).sort().map((type) => type + ' ' + counts[type]).join(' · ');
}

function groupWarnings(warnings) {
  const groups = {};
  warnings.forEach((warning) => {
    const code = warning.code || 'OTHER';
    groups[code] = groups[code] || [];
    groups[code].push(warning);
  });
  return groups;
}

function humanSummary(lines) {
  const width = lines.reduce((widest, [label]) => Math.max(widest, label.length), 0);
  return lines.map(([label, value]) => label.padEnd(width) + '  ' + value).join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (!options.spec) {
    process.stderr.write(USAGE + '\n');
    process.exitCode = 1;
    return;
  }

  let loaded;
  try {
    loaded = loadSpec(options.spec);
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
    return;
  }
  const { deck, source } = loaded;

  // A spec that fails validation is not written at all: a partial deck is worse than none,
  // because the file looks finished.
  const errors = validateDeck(deck);
  if (errors.length) {
    process.stderr.write('spec rejected (' + errors.length + ' error(s)): ' + options.spec + '\n');
    errors.slice(0, 20).forEach((message) => process.stderr.write('  - ' + message + '\n'));
    if (errors.length > 20) process.stderr.write('  … and ' + (errors.length - 20) + ' more\n');
    process.exitCode = 1;
    return;
  }

  // A slide is not an element: count what the slides contain, children included.
  const counts = census(deck.slides.flatMap((slide) => (slide && Array.isArray(slide.elements) ? slide.elements : [])));
  if (options.check) {
    const summary = humanSummary([
      ['spec', path.relative(process.cwd(), source) || source],
      ['slides', String(deck.slides.length)],
      ['objects', describeCensus(counts)],
      ['page', String(deck.pageSize || 'wide')],
      ['result', 'spec is valid; nothing written (--check)']
    ]);
    process.stdout.write((options.json ? JSON.stringify({ ok: true, source, slides: deck.slides.length, objects: counts }) : summary) + '\n');
    return;
  }

  const outputPath = path.resolve(options.out || defaultOutput(source));
  let result;
  try {
    result = await generatePptx(deck, outputPath, { baseDir: path.dirname(path.resolve(source)) });
  } catch (error) {
    process.stderr.write('the writer failed: ' + (error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = 2;
    return;
  }

  // The engine reports what it had to guess. Bounds and overflow come from the boxes it really
  // used (`laidOut`), not from the spec, so they describe the file that was written.
  const warnings = [];
  (result.laidOut || []).forEach((elements, index) => {
    validateSlide(elements, result.pageSize).forEach((warning) => {
      warnings.push(Object.assign({ slide: index + 1 }, warning));
    });
  });
  (result.droppedPictures || []).forEach((dropped) => {
    warnings.push({
      slide: dropped.slide || null,
      code: 'PICTURE_DROPPED',
      // The record says `source`: a relative path that was resolved against the wrong directory and
      // an absolute path that does not exist both land here, and either way the page is now wrong.
      message: 'could not read ' + (dropped.source || 'an image') + ' - that page is written without it'
        + (dropped.source && !path.isAbsolute(dropped.source) && !/^data:/iu.test(dropped.source)
          ? ' (a relative path is resolved against the spec file)'
          : '')
    });
  });
  const bytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  const fontReport = result.fontReport || {};
  // A face file is how this machine measures text. Without one the wrap is a heuristic: the run
  // that printed `no face files: wrap is estimated` had a cover title break one line later than
  // measured, which pushed every block under it down 0.65 in, and no gate said a word. `--strict`
  // deliberately tolerates that — a machine without the typeface is not a broken deck — so the
  // refusal is a separate, opt-in flag.
  const metricsEstimated = (fontReport.measuredCalls || 0) === 0;
  const faceMetricFailure = options.faceMetrics && metricsEstimated;
  const loadedFaces = fontReport.loadedFiles || [];
  const themeFonts = (deck.theme && deck.theme.fonts) || {};
  const deckFonts = [themeFonts.heading, themeFonts.body].filter(Boolean).filter((face, index, all) => all.indexOf(face) === index)
    .join(' / ') || 'theme default';
  if (faceMetricFailure) {
    const configured = (fontReport.configuredFaces || []).length;
    warnings.push({
      slide: null,
      code: 'FONT_UNMEASURED',
      message: (configured
        ? configured + ' face file(s) are declared for ' + deckFonts + ' but none could be opened'
        : 'no metric file for ' + deckFonts + ' could be opened - neither declared in theme.fontFiles'
          + (fontReport.discoveredFaces === false ? ' (discovery is off)' : ' nor found on this machine'))
        + ': every text box is wrapped from an estimate, not from the face'
        + ' (declare theme.fontFiles, install the face, or drop --require-face-metrics)'
    });
  }
  const groups = groupWarnings(warnings);

  if (options.report) {
    const reportPath = path.resolve(options.report);
    fs.writeFileSync(reportPath, JSON.stringify({
      spec: source,
      outputPath,
      slides: result.laidOut ? result.laidOut.length : 0,
      pageSize: result.pageSize,
      objects: counts,
      warnings,
      fonts: fontReport,
      // Readable without parsing the `fonts` line: a script can assert on these two.
      fontsEstimated: metricsEstimated,
      requestedFaces: deckFonts,
      droppedPictures: result.droppedPictures || [],
      embeddedFonts: result.embeddedFonts || [],
      skippedFonts: result.skippedFonts || []
    }, null, 2) + '\n', 'utf8');
  }

  // The boxes the writer really used, one entry per slide, in inches: the text-fit gate compares
  // these against the lines the renderer drew, so it needs what was written and not what was asked.
  if (options.layout) {
    const layoutPath = path.resolve(options.layout);
    fs.writeFileSync(layoutPath, JSON.stringify({
      pageSize: result.pageSize,
      slides: (result.laidOut || []).map((elements) => ({ elements }))
    }, null, 2) + '\n', 'utf8');
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      spec: source,
      outputPath,
      slides: result.laidOut ? result.laidOut.length : 0,
      pageSize: result.pageSize,
      objects: counts,
      warnings: warnings.length,
      warningsByCode: Object.keys(groups).reduce((into, code) => Object.assign(into, { [code]: groups[code].length }), {}),
      fonts: fontReport,
      fontsEstimated: metricsEstimated,
      requestedFaces: deckFonts,
      droppedPictures: (result.droppedPictures || []).length,
      bytes
    }) + '\n');
  } else if (!options.quiet) {
    const lines = [
      ['spec', path.relative(process.cwd(), source) || source],
      ['slides', String(result.laidOut ? result.laidOut.length : 0)],
      ['page', result.pageSize ? result.pageSize.width + ' x ' + result.pageSize.height + ' in' : 'unknown'],
      ['objects', describeCensus(counts)],
      ['metrics', metricsEstimated
        ? (fontReport.fontkitAvailable
          ? 'fontkit: present, but no glyph was measured from a face'
          : 'fontkit: absent (estimates only)')
        : 'fontkit: ' + fontReport.measuredCalls + ' of '
          + (fontReport.measuredCalls + fontReport.estimatedCalls) + ' measurements used real faces'],
      // The faces the deck asks for, which is what a reader has to have; the metric files are
      // how this machine measured them, and their absence is worth knowing too.
      ['fonts', deckFonts + (loadedFaces.length
        ? ' · metrics from ' + loadedFaces.length + ' face file(s)'
          + ((fontReport.configuredFaces || []).length < loadedFaces.length ? ' (found on this machine)' : '')
        : ' · no face files: wrap is estimated'
          + (faceMetricFailure ? ' (FONT_UNMEASURED: --require-face-metrics)' : ''))],
      ['warnings', warnings.length ? Object.keys(groups).sort().map((code) => code + ' ' + groups[code].length).join(' · ') : 'none'],
      ['wrote', path.relative(process.cwd(), outputPath) + ' (' + Math.max(1, Math.round(bytes / 1024)) + ' KB)']
    ];
    if ((result.droppedPictures || []).length) {
      lines.push(['dropped', (result.droppedPictures || []).length + ' picture(s) could not be read; named in the report']);
    }
    process.stdout.write(humanSummary(lines) + '\n');
    Object.keys(groups).sort().forEach((code) => {
      groups[code].slice(0, 5).forEach((warning) => {
        // A deck-level warning has no page number; naming it `slide null` would read like a bug.
        process.stderr.write('  [' + code + '] ' + (warning.slide ? 'slide ' + warning.slide : 'deck')
          + ': ' + warning.message + '\n');
      });
      if (groups[code].length > 5) process.stderr.write('  [' + code + '] … and ' + (groups[code].length - 5) + ' more\n');
    });
  }

  // `--strict` still owns layout warnings. The metric gate fails on its own reason only, so a deck
  // is never refused for a warning the caller did not ask to be fatal.
  if (faceMetricFailure || (options.strict && warnings.length)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
  process.exitCode = 2;
});
