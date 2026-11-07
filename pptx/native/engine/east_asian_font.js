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
    const cleaned = inner.replace(/<a:ea\\b[^>]*\\/>/g, '');
    const latin = /<a:latin\\b[^>]*\\/>/.exec(cleaned);
    const next = latin
      ? cleaned.slice(0, latin.index + latin[0].length) + '<a:ea typeface="' + face + '"/>' + cleaned.slice(latin.index + latin[0].length)
      : cleaned + '<a:ea typeface="' + face + '"/>';
    return '<a:' + tagName + attributes + '>' + next + '</a:' + tagName + '>';
  });
}

function patchEastAsianFonts(xml, fontFace) {
  let output = xml;
  for (const tag of ['rPr', 'defRPr', 'endParaRPr']) {
    output = addEastAsianFontToProperties(output, tag, fontFace);
  }
  return output.replace(/<a:ea\\b[^>]*\\/>/g, '<a:ea typeface="' + escapeXml(fontFace) + '"/>');
}

module.exports = { patchEastAsianFonts };
