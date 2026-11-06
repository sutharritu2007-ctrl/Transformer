# Page Blueprint Schema v0.1

**Project:** Transformer (Chrome extension, Manifest V3)
**Component:** Page Inspector
**Status:** DRAFT (Phase A, not yet frozen)
**Audience:** me, while building; a future reviewer who needs to understand why each field exists


---

## 0. How to edit this document

- Every field has a **Verdict**: `v0.1` (build it now), `Later` (wanted, not yet), `Cut` (deliberately excluded).
- Every field answers five questions: **what it means**, **why Transformer needs it**, **how it is collected**, **privacy/performance cost**, **whether it is essential now**.
- Mark anything uncertain with `OPEN:` so it can be found with a search.
- Never add a field without writing its reason. If the reason is weak, the field probably belongs in `Later`.

### Changelog

| Date | Change |
|---|---|
| 2026-10-28 | Initial v0.1 draft from the Phase A design discussion |
| 2026-11-06 | Phase 3a: repeated-component sampling (`rep` on nodes, `repeats-sampled` warning), hard time budget (`maxMs`, `budget-time` warning) |
| 2026-10-30 | Phase 2 implementation adjustments: absent `v` means visible; `sr` may be `"closed"`; `ik` gains `other`; `limits.totalElements` added; `pos` limited to fixed/sticky/absolute |

---

## 1. Purpose and non-goals

### Purpose

The Page Inspector looks at the live page and produces a **compact, privacy-filtered, structured description** of it (the Page Blueprint). A future AI design planner reads the blueprint to plan a redesign. The inspector never decides the redesign.

### Constraints that shape the schema

- DOM-first hybrid: DOM structure + lightweight semantics + selected computed styles + geometry.
- Must work on **unfamiliar websites**. No site-specific templates. No assumed page type.
- No AI API or external service at this stage.
- Page content is **untrusted data**, never instructions.
- No arbitrary AI-generated JavaScript as inspector output.
- Collect the minimum. Allowlist, not blocklist.
- Hybrid transformation depth: preserve content and essential functionality, allow substantial layout and presentation change.
- The extension should work smoothly across whole websites (multi-page, SPA navigation), so the blueprint is **ephemeral** and is never the persisted artifact.

### Non-goals for v0.1

- Deciding what the redesign should be, or how important anything is.
- Classifying the page type or the site.
- Describing iframe contents, closed shadow roots, or canvas content.
- Persisting anything across navigations (Phase 7).
- Stable cross-navigation element references (Phase 7).
- Vision/screenshot analysis (Phase 9).

---

## 2. Organizing principle: three kinds of truth

| Kind | Meaning | Example |
|---|---|---|
| **Observed** | Read directly from the browser | tag, bounding box, computed font size |
| **Spec-derived** | Deterministic lookup with no judgment; same answer every time | implicit ARIA role of `<nav>`; link is internal vs external |
| **Inferred** | Heuristic judgment that can be wrong | "probably a sidebar", "these items are a repeated group" |

**Structural rule:** `nodes` contain only observed and spec-derived data. All inferences live in a separate `inferred` block that points to node IDs and carries confidence (`conf`) and evidence (`ev`).

**Why:** heuristics can change without touching facts; inference can be tested separately from collection; the planner can trust facts fully and inferences conditionally.

**Cost:** consumers join by ID (one level of indirection).

**Rejected alternative:** inline `role: "sidebar", conf: 0.8` on nodes, which mixes verifiable and guessed data.

---

## 3. Top-level shape

```
blueprint
├─ v, meta, limits, warnings        envelope
├─ root, nodes, styles              facts (observed + spec-derived)
├─ inferred { regions, groups }     judgments, each with conf + ev
└─ diag                             debug only, stripped before the planner sees it
```

Two views of one structure: the **planner view** (everything except `diag`) and the **debug view** (everything).

Nothing in the schema names a page type or a site. Unfamiliar pages are described only by what is on them.

---

## 4. Envelope

| Field | Meaning and why | Collected via | Cost | Verdict |
|---|---|---|---|---|
| `v` | Schema version, so inspector and planner can evolve separately | constant | none | **v0.1** |
| `meta.host` | Hostname only. Keys later per-site storage; minimal context for the planner | `location.hostname` | negligible | **v0.1** |
| `meta.path` | URL path | `location.pathname` | **Privacy risk:** paths often hold IDs or tokens (`/reset/abc123`) | **Cut for now.** Nothing in v0.1 needs it. Revisit at the site layer (Phase 7) |
| `meta.title` | Page title, capped (~120 chars). One line of context for the planner | `document.title` | Medium privacy (titles can carry names or subjects). Cap and run redaction | **v0.1** |
| `meta.dir` | Text direction (`ltr`/`rtl`). RTL pages invert layout, so any redesign must know | computed `direction` on root | negligible | **v0.1** |
| `meta.lang` | Document language | `documentElement.lang` | negligible | **Later.** Only affects font fallback |
| `meta.viewport` | `[w, h]` of the window | `innerWidth/innerHeight` | negligible | **v0.1** |
| `meta.scroll` | `[x, y]` scroll offset at capture | `scrollX/scrollY` | negligible | **v0.1** |
| `meta.docSize` | `[w, h]` full document size | `scrollWidth/scrollHeight` | negligible | **v0.1** |
| `meta.epoch` | Integer identifying this snapshot. All element IDs are valid only within one epoch | counter in the content script | none | **v0.1** |
| `meta.colorScheme` | Light or dark page | computed `color-scheme` or background luminance | cheap | **Later** |
| `meta.dpr` | Device pixel ratio | `devicePixelRatio` | none | **Cut.** Nothing consumes it |
| `limits` | Budgets applied (`maxNodes`, `maxDepth`, `maxMs`) plus counts (`nodesVisited`, `nodesKept`, `totalElements`: the subtree's real element count, so a cut-off page is visible as `nodesKept` far below `totalElements`) | config + counters | tiny | **v0.1.** Lets the planner tell "page is small" from "inspection was cut off" |
| `warnings[]` | `{ code, node? }` entries from a closed vocabulary (section 11) | emitted by modules | tiny | **v0.1** |

**Why viewport, scroll and docSize together:** boxes are in page coordinates, so with these three values anyone can derive "is this element in view" without a separate `inView` field.

---

## 5. Nodes (facts only)

Nodes live in a **flat map keyed by ID**, with a `root` pointer. The structure is **sparse**: omit any field that has no value.

| Field | Meaning and why | Collected via | Cost | Verdict |
|---|---|---|---|---|
| key = `id` | Temporary reference (e.g. `"e12"`). Lets regions, groups and later components point at this node | assigned by the reference registry | none | **v0.1** |
| `t` | Tag name. The most reliable cheap fact about an element | `tagName` | none | **v0.1** |
| `c` | Child IDs in DOM order | traversal | size grows with node count | **v0.1** |
| `parent` | Parent ID | | | **Cut.** Derivable from `c` in one pass; storing it doubles relationship data |
| `r` | Effective semantic role: author-set ARIA role, else implicit role from a fixed tag table. Omitted for generic elements such as `div` | `getAttribute('role')` + lookup table | tiny | **v0.1.** Spec-derived, not inferred |
| `lv` | Heading level | `h1`-`h6` or `aria-level` | tiny | **v0.1.** Gives the page's type hierarchy |
| `n` | Short accessible-name approximation for interactive elements, images and landmarks (aria-label, alt, associated label, title). Capped (~80) | attribute reads | Low-medium privacy (label text) | **v0.1.** Without it a button is just "button" |
| `tx` | Snippet of the node's **own direct text** | direct text-node children only | **Highest privacy cost in the schema**, plus size | **v0.1**, capped by element kind (section 7) |
| `tl` | Full own-text length | same | tiny | **v0.1.** Lets the planner know a paragraph is long without reading it |
| `bx` | `[x, y, w, h]` in **page** coordinates, integers | `getBoundingClientRect` + scroll offset | The main performance cost (layout read) | **v0.1** |
| `v` | Visibility: `hidden` (display none, visibility hidden, opacity 0 on the node or an ancestor), `zero` (zero-size box). **Absent means visible**: omitting the default saves roughly 15 bytes on most nodes | computed style + box | cheap once style is read | **v0.1** |
| `pos` | Computed position, **only when not static** (`fixed`, `sticky`, `absolute`) | computed style | cheap | **v0.1.** Fixed and sticky are how headers, banners and overlays reveal themselves |
| `st` | Reference into the style table | interning | see section 8 | **v0.1** |
| `ik` | Interactive kind: `button`, `link`, `text`, `email`, `password`, `checkbox`, `radio`, `select`, `textarea`, `file`, `submit`, `summary`... | tag + `type` attribute | tiny | **v0.1.** Native controls only. Observed |
| `dis` | Disabled | attribute | tiny | **v0.1.** A disabled button must not be restyled as active |
| `req` | Required | attribute | tiny | **v0.1** |
| `lk` | Link kind: `internal`, `external`, `anchor`, `mail`, `tel`, `other`. Computed by comparing `href` to the current location | spec-derived | tiny | **v0.1.** Replaces storing URLs, which can carry tokens |
| `p` | **Protected:** content withheld, with the reason (section 6) | attribute checks | removes cost | **v0.1.** Tells the planner "something is here that you cannot see" |
| `sr` | `"open"` or `"closed"` on shadow hosts, meaning children came from a shadow root (closed roots are only reachable through the extension API) | `element.shadowRoot` | cheap | **v0.1.** Styling and targeting behave differently inside shadow trees |
| `omit` | Count of children dropped by a budget | counter | tiny | **v0.1.** Truncation must be visible per node, not only in `warnings` |
| `rep` | Count of children **sampled out** because they repeat kept siblings of the same shape (product cards, feed items, table rows). Distinct from `omit`: no structure was lost, the kept siblings are representative | fingerprint of tag + class + child tags; only for sibling lists over 12 whose items each have 2+ element children | tiny | **v0.1.** Never applied to leaf-like siblings, so article paragraphs and nav links are not sampled. Phase 5 groups will formalize this with a count and an exemplar |

### Why `p`, `omit`, `limits`, `warnings` exist

They all exist so the planner knows what it **cannot** see. A planner that assumes it sees everything makes confident, wrong plans.

### Deliberately cut from nodes

| Cut | Why |
|---|---|
| `class`, `id`, other attributes | Large, noisy, occasionally sensitive. But they are strong hints on unfamiliar sites, so the inspector uses them **internally as evidence** (e.g. `name:sidebar-like`) without serializing them. OPEN: add a sanitized subset if the planner proves to need them |
| `href`, `src`, `value`, `placeholder` | Token and PII risk. `lk` and `n` cover the legitimate need |
| Selector or XPath | Targeting belongs to the registry and engine, not the description |
| Fingerprint | Needed for re-matching after DOM changes (Phase 7). Lives registry-side |
| Parent pointer | Derivable |
| padding, margin, gap | Derivable from sibling and parent/child boxes |
| z-index, overflow and clip state | Not needed yet |
| Event listeners | Not observable from a content script |
| `collapsedFrom` (wrapper folding) | Retracted for v0.1. Folding hides layout structure the planner may need (a wrapper may be the grid container) and complicates references. First do cheap skipping (no-box nodes, `display: contents`) and budgets. Add folding when real output proves it is needed |
| `mut` (mutability: safe to restructure) | Retracted for v0.1. "Safe to restructure" is a judgment about the engine, which does not exist yet to validate it. v0.1 ships the raw facts that would feed it (`p`, `ik`, `sr`, `pos`, warnings) |

---

## 6. Protected content (`p`)

`p` marks nodes where content **exists but was deliberately withheld or cannot be seen**. A `p`-flagged node keeps `t`, `bx`, `v`, `r` and `p`, and carries **no text, no name, and no children**.

| Value | Applies to | Why |
|---|---|---|
| `editable` | `contenteditable` subtrees | Contains user-authored text |
| `frame` | `<iframe>` | Opaque in v0.1 (cross-origin cannot be read; same-origin deferred) |
| `closed-shadow` | Hosts with closed shadow roots, where not accessible | Cannot be inspected |
| `sensitive` | `type=password`, or `autocomplete` tokens for credentials, payment, one-time codes | Planner must know this is a credential or payment field |

**Input values are never read at all**, for any input, so they never need a `p` flag. `p` is about content that would otherwise have been collected.

Further privacy rules (apply to all fields):

- Strip query strings and fragments from anything URL-derived. Drop `data:` and `blob:` URIs.
- No cookies, storage, or hidden form fields.
- The blueprint lives **in memory only** and is never persisted. Sending anything to an AI provider will be a separate, explicit, user-visible step with its own redaction pass.
- Optional later: pattern redaction of emails and long digit sequences in text snippets.

---

## 7. Text policy

Caps are **configuration, not schema**, so privacy can be tuned without a schema change.

Starting point (OPEN: confirm):

| Element kind | Policy |
|---|---|
| Headings, interactive names, link text | up to ~120 chars |
| Other text (paragraphs, list items) | length (`tl`) + short prefix (~40 chars) |
| `p`-flagged nodes | nothing |
| Input values | never read |

**Own-text only:** `tx` holds a node's direct text nodes, not descendants. This avoids duplicating a paragraph at every ancestor.

---

## 8. Style table

Nodes reference entries by `st`. Identical combinations share one entry (key a Map by the serialized values). This shrinks output dramatically and is simple, so it is in v0.1.

| Field | Meaning and why | Verdict |
|---|---|---|
| `display` | Layout mode | **v0.1** |
| `flow` | `row`, `column` or `grid` when `display` is flex or grid | **v0.1** |
| `font` | Primary font family | **v0.1** |
| `fs` | Font size (px) | **v0.1** |
| `fw` | Font weight | **v0.1** |
| `color` | Text color | **v0.1** |
| `bg` | Computed background color (alpha kept) | **v0.1** |
| `bgImg` | Boolean: a background image exists. URL never stored | **v0.1** |
| `radius` | Border radius (shape language) | **v0.1** |
| line-height, letter-spacing, text-transform | Typographic detail | **Later** |
| border, shadow, transform, z-index, opacity | Visual detail | **Later** |
| padding, margin, gap | Derivable from boxes | **Cut** |

**Cost:** `getComputedStyle` is read once per kept node, only for the properties above. Hidden subtrees never get style reads.

**Known limitation (accepted):** a node's computed `bg` is often transparent while its *effective* background comes from an ancestor. Resolving it costs an ancestor walk per node. OPEN: add `effective background` for region roots only if contrast reasoning becomes a real problem.

---

## 9. Inferred block

Every entry here carries `conf` and `ev`. **Nodes never do.**

### Confidence (`conf`)

Coarse bands: `high | med | low`. **Not decimals.**

- A number like 0.83 implies calibration that does not exist yet.
- Bands are derived from evidence rules (e.g. high = explicit landmark **and** corroborating geometry).
- In Phase 4, hand-labelled regions will allow measuring precision/recall; only then can numeric scores be justified.

### Evidence (`ev`)

A **closed vocabulary** of short codes (section 11). Why: failures become debuggable ("why did it call this a header?") and tests can assert on evidence.

### `regions[]`

| Field | Meaning and why | Verdict |
|---|---|---|
| `id` | Region reference | **v0.1** |
| `role` | One of `header`, `nav`, `main`, `aside`, `footer`, `overlay` | **v0.1.** Small closed vocabulary, no page-type words. `overlay` (fixed, viewport-covering layers such as cookie banners) is included because it appears on most sites; if it slows Phase 4, the detector can skip it without any schema change |
| `nodes[]` | Root node IDs. A list because a "header" may be several adjacent siblings | **v0.1** |
| `conf`, `ev` | See above | **v0.1** |
| region `box` | Union of root boxes | **Cut.** Derivable |
| nesting / parent region | | **Cut.** Derivable from the node tree |
| `importance`, `isPrimary` | | **Cut.** A design judgment |

If detection finds nothing convincing, emit **no region** and a `no-landmarks` warning. Do not guess to fill the vocabulary.

### `groups[]`

| Field | Meaning and why | Verdict |
|---|---|---|
| `id` | Group reference | **v0.1** |
| `container` | Node ID of the parent holding the repeated items | **v0.1** |
| `count` | Total members found | **v0.1** |
| `members[]` | A **sample** of member IDs (capped, e.g. 12) | **v0.1.** Listing hundreds wastes budget |
| `exemplar` | ID of one representative member. The planner reads its subtree to learn "what one item looks like" | **v0.1** |
| `layout` | `row`, `column`, `grid` or `flow`, derived from member boxes | **v0.1** (inferred, so it lives here) |
| `conf`, `ev` | e.g. `sib:same-tag`, `sib:same-sig`, `geo:uniform-size` | **v0.1** |
| `kind` ("card", "list", "toolbar") | | **Cut.** Naming a group's purpose is a guess. The planner can see the exemplar's contents |

### Blueprint is a view, registry is the truth

The registry can hold references for **all** group members even though the blueprint lists a sample, so the engine can still reach them. The blueprint tells the planner "there are 300 like this" and nothing more.

---

## 10. Temporary references

| Aspect | Decision |
|---|---|
| Format | **String IDs** like `"e12"`, not integers, so a future frame prefix (`"f2.e12"`) needs no schema change |
| Validity | Only within the same `epoch` and the same top-level frame. A new inspection starts a new epoch |
| Storage | `WeakMap` in the content script's isolated world (the **reference registry**). Nothing is written to the page |
| In the blueprint | Just the ID. No selector, no fingerprint, no node data |
| Scope for v0.1 | Top frame only. Iframes appear as nodes with `p: "frame"` and a warning |
| Later (Phase 7) | Fingerprint per node and confidence-reporting re-resolution; durable semantic selectors for site-wide plans |

**Why not stamp `data-*` attributes on the page:** it mutates the page, can trigger site MutationObservers, and some frameworks re-render and strip it.

---

## 11. Closed vocabularies

Keep these lists in sync with the code. Adding a value is a schema change.

### Warning codes

| Code | Meaning |
|---|---|
| `budget-nodes` | Node budget hit; content dropped |
| `budget-time` | Time budget hit; inspection partial |
| `budget-depth` | Depth cap hit |
| `text-truncated` | One or more text snippets capped |
| `repeats-sampled` | Repeated sibling components were sampled (see `rep` on the parent nodes) |
| `opaque-frame` | An iframe was not inspected |
| `closed-shadow` | A closed shadow root could not be inspected |
| `no-landmarks` | No convincing region found |
| `low-confidence-regions` | Regions were found but only with low confidence |
| `large-hidden-subtree-skipped` | A big hidden subtree was recorded but not expanded |
| `page-changed-during-inspection` | DOM mutated while inspecting; snapshot may be inconsistent |
| `style-read-failed` | A computed-style read failed for some node |

### Region roles

`header`, `nav`, `main`, `aside`, `footer`, `overlay`

### Evidence codes (starting set)

| Code | Meaning |
|---|---|
| `tag:<name>` | Semantic tag present (e.g. `tag:nav`) |
| `aria:<role>` | Explicit ARIA role present |
| `pos:fixed-top`, `pos:sticky` | Positioning evidence |
| `geo:fullwidth-top` | Full-width block near the top |
| `geo:narrow-side` | Narrow column beside a wide one |
| `geo:uniform-size` | Group members have similar boxes |
| `stat:text-dense` | High text density |
| `stat:link-dense` | High link density |
| `sib:same-tag` | Siblings share a tag |
| `sib:same-sig` | Siblings share a structural signature |
| `name:sidebar-like` | Class/id tokens resemble a known layout term (token itself not emitted) |

### Interactive kinds (`ik`)

`button`, `link`, `text`, `email`, `password`, `checkbox`, `radio`, `select`, `textarea`, `file`, `submit`, `summary`, `other` (native controls with no better label, such as range and color inputs)

### Link kinds (`lk`)

`internal`, `external`, `anchor`, `mail`, `tel`, `other`

---

## 12. Diagnostics (debug view only)

`diag` contains `inspectMs`, per-stage timing, `nodesVisited`, `nodesKept`, and which budgets were hit. It is useful from Phase 2 onward for performance work. It is **stripped before anything goes to the planner**, so debugging needs never bloat or leak into the planner's input.

---

## 13. Budgets (provisional)

Do not treat these as final. Measure real baselines in Phase 2, then revise.

| Budget | Starting value |
|---|---|
| `maxNodes` | 1500 |
| `maxDepth` | OPEN |
| Time per slice | OPEN (yield between chunks) |
| Hard time limit (`maxMs`) | 250 ms provisional. The walk stops and emits `budget-time`; tune after the baseline table |
| Medium-page first pass | ~300 ms or less |
| Medium-page blueprint size | ~100 KB or less |
| Repeat/incremental inspection | under ~20% of first pass |

When a budget is hit: prioritize viewport-visible content and high-confidence regions; **summarize** rather than silently drop; record what was cut in `limits`, `omit` and `warnings`.

---

## 14. Example (trimmed)

```json
{
  "v": "0.1",
  "meta": {
    "host": "example.org",
    "title": "Spider-Man",
    "dir": "ltr",
    "viewport": [1440, 900],
    "scroll": [0, 0],
    "docSize": [1440, 12400],
    "epoch": 1
  },
  "limits": { "maxNodes": 1500, "nodesVisited": 2210, "nodesKept": 640 },
  "warnings": [
    { "code": "text-truncated" },
    { "code": "opaque-frame", "node": "e88" }
  ],
  "root": "e1",
  "nodes": {
    "e1":  { "t": "body", "c": ["e2", "e9"], "bx": [0, 0, 1440, 12400], "v": "visible", "st": "s1" },
    "e2":  { "t": "header", "r": "banner", "c": ["e3"], "bx": [0, 0, 1440, 64], "v": "visible", "pos": "sticky", "st": "s2" },
    "e3":  { "t": "a", "ik": "link", "lk": "internal", "n": "Home", "bx": [24, 20, 60, 24], "v": "visible", "st": "s3" },
    "e9":  { "t": "main", "r": "main", "c": ["e10", "e88"], "omit": 310, "bx": [220, 64, 1000, 12300], "v": "visible", "st": "s1" },
    "e10": { "t": "h1", "r": "heading", "lv": 1, "tx": "Spider-Man", "tl": 10, "bx": [240, 90, 400, 44], "v": "visible", "st": "s4" },
    "e88": { "t": "iframe", "p": "frame", "bx": [240, 600, 560, 315], "v": "visible" }
  },
  "styles": {
    "s1": { "display": "block", "font": "Georgia", "fs": 16, "fw": 400, "color": "#202122", "bg": "#ffffff" },
    "s4": { "display": "block", "font": "Georgia", "fs": 32, "fw": 700, "color": "#000000", "bg": "transparent" }
  },
  "inferred": {
    "regions": [
      { "id": "r1", "role": "header", "nodes": ["e2"], "conf": "high", "ev": ["tag:header", "pos:sticky", "geo:fullwidth-top"] },
      { "id": "r2", "role": "main", "nodes": ["e9"], "conf": "high", "ev": ["tag:main", "stat:text-dense"] }
    ],
    "groups": []
  }
}
```

Note: the example is trimmed, so some referenced style IDs (`s2`, `s3`) are not shown.

---

## 15. Decision log

| # | Decision | Rejected alternative | Revisit when |
|---|---|---|---|
| 1 | Facts and inferences are structurally separate | Inline `role/conf` on nodes | Never, unless it proves unworkable |
| 2 | Coarse confidence bands | Decimals | Phase 4 has labelled data to calibrate |
| 3 | Class/id used as internal evidence, not emitted | Emit raw class/id | Planner shows it needs semantic names |
| 4 | `lk` instead of URLs | Store `href` | A planner use case needs destinations |
| 5 | Host only, no path | Store path | Phase 7 site layer |
| 6 | Spacing derived from boxes | Collect padding/margin/gap | Derivation proves unreliable |
| 7 | No wrapper collapsing in v0.1 | `collapsedFrom` | Real output is too large or too deep |
| 8 | No `mut` field in v0.1 | Inspector-assigned mutability | An engine exists to validate it |
| 9 | No `kind` on groups, no `importance` anywhere | Name groups, score importance | Planner cannot work without it |
| 10 | Own-text only; caps in config | Subtree text; caps in schema | Privacy review |
| 11 | Blueprint is a view; registry is the truth | Blueprint lists every reference | Never |
| 12 | String IDs, top-frame only | Integer IDs | Frames become in scope |
| 13 | Planner view vs debug view (`diag`) | One merged output | Never |
| 14 | Style table (interning) in v0.1 | Inline styles per node | Never; it is simple and cuts size sharply |
| 15 | Page coordinates for `bx` | Viewport coordinates | Reading boxes becomes a real pain |
| 16 | Structural signature deferred to v0.2 | Include now | Phase 5 (computed from regions and groups) |
| 17 | Sample repeated siblings only when they look like components (2+ element children) | Sample every repeated tag, which would cut article paragraphs | Phase 5 groups replace this heuristic |

---

## 16. Open questions

- [ ] **Text exposure:** are the proposed caps acceptable, or should non-heading text be length only?
- [ ] **Class/id hints:** keep them internal-only, or emit a sanitized subset?
- [ ] **Coordinate system:** page coordinates (chosen) vs viewport coordinates.
- [ ] **`maxDepth` and per-slice time budget:** pick values after Phase 2 baselines.
- [ ] **`overlay` region role:** keep in the vocabulary, or defer detection to later?
- [ ] **Effective background** for region roots: needed, or can it wait?

---

## 17. Backlog (candidates for v0.2 and beyond)

| Candidate | Depends on |
|---|---|
| Structural signature (content-independent page fingerprint) | Regions and groups working (Phase 5) |
| Wrapper collapsing | Evidence from real output |
| Transformability / mutability assessment | An engine to validate against |
| Reference fingerprints and re-matching | Site layer (Phase 7) |
| `meta.path`, `meta.lang`, `meta.colorScheme` | A consumer that needs them |
| Extra style properties (line-height, border, shadow, z-index, opacity) | Planner feedback |
| Same-origin iframe inspection; closed shadow roots | Demonstrated need |
| Effective background color for region roots | Contrast problems observed |
| Numeric confidence | Labelled data (Phase 4) |
| Screenshot-based verification | Phase 9 |

---

## 18. Related roadmap phases

| Phase | Relevance to this schema |
|---|---|
| A | Freeze this schema, allowlists, budgets, fixtures |
| 0-1 | Plumbing, safe traversal, privacy gate, registry |
| 2 | Fill `bx`, `v`, `pos`, `st`; record baselines for budgets |
| 3 | Budgets, `omit`, `limits`, `warnings` |
| 4 | `regions`, `conf`, `ev`, debug overlay, hand-labelled ground truth |
| 5 | `groups`, palette summary, structural signature |
| 6 | Shadow DOM, opaque iframes, staleness, incremental inspection |
| 7+ | Site layer: persistence, navigation, durable selectors |