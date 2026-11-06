// src/inspector/semantics.js
//
// Semantics and text for ONE record. Everything here is observed or
// spec-derived (table lookups). Nothing is guessed: guessing belongs to the
// inferred block (regions, groups).
//
// Adds to the record (all optional, sparse):
//   role  effective ARIA role (author-set, else implicit from the tag)
//   lv    heading level
//   ik    interactive kind (native controls, plus a few ARIA roles)
//   dis   true if disabled          req  true if required
//   lk    link kind: internal | external | anchor | mail | tel | other
//   n     short accessible-name approximation (only when it adds information)
//   tx/tl own direct text snippet / its full length
//
// Protected records (frame, editable, sensitive) get NO name and NO text.
// Input VALUES are never read anywhere in this file.

export const TEXT_CAP_STRONG = 120; // headings and interactive elements
export const TEXT_CAP_DEFAULT = 40; // everything else
export const NAME_CAP = 80;

const IMPLICIT_ROLE = {
  nav: 'navigation', main: 'main', aside: 'complementary', article: 'article',
  ul: 'list', ol: 'list', li: 'listitem', img: 'img', form: 'form', table: 'table',
  button: 'button', textarea: 'textbox', dialog: 'dialog',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
};

// Roles whose name comes from attributes, never from their content.
const NAMED_ROLES = new Set([
  'navigation', 'main', 'complementary', 'banner', 'contentinfo',
  'region', 'form', 'dialog', 'search',
]);

// Interactive kinds whose name may come from their visible content.
const NAME_FROM_CONTENT = new Set(['link', 'button', 'submit', 'summary']);

const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function looksLikeMetadata(value) {
  const s = clean(value);
  if (!s || s.length < 8) return false;

  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    const hasQuotedKey = /["']\s*\w+\s*["']\s*:/.test(s);
    const hasComma = s.includes(',');
    if (hasQuotedKey && hasComma) return true;
  }

  if (/(?:^|[,{\s])(?:color|size|variant|sku|product|item|mainColorId|colorId|sizeId|styleId|option|selected|select)["'\s:]/i.test(s)) {
    const hasJsonLikeColon = s.includes(':') && s.includes(',');
    const hasNumberishPair = /\b\w+Id\b\s*:/i.test(s) || /\b\w+\s*:\s*(?:\d+|true|false|null|["'])/i.test(s);
    if (hasJsonLikeColon || hasNumberishPair) return true;
  }

  return false;
}

function sanitizeName(value) {
  const s = clean(value);
  if (!s) return '';
  if (looksLikeMetadata(s)) return '';
  return s;
}

// Cut to a cap without leaving half of an emoji (a lone surrogate) at the end.
function cut(text, cap) {
  if (text.length <= cap) return text;
  return text.slice(0, cap).replace(/[\uD800-\uDBFF]$/, '');
}

// ---------------------------------------------------------------- role --

function effectiveRole(el, tag) {
  const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
  if (/^[a-z-]{2,30}$/.test(explicit)) return explicit;

  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;

  // header/footer only mean page-level banner/contentinfo outside sectioning content.
  if (tag === 'header' || tag === 'footer') {
    if (el.closest('article, aside, main, nav, section')) return null;
    return tag === 'header' ? 'banner' : 'contentinfo';
  }
  return IMPLICIT_ROLE[tag] ?? null;
}

function headingLevel(el, tag, role) {
  const m = /^h([1-6])$/.exec(tag);
  if (m) return Number(m[1]);
  if (role === 'heading') {
    const level = parseInt(el.getAttribute('aria-level'), 10);
    if (level >= 1 && level <= 9) return level;
  }
  return null;
}

// --------------------------------------------------- interactive kind --

function interactiveKind(el, tag, role) {
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'summary') return 'summary';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';

  if (tag === 'button') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'submit' || (type === '' && el.form) ? 'submit' : 'button';
  }

  if (tag === 'input') {
    switch (el.type) {
      case 'password': return 'password';
      case 'email': return 'email';
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'file': return 'file';
      case 'submit': return 'submit';
      case 'button': case 'reset': case 'image': return 'button';
      case 'range': case 'color': return 'other';
      default: return 'text'; // text, search, tel, url, number, date, ...
    }
  }

  // A few ARIA roles on non-native elements.
  if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio') return role;
  return null;
}

function isDisabled(el) {
  try {
    return el.matches(':disabled');
  } catch (_) {
    return false;
  }
}

// ----------------------------------------------------------- link kind --

function linkKind(el) {
  const attr = (el.getAttribute('href') || '').trim();
  if (attr.startsWith('#')) return 'anchor';
  let url;
  try {
    url = new URL(attr, document.baseURI);
  } catch (_) {
    return 'other';
  }
  switch (url.protocol) {
    case 'mailto:': return 'mail';
    case 'tel:': return 'tel';
    case 'http:':
    case 'https:': return url.origin === location.origin ? 'internal' : 'external';
    default: return 'other'; // javascript:, data:, blob:, ...
  }
}

// ---------------------------------------------------------------- text --

// Own DIRECT text only (not descendants), so a paragraph is never repeated
// at every ancestor. textarea children are its default value: never read.
function ownText(el) {
  let s = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) s += node.nodeValue;
  }
  return clean(s);
}

// Visible text of a subtree, stopping early once `cap` characters are found,
// so a huge link or label never gets fully concatenated.
// (Known gap: it does not skip protected descendants; rare inside links/labels.)
function collectText(el, cap) {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let out = '';
  for (let node = walker.nextNode(); node && out.length < cap; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && SKIP_TEXT_TAGS.has(parent.localName)) continue;
    out += ' ' + node.nodeValue;
  }
  return clean(out);
}

// ---------------------------------------------------------------- name --

// An approximation of the accessible name (Chrome gives extensions no API for
// the real one). Order follows the accessible-name spec's main steps.
function accessibleName(el, tag, ik, role) {
  const root = el.getRootNode(); // Document or ShadowRoot, both have getElementById

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby && typeof root.getElementById === 'function') {
    const parts = labelledby.split(/\s+/)
      .map((id) => root.getElementById(id))
      .filter(Boolean)
      .map((node) => collectText(node, NAME_CAP));
    const joined = clean(parts.join(' '));
    if (joined) return joined;
  }

  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;

  if (el.labels && el.labels.length > 0) {
    const fromLabels = clean(Array.from(el.labels, (l) => collectText(l, NAME_CAP)).join(' '));
    if (fromLabels) return fromLabels;
  }

  if (tag === 'img' || tag === 'area' || (tag === 'input' && el.type === 'image')) {
    const alt = clean(el.getAttribute('alt'));
    if (alt) return alt;
  }

  // For button-type inputs, the value attribute IS the visible label.
  if (tag === 'input' && (el.type === 'submit' || el.type === 'button' || el.type === 'reset')) {
    const label = clean(el.getAttribute('value'));
    if (label) return label;
  }

  const title = clean(el.getAttribute('title'));
  if (title) return title;

  if (NAME_FROM_CONTENT.has(ik) || role === 'button' || role === 'link') {
    const content = collectText(el, NAME_CAP);
    if (content) return content;
    // Logo links: no text, but an image with alt text inside.
    const img = el.querySelector('img[alt]');
    if (img) return clean(img.getAttribute('alt'));
  }
  return '';
}

// ---------------------------------------------------------------- main --

/**
 * @param {object} rec
 * @param {{ warn: function }} ctx   warn(code, nodeId?) records a warning
 */
export function annotate(rec, ctx) {
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

  // Protected content is withheld: no link info, no name, no text.
  if (rec.protect) return;

  if (tag === 'a' && ik === 'link') rec.lk = linkKind(el);

  // Own text first, so a name that only repeats it can be dropped.
  const text = tag === 'textarea' ? '' : ownText(el);
  if (text) {
    const cap = ik || role === 'heading' ? TEXT_CAP_STRONG : TEXT_CAP_DEFAULT;
    if (text.length > cap) ctx.warn('text-truncated');
    rec.tl = text.length;
    rec.tx = cut(text, cap);
  }

  if (ik || tag === 'img' || NAMED_ROLES.has(role)) {
    const full = accessibleName(el, tag, ik, role);
    const safe = sanitizeName(full);
    if (safe) {
      if (safe.length > NAME_CAP) ctx.warn('text-truncated');
      const name = cut(safe, NAME_CAP);
      if (name !== rec.tx) rec.n = name; // only record names that add information
    }
  }
}