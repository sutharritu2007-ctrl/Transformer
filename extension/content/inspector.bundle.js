var TransformerInspector = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // Architecture/inspect.js
  var inspect_exports = {};
  __export(inspect_exports, {
    inspect: () => inspect,
    toPlannerView: () => toPlannerView
  });

  // Architecture/registry.js
  function createRegistry(epoch) {
    let counter = 0;
    const idByElement = /* @__PURE__ */ new WeakMap();
    const refById = /* @__PURE__ */ new Map();
    return {
      epoch,
      /** Give an element an ID (or return the one it already has). */
      assign(el) {
        const existing = idByElement.get(el);
        if (existing) return existing;
        const id = "e" + ++counter;
        idByElement.set(el, id);
        refById.set(id, new WeakRef(el));
        return id;
      },
      /** The ID of an element, or null if it was never recorded. */
      idOf(el) {
        return idByElement.get(el) ?? null;
      },
      /** The real element for an ID, or null if it is gone or unknown. */
      resolve(id) {
        return refById.get(id)?.deref() ?? null;
      },
      get size() {
        return counter;
      }
    };
  }

  // Architecture/safety.js
  var SKIP_TAGS = /* @__PURE__ */ new Set([
    "script",
    "style",
    "noscript",
    "template",
    "link",
    "meta",
    "base",
    "title",
    "head"
  ]);
  var OPAQUE_TAGS = /* @__PURE__ */ new Set([
    "svg",
    "canvas",
    "video",
    "audio",
    "object",
    "embed",
    "select",
    "datalist",
    "math"
  ]);
  var FORM_CONTROLS = /* @__PURE__ */ new Set(["input", "textarea", "select"]);
  var SENSITIVE_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/;
  function hasSensitiveAutocomplete(el) {
    const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    return tokens.some((token) => SENSITIVE_AUTOCOMPLETE.test(token));
  }
  var skip = () => ({ action: "skip", descend: false, protect: null });
  var keep = (descend, protect) => ({ action: "keep", descend, protect });
  function classifyElement(el) {
    const tag = el.localName;
    if (SKIP_TAGS.has(tag)) return skip();
    if (tag === "input" && el.type === "hidden") return skip();
    if (tag === "iframe" || tag === "frame") return keep(false, "frame");
    if (el.isContentEditable) return keep(false, "editable");
    if (FORM_CONTROLS.has(tag) && (el.type === "password" || hasSensitiveAutocomplete(el))) {
      return keep(false, "sensitive");
    }
    if (OPAQUE_TAGS.has(tag)) return keep(false, null);
    return keep(true, null);
  }

  // Architecture/traversal.js
  var DEFAULT_SAMPLE = { threshold: 12, keep: 6, minChildElements: 2 };
  var WRAPPER_TAGS = /* @__PURE__ */ new Set(["div", "span"]);
  var EMPTY_LEAF_TAGS = /* @__PURE__ */ new Set(["div", "span", "i"]);
  function getShadowRoot(el) {
    try {
      if (typeof chrome !== "undefined" && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        return chrome.dom.openOrClosedShadowRoot(el);
      }
    } catch (_) {
    }
    return el.shadowRoot;
  }
  function getChildElements(el) {
    if (el.localName === "slot" && typeof el.assignedElements === "function") {
      const assigned = el.assignedElements({ flatten: true });
      if (assigned.length > 0) return { children: assigned, shadow: null };
    }
    const root = getShadowRoot(el);
    if (root) return { children: Array.from(root.children), shadow: root.mode };
    return { children: Array.from(el.children), shadow: null };
  }
  function shapeSignature(el, minChildElements) {
    if (el.childElementCount < minChildElements) return null;
    const tags = [];
    for (let c = el.firstElementChild; c && tags.length < 6; c = c.nextElementSibling) {
      tags.push(c.localName);
    }
    const cls = (el.getAttribute("class") || "").trim().replace(/\s+/g, " ");
    return el.localName + "|" + cls + "|" + tags.join(",");
  }
  function isPlainWrapper(rec) {
    return rec.plain === true && WRAPPER_TAGS.has(rec.tag) && rec.shadow === null && !rec.protect && !rec.role && !rec.ik && !rec.n && !rec.tx && !rec.lv;
  }
  function isEmptyLeaf(rec) {
    return EMPTY_LEAF_TAGS.has(rec.tag) && rec.vis === "zero" && rec.el.childElementCount === 0 && getShadowRoot(rec.el) === null && !rec.protect && !rec.role && !rec.ik && !rec.n && !rec.tx;
  }
  function sameBox(a, b) {
    return Boolean(a && b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  }
  function traverse(root, {
    registry,
    maxNodes = 1500,
    maxDepth = 60,
    maxMs = 250,
    sample = DEFAULT_SAMPLE,
    fold = true,
    onRecord = null
  } = {}) {
    if (!registry) throw new Error("traverse() needs a registry");
    const t0 = performance.now();
    const records = [];
    const warnings = [];
    const stats = {
      visited: 0,
      skipped: 0,
      sampled: 0,
      // children dropped as repeats of kept siblings
      collapsed: 0,
      // inert wrappers folded away
      emptyDropped: 0,
      // invisible empty leaves left out
      recorded: 0,
      // records made (includes folded and dropped ones)
      kept: 0,
      // nodes that end up in the blueprint
      maxDepthSeen: 0,
      // deepest record, relative to `root` (raw DOM depth)
      elementsInRoot: 0,
      // how big the subtree really is (light DOM only)
      elapsedMs: 0
    };
    stats.elementsInRoot = root.getElementsByTagName("*").length;
    let used = 0;
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
        drop: false
      };
      records.push(rec);
      used++;
      if (depth > stats.maxDepthSeen) stats.maxDepthSeen = depth;
      if (decision.protect === "frame") warnings.push({ code: "opaque-frame", node: rec.id });
      if (onRecord) onRecord(rec, parent >= 0 ? records[parent] : null);
      return rec;
    };
    const finish = () => {
      stats.recorded = records.length;
      stats.kept = records.length - stats.collapsed - stats.emptyDropped;
      stats.elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
      return { records, stats, warnings };
    };
    stats.visited++;
    const rootDecision = classifyElement(root);
    if (rootDecision.action === "skip") {
      stats.skipped++;
      return finish();
    }
    addRecord(root, -1, 0, rootDecision);
    for (let i = 0; i < records.length; i++) {
      if ((i & 31) === 0 && performance.now() - t0 > maxMs) {
        warnings.push({ code: "budget-time" });
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
          warnings.push({ code: "budget-depth", node: rec.id });
        }
        continue;
      }
      let sigs = null;
      let totals = null;
      if (sample && children.length > sample.threshold) {
        sigs = children.map((child) => shapeSignature(child, sample.minChildElements));
        totals = /* @__PURE__ */ new Map();
        for (const sig of sigs) {
          if (sig) totals.set(sig, (totals.get(sig) || 0) + 1);
        }
      }
      const keptBySig = /* @__PURE__ */ new Map();
      const childRecs = [];
      for (let k = 0; k < children.length; k++) {
        const child = children[k];
        stats.visited++;
        const decision = classifyElement(child);
        if (decision.action === "skip") {
          stats.skipped++;
          continue;
        }
        if (registry.idOf(child) !== null) continue;
        const sig = sigs ? sigs[k] : null;
        if (sig && totals.get(sig) > sample.threshold) {
          const already = keptBySig.get(sig) || 0;
          if (already >= sample.keep) {
            rec.repeated++;
            stats.sampled++;
            if (!sampledWarned) {
              sampledWarned = true;
              warnings.push({ code: "repeats-sampled" });
            }
            continue;
          }
          keptBySig.set(sig, already + 1);
        }
        if (used >= maxNodes) {
          rec.omitted++;
          if (!nodeBudgetWarned) {
            nodeBudgetWarned = true;
            warnings.push({ code: "budget-nodes" });
          }
          continue;
        }
        const childRec = addRecord(child, i, rec.depth + 1, decision);
        rec.children.push(childRec.id);
        childRecs.push(childRec);
        if (fold && isEmptyLeaf(childRec)) {
          childRec.drop = true;
          stats.emptyDropped++;
          used--;
        }
      }
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

  // Architecture/geometry.js
  var NOTABLE_POSITIONS = /* @__PURE__ */ new Set(["fixed", "sticky", "absolute"]);
  function measure(rec, cs, parentRec, scroll) {
    const display = cs.display;
    const opacityHidden = parentRec !== null && parentRec.opacityHidden === true || cs.opacity === "0";
    rec.opacityHidden = opacityHidden;
    if (display === "none") {
      rec.vis = "hidden";
      rec.descend = false;
      rec.hiddenSubtree = true;
      return;
    }
    if (display === "contents") {
      rec.vis = opacityHidden ? "hidden" : "visible";
      return;
    }
    const r = rec.el.getBoundingClientRect();
    rec.bx = [
      Math.round(r.left + scroll.x),
      Math.round(r.top + scroll.y),
      Math.round(r.width),
      Math.round(r.height)
    ];
    if (cs.visibility !== "visible" || opacityHidden) rec.vis = "hidden";
    else if (r.width === 0 && r.height === 0) rec.vis = "zero";
    else rec.vis = "visible";
    if (NOTABLE_POSITIONS.has(cs.position)) rec.pos = cs.position;
  }

  // Architecture/style.js
  function createStyleTable() {
    const idByKey = /* @__PURE__ */ new Map();
    const table = {};
    let counter = 0;
    return {
      table,
      /** Store an entry (or find the identical one) and return its id. */
      intern(entry) {
        const key = JSON.stringify(entry);
        let id = idByKey.get(key);
        if (!id) {
          id = "s" + ++counter;
          idByKey.set(key, id);
          table[id] = entry;
        }
        return id;
      },
      get size() {
        return counter;
      }
    };
  }
  function firstFamily(value) {
    return (value || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  }
  var round1 = (n) => Math.round(n * 10) / 10;
  function collectStyle(rec, cs, styles) {
    const display = cs.display;
    const entry = {
      display,
      font: firstFamily(cs.fontFamily),
      fs: round1(parseFloat(cs.fontSize) || 0),
      fw: parseInt(cs.fontWeight, 10) || 400,
      color: cs.color,
      bg: cs.backgroundColor
      // often transparent; effective background is a later concern
    };
    if (display.includes("flex")) {
      entry.flow = cs.flexDirection.startsWith("column") ? "column" : "row";
    } else if (display.includes("grid")) {
      entry.flow = "grid";
    }
    if (cs.backgroundImage && cs.backgroundImage !== "none") entry.bgImg = true;
    if (cs.borderRadius && cs.borderRadius !== "0px") entry.radius = cs.borderRadius;
    rec.st = styles.intern(entry);
  }

  // Architecture/semantics.js
  var TEXT_CAP_STRONG = 120;
  var TEXT_CAP_DEFAULT = 40;
  var NAME_CAP = 80;
  var IMPLICIT_ROLE = {
    nav: "navigation",
    main: "main",
    aside: "complementary",
    article: "article",
    ul: "list",
    ol: "list",
    li: "listitem",
    img: "img",
    form: "form",
    table: "table",
    button: "button",
    textarea: "textbox",
    dialog: "dialog",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading"
  };
  var NAMED_ROLES = /* @__PURE__ */ new Set([
    "navigation",
    "main",
    "complementary",
    "banner",
    "contentinfo",
    "region",
    "form",
    "dialog",
    "search"
  ]);
  var NAME_FROM_CONTENT = /* @__PURE__ */ new Set(["link", "button", "submit", "summary"]);
  var SKIP_TEXT_TAGS = /* @__PURE__ */ new Set(["script", "style", "noscript", "template"]);
  var clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  function looksLikeMetadata(value) {
    const s = clean(value);
    if (!s || s.length < 8) return false;
    if (s.startsWith("{") && s.endsWith("}") || s.startsWith("[") && s.endsWith("]")) {
      const hasQuotedKey = /["']\s*\w+\s*["']\s*:/.test(s);
      const hasComma = s.includes(",");
      if (hasQuotedKey && hasComma) return true;
    }
    if (/(?:^|[,{\s])(?:color|size|variant|sku|product|item|mainColorId|colorId|sizeId|styleId|option|selected|select)["'\s:]/i.test(s)) {
      const hasJsonLikeColon = s.includes(":") && s.includes(",");
      const hasNumberishPair = /\b\w+Id\b\s*:/i.test(s) || /\b\w+\s*:\s*(?:\d+|true|false|null|["'])/i.test(s);
      if (hasJsonLikeColon || hasNumberishPair) return true;
    }
    return false;
  }
  function sanitizeName(value) {
    const s = clean(value);
    if (!s) return "";
    if (looksLikeMetadata(s)) return "";
    return s;
  }
  function cut(text, cap) {
    if (text.length <= cap) return text;
    return text.slice(0, cap).replace(/[\uD800-\uDBFF]$/, "");
  }
  function effectiveRole(el, tag) {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
    if (/^[a-z-]{2,30}$/.test(explicit)) return explicit;
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "header" || tag === "footer") {
      if (el.closest("article, aside, main, nav, section")) return null;
      return tag === "header" ? "banner" : "contentinfo";
    }
    return IMPLICIT_ROLE[tag] ?? null;
  }
  function headingLevel(el, tag, role) {
    const m = /^h([1-6])$/.exec(tag);
    if (m) return Number(m[1]);
    if (role === "heading") {
      const level = parseInt(el.getAttribute("aria-level"), 10);
      if (level >= 1 && level <= 9) return level;
    }
    return null;
  }
  function interactiveKind(el, tag, role) {
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : null;
    if (tag === "summary") return "summary";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (tag === "button") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return type === "submit" || type === "" && el.form ? "submit" : "button";
    }
    if (tag === "input") {
      switch (el.type) {
        case "password":
          return "password";
        case "email":
          return "email";
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "file":
          return "file";
        case "submit":
          return "submit";
        case "button":
        case "reset":
        case "image":
          return "button";
        case "range":
        case "color":
          return "other";
        default:
          return "text";
      }
    }
    if (role === "button" || role === "link" || role === "checkbox" || role === "radio") return role;
    return null;
  }
  function isDisabled(el) {
    try {
      return el.matches(":disabled");
    } catch (_) {
      return false;
    }
  }
  function linkKind(el) {
    const attr = (el.getAttribute("href") || "").trim();
    if (attr.startsWith("#")) return "anchor";
    let url;
    try {
      url = new URL(attr, document.baseURI);
    } catch (_) {
      return "other";
    }
    switch (url.protocol) {
      case "mailto:":
        return "mail";
      case "tel:":
        return "tel";
      case "http:":
      case "https:":
        return url.origin === location.origin ? "internal" : "external";
      default:
        return "other";
    }
  }
  function ownText(el) {
    let s = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) s += node.nodeValue;
    }
    return clean(s);
  }
  function collectText(el, cap) {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = "";
    for (let node = walker.nextNode(); node && out.length < cap; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && SKIP_TEXT_TAGS.has(parent.localName)) continue;
      out += " " + node.nodeValue;
    }
    return clean(out);
  }
  function accessibleName(el, tag, ik, role) {
    const root = el.getRootNode();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby && typeof root.getElementById === "function") {
      const parts = labelledby.split(/\s+/).map((id) => root.getElementById(id)).filter(Boolean).map((node) => collectText(node, NAME_CAP));
      const joined = clean(parts.join(" "));
      if (joined) return joined;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.labels && el.labels.length > 0) {
      const fromLabels = clean(Array.from(el.labels, (l) => collectText(l, NAME_CAP)).join(" "));
      if (fromLabels) return fromLabels;
    }
    if (tag === "img" || tag === "area" || tag === "input" && el.type === "image") {
      const alt = clean(el.getAttribute("alt"));
      if (alt) return alt;
    }
    if (tag === "input" && (el.type === "submit" || el.type === "button" || el.type === "reset")) {
      const label = clean(el.getAttribute("value"));
      if (label) return label;
    }
    const title = clean(el.getAttribute("title"));
    if (title) return title;
    if (NAME_FROM_CONTENT.has(ik) || role === "button" || role === "link") {
      const content = collectText(el, NAME_CAP);
      if (content) return content;
      const img = el.querySelector("img[alt]");
      if (img) return clean(img.getAttribute("alt"));
    }
    return "";
  }
  function annotate(rec, ctx) {
    const el = rec.el;
    const tag = rec.tag;
    const role = effectiveRole(el, tag);
    if (role) rec.role = role;
    const lv = headingLevel(el, tag, role);
    if (lv) rec.lv = lv;
    const ik = interactiveKind(el, tag, role);
    if (ik) {
      rec.ik = ik;
      if (isDisabled(el)) rec.dis = true;
      if (el.required === true) rec.req = true;
    }
    if (rec.protect) return;
    if (tag === "a" && ik === "link") rec.lk = linkKind(el);
    const text = tag === "textarea" ? "" : ownText(el);
    if (text) {
      const cap = ik || role === "heading" ? TEXT_CAP_STRONG : TEXT_CAP_DEFAULT;
      if (text.length > cap) ctx.warn("text-truncated");
      rec.tl = text.length;
      rec.tx = cut(text, cap);
    }
    if (ik || tag === "img" || NAMED_ROLES.has(role)) {
      const full = accessibleName(el, tag, ik, role);
      const safe = sanitizeName(full);
      if (safe) {
        if (safe.length > NAME_CAP) ctx.warn("text-truncated");
        const name = cut(safe, NAME_CAP);
        if (name !== rec.tx) rec.n = name;
      }
    }
  }

  // Architecture/serialize.js
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
    if (rec.vis && rec.vis !== "visible") n.v = rec.vis;
    if (rec.pos) n.pos = rec.pos;
    if (rec.st) n.st = rec.st;
    if (rec.ik) n.ik = rec.ik;
    if (rec.dis) n.dis = true;
    if (rec.req) n.req = true;
    if (rec.lk) n.lk = rec.lk;
    if (rec.protect) n.p = rec.protect;
    if (rec.shadow) n.sr = rec.shadow;
    if (rec.omitted) n.omit = rec.omitted;
    if (rec.repeated) n.rep = rec.repeated;
    if (rec.cw) n.cw = rec.cw;
    return n;
  }
  var round12 = (n) => Math.round(n * 10) / 10;
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
  function serialize({ records, stats, warnings, styles, timers, config, meta, inferred = { regions: [], groups: [] } }) {
    const byId = new Map(records.map((r) => [r.id, r]));
    const live = records.filter((r) => !r.collapsed && !r.drop);
    const lifted = /* @__PURE__ */ new Map();
    for (const rec of live) lifted.set(rec.id, liftChildren(rec.children, byId, 0));
    const nodes = {};
    for (const rec of live) nodes[rec.id] = serializeNode(rec, lifted.get(rec.id));
    const timersMs = {};
    for (const [name, ms] of Object.entries(timers)) timersMs[name] = round12(ms);
    const normalizedInferred = inferred && typeof inferred === "object" ? inferred : { regions: [], groups: [] };
    const overview = normalizedInferred.overview || {
      pageSummary: {
        regionCount: (normalizedInferred.regions || []).length,
        groupCount: (normalizedInferred.groups || []).length
      },
      regions: (normalizedInferred.regions || []).slice(0, 8).map((r) => ({ id: r.id, role: r.role, kind: r.kind, conf: r.conf })),
      groups: (normalizedInferred.groups || []).slice(0, 8).map((g) => ({ id: g.id, kind: g.kind, count: g.count, conf: g.conf, parent: g.parent }))
    };
    return {
      v: "0.1",
      meta,
      limits: {
        maxNodes: config.maxNodes,
        maxDepth: config.maxDepth,
        maxMs: config.maxMs,
        nodesVisited: stats.visited,
        nodesKept: stats.kept,
        totalElements: stats.elementsInRoot
      },
      warnings,
      root: records.length > 0 ? records[0].id : null,
      nodes,
      styles: styles.table,
      overview,
      inferred: {
        regions: normalizedInferred.regions || [],
        groups: normalizedInferred.groups || []
      },
      diag: { stats, timersMs, styleCount: styles.size, bytes: 0, totalMs: 0 }
    };
  }
  function toPlannerView(blueprint) {
    const { diag, ...rest } = blueprint;
    return rest;
  }

  // Architecture/inspect.js
  var HIDDEN_SUBTREE_WARN_MIN = 20;
  function collectMeta(epoch) {
    const de = document.documentElement;
    return {
      host: location.hostname,
      title: (document.title || "").replace(/\s+/g, " ").trim().slice(0, 120),
      dir: getComputedStyle(de).direction,
      viewport: [window.innerWidth, window.innerHeight],
      scroll: [Math.round(window.scrollX), Math.round(window.scrollY)],
      docSize: [de.scrollWidth, de.scrollHeight],
      epoch
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
      existing.nodes = Array.from(/* @__PURE__ */ new Set([...existing.nodes, ...c.nodes]));
      existing.ev = Array.from(/* @__PURE__ */ new Set([...existing.ev, ...c.ev]));
      if (!existing.box || areaOfBox(existing.box) < areaOfBox(c.box)) existing.box = c.box;
    }
    return merged.sort((a, b) => b.conf - a.conf);
  }
  function scoreRegionCandidate(rec, parentRec, siblings) {
    if (!rec.bx || rec.bx[2] <= 0 || rec.bx[3] <= 0) return 0;
    if (rec.drop || rec.collapsed || rec.protect || rec.vis === "hidden" || rec.vis === "zero") return 0;
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
      aside: 0.3
    };
    const tagBoost = semanticBoost[role] || 0;
    score += tagBoost;
    evidence.push(`role:${role}`);
    if (area > viewportW * viewportH * 0.08) score += 0.18, evidence.push("large-area");
    if (width > viewportW * 0.35) score += 0.15, evidence.push("wide");
    if (height > viewportH * 0.12) score += 0.1, evidence.push("tall");
    if (box[1] < 80) score += 0.1, evidence.push("top-band");
    if (box[1] + box[3] > (document.documentElement?.scrollHeight || 0) * 0.7) score += 0.08, evidence.push("bottom-band");
    if (rec.pos === "sticky" || rec.pos === "fixed") score += 0.12, evidence.push("sticky-or-fixed");
    if (textDensity > 120) score += 0.1, evidence.push("text-dense");
    if ((rec.children || []).length >= 4) score += 0.08, evidence.push("has-children");
    if (role === "navigation" || rec.tag === "nav") {
      const links = (rec.children || []).length;
      if (links >= 3) score += 0.22, evidence.push("nav-links");
    }
    if (role === "main" || rec.tag === "main") {
      if (width > viewportW * 0.25) score += 0.12, evidence.push("main-width");
      if (height > 180) score += 0.08, evidence.push("main-height");
    }
    if (role === "complementary" || rec.tag === "aside") {
      if (width < viewportW * 0.5) score += 0.14, evidence.push("sidebar-width");
      if (parentRec && parentRec.role === "main") score += 0.1, evidence.push("adjacent-to-main");
    }
    if (rec.tag === "header" || rec.role === "banner") {
      if (box[1] <= 80 && width > viewportW * 0.5) score += 0.1, evidence.push("header-pattern");
    }
    if (rec.tag === "footer" || rec.role === "contentinfo") {
      if (box[1] + box[3] > (document.documentElement?.scrollHeight || 0) * 0.7) score += 0.12, evidence.push("footer-pattern");
    }
    const containsMain = siblings.some((sibling) => sibling !== rec && sibling.role === "main" && overlaps(box, sibling.bx));
    if (containsMain) score -= 0.1;
    const overlapPenalty = siblings.some((sibling) => sibling !== rec && sibling.role && sibling.role !== rec.role && overlaps(box, sibling.bx) && areaOfBox(sibling.bx) > area * 0.8);
    if (overlapPenalty) score -= 0.15;
    return Math.max(0, Math.min(1, score));
  }
  function isMeaningfulChildRecord(child, byId) {
    if (!child) return false;
    const textValue = (child.tx || child.n || "").trim();
    if (textValue && !/^[-+]?\d+(?:\.\d+)?%?$/.test(textValue)) {
      if (child.role || child.ik || child.lv || child.n || child.tx) return true;
    }
    if (child.role || child.ik || child.lv) return true;
    const descendants = (child.children || []).map((id) => byId.get(id)).filter(Boolean);
    return descendants.some((desc) => {
      if (!desc) return false;
      const descText = (desc.tx || desc.n || "").trim();
      if (descText && !/^[-+]?\d+(?:\.\d+)?%?$/.test(descText)) {
        if (desc.role || desc.ik || desc.lv || desc.n || desc.tx) return true;
      }
      if (desc.role || desc.ik || desc.lv) return true;
      return ["button", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "article", "section", "nav", "main", "aside", "ul", "ol"].includes(desc.tag);
    });
  }
  function isGenericWrapperCluster(members, byId) {
    if (!members.length) return false;
    return members.every((child) => {
      if (!child) return false;
      if (child.role || child.ik || child.lv || child.n || child.tx) return false;
      const totalText = (child.tx || "").trim();
      if (totalText && /^[-+]?\d+(?:\.\d+)?%?$/.test(totalText)) return true;
      const descendants = (child.children || []).map((id) => byId.get(id)).filter(Boolean);
      if (descendants.length === 0) return true;
      if (descendants.some((desc) => isMeaningfulChildRecord(desc, byId))) return false;
      const shortNumeric = descendants.every((desc) => {
        const text = (desc.tx || "").trim();
        return !text || /^[-+]?\d+(?:\.\d+)?%?$/.test(text) || text.length <= 4;
      });
      return shortNumeric;
    });
  }
  function getStructureSignature(child, byId) {
    if (!child || !Array.isArray(child.children)) return /* @__PURE__ */ new Set();
    const set = /* @__PURE__ */ new Set();
    for (const id of child.children) {
      const desc = byId.get(id);
      if (!desc || desc.drop || desc.collapsed || desc.vis === "hidden" || desc.vis === "zero") continue;
      const tag = (desc.role || desc.tag || "").toLowerCase();
      if (!tag || ["script", "style"].includes(tag)) continue;
      set.add(tag);
    }
    return set;
  }
  function similarityBetween(a, b) {
    if (!a || !b) return 0;
    const union = /* @__PURE__ */ new Set([...a, ...b]);
    const intersection = new Set([...a].filter((value) => b.has(value)));
    if (!union.size) return 1;
    return intersection.size / union.size;
  }
  function inferBlueprint(records) {
    const byId = new Map(records.map((r) => [r.id, r]));
    const visible = records.filter((r) => !r.drop && !r.collapsed && !r.protect && r.vis !== "hidden" && r.vis !== "zero" && r.bx);
    const regionCandidates = [];
    for (const rec of visible) {
      if (!rec.role && !rec.tag) continue;
      const role = rec.role || rec.tag;
      const allowed = /* @__PURE__ */ new Set(["banner", "header", "nav", "navigation", "main", "aside", "complementary", "footer", "contentinfo", "region", "form", "search", "dialog", "article"]);
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
        ev: [`role:${rec.role || rec.tag}`, `score:${score.toFixed(2)}`]
      });
    }
    const regions = mergeCandidates(regionCandidates).filter((region) => region.conf >= 0.42).slice(0, 12).map((region) => ({
      id: region.id,
      role: region.role,
      kind: region.kind,
      nodes: region.nodes,
      conf: region.conf,
      ev: region.ev
    }));
    const groups = [];
    const groupParents = /* @__PURE__ */ new Set();
    for (const rec of visible) {
      if (!rec.children || rec.children.length < 2) continue;
      const childList = rec.children.map((id) => byId.get(id)).filter(Boolean);
      const meaningfulChildren = childList.filter((child) => !child.drop && !child.collapsed && child.vis !== "hidden" && child.vis !== "zero" && child.bx && child.tag !== "script");
      if (meaningfulChildren.length < 2) continue;
      const shapeMap = /* @__PURE__ */ new Map();
      for (const child of meaningfulChildren) {
        const key = `${child.tag}|${child.role || ""}|${child.ik || ""}|${child.children?.length || 0}`;
        const arr = shapeMap.get(key) || [];
        arr.push(child.id);
        shapeMap.set(key, arr);
      }
      const repeated = [...shapeMap.entries()].map(([key, ids]) => ({ key, ids })).filter(({ ids }) => ids.length >= 2).sort((a, b) => b.ids.length - a.ids.length);
      let best = repeated[0] || null;
      let members = best ? best.ids.slice(0, 12) : [];
      if (!best) {
        const byTag = /* @__PURE__ */ new Map();
        for (const child of meaningfulChildren) {
          const tag = (child.role || child.tag || "").toLowerCase() || "div";
          const arr = byTag.get(tag) || [];
          arr.push(child.id);
          byTag.set(tag, arr);
        }
        const fallback = [...byTag.entries()].map(([key, ids]) => ({ key, ids: ids.slice(0, 12) })).filter(({ ids }) => ids.length >= 2).map(({ key, ids }) => {
          const records2 = ids.map((id) => byId.get(id)).filter(Boolean);
          const semanticSignals2 = records2.filter((child) => isMeaningfulChildRecord(child, byId)).length;
          if (semanticSignals2 < 1) return null;
          const structureScores = [];
          for (let i = 0; i < records2.length; i++) {
            for (let j = i + 1; j < records2.length; j++) {
              structureScores.push(similarityBetween(getStructureSignature(records2[i], byId), getStructureSignature(records2[j], byId)));
            }
          }
          const structureScore = structureScores.length ? structureScores.reduce((sum, value) => sum + value, 0) / structureScores.length : 0;
          return { key, ids, structureScore, semanticSignals: semanticSignals2 };
        }).filter(Boolean).sort((a, b) => b.semanticSignals + b.structureScore - (a.semanticSignals + a.structureScore))[0];
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
      const semanticBonus = semanticSignals / Math.max(1, memberRecords.length) * 0.18;
      const strongPair = memberRecords.length === 2 && semanticSignals >= 1 && consistency >= 0.6;
      const minimumCount = meaningfulChildren.length >= 3 || strongPair;
      if (!minimumCount && !(best && best.key && memberRecords.length >= 2 && semanticSignals >= 1 && meaningfulChildren.length >= 2)) continue;
      const score = Math.min(0.98, 0.38 + best.ids.length / Math.max(2, meaningfulChildren.length) * 0.28 + consistency * 0.2 + structureBonus + semanticBonus);
      if (score < 0.5) continue;
      groupParents.add(rec.id);
      groups.push({
        id: `g${groups.length + 1}`,
        kind: best.key.split("|")[0] === "article" ? "card-list" : "repeated-group",
        parent: rec.id,
        members,
        count: members.length,
        conf: Number(score.toFixed(2)),
        ev: [`parent:${rec.id}`, `matches:${best.key}`, `count:${members.length}`]
      });
    }
    const overview = {
      pageSummary: {
        regionCount: regions.length,
        groupCount: groups.length,
        hasHeader: regions.some((r) => /header|banner/.test(String(r.role || ""))),
        hasFooter: regions.some((r) => /footer|contentinfo/.test(String(r.role || ""))),
        hasSidebar: regions.some((r) => /aside|complementary|sidebar/.test(String(r.role || ""))),
        hasMainContent: regions.some((r) => /main/.test(String(r.role || "")))
      },
      regions: regions.slice(0, 8).map((r) => ({ id: r.id, role: r.role, kind: r.kind, conf: r.conf })),
      groups: groups.slice(0, 8).map((g) => ({ id: g.id, kind: g.kind, count: g.count, conf: g.conf, parent: g.parent }))
    };
    return { regions, groups, overview };
  }
  function inspect({
    epoch = 1,
    root = document.body,
    maxNodes = 1500,
    maxDepth = 60,
    maxMs = 250,
    sample = void 0,
    // undefined = default sampling, null = off
    fold = true
    // false = keep every wrapper (raw structure, for debugging)
  } = {}) {
    const t0 = performance.now();
    const registry = createRegistry(epoch);
    const styles = createStyleTable();
    const timers = { measure: 0, style: 0, semantics: 0 };
    const scroll = { x: window.scrollX, y: window.scrollY };
    const extraWarnings = [];
    const seen = /* @__PURE__ */ new Set();
    const warn = (code, node) => {
      const key = code + "|" + (node || "");
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
        warn("style-read-failed", rec.id);
        return;
      } finally {
        timers.measure += performance.now() - t;
      }
      if (rec.hiddenSubtree) {
        const size = rec.el.getElementsByTagName("*").length;
        if (size >= HIDDEN_SUBTREE_WARN_MIN) warn("large-hidden-subtree-skipped", rec.id);
      } else {
        t = performance.now();
        try {
          collectStyle(rec, cs, styles);
        } catch (_) {
          warn("style-read-failed", rec.id);
        }
        timers.style += performance.now() - t;
      }
      t = performance.now();
      annotate(rec, ctx);
      timers.semantics += performance.now() - t;
      const look = rec.st ? styles.table[rec.st] : null;
      rec.plain = Boolean(look) && rec.vis === "visible" && !rec.pos && !look.bgImg && !look.radius && ["", "transparent", "rgba(0, 0, 0, 0)"].includes(look.bg);
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
      inferred
    });
    const json = JSON.stringify(toPlannerView(blueprint));
    const bytes = new TextEncoder().encode(json).length;
    blueprint.diag.bytes = bytes;
    blueprint.diag.totalMs = Math.round((performance.now() - t0) * 10) / 10;
    return { blueprint, registry };
  }
  return __toCommonJS(inspect_exports);
})();
