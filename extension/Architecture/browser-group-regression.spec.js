const { test, expect } = require('playwright/test');
const path = require('node:path');

const bundlePath = path.resolve(__dirname, '../content/inspector.bundle.js');

function assertGroupIntegrity(groups, nodes) {
  const nodeSet = new Set(Array.isArray(nodes) ? nodes : Object.keys(nodes || {}));
  const seen = new Set();
  for (const group of groups) {
    expect(group).toBeTruthy();
    expect(group.id).toBeTruthy();
    expect(group.kind).toBeTruthy();
    expect(Number.isFinite(group.conf)).toBeTruthy();
    expect(group.conf).toBeGreaterThanOrEqual(0);
    expect(group.conf).toBeLessThanOrEqual(1);
    expect(seen.has(group.id)).toBeFalsy();
    seen.add(group.id);
    expect(Array.isArray(group.members)).toBeTruthy();
    expect(group.members.length).toBe(group.count);
    expect(group.members.every((id) => nodeSet.has(id))).toBeTruthy();
  }
}

async function inspectScenario(page, html, viewWidth = 1200) {
  await page.setViewportSize({ width: viewWidth, height: 900 });
  await page.setContent(html);
  await page.addScriptTag({ path: bundlePath });

  return page.evaluate(() => {
    const { blueprint } = window.TransformerInspector.inspect({
      maxNodes: 2000,
      maxDepth: 50,
      maxMs: 1000,
    });
    const groups = (blueprint.inferred.groups || []).map((group) => ({
      ...group,
      members: Array.isArray(group.members) ? [...group.members] : [],
    }));
    const nodes = Object.keys(blueprint.nodes || {});
    const regionCount = (blueprint.inferred.regions || []).length;
    return { groups, nodes, regionCount };
  });
}

const scenarios = [
  {
    name: 'product grid',
    html: `
      <div class="page">
        <header>Shop</header>
        <main>
          <section class="catalog">
            <article class="product-card"><h3>White Tee</h3><p>$20</p></article>
            <article class="product-card"><h3>Black Tee</h3><p>$20</p></article>
            <article class="product-card"><h3>Navy Tee</h3><p>$20</p></article>
            <article class="product-card"><h3>Red Tee</h3><p>$20</p></article>
          </section>
        </main>
      </div>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['card-list'],
      groupCounts: [4],
      regionCount: 2,
    },
  },
  {
    name: 'navigation',
    html: `
      <nav>
        <a href="#">Home</a>
        <a href="#">Shop</a>
        <a href="#">About</a>
        <a href="#">Support</a>
      </nav>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['repeated-group'],
      groupCounts: [4],
      regionCount: 1,
    },
  },
  {
    name: 'dashboard statistics',
    html: `
      <div class="dashboard">
        <div class="stat"><div class="label">Revenue</div><div class="value">$42k</div></div>
        <div class="stat"><div class="label">Orders</div><div class="value">430</div></div>
        <div class="stat"><div class="label">Visitors</div><div class="value">12k</div></div>
      </div>
    `,
    expected: {
      groupCount: 4,
      groupKinds: ['repeated-group', 'repeated-group', 'repeated-group', 'repeated-group'],
      groupCounts: [3, 2, 2, 2],
      regionCount: 0,
    },
  },
  {
    name: 'table rows',
    html: `
      <table><tbody>
        <tr><td>Jan</td><td>100</td></tr>
        <tr><td>Feb</td><td>110</td></tr>
        <tr><td>Mar</td><td>120</td></tr>
      </tbody></table>
    `,
    expected: {
      groupCount: 4,
      groupKinds: ['repeated-group', 'repeated-group', 'repeated-group', 'repeated-group'],
      groupCounts: [3, 2, 2, 2],
      regionCount: 0,
    },
  },
  {
    name: 'nested cards',
    html: `
      <div class="feed">
        <article class="post"><h3>Alpha</h3><button>Like</button><button>Share</button></article>
        <article class="post"><h3>Beta</h3><button>Like</button><button>Share</button></article>
        <article class="post"><h3>Gamma</h3><button>Like</button><button>Share</button></article>
      </div>
    `,
    expected: {
      groupCount: 4,
      groupKinds: ['card-list', 'repeated-group', 'repeated-group', 'repeated-group'],
      groupCounts: [3, 2, 2, 2],
      regionCount: 3,
    },
  },
  {
    name: 'two legitimate cards',
    html: `
      <section class="stack">
        <article class="card"><h3>A</h3><p>One</p></article>
        <article class="card"><h3>B</h3><p>Two</p></article>
      </section>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['card-list'],
      groupCounts: [2],
      regionCount: 2,
    },
  },
  {
    name: 'unrelated similar siblings',
    html: `
      <div class="wrap">
        <div class="tile"><span>1</span></div>
        <div class="tile"><span>2</span></div>
        <div class="tile"><span>3</span></div>
        <div class="tile"><span>4</span></div>
      </div>
    `,
    expected: {
      groupCount: 0,
      groupKinds: [],
      groupCounts: [],
      regionCount: 0,
    },
  },
  {
    name: 'floating overlay',
    html: `
      <div class="topbar"><div class="floating-ad">Ad</div></div>
      <main>
        <div class="cards">
          <article class="item"><h3>One</h3></article>
          <article class="item"><h3>Two</h3></article>
          <article class="item"><h3>Three</h3></article>
        </div>
      </main>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['card-list'],
      groupCounts: [3],
      regionCount: 1,
    },
  },
  {
    name: 'responsive cards',
    html: `
      <div class="cards" style="display:flex; flex-wrap:wrap; gap:12px; width:600px;">
        <article class="item" style="width:180px;height:140px;">A</article>
        <article class="item" style="width:180px;height:140px;">B</article>
        <article class="item" style="width:180px;height:140px;">C</article>
      </div>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['card-list'],
      groupCounts: [3],
      regionCount: 3,
    },
  },
  {
    name: 'decorative children',
    html: `
      <div class="rail">
        <div class="dot" aria-hidden="true"></div>
        <div class="dot" aria-hidden="true"></div>
        <div class="dot" aria-hidden="true"></div>
      </div>
    `,
    expected: {
      groupCount: 0,
      groupKinds: [],
      groupCounts: [],
      regionCount: 0,
    },
  },
  {
    name: 'slightly different child structures',
    html: `
      <div class="pair">
        <article class="card"><h3>Alpha</h3><p>Short</p></article>
        <article class="card"><h3>Beta</h3><div>Extra</div><p>Longer</p></article>
      </div>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['card-list'],
      groupCounts: [2],
      regionCount: 2,
    },
  },
  {
    name: 'cards with mostly images and little text',
    html: `
      <div class="gallery">
        <article class="thumb"><img alt="A" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /><span>One</span></article>
        <article class="thumb"><img alt="B" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /><span>Two</span></article>
      </div>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['card-list'],
      groupCounts: [2],
      regionCount: 2,
    },
  },
  {
    name: 'cards with only heading and price',
    html: `
      <div class="offers">
        <article class="offer"><h3>Desk Lamp</h3><div>$40</div></article>
        <article class="offer"><h3>Desk Chair</h3><div>$120</div></article>
      </div>
    `,
    expected: {
      groupCount: 1,
      groupKinds: ['card-list'],
      groupCounts: [2],
      regionCount: 2,
    },
  },
  {
    name: 'nested overlapping patterns',
    html: `
      <div class="feed">
        <article class="post">
          <button>Like</button>
          <button>Share</button>
          <button>Save</button>
        </article>
        <article class="post">
          <button>Like</button>
          <button>Share</button>
          <button>Save</button>
        </article>
      </div>
    `,
    expected: {
      groupCount: 3,
      groupKinds: ['card-list', 'repeated-group', 'repeated-group'],
      groupCounts: [2, 3, 3],
      regionCount: 2,
    },
  },
];

for (const scenario of scenarios) {
  test(`${scenario.name} group inference`, async ({ page }) => {
    const result = await inspectScenario(page, scenario.html, 1200);
    const groups = result.groups;
    expect(groups).toHaveLength(scenario.expected.groupCount);
    expect(groups.map((g) => g.kind)).toEqual(scenario.expected.groupKinds);
    expect(groups.map((g) => g.count)).toEqual(scenario.expected.groupCounts);
    assertGroupIntegrity(groups, result.nodes);
    expect(result.regionCount).toBe(scenario.expected.regionCount);
  });
}

test('responsive width changes preserve group detection', async ({ page }) => {
  const html = `
    <div class="cards" style="display:flex; flex-wrap:wrap; gap:12px; width:600px;">
      <article class="item" style="width:180px;height:140px;">A</article>
      <article class="item" style="width:180px;height:140px;">B</article>
      <article class="item" style="width:180px;height:140px;">C</article>
    </div>
  `;

  const wide = await inspectScenario(page, html, 1200);
  const narrow = await inspectScenario(page, html, 480);

  expect(wide.groups).toHaveLength(1);
  expect(narrow.groups).toHaveLength(1);
  expect(wide.groups[0].count).toBe(3);
  expect(narrow.groups[0].count).toBe(3);
  assertGroupIntegrity(wide.groups, wide.nodes);
  assertGroupIntegrity(narrow.groups, narrow.nodes);
});
