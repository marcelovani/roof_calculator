/**
 * Everything the browser remembers, in one entry.
 *
 * `data/cuts.json` and `data/sheets.json` are the defaults — what a new visitor
 * sees, and what Reset goes back to. Nothing is ever written to them: the store
 * is the record from the first edit onwards, and the way work leaves the
 * browser is Export.
 *
 * One key rather than several because the parts have to agree. A design's flags
 * belong to that design, and a run of separate keys is how you end up looking
 * at one roof with another one's flags on it.
 */
export const KEY = 'roof';
export const VERSION = 1;

/** Short, and unique enough for a list one person keeps by hand. */
export const newId = () =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(-10);

export function read() {
  let text;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const store = JSON.parse(text);
    return store && store.designs ? store : null;
  } catch {
    // Corrupt beyond use. Saying so and starting again beats a blank page.
    return null;
  }
}

export function write(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing was kept in the first place */
  }
}

/** A sheet as the app holds it: the file's fields, plus a name and a link. */
export const toSheet = (raw) => ({
  id: String(raw.id ?? newId()),
  label: String(raw.label ?? raw.id ?? ''),
  width: Number(raw.width) || 0,
  length: Number(raw.length) || 0,
  price: Number(raw.price) || 0,
  url: String(raw.url ?? ''),
});

/**
 * A design is a roof: its measurements and what has been marked on them.
 *
 * `cuts` is exactly the shape of the file, so a design can be exported and
 * pasted straight over `data/cuts.json`.
 */
export const toDesign = (name, cutsDoc) => ({
  name,
  note: cutsDoc.note || '',
  cuts: structuredClone(cutsDoc.cuts || {}),
  flags: [],
});

/** The shipped roof and the shipped catalogue, as a store nobody has touched. */
export function fromDefaults(cutsDoc, sheetsDoc, name = 'My roof') {
  const id = newId();
  return {
    version: VERSION,
    current: id,
    designs: { [id]: toDesign(name, cutsDoc) },
    sheets: (sheetsDoc.sheets || []).map(toSheet),
    settings: {
      tab: 'pieces',
      sidebarOff: false,
      hiddenSides: [],
      // null is every sheet, which is not the same as a list that happens to
      // hold them all: a size added later should be in the plan, not left out
      // because it was not around when the boxes were last ticked.
      sheetPicks: null,
      pastedPlan: '',
      pastedDraft: '',
    },
  };
}

/**
 * What the older version of this page left behind, brought across.
 *
 * It kept a key per thing — `roof.cuts:data/cuts.json`, `roof.flags:…`,
 * `roof.hiddenSides`, `roof.tab` — and a tablet that has been measuring all
 * week has its only copy of that work in them. They are read once, folded into
 * the store, and removed.
 */
export function migrate(cutsDoc, sheetsDoc, cutsPath = 'data/cuts.json') {
  const get = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const kept = get(`roof.cuts:${cutsPath}`);
  if (!kept) return null;

  let doc;
  try {
    doc = JSON.parse(kept);
  } catch {
    return null;
  }
  if (!doc || !doc.cuts) return null;

  const store = fromDefaults(doc, sheetsDoc, 'My roof');
  const design = store.designs[store.current];
  design.flags = (get(`roof.flags:${cutsPath}`) || '').split(',').filter(Boolean);
  store.settings.hiddenSides = (get('roof.hiddenSides') || '').split(',').filter(Boolean);
  store.settings.tab = get('roof.tab') || 'pieces';
  store.settings.sidebarOff = get('roof.sidebarOff') === '1';
  store.settings.pastedPlan = get('roof.pastedPlan') || '';
  store.settings.pastedDraft = get('roof.pastedDraft') || '';

  for (const key of [
    `roof.cuts:${cutsPath}`,
    `roof.flags:${cutsPath}`,
    'roof.hiddenSides',
    'roof.tab',
    'roof.sidebarOff',
    'roof.pastedPlan',
    'roof.pastedDraft',
  ]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* already gone */
    }
  }
  return store;
}

/** The design being worked on, whatever the store has been through. */
export function current(store) {
  return store.designs[store.current] || Object.values(store.designs)[0] || null;
}

/** The sheets the plan may use: every one, unless some have been ticked off. */
export function pickedSheets(store) {
  const picks = store.settings.sheetPicks;
  if (!Array.isArray(picks)) return store.sheets;
  return store.sheets.filter((s) => picks.includes(s.id));
}
