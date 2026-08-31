import { OPS, area, buildRelaxed, compose, fitPolygon, isPlain, orient } from './geometry.js';
import { plan } from './nest.js';
import { createSearch, shrinkPieces } from './nest-blf.js';
import { fillPrompt, pieceList, planJson, promptTemplate, readPlan, sheetList } from './aiplan.js';
import * as store from './store.js';
import { EDGE_NAMES, renderCutPlan, renderOrder, renderPieceEditor, renderPiecePreview, renderPieces, renderDesigns, renderRoof, renderSheetPicker, renderSheets, sqm } from './render.js';

const $ = (sel) => document.querySelector(sel);

/** Attribute-safe, unlike escapeHtml below, which only guards text. */
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SIDE_ORDER = ['west', 'south', 'east', 'north'];

const state = { store: null, defaults: null, data: null, sheet: null, design: null, showFitted: false, hiddenSides: new Set(), flags: new Set(), stepTimer: null, pieces: [], pasted: '', draft: '', editing: null,
  // The slow nester's plan, and the measurements it was made from. Kept apart
  // from the fast one so a keystroke never waits on a search.
  // Every search run on the current measurements, everything they found, and
  // which of it is on the screen. Kept apart from the fast plan so a keystroke
  // never waits on a search.
  opt: { sig: '', searches: [], active: null, chosen: null, plan: null, pinned: false, timer: null, reduce: 0 } };

/**
 * Everything remembered goes through here, so there is one moment where the
 * browser is written to and one place to look when it has not been.
 */
function keep() {
  if (store.write(state.store)) return true;
  status('this browser will not keep anything — copy your work out with Export before you reload');
  return false;
}

/** A setting changed and saved, which is most of what the buttons do. */
function setSetting(name, value) {
  state.store.settings[name] = value;
  keep();
}

function toPieces(data) {
  const problems = new Map();
  const pieces = Object.entries(data.cuts || {})
    .map(([id, cut]) => {
      const result = buildRelaxed(cut.edges);
      // How the piece lies is applied to the shape, not to the lengths, so
      // everything downstream — the roof, the nester, the cut plan and the
      // order — is working from the piece as it will actually be laid.
      const how = { turn: Number(cut.turn) || 0, mirror: !!cut.mirror };
      const lay = (vertices) => (vertices && !isPlain(how) ? orient(vertices, how).vertices : vertices);
      const piece = {
        id,
        side: cut.side || 'unassigned',
        edges: cut.edges,
        ...how,
        vertices: lay(result.vertices) || null,
        model: result.model,
        fitted: null,
      };
      if (result.vertices || result.empty) return piece;

      // Nothing closes, so draw the nearest edges that do and keep the measured
      // ones on the labels — the piece is still worth seeing in proportion.
      const fit = fitPolygon(cut.edges);
      problems.set(id, result.error);
      if (fit) Object.assign(piece, { vertices: lay(fit.vertices), fitted: fit.edges, model: 'fitted' });
      return piece;
    })
    .sort((a, b) => {
      const s = SIDE_ORDER.indexOf(a.side) - SIDE_ORDER.indexOf(b.side);
      return s !== 0 ? s : Number(a.id) - Number(b.id);
    });
  return { pieces, problems };
}

/** "top 85 → 138.1" for every edge the fit had to move. */
function changes(piece) {
  const names = EDGE_NAMES[piece.edges.length] || [];
  return piece.edges
    .map((e, i) => [names[i] || `edge ${i + 1}`, Number(e), piece.fitted[i]])
    .filter(([, was, now]) => Math.abs(was - now) > 0.05)
    .map(([name, was, now]) => `${name} ${was} &rarr; ${now}`)
    .join(', ');
}

function renderSummary(pieces, result, problems, units) {
  const drawable = pieces.filter((p) => p.vertices);
  const bySide = SIDE_ORDER.map((side) => {
    const group = drawable.filter((p) => p.side === side);
    const total = group.reduce((s, p) => s + area(p.vertices), 0);
    return group.length
      ? `<li><span>${side}</span><b>${sqm(total, units)} m&sup2;</b><span class="muted">${group.length} pcs</span></li>`
      : `<li class="muted"><span>${side}</span><b>&mdash;</b><span></span></li>`;
  }).join('');
  const total = drawable.reduce((s, p) => s + area(p.vertices), 0);

  $('#summary').innerHTML = `<ul class="totals">${bySide}
    <li class="grand"><span>total glazed</span><b>${sqm(total, units)} m&sup2;</b>
      <span class="muted">${drawable.length}/${pieces.length} measured</span></li></ul>`;

  const oversize = (result.leftovers || []).flatMap((b) => b.placements.map((p) => p.piece.id));
  const fitted = pieces.filter((p) => p.fitted);
  const hips = pieces.filter((p) => p.model === 'hip');
  const lines = [
    ...fitted.map(
      (p) => `<li><b>Piece ${p.id}</b> ${problems.get(p.id)} Drawn to the nearest that does: ${changes(p)}.</li>`
    ),
    ...[...problems.keys()]
      .filter((id) => !fitted.some((p) => p.id === id))
      .map((id) => `<li><b>Piece ${id}</b> ${problems.get(id)}</li>`),
    ...(oversize.length
      ? [`<li><b>Too big for any sheet</b> pieces ${oversize.join(', ')} — add a larger sheet size or split them.</li>`]
      : []),
  ];

  $('#warnings').innerHTML = [
    lines.length ? `<h2>Problems</h2><ul class="warnings">${lines.join('')}</ul>` : '',
    hips.length
      ? `<h2>Hip cuts</h2><p class="hint">${hips.length} pieces do not close with the top parallel to the
         bottom, so they are drawn square to the base instead, sides parallel and the top on the slant —
         which is how a piece cut against a hip sits. Every measured length is used as it stands.
         Pieces ${hips.map((p) => p.id).join(', ')}.</p>`
      : '',
    fitted.length
      ? `<button id="togglefit">${state.showFitted ? 'Show measured sizes' : 'Show fitted sizes'}</button>
         <details><summary class="hint">Fitted <code>cuts.json</code></summary><pre id="fittedjson">${fittedJson(pieces)}</pre>
         <button id="copyfit">Copy</button></details>`
      : '',
  ].join('');

  $('#togglefit')?.addEventListener('click', () => {
    state.showFitted = !state.showFitted;
    draw();
  });
  $('#copyfit')?.addEventListener('click', async (event) => {
    await navigator.clipboard.writeText($('#fittedjson').textContent);
    event.target.textContent = 'Copied';
  });
}

/** The file as it would be written: one piece to a line, in numeric order. */
function serialise(cuts) {
  const rows = Object.entries(cuts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, cut]) => {
      // Only said when there is something to say, so a roof nobody has turned a
      // piece on reads exactly as it always did.
      const turn = Number(cut.turn) || 0;
      const lie = `${turn ? `, "turn": ${turn}` : ''}${cut.mirror ? ', "mirror": true' : ''}`;
      return `    "${id}": { "side": "${cut.side || 'unassigned'}", "edges": [${cut.edges.map(Number).join(', ')}]${lie} }`;
    });
  return `{\n  "note": ${JSON.stringify(state.data.note || '')},\n  "cuts": {\n${rows.join(',\n')}\n  }\n}\n`;
}

/** The whole file again with the fitted pieces swapped in, ready to paste back. */
function fittedJson(pieces) {
  const cuts = {};
  for (const p of pieces) cuts[p.id] = { side: p.side, edges: p.fitted || p.edges, turn: p.turn, mirror: p.mirror };
  return serialise(cuts);
}

/**
 * The design being worked on, and the measurements in it.
 *
 * `state.data` is the shape the drawing code has always been handed — units and
 * kerf from the catalogue, `cuts` from the design — so nothing downstream had
 * to learn about designs.
 */
function useStore() {
  const design = store.current(state.store);
  const { sheets, settings } = state.store;
  state.data = {
    ...state.defaults.sheets,
    // The tolerance is typed on the cut plan and kept with the settings; a
    // store written before that box existed falls back to the file's number.
    allowance: Number(settings.allowance ?? state.defaults.sheets.allowance) || 0,
    sheets: store.pickedSheets(state.store),
    note: design.note,
    cuts: design.cuts,
  };
  state.flags = new Set(design.flags);
  state.hiddenSides = new Set((settings.hiddenSides || []).filter((side) => SIDE_ORDER.includes(side)));
  state.pasted = settings.pastedPlan || '';
  state.draft = settings.pastedDraft ?? state.pasted;
  return design;
}

/** The measurements as they now stand, into the browser. Nothing else writes. */
function saveCuts() {
  if (!keep()) return false;
  status(`saved at ${new Date().toLocaleTimeString('en-GB')} — in this browser, so use Export to move it`);
  return true;
}

/**
 * The border, from the number in the box as it stands: green while the four
 * lengths close into a piece, red once they do not. Nothing is saved and
 * nothing is redrawn, so this can run on every keystroke and every click of
 * the arrows without the box moving under the cursor.
 */
function markClosure(input) {
  const cut = state.data.cuts[input.dataset.piece];
  const figure = input.closest('.piece-card')?.querySelector('.piece');
  if (!cut || !figure) return;

  const edges = cut.edges.map(Number);
  edges[Number(input.dataset.edge)] = Number(input.value);
  const result = Number.isFinite(Number(input.value)) ? buildRelaxed(edges) : {};

  figure.classList.toggle('closes', !!result.vertices);
  figure.classList.toggle('fitted', !result.vertices && !result.empty);
}

/**
 * A tap on + or &minus;: one centimetre, straight into the box.
 *
 * The saving and the redraw are held back a moment, because a redraw replaces
 * the boxes and the button under the finger with them — tap twice quickly and
 * the second tap would land on nothing.
 */
function onStep(event) {
  const button = event.target.closest?.('.step');
  if (!button) return;
  const input = button.closest('.edge')?.querySelector('input');
  if (!input) return;
  const next = Math.max(0, (Number(input.value) || 0) + Number(button.dataset.delta));
  input.value = String(Math.round(next * 100) / 100);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  clearTimeout(state.stepTimer);
  state.stepTimer = setTimeout(() => input.dispatchEvent(new Event('change', { bubbles: true })), 500);
}

/** A typed measurement: into the data, into the file, back onto the drawing. */
async function onEdgeChange(event) {
  const input = event.target;
  if (!input.classList?.contains('edge-input')) return;
  const cut = state.data.cuts[input.dataset.piece];
  const index = Number(input.dataset.edge);
  const value = Number(input.value);
  if (!cut || !Number.isFinite(value) || value < 0) {
    status(`${input.value} is not a length — piece ${input.dataset.piece} left as it was`);
    return;
  }

  cut.edges = cut.edges.map(Number);
  cut.edges[index] = value;
  saveCuts();

  // Redrawing replaces the boxes, so put the cursor back where the keyboard
  // left it — usually the next box along, after a tab.
  const active = document.activeElement?.classList?.contains('edge-input') ? { ...document.activeElement.dataset } : null;
  draw();
  if (active) {
    const back = document.querySelector(`.edge-input[data-piece="${active.piece}"][data-edge="${active.edge}"]`);
    back?.focus();
    back?.select?.();
  }
}

/**
 * Clicking a piece on the roof opens it on its own, big enough to read.
 *
 * The lengths are edited on a copy, so nothing reaches the file until OK is
 * pressed and Close can simply drop them. Only the drawing is redrawn as you
 * type — replacing the boxes would take the caret with them.
 */
function openEditor(id) {
  const cut = state.data?.cuts?.[id];
  if (!cut) return;
  state.editing = { id, edges: cut.edges.map(Number), turn: Number(cut.turn) || 0, mirror: !!cut.mirror };
  drawEditor();
  $('#editor').showModal();
  // Close takes the focus, not the first measurement: on a tablet, focusing a
  // box throws the keyboard up over the drawing you opened the piece to see.
  $('#editor-close').focus();
}

/** The piece as the copy has it — redrawn on a turn, and on every keystroke. */
function drawEditor() {
  const edit = state.editing;
  const cut = state.data.cuts[edit.id];
  $('#editor-body').innerHTML = renderPieceEditor(
    { id: edit.id, side: cut.side || 'unassigned' },
    edit.edges,
    state.data.units,
    { turn: edit.turn, mirror: edit.mirror }
  );
}

function onEditorInput(event) {
  if (!event.target.classList?.contains('editor-edge') || !state.editing) return;
  const value = Number(event.target.value);
  // A box mid-edit can be empty or a lone minus sign; keep the last good length
  // for that edge rather than redrawing from a number that is not one yet.
  if (Number.isFinite(value) && value >= 0) state.editing.edges[Number(event.target.dataset.edge)] = value;
  const cut = state.data.cuts[state.editing.id];
  $('#editor-preview').innerHTML = renderPiecePreview(state.editing.edges, cut.side, state.data.units, {
    turn: state.editing.turn,
    mirror: state.editing.mirror,
  });
}

async function onEditorClose() {
  const edit = state.editing;
  state.editing = null;
  if (!edit || $('#editor').returnValue !== 'ok') return;
  Object.assign(state.data.cuts[edit.id], { edges: edit.edges, turn: edit.turn, mirror: edit.mirror });
  saveCuts();
  draw();
}

/**
 * The order list, under whichever plan it belongs to.
 *
 * There is no Order tab: a cut plan and the sheets it asks you to buy are one
 * sheet of paper, and the plan a model came back with has its own bill that is
 * not the nester's.
 */
function materials(result, data) {
  if (!result.sheets.length) return '';
  return `<section class="materials"><h2>Materials</h2>${renderOrder(result, data.units)}</section>`;
}

/**
 * What a plan was made from, so an edit retires it.
 *
 * The sheets are in it as well as the pieces: untick a size, or change a price,
 * and a finished search is a plan built out of sheets you no longer want. So is
 * the tolerance — it is how wide a sheet is allowed to be packed, so every plan
 * found under the old one was packed to a sheet of another width.
 */
const signature = (pieces, sheets, allowance) =>
  `${pieces.map((p) => `${p.id}:${p.edges.join(',')}`).join('|')}#${sheets
    .map((s) => `${s.id}:${s.width}x${s.length}:${s.price}`)
    .join(',')}@${allowance}`;

function draw() {
  // Everything drawn is derived from the store, every time. Anything less and a
  // ticked box changes what is stored without changing what is on the screen.
  useStore();
  const data = state.data;
  const { pieces, problems } = toPieces(data);
  const nestable = pieces.filter((p) => p.vertices);
  const sig = signature(nestable, data.sheets, data.allowance);
  if (sig !== state.opt.sig) resetSearches(sig);
  // The trial slack is part of the plan on the screen, not only of a search:
  // the box that asks for it is the answer to "nothing ticked fits these
  // pieces", and an answer that changed nothing below it would be no answer.
  const cut = shrinkPieces(nestable, state.opt.reduce);
  const fast = plan(cut, data);
  const result = state.opt.plan || fast;

  $('#pieces').innerHTML = renderPieces(pieces, problems, data.units, state.showFitted);
  $('#roof').innerHTML = renderRoof(pieces, data.units, state.hiddenSides, state.flags);
  drawAsk(pieces, result);
  $('#cutplan').innerHTML = planControls(fast, result) + renderCutPlan(result, data) + materials(result, data);
  $('#sheets').innerHTML = renderSheets(state.store.sheets, data.units);
  $('#designs').innerHTML = renderDesigns(state.store.designs, state.store.current, data.units);
  renderSummary(pieces, result, problems, data.units);
  wireOptimise(nestable, fast);
}

/**
 * Forget every search and everything it found; the roof is not the same roof.
 *
 * Emptied in place rather than replaced. A running search holds this object in
 * its loop and stops when `active` is no longer its own search — hand it a new
 * object and the old loop never sees the change, and grinds on against a roof
 * that no longer exists.
 */
function resetSearches(sig) {
  if (state.opt.timer) clearTimeout(state.opt.timer);
  Object.assign(state.opt, { sig, searches: [], active: null, chosen: null, plan: null, pinned: false, timer: null });
}

const TRIAL = (by) => `&minus;${fmt1(by)} cm`;
const fmt1 = (n) => String(Math.round(n * 10) / 10);

const SHOWN = 10;
const TRIAL_SHARE = 5;

/**
 * Every plan any search has found, cheapest first, tagged with which search.
 *
 * A trial plan is cheaper than anything you can actually order — it is a
 * smaller roof — so left to sort on price alone the trials take every row and
 * the plans you could buy today disappear. They get half the list at most.
 */
function offers() {
  const all = state.opt.searches.flatMap((s, i) =>
    s.search.plans().map((p) => ({ ...p, search: i, shrink: s.shrink, id: `${i}#${p.key}` }))
  );
  const cheapest = (rows, n) => rows.sort((a, b) => a.cost - b.cost || a.sheets - b.sheets).slice(0, n);
  const trials = cheapest(all.filter((r) => r.shrink), TRIAL_SHARE);
  const measured = cheapest(all.filter((r) => !r.shrink), SHOWN - trials.length);
  return cheapest([...measured, ...trials], SHOWN);
}

/**
 * The buttons, what the running search has got to, and the ten on offer.
 *
 * The fast plan is always there the moment a measurement changes; a search only
 * ever adds cheaper things to choose between, and says by how much.
 */
/** The ids the plan may use, as a set — every sheet when nothing is ticked off. */
function pickedIds() {
  const picks = state.store.settings.sheetPicks;
  return new Set(Array.isArray(picks) ? picks : state.store.sheets.map((s) => s.id));
}

/**
 * A size ticked or unticked. Never all of them off: a plan needs something to
 * cut from, and an empty catalogue is an error message rather than an answer.
 */
function setPicks(ids) {
  if (!ids.size) {
    status('the plan needs at least one size to cut from');
    draw();
    return;
  }
  // Every size ticked is stored as "all", so a size added tomorrow is in the
  // plan rather than left out for not having been around today.
  setSetting('sheetPicks', ids.size === state.store.sheets.length ? null : [...ids]);
  draw();
}

/**
 * The controls above the plan, and the one thing that can make the plan a lie.
 *
 * A piece that fits no ticked size is not cut at all — the nester sets it aside
 * and prices what is left. That is a smaller number than the roof costs, and
 * without saying so it reads as a saving. So it is said here, next to the
 * price, rather than only in the sidebar.
 */
function planControls(fast, result = fast) {
  const picker = renderSheetPicker(state.store.sheets, pickedIds(), state.data.units);
  const unplaced = (result.leftovers || []).flatMap((b) => b.placements.map((p) => p.piece.id));
  const nowhere = unplaced.length
    ? `<p class="hint bad"><b>${unplaced.length} ${unplaced.length === 1 ? 'piece is' : 'pieces are'} not in this plan</b> —
       nothing ticked is big enough for ${unplaced.length === 1 ? 'it' : 'them'}. The price below is for the
       ${(result.sheets || []).length ? 'rest' : 'others'} only, so it is not what the roof costs.
       Pieces ${unplaced.join(', ')}.</p>`
    : '';
  const { active, chosen, reduce } = state.opt;
  // Only worth a box when something does not fit — or when it already holds a
  // number, which is the only way back to nought.
  const reducer = unplaced.length || reduce
    ? `<label class="reduce">every piece
        <input id="reduce" type="number" step="0.5" min="0" value="${esc(reduce)}"${active ? ' disabled' : ''}> cm smaller</label>`
    : '';
  // The tolerance decides what fits across a sheet, so it belongs next to the
  // button that spends a minute working out what fits — not in a file you have
  // to edit and reload to try another number against. Always shown: nought is
  // as much a choice as one, and this is the only way back to it.
  const slack = `<label class="tolerance" title="A run of pieces measured off a roof adds up to a little more than the roof is. This is how much of that the plan may take across the sheet — along it the same slack would cost a whole sheet, so it is not given there.">tolerance
      <input id="allowance" type="number" step="0.1" min="0" value="${esc(fmt1(state.data.allowance))}"${active ? ' disabled' : ''}> cm across the sheet</label>`;
  if (!fast.sheets.length) return `${picker}${nowhere}<div class="plan-controls">${slack}${reducer}</div>`;
  const rows = offers();
  const status = active
    ? `<span class="muted">search ${state.opt.searches.length} &middot; round ${active.round} &middot;
       ${active.sheets} sheets &middot; &pound;${active.cost.toFixed(2)}</span>`
    : rows.length
      ? `<span class="muted">${rows.length} plans found. The quick nester's is ${fast.sheets.length} sheets,
         &pound;${fast.cost.toFixed(2)}.</span>`
      : `<span class="muted">${fast.sheets.length} sheets, &pound;${fast.cost.toFixed(2)} from the quick nester.
         A search takes a minute or so and only ever improves on it.</span>`;

  const list = rows.length
    ? `<table class="offers"><tbody>${rows
        .map((r) => {
          const saved = fast.cost - r.cost;
          return `<tr class="${chosen === r.id ? 'chosen' : ''}${r.shrink ? ' trial' : ''}" data-plan="${esc(r.id)}" tabindex="0" role="button">
            <td class="num">${r.sheets}</td>
            <td class="num">&pound;${r.cost.toFixed(2)}</td>
            <td class="num">${saved > 0.005 ? `&minus;&pound;${saved.toFixed(2)}` : '&mdash;'}</td>
            <td>${r.shrink ? `<span class="tag">${TRIAL(r.shrink)}</span>` : ''}</td>
            <td class="mix">${esc(r.mix)}</td>
            <td><button class="exportrow" data-plan="${esc(r.id)}"
              title="Draw this one, and take it to the AI tab">Export to AI</button></td></tr>`;
        })
        .join('')}</tbody></table>`
    : '';

  // A shrunk plan is a smaller roof whichever nester made it, so the warning
  // follows the slack rather than the search that used it.
  const shrunkBy = state.opt.plan ? rows.find((r) => r.id === chosen)?.shrink || 0 : reduce;
  const trialWarning = shrunkBy
    ? `<p class="hint bad">This plan is drawn from pieces ${fmt1(shrunkBy)} cm
       narrower and ${fmt1(shrunkBy)} cm shorter than you measured, so its
       price is not one you can order. It is here to say what that much slack would be worth.</p>`
    : '';

  // One button, three jobs: start, stop, start again. Starting again adds to the
  // list rather than replacing it, which is what "more" is saying.
  return `${picker}${nowhere}<div class="plan-controls">
    ${slack}
    ${reducer}
    <button id="optimise">${active ? 'Stop' : rows.length ? 'Optimise more' : 'Optimise'}</button>
    ${state.opt.plan ? '<button id="dropoptimise">Back to the quick plan</button>' : ''}
    ${rows.length ? '<button id="clearsearches">Clear results</button>' : ''}
    ${status}
  </div>${list}${trialWarning}`;
}

/**
 * The search a few rounds at a time, letting the page paint between them.
 *
 * A round is the better part of a tenth of a second, so running the lot in one
 * go would lock the page for a minute. Every round is a complete plan, so
 * stopping at any point leaves something usable on the screen — and everything
 * it has tried along the way is already in the list.
 */
function wireOptimise(nestable, fast) {
  const ROUNDS = 500;
  const opt = state.opt;

  // Redrawn rather than stored and forgotten: the plan below is nested from the
  // shrunk pieces, so the number has to take effect where it is typed. The
  // redraw replaces the box, so the caret is put back where it was.
  $('#reduce')?.addEventListener('change', (event) => {
    const next = Math.max(0, Number(event.target.value) || 0);
    if (next === opt.reduce) return;
    opt.reduce = next;
    draw();
    $('#reduce')?.focus();
  });

  // Kept the moment it changes, and redrawn with it: the tolerance is what both
  // nesters pack to, so the plan under the box has to be the plan for the number
  // in the box. Every search packed to the old number retires with it.
  $('#allowance')?.addEventListener('change', (event) => {
    const next = Math.max(0, Number(event.target.value) || 0);
    if (next === state.data.allowance) return;
    setSetting('allowance', next);
    draw();
    $('#allowance')?.focus();
  });

  $('#clearsearches')?.addEventListener('click', () => {
    resetSearches(opt.sig);
    draw();
  });

  // A plan in the same JSON a pasted answer comes back as. The clipboard can
  // refuse — the published copy is plain http — so the AI tab holds it as well,
  // and that is where the button leaves you.
  const exportPlan = async (plan) => {
    try {
      await navigator.clipboard.writeText(planJson(plan));
    } catch {
      /* no clipboard here; the box on the AI tab is the fallback */
    }
    showTab('ai');
  };

  $('#dropoptimise')?.addEventListener('click', () => {
    opt.plan = null;
    opt.chosen = null;
    opt.pinned = true;
    draw();
  });

  const show = (row) => {
    const rebuilt = opt.searches[row.search].search.rebuild(row.key);
    if (!rebuilt) return;
    opt.plan = rebuilt;
    opt.chosen = row.id;
  };

  for (const el of document.querySelectorAll('#cutplan tr[data-plan]')) {
    const choose = () => {
      const row = offers().find((r) => r.id === el.dataset.plan);
      if (!row) return null;
      opt.pinned = true;
      show(row);
      return opt.plan;
    };
    const pick = () => {
      if (choose()) draw();
    };
    // Exporting a row draws it as well: what leaves for the model and what is
    // on the screen being two different plans is the one confusion worth ruling
    // out. The row's own handler would do it anyway, but by then the table has
    // been redrawn and this button is gone, so it is done here instead.
    el.querySelector('.exportrow')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      const plan = choose();
      draw();
      if (plan) await exportPlan(plan);
    });
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (event) => {
      // The button inside the row does its own thing on Enter; without this the
      // row would pick the plan a second time on the way up.
      if (event.target.closest('.exportrow')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pick();
      }
    });
  }

  const stop = () => {
    if (opt.timer) clearTimeout(opt.timer);
    opt.timer = null;
    opt.active = null;
  };

  const start = (shrink, { keepPinned = false } = {}) => {
    const search = createSearch(nestable, state.data, { shrink, seed: opt.searches.length + 1 });
    opt.searches.push({ search, shrink });
    opt.active = search;
    if (!keepPinned) opt.pinned = false;

    const tick = () => {
      if (opt.active !== search) return;
      const improved = search.step(1);
      // Follow the search while it is running, unless a plan has been picked by
      // hand — then it stays put and the new ones simply join the list.
      if (improved && !opt.pinned) {
        const best = offers()[0];
        if (best) show(best);
      }
      // A seed is one hill, and it is climbed out in a few hundred rounds. Rather
      // than stop there, the next one starts from somewhere else and its plans
      // join the list — twelve seeds are worth about ten per cent on this roof,
      // where a longer run of one is worth two. It runs until it is stopped,
      // which is what the button has always said it does.
      if (search.round >= ROUNDS) {
        start(opt.reduce, { keepPinned: true });
        return;
      }
      if (improved) draw();
      else {
        const label = $('#cutplan .plan-controls .muted');
        if (label) {
          label.textContent = `search ${opt.searches.length} \u00b7 round ${search.round} \u00b7 ${search.sheets} sheets \u00b7 £${search.cost.toFixed(2)}`;
        }
      }
      opt.timer = setTimeout(tick, 0);
    };
    if (!opt.pinned) {
      const best = offers()[0];
      if (best) show(best);
    }
    draw();
    opt.timer = setTimeout(tick, 0);
  };

  $('#optimise')?.addEventListener('click', () => {
    if (opt.active) {
      stop();
      draw();
      return;
    }
    // The box is only on the page when something needs shrinking; without it
    // the slack is nought and the search is on the pieces as measured.
    opt.reduce = Math.max(0, Number($('#reduce')?.value) || 0);
    start(opt.reduce);
  });
}

/**
 * The prompt to take away, and the answer to bring back. Nothing here talks to a
 * model — the page is static — so the exchange is copy, paste, and check.
 */
function drawAsk(pieces, ours) {
  const data = state.data;
  const mine = state.pasted ? readPlan(state.pasted, pieces, data) : { sheets: [], problems: [], cost: 0 };
  const drawable = pieces.filter((p) => p.vertices).length;
  // A shrunk plan is of a smaller roof, so its coordinates do not fit the pieces
  // as measured. Worth saying next to the box rather than letting it be pasted
  // back and reported as overlapping.
  const shrunk = state.opt.plan ? offers().find((r) => r.id === state.opt.chosen)?.shrink || 0 : state.opt.reduce;

  const verdict = !state.pasted
    ? ''
    : mine.problems.length
      ? `<ul class="warnings">${mine.problems.map((m) => `<li>${m}</li>`).join('')}</ul>`
      : `<p class="ok">Every piece placed once, inside its sheet, nothing overlapping.</p>`;

  const comparison =
    state.pasted && mine.sheets.length
      ? `<p><b>${mine.sheets.length} sheets, £${mine.cost.toFixed(2)}</b> against the
         nester's ${ours.sheets.length} sheets, £${ours.cost.toFixed(2)}
         — ${mine.cost < ours.cost ? `£${(ours.cost - mine.cost).toFixed(2)} better` : mine.cost > ours.cost ? `£${(mine.cost - ours.cost).toFixed(2)} worse` : 'the same'}.</p>`
      : '';

  $('#ai').innerHTML = `<section class="ask">
    <h2>1. Give a model the pieces</h2>
    <p class="hint">${drawable} pieces, ${(data.sheets || []).length} sheet sizes, the rules the nester works
      under. Paste it into Claude, or anything else, and ask for the arrangement.</p>
    <textarea id="prompt" class="long" rows="16" spellcheck="false" readonly>${escapeHtml(promptTemplate(data))}</textarea>
    <div class="ask-buttons"><button id="copyprompt">Copy the prompt, filled in</button></div>
    <p class="hint">Copy takes the three boxes below and puts each one where the prompt names it, so
      what reaches the clipboard is the whole thing. The boxes are here to be read one at a time,
      and to be copied one at a time when a model would rather be handed them separately.</p>

    <h3><code>[sheets]</code></h3>
    <p class="hint">The catalogue, as ticked on the cut plan.</p>
    <textarea id="sheetlist" class="long" rows="8" spellcheck="false" readonly>${escapeHtml(sheetList(data))}</textarea>
    <div class="ask-buttons"><button id="copysheets">Copy the sheets</button></div>

    <h3><code>[pieces]</code></h3>
    <p class="hint">Every measured piece, with its corners.</p>
    <textarea id="piecelist" class="long" rows="8" spellcheck="false" readonly>${escapeHtml(pieceList(pieces))}</textarea>
    <div class="ask-buttons"><button id="copypieces">Copy the pieces</button></div>

    <h2>2. <code>[plan]</code> — the plan you have now, if you want it beaten</h2>
    <p class="hint">The arrangement on the cut plan, in the same JSON an answer comes back as${
      shrunk ? `, <b>but drawn from pieces ${fmt1(shrunk)} cm smaller than you measured</b>` : ''} —
      hand it over with the prompt and ask for fewer sheets than this. Leave it out and the model starts from nothing.
      This box follows whichever plan is chosen on the cut plan, so it cannot go stale;
      Export to AI over there copies it and brings you here. Clear it and the prompt goes out
      with no floor to beat.</p>
    <textarea id="planout" class="long" rows="10" spellcheck="false">${escapeHtml(planJson(ours))}</textarea>
    <div class="ask-buttons"><button id="copyplan">Copy the plan</button></div>

    <h2>3. Paste what comes back</h2>
    <p class="hint">Checked against the same rules before anything is drawn: inside the sheet, no
      overlaps, every piece placed once, half turns only. Nothing is saved to your measurements.</p>
    <textarea id="pasted" rows="6" spellcheck="false" placeholder='{"sheets": [ ... ]}'>${escapeHtml(state.draft)}</textarea>
    <div class="ask-buttons"><button id="checkplan">Check and draw it</button>
      <button id="clearplan">Clear</button></div>
    ${verdict}${comparison}
  </section>
  ${state.pasted && mine.sheets.length ? `<div class="sheets">${renderCutPlan(mine, data)}</div>${materials(mine, data)}` : ''}`;

  const copy = async (text, event) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Plain http has no clipboard API, so fall back to selecting the text.
      const box = $('#clipboard-fallback') || Object.assign(document.createElement('textarea'), { id: 'clipboard-fallback' });
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.value = text;
      box.select();
      document.execCommand('copy');
      box.remove();
    }
    event.target.textContent = 'Copied';
  };
  // The prompt goes out whole: each box put back where the prompt names it. The
  // values are read off the page rather than rebuilt, so what is copied is what
  // can be seen — the plan box in particular, which can be emptied by hand.
  $('#copyprompt').addEventListener('click', (event) =>
    copy(
      fillPrompt($('#prompt').value, {
        sheets: $('#sheetlist').value,
        pieces: $('#piecelist').value,
        plan: $('#planout').value.trim(),
      }).trimEnd(),
      event,
    ),
  );
  $('#copysheets').addEventListener('click', (event) => copy($('#sheetlist').value, event));
  $('#copypieces').addEventListener('click', (event) => copy($('#piecelist').value, event));
  $('#copyplan').addEventListener('click', (event) => copy($('#planout').value, event));
  $('#pasted').addEventListener('input', (event) => {
    state.draft = event.target.value;
    setSetting('pastedDraft', state.draft);
  });
  $('#checkplan').addEventListener('click', () => {
    state.draft = $('#pasted').value;
    state.pasted = state.draft.trim();
    setSetting('pastedDraft', state.draft);
    setSetting('pastedPlan', state.pasted);
    draw();
  });
  $('#clearplan').addEventListener('click', () => {
    state.pasted = '';
    state.draft = '';
    setSetting('pastedDraft', '');
    setSetting('pastedPlan', '');
    draw();
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// The sheet catalogue and your measurements are separate files so that
// refreshing prices can never touch the measurements. ?cuts= swaps which
// measurements are drawn.
const SHEETS = 'data/sheets.json';
const CUTS = new URLSearchParams(location.search).get('cuts') || 'data/cuts.json';

async function fetchText(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} — ${res.status} ${res.statusText}`);
  return res.text();
}

const status = (text) => {
  $('#status').textContent = text;
};

/**
 * The defaults, then whatever this browser has been doing since.
 *
 * The files are read once. They are the shipped roof and the shipped
 * catalogue: what a new visitor sees, and what Reset goes back to. From the
 * first edit onwards the store is the record — the page never writes to a file,
 * and the way work leaves the browser is Export.
 */
async function load() {
  status('loading…');
  let cutsDoc;
  let sheetsDoc;
  try {
    const [sheets, cuts] = await Promise.all([fetchText(SHEETS), fetchText(CUTS)]);
    sheetsDoc = JSON.parse(sheets);
    cutsDoc = JSON.parse(cuts);
  } catch (err) {
    status(`could not load — ${err.message}`);
    return;
  }
  state.defaults = { sheets: sheetsDoc, cuts: cutsDoc };

  // An older version of this page kept a key per thing. A tablet that has been
  // measuring all week has its only copy of that work in them, so they are
  // folded in before anything else looks at storage.
  state.store = store.read() || store.migrate(cutsDoc, sheetsDoc, CUTS) || store.fromDefaults(cutsDoc, sheetsDoc);
  keep();
  showSidebar(!state.store.settings.sidebarOff);
  if (!store.current(state.store)) {
    emptyDesigns();
    return;
  }
  useStore();
  showTab(rememberedTab() || state.store.settings.tab || 'pieces');
  draw();
  const design = store.current(state.store);
  status(`${design.name} · ${Object.keys(design.cuts).length} pieces · ${state.store.sheets.length} sheet sizes`);
}

/**
 * The measurements out of the browser and back into it.
 *
 * A tablet has nowhere to put a file, so the way off it is the text itself:
 * copy it, or send it to yourself on WhatsApp, and paste it into the import box
 * on the machine that has `serve.mjs` running. What goes out is `serialise`'s
 * output — data/cuts.json byte for byte — so it can equally be pasted straight
 * over the file in an editor.
 */
function openExport() {
  if (!state.data) return;
  $('#export-text').value = serialise(state.data.cuts);
  $('#export-status').textContent = '';
  $('#exporter').showModal();
}

/**
 * The clipboard API needs a secure context and the published copy is plain
 * http, so the old selection-and-copy is the one that actually runs there. If
 * even that is refused the text is at least left selected, ready for a long
 * press.
 */
async function copyExport() {
  const box = $('#export-text');
  const note = (text) => {
    $('#export-status').textContent = text;
  };
  try {
    await navigator.clipboard.writeText(box.value);
    note('Copied.');
    return;
  } catch {
    /* no clipboard here — fall through to selecting it */
  }
  // iOS will not select inside a readonly box, and putting the caret in one that
  // is not readonly is harmless: nothing here is saved.
  box.removeAttribute('readonly');
  box.focus();
  box.setSelectionRange(0, box.value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  box.setAttribute('readonly', '');
  note(copied ? 'Copied.' : 'Could not copy on its own — the text is selected, so hold it and choose Copy.');
}

/** WhatsApp with the text already in the box, ready to pick who it goes to. */
function whatsappExport() {
  const url = `https://wa.me/?text=${encodeURIComponent($('#export-text').value)}`;
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) location.href = url;
}

function openImport() {
  $('#import-text').value = '';
  $('#import-status').textContent = '';
  $('#importer').showModal();
}

/**
 * Everything or nothing: the paste is checked in full before a single
 * measurement is replaced, so a truncated message cannot leave half a roof.
 */
async function runImport() {
  const note = (text) => {
    $('#import-status').textContent = text;
  };
  let parsed;
  try {
    parsed = JSON.parse($('#import-text').value);
  } catch (err) {
    note(`Not JSON — ${err.message}`);
    return;
  }
  const cuts = parsed && typeof parsed.cuts === 'object' && parsed.cuts ? parsed.cuts : null;
  if (!cuts || !Object.keys(cuts).length) {
    note('No "cuts" in there. Paste the whole file, from the first { to the last }.');
    return;
  }
  for (const [id, cut] of Object.entries(cuts)) {
    const edges = cut?.edges;
    if (!Array.isArray(edges) || edges.length < 3 || edges.some((n) => !Number.isFinite(Number(n)))) {
      note(`Piece ${id} has no usable edges — nothing imported.`);
      return;
    }
  }

  // Straight into the design being worked on, replacing its measurements. The
  // shape accepted is the one Export writes, which is `cuts.json`'s — so
  // anything exported before this existed still comes back in.
  const design = store.current(state.store);
  design.note = typeof parsed.note === 'string' ? parsed.note : design.note;
  design.cuts = Object.fromEntries(
    Object.entries(cuts).map(([id, cut]) => [
      id,
      { side: cut.side || 'unassigned', edges: cut.edges.map(Number), turn: Number(cut.turn) || 0, mirror: !!cut.mirror },
    ])
  );
  // Marks belong to pieces, and these are different pieces.
  design.flags = design.flags.filter((id) => id in design.cuts);
  saveCuts();
  useStore();
  draw();
  $('#importer').close('cancel');
}

/**
 * A design: renaming it, throwing it away.
 *
 * Opening one is on the row itself, where you are already looking, so this is
 * only the two things that need a name typed or a confirmation. Nothing is a
 * copy here — a design is renamed in place — so the dialog acts at once and
 * closes.
 */
function openDesign(id) {
  const design = state.store.designs[id];
  if (!design) return;
  state.design = id;
  $('#design-title').textContent = design.name;
  $('#design-name').value = design.name;
  $('#design-status').textContent =
    id === state.store.current ? 'This is the one you are working on.' : '';
  $('#designeditor').showModal();
  $('#designeditor button[value=\"cancel\"]').focus();
}

function useDesign(id, tab) {
  if (!state.store.designs[id]) return;
  if (id !== state.store.current) {
    state.store.current = id;
    keep();
    // A different roof is a different search; the plan on screen was not made
    // from these measurements.
    resetSearches('');
  }
  draw();
  if (tab) showTab(tab);
  status(`${state.store.designs[id].name} — open`);
}

function renameDesign() {
  const design = state.store.designs[state.design];
  const name = $('#design-name').value.trim();
  if (!design) return;
  if (!name) {
    $('#design-status').textContent = 'A design needs a name.';
    return;
  }
  design.name = name;
  keep();
  draw();
  $('#designeditor').close('cancel');
}

function deleteDesign() {
  const design = state.store.designs[state.design];
  if (!design) return;
  if (!confirm(`Delete ${design.name}? Everything measured on it goes with it.`)) return;
  delete state.store.designs[state.design];
  // Something has to be open while there is anything to open.
  if (state.store.current === state.design) state.store.current = Object.keys(state.store.designs)[0] || null;
  keep();
  resetSearches('');
  if (state.store.current) draw();
  else emptyDesigns();
  $('#designeditor').close('cancel');
}

/**
 * Every design deleted. There is no roof to draw, so the only thing on the
 * page is the way back to one.
 */
function emptyDesigns() {
  for (const id of ['pieces', 'roof', 'cutplan']) $(`#${id}`).innerHTML = '';
  $('#summary').innerHTML = '';
  $('#warnings').innerHTML = '';
  $('#designs').innerHTML = renderDesigns({}, null, state.defaults.sheets.units);
  showTab('designs');
  status('no designs — start one from the roof we ship');
}

/** A copy of the roof being worked on, under a new name. */
function saveAs() {
  const design = store.current(state.store);
  const name = prompt('Save this roof as', design ? `${design.name} copy` : 'My roof');
  if (name === null) return;
  const id = store.newId();
  state.store.designs[id] = design
    ? { ...structuredClone(design), name: name.trim() || 'Untitled' }
    : store.toDesign(name.trim() || 'Untitled', state.defaults.cuts);
  state.store.current = id;
  keep();
  draw();
  showTab('designs');
  status(`${state.store.designs[id].name} — saved and open`);
}

/**
 * Reset, one thing at a time.
 *
 * Four separate acts that happen to share a button. Doing all four is rarely
 * what is wanted, so nothing is ticked to begin with and nothing untouched is
 * touched.
 */
function openReset() {
  for (const id of ['reset-cuts', 'reset-sheets', 'reset-settings', 'reset-designs']) $(`#${id}`).checked = false;
  $('#reset-status').textContent = '';
  $('#resetter').showModal();
  $('#resetter button[value=\"cancel\"]').focus();
}

function runReset() {
  const want = {
    cuts: $('#reset-cuts').checked,
    sheets: $('#reset-sheets').checked,
    settings: $('#reset-settings').checked,
    designs: $('#reset-designs').checked,
  };
  if (!Object.values(want).some(Boolean)) {
    $('#reset-status').textContent = 'Tick what you want reset.';
    return;
  }
  const what = Object.entries(want).filter(([, on]) => on).map(([name]) => name);
  if (!confirm(`Reset ${what.join(', ')}? This cannot be undone.`)) return;

  if (want.designs) {
    state.store.designs = {};
    state.store.current = null;
  } else if (want.cuts) {
    const design = store.current(state.store);
    if (design) {
      design.cuts = structuredClone(state.defaults.cuts.cuts);
      design.note = state.defaults.cuts.note || '';
      design.flags = [];
    }
  }
  if (want.sheets) state.store.sheets = (state.defaults.sheets.sheets || []).map(store.toSheet);
  if (want.settings) state.store.settings = store.fromDefaults(state.defaults.cuts, state.defaults.sheets).settings;

  keep();
  resetSearches('');
  $('#resetter').close('cancel');
  if (state.store.current) {
    draw();
    showSidebar(!state.store.settings.sidebarOff);
    status(`reset: ${what.join(', ')}`);
  } else {
    emptyDesigns();
  }
}

/**
 * One sheet size, on a copy until Save.
 *
 * `editing` is the id being changed, or null for a size being added. The id
 * itself is never on the form: the cut-plan selection points at it, so renaming
 * one would quietly drop a size out of the plan.
 */
function openSheet(id) {
  const sheet = state.store.sheets.find((s) => s.id === id);
  state.sheet = sheet ? sheet.id : null;
  const units = state.data.units;
  $('#sheet-title').textContent = sheet ? `${sheet.label || sheet.id}` : 'New sheet size';
  $('#sheet-label').value = sheet ? sheet.label : '';
  $('#sheet-width').value = sheet ? sheet.width : '';
  $('#sheet-length').value = sheet ? sheet.length : '';
  $('#sheet-price').value = sheet ? sheet.price : '';
  $('#sheet-url').value = sheet ? sheet.url : '';
  $('#sheet-delete').hidden = !sheet;
  $('#sheet-status').textContent = sheet ? '' : `Width and length in ${units}.`;
  $('#sheeteditor').showModal();
  $('#sheeteditor button[value="cancel"]').focus();
}

function saveSheet() {
  const note = (text) => {
    $('#sheet-status').textContent = text;
  };
  const width = Number($('#sheet-width').value);
  const length = Number($('#sheet-length').value);
  const price = Number($('#sheet-price').value);
  if (!(width > 0) || !(length > 0)) {
    note('Width and length both have to be more than zero.');
    return;
  }
  if (!Number.isFinite(price) || price < 0) {
    note('The price has to be a number, and not a negative one.');
    return;
  }

  const label = $('#sheet-label').value.trim() || `${width}x${length}`;
  const url = $('#sheet-url').value.trim();
  const existing = state.store.sheets.find((s) => s.id === state.sheet);
  if (existing) Object.assign(existing, { label, width, length, price, url });
  else state.store.sheets.push(store.toSheet({ id: store.newId(), label, width, length, price, url }));

  keep();
  draw();
  $('#sheeteditor').close('cancel');
}

function deleteSheet() {
  const sheet = state.store.sheets.find((s) => s.id === state.sheet);
  if (!sheet) return;
  if (!confirm(`Delete ${sheet.label || sheet.id}? The cut plan will stop using it.`)) return;
  state.store.sheets = state.store.sheets.filter((s) => s.id !== sheet.id);
  const picks = state.store.settings.sheetPicks;
  if (Array.isArray(picks)) state.store.settings.sheetPicks = picks.filter((id) => id !== sheet.id);
  keep();
  draw();
  $('#sheeteditor').close('cancel');
}

/** Out of the way, and it stays out of the way until it is asked back. */
function showSidebar(on) {
  document.body.classList.toggle('sidebar-off', !on);
  const button = $('#sidebar-toggle');
  button.setAttribute('aria-expanded', String(on));
  button.title = on ? 'Hide the sidebar' : 'Show the sidebar';
  if (state.store) setSetting('sidebarOff', !on);
}

function showTab(name) {
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.id !== name;
  }
  for (const tab of document.querySelectorAll('.toolbar button[data-tab]')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  // Refreshing to see a measurement redrawn should not send you back to the
  // first tab.
  if (state.store) setSetting('tab', name);
}

function rememberedTab() {
  const name = state.store?.settings.tab;
  return document.querySelector(`.toolbar button[data-tab="${name}"]`) ? name : null;
}

document.querySelectorAll('.toolbar button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
// Only the open tab is printed; the stylesheet does the choosing, so there is
// nothing to pass here.
$('#print').addEventListener('click', () => window.print());
$('#reload').addEventListener('click', () => load());
$('#export').addEventListener('click', openExport);
$('#export-copy').addEventListener('click', copyExport);
$('#export-whatsapp').addEventListener('click', whatsappExport);
$('#import').addEventListener('click', openImport);
$('#import-go').addEventListener('click', runImport);
$('#forgetlocal').addEventListener('click', openReset);
$('#reset-go').addEventListener('click', runReset);
$('#saveas').addEventListener('click', saveAs);
$('#designs').addEventListener('click', (event) => {
  if (event.target.closest('#design-new')) {
    const id = store.newId();
    state.store.designs[id] = store.toDesign('My roof', state.defaults.cuts);
    state.store.current = id;
    keep();
    // Starting a roof is opening it — the same as Open on a row, so it lands in
    // the same place. Staying on an empty-turned-one-row list says nothing.
    draw();
    showTab('roof');
    return;
  }
  const open = event.target.closest('.design-open');
  if (open) {
    useDesign(open.dataset.design, 'roof');
    return;
  }
  const edit = event.target.closest('.design-edit');
  if (edit) openDesign(edit.dataset.design);
});
$('#design-rename').addEventListener('click', renameDesign);
$('#design-delete').addEventListener('click', deleteDesign);
$('#cutplan').addEventListener('change', (event) => {
  const box = event.target;
  const ids = pickedIds();
  if (box.classList?.contains('pick-one')) {
    if (box.checked) ids.add(box.dataset.sheet);
    else ids.delete(box.dataset.sheet);
    setPicks(ids);
    return;
  }
  if (box.classList?.contains('pick-all')) {
    for (const sheet of state.store.sheets) {
      if (sheet.width !== Number(box.dataset.width)) continue;
      if (box.checked) ids.add(sheet.id);
      else ids.delete(sheet.id);
    }
    setPicks(ids);
  }
});
$('#cutplan').addEventListener('click', (event) => {
  if (event.target.closest('#pick-all')) setPicks(new Set(state.store.sheets.map((s) => s.id)));
  if (event.target.closest('#pick-none')) setPicks(new Set());
});
$('#sheets').addEventListener('click', (event) => {
  if (event.target.closest('#sheet-new')) return openSheet(null);
  const row = event.target.closest('.sheet-row');
  if (row) openSheet(row.dataset.sheet);
});
$('#sheet-save').addEventListener('click', saveSheet);
$('#sheet-delete').addEventListener('click', deleteSheet);
$('#pieces').addEventListener('change', onEdgeChange);
$('#pieces').addEventListener('click', onStep);
$('#editor-body').addEventListener('click', onStep);
/**
 * Turn the piece over, or stand it on the next edge.
 *
 * The whole body is redrawn rather than the numbers poked into the boxes: every
 * length has moved to a different edge, so there is no caret worth keeping.
 */
$('#editor-body').addEventListener('click', (event) => {
  const button = event.target.closest?.('.turn');
  const op = OPS[button?.dataset.transform];
  if (!op || !state.editing) return;
  Object.assign(state.editing, compose({ turn: state.editing.turn, mirror: state.editing.mirror }, op));
  drawEditor();
});
$('#roof').addEventListener('change', (event) => {
  const box = event.target.closest?.('.side-toggle');
  if (!box) return;
  if (box.checked) state.hiddenSides.delete(box.dataset.side);
  else state.hiddenSides.add(box.dataset.side);
  setSetting('hiddenSides', [...state.hiddenSides]);
  draw();
});
/**
 * A flag on or off, without a redraw.
 *
 * The class is toggled on the node under the finger rather than the drawing
 * being rebuilt: rebuilding takes the element out from under the tap, and there
 * is nothing else on the page that a flag changes.
 */
function toggleFlag(node) {
  const id = node.dataset.flag;
  const on = !state.flags.has(id);
  if (on) state.flags.add(id);
  else state.flags.delete(id);
  node.classList.toggle('on', on);
  node.setAttribute('aria-pressed', String(on));
  store.current(state.store).flags = [...state.flags];
  keep();
}

$('#roof').addEventListener('click', (event) => {
  const flag = event.target.closest('.roof-flag');
  if (flag) {
    toggleFlag(flag);
    return;
  }
  const target = event.target.closest('.roof-piece');
  if (target) openEditor(target.dataset.piece);
});
$('#roof').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const flag = event.target.closest?.('.roof-flag');
  if (flag) {
    event.preventDefault();
    toggleFlag(flag);
    return;
  }
  const target = event.target.closest?.('.roof-piece');
  if (target) {
    event.preventDefault();
    openEditor(target.dataset.piece);
  }
});
$('#editor-body').addEventListener('input', onEditorInput);
$('#editor').addEventListener('close', onEditorClose);
$('#pieces').addEventListener('input', (event) => {
  if (event.target.classList?.contains('edge-input')) markClosure(event.target);
});

$('#sidebar-toggle').addEventListener('click', () => showSidebar(document.body.classList.contains('sidebar-off')));
// Everything else waits on the store, which `load` is what reads.
load();
