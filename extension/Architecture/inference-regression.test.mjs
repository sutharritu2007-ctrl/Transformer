import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./inspect.js', import.meta.url), 'utf8');
const stripped = source
  .replace(/import\s+[^;]+from\s+['"][^'"]+['"];?\n/g, '')
  .replace(/export\s+/g, '');

const context = {
  console,
  Map,
  Set,
  Array,
  Math,
  Object,
  JSON,
  Number,
  String,
  Boolean,
  performance: { now: () => 0 },
  window: { innerWidth: 1200, innerHeight: 800 },
  document: {
    documentElement: { scrollHeight: 1000 },
    title: 'fixture page',
    baseURI: 'https://example.test/'
  },
  location: { hostname: 'example.test', origin: 'https://example.test', href: 'https://example.test/' },
  getComputedStyle: () => ({ direction: 'ltr' }),
  createRegistry: () => ({ assign: () => 'id', idOf: () => null }),
  traverse: () => ({ records: [], stats: { visited: 0, kept: 0, elementsInRoot: 0 }, warnings: [] }),
  measure: () => {},
  createStyleTable: () => ({ table: {}, size: 0 }),
  collectStyle: () => {},
  annotate: () => {},
  serialize: (payload) => payload,
  toPlannerView: (blueprint) => blueprint,
};

const vm = await import('node:vm');
vm.runInNewContext(stripped, context);

const { inferBlueprint, scoreRegionCandidate, mergeCandidates } = context;

function makeRecord(overrides = {}) {
  return {
    id: overrides.id || 'e1',
    tag: overrides.tag || 'div',
    role: overrides.role || null,
    bx: overrides.bx || [0, 0, 100, 100],
    vis: overrides.vis || 'visible',
    pos: overrides.pos || null,
    children: overrides.children || [],
    parent: overrides.parent ?? null,
    drop: !!overrides.drop,
    collapsed: !!overrides.collapsed,
    protect: overrides.protect || null,
    tx: overrides.tx || '',
    n: overrides.n || '',
    ik: overrides.ik || '',
    st: overrides.st || null,
    lv: overrides.lv || null,
    depth: overrides.depth ?? 0,
    el: overrides.el || null,
  };
}

test('semantic landmarks produce region candidates', () => {
  const records = [
    makeRecord({ id: 'r1', tag: 'header', role: 'banner', bx: [0, 0, 1200, 80] }),
    makeRecord({ id: 'r2', tag: 'nav', role: 'navigation', bx: [0, 80, 220, 620] }),
    makeRecord({ id: 'r3', tag: 'main', role: 'main', bx: [240, 80, 900, 620] }),
    makeRecord({ id: 'r4', tag: 'footer', role: 'contentinfo', bx: [0, 700, 1200, 100] }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.regions.length >= 4, `expected semantic regions, got ${JSON.stringify(outcome.regions)}`);
  assert.equal(outcome.overview.pageSummary.hasHeader, true);
  assert.equal(outcome.overview.pageSummary.hasMainContent, true);
  assert.equal(outcome.overview.pageSummary.hasFooter, true);
});

test('generic div layout without semantic roles is conservative and does not infer regions', () => {
  const records = [
    makeRecord({ id: 'a', tag: 'div', bx: [0, 0, 1200, 80], children: ['b', 'c'] }),
    makeRecord({ id: 'b', tag: 'div', bx: [0, 80, 220, 620] }),
    makeRecord({ id: 'c', tag: 'div', bx: [240, 80, 900, 620] }),
    makeRecord({ id: 'd', tag: 'div', bx: [0, 700, 1200, 100] }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.regions.length, 0, 'expected no region inference without semantic role or landmark tags');
});

test('large main region and adjacent side panel can be recognized when semantically marked', () => {
  const records = [
    makeRecord({ id: 'left', tag: 'aside', role: 'complementary', bx: [0, 80, 250, 620] }),
    makeRecord({ id: 'main', tag: 'main', role: 'main', bx: [270, 80, 850, 620] }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.regions.length >= 2, true, `expected main + aside, got ${JSON.stringify(outcome.regions)}`);
  const hasMain = outcome.regions.some((r) => r.role === 'main');
  const hasAside = outcome.regions.some((r) => r.role === 'complementary');
  assert.equal(hasMain, true);
  assert.equal(hasAside, true);
});

test('hidden or zero-sized elements are excluded from region inference', () => {
  const records = [
    makeRecord({ id: 'hidden', tag: 'nav', role: 'navigation', bx: [0, 0, 200, 50], vis: 'hidden' }),
    makeRecord({ id: 'zero', tag: 'main', role: 'main', bx: [0, 0, 0, 0], vis: 'zero' }),
    makeRecord({ id: 'normal', tag: 'main', role: 'main', bx: [20, 20, 800, 500] }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.regions.some((r) => r.id === 'r1' && r.role === 'navigation'), false);
  assert.ok(outcome.regions.some((r) => r.role === 'main'));
});

test('floating elements with small area do not become major regions', () => {
  const records = [
    makeRecord({ id: 'float1', tag: 'div', role: 'region', bx: [100, 100, 150, 120] }),
    makeRecord({ id: 'float2', tag: 'div', role: 'region', bx: [300, 200, 180, 130] }),
    makeRecord({ id: 'main', tag: 'main', role: 'main', bx: [0, 0, 1200, 700] }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.regions.some((r) => r.role === 'main'));
  assert.equal(outcome.regions.some((r) => r.role === 'region' && r.box && r.box[2] < 300), false);
});

test('repeated navigation items are detected as a repeated group', () => {
  const parent = makeRecord({ id: 'nav-wrap', tag: 'nav', role: 'navigation', bx: [0, 0, 1000, 80], children: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] });
  const records = [
    parent,
    makeRecord({ id: 'n1', tag: 'a', role: 'link', bx: [0, 0, 120, 50], parent: 'nav-wrap' }),
    makeRecord({ id: 'n2', tag: 'a', role: 'link', bx: [130, 0, 120, 50], parent: 'nav-wrap' }),
    makeRecord({ id: 'n3', tag: 'a', role: 'link', bx: [260, 0, 120, 50], parent: 'nav-wrap' }),
    makeRecord({ id: 'n4', tag: 'a', role: 'link', bx: [390, 0, 120, 50], parent: 'nav-wrap' }),
    makeRecord({ id: 'n5', tag: 'a', role: 'link', bx: [520, 0, 120, 50], parent: 'nav-wrap' }),
    makeRecord({ id: 'n6', tag: 'a', role: 'link', bx: [650, 0, 120, 50], parent: 'nav-wrap' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'nav-wrap'), `expected a repeated group under nav-wrap, got ${JSON.stringify(outcome.groups)}`);
});

test('similar-but-unrelated siblings do not become repeated groups when they are just generic wrappers', () => {
  const parent = makeRecord({ id: 'wrap', tag: 'div', bx: [0, 0, 1000, 200], children: ['x1', 'x2', 'x3', 'x4'] });
  const records = [
    parent,
    makeRecord({ id: 'x1', tag: 'div', role: null, bx: [0, 0, 100, 100], parent: 'wrap' }),
    makeRecord({ id: 'x2', tag: 'div', role: null, bx: [120, 0, 100, 100], parent: 'wrap' }),
    makeRecord({ id: 'x3', tag: 'div', role: null, bx: [240, 0, 100, 100], parent: 'wrap' }),
    makeRecord({ id: 'x4', tag: 'div', role: null, bx: [360, 0, 100, 100], parent: 'wrap' }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.groups.length, 0, `expected no false positives, got ${JSON.stringify(outcome.groups)}`);
});

test('legitimate repeated div-based cards can still be recognized when they have content structure', () => {
  const parent = makeRecord({ id: 'cards', tag: 'section', role: 'region', bx: [0, 0, 900, 400], children: ['c1', 'c2', 'c3', 'c4'] });
  const records = [
    parent,
    makeRecord({ id: 'c1', tag: 'div', role: null, bx: [0, 0, 200, 180], parent: 'cards', children: ['h1', 'p1'], tx: 'Card one', n: 'Card one' }),
    makeRecord({ id: 'c2', tag: 'div', role: null, bx: [220, 0, 200, 180], parent: 'cards', children: ['h2', 'p2'], tx: 'Card two', n: 'Card two' }),
    makeRecord({ id: 'c3', tag: 'div', role: null, bx: [440, 0, 200, 180], parent: 'cards', children: ['h3', 'p3'], tx: 'Card three', n: 'Card three' }),
    makeRecord({ id: 'c4', tag: 'div', role: null, bx: [660, 0, 200, 180], parent: 'cards', children: ['h4', 'p4'], tx: 'Card four', n: 'Card four' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'cards'), `expected repeated card group, got ${JSON.stringify(outcome.groups)}`);
});

test('two legitimate product cards can qualify as a repeated group with strong evidence', () => {
  const parent = makeRecord({ id: 'two-cards', tag: 'section', role: 'region', bx: [0, 0, 520, 240], children: ['c1', 'c2'] });
  const records = [
    parent,
    makeRecord({ id: 'c1', tag: 'article', role: 'article', bx: [0, 0, 240, 200], parent: 'two-cards', children: ['h1', 'p1'], tx: 'Product A', n: 'Product A' }),
    makeRecord({ id: 'c2', tag: 'article', role: 'article', bx: [260, 0, 240, 200], parent: 'two-cards', children: ['h2', 'p2'], tx: 'Product B', n: 'Product B' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'two-cards'), `expected two-card repeated group, got ${JSON.stringify(outcome.groups)}`);
});

test('two unrelated generic divs are not treated as a repeated group', () => {
  const parent = makeRecord({ id: 'pair', tag: 'div', bx: [0, 0, 400, 200], children: ['d1', 'd2'] });
  const records = [
    parent,
    makeRecord({ id: 'd1', tag: 'div', bx: [0, 0, 180, 120], parent: 'pair' }),
    makeRecord({ id: 'd2', tag: 'div', bx: [200, 0, 180, 120], parent: 'pair' }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.groups.length, 0, `expected no group for unrelated generic div pair, got ${JSON.stringify(outcome.groups)}`);
});

test('four generic tiles with numeric text do not become a repeated component', () => {
  const parent = makeRecord({ id: 'tiles', tag: 'div', bx: [0, 0, 500, 200], children: ['t1', 't2', 't3', 't4'] });
  const records = [
    parent,
    makeRecord({ id: 't1', tag: 'div', bx: [0, 0, 100, 100], parent: 'tiles', children: ['s1'], tx: '', n: '' }),
    makeRecord({ id: 't2', tag: 'div', bx: [120, 0, 100, 100], parent: 'tiles', children: ['s2'], tx: '', n: '' }),
    makeRecord({ id: 't3', tag: 'div', bx: [240, 0, 100, 100], parent: 'tiles', children: ['s3'], tx: '', n: '' }),
    makeRecord({ id: 't4', tag: 'div', bx: [360, 0, 100, 100], parent: 'tiles', children: ['s4'], tx: '', n: '' }),
    makeRecord({ id: 's1', tag: 'span', bx: [0, 0, 30, 20], parent: 't1', tx: '1', n: '1' }),
    makeRecord({ id: 's2', tag: 'span', bx: [120, 0, 30, 20], parent: 't2', tx: '2', n: '2' }),
    makeRecord({ id: 's3', tag: 'span', bx: [240, 0, 30, 20], parent: 't3', tx: '3', n: '3' }),
    makeRecord({ id: 's4', tag: 'span', bx: [360, 0, 30, 20], parent: 't4', tx: '4', n: '4' }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.groups.length, 0, `expected no group for numeric generic tiles, got ${JSON.stringify(outcome.groups)}`);
});

test('two structurally similar cards with different content remain a legitimate repeated group', () => {
  const parent = makeRecord({ id: 'pair', tag: 'div', bx: [0, 0, 500, 220], children: ['a', 'b'] });
  const records = [
    parent,
    makeRecord({ id: 'a', tag: 'div', bx: [0, 0, 220, 180], parent: 'pair', children: ['a1', 'a2'], tx: 'Alpha card', n: 'Alpha card' }),
    makeRecord({ id: 'b', tag: 'div', bx: [260, 0, 220, 180], parent: 'pair', children: ['b1', 'b2'], tx: 'Beta card', n: 'Beta card' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'pair'), `expected pair to remain a valid repeated group, got ${JSON.stringify(outcome.groups)}`);
});

test('slightly different child structures still qualify when the siblings share the same meaningful pattern', () => {
  const parent = makeRecord({ id: 'pair', tag: 'div', bx: [0, 0, 520, 220], children: ['a', 'b'] });
  const records = [
    parent,
    makeRecord({ id: 'a', tag: 'article', role: 'article', bx: [0, 0, 220, 180], parent: 'pair', children: ['h1', 'p1'], tx: 'Alpha card', n: 'Alpha card' }),
    makeRecord({ id: 'b', tag: 'article', role: 'article', bx: [260, 0, 220, 180], parent: 'pair', children: ['h2', 'd1', 'p2'], tx: 'Beta card', n: 'Beta card' }),
    makeRecord({ id: 'h1', tag: 'h3', bx: [0, 0, 120, 30], parent: 'a', tx: 'Alpha', n: 'Alpha' }),
    makeRecord({ id: 'p1', tag: 'p', bx: [0, 40, 110, 20], parent: 'a', tx: 'Short', n: 'Short' }),
    makeRecord({ id: 'h2', tag: 'h3', bx: [260, 0, 120, 30], parent: 'b', tx: 'Beta', n: 'Beta' }),
    makeRecord({ id: 'd1', tag: 'div', bx: [260, 40, 110, 20], parent: 'b', tx: 'Extra', n: 'Extra' }),
    makeRecord({ id: 'p2', tag: 'p', bx: [260, 70, 110, 20], parent: 'b', tx: 'Longer', n: 'Longer' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'pair'), `expected a two-card group despite structural variation, got ${JSON.stringify(outcome.groups)}`);
});

test('nested cards containing repeated buttons remain valid nested groups', () => {
  const parent = makeRecord({ id: 'feed', tag: 'div', bx: [0, 0, 600, 300], children: ['p1', 'p2', 'p3'] });
  const records = [
    parent,
    makeRecord({ id: 'p1', tag: 'article', role: 'article', bx: [0, 0, 520, 80], parent: 'feed', children: ['b1', 'b2'] }),
    makeRecord({ id: 'p2', tag: 'article', role: 'article', bx: [0, 100, 520, 80], parent: 'feed', children: ['b3', 'b4'] }),
    makeRecord({ id: 'p3', tag: 'article', role: 'article', bx: [0, 200, 520, 80], parent: 'feed', children: ['b5', 'b6'] }),
    makeRecord({ id: 'b1', tag: 'button', role: 'button', bx: [10, 10, 90, 30], parent: 'p1', tx: 'Like', n: 'Like' }),
    makeRecord({ id: 'b2', tag: 'button', role: 'button', bx: [110, 10, 90, 30], parent: 'p1', tx: 'Share', n: 'Share' }),
    makeRecord({ id: 'b3', tag: 'button', role: 'button', bx: [10, 110, 90, 30], parent: 'p2', tx: 'Like', n: 'Like' }),
    makeRecord({ id: 'b4', tag: 'button', role: 'button', bx: [110, 110, 90, 30], parent: 'p2', tx: 'Share', n: 'Share' }),
    makeRecord({ id: 'b5', tag: 'button', role: 'button', bx: [10, 210, 90, 30], parent: 'p3', tx: 'Like', n: 'Like' }),
    makeRecord({ id: 'b6', tag: 'button', role: 'button', bx: [110, 210, 90, 30], parent: 'p3', tx: 'Share', n: 'Share' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'feed'), `expected nested repeated article group, got ${JSON.stringify(outcome.groups)}`);
});

test('three or more legitimate generic div-based cards are still recognized', () => {
  const parent = makeRecord({ id: 'three', tag: 'div', bx: [0, 0, 700, 200], children: ['d1', 'd2', 'd3'] });
  const records = [
    parent,
    makeRecord({ id: 'd1', tag: 'div', bx: [0, 0, 180, 150], parent: 'three', children: ['h1', 'h2'] }),
    makeRecord({ id: 'd2', tag: 'div', bx: [200, 0, 180, 150], parent: 'three', children: ['h3', 'h4'] }),
    makeRecord({ id: 'd3', tag: 'div', bx: [400, 0, 180, 150], parent: 'three', children: ['h5', 'h6'] }),
    makeRecord({ id: 'h1', tag: 'h3', bx: [0, 0, 120, 24], parent: 'd1', tx: 'One', n: 'One' }),
    makeRecord({ id: 'h2', tag: 'p', bx: [0, 30, 120, 20], parent: 'd1', tx: 'Text', n: 'Text' }),
    makeRecord({ id: 'h3', tag: 'h3', bx: [200, 0, 120, 24], parent: 'd2', tx: 'Two', n: 'Two' }),
    makeRecord({ id: 'h4', tag: 'p', bx: [200, 30, 120, 20], parent: 'd2', tx: 'Text', n: 'Text' }),
    makeRecord({ id: 'h5', tag: 'h3', bx: [400, 0, 120, 24], parent: 'd3', tx: 'Three', n: 'Three' }),
    makeRecord({ id: 'h6', tag: 'p', bx: [400, 30, 120, 20], parent: 'd3', tx: 'Text', n: 'Text' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'three'), `expected generic div cards to remain valid, got ${JSON.stringify(outcome.groups)}`);
});

test('visually similar but unrelated elements remain rejected when they lack content semantics', () => {
  const parent = makeRecord({ id: 'gallery', tag: 'div', bx: [0, 0, 600, 200], children: ['i1', 'i2', 'i3'] });
  const records = [
    parent,
    makeRecord({ id: 'i1', tag: 'div', bx: [0, 0, 160, 160], parent: 'gallery' }),
    makeRecord({ id: 'i2', tag: 'div', bx: [180, 0, 160, 160], parent: 'gallery' }),
    makeRecord({ id: 'i3', tag: 'div', bx: [360, 0, 160, 160], parent: 'gallery' }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.groups.length, 0, `expected no group for generic visual tiles without semantic content, got ${JSON.stringify(outcome.groups)}`);
});

test('repeated elements with slightly different content are still allowed', () => {
  const parent = makeRecord({ id: 'rows', tag: 'div', bx: [0, 0, 600, 200], children: ['r1', 'r2', 'r3'] });
  const records = [
    parent,
    makeRecord({ id: 'r1', tag: 'div', role: null, bx: [0, 0, 180, 50], parent: 'rows', tx: 'Jan', n: 'Jan' }),
    makeRecord({ id: 'r2', tag: 'div', role: null, bx: [0, 60, 180, 50], parent: 'rows', tx: 'Feb', n: 'Feb' }),
    makeRecord({ id: 'r3', tag: 'div', role: null, bx: [0, 120, 180, 50], parent: 'rows', tx: 'Mar', n: 'Mar' }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'rows'), `expected repeated content rows, got ${JSON.stringify(outcome.groups)}`);
});

test('nested repeated structures are retained when the inner pattern is meaningful', () => {
  const parent = makeRecord({ id: 'feed', tag: 'div', bx: [0, 0, 500, 300], children: ['p1', 'p2', 'p3'] });
  const records = [
    parent,
    makeRecord({ id: 'p1', tag: 'article', role: 'article', bx: [0, 0, 460, 80], parent: 'feed', children: ['a1', 'a2'] }),
    makeRecord({ id: 'p2', tag: 'article', role: 'article', bx: [0, 90, 460, 80], parent: 'feed', children: ['b1', 'b2'] }),
    makeRecord({ id: 'p3', tag: 'article', role: 'article', bx: [0, 180, 460, 80], parent: 'feed', children: ['c1', 'c2'] }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'feed'), `expected nested repeated article group, got ${JSON.stringify(outcome.groups)}`);
});

test('groups containing decorative elements are not promoted if the repeated members are still structurally empty', () => {
  const parent = makeRecord({ id: 'decor-rail', tag: 'div', bx: [0, 0, 300, 200], children: ['d1', 'd2', 'd3'] });
  const records = [
    parent,
    makeRecord({ id: 'd1', tag: 'div', bx: [0, 0, 80, 80], parent: 'decor-rail' }),
    makeRecord({ id: 'd2', tag: 'div', bx: [90, 0, 80, 80], parent: 'decor-rail' }),
    makeRecord({ id: 'd3', tag: 'div', bx: [180, 0, 80, 80], parent: 'decor-rail' }),
  ];

  const outcome = inferBlueprint(records);
  assert.equal(outcome.groups.length, 0, `expected no decorative group, got ${JSON.stringify(outcome.groups)}`);
});

test('shape-based grouping can handle repeated cards', () => {
  const parent = makeRecord({ id: 'cards', tag: 'section', role: 'region', bx: [0, 0, 900, 400], children: ['c1', 'c2', 'c3', 'c4'] });
  const records = [
    parent,
    makeRecord({ id: 'c1', tag: 'article', role: 'article', bx: [0, 0, 200, 180], parent: 'cards', children: ['h1', 'p1'] }),
    makeRecord({ id: 'c2', tag: 'article', role: 'article', bx: [220, 0, 200, 180], parent: 'cards', children: ['h2', 'p2'] }),
    makeRecord({ id: 'c3', tag: 'article', role: 'article', bx: [440, 0, 200, 180], parent: 'cards', children: ['h3', 'p3'] }),
    makeRecord({ id: 'c4', tag: 'article', role: 'article', bx: [660, 0, 200, 180], parent: 'cards', children: ['h4', 'p4'] }),
  ];

  const outcome = inferBlueprint(records);
  assert.ok(outcome.groups.some((g) => g.parent === 'cards'), `expected repeated card group, got ${JSON.stringify(outcome.groups)}`);
});

const expected = {
  merge: mergeCandidates([
    { id: 'a', role: 'main', box: [0, 0, 300, 200], conf: 0.9, nodes: ['a'], ev: ['role:main'] },
    { id: 'b', role: 'main', box: [10, 10, 280, 180], conf: 0.7, nodes: ['b'], ev: ['role:main'] },
  ]),
  score: scoreRegionCandidate(makeRecord({ id: 'x', tag: 'main', role: 'main', bx: [0, 0, 500, 300] }), null, [
    makeRecord({ id: 'x', tag: 'main', role: 'main', bx: [0, 0, 500, 300] }),
  ]),
};

test('candidate merge preserves the strongest evidence and merges overlapping regions', () => {
  assert.equal(expected.merge.length, 1);
  assert.ok(expected.merge[0].conf >= 0.7);
  assert.equal(expected.score >= 0.42, true);
});
