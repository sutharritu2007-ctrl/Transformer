// src/inspector/serialize.js
//
// Turns the internal records into the Page Blueprint (see
// page-blueprint-schema-v0.1.md). This is a WHITELIST: a node only ever gets
// the keys listed below, so a field added to a record by accident (like `el`,
// the real DOM element) can never leak into the output.

export const NODE_KEYS = new Set([
  't', 'c', 'r', 'lv', 'n', 'tx', 'tl', 'bx', 'v', 'pos', 'st',
  'ik', 'dis', 'req', 'lk', 'p', 'sr', 'omit',
]);

function serializeNode(rec) {
  const n = { t: rec.tag };
  if (rec.children.length > 0) n.c = rec.children;
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
  return n;
}

const round1 = (n) => Math.round(n * 10) / 10;

export function serialize({ records, stats, warnings, styles, timers, config, meta }) {
  const nodes = {};
  for (const rec of records) nodes[rec.id] = serializeNode(rec);

  const timersMs = {};
  for (const [name, ms] of Object.entries(timers)) timersMs[name] = round1(ms);

  return {
    v: '0.1',
    meta,
    limits: {
      maxNodes: config.maxNodes,
      maxDepth: config.maxDepth,
      nodesVisited: stats.visited,
      nodesKept: stats.kept,
      totalElements: stats.elementsInRoot,
    },
    warnings,
    root: records.length > 0 ? records[0].id : null,
    nodes,
    styles: styles.table,
    inferred: { regions: [], groups: [] }, // filled by later phases
    diag: { stats, timersMs, styleCount: styles.size, bytes: 0, totalMs: 0 },
  };
}

/** What the planner would receive: everything except the debug section. */
export function toPlannerView(blueprint) {
  const { diag, ...rest } = blueprint; // eslint-disable-line no-unused-vars
  return rest;
}