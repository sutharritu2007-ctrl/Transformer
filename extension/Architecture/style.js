// src/inspector/styles.js
//
// Collects a SMALL, allowlisted set of computed styles and interns them:
// identical combinations are stored once in a table, and records only keep a
// short reference ("s4"). A page with 2,000 elements usually has a few dozen
// distinct looks, so the table stays small.
//
// Allowlist (v0.1): display, flow, font, fs, fw, color, bg, bgImg, radius.
// Deliberately NOT collected: padding/margin/gap (derivable from boxes),
// border, shadow, z-index, transform, any URL.

export function createStyleTable() {
  const idByKey = new Map();
  const table = {};
  let counter = 0;

  return {
    table,

    /** Store an entry (or find the identical one) and return its id. */
    intern(entry) {
      // Entries are always built with keys in the same order, so the JSON
      // string is a reliable identity key.
      const key = JSON.stringify(entry);
      let id = idByKey.get(key);
      if (!id) {
        id = 's' + ++counter;
        idByKey.set(key, id);
        table[id] = entry;
      }
      return id;
    },

    get size() {
      return counter;
    },
  };
}

function firstFamily(value) {
  return (value || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {object} rec
 * @param {CSSStyleDeclaration} cs   the same object geometry.js used
 * @param {object} styles            from createStyleTable()
 */
export function collectStyle(rec, cs, styles) {
  const display = cs.display;

  const entry = {
    display,
    font: firstFamily(cs.fontFamily),
    fs: round1(parseFloat(cs.fontSize) || 0),
    fw: parseInt(cs.fontWeight, 10) || 400,
    color: cs.color,
    bg: cs.backgroundColor, // often transparent; effective background is a later concern
  };

  if (display.includes('flex')) {
    entry.flow = cs.flexDirection.startsWith('column') ? 'column' : 'row';
  } else if (display.includes('grid')) {
    entry.flow = 'grid';
  }

  // Only the fact that a background image exists. The URL is never stored.
  if (cs.backgroundImage && cs.backgroundImage !== 'none') entry.bgImg = true;

  if (cs.borderRadius && cs.borderRadius !== '0px') entry.radius = cs.borderRadius;

  rec.st = styles.intern(entry);
}