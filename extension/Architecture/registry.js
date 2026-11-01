// src/inspector/registry.js
//
// The reference registry: hands out temporary IDs ("e1", "e2", ...) and is the
// ONLY place that holds real DOM nodes on behalf of the blueprint.
//
// - Nothing is written to the page (no data-* attributes).
// - Elements are held weakly, so the registry never keeps a removed page
//   element alive.
// - IDs are only valid inside one epoch (one inspection run).

export function createRegistry(epoch) {
  let counter = 0;
  const idByElement = new WeakMap(); // element -> id
  const refById = new Map();         // id -> WeakRef(element)

  return {
    epoch,

    /** Give an element an ID (or return the one it already has). */
    assign(el) {
      const existing = idByElement.get(el);
      if (existing) return existing;
      const id = 'e' + ++counter;
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
    },
  };
}
