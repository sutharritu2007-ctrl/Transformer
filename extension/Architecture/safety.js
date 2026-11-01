// src/inspector/safety.js
//
// The privacy gate. Every decision of the form "may we look inside this
// element?" lives in this one file, so a new rule added here protects every
// later stage (geometry, text, styles...) automatically.
//
// Rule of thumb: when unsure, withhold.

// Never recorded at all.
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template',
  'link', 'meta', 'base', 'title', 'head',
]);

// Recorded as nodes, but their insides are never walked.
const OPAQUE_TAGS = new Set([
  'svg', 'canvas', 'video', 'audio', 'object', 'embed',
  'select', 'datalist', 'math',
]);

const FORM_CONTROLS = new Set(['input', 'textarea', 'select']);

// autocomplete tokens that mark credentials, payment data, or one-time codes.
const SENSITIVE_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/;

function hasSensitiveAutocomplete(el) {
  const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  return tokens.some((token) => SENSITIVE_AUTOCOMPLETE.test(token));
}

const skip = () => ({ action: 'skip', descend: false, protect: null });
const keep = (descend, protect) => ({ action: 'keep', descend, protect });

/**
 * Decide what the inspector may do with one element.
 *
 * Returns:
 *   action:  'skip' (do not record) or 'keep' (record it)
 *   descend: may the traversal walk into its children?
 *   protect: null, or why content is withheld:
 *            'frame' | 'editable' | 'sensitive'
 *            ('closed-shadow' is handled in traversal, where shadow roots are read)
 */
export function classifyElement(el) {
  const tag = el.localName; // lowercase for HTML elements

  if (SKIP_TAGS.has(tag)) return skip();

  // Hidden inputs usually carry tokens and tracking data. Never collected.
  if (tag === 'input' && el.type === 'hidden') return skip();

  // Cross-origin content can't be read anyway; same-origin is deferred.
  if (tag === 'iframe' || tag === 'frame') return keep(false, 'frame');

  // Anything the user can type into freely. We stop at the editable root.
  if (el.isContentEditable) return keep(false, 'editable');

  if (FORM_CONTROLS.has(tag) && (el.type === 'password' || hasSensitiveAutocomplete(el))) {
    return keep(false, 'sensitive');
  }

  if (OPAQUE_TAGS.has(tag)) return keep(false, null);

  return keep(true, null);
}
