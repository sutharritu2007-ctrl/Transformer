// src/inspector/inspect.js
//
// The orchestrator: the one function the content script calls.
//
//   const { blueprint, registry } = inspect();
//
// ONE pass over the page. For every new record the traversal calls `enrich`,
// which reads computed style ONCE and shares it between the stages:
//
//   getComputedStyle -> geometry (box, visibility, position, pruning)
//                    -> styles   (interned look)
//                    -> semantics (role, kind, name, text)
//
// The blueprint holds no DOM references. The registry (returned separately)
// is what lets later components resolve "e12" back to a real element, so keep
// it inside the content script and never send it anywhere.

import { createRegistry } from './registry.js';
import { traverse } from './traversal.js';
import { measure } from './geometry.js';
import { createStyleTable, collectStyle } from './style.js';
import { annotate } from './semantics.js';
import { serialize, toPlannerView } from './serialize.js';

// A hidden subtree this big gets a warning (smaller ones are just recorded).
const HIDDEN_SUBTREE_WARN_MIN = 20;

function collectMeta(epoch) {
  const de = document.documentElement;
  return {
    host: location.hostname,
    title: (document.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    dir: getComputedStyle(de).direction,
    viewport: [window.innerWidth, window.innerHeight],
    scroll: [Math.round(window.scrollX), Math.round(window.scrollY)],
    docSize: [de.scrollWidth, de.scrollHeight],
    epoch,
  };
}

export function inspect({ epoch = 1, root = document.body, maxNodes = 1500, maxDepth = 60 } = {}) {
  const t0 = performance.now();

  const registry = createRegistry(epoch);
  const styles = createStyleTable();
  const timers = { measure: 0, style: 0, semantics: 0 };
  const scroll = { x: window.scrollX, y: window.scrollY };

  // Extra warnings raised by the stages (de-duplicated).
  const extraWarnings = [];
  const seen = new Set();
  const warn = (code, node) => {
    const key = code + '|' + (node || '');
    if (seen.has(key)) return;
    seen.add(key);
    extraWarnings.push(node ? { code, node } : { code });
  };
  const ctx = { warn };

  const enrich = (rec, parentRec) => {
    let cs;
    let t = performance.now();
    try {
      cs = getComputedStyle(rec.el);
      measure(rec, cs, parentRec, scroll);
    } catch (_) {
      warn('style-read-failed', rec.id);
      return;
    } finally {
      timers.measure += performance.now() - t;
    }

    if (rec.hiddenSubtree) {
      // Hidden subtrees never get style reads; just note if a big one was skipped.
      const size = rec.el.getElementsByTagName('*').length;
      if (size >= HIDDEN_SUBTREE_WARN_MIN) warn('large-hidden-subtree-skipped', rec.id);
    } else {
      t = performance.now();
      try {
        collectStyle(rec, cs, styles);
      } catch (_) {
        warn('style-read-failed', rec.id);
      }
      timers.style += performance.now() - t;
    }

    t = performance.now();
    annotate(rec, ctx);
    timers.semantics += performance.now() - t;
  };

  const result = traverse(root, { registry, maxNodes, maxDepth, onRecord: enrich });

  const blueprint = serialize({
    records: result.records,
    stats: result.stats,
    warnings: [...result.warnings, ...extraWarnings],
    styles,
    timers,
    config: { maxNodes, maxDepth },
    meta: collectMeta(epoch),
  });

  // Baseline numbers for the performance table (planner view size, in bytes).
  const json = JSON.stringify(toPlannerView(blueprint));
  const bytes = new TextEncoder().encode(json).length;
  blueprint.diag.bytes = bytes;
  blueprint.diag.totalMs = Math.round((performance.now() - t0) * 10) / 10;
  

  return { blueprint, registry };
}

export { toPlannerView };