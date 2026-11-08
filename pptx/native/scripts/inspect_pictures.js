'use strict';
const fs = require('node:fs');
const JSZip = require('jszip');

(async () => {
  const file = process.argv[2] || 'native-images-demo.pptx';
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    const pics = xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) || [];
    console.log(name, 'pics=' + pics.length, 'graphicFrames=' + (xml.match(/<p:graphicFrame>/g) || []).length, 'sp=' + (xml.match(/<p:sp>/g) || []).length);
    pics.forEach((p, idx) => {
      const src = p.match(/<a:srcRect[^>]*\/>/);
      const geom = p.match(/<a:prstGeom prst="([^"]+)"/);
      const adj = p.match(/name="adj" fmla="val (\d+)"/);
      const ext = p.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
      const alpha = p.match(/alphaModFix amt="(\d+)"/);
      console.log('  pic' + idx,
        'srcRect=' + (src ? src[0] : '-'),
        'geom=' + (geom ? geom[1] + (adj ? '/' + adj[1] : '') : '?'),
        'ln=' + (/<a:ln /.test(p) ? 'y' : 'n'),
        'shadow=' + (/outerShdw/.test(p) ? 'y' : 'n'),
        'alpha=' + (alpha ? alpha[1] : '-'),
        'ext=' + (ext ? ext[1] + 'x' + ext[2] : '?'));
    });
  }
  const counts = {};
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    counts[name] = {
      srcRect: (xml.match(/<a:srcRect/g) || []).length,
      roundRect: (xml.match(/prst="roundRect"/g) || []).length,
      lines: (xml.match(/<a:ln /g) || []).length,
      shadows: (xml.match(/<a:outerShdw/g) || []).length,
      alpha: (xml.match(/<a:alpha /g) || []).length,
      alphaModFix: (xml.match(/<a:alphaModFix/g) || []).length
    };
  }
  console.log(JSON.stringify(counts, null, 2));
})();
