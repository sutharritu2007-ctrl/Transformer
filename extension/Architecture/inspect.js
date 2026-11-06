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

function areaOfBox(box) {
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, box[2]) * Math.max(0, box[3]);
}

function overlaps(a, b) {
  if (!a || !b) return false;
  const ax1 = a[0], ay1 = a[1], ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  return ix2 > ix1 && iy2 > iy1;
}

function mergeCandidates(candidates) {
  const merged = [];
  for (const c of candidates) {
    const existing = merged.find((m) => overlaps(m.box, c.box) && m.role === c.role);
    if (!existing) {
      merged.push(c);
      continue;
    }
    const score = Math.max(existing.conf, c.conf);
    existing.conf = score;
    existing.nodes = Array.from(new Set([...existing.nodes, ...c.nodes]));
    existing.ev = Array.from(new Set([...existing.ev, ...c.ev]));
    if (!existing.box || areaOfBox(existing.box) < areaOfBox(c.box)) existing.box = c.box;
  }
  return merged.sort((a, b) => b.conf - a.conf);
}

function scoreRegionCandidate(rec, parentRec, siblings) {
  if (!rec.bx || rec.bx[2] <= 0 || rec.bx[3] <= 0) return 0;
  if (rec.drop || rec.collapsed || rec.protect || rec.vis === 'hidden' || rec.vis === 'zero') return 0;

  const role = rec.role || rec.tag;
  const box = rec.bx;
  const area = areaOfBox(box);
  const width = box[2];
  const height = box[3];
  const viewportW = window.innerWidth || 1;
  const viewportH = window.innerHeight || 1;
  const textDensity = (rec.tx ? rec.tx.length : 0) + (rec.n ? rec.n.length : 0) + (rec.children?.length || 0) * 6;

  let score = 0.15;
  const evidence = [];

  const semanticBoost = {
    banner: 0.42,
    navigation: 0.36,
    main: 0.44,
    complementary: 0.28,
    contentinfo: 0.35,
    footer: 0.34,
    region: 0.24,
    form: 0.2,
    search: 0.28,
    dialog: 0.26,
    article: 0.18,
    header: 0.38,
    nav: 0.38,
    aside: 0.3,
  };
  const tagBoost = semanticBoost[role] || 0;
  score += tagBoost;
  evidence.push(`role:${role}`);

  if (area > viewportW * viewportH * 0.08) score += 0.18, evidence.push('large-area');
  if (width > viewportW * 0.35) score += 0.15, evidence.push('wide');
  if (height > viewportH * 0.12) score += 0.1, evidence.push('tall');
  if (box[1] < 80) score += 0.1, evidence.push('top-band');
  if (box[1] + box[3] > (document.documentElement?.scrollHeight || 0) * 0.7) score += 0.08, evidence.push('bottom-band');
  if (rec.pos === 'sticky' || rec.pos === 'fixed') score += 0.12, evidence.push('sticky-or-fixed');
  if (textDensity > 120) score += 0.1, evidence.push('text-dense');
  if ((rec.children || []).length >= 4) score += 0.08, evidence.push('has-children');

  if (role === 'navigation' || rec.tag === 'nav') {
    const links = (rec.children || []).length;
    if (links >= 3) score += 0.22, evidence.push('nav-links');
  }

  if (role === 'main' || rec.tag === 'main') {
    if (width > viewportW * 0.25) score += 0.12, evidence.push('main-width');
    if (height > 180) score += 0.08, evidence.push('main-height');
  }

  if (role === 'complementary' || rec.tag === 'aside') {
    if (width < viewportW * 0.5) score += 0.14, evidence.push('sidebar-width');
    if (parentRec && parentRec.role === 'main') score += 0.1, evidence.push('adjacent-to-main');
  }

  if (rec.tag === 'header' || rec.role === 'banner') {
    if (box[1] <= 80 && width > viewportW * 0.5) score += 0.1, evidence.push('header-pattern');
  }

  if (rec.tag === 'footer' || rec.role === 'contentinfo') {
    if (box[1] + box[3] > (document.documentElement?.scrollHeight || 0) * 0.7) score += 0.12, evidence.push('footer-pattern');
  }

  const containsMain = siblings.some((sibling) => sibling !== rec && sibling.role === 'main' && overlaps(box, sibling.bx));
  if (containsMain) score -= 0.1;

  const overlapPenalty = siblings.some((sibling) => sibling !== rec && sibling.role && sibling.role !== rec.role && overlaps(box, sibling.bx) && areaOfBox(sibling.bx) > area * 0.8);
  if (overlapPenalty) score -= 0.15;

  return Math.max(0, Math.min(1, score));
}

function isMeaningfulChildRecord(child, byId) {
  if (!child) return false;

  const textValue = (child.tx || child.n || '').trim();
  if (textValue && !/^[-+]?\d+(?:\.\d+)?%?$/.test(textValue)) {
    if (child.role || child.ik || child.lv || child.n || child.tx) return true;
  }

  if (child.role || child.ik || child.lv) return true;

  const descendants = (child.children || []).map((id) => byId.get(id)).filter(Boolean);
  return descendants.some((desc) => {
    if (!desc) return false;
    const descText = (desc.tx || desc.n || '').trim();
    if (descText && !/^[-+]?\d+(?:\.\d+)?%?$/.test(descText)) {
      if (desc.role || desc.ik || desc.lv || desc.n || desc.tx) return true;
    }
    if (desc.role || desc.ik || desc.lv) return true;
    return ['button', 'a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'article', 'section', 'nav', 'main', 'aside', 'ul', 'ol'].includes(desc.tag);
  });
}

function isGenericWrapperCluster(members, byId) {
  if (!members.length) return false;
  return members.every((child) => {
    if (!child) return false;
    if (child.role || child.ik || child.lv || child.n || child.tx) return false;
    const totalText = (child.tx || '').trim();
    if (totalText && /^[-+]?\d+(?:\.\d+)?%?$/.test(totalText)) return true;
    const descendants = (child.children || []).map((id) => byId.get(id)).filter(Boolean);
    if (descendants.length === 0) return true;
    if (descendants.some((desc) => isMeaningfulChildRecord(desc, byId))) return false;
    const shortNumeric = descendants.every((desc) => {
      const text = (desc.tx || '').trim();
      return !text || /^[-+]?\d+(?:\.\d+)?%?$/.test(text) || text.length <= 4;
    });
    return shortNumeric;
  });
}

function getStructureSignature(child, byId) {
  if (!child || !Array.isArray(child.children)) return new Set();
  const set = new Set();
  for (const id of child.children) {
    const desc = byId.get(id);
    if (!desc || desc.drop || desc.collapsed || desc.vis === 'hidden' || desc.vis === 'zero') continue;
    const tag = (desc.role || desc.tag || '').toLowerCase();
    if (!tag || ['script', 'style'].includes(tag)) continue;
    set.add(tag);
  }
  return set;
}

function similarityBetween(a, b) {
  if (!a || !b) return 0;
  const union = new Set([...a, ...b]);
  const intersection = new Set([...a].filter((value) => b.has(value)));
  if (!union.size) return 1;
  return intersection.size / union.size;
}

function inferBlueprint(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const visible = records.filter((r) => !r.drop && !r.collapsed && !r.protect && r.vis !== 'hidden' && r.vis !== 'zero' && r.bx);

  const regionCandidates = [];
  for (const rec of visible) {
    if (!rec.role && !rec.tag) continue;
    const role = rec.role || rec.tag;
    const allowed = new Set(['banner', 'header', 'nav', 'navigation', 'main', 'aside', 'complementary', 'footer', 'contentinfo', 'region', 'form', 'search', 'dialog', 'article']);
    if (!allowed.has(role)) continue;
    const score = scoreRegionCandidate(rec, byId.get(rec.parent), visible);
    if (score < 0.42) continue;
    regionCandidates.push({
      id: `r${regionCandidates.length + 1}`,
      role: rec.role || rec.tag,
      kind: (rec.role || rec.tag).toLowerCase(),
      nodes: [rec.id],
      box: rec.bx,
      conf: Number(score.toFixed(2)),
      ev: [`role:${rec.role || rec.tag}`, `score:${score.toFixed(2)}`],
    });
  }

  const regions = mergeCandidates(regionCandidates)
    .filter((region) => region.conf >= 0.42)
    .slice(0, 12)
    .map((region) => ({
      id: region.id,
      role: region.role,
      kind: region.kind,
      nodes: region.nodes,
      conf: region.conf,
      ev: region.ev,
    }));

  const groups = [];
  const groupParents = new Set();
  for (const rec of visible) {
    if (!rec.children || rec.children.length < 2) continue;
    const childList = rec.children.map((id) => byId.get(id)).filter(Boolean);
    const meaningfulChildren = childList.filter((child) => !child.drop && !child.collapsed && child.vis !== 'hidden' && child.vis !== 'zero' && child.bx && child.tag !== 'script');
    if (meaningfulChildren.length < 2) continue;

    const shapeMap = new Map();
    for (const child of meaningfulChildren) {
      const key = `${child.tag}|${child.role || ''}|${child.ik || ''}|${child.children?.length || 0}`;
      const arr = shapeMap.get(key) || [];
      arr.push(child.id);
      shapeMap.set(key, arr);
    }

    const repeated = [...shapeMap.entries()]
      .map(([key, ids]) => ({ key, ids }))
      .filter(({ ids }) => ids.length >= 2)
      .sort((a, b) => b.ids.length - a.ids.length);

    let best = repeated[0] || null;
    let members = best ? best.ids.slice(0, 12) : [];

    if (!best) {
      const byTag = new Map();
      for (const child of meaningfulChildren) {
        const tag = (child.role || child.tag || '').toLowerCase() || 'div';
        const arr = byTag.get(tag) || [];
        arr.push(child.id);
        byTag.set(tag, arr);
      }

      const fallback = [...byTag.entries()]
        .map(([key, ids]) => ({ key, ids: ids.slice(0, 12) }))
        .filter(({ ids }) => ids.length >= 2)
        .map(({ key, ids }) => {
          const records = ids.map((id) => byId.get(id)).filter(Boolean);
          const semanticSignals = records.filter((child) => isMeaningfulChildRecord(child, byId)).length;
          if (semanticSignals < 1) return null;
          const structureScores = [];
          for (let i = 0; i < records.length; i++) {
            for (let j = i + 1; j < records.length; j++) {
              structureScores.push(similarityBetween(getStructureSignature(records[i], byId), getStructureSignature(records[j], byId)));
            }
          }
          const structureScore = structureScores.length ? structureScores.reduce((sum, value) => sum + value, 0) / structureScores.length : 0;
          return { key, ids, structureScore, semanticSignals };
        })
        .filter(Boolean)
        .sort((a, b) => (b.semanticSignals + b.structureScore) - (a.semanticSignals + a.structureScore))[0];

      if (!fallback || fallback.structureScore < 0.35) continue;
      best = { key: fallback.key, ids: fallback.ids };
      members = fallback.ids;
    }

    if (members.length < 2) continue;

    const memberRecords = members.map((id) => byId.get(id)).filter(Boolean);
    const semanticSignals = memberRecords.filter((child) => isMeaningfulChildRecord(child, byId)).length;
    const genericOnly = isGenericWrapperCluster(memberRecords, byId);
    if (genericOnly) continue;

    const widths = memberRecords.map((child) => child.bx?.[2] || 0).filter((w) => w > 0);
    const heights = memberRecords.map((child) => child.bx?.[3] || 0).filter((h) => h > 0);
    const widthSpread = widths.length > 1 ? Math.max(...widths) - Math.min(...widths) : 0;
    const heightSpread = heights.length > 1 ? Math.max(...heights) - Math.min(...heights) : 0;
    const widthConsistency = widths.length > 0 ? Math.max(0, 1 - widthSpread / 200) : 0;
    const heightConsistency = heights.length > 0 ? Math.max(0, 1 - heightSpread / 180) : 0;
    const consistency = (widthConsistency + heightConsistency) / 2;

    const structureBonus = memberRecords.some((child) => (child.children?.length || 0) > 0) ? 0.08 : 0;
    const semanticBonus = (semanticSignals / Math.max(1, memberRecords.length)) * 0.18;
    const strongPair = memberRecords.length === 2 && semanticSignals >= 1 && consistency >= 0.6;
    const minimumCount = meaningfulChildren.length >= 3 || strongPair;
    if (!minimumCount && !(best && best.key && memberRecords.length >= 2 && semanticSignals >= 1 && (meaningfulChildren.length >= 2))) continue;

    const score = Math.min(0.98, 0.38 + (best.ids.length / Math.max(2, meaningfulChildren.length)) * 0.28 + consistency * 0.2 + structureBonus + semanticBonus);
    if (score < 0.5) continue;

    groupParents.add(rec.id);
    groups.push({
      id: `g${groups.length + 1}`,
      kind: best.key.split('|')[0] === 'article' ? 'card-list' : 'repeated-group',
      parent: rec.id,
      members,
      count: members.length,
      conf: Number(score.toFixed(2)),
      ev: [`parent:${rec.id}`, `matches:${best.key}`, `count:${members.length}`],
    });
  }

  const overview = {
    pageSummary: {
      regionCount: regions.length,
      groupCount: groups.length,
      hasHeader: regions.some((r) => /header|banner/.test(String(r.role || ''))),
      hasFooter: regions.some((r) => /footer|contentinfo/.test(String(r.role || ''))),
      hasSidebar: regions.some((r) => /aside|complementary|sidebar/.test(String(r.role || ''))),
      hasMainContent: regions.some((r) => /main/.test(String(r.role || ''))),
    },
    regions: regions.slice(0, 8).map((r) => ({ id: r.id, role: r.role, kind: r.kind, conf: r.conf })),
    groups: groups.slice(0, 8).map((g) => ({ id: g.id, kind: g.kind, count: g.count, conf: g.conf, parent: g.parent })),
  };

  return { regions, groups, overview };
}

export function inspect({
  epoch = 1,
  root = document.body,
  maxNodes = 1500,
  maxDepth = 60,
  maxMs = 250,
  sample = undefined, // undefined = default sampling, null = off
  fold = true, // false = keep every wrapper (raw structure, for debugging)
} = {}) {
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

    // Visually inert? Lets the traversal fold pass-through wrappers.
    const look = rec.st ? styles.table[rec.st] : null;
    rec.plain =
      Boolean(look) &&
      rec.vis === 'visible' &&
      !rec.pos &&
      !look.bgImg &&
      !look.radius &&
      ['', 'transparent', 'rgba(0, 0, 0, 0)'].includes(look.bg);
  };

  const result = traverse(root, { registry, maxNodes, maxDepth, maxMs, sample, fold, onRecord: enrich });
  const inferred = inferBlueprint(result.records);

  const blueprint = serialize({
    records: result.records,
    stats: result.stats,
    warnings: [...result.warnings, ...extraWarnings],
    styles,
    timers,
    config: { maxNodes, maxDepth, maxMs },
    meta: collectMeta(epoch),
    inferred,
  });

  // Baseline numbers for the performance table (planner view size, in bytes).
  const json = JSON.stringify(toPlannerView(blueprint));
  const bytes = new TextEncoder().encode(json).length;
  blueprint.diag.bytes = bytes;
  blueprint.diag.totalMs = Math.round((performance.now() - t0) * 10) / 10;

  return { blueprint, registry };
}

export { toPlannerView };