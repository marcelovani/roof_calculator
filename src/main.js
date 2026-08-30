import { OPS, area, buildRelaxed, compose, fitPolygon, isPlain, orient } from './geometry.js';
import { plan } from './nest.js';
import { createSearch } from './nest-blf.js';
import { promptFor, readPlan } from './aiplan.js';
import { EDGE_NAMES, renderCutPlan, renderOrder, renderPieceEditor, renderPiecePreview, renderPieces, renderRoof, sqm } from './render.js';

const $ = (sel) => document.querySelector(sel);

/** Attribute-safe, unlike escapeHtml below, which only guards text. */
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SIDE_ORDER = ['west', 'south', 'east', 'north'];

const state = { data: null, raw: {}, showFitted: false, hiddenSides: new Set(), flags: new Set(), stepTimer: null, pieces: [], pasted: '', draft: '', editing: null,
  // The slow nester's plan, and the measurements it was made from. Kept apart
  // from the fast one so a keystroke never waits on a search.
  // Every search run on the current measurements, everything they found, and
  // which of it is on the screen. Kept apart from the fast plan so a keystroke
  // never waits on a search.
  opt: { sig: '', searches: [], active: null, chosen: null, plan: null, pinned: false, timer: null, reduce: 0 } };

// What is drawn, and what is merely typed. Keeping them apart means a refresh
// mid-paste loses nothing, without the half-typed text being checked as if it
// had been submitted.
const PASTED_KEY = 'roof.pastedPlan';
const DRAFT_KEY = 'roof.pastedDraft';
const HIDDEN_KEY = 'roof.hiddenSides';
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage off; it just will not survive a refresh */
  }
};

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
 * Where the browser keeps the measurements when the server will not take them.
 *
 * Keyed on which file is being drawn, so the worked example and your own roof
 * do not overwrite each other.
 */
const localKey = () => `roof.cuts:${CUTS}`;
const flagKey = () => `roof.flags:${CUTS}`;

const localCuts = () => {
  try {
    return localStorage.getItem(localKey());
  } catch {
    return null;
  }
};

function forgetLocalCuts() {
  try {
    localStorage.removeItem(localKey());
  } catch {
    /* nothing was kept in the first place */
  }
  showLocalNote();
}

/**
 * The browser's copy of the measurements — written on every save, before
 * anything is sent anywhere.
 *
 * This is the record. The file is only the record once a read of it comes back
 * matching, which is what `load` checks; a 200 from a PUT proves nothing, and
 * on the published copy it is a plain lie — the host answers PUT with 200 and
 * writes nothing at all. Believing it cost an edit every time the poll ran.
 */
function keepLocally(text) {
  try {
    localStorage.setItem(localKey(), text);
  } catch {
    return false;
  }
  showLocalNote();
  return true;
}

/** Reset is always there; it just says whether there is anything to reset. */
function showLocalNote() {
  const button = $('#forgetlocal');
  if (button) button.classList.toggle('armed', !!localCuts());
}

/**
 * Write the measurements back: into this browser, and at the file if it will
 * take them.
 *
 * `state.raw.cuts` is set either way, and set first. It is what the watcher
 * compares against, so recording it here keeps our own save from bouncing back
 * as an external change and redrawing over the edit that caused it.
 */
async function saveCuts() {
  const text = serialise(state.data.cuts);
  state.raw.cuts = text;
  const kept = keepLocally(text);
  const at = () => new Date().toLocaleTimeString('en-GB');

  let sent;
  try {
    const res = await fetch(CUTS, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text });
    sent = res.ok ? null : `${res.status} ${await res.text().catch(() => res.statusText)}`;
  } catch (err) {
    sent = err.message;
  }

  if (!kept) {
    status(`nothing here will keep this — copy it out with Export before you reload`);
    return false;
  }
  status(
    sent
      ? `kept in this browser at ${at()} — ${CUTS} did not take it (${sent})`
      : `saved at ${at()} — kept here until ${CUTS} reads back the same`
  );
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
  await saveCuts();

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
  await saveCuts();
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

/** The measurements a plan was made from, so an edit can retire it. */
const signature = (pieces) => pieces.map((p) => `${p.id}:${p.edges.join(',')}`).join('|');

function draw() {
  const data = state.data;
  const { pieces, problems } = toPieces(data);
  const nestable = pieces.filter((p) => p.vertices);
  const sig = signature(nestable);
  if (sig !== state.opt.sig) resetSearches(sig);
  const fast = plan(nestable, data);
  const result = state.opt.plan || fast;

  $('#pieces').innerHTML = renderPieces(pieces, problems, data.units, state.showFitted);
  $('#roof').innerHTML = renderRoof(pieces, data.units, state.hiddenSides, state.flags);
  drawAsk(pieces, result);
  $('#cutplan').innerHTML = planControls(fast) + renderCutPlan(result, data) + materials(result, data);
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
function planControls(fast) {
  if (!fast.sheets.length) return '';
  const { active, chosen, reduce } = state.opt;
  const rows = offers();
  const status = active
    ? `<span class="muted">round ${active.round} &middot; ${active.sheets} sheets &middot; &pound;${active.cost.toFixed(2)}</span>`
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
            <td class="mix">${esc(r.mix)}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '';

  const trialWarning = rows.some((r) => r.shrink && state.opt.chosen === r.id)
    ? `<p class="hint bad">This plan is drawn from pieces ${fmt1(rows.find((r) => r.id === state.opt.chosen).shrink)} cm
       narrower and ${fmt1(rows.find((r) => r.id === state.opt.chosen).shrink)} cm shorter than you measured, so its
       price is not one you can order. It is here to say what that much slack would be worth.</p>`
    : '';

  // One button, three jobs: start, stop, start again. Starting again adds to the
  // list rather than replacing it, which is what "more" is saying.
  return `<div class="plan-controls">
    <label class="reduce">every piece
      <input id="reduce" type="number" step="0.5" min="0" value="${esc(reduce)}"${active ? ' disabled' : ''}> cm smaller</label>
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

  $('#reduce')?.addEventListener('change', (event) => {
    opt.reduce = Math.max(0, Number(event.target.value) || 0);
  });

  $('#clearsearches')?.addEventListener('click', () => {
    resetSearches(opt.sig);
    draw();
  });

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
    const pick = () => {
      const row = offers().find((r) => r.id === el.dataset.plan);
      if (!row) return;
      opt.pinned = true;
      show(row);
      draw();
    };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (event) => {
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

  const start = (shrink) => {
    const search = createSearch(nestable, state.data, { shrink, seed: opt.searches.length + 1 });
    opt.searches.push({ search, shrink });
    opt.active = search;
    opt.pinned = false;

    const tick = () => {
      if (opt.active !== search) return;
      const improved = search.step(1);
      // Follow the search while it is running, unless a plan has been picked by
      // hand — then it stays put and the new ones simply join the list.
      if (improved && !opt.pinned) {
        const best = offers()[0];
        if (best) show(best);
      }
      if (search.round >= ROUNDS) {
        stop();
        draw();
        return;
      }
      if (improved) draw();
      else {
        const label = $('#cutplan .plan-controls .muted');
        if (label) label.textContent = `round ${search.round} \u00b7 ${search.sheets} sheets \u00b7 £${search.cost.toFixed(2)}`;
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
    opt.reduce = Math.max(0, Number($('#reduce').value) || 0);
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
    <button id="copyprompt">Copy the prompt</button>
    <details><summary class="hint">Read it first</summary><pre id="prompt">${escapeHtml(promptFor(pieces, data))}</pre></details>

    <h2>2. Paste what comes back</h2>
    <p class="hint">Checked against the same rules before anything is drawn: inside the sheet, no
      overlaps, every piece placed once, half turns only. Nothing is saved to your measurements.</p>
    <textarea id="pasted" rows="6" spellcheck="false" placeholder='{"sheets": [ ... ]}'>${escapeHtml(state.draft)}</textarea>
    <div class="ask-buttons"><button id="checkplan">Check and draw it</button>
      <button id="clearplan">Clear</button></div>
    ${verdict}${comparison}
  </section>
  ${state.pasted && mine.sheets.length ? `<div class="sheets">${renderCutPlan(mine, data)}</div>${materials(mine, data)}` : ''}`;

  $('#copyprompt').addEventListener('click', async (event) => {
    await navigator.clipboard.writeText(promptFor(pieces, data));
    event.target.textContent = 'Copied';
  });
  $('#pasted').addEventListener('input', (event) => {
    state.draft = event.target.value;
    remember(DRAFT_KEY, state.draft);
  });
  $('#checkplan').addEventListener('click', () => {
    state.draft = $('#pasted').value;
    state.pasted = state.draft.trim();
    remember(DRAFT_KEY, state.draft);
    remember(PASTED_KEY, state.pasted);
    draw();
  });
  $('#clearplan').addEventListener('click', () => {
    state.pasted = '';
    state.draft = '';
    remember(PASTED_KEY, '');
    remember(DRAFT_KEY, '');
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
 * Both files, redrawn only when their text has actually changed. Polling is
 * enough at this size and needs no server beyond the static one, so the file
 * stays the only place measurements live: save in the editor, and the drawing
 * follows within the second.
 */
async function load({ quiet = false } = {}) {
  if (!quiet) status('loading…');
  let raw;
  try {
    const [sheets, cuts] = await Promise.all([fetchText(SHEETS), fetchText(CUTS)]);
    raw = { sheets, cuts };
  } catch (err) {
    status(`could not load — ${err.message}`);
    return;
  }
  // Edits made where the file cannot be written live in this browser; they are
  // what to draw, and the file is only the starting point. The one thing that
  // retires them is the file itself coming back saying the same — which is the
  // only proof that a save reached it.
  const kept = localCuts();
  if (kept === raw.cuts) forgetLocalCuts();
  else if (kept) raw.cuts = kept;
  if (raw.sheets === state.raw.sheets && raw.cuts === state.raw.cuts) return;
  // An edit in progress outranks the file: leave state.raw alone and the change
  // will be picked up on the next poll, once the box is no longer in use.
  if (document.activeElement?.classList?.contains('edge-input') || $('#editor').open) return;
  state.raw = raw;

  try {
    state.data = { ...JSON.parse(raw.sheets), ...JSON.parse(raw.cuts) };
  } catch (err) {
    // Half-typed JSON is normal while editing; keep the last good drawing up.
    status(`${CUTS} — not valid JSON yet (${err.message})`);
    return;
  }
  draw();
  const stamp = new Date().toLocaleTimeString('en-GB');
  status(`${CUTS} · ${Object.keys(state.data.cuts || {}).length} pieces · ${state.data.sheets.length} sheet sizes · watching, last change ${stamp}`);
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

  state.data = {
    ...state.data,
    note: typeof parsed.note === 'string' ? parsed.note : state.data?.note,
    cuts: Object.fromEntries(
      Object.entries(cuts).map(([id, cut]) => [
        id,
        { side: cut.side || 'unassigned', edges: cut.edges.map(Number), turn: Number(cut.turn) || 0, mirror: !!cut.mirror },
      ])
    ),
  };
  await saveCuts();
  draw();
  $('#importer').close('cancel');
}

const TAB_KEY = 'roof.tab';
const SIDEBAR_KEY = 'roof.sidebarOff';

/** Out of the way, and it stays out of the way until it is asked back. */
function showSidebar(on) {
  document.body.classList.toggle('sidebar-off', !on);
  const button = $('#sidebar-toggle');
  button.setAttribute('aria-expanded', String(on));
  button.title = on ? 'Hide the sidebar' : 'Show the sidebar';
  remember(SIDEBAR_KEY, on ? '' : '1');
}

function showTab(name) {
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.id !== name;
  }
  for (const tab of document.querySelectorAll('.tabs button[data-tab]')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  // Refreshing to see a measurement redrawn should not send you back to the
  // first tab. Storage can be turned off, and a missing tab is not worth an error.
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    /* nothing to remember it with */
  }
}

function rememberedTab() {
  let name;
  try {
    name = localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
  return document.querySelector(`.tabs button[data-tab="${name}"]`) ? name : null;
}

document.querySelectorAll('.tabs button[data-tab]').forEach((btn) => {
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
$('#forgetlocal').addEventListener('click', () => {
  if (localCuts() && !confirm(`Throw away the measurements kept in this browser and go back to ${CUTS}?`)) return;
  forgetLocalCuts();
  // The drawing is of the browser's copy, so there is nothing to compare
  // against until the file has been read again.
  state.raw = {};
  load();
});
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
  remember(HIDDEN_KEY, [...state.hiddenSides].join(','));
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
  remember(flagKey(), [...state.flags].join(','));
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

try {
  state.pasted = localStorage.getItem(PASTED_KEY) || '';
  state.draft = localStorage.getItem(DRAFT_KEY) ?? state.pasted;
  // A side that has since been renamed away is simply not hidden any more.
  const hidden = (localStorage.getItem(HIDDEN_KEY) || '').split(',').filter((s) => SIDE_ORDER.includes(s));
  state.hiddenSides = new Set(hidden);
  state.flags = new Set((localStorage.getItem(flagKey()) || '').split(',').filter(Boolean));
} catch {
  /* nothing remembered */
}

showLocalNote();
$('#sidebar-toggle').addEventListener('click', () => showSidebar(document.body.classList.contains('sidebar-off')));
showSidebar(!(() => {
  try {
    return localStorage.getItem(SIDEBAR_KEY);
  } catch {
    return null;
  }
})());
showTab(rememberedTab() || 'pieces');
load();
setInterval(() => load({ quiet: true }), 1000);
