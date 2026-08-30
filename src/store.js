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
export const VERSION = 2;

/** Short, and unique enough for a list one person keeps by hand. */
export const newId = () =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(-10);

/**
 * Sides used to be listed anticlockwise from the bottom-right corner, so the
 * numbers ran round the drawing the opposite way from the way they are walked
 * now — clockwise from the bottom-left. The lengths are the same lengths; only
 * their order changed, and sides 1 and 3 swap places to turn one into the other
 * (sides 1 and 2 on a triangle, where the base is the third).
 *
 * Anything already in the browser was typed in the old order, so it is turned
 * round once, on the way in.
 */
const clockwiseFromLeft = (edges) => {
  const e = [...edges];
  if (e.length === 4) return [e[2], e[1], e[0], e[3]];
  if (e.length === 3) return [e[1], e[0], e[2]];
  return e;
};

/** A store written before the sides were renumbered, brought up to date. */
export function upgrade(store) {
  if (!store || Number(store.version) >= 2) return store;
  for (const design of Object.values(store.designs || {})) {
    for (const cut of Object.values(design.cuts || {})) {
      if (Array.isArray(cut.edges)) cut.edges = clockwiseFromLeft(cut.edges);
    }
  }
  store.version = VERSION;
  return store;
}

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
    return store && store.designs ? upgrade(store) : null;
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
      // How much wider than the sheet a run of pieces may come out, in cm. It
      // is kept here rather than with the catalogue because it is a property of
      // the job — how straight you can cut — not of what the shop sells. The
      // file's number is only where a browser that has never been here starts.
      allowance: Number(sheetsDoc.allowance) || 0,
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

  // The old per-key store predates the renumbering, so its edges are turned
  // round too. `fromDefaults` has already stamped the current version on it.
  const store = fromDefaults(doc, sheetsDoc, 'My roof');
  for (const cut of Object.values(store.designs[store.current].cuts)) {
    if (Array.isArray(cut.edges)) cut.edges = clockwiseFromLeft(cut.edges);
  }
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
