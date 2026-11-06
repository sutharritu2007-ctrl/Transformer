// src/inspector/serialize.js
//
// Turns the internal records into the Page Blueprint (see
// page-blueprint-schema-v0.1.md). This is a WHITELIST: a node only ever gets
// the keys listed below, so a field added to a record by accident (like `el`,
// the real DOM element) can never leak into the output.

export const NODE_KEYS = new Set([
  't', 'c', 'r', 'lv', 'n', 'tx', 'tl', 'bx', 'v', 'pos', 'st',
  'ik', 'dis', 'req', 'lk', 'p', 'sr', 'omit', 'rep', 'cw',
]);

function serializeNode(rec, children) {
  const n = { t: rec.tag };
  if (children.length > 0) n.c = children;
  if (rec.role) n.r = rec.role;
  if (rec.lv) n.lv = rec.lv;
  if (rec.n) n.n = rec.n;
  if (rec.tx) {
    n.tx = rec.tx;
    n.tl = rec.tl;
  }
  if (rec.bx) n.bx = rec.bx;
  if (rec.vis && rec.vis !== 'visible') n.v = rec.vis; // absent `v` means visible
  if (rec.pos) n.pos = rec.pos;
  if (rec.st) n.st = rec.st;
  if (rec.ik) n.ik = rec.ik;
  if (rec.dis) n.dis = true;
  if (rec.req) n.req = true;
  if (rec.lk) n.lk = rec.lk;
  if (rec.protect) n.p = rec.protect;
  if (rec.shadow) n.sr = rec.shadow;
  if (rec.omitted) n.omit = rec.omitted;
  if (rec.repeated) n.rep = rec.repeated; // children sampled out as repeats
  if (rec.cw) n.cw = rec.cw; // inert wrappers folded away above this node
  return n;
}

const round1 = (n) => Math.round(n * 10) / 10;

// Replace folded wrappers by the single child they wrap (recursively), drop
// invisible empty leaves, and count how many wrappers were folded above each
// surviving child (`cw`). Folded and dropped records stay in the registry.
function liftChildren(ids, byId, hops) {
  const out = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r.drop) continue;
    if (r.collapsed) {
      out.push(...liftChildren(r.children, byId, hops + 1));
      continue;
    }
    if (hops > 0) r.cw = (r.cw || 0) + hops;
    out.push(id);
  }
  return out;
}

export function serialize({ records, stats, warnings, styles, timers, config, meta, inferred = { regions: [], groups: [] } }) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const live = records.filter((r) => !r.collapsed && !r.drop);

  // Two passes: lift every child list first (this sets `cw`), then serialize.
  const lifted = new Map();
  for (const rec of live) lifted.set(rec.id, liftChildren(rec.children, byId, 0));

  const nodes = {};
  for (const rec of live) nodes[rec.id] = serializeNode(rec, lifted.get(rec.id));

  const timersMs = {};
  for (const [name, ms] of Object.entries(timers)) timersMs[name] = round1(ms);

  const normalizedInferred = inferred && typeof inferred === 'object' ? inferred : { regions: [], groups: [] };
  const overview = normalizedInferred.overview || {
    pageSummary: {
      regionCount: (normalizedInferred.regions || []).length,
      groupCount: (normalizedInferred.groups || []).length,
    },
    regions: (normalizedInferred.regions || []).slice(0, 8).map((r) => ({ id: r.id, role: r.role, kind: r.kind, conf: r.conf })),
    groups: (normalizedInferred.groups || []).slice(0, 8).map((g) => ({ id: g.id, kind: g.kind, count: g.count, conf: g.conf, parent: g.parent })),
  };

  return {
    v: '0.1',
    meta,
    limits: {
      maxNodes: config.maxNodes,
      maxDepth: config.maxDepth,
      maxMs: config.maxMs,
      nodesVisited: stats.visited,
      nodesKept: stats.kept,
      totalElements: stats.elementsInRoot,
    },
    warnings,
    root: records.length > 0 ? records[0].id : null,
    nodes,
    styles: styles.table,
    overview,
    inferred: {
      regions: normalizedInferred.regions || [],
      groups: normalizedInferred.groups || [],
    },
    diag: { stats, timersMs, styleCount: styles.size, bytes: 0, totalMs: 0 },
  };
}

/** What the planner would receive: everything except the debug section. */
export function toPlannerView(blueprint) {
  const { diag, ...rest } = blueprint; // eslint-disable-line no-unused-vars
  return rest;
}