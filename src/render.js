/**
 * SVG output. Everything is built as markup strings and assigned in one go —
 * there is no interaction to preserve, so there is nothing to gain from
 * patching nodes.
 */

import { area, bbox, buildRelaxed, fitPolygon, isPlain, normalise, orient, squareCorners, widthGuide } from './geometry.js';
import { SIDE_ORDER, layoutRoof } from './roof.js';

export const SIDE_COLOURS = {
  west: '#3f7cac',
  south: '#c2703d',
  east: '#4e8f5a',
  north: '#7a5ea8',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('en-GB');

/** Square metres, from whatever unit the JSON is written in. */
const PER_METRE = { mm: 1000, cm: 100, m: 1 };

export function sqm(value, units = 'cm') {
  const per = PER_METRE[units] || PER_METRE.cm;
  return (value / (per * per)).toFixed(2);
}

/** Maths coords (y up) to SVG coords (y down) within a box of the given height. */
function points(vertices, scale, height, dx = 0, dy = 0) {
  return vertices
    .map((v) => `${((v.x + dx) * scale).toFixed(2)},${(height - (v.y + dy) * scale).toFixed(2)}`)
    .join(' ');
}

/** The size of a right-angle mark on the page, whatever the piece measures. */
const SQUARE = 9;

/**
 * The surveyor's mark at every corner that is square: the little box tucked
 * into the angle, drawn on the page rather than in centimetres so it is the
 * same size on a piece 60 wide and one 240 wide.
 */
function rightAngles(vertices, scale, height, dx = 0, dy = 0) {
  const toSvg = (v) => ({ x: (v.x + dx) * scale, y: height - (v.y + dy) * scale });
  return squareCorners(vertices)
    .map((i) => {
      const here = toSvg(vertices[i]);
      const arms = [vertices[(i - 1 + vertices.length) % vertices.length], vertices[(i + 1) % vertices.length]]
        .map(toSvg)
        .map((end) => {
          const len = Math.hypot(end.x - here.x, end.y - here.y) || 1;
          return { x: ((end.x - here.x) / len) * SQUARE, y: ((end.y - here.y) / len) * SQUARE };
        });
      const corner = [
        [here.x + arms[0].x, here.y + arms[0].y],
        [here.x + arms[0].x + arms[1].x, here.y + arms[0].y + arms[1].y],
        [here.x + arms[1].x, here.y + arms[1].y],
      ];
      return `<polyline class="right-angle" points="${corner.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`;
    })
    .join('');
}

/**
 * Length labels running along each edge, offset inward. Sitting them at the
 * midpoints instead makes the two sides of a narrow triangle overlap.
 */
function edgeLabels(vertices, labels, scale, height, dx = 0, dy = 0) {
  const toSvg = (v) => ({ x: (v.x + dx) * scale, y: height - (v.y + dy) * scale });
  const centre = toSvg({
    x: vertices.reduce((s, v) => s + v.x, 0) / vertices.length - dx * 0,
    y: vertices.reduce((s, v) => s + v.y, 0) / vertices.length - dy * 0,
  });

  return vertices
    .map((v, i) => {
      const a = toSvg(v);
      const b = toSvg(vertices[(i + 1) % vertices.length]);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const inward = { x: centre.x - mid.x, y: centre.y - mid.y };
      const len = Math.hypot(inward.x, inward.y) || 1;
      const x = mid.x + (inward.x / len) * 9;
      const y = mid.y + (inward.y / len) * 9;
      let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const label = labels[i] || { value: 0, changed: false };
      return `<text class="edge-label${label.changed ? ' changed' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" transform="rotate(${angle.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${fmt(label.value)}</text>`;
    })
    .join('');
}

/**
 * The perpendicular drawn across the piece, with what it measures on the end.
 *
 * The number is not a measurement — it is the width the four lengths as typed
 * work out to where the slant starts, and it should be the base. Marked when it
 * is not: nudge the top up or down until it reads back.
 */
function guideLine(guide, scale, height, dx = 0, dy = 0) {
  if (!guide) return '';
  const toSvg = (v) => ({ x: (v.x + dx) * scale, y: height - (v.y + dy) * scale });
  const a = toSvg(guide.from);
  const b = toSvg(guide.to);
  // Half a centimetre is finer than the piece can be cut, so anything inside it
  // is square enough.
  const off = Math.abs(guide.width - guide.target) > 0.5;
  const away = { x: b.x - a.x, y: b.y - a.y };
  const len = Math.hypot(away.x, away.y) || 1;
  const x = b.x + (away.x / len) * 5;
  const y = b.y + (away.y / len) * 5;
  return `<line class="guide${off ? ' off' : ''}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>
    <circle class="guide-end${off ? ' off' : ''}" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="1.8"/>
    <text class="guide-label${off ? ' off' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
          text-anchor="${away.x < -0.5 ? 'end' : away.x > 0.5 ? 'start' : 'middle'}">${fmt(guide.width)}</text>`;
}

const CELL = 230;
const PAD = 26;

export function renderPieces(pieces, problems, units, showFitted = false) {
  const drawable = pieces.filter((p) => p.vertices);
  const longest = Math.max(1, ...drawable.map((p) => Math.max(bbox(p.vertices).width, bbox(p.vertices).height)));
  const scale = (CELL - PAD * 2) / longest;

  const bySide = new Map();
  for (const p of pieces) {
    if (!bySide.has(p.side)) bySide.set(p.side, []);
    bySide.get(p.side).push(p);
  }

  return [...bySide.entries()]
    .map(([side, group]) => {
      const total = group.reduce((s, p) => s + (p.vertices ? area(p.vertices) : 0), 0);
      const cells = group.map((p) => cell(p, scale, problems, units, showFitted)).join('');
      return `<section class="side-group">
        <h2><span class="swatch" style="background:${SIDE_COLOURS[side] || '#888'}"></span>${esc(side)}
          <span class="muted">${group.length} pieces &middot; ${sqm(total, units)} m&sup2;</span></h2>
        <div class="piece-grid">${cells}</div>
      </section>`;
    })
    .join('');
}

/**
 * Measured lengths, or the fitted ones with whatever changed marked. The order
 * they are entered in is the order the drawing walks its corners, so each
 * number already lands on its own edge.
 */
function edgeValues(piece, showFitted) {
  const shown = showFitted && piece.fitted ? piece.fitted : piece.edges;
  return shown.map((value, i) => ({
    value: Number(value),
    changed: !!piece.fitted && Math.abs(Number(piece.edges[i]) - piece.fitted[i]) > 0.05,
  }));
}

const MODEL_NOTE = {
  hip: 'hip cut',
  fitted: 'fitted',
};

/**
 * The edges are numbered, not named. A piece can be turned or flipped, so
 * "left" and "top" are only true of whichever way it happens to be lying —
 * side 1 stays side 1. The last one is still the base, whatever it is called.
 */
export const EDGE_NAMES = { 3: ['side 1', 'side 2', 'side 3'], 4: ['side 1', 'side 2', 'side 3', 'side 4'] };

/**
 * A minus and a plus either side of the box. The native spinner arrows are a
 * couple of pixels tall and are not shown at all on a touch keyboard, so on a
 * tablet they are the one control you cannot hit; these are sized for a finger.
 *
 * They sit outside the <label>, not in it. Safari hands a tap anywhere inside a
 * label to the control the label is for, and a button nested in one never sees
 * its own click — which on an iPad is a button that visibly does nothing.
 */
const stepper = (delta) =>
  `<button type="button" class="step" data-delta="${delta}" tabindex="-1"
           aria-label="${delta > 0 ? 'Add' : 'Take off'} 1 cm">${delta > 0 ? '+' : '&minus;'}</button>`;

/**
 * The measurements as typed-in boxes under the piece, two to a row, so the
 * numbers can be corrected against the drawing they produce rather than by
 * counting commas in the JSON.
 */
function edgeInputs(piece) {
  const names = EDGE_NAMES[piece.edges.length] || piece.edges.map((_, i) => `side ${i + 1}`);
  const boxes = piece.edges
    .map(
      // Whole centimetres on the arrows — that is the size of a correction off a
      // tape. A decimal typed in is still kept.
      // inputmode and the pattern are what bring up the digits-only keyboard on
      // a tablet; the rest keeps autocorrect and the spell checker off a number.
      (value, i) => `<div class="edge">${stepper(-1)}<label><span>${names[i]}</span>
        <input class="edge-input" type="number" step="1" min="0" inputmode="decimal"
               pattern="[0-9]*[.,]?[0-9]*" enterkeyhint="done" autocomplete="off"
               autocorrect="off" autocapitalize="off" spellcheck="false"
               data-piece="${esc(piece.id)}" data-edge="${i}" value="${esc(Number(value))}"></label>${stepper(1)}</div>`
    )
    .join('');
  return `<div class="edges">${boxes}</div>`;
}

function cell(piece, scale, problems, units, showFitted) {
  const problem = problems.get(piece.id);
  if (!piece.vertices) {
    return `<div class="piece-card">
      <figure class="piece ${problem ? 'invalid' : 'empty'}">
        <div class="placeholder">${problem ? '&#9888;' : '&mdash;'}</div>
        <figcaption><b>${esc(piece.id)}</b><span class="muted">${problem ? esc(problem) : 'not measured yet'}</span></figcaption>
      </figure>${edgeInputs(piece)}
    </div>`;
  }
  // Shifted to the origin first: a piece that leans far enough left — a trapezoid
  // whose top overhangs its base — reaches negative x, and would be drawn off
  // the edge of its own box.
  const shape = normalise(piece.vertices);
  const guide = widthGuide(shape, piece.edges);
  // The guide is measured off the base, so on a piece that leans in it reaches
  // past the shape's own right-hand side. Sizing the box to both keeps it on.
  const bb = bbox(guide ? [...shape, guide.to] : shape);
  const w = bb.width * scale + PAD * 2;
  const h = bb.height * scale + PAD * 2;
  const colour = SIDE_COLOURS[piece.side] || '#888';
  const note = MODEL_NOTE[piece.model];
  return `<div class="piece-card">
    <figure class="piece ${piece.model === 'fitted' ? 'fitted' : 'closes'}">
    <svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}">
      <g transform="translate(${PAD},${PAD})">
        <polygon points="${points(shape, scale, bb.height * scale)}" fill="${colour}22" stroke="${colour}" stroke-width="1.5"/>
        ${guideLine(guide, scale, bb.height * scale)}
        ${rightAngles(shape, scale, bb.height * scale)}
        ${edgeLabels(shape, edgeValues(piece, showFitted), scale, bb.height * scale)}
      </g>
    </svg>
    <figcaption><b>${esc(piece.id)}</b>
      <span class="muted">${note ? `${note} &middot; ` : ''}${sqm(area(piece.vertices), units)} m&sup2;</span></figcaption>
    </figure>${edgeInputs(piece)}
  </div>`;
}

/** Area centroid of a simple polygon. */
function centroid(vertices) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i];
    const q = vertices[(i + 1) % vertices.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) return { x: vertices[0].x, y: vertices[0].y };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

const SHEET_MAX_H = 460;
const SHEET_MAX_W = 300;

export function renderCutPlan(result, config) {
  if (!result.sheets.length) return '<p class="muted">Nothing to nest yet — fill in some edge lengths.</p>';
  const margin = Number(config.margin) || 0;
  const allowance = Number(config.allowance) || 0;
  /** How far past the sheet's own width this one reaches, into the allowance. */
  const overrunOf = (s) =>
    Math.max(0, ...s.placements.flatMap((p) => p.block.placements.map((pl) => p.x + bbox(pl.vertices).maxX)) ) - s.sheet.width;
  // One scale for the lot. Fitting each sheet to the page separately draws a 5 m
  // sheet the same size as a 2.5 m one, which is exactly the comparison you came
  // to the cut plan to make.
  const longest = Math.max(...result.sheets.map((s) => s.sheet.length));
  // The allowance is drawn, not clipped: a piece that runs into it has to be
  // visible past the edge or the red line means nothing.
  const widest = Math.max(...result.sheets.map((s) => s.sheet.width + Math.max(0, overrunOf(s))));
  const scale = Math.min(SHEET_MAX_H / longest, SHEET_MAX_W / widest);
  // Every sheet of one size says the same width and length, so it is said once
  // in a heading and the drawings under it carry only what differs.
  const groups = new Map();
  result.sheets.forEach((s, i) => {
    if (!groups.has(s.sheet.id)) groups.set(s.sheet.id, []);
    groups.get(s.sheet.id).push({ s, i });
  });
  const drawing = ({ s, i }) => {
    const over = Math.max(0, overrunOf(s));
    const w = s.sheet.width * scale;
    const h = s.sheet.length * scale;
    const canvas = (s.sheet.width + over) * scale;
    const used = s.placements.reduce((sum, p) => sum + p.block.area, 0);
    const shapes = s.placements
      .flatMap((p) =>
        p.block.placements.map((pl) => {
          const colour = SIDE_COLOURS[pl.piece.side] || '#888';
          // Area centroid, not bounding-box centre: two interlocked triangles
          // share a bounding box and their labels would land on top of each other.
          const c = centroid(pl.vertices);
          const cx = (p.x + c.x) * scale;
          const cy = h - (p.y + c.y) * scale;
          return `<polygon points="${points(pl.vertices, scale, h, p.x, p.y)}" fill="${colour}33" stroke="${colour}" stroke-width="1"/>
            ${edgeLabels(pl.vertices, edgeValues(pl.piece, false), scale, h, p.x, p.y)}
            <text class="piece-num" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}">${esc(pl.piece.id)}${pl.orientation ? '&#8635;' : ''}</text>`;
        })
      )
      .join('');
    // Dashed and red at the width the shop sells, so what sits to the right of
    // it is exactly what you are trusting the tolerance for.
    const edge = over
      ? `<line class="over-line" x1="${w.toFixed(1)}" y1="0" x2="${w.toFixed(1)}" y2="${h.toFixed(1)}"/>`
      : '';
    return `<figure class="sheet">
      <svg viewBox="0 0 ${canvas.toFixed(1)} ${h.toFixed(1)}" width="${canvas.toFixed(1)}" height="${h.toFixed(1)}">
        <rect x="0" y="0" width="${w.toFixed(1)}" height="${h.toFixed(1)}" class="offcut"/>
        <rect x="${(margin * scale).toFixed(1)}" y="${(margin * scale).toFixed(1)}"
              width="${((s.sheet.width - 2 * margin) * scale).toFixed(1)}"
              height="${((s.sheet.length - 2 * margin) * scale).toFixed(1)}" class="usable"/>
        ${shapes}
        <rect x="0.75" y="0.75" width="${(w - 1.5).toFixed(1)}" height="${(h - 1.5).toFixed(1)}" class="sheet-edge"/>
        ${edge}
      </svg>
      <figcaption><b>Sheet ${i + 1}</b>
        <span class="muted">${Math.round((used / (s.sheet.width * s.sheet.length)) * 100)}% used</span>
        ${
          over
            ? `<span class="over">Runs ${fmt(over)} cm past the red line — ${fmt(s.sheet.width + over)} cm
                wanted across a ${fmt(s.sheet.width)} cm sheet. Within the ${fmt(allowance)} cm allowed, but
                it only cuts if the sheet and the pieces are both as measured.</span>`
            : allowance
              ? `<span class="muted">Fits the ${fmt(s.sheet.width)} cm without using the ${fmt(allowance)} cm allowance.</span>`
              : ''
        }</figcaption>
    </figure>`;
  };
  return [...groups.values()]
    .map((group) => {
      const { sheet } = group[0].s;
      return `<h2 class="sheet-heading">${esc(sheet.id)}
        <span class="muted">${fmt(sheet.width)} &times; ${fmt(sheet.length)} &middot;
          ${group.length} sheet${group.length === 1 ? '' : 's'}</span></h2>
        ${group.map(drawing).join('')}`;
    })
    .join('');
}

/**
 * How much of what you buy ends up on the roof.
 *
 * The one number that says whether a plan is good without knowing the roof: two
 * plans a pound apart are the same plan, and the one that wastes less sheet is
 * the one to cut. Said in the order list, on every row of the results, and in
 * the sidebar, all from here so they cannot disagree.
 */
export function usage(result) {
  const total = (result.sheets || []).reduce((s, x) => s + x.sheet.width * x.sheet.length, 0);
  const used = (result.sheets || []).reduce((s, x) => s + x.placements.reduce((a, p) => a + p.block.area, 0), 0);
  return { used, total, ratio: total ? used / total : 0 };
}

export function renderOrder(result, units) {
  if (!result.sheets.length) return '<p class="muted">No sheets needed yet.</p>';
  const counts = new Map();
  for (const s of result.sheets) {
    const entry = counts.get(s.sheet.id) || { sheet: s.sheet, qty: 0 };
    entry.qty += 1;
    counts.set(s.sheet.id, entry);
  }
  const priced = [...counts.values()].every((c) => c.sheet.price != null);
  const rows = [...counts.values()]
    .map(
      (c) => `<tr><td>${esc(c.sheet.id)}</td><td>${c.sheet.width} &times; ${c.sheet.length}</td>
        <td class="num">${c.qty}</td>
        <td class="num">${c.sheet.price != null ? '&pound;' + (c.sheet.price * c.qty).toFixed(2) : '&mdash;'}</td></tr>`
    )
    .join('');
  const total = [...counts.values()].reduce((s, c) => s + (c.sheet.price || 0) * c.qty, 0);
  const { used: usedArea, total: sheetArea } = usage(result);
  return `<table class="order">
    <thead><tr><th>Sheet</th><th>Size (${esc(units)})</th><th class="num">Qty</th><th class="num">Cost</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2">${result.sheets.length} sheets &middot; ${sqm(usedArea, units)} of ${sqm(sheetArea, units)} m&sup2; used
      (${Math.round((usedArea / sheetArea) * 100)}%)</td>
      <td class="num">${result.sheets.length}</td>
      <td class="num">${priced ? '&pound;' + total.toFixed(2) : '&mdash;'}</td></tr></tfoot>
  </table>${priced ? '' : '<p class="muted">Add <code>price</code> to each sheet in the JSON to cost the order — until then the optimiser minimises sheet area instead.</p>'}`;
}

const ROOF_MAX = 880;

/**
 * The roof from above: every side turned onto its own eave, pieces in numbered
 * order along it. The dashed rectangle is what the four eaves enclose, so a
 * side that overshoots it, or two opposite sides that do not reach each other,
 * shows up against a straight line.
 */
/**
 * North is up in this view: the layout puts the south eave at y=0 and the north
 * eave at y=depth, and the drawing flips y, so the needle needs no rotation.
 */
const COMPASS = `<svg class="compass" viewBox="0 0 64 64" width="64" height="64" aria-label="North is up">
  <circle cx="32" cy="32" r="21" fill="none" stroke="currentColor" stroke-width="1"/>
  <polygon points="32,9 27,32 37,32" fill="currentColor"/>
  <polygon points="32,55 27,32 37,32" fill="none" stroke="currentColor" stroke-width="1"/>
  <text x="32" y="7" text-anchor="middle" dominant-baseline="auto">N</text>
  <text x="32" y="63" text-anchor="middle">S</text>
  <text x="61" y="36" text-anchor="end">E</text>
  <text x="3" y="36" text-anchor="start">W</text>
</svg>`;

/**
 * The sides, as checkboxes. Hiding a side takes it out of the drawing only —
 * the layout is still made from every piece, so what is left does not move.
 */
function sideToggles(hidden) {
  return `<div class="roof-tools">${SIDE_ORDER.map(
    (side) => `<label><input type="checkbox" class="side-toggle" data-side="${esc(side)}"${
      hidden.has(side) ? '' : ' checked'
    }><span class="swatch" style="background:${SIDE_COLOURS[side]}"></span>${esc(side)}</label>`
  ).join('')}</div>`;
}

/**
 * The flag on a piece, under its number: red once it is set, grey while it is
 * not.
 *
 * Its own hit target, sitting on top of the piece, which opens the editor — so
 * a thumb that misses by a few millimetres should do nothing rather than the
 * wrong thing. They are drawn in one layer after every piece: pieces on a roof
 * sit close enough that a flag drawn inside its own piece ends up under the
 * next piece along, and unhittable.
 */
/**
 * Each flag is nudged out towards its own eave. Where two sides meet, the last
 * piece of one and the first of the next overlap almost exactly — at the
 * corners their centres came within 1.3px, which is one flag sitting on top of
 * another and swallowing its taps. Their eaves are at right angles, so pushing
 * each towards its own pulls them apart.
 */
const NUDGE = 20;
const AWAY = {
  west: { x: -NUDGE, y: 0 },
  east: { x: NUDGE, y: 0 },
  south: { x: 0, y: NUDGE },
  north: { x: 0, y: -NUDGE },
};

function flagMark(id, on, x, y) {
  return `<g class="roof-flag${on ? ' on' : ''}" data-flag="${esc(id)}" tabindex="0" role="button"
             aria-pressed="${on}" aria-label="Flag piece ${esc(id)}"
             transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
    <circle class="hit" r="11"/>
    <path d="M -4.5 -7 L -4.5 7 M -4.5 -6.5 L 6 -3 L -4.5 0.5 Z"/>
  </g>`;
}

export function renderRoof(pieces, units, hidden = new Set(), flagged = new Set()) {
  const { placements, eaves, width, depth, extent } = layoutRoof(pieces);
  if (!placements.length) return '<p class="muted">Nothing to lay out yet — fill in some edge lengths.</p>';

  const scale = Math.min(ROOF_MAX / extent.width, 620 / extent.height);
  const w = extent.width * scale;
  const h = extent.height * scale;
  // Everything is drawn shifted off the bounding box, so a piece that overhangs
  // the footprint stays on the page.
  const dx = -extent.minX;
  const dy = -extent.minY;

  const shapes = placements
    .filter(({ side }) => !hidden.has(side))
    .map(({ piece, side, vertices }) => {
      const colour = SIDE_COLOURS[side] || '#888';
      const c = centroid(vertices);
      // The whole group is the hit target, so the number is as clickable as the
      // shape under it.
      // The turn onto the eave preserves vertex order, so edges[i] is still the
      // edge leaving vertex i and the lengths land on the right sides.
      return `<g class="roof-piece" data-piece="${esc(piece.id)}" tabindex="0" role="button"
                 aria-label="Edit piece ${esc(piece.id)}">
        <polygon points="${points(vertices, scale, h, dx, dy)}" fill="${colour}33" stroke="${colour}" stroke-width="1"/>
        ${rightAngles(vertices, scale, h, dx, dy)}
        ${edgeLabels(vertices, edgeValues(piece, false), scale, h, dx, dy)}
        <text class="piece-num" x="${((c.x + dx) * scale).toFixed(1)}" y="${(h - (c.y + dy) * scale).toFixed(1)}">${esc(piece.id)}</text>
      </g>`;
    })
    .join('');

  const flags = placements
    .filter(({ side }) => !hidden.has(side))
    .map(({ piece, side, vertices }) => {
      const c = centroid(vertices);
      const away = AWAY[side] || { x: 0, y: NUDGE };
      return flagMark(
        piece.id,
        flagged.has(String(piece.id)),
        (c.x + dx) * scale + away.x,
        h - (c.y + dy) * scale + away.y
      );
    })
    .join('');

  // Anything with no shape, or a side that is not one of the four, is simply not
  // in the picture — worth saying, or the roof looks complete when it is not.
  const missing = pieces.filter((p) => !placements.some((pl) => pl.piece === p));
  const totals = SIDE_ORDER.map(
    (side) => `<li class="${hidden.has(side) ? 'off' : ''}"><span class="swatch" style="background:${SIDE_COLOURS[side]}"></span>${side} eave
      <b>${fmt(eaves[side])} ${esc(units)}</b></li>`
  ).join('');

  return `<figure class="roof">
    ${COMPASS}
    ${sideToggles(hidden)}
    <svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}">
      <rect class="footprint" x="${(dx * scale).toFixed(1)}" y="${(h - (depth + dy) * scale).toFixed(1)}"
            width="${(width * scale).toFixed(1)}" height="${(depth * scale).toFixed(1)}"/>
      ${shapes}
      <g class="flags">${flags}</g>
    </svg>
    <figcaption>
      <ul class="eaves">${totals}</ul>
      <span class="muted">Looking down on the roof. Each side is turned onto its own eave and its pieces
        laid in numbered order, at the length of their own bases — a gap or an overlap is the
        measurements disagreeing, not the drawing.${
          missing.length
            ? ` Not shown: ${missing.map((p) => esc(p.id)).join(', ')} — no shape to draw yet.`
            : ''
        }</span>
    </figcaption>
  </figure>`;
}

/**
 * The designs kept in this browser.
 *
 * One is always open, and it is marked; the rest are a tap away. A design is
 * the whole roof — its measurements, its flags, how each piece lies — so
 * "Save as" is how you try something without losing what you had.
 */
export function renderDesigns(designs, currentId, units) {
  const ids = Object.keys(designs);
  if (!ids.length) {
    return `<div class="designs">
      <p class="muted">No designs. There is nothing to draw until there is one.</p>
      <button type="button" id="design-new" class="primary">Start from the roof we ship</button>
    </div>`;
  }

  const rows = ids
    .map((id) => {
      const design = designs[id];
      const pieces = Object.keys(design.cuts || {}).length;
      const flags = (design.flags || []).length;
      // Open is the everyday action and Edit the rare one, so Open leads and
      // carries the weight. Which design you are working on is said on the row
      // itself rather than only inside a dialog nobody has opened — and that
      // row has nothing to open, so it does not offer it.
      // With one design there is nothing it could be current against, so the
      // tag says nothing and is left off.
      const current = id === currentId;
      const marked = current && ids.length > 1;
      return `<li class="design-row${marked ? ' current' : ''}" data-design="${esc(id)}">
        <span class="name">${esc(design.name)}${marked ? ' <span class="tag">current</span>' : ''}</span>
        <span class="muted">${pieces} ${pieces === 1 ? 'piece' : 'pieces'}${flags ? ` &middot; ${flags} flagged` : ''}</span>
        <span class="design-actions">
          ${current ? '' : `<button type="button" class="design-open primary" data-design="${esc(id)}">Open</button>`}
          <button type="button" class="design-edit" data-design="${esc(id)}">Edit</button>
        </span>
      </li>`;
    })
    .join('');

  return `<div class="designs">
    <p class="hint">Every design is a whole roof of its own. Save as, on the toolbar, makes a copy of
      the one you are working on so you can try something without losing it. All in this browser —
      Export is how one leaves.</p>
    <ul class="design-list">${rows}</ul>
  </div>`;
}

/**
 * Which sizes the plan may use.
 *
 * Folded away, because the answer is usually "all of them" and fifty-three
 * boxes is not something to look at while reading a plan. The count in the
 * summary is what you need at a glance; open it when you want to price the job
 * out of one width, or without the size that is on back-order.
 */
export function renderSheetPicker(sheets, picked, units) {
  const widths = new Map();
  for (const sheet of [...sheets].sort((a, b) => a.width - b.width || a.length - b.length)) {
    if (!widths.has(sheet.width)) widths.set(sheet.width, []);
    widths.get(sheet.width).push(sheet);
  }

  const groups = [...widths]
    .map(([width, list]) => {
      const on = list.filter((s) => picked.has(s.id)).length;
      return `<div class="pick-group">
        <label class="pick-width">
          <input type="checkbox" class="pick-all" data-width="${width}"${on === list.length ? ' checked' : ''}
                 ${on && on < list.length ? 'data-some="1"' : ''}>
          <b>${fmt(width)} ${esc(units)}</b>
        </label>
        <div class="pick-lengths">${list
          .map(
            (sheet) => `<label class="pick" title="${esc(sheet.label || sheet.id)} — &pound;${sheet.price.toFixed(2)}">
              <input type="checkbox" class="pick-one" data-sheet="${esc(sheet.id)}"${picked.has(sheet.id) ? ' checked' : ''}>
              <span>${fmt(sheet.length)}</span>
            </label>`
          )
          .join('')}</div>
      </div>`;
    })
    .join('');

  return `<details class="sheet-picker"${picked.size === sheets.length ? '' : ' open'}>
    <summary>Sizes in the plan <span class="muted">${picked.size} of ${sheets.length}</span></summary>
    <div class="pick-groups">${groups}</div>
    <div class="pick-actions">
      <button type="button" id="pick-all">All</button>
      <button type="button" id="pick-none">None</button>
    </div>
  </details>`;
}

/**
 * The catalogue, grouped by width.
 *
 * Fifty-three sizes in one list is a wall; seven widths with their lengths
 * under them is the way the shop sells them and the way you think about them —
 * the width is the piece's width, the length is what you are choosing.
 */
export function renderSheets(sheets, units) {
  const rows = (list) =>
    list
      .map(
        (sheet) => `<li>
        <button type="button" class="sheet-row" data-sheet="${esc(sheet.id)}">
          <span class="name">${esc(sheet.label || sheet.id)}</span>
          <span class="size">${fmt(sheet.width)} &times; ${fmt(sheet.length)} ${esc(units)}</span>
          <span class="price">&pound;${sheet.price.toFixed(2)}</span>
        </button>
        ${sheet.url ? `<a class="sheet-link" href="${esc(sheet.url)}" target="_blank" rel="noopener" title="Open the shop page">&#8599;</a>` : ''}
      </li>`
      )
      .join('');

  const widths = new Map();
  for (const sheet of [...sheets].sort((a, b) => a.width - b.width || a.length - b.length)) {
    if (!widths.has(sheet.width)) widths.set(sheet.width, []);
    widths.get(sheet.width).push(sheet);
  }

  return `<div class="sheet-manager">
    <div class="sheet-tools">
      <button type="button" id="sheet-new" class="primary">Add a size</button>
    </div>
    <p class="hint">The sizes you can buy. Tap one to change its price or its name, or add a size the
      shop has started stocking. Kept in this browser, not in the file.</p>
    ${
      widths.size
        ? [...widths]
            .map(
              ([width, list]) => `<section class="sheet-group">
        <h2>${fmt(width)} ${esc(units)} wide <span class="muted">${list.length} ${list.length === 1 ? 'size' : 'sizes'}</span></h2>
        <ul class="sheet-list">${rows(list)}</ul>
      </section>`
            )
            .join('')
        : '<p class="muted">No sizes yet.</p>'
    }
  </div>`;
}

const EDIT_SIZE = 320;

/**
 * The drawing and the verdict, from the working copy of the lengths.
 *
 * Kept apart from the boxes below it because this is what redraws on every
 * keystroke — replacing the boxes too would take the caret with them.
 */
export function renderPiecePreview(edges, side, units, how) {
  const built = buildRelaxed(edges);
  const shape = built.vertices || (fitPolygon(edges) || {}).vertices;
  const colour = SIDE_COLOURS[side] || '#888';

  if (!shape) {
    return `<figure class="piece empty"><p class="muted">No shape from these lengths yet.</p></figure>
      <p class="hint bad">Nothing closes, and nothing near it does either.</p>`;
  }

  // The guide is worked out on the piece as it was measured, then carried
  // through the same turn as the shape: it is a fact about the measurements,
  // not about which way up the piece is being looked at.
  const plain = normalise(shape);
  const laid = isPlain(how) ? null : orient(plain, how);
  const v = laid ? laid.vertices : plain;
  const flat = widthGuide(plain, edges);
  const guide = flat && laid ? { ...flat, from: laid.map(flat.from), to: laid.map(flat.to) } : flat;
  const bb = bbox(guide ? [...v, guide.to] : v);
  const scale = Math.min(EDIT_SIZE / (bb.width || 1), EDIT_SIZE / (bb.height || 1));
  const w = bb.width * scale + PAD * 2;
  const h = bb.height * scale + PAD * 2;
  const note = built.vertices
    ? `${MODEL_NOTE[built.model] ? `${MODEL_NOTE[built.model]} &middot; ` : ''}${sqm(area(built.vertices), units)} m&sup2;`
    : 'These lengths do not close — this is the nearest shape that does.';

  return `<figure class="piece ${built.vertices ? 'closes' : 'fitted'}">
      <svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}">
        <g transform="translate(${PAD},${PAD})">
          <polygon points="${points(v, scale, bb.height * scale)}" fill="${colour}22" stroke="${colour}" stroke-width="1.5"/>
          ${guideLine(guide, scale, bb.height * scale)}
          ${rightAngles(v, scale, bb.height * scale)}
          ${edgeLabels(v, edges.map((value) => ({ value: Number(value), changed: false })), scale, bb.height * scale)}
        </g>
      </svg>
    </figure>
    <p class="hint ${built.vertices ? '' : 'bad'}">${note}</p>`;
}

/**
 * Turning the piece over, or round. The lengths never move — see `orient` — so
 * the shape that comes back is the shape that went in, whichever model drew it.
 */
const TRANSFORM_BUTTONS = [
  ['flipH', '&#8646;', 'Flip left to right'],
  ['flipV', '&#8645;', 'Flip top to bottom'],
  ['turn', '&#8635;', 'Quarter turn clockwise'],
];

/** One piece, big, with its lengths both on the drawing and in boxes underneath. */
export function renderPieceEditor(piece, edges, units, how) {
  const names = EDGE_NAMES[edges.length] || edges.map((_, i) => `side ${i + 1}`);
  const boxes = edges
    .map(
      (value, i) => `<div class="edge">${stepper(-1)}<label><span>${names[i]}</span>
        <input class="editor-edge" type="number" step="1" min="0" inputmode="decimal"
               pattern="[0-9]*[.,]?[0-9]*" enterkeyhint="done" autocomplete="off"
               autocorrect="off" autocapitalize="off" spellcheck="false"
               data-edge="${i}" value="${esc(Number(value))}"></label>${stepper(1)}</div>`
    )
    .join('');

  const turns = TRANSFORM_BUTTONS.map(
    ([name, glyph, title]) => `<button type="button" class="turn" data-transform="${name}" title="${title}"
      aria-label="${title}">${glyph}</button>`
  ).join('');

  return `<h2>Piece ${esc(piece.id)} <span class="muted">${esc(piece.side)}</span></h2>
    <div id="editor-preview">${renderPiecePreview(edges, piece.side, units, how)}</div>
    <div class="turns">${turns}</div>
    <div class="edges">${boxes}</div>`;
}
