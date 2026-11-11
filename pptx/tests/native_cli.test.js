'use strict';

// The native tool's public interface: a spec in, a deck out. These tests drive the CLI the way a
// person or another program would - a child process, stdout, exit code - because that interface is
// the product. What the file contains is checked by asking the package itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const JSZip = require(require.resolve('jszip', { paths: [path.join(__dirname, '..', 'native', 'engine', 'native_pptx')] }));

const CLI = path.join(__dirname, '..', 'native', 'cli.js');
const JSON_SPEC = path.join(__dirname, '..', 'examples', 'native-cover.spec.json');
const JS_SPEC = path.join(__dirname, '..', 'examples', 'native_deck_spec.js');

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'native-cli-'));
}

// spawnSync, not execFileSync: the tool reports layout warnings on stderr while still exiting 0,
// and a helper that only returns stderr on failure cannot see them.
function run(args, env) {
  const result = spawnSync(process.execPath, [CLI].concat(args), {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..', 'native'),
    env: env ? Object.assign({}, process.env, env) : process.env
  });
  return { code: result.status === null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function slideParts(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  const xml = await Promise.all(slides.map((name) => zip.file(name).async('string')));
  return {
    zip,
    names,
    slides: slides.length,
    charts: names.filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name)).length,
    workbooks: names.filter((name) => /^ppt\/embeddings\/.*\.xlsx$/u.test(name)).length,
    tables: xml.reduce((sum, text) => sum + (text.match(/<a:tbl>/gu) || []).length, 0),
    runs: xml.reduce((sum, text) => sum + (text.match(/<a:r>/gu) || []).length, 0),
    pictures: xml.reduce((sum, text) => sum + (text.match(/<p:pic>/gu) || []).length, 0)
  };
}

test('a JSON spec becomes a native deck: exit 0, real objects, no page raster', async () => {
  const folder = workspace();
  const out = path.join(folder, 'cover.pptx');
  const result = run([JSON_SPEC, out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /slides\s+5\b/u);
  assert.ok(fs.existsSync(out), 'the deck was written');

  const parts = await slideParts(out);
  assert.equal(parts.slides, 5);
  assert.equal(parts.charts, 1, 'the chart slide is a native chart');
  assert.equal(parts.workbooks, 1, 'and it carries its data workbook');
  assert.equal(parts.tables, 1, 'the table slide is a real table');
  assert.ok(parts.runs > 20, 'the words are runs: ' + parts.runs);
  assert.equal(parts.pictures, 0, 'a spec with no picture element writes no picture at all');
});

test('--check validates and writes nothing', () => {
  const folder = workspace();
  const out = path.join(folder, 'never.pptx');
  const result = run([JSON_SPEC, out, '--check']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /spec is valid/u);
  assert.equal(fs.existsSync(out), false, 'no file was written');
});

test('a broken spec is rejected with the element that broke it, and nothing is written', () => {
  const folder = workspace();
  const spec = path.join(folder, 'broken.json');
  fs.writeFileSync(spec, JSON.stringify({
    pageSize: 'wide',
    slides: [{ elements: [{ type: 'picture-book', text: '没有这种元素' }] }]
  }), 'utf8');
  const out = path.join(folder, 'broken.pptx');
  const result = run([spec, out]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /spec rejected/u);
  assert.match(result.stderr, /slides\[0\]\.elements\[0\]/u, 'the message names the element: ' + result.stderr);
  assert.equal(fs.existsSync(out), false);
});

test('--report writes the census, the warnings and the font situation', () => {
  const folder = workspace();
  const out = path.join(folder, 'deck.pptx');
  const report = path.join(folder, 'report.json');
  const result = run([JSON_SPEC, out, '--report', report]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(parsed.slides, 5);
  assert.equal(parsed.objects.chart, 1);
  assert.equal(parsed.objects.table, 1);
  assert.ok(Array.isArray(parsed.warnings));
  assert.ok(parsed.fonts && typeof parsed.fonts.fontkitAvailable === 'boolean');
});

test('--json prints one object a program can read', () => {
  const folder = workspace();
  const out = path.join(folder, 'deck.pptx');
  const result = run([JSON_SPEC, out, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.slides, 5);
  assert.equal(parsed.objects.text, 22);
  assert.ok(parsed.bytes > 1000);
});

test('--strict turns a layout warning into a failure', () => {
  const folder = workspace();
  const spec = path.join(folder, 'outside.json');
  // A text box hanging off the right edge: the writer draws it, the engine says so.
  fs.writeFileSync(spec, JSON.stringify({
    pageSize: 'wide',
    slides: [{ elements: [
      { type: 'text', text: '超出边界的一段文字', x: 12.6, y: 1, w: 3, h: 0.5, fontSize: 14 }
    ] }]
  }), 'utf8');
  const out = path.join(folder, 'outside.pptx');
  const loose = run([spec, out]);
  assert.equal(loose.code, 0, 'a warning does not stop the write by default');
  assert.match(loose.stderr, /OUT_OF_BOUNDS/u);
  const strict = run([spec, path.join(folder, 'strict.pptx'), '--strict']);
  assert.equal(strict.code, 1, 'and --strict makes it fatal');
});

test('a JS spec that uses the templates builds the flagship deck', async () => {
  const folder = workspace();
  const out = path.join(folder, 'flagship.pptx');
  const result = run([JS_SPEC, out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /slides\s+6\b/u);
  const parts = await slideParts(out);
  assert.equal(parts.slides, 6);
  assert.equal(parts.charts, 1);
  assert.equal(parts.tables, 1);
  assert.equal(parts.workbooks, 1);
});

test('--require-face-metrics refuses a deck whose wrap is only an estimate', () => {
  // `--strict` tolerates a missing metric file on purpose - a machine without the typeface is not a
  // broken deck - which lets a run print `warnings none` while every line break came from a
  // heuristic. The run that found this had a cover title break one line later than measured and push
  // the page down 0.65 in, silently. The flag is the opt-in gate, and the report carries the fact.
  const folder = workspace();
  const report = path.join(folder, 'gated.json');
  // The condition the flag exists for: no metric file for the family anywhere on this machine.
  // Discovery finds one when it is installed, so the estimate has to be asked for explicitly.
  const noFaces = { NATIVE_FONT_DISCOVERY: '0' };

  const loose = run([JSON_SPEC, path.join(folder, 'loose.pptx')], noFaces);
  assert.equal(loose.code, 0, 'without the flag an estimate is still written: ' + loose.stderr);
  assert.doesNotMatch(loose.stderr, /FONT_UNMEASURED/u, 'and it is not dressed up as a warning');

  const gated = run([JSON_SPEC, path.join(folder, 'gated.pptx'), '--require-face-metrics', '--report', report], noFaces);
  assert.equal(gated.code, 1, 'the gate fails the build: ' + gated.stdout + gated.stderr);
  assert.match(gated.stdout, /FONT_UNMEASURED/u, 'the summary names the gate');
  assert.match(gated.stderr, /\[FONT_UNMEASURED\] deck:/u, 'and the warning has no page number to blame');

  const written = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(written.fontsEstimated, true, 'the report says the wrap was estimated');
  assert.equal(written.fonts.measuredCalls, 0, 'no measurement came from a face');
  assert.equal(written.warnings.filter((warning) => warning.code === 'FONT_UNMEASURED').length, 1);
});

test('the same deck passes the gate when the face is installed', (t) => {
  // Discovery is the fix for the run's whole font complaint: the deck names a family, the machine
  // knows the file, and nobody has to repeat a path that cannot be guessed from the name.
  const { fontFileForFamily } = require('../native/engine/font_manager');
  const family = JSON.parse(fs.readFileSync(JSON_SPEC, 'utf8')).theme.fonts.body;
  if (!fontFileForFamily(family)) { t.skip(family + ' is not installed on this machine'); return; }
  const folder = workspace();
  const report = path.join(folder, 'discovered.json');

  const measured = run([JSON_SPEC, path.join(folder, 'measured.pptx'), '--require-face-metrics', '--report', report]);
  assert.equal(measured.code, 0, 'the gate passes on a machine that has the face: ' + measured.stdout + measured.stderr);
  assert.match(measured.stdout, /measurements used real faces/u, 'and says so: ' + measured.stdout);
  assert.match(measured.stdout, /found on this machine/u, 'naming discovery as the source');

  const written = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(written.fontsEstimated, false, 'the report agrees the wrap was measured');
  assert.ok(written.fonts.measuredCalls > 0, 'measurements came from a face');
  assert.ok((written.fonts.loadedFiles || []).length > 0, 'and the file is named: '
    + JSON.stringify(written.fonts.loadedFiles));
});
