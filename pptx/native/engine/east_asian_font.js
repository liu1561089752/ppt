'use strict';

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function addEastAsianFontToProperties(xml, tagName, fontFace) {
  const face = escapeXml(fontFace);
  const selfClosing = new RegExp('<a:' + tagName + '\\b([^>]*)\\s*/>', 'g');
  xml = xml.replace(selfClosing, '<a:' + tagName + '$1><a:ea typeface="' + face + '"/></a:' + tagName + '>');
  const paired = new RegExp('<a:' + tagName + '\\b([^>]*)>([\\s\\S]*?)</a:' + tagName + '>', 'g');
  return xml.replace(paired, (match, attributes, inner) => {
    const cleaned = inner.replace(new RegExp('<a:ea\\b[^>]*\\/>', 'g'), '');
    const latin = new RegExp('<a:latin\\b[^>]*\\/>').exec(cleaned);
    const fallback = new RegExp('<a:(?:cs|sym|hlinkClick|hlinkMouseOver|rtl|extLst)\\b').exec(cleaned);
    const insertion = '<a:ea typeface="' + face + '"/>';
    let next;
    if (latin) {
      const position = latin.index + latin[0].length;
      next = cleaned.slice(0, position) + insertion + cleaned.slice(position);
    } else if (fallback) {
      next = cleaned.slice(0, fallback.index) + insertion + cleaned.slice(fallback.index);
    } else {
      next = cleaned + insertion;
    }
    return '<a:' + tagName + attributes + '>' + next + '</a:' + tagName + '>';
  });
}

function patchEastAsianFonts(xml, fontFace) {
  let output = xml;
  for (const tag of ['rPr', 'defRPr', 'endParaRPr']) {
    output = addEastAsianFontToProperties(output, tag, fontFace);
  }
  return output.replace(new RegExp('<a:ea\\b[^>]*\\/>', 'g'), '<a:ea typeface="' + escapeXml(fontFace) + '"/>');
}

module.exports = { patchEastAsianFonts };
