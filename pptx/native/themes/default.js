'use strict';

module.exports = {
  name: 'editorial-light',
  colors: {
    background: 'F7F7F4',
    foreground: '202321',
    primary: '183B3A',
    accent: 'D36B45',
    muted: '6B7470',
    surface: 'FFFFFF',
    border: 'DCE2DE'
  },
  fonts: { heading: 'Aptos Display', body: 'Aptos', cjk: 'Microsoft YaHei' },
  // display and micro are the two ends the original's --fs-display / --fs-micro tokens covered:
  // a statement number or a one-word cover, and the axis labels and footnotes that must stay quiet.
  sizes: { display: 44, title: 30, heading: 22, body: 16, caption: 10, micro: 9 },
  margins: { x: 0.58, y: 0.5 },
  lineSpacingMultiple: 1.18
};
