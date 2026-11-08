'use strict';

const ELEMENT_TYPES = new Set(['text', 'shape', 'line', 'image', 'table', 'chart', 'container']);

const IMAGE_FITS = new Set(['stretch', 'fill', 'none', 'cover', 'contain', 'crop']);
const IMAGE_FOCUS_PRESETS = new Set([
  'center', 'centre', 'middle', 'top', 'bottom', 'left', 'right',
  'top left', 'top right', 'bottom left', 'bottom right',
  'left top', 'right top', 'left bottom', 'right bottom'
]);

function validateShadowOptions(prefix, element, errors) {
  const shadow = element.shadow;
  if (shadow === undefined || shadow === false || shadow === true) return;
  if (typeof shadow !== 'object' || Array.isArray(shadow)) {
    errors.push(prefix + '.shadow must be a boolean or options object');
    return;
  }
  if (shadow.opacity !== undefined && (!Number.isFinite(shadow.opacity) || shadow.opacity < 0 || shadow.opacity > 1)) {
    errors.push(prefix + '.shadow.opacity must be between 0 and 1');
  }
  ['blur', 'distance'].forEach((key) => {
    if (shadow[key] !== undefined && (!Number.isFinite(shadow[key]) || shadow[key] < 0)) {
      errors.push(prefix + '.shadow.' + key + ' must be finite and non-negative');
    }
  });
  if (shadow.angle !== undefined && !Number.isFinite(shadow.angle)) errors.push(prefix + '.shadow.angle must be finite');
  if (shadow.type !== undefined && !['outer', 'inner'].includes(shadow.type)) errors.push(prefix + '.shadow.type must be outer or inner');
  if (shadow.color !== undefined && (typeof shadow.color !== 'string' || !/^#?[0-9a-f]{6}$/iu.test(shadow.color))) {
    errors.push(prefix + '.shadow.color must be a six-digit hex color');
  }
}

function validateImageFit(prefix, element, errors) {
  if (element.fit !== undefined && !IMAGE_FITS.has(String(element.fit).toLowerCase())) {
    errors.push(prefix + '.fit must be one of: cover, contain, crop, stretch');
  }
  if (element.fit !== undefined && String(element.fit).toLowerCase() === 'crop') {
    const crop = element.crop;
    if (!crop || typeof crop !== 'object' || Array.isArray(crop)) {
      errors.push(prefix + '.crop is required when fit is crop');
    } else {
      ['left', 'top', 'right', 'bottom'].forEach((key) => {
        if (crop[key] !== undefined && (!Number.isFinite(crop[key]) || crop[key] < 0 || crop[key] > 1)) {
          errors.push(prefix + '.crop.' + key + ' must be between 0 and 1');
        }
      });
      const total = ['left', 'right'].reduce((sum, key) => sum + (Number.isFinite(crop[key]) ? crop[key] : 0), 0);
      const vertical = ['top', 'bottom'].reduce((sum, key) => sum + (Number.isFinite(crop[key]) ? crop[key] : 0), 0);
      if (total >= 1) errors.push(prefix + '.crop left + right must be less than 1');
      if (vertical >= 1) errors.push(prefix + '.crop top + bottom must be less than 1');
    }
  }
  if (element.crop !== undefined && element.fit === undefined) {
    errors.push(prefix + '.crop requires fit: "crop"');
  }
  if (element.focus !== undefined) {
    if (typeof element.focus === 'string') {
      const key = element.focus.trim().toLowerCase().replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ');
      if (!IMAGE_FOCUS_PRESETS.has(key)) errors.push(prefix + '.focus is not a known focal preset');
    } else if (!element.focus || typeof element.focus !== 'object' || Array.isArray(element.focus)) {
      errors.push(prefix + '.focus must be a preset name or an { x, y } object');
    } else {
      ['x', 'y'].forEach((key) => {
        if (element.focus[key] !== undefined && (!Number.isFinite(element.focus[key]) || element.focus[key] < 0 || element.focus[key] > 1)) {
          errors.push(prefix + '.focus.' + key + ' must be between 0 and 1');
        }
      });
    }
  }
  if (element.zoom !== undefined && (!Number.isFinite(element.zoom) || element.zoom < 1)) {
    errors.push(prefix + '.zoom must be a finite number greater than or equal to 1');
  }
  if (element.radius !== undefined && (!Number.isFinite(element.radius) || element.radius < 0)) {
    errors.push(prefix + '.radius must be finite and non-negative');
  }
  if (element.rotate !== undefined && !Number.isFinite(element.rotate)) errors.push(prefix + '.rotate must be finite');
  if (element.naturalSize !== undefined) {
    const size = element.naturalSize;
    if (!size || typeof size !== 'object' || Array.isArray(size) ||
        !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
      errors.push(prefix + '.naturalSize requires positive finite width and height');
    }
  }
  ['flipH', 'flipV'].forEach((key) => {
    if (element[key] !== undefined && typeof element[key] !== 'boolean') errors.push(prefix + '.' + key + ' must be a boolean');
  });
  if (element.altText !== undefined && typeof element.altText !== 'string') errors.push(prefix + '.altText must be a string');
  if (element.lineColor !== undefined && (typeof element.lineColor !== 'string' || !/^#?[0-9a-f]{6}$/iu.test(element.lineColor))) {
    errors.push(prefix + '.lineColor must be a six-digit hex color');
  }
  if (element.lineWidth !== undefined && (!Number.isFinite(element.lineWidth) || element.lineWidth < 0)) {
    errors.push(prefix + '.lineWidth must be finite and non-negative');
  }
  if (element.lineTransparency !== undefined &&
      (!Number.isFinite(element.lineTransparency) || element.lineTransparency < 0 || element.lineTransparency > 100)) {
    errors.push(prefix + '.lineTransparency must be between 0 and 100');
  }
}

function validateEdge(prefix, element, errors) {
  const edge = element && element.edge;
  if (edge === undefined) return;
  const at = prefix + '.edge';
  if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
    errors.push(at + ' must be an object');
    return;
  }
  if (!['top', 'right', 'bottom', 'left'].includes(edge.side)) {
    errors.push(at + '.side must be one of: top, right, bottom, left');
  }
  if (!Number.isFinite(edge.width) || edge.width <= 0) {
    errors.push(at + '.width must be a finite positive number of points');
  }
  if (typeof edge.color !== 'string' || !edge.color) {
    errors.push(at + '.color must be a color string');
  }
}

function validateDeck(deck) {
  const errors = [];
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) return ['Deck spec must be an object'];
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) errors.push('deck.slides must be a non-empty array');

  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  slides.forEach((slide, slideIndex) => {
    const prefix = 'slides[' + slideIndex + ']';
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) {
      errors.push(prefix + ' must be an object');
      return;
    }
    if (!Array.isArray(slide.elements)) {
      errors.push(prefix + '.elements must be an array');
      return;
    }
    slide.elements.forEach((element, elementIndex) => {
      validateElement(prefix + '.elements[' + elementIndex + ']', element, errors);
    });
  });
  return errors;
}

function validateContainer(prefix, element, errors) {
  if (element.children !== undefined && !Array.isArray(element.children)) {
    errors.push(prefix + '.children must be an array');
    return;
  }
  if (element.direction !== undefined && !['row', 'column'].includes(element.direction)) {
    errors.push(prefix + '.direction must be row or column');
  }
  if (element.columns !== undefined && (!Number.isInteger(element.columns) || element.columns < 1)) {
    errors.push(prefix + '.columns must be a positive integer');
  }
  if (element.gap !== undefined && (!Number.isFinite(element.gap) || element.gap < 0)) {
    errors.push(prefix + '.gap must be finite and non-negative');
  }
  ['rowGap', 'columnGap'].forEach((key) => {
    if (element[key] !== undefined && (!Number.isFinite(element[key]) || element[key] < 0)) {
      errors.push(prefix + '.' + key + ' must be finite and non-negative');
    }
  });
  if (element.align !== undefined && !['start', 'center', 'end', 'stretch'].includes(element.align)) {
    errors.push(prefix + '.align must be one of: start, center, end, stretch');
  }
  if (element.columnSpan !== undefined) {
    if (!Number.isInteger(element.columnSpan) || element.columnSpan < 1) {
      errors.push(prefix + '.columnSpan must be a positive integer');
    }
  }
  if (element.rowSpan !== undefined) {
    if (!Number.isInteger(element.rowSpan) || element.rowSpan < 1) {
      errors.push(prefix + '.rowSpan must be a positive integer');
    }
  }
  if (element.crossGap !== undefined && (!(Number.isFinite(element.crossGap)) || element.crossGap < 0)) {
    errors.push(prefix + '.crossGap must be a non-negative number');
  }
  if (element.alignContent !== undefined
    && !['start', 'center', 'end', 'flex-start', 'flex-end', 'space-between', 'space-around', 'space-evenly', 'stretch', 'normal'].includes(element.alignContent)) {
    errors.push(prefix + '.alignContent is not a recognised value');
  }
  if (element.justifySelf !== undefined
    && !['start', 'center', 'end', 'stretch'].includes(element.justifySelf)) {
    errors.push(prefix + '.justifySelf must be one of: start, center, end, stretch');
  }
  ['gridColumnStart', 'gridRowStart'].forEach((key) => {
    if (element[key] !== undefined
      && (!Number.isInteger(element[key]) || element[key] < 0)) {
      errors.push(prefix + '.' + key + ' must be a non-negative integer cell index');
    }
  });
  if (element.overlays !== undefined) {
    if (!Array.isArray(element.overlays)) {
      errors.push(prefix + '.overlays must be an array');
    } else {
      element.overlays.forEach((overlay, index) => {
        const label = prefix + '.overlays[' + index + ']';
        if (!overlay || typeof overlay !== 'object') {
          errors.push(label + ' must be an object');
          return;
        }
        ['x', 'y', 'w', 'h'].forEach((key) => {
          const value = overlay[key];
          if (key === 'x' || key === 'y') {
            if (value !== undefined && (!Number.isFinite(value))) errors.push(label + '.' + key + ' must be finite');
            return;
          }
          if (!Number.isFinite(value) || value <= 0) errors.push(label + '.' + key + ' must be a positive number');
        });
        if (overlay.fill !== undefined && typeof overlay.fill !== 'string') {
          errors.push(label + '.fill must be a hex colour string');
        }
        if (overlay.text !== undefined && typeof overlay.text !== 'string') {
          errors.push(label + '.text must be a string');
        }
      });
    }
  }
  if (element.columnTracks !== undefined) {
    if (!Array.isArray(element.columnTracks) || !element.columnTracks.length) {
      errors.push(prefix + '.columnTracks must be a non-empty array');
    } else {
      element.columnTracks.forEach((track, index) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) {
          errors.push(prefix + '.columnTracks[' + index + '] must be an object');
          return;
        }
        const hasFr = Number.isFinite(track.fr) && track.fr > 0;
        const hasWidth = Number.isFinite(track.width) && track.width > 0;
        if (!hasFr && !hasWidth) {
          errors.push(prefix + '.columnTracks[' + index + '] needs a positive fr or width');
        }
      });
    }
  }
  if (element.rowTracks !== undefined) {
    if (!Array.isArray(element.rowTracks) || !element.rowTracks.length) {
      errors.push(prefix + '.rowTracks must be a non-empty array');
    } else {
      element.rowTracks.forEach((track, index) => {
        const fixed = track && Number.isFinite(track.height) && track.height >= 0;
        const auto = track && track.auto === true;
        const fractional = track && Number.isFinite(track.fr) && track.fr > 0;
        if (!fixed && !auto && !fractional) {
          errors.push(prefix + '.rowTracks[' + index
            + '] needs a non-negative height, a positive fr, or auto: true');
        }
        if (fractional && element.rowContentHeight !== undefined
          && !Number.isFinite(element.rowContentHeight)) {
          errors.push(prefix + '.rowContentHeight must be a number when a row uses fr');
        }
      });
    }
  }
  if (element.autoRowHeight !== undefined
    && (!Number.isFinite(element.autoRowHeight) || element.autoRowHeight <= 0)) {
    errors.push(prefix + '.autoRowHeight must be a positive number');
  }
  if (element.rowContentHeight !== undefined && !Number.isFinite(element.rowContentHeight)) {
    errors.push(prefix + '.rowContentHeight must be a number');
  }
  if (element.alignSelf !== undefined && !['start', 'center', 'end', 'stretch'].includes(element.alignSelf)) {
    errors.push(prefix + '.alignSelf must be one of: start, center, end, stretch');
  }
  if (element.justify !== undefined && !['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'].includes(element.justify)) {
    errors.push(prefix + '.justify must be one of: start, center, end, space-between, space-around, space-evenly');
  }
  if (element.padding !== undefined) {
    if (typeof element.padding === 'number') {
      if (!Number.isFinite(element.padding) || element.padding < 0) {
        errors.push(prefix + '.padding must be finite and non-negative');
      }
    } else if (!element.padding || typeof element.padding !== 'object' || Array.isArray(element.padding)) {
      errors.push(prefix + '.padding must be a number or { top, right, bottom, left } object');
    } else {
      ['top', 'right', 'bottom', 'left'].forEach((key) => {
        if (element.padding[key] !== undefined && (!Number.isFinite(element.padding[key]) || element.padding[key] < 0)) {
          errors.push(prefix + '.padding.' + key + ' must be finite and non-negative');
        }
      });
    }
  }
  (element.children || []).forEach((child, index) => {
    validateElement(prefix + '.children[' + index + ']', child, errors);
  });
  if (element.background !== undefined && element.background !== true) {
    if (!element.background || typeof element.background !== 'object' || Array.isArray(element.background)) {
      errors.push(prefix + '.background must be true or a shape style object');
    } else {
      validateElement(prefix + '.background', Object.assign({ type: 'shape' }, element.background), errors);
    }
  }
}

function validateElement(p, element, errors) {
      if (!element || typeof element !== 'object' || Array.isArray(element)) {
        errors.push(p + ' must be an object');
        return;
      }
      if (!ELEMENT_TYPES.has(element.type)) errors.push(p + '.type must be one of: ' + Array.from(ELEMENT_TYPES).join(', '));
      if (element.type === 'container') {
        validateContainer(p, element, errors);
        // A shape may bleed off the canvas (CSS `right: -120px` on a decoration),
        // so only the sizes are non-negative; a position is any finite number.
        ['x', 'y'].forEach((key) => {
          if (element[key] !== undefined && !Number.isFinite(element[key])) {
            errors.push(p + '.' + key + ' must be a finite number');
          }
        });
        ['w', 'h'].forEach((key) => {
          if (element[key] !== undefined && (!Number.isFinite(element[key]) || element[key] < 0)) {
            errors.push(p + '.' + key + ' must be a finite non-negative number');
          }
        });
        return;
      }
      if (element.type === 'text' && typeof element.text !== 'string' && !Array.isArray(element.text)) {
        errors.push(p + '.text must be a string or rich-text run array');
      }
      if (element.type === 'text' && Array.isArray(element.text) && element.text.some((run) => typeof run !== 'string' && (!run || typeof run !== 'object' || Array.isArray(run) || typeof run.text !== 'string'))) {
        errors.push(p + '.text rich-text runs must be strings or objects with a text field');
      }
      if (element.type === 'text' && Array.isArray(element.text)) {
        element.text.forEach((run, runIndex) => {
          if (typeof run === 'string' || !run || typeof run !== 'object') return;
          if (run.options !== undefined && (!run.options || typeof run.options !== 'object' || Array.isArray(run.options))) {
            errors.push(p + '.text[' + runIndex + '].options must be an object');
          }
          if (run.options && run.options.fontSize !== undefined &&
              (!Number.isFinite(run.options.fontSize) || run.options.fontSize <= 0)) {
            errors.push(p + '.text[' + runIndex + '].options.fontSize must be finite and greater than zero');
          }
          if (run.options && run.options.transparency !== undefined &&
              (!Number.isFinite(run.options.transparency) || run.options.transparency < 0 || run.options.transparency > 100)) {
            errors.push(p + '.text[' + runIndex + '].options.transparency must be between 0 and 100');
          }
        });
      }
      if (element.type === 'image' && !element.path && !element.data) errors.push(p + ' requires path or data');
      if (element.type === 'image' && element.path && element.data) errors.push(p + ' must specify either path or data, not both');
      if (element.type === 'image' && element.transparency !== undefined &&
          (!Number.isFinite(element.transparency) || element.transparency < 0 || element.transparency > 100)) {
        errors.push(p + '.transparency must be between 0 and 100');
      }
      if (element.type === 'image') {
        validateImageFit(p, element, errors);
        validateShadowOptions(p, element, errors);
      }
      if (element.type === 'line' && element.width !== undefined &&
          (!Number.isFinite(element.width) || element.width <= 0)) {
        errors.push(p + '.width must be finite and greater than zero');
      }
      if (element.type === 'text' && element.transparency !== undefined &&
          (!Number.isFinite(element.transparency) || element.transparency < 0 || element.transparency > 100)) {
        errors.push(p + '.transparency must be between 0 and 100');
      }
      if (element.type === 'text' && element.fontSize !== undefined &&
          (!Number.isFinite(element.fontSize) || element.fontSize <= 0)) {
        errors.push(p + '.fontSize must be finite and greater than zero');
      }
      if (element.type === 'text') {
        ['charSpacing', 'paraSpaceBeforePt', 'paraSpaceAfterPt'].forEach((key) => {
          if (element[key] !== undefined && (!Number.isFinite(element[key]) || (key !== 'charSpacing' && element[key] < 0))) {
            errors.push(p + '.' + key + ' must be finite' + (key === 'charSpacing' ? '' : ' and non-negative'));
          }
        });
        if (element.lineSpacingMultiple !== undefined &&
            (!Number.isFinite(element.lineSpacingMultiple) || element.lineSpacingMultiple <= 0)) {
          errors.push(p + '.lineSpacingMultiple must be finite and greater than zero');
        }
        if (element.textIndent !== undefined && !Number.isFinite(element.textIndent)) {
          errors.push(p + '.textIndent must be a number of inches');
        }
        if (element.nowrap !== undefined && typeof element.nowrap !== 'boolean') {
          errors.push(p + '.nowrap must be a boolean');
        }
        if (element.vert !== undefined && !['eaVert', 'vert', 'vert270', 'mongolianVert'].includes(element.vert)) {
          errors.push(p + '.vert must be one of: eaVert, vert, vert270, mongolianVert');
        }
        if (element.fixedWidth !== undefined && typeof element.fixedWidth !== 'boolean') {
          errors.push(p + '.fixedWidth must be a boolean');
        }
        if (element.fixedHeight !== undefined && typeof element.fixedHeight !== 'boolean') {
          errors.push(p + '.fixedHeight must be a boolean');
        }
        if (element.relativeShift !== undefined) {
          const shift = element.relativeShift;
          if (!shift || typeof shift !== 'object' || !Number.isFinite(shift.dx) || !Number.isFinite(shift.dy)) {
            errors.push(p + '.relativeShift must be an object with finite dx and dy');
          }
        }
        if (element.bullet !== undefined && typeof element.bullet !== 'boolean' &&
            (typeof element.bullet !== 'object' || element.bullet === null || Array.isArray(element.bullet))) {
          errors.push(p + '.bullet must be a boolean or options object');
        }
      }
      validateEdge(p, element);
      if (element.type === 'line' && element.transparency !== undefined &&
          (!Number.isFinite(element.transparency) || element.transparency < 0 || element.transparency > 100)) {
        errors.push(p + '.transparency must be between 0 and 100');
      }
      if (element.type === 'shape') {
        ['transparency', 'fillTransparency', 'lineTransparency'].forEach((key) => {
          if (element[key] !== undefined && (!Number.isFinite(element[key]) || element[key] < 0 || element[key] > 100)) {
            errors.push(p + '.' + key + ' must be between 0 and 100');
          }
        });
        if (element.rotate !== undefined && !Number.isFinite(element.rotate)) errors.push(p + '.rotate must be finite');
        if (element.radius !== undefined && (!Number.isFinite(element.radius) || element.radius < 0)) errors.push(p + '.radius must be finite and non-negative');
        ['fill', 'lineColor'].forEach((key) => {
          if (typeof element[key] === 'string' && !/^#?[0-9a-f]{6}$/iu.test(element[key])) {
            errors.push(p + '.' + key + ' must be a six-digit hex color');
          }
        });
        validateShadowOptions(p, element, errors);
      }
      if (element.gradient !== undefined) {
        if (element.type !== 'shape') errors.push(p + '.gradient is only supported on shapes');
        const stops = element.gradient && element.gradient.stops;
        if (!Array.isArray(stops) || stops.length < 2) errors.push(p + '.gradient.stops must contain at least two stops');
        else stops.forEach((stop, stopIndex) => {
          if (!stop || typeof stop.color !== 'string' || !/^#?[0-9a-f]{6}$/iu.test(stop.color)) errors.push(p + '.gradient.stops[' + stopIndex + '].color must be a six-digit hex color');
          if (!Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1) errors.push(p + '.gradient.stops[' + stopIndex + '].position must be between 0 and 1');
          if (stop.transparency !== undefined && (!Number.isFinite(stop.transparency) || stop.transparency < 0 || stop.transparency > 100)) errors.push(p + '.gradient.stops[' + stopIndex + '].transparency must be between 0 and 100');
        });
        if (element.gradient && element.gradient.angle !== undefined && !Number.isFinite(element.gradient.angle)) errors.push(p + '.gradient.angle must be finite');
      }
      if (element.type === 'chart') {
        const chartTypes = new Set(['bar', 'line', 'pie', 'doughnut', 'area']);
        if (element.chartType !== undefined && !chartTypes.has(element.chartType)) errors.push(p + '.chartType is not supported');
        if (!Array.isArray(element.data) || element.data.length === 0) {
          errors.push(p + '.data must be a non-empty chart series array');
        } else {
          element.data.forEach((series, seriesIndex) => {
            if (!series || !Array.isArray(series.labels) || !Array.isArray(series.values) || series.labels.length !== series.values.length || series.values.some((value) => !Number.isFinite(value))) {
              errors.push(p + '.data[' + seriesIndex + '] must have matching labels and finite numeric values');
            }
          });
        }
      }
      ['x', 'y'].forEach((key) => {
        if (element[key] !== undefined && !Number.isFinite(element[key])) {
          errors.push(p + '.' + key + ' must be a finite number');
        }
      });
      ['w', 'h'].forEach((key) => {
        if (element[key] !== undefined && (!Number.isFinite(element[key]) || element[key] < 0)) {
          errors.push(p + '.' + key + ' must be a finite non-negative number');
        }
      });
      if (element.type === 'line') {
        if (element.w === 0 && element.h === 0) errors.push(p + ' line must have a non-zero width or height');
      } else {
        ['w', 'h'].forEach((key) => {
          if (element[key] === 0) errors.push(p + '.' + key + ' must be greater than zero');
        });
      }
}

module.exports = { ELEMENT_TYPES, validateDeck, validateElement };
