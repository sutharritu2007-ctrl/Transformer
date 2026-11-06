// src/inspector/traversal.js
//
// Walks the DOM once, breadth-first, and produces the internal WORKING LIST:
// one plain record per kept element. Later stages (geometry, text, styles...)
// add fields to these records. The blueprint is built from them at the end.
//
// This stage is STRUCTURAL: it reads no styles and no layout itself. Other
// stages attach through the `onRecord` hook. It asks safety.js before
// entering anything.
//
// A record looks like:
//   id        "e12"           temporary reference
//   el        <the element>   PRIVATE: must never be serialized
//   parent    index of the parent record in the list (-1 for the root)
//   depth     0 for the root
//   tag       lowercase tag name
//   children  ids of recorded children, in DOM order
//   omitted   children dropped because a budget ran out
//   repeated  children dropped because they repeat kept siblings (sampling)
//   protect   null | 'frame' | 'editable' | 'sensitive'
//   descend   whether we entered this element's children
//   shadow    null | 'open' | 'closed' (children came from a shadow root)
//   collapsed true if this is an inert pass-through wrapper (folded away)
//   drop      true if this is an invisible empty leaf (left out entirely)
//
// Folded and dropped records still exist in the registry, so the engine can
// reach them later; they just do not appear in the blueprint or in the budget.

import { classifyElement } from './safety.js';

// Repeated-component sampling. Applies only to siblings that look like
// COMPONENTS (they have element children of their own), never to plain text
// blocks: 40 paragraphs in an article are content, 80 product cards are a grid.
//   threshold         sample only when more than this many siblings share a shape
//   keep              how many of each shape to record
//   minChildElements  a sibling needs at least this many element children
//                     to count as a component (leaf-like elements are never sampled)
const DEFAULT_SAMPLE = { threshold: 12, keep: 6, minChildElements: 2 };

// Wrapper folding. Modern pages nest several layout-only <div>s around every
// piece of content. A wrapper is folded away only when it adds NOTHING we can
// see: it has exactly one recorded child, the same box as that child, no look
// of its own, no role, no text, no name, and it is not interactive or protected.
const WRAPPER_TAGS = new Set(['div', 'span']);
// Invisible, empty, decorative leaves (zero-size, no children, no text).
const EMPTY_LEAF_TAGS = new Set(['div', 'span', 'i']);

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

// A cheap structural fingerprint: tag + class attribute + tags of the first few
// children. Two siblings with the same fingerprint are treated as the same kind
// of component. Class names are used here as internal evidence only; they are
// never written to the blueprint.
function shapeSignature(el, minChildElements) {
  if (el.childElementCount < minChildElements) return null; // leaf-like: never sampled
  const tags = [];
  for (let c = el.firstElementChild; c && tags.length < 6; c = c.nextElementSibling) {
    tags.push(c.localName);
  }
  const cls = (el.getAttribute('class') || '').trim().replace(/\s+/g, ' ');
  return el.localName + '|' + cls + '|' + tags.join(',');
}

// `rec.plain` is set by the enrichment hook: visible, no background, no
// background image, no rounded corners, not positioned.
function isPlainWrapper(rec) {
  return (
    rec.plain === true &&
    WRAPPER_TAGS.has(rec.tag) &&
    rec.shadow === null &&
    !rec.protect && !rec.role && !rec.ik && !rec.n && !rec.tx && !rec.lv
  );
}

function isEmptyLeaf(rec) {
  return (
    EMPTY_LEAF_TAGS.has(rec.tag) &&
    rec.vis === 'zero' &&
    rec.el.childElementCount === 0 &&
    getShadowRoot(rec.el) === null &&
    !rec.protect && !rec.role && !rec.ik && !rec.n && !rec.tx
  );
}

// Equal boxes mean the wrapper adds no padding, border or offset of its own.
function sameBox(a, b) {
  return Boolean(a && b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * @param {Element} root       where to start (usually document.body)
 * @param {object}  options
 * @param {object}  options.registry   from createRegistry()
 * @param {number}  options.maxNodes   budget for nodes IN THE BLUEPRINT (folded
 *                                     wrappers and dropped leaves do not count)
 * @param {number}  options.maxDepth   do not descend below this depth
 * @param {number}  options.maxMs      hard time limit; the walk stops and says so
 * @param {object|null} options.sample repeated-component sampling (null turns it off)
 * @param {boolean} options.fold       fold inert wrappers / drop invisible empty
 *                                     leaves (false shows the raw structure)
 * @param {function} options.onRecord  optional hook, called once per new record
 *        as (record, parentRecord|null) BEFORE the record's children are
 *        visited. It may add fields to the record, and may set
 *        `record.descend = false` to prune the subtree (e.g. display:none).
 *        This is how geometry, styles and text are collected in ONE pass.
 * @returns {{ records: object[], stats: object, warnings: object[] }}
 */
export function traverse(
  root,
  {
    registry,
    maxNodes = 1500,
    maxDepth = 60,
    maxMs = 250,
    sample = DEFAULT_SAMPLE,
    fold = true,
    onRecord = null,
  } = {}
) {
  if (!registry) throw new Error('traverse() needs a registry');

  const t0 = performance.now();
  const records = [];
  const warnings = [];
  const stats = {
    visited: 0,
    skipped: 0,
    sampled: 0,        // children dropped as repeats of kept siblings
    collapsed: 0,      // inert wrappers folded away
    emptyDropped: 0,   // invisible empty leaves left out
    recorded: 0,       // records made (includes folded and dropped ones)
    kept: 0,           // nodes that end up in the blueprint
    maxDepthSeen: 0,   // deepest record, relative to `root` (raw DOM depth)
    elementsInRoot: 0, // how big the subtree really is (light DOM only)
    elapsedMs: 0,
  };

  // Cheap up-front size. The walk below stops when a budget hits, so it can't
  // tell us how much it left behind; this number can. It excludes shadow DOM
  // contents and includes elements we later skip (script, style...).
  stats.elementsInRoot = root.getElementsByTagName('*').length;

  let used = 0; // nodes counted against maxNodes
  let nodeBudgetWarned = false;
  let depthBudgetWarned = false;
  let sampledWarned = false;

  const addRecord = (el, parent, depth, decision) => {
    const rec = {
      id: registry.assign(el),
      el,
      parent,
      depth,
      tag: el.localName,
      children: [],
      omitted: 0,
      repeated: 0,
      protect: decision.protect,
      descend: decision.descend,
      shadow: null,
      collapsed: false,
      drop: false,
    };
    records.push(rec);
    used++;
    if (depth > stats.maxDepthSeen) stats.maxDepthSeen = depth;
    if (decision.protect === 'frame') warnings.push({ code: 'opaque-frame', node: rec.id });
    if (onRecord) onRecord(rec, parent >= 0 ? records[parent] : null);
    return rec;
  };

  const finish = () => {
    stats.recorded = records.length;
    stats.kept = records.length - stats.collapsed - stats.emptyDropped;
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
    // Time budget: checked every 32 records (performance.now() is cheap, but
    // not free). Records not yet entered keep an approximate `omitted` count.
    if ((i & 31) === 0 && performance.now() - t0 > maxMs) {
      warnings.push({ code: 'budget-time' });
      for (let j = i; j < records.length; j++) {
        const pending = records[j];
        if (pending.descend && pending.children.length === 0) {
          pending.omitted = pending.el.childElementCount;
        }
      }
      break;
    }

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

    // Sampling prep: fingerprint the children, but only for big sibling lists.
    let sigs = null;
    let totals = null;
    if (sample && children.length > sample.threshold) {
      sigs = children.map((child) => shapeSignature(child, sample.minChildElements));
      totals = new Map();
      for (const sig of sigs) {
        if (sig) totals.set(sig, (totals.get(sig) || 0) + 1);
      }
    }
    const keptBySig = new Map();
    const childRecs = [];

    for (let k = 0; k < children.length; k++) {
      const child = children[k];
      stats.visited++;

      const decision = classifyElement(child);
      if (decision.action === 'skip') {
        stats.skipped++;
        continue;
      }

      // Safety net: an element must never be recorded twice.
      if (registry.idOf(child) !== null) continue;

      // Repeated component: keep the first few of this shape, count the rest.
      const sig = sigs ? sigs[k] : null;
      if (sig && totals.get(sig) > sample.threshold) {
        const already = keptBySig.get(sig) || 0;
        if (already >= sample.keep) {
          rec.repeated++;
          stats.sampled++;
          if (!sampledWarned) {
            sampledWarned = true;
            warnings.push({ code: 'repeats-sampled' });
          }
          continue;
        }
        keptBySig.set(sig, already + 1);
      }

      if (used >= maxNodes) {
        rec.omitted++;
        if (!nodeBudgetWarned) {
          nodeBudgetWarned = true;
          warnings.push({ code: 'budget-nodes' });
        }
        continue;
      }

      const childRec = addRecord(child, i, rec.depth + 1, decision);
      rec.children.push(childRec.id);
      childRecs.push(childRec);

      // Invisible, empty, decorative leaf: leave it out of the blueprint and
      // do not charge the budget for it.
      if (fold && isEmptyLeaf(childRec)) {
        childRec.drop = true;
        stats.emptyDropped++;
        used--;
      }
    }

    // Wrapper folding: exactly one real child, same box, nothing of its own.
    if (fold && i > 0 && rec.omitted === 0 && rec.repeated === 0) {
      const live = childRecs.filter((c) => !c.drop);
      if (live.length === 1 && isPlainWrapper(rec) && sameBox(rec.bx, live[0].bx)) {
        rec.collapsed = true;
        stats.collapsed++;
        used--;
      }
    }
  }

  return finish();
}