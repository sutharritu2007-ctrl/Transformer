// src/inspector/geometry.js
//
// Geometry and visibility for ONE record. Called from the traversal hook, so
// each element is measured exactly once, in the same pass that discovers it.
//
// Rule: this file only READS. Writing to the page (even a class name) between
// reads would force the browser to recompute layout over and over.
//
// Adds to the record:
//   bx      [x, y, w, h] in PAGE coordinates, integers (absent if no box)
//   vis     'visible' | 'hidden' | 'zero'
//   pos     'fixed' | 'sticky' | 'absolute' (only these; static/relative omitted)
// And may prune: display:none subtrees are never walked.
//
// Not covered on purpose: an element pushed far off-screen (left: -9999px) is
// still 'visible' here. The planner can see that from bx and meta.docSize.

const NOTABLE_POSITIONS = new Set(['fixed', 'sticky', 'absolute']);

/**
 * @param {object} rec        the record being enriched
 * @param {CSSStyleDeclaration} cs   getComputedStyle(rec.el), shared with styles.js
 * @param {object|null} parentRec
 * @param {{x:number,y:number}} scroll   scroll offset captured once per run
 */
export function measure(rec, cs, parentRec, scroll) {
  const display = cs.display;

  // opacity is NOT inherited by computed style, yet a child of an opacity:0
  // parent is invisible too. So we carry the flag down the tree ourselves.
  const opacityHidden = (parentRec !== null && parentRec.opacityHidden === true) || cs.opacity === '0';
  rec.opacityHidden = opacityHidden;

  // display:none removes the element AND all descendants from rendering.
  // Record the root of the hidden subtree, then never walk into it.
  if (display === 'none') {
    rec.vis = 'hidden';
    rec.descend = false;
    rec.hiddenSubtree = true;
    return;
  }

  // display:contents has no box of its own; its children render in its place.
  if (display === 'contents') {
    rec.vis = opacityHidden ? 'hidden' : 'visible';
    return;
  }

  const r = rec.el.getBoundingClientRect();
  rec.bx = [
    Math.round(r.left + scroll.x),
    Math.round(r.top + scroll.y),
    Math.round(r.width),
    Math.round(r.height),
  ];

  // visibility:hidden IS inherited, so the element's own computed value is
  // already correct (a child can even override it back to visible).
  if (cs.visibility !== 'visible' || opacityHidden) rec.vis = 'hidden';
  else if (r.width === 0 && r.height === 0) rec.vis = 'zero';
  else rec.vis = 'visible';

  if (NOTABLE_POSITIONS.has(cs.position)) rec.pos = cs.position;
}