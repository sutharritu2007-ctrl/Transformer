#!/usr/bin/env node
// tools/summarize-blueprint.cjs
//
// Usage:  node tools/summarize-blueprint.cjs path/to/blueprint.json
//
// Prints a short diagnosis of one downloaded blueprint: how much of the page
// was recorded, what the budgets did, where content was cut or sampled, and
// where the nodes are. Paste the output when asking for help tuning budgets.

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/summarize-blueprint.cjs path/to/blueprint.json');
  process.exit(1);
}
const bp = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = bp.nodes || {};
const ids = Object.keys(nodes);

// --- depth of every node (walk down from the root) ------------------------
const depthOf = {};
const stack = bp.root ? [[bp.root, 0]] : [];
while (stack.length) {
  const [id, d] = stack.pop();
  depthOf[id] = d;
  for (const child of nodes[id].c || []) stack.push([child, d + 1]);
}

const label = (id) => {
  const n = nodes[id];
  const what = n.r ? `${n.t}[${n.r}]` : n.t;
  return `${id} <${what}> depth ${depthOf[id]}`;
};
const top = (arr, n) => arr.slice(0, n);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// --- header ---------------------------------------------------------------
const lim = bp.limits || {};
const diag = bp.diag || {};
console.log(`File:      ${file}`);
console.log(`Page:      ${bp.meta?.title || '(no title)'}  [${bp.meta?.host}]`);
console.log(`Recorded:  ${lim.nodesKept} of ${lim.totalElements} elements` +
  (lim.totalElements ? ` (${Math.round((100 * lim.nodesKept) / lim.totalElements)}%)` : ''));
if (bp.diag?.stats?.sampled > 0) {
  console.log('           (elements sampled out as repeats are intentional, so this overstates real loss)');
}
console.log(`Budgets:   maxNodes ${lim.maxNodes}, maxDepth ${lim.maxDepth}, maxMs ${lim.maxMs}`);
console.log(`Warnings:  ${(bp.warnings || []).map((w) => (w.node ? `${w.code}@${w.node}` : w.code)).join(', ') || 'none'}`);
if (diag.stats) {
  console.log(`Walk:      visited ${diag.stats.visited}, skipped ${diag.stats.skipped}, ` +
    `sampled out ${diag.stats.sampled ?? 'n/a'}, max depth ${diag.stats.maxDepthSeen}`);
  if (diag.stats.collapsed !== undefined) {
    console.log(`Folding:   ${diag.stats.collapsed} wrappers folded, ${diag.stats.emptyDropped} empty leaves dropped, ` +
      `${diag.stats.recorded} elements recorded -> ${diag.stats.kept} nodes in the blueprint`);
  }
}
if (diag.timersMs) {
  console.log(`Time:      ${diag.totalMs} ms total (measure ${diag.timersMs.measure}, ` +
    `style ${diag.timersMs.style}, semantics ${diag.timersMs.semantics}), ` +
    `walk ${diag.stats?.elapsedMs} ms`);
}
console.log(`Size:      ${diag.bytes} bytes, ${diag.styleCount} distinct styles`);

// --- budget pressure ------------------------------------------------------
const withOmit = ids.filter((id) => nodes[id].omit > 0).sort((a, b) => nodes[b].omit - nodes[a].omit);
const withRep = ids.filter((id) => nodes[id].rep > 0).sort((a, b) => nodes[b].rep - nodes[a].rep);
console.log(`\nCut by a budget (omit):   ${sum(withOmit.map((id) => nodes[id].omit))} children across ${withOmit.length} nodes`);
top(withOmit, 8).forEach((id) =>
  console.log(`   ${label(id)}  omit ${nodes[id].omit}, kept ${(nodes[id].c || []).length} children`));
console.log(`Sampled as repeats (rep): ${sum(withRep.map((id) => nodes[id].rep))} children across ${withRep.length} nodes`);
top(withRep, 8).forEach((id) =>
  console.log(`   ${label(id)}  rep ${nodes[id].rep}, kept ${(nodes[id].c || []).length} children`));

// --- where the nodes are --------------------------------------------------
const byWidth = ids
  .map((id) => ({ id, total: (nodes[id].c || []).length + (nodes[id].rep || 0) + (nodes[id].omit || 0) }))
  .sort((a, b) => b.total - a.total);
console.log('\nWidest parents (children originally present):');
top(byWidth, 8).forEach(({ id, total }) =>
  console.log(`   ${label(id)}  ${total} children (kept ${(nodes[id].c || []).length})`));

const hist = {};
ids.forEach((id) => { hist[depthOf[id]] = (hist[depthOf[id]] || 0) + 1; });
console.log('\nRecorded nodes per depth:');
console.log('   ' + Object.keys(hist).map(Number).sort((a, b) => a - b).map((d) => `${d}:${hist[d]}`).join('  '));

const tagCount = {};
ids.forEach((id) => { tagCount[nodes[id].t] = (tagCount[nodes[id].t] || 0) + 1; });
console.log('\nMost common tags:');
console.log('   ' + Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t}:${c}`).join('  '));

// --- content quality ------------------------------------------------------
const count = (pred) => ids.filter((id) => pred(nodes[id])).length;
console.log(`\nWith text (tx): ${count((n) => n.tx)}   with name (n): ${count((n) => n.n)}   ` +
  `links: ${count((n) => n.lk)}   with folded wrappers (cw): ${count((n) => n.cw)}   hidden: ${count((n) => n.v === 'hidden')}   ` +
  `zero-size: ${count((n) => n.v === 'zero')}   protected: ${count((n) => n.p)}   fixed/sticky: ${count((n) => n.pos === 'fixed' || n.pos === 'sticky')}`);
