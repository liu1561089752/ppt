#!/usr/bin/env node
'use strict';

/**
 * Audit a generated deck for editability.
 *
 * The native engine's promise is "content stays editable". This script reads
 * the PPTX package directly and reports, per slide, how much of the content is
 * still native text / shape / table / chart geometry, and whether a slide has
 * been degraded into a single full-slide raster.
 *
 * Usage:
 *   node scripts/audit_deck.js deck.pptx
 *   node scripts/audit_deck.js deck.pptx --json --min-text-shapes 2
 */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const EMU_PER_INCH = 914400;

const SEVERITY_ORDER = { info: 0, warning: 1, error: 2 };

function slidePartNames(zip) {
  return Object.keys(zip.files)
    .map((name) => ({ name, match: /^ppt\/slides\/slide(\d+)\.xml$/u.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((entry) => entry.name);
}

function numberAttribute(attributes, name) {
  const match = new RegExp('\\b' + name + '="(-?\\d+)"', 'u').exec(attributes || '');
  return match ? Number(match[1]) : null;
}

function decodeXmlText(value) {
  return String(value)
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&');
}

function readTextCharacters(xml) {
  const matches = xml.match(/<a:t>([\s\S]*?)<\/a:t>/gu) || [];
  return matches.reduce((sum, node) => {
    const inner = node.replace(/^<a:t>/u, '').replace(/<\/a:t>$/u, '');
    return sum + decodeXmlText(inner).replace(/\s/gu, '').length;
  }, 0);
}

function readPageSize(presentationXml) {
  const match = /<p:sldSz\b([^>]*)>/u.exec(presentationXml || '');
  if (!match) return null;
  const cx = numberAttribute(match[1], 'cx');
  const cy = numberAttribute(match[1], 'cy');
  if (!cx || !cy) return null;
  return { cx, cy, widthIn: cx / EMU_PER_INCH, heightIn: cy / EMU_PER_INCH };
}

function inspectPictures(xml) {
  const pictures = [];
  const blocks = xml.match(/<p:pic>[\s\S]*?<\/p:pic>/gu) || [];
  blocks.forEach((block, index) => {
    const extent = /<a:ext\b([^>]*)\/>/u.exec(block);
    const offset = /<a:off\b([^>]*)\/>/u.exec(block);
    const cx = extent ? numberAttribute(extent[1], 'cx') : null;
    const cy = extent ? numberAttribute(extent[1], 'cy') : null;
    const x = offset ? numberAttribute(offset[1], 'x') : null;
    const y = offset ? numberAttribute(offset[1], 'y') : null;
    pictures.push({
      index,
      x, y, cx, cy,
      cropped: /<a:srcRect\b/u.test(block),
      rounded: /<a:prstGeom prst="roundRect"/u.test(block),
      outlined: /<a:ln\b/u.test(block),
      shadowed: /<a:effectLst[\s\S]*?Shdw/u.test(block),
      alpha: /<a:alphaModFix\b/u.test(block)
    });
  });
  return pictures;
}

function inspectSlide(name, xml, pageSize) {
  const textShapes = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/gu) || [])
    .filter((block) => /<p:txBody>/u.test(block));
  const shapes = (xml.match(/<p:sp>/gu) || []).length;
  const graphicFrames = xml.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/gu) || [];
  const charts = graphicFrames.filter((block) => /<c:chart\b/u.test(block)).length;
  const tables = (xml.match(/<a:tbl>/gu) || []).length;
  const pictures = inspectPictures(xml);
  const characters = readTextCharacters(xml);
  const slideArea = pageSize ? pageSize.cx * pageSize.cy : null;

  const pictureArea = slideArea
    ? pictures.reduce((sum, picture) => sum + Math.max(0, picture.cx || 0) * Math.max(0, picture.cy || 0), 0)
    : 0;
  const largestPictureShare = slideArea
    ? pictures.reduce((max, picture) => Math.max(max, ((picture.cx || 0) * (picture.cy || 0)) / slideArea), 0)
    : 0;

  const findings = [];
  if (textShapes.length === 0 && pictures.length > 0) {
    findings.push({
      code: 'TEXT_AS_IMAGE', severity: 'error',
      message: 'Slide has pictures but no editable text shapes; content appears rasterized.'
    });
  }
  if (characters === 0) {
    findings.push({ code: 'NO_EDITABLE_TEXT', severity: 'error', message: 'Slide has no editable characters.' });
  }
  if (largestPictureShare >= 0.9 && characters < 20) {
    findings.push({
      code: 'POSSIBLE_FULL_SLIDE_RASTER', severity: 'error',
      message: 'A single picture covers ' + Math.round(largestPictureShare * 100) + '% of the slide and the slide has almost no editable text.'
    });
  } else if (largestPictureShare >= 0.9) {
    findings.push({
      code: 'FULL_BLEED_PICTURE', severity: 'info',
      message: 'A picture covers ' + Math.round(largestPictureShare * 100) + '% of the slide as an editable, croppable picture frame.'
    });
  }
  if (pageSize) {
    pictures.forEach((picture) => {
      if (picture.x === null || picture.y === null || picture.cx === null || picture.cy === null) return;
      const tolerance = 0.02 * EMU_PER_INCH;
      if (picture.x < -tolerance || picture.y < -tolerance ||
          picture.x + picture.cx > pageSize.cx + tolerance ||
          picture.y + picture.cy > pageSize.cy + tolerance) {
        findings.push({
          code: 'PICTURE_OUT_OF_BOUNDS', severity: 'warning',
          message: 'Picture ' + picture.index + ' extends beyond the slide bounds.'
        });
      }
    });
  }

  return {
    part: name,
    shapes,
    textShapes: textShapes.length,
    characters,
    pictures: pictures.length,
    croppedPictures: pictures.filter((picture) => picture.cropped).length,
    roundedPictures: pictures.filter((picture) => picture.rounded).length,
    outlinedPictures: pictures.filter((picture) => picture.outlined).length,
    shadowedPictures: pictures.filter((picture) => picture.shadowed).length,
    alphaPictures: pictures.filter((picture) => picture.alpha).length,
    charts,
    tables,
    pictureCoverage: slideArea ? pictureArea / slideArea : 0,
    largestPictureShare,
    findings
  };
}

async function auditPptx(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error('PPTX not found: ' + absolute);
  const zip = await JSZip.loadAsync(fs.readFileSync(absolute));
  const presentationFile = zip.file('ppt/presentation.xml');
  const pageSize = presentationFile ? readPageSize(await presentationFile.async('string')) : null;
  const parts = slidePartNames(zip);
  const slides = [];
  for (const part of parts) {
    const xml = await zip.file(part).async('string');
    slides.push(inspectSlide(part, xml, pageSize));
  }
  const totals = slides.reduce((accumulator, slide) => {
    Object.keys(accumulator).forEach((key) => { accumulator[key] += slide[key]; });
    return accumulator;
  }, {
    shapes: 0, textShapes: 0, characters: 0, pictures: 0, croppedPictures: 0,
    roundedPictures: 0, outlinedPictures: 0, shadowedPictures: 0, alphaPictures: 0,
    charts: 0, tables: 0
  });
  const findings = slides.flatMap((slide) => slide.findings.map((finding) =>
    Object.assign({ slide: slide.part }, finding)));
  return {
    file: absolute,
    pageSize,
    slideCount: slides.length,
    totals,
    slides,
    findings,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length
  };
}

function parseArgs(argv) {
  const options = {
    file: null, json: false, minTextShapes: 1, minCharacters: 1,
    maxPictureCoverage: 1, failOnWarning: false, quiet: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') options.json = true;
    else if (token === '--quiet') options.quiet = true;
    else if (token === '--fail-on-warning') options.failOnWarning = true;
    else if (token === '--min-text-shapes') options.minTextShapes = Number(argv[++index]);
    else if (token === '--min-characters') options.minCharacters = Number(argv[++index]);
    else if (token === '--max-picture-coverage') options.maxPictureCoverage = Number(argv[++index]);
    else if (token === '--help' || token === '-h') options.help = true;
    else if (!token.startsWith('--') && !options.file) options.file = token;
    else throw new Error('Unknown argument: ' + token);
  }
  return options;
}

function evaluate(report, options) {
  const failures = [];
  report.slides.forEach((slide) => {
    if (slide.textShapes < options.minTextShapes) {
      failures.push(slide.part + ': ' + slide.textShapes + ' editable text shapes, minimum is ' + options.minTextShapes);
    }
    if (slide.characters < options.minCharacters) {
      failures.push(slide.part + ': ' + slide.characters + ' editable characters, minimum is ' + options.minCharacters);
    }
    if (slide.pictureCoverage > options.maxPictureCoverage) {
      failures.push(slide.part + ': picture coverage ' + slide.pictureCoverage.toFixed(3) +
        ' exceeds the ' + options.maxPictureCoverage + ' budget');
    }
  });
  report.findings.forEach((finding) => {
    const blocking = finding.severity === 'error' || (options.failOnWarning && finding.severity === 'warning');
    if (blocking) failures.push(finding.slide + ': [' + finding.code + '] ' + finding.message);
  });
  return failures;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.file) {
    process.stdout.write('Usage: node scripts/audit_deck.js <deck.pptx> [--json] [--min-text-shapes N]\n' +
      '       [--min-characters N] [--max-picture-coverage 0..1] [--fail-on-warning]\n');
    return options.help ? 0 : 1;
  }
  const report = await auditPptx(options.file);
  const failures = evaluate(report, options);
  if (options.json) {
    process.stdout.write(JSON.stringify(Object.assign({}, report, { failures }), null, 2) + '\n');
  } else if (!options.quiet) {
    process.stdout.write('Deck: ' + report.file + '\n');
    process.stdout.write('Slides: ' + report.slideCount +
      ' | text shapes: ' + report.totals.textShapes +
      ' | characters: ' + report.totals.characters +
      ' | pictures: ' + report.totals.pictures +
      ' | charts: ' + report.totals.charts +
      ' | tables: ' + report.totals.tables + '\n');
    report.slides.forEach((slide, index) => {
      process.stdout.write('  slide ' + (index + 1) + ': text=' + slide.textShapes +
        ' shapes=' + slide.shapes + ' chars=' + slide.characters +
        ' pics=' + slide.pictures + ' (cropped=' + slide.croppedPictures + ')' +
        ' charts=' + slide.charts + ' tables=' + slide.tables +
        ' picCoverage=' + slide.pictureCoverage.toFixed(2) + '\n');
    });
    report.findings.forEach((finding) => {
      process.stdout.write('  [' + finding.severity + '] ' + finding.slide + ' ' +
        finding.code + ': ' + finding.message + '\n');
    });
    if (failures.length) {
      process.stdout.write('FAILED (' + failures.length + ')\n');
      failures.forEach((failure) => process.stdout.write('  - ' + failure + '\n'));
    } else {
      process.stdout.write('OK: deck is editable and within the audit budgets.\n');
    }
  }
  return failures.length ? 1 : 0;
}

module.exports = { auditPptx, inspectSlide, inspectPictures, readPageSize, readTextCharacters, evaluate, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
