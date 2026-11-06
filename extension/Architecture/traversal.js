// src/inspector/traversal.js
//
// Walks the DOM once, breadth-first, and produces the internal WORKING LIST:
// one plain record per kept element. Later stages (geometry, text, styles...)
// add fields to these records. The blueprint is built from them at the end.
//
// This stage is purely STRUCTURAL: it reads no styles and no layout. That
// keeps it fast and easy to test. It asks safety.js before entering anything.
//
// A record looks like:
//   id        "e12"           temporary reference
//   el        <the element>   PRIVATE: must never be serialized
//   parent    index of the parent record in the list (-1 for the root)
//   depth     0 for the root
//   tag       lowercase tag name
//   children  ids of kept children, in DOM order
//   omitted   children dropped because of a budget
//   protect   null | 'frame' | 'editable' | 'sensitive'
//   descend   whether we entered this element's children
//   shadow    null | 'open' | 'closed' (children came from a shadow root)

import { classifyElement } from './safety.js';

// Closed shadow roots are only reachable through the extension API.
// (Outside an extension, e.g. the demo page, only open roots are visible.)
function getShadowRoot(el) {
  try {
    if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
      return chrome.dom.openOrClosedShadowRoot(el);
    }
  } catch (_) {
    // fall through to the standard property
  }
  return el.shadowRoot;
}

// The children that are actually RENDERED under an element:
//  - a <slot> renders the light-DOM elements assigned to it
//  - a shadow host renders its shadow root's children
//    (its own light-DOM children only appear if a <slot> places them)
//  - anything else renders its ordinary children
function getChildElements(el) {
  if (el.localName === 'slot' && typeof el.assignedElements === 'function') {
    const assigned = el.assignedElements({ flatten: true });
    if (assigned.length > 0) return { children: assigned, shadow: null };
    // no assigned content: the slot's own fallback children render instead
  }
  const root = getShadowRoot(el);
  if (root) return { children: Array.from(root.children), shadow: root.mode };
  return { children: Array.from(el.children), shadow: null };
}

/**
 * @param {Element} root       where to start (usually document.body)
 * @param {object}  options
 * @param {object}  options.registry   from createRegistry()
 * @param {number}  options.maxNodes   stop recording after this many elements
 * @param {number}  options.maxDepth   do not descend below this depth
 * @param {function} options.onRecord  optional hook, called once per new record
 *        as (record, parentRecord|null) BEFORE the record's children are
 *        visited. It may add fields to the record, and may set
 *        `record.descend = false` to prune the subtree (e.g. display:none).
 *        This is how geometry, styles and text are collected in ONE pass.
 * @returns {{ records: object[], stats: object, warnings: object[] }}
 */
export function traverse(root, { registry, maxNodes = 1500, maxDepth = 60, onRecord = null } = {}) {
  if (!registry) throw new Error('traverse() needs a registry');

  const t0 = performance.now();
  const records = [];
  const warnings = [];
  const stats = {
    visited: 0,
    skipped: 0,
    kept: 0,
    maxDepthSeen: 0,   // deepest kept record, relative to `root`
    elementsInRoot: 0, // how big the subtree really is (light DOM only)
    elapsedMs: 0,
  };

  // Cheap up-front size. The walk below stops when a budget hits, so it can't
  // tell us how much it left behind; this number can. It excludes shadow DOM
  // contents and includes elements we later skip (script, style...).
  stats.elementsInRoot = root.getElementsByTagName('*').length;
  let nodeBudgetWarned = false;
  let depthBudgetWarned = false;

  const addRecord = (el, parent, depth, decision) => {
    const rec = {
      id: registry.assign(el),
      el,
      parent,
      depth,
      tag: el.localName,
      children: [],
      omitted: 0,
      protect: decision.protect,
      descend: decision.descend,
      shadow: null,
    };
    records.push(rec);
    if (depth > stats.maxDepthSeen) stats.maxDepthSeen = depth;
    if (decision.protect === 'frame') warnings.push({ code: 'opaque-frame', node: rec.id });
    if (onRecord) onRecord(rec, parent >= 0 ? records[parent] : null);
    return rec;
  };

  const finish = () => {
    stats.kept = records.length;
    stats.elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
    return { records, stats, warnings };
  };

  // --- the root ---------------------------------------------------------
  stats.visited++;
  const rootDecision = classifyElement(root);
  if (rootDecision.action === 'skip') {
    stats.skipped++;
    return finish();
  }
  addRecord(root, -1, 0, rootDecision);

  // --- breadth-first walk ----------------------------------------------
  // The records array IS the queue: new records are appended at the end, and
  // `i` is a read cursor moving through it. Because parents are always
  // processed before their children, the order is breadth-first, so shallow
  // structure (header, nav, main) is recorded before deep leaves and a budget
  // cuts the least structural content first.
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec.descend) continue;

    const { children, shadow } = getChildElements(rec.el);
    rec.shadow = shadow;

    if (rec.depth >= maxDepth) {
      rec.omitted = children.length;
      if (children.length > 0 && !depthBudgetWarned) {
        depthBudgetWarned = true;
        warnings.push({ code: 'budget-depth', node: rec.id });
      }
      continue;
    }

    for (const child of children) {
      stats.visited++;

      const decision = classifyElement(child);
      if (decision.action === 'skip') {
        stats.skipped++;
        continue;
      }

      // Safety net: an element must never be recorded twice.
      if (registry.idOf(child) !== null) continue;

      if (records.length >= maxNodes) {
        rec.omitted++;
        if (!nodeBudgetWarned) {
          nodeBudgetWarned = true;
          warnings.push({ code: 'budget-nodes' });
        }
        continue;
      }

      const childRec = addRecord(child, i, rec.depth + 1, decision);
      rec.children.push(childRec.id);
    }
  }

  return finish();
}