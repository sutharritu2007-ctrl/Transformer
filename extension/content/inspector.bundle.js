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

  // src/inspector/inspect.js
  var inspect_exports = {};
  __export(inspect_exports, {
    inspect: () => inspect,
    toPlannerView: () => toPlannerView
  });

  // src/inspector/registry.js
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

  // src/inspector/safety.js
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

  // src/inspector/traversal.js
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
  function traverse(root, { registry, maxNodes = 1500, maxDepth = 60, onRecord = null } = {}) {
    if (!registry) throw new Error("traverse() needs a registry");
    const t0 = performance.now();
    const records = [];
    const warnings = [];
    const stats = {
      visited: 0,
      skipped: 0,
      kept: 0,
      maxDepthSeen: 0,
      // deepest kept record, relative to `root`
      elementsInRoot: 0,
      // how big the subtree really is (light DOM only)
      elapsedMs: 0
    };
    stats.elementsInRoot = root.getElementsByTagName("*").length;
    let nodeBudgetWarned = false;
    let depthBudgetWarned = false;
    const addRecord = (el, parent, depth, decision) => {
      const rec = {
        id: registry.assign(el),
        el,
        parent,
        depth,
        tag: el.localName,
        children: [],
        omitted: 0,
        protect: decision.protect,
        descend: decision.descend,
        shadow: null
      };
      records.push(rec);
      if (depth > stats.maxDepthSeen) stats.maxDepthSeen = depth;
      if (decision.protect === "frame") warnings.push({ code: "opaque-frame", node: rec.id });
      if (onRecord) onRecord(rec, parent >= 0 ? records[parent] : null);
      return rec;
    };
    const finish = () => {
      stats.kept = records.length;
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
      for (const child of children) {
        stats.visited++;
        const decision = classifyElement(child);
        if (decision.action === "skip") {
          stats.skipped++;
          continue;
        }
        if (registry.idOf(child) !== null) continue;
        if (records.length >= maxNodes) {
          rec.omitted++;
          if (!nodeBudgetWarned) {
            nodeBudgetWarned = true;
            warnings.push({ code: "budget-nodes" });
          }
          continue;
        }
        const childRec = addRecord(child, i, rec.depth + 1, decision);
        rec.children.push(childRec.id);
      }
    }
    return finish();
  }

  // src/inspector/geometry.js
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

  // src/inspector/style.js
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

  // src/inspector/semantics.js
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
      if (full) {
        if (full.length > NAME_CAP) ctx.warn("text-truncated");
        const name = cut(full, NAME_CAP);
        if (name !== rec.tx) rec.n = name;
      }
    }
  }

  // src/inspector/serialize.js
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
    return n;
  }
  var round12 = (n) => Math.round(n * 10) / 10;
  function serialize({ records, stats, warnings, styles, timers, config, meta }) {
    const nodes = {};
    for (const rec of records) nodes[rec.id] = serializeNode(rec);
    const timersMs = {};
    for (const [name, ms] of Object.entries(timers)) timersMs[name] = round12(ms);
    return {
      v: "0.1",
      meta,
      limits: {
        maxNodes: config.maxNodes,
        maxDepth: config.maxDepth,
        nodesVisited: stats.visited,
        nodesKept: stats.kept,
        totalElements: stats.elementsInRoot
      },
      warnings,
      root: records.length > 0 ? records[0].id : null,
      nodes,
      styles: styles.table,
      inferred: { regions: [], groups: [] },
      // filled by later phases
      diag: { stats, timersMs, styleCount: styles.size, bytes: 0, totalMs: 0 }
    };
  }
  function toPlannerView(blueprint) {
    const { diag, ...rest } = blueprint;
    return rest;
  }

  // src/inspector/inspect.js
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
  function inspect({ epoch = 1, root = document.body, maxNodes = 1500, maxDepth = 60 } = {}) {
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
    };
    const result = traverse(root, { registry, maxNodes, maxDepth, onRecord: enrich });
    const blueprint = serialize({
      records: result.records,
      stats: result.stats,
      warnings: [...result.warnings, ...extraWarnings],
      styles,
      timers,
      config: { maxNodes, maxDepth },
      meta: collectMeta(epoch)
    });
    const json = JSON.stringify(toPlannerView(blueprint));
    const bytes = new TextEncoder().encode(json).length;
    blueprint.diag.bytes = bytes;
    blueprint.diag.totalMs = Math.round((performance.now() - t0) * 10) / 10;
    return { blueprint, registry };
  }
  return __toCommonJS(inspect_exports);
})();