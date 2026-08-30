/**
 * The slow nester: bottom-left-fill on the pieces themselves, searched.
 *
 * [nest.js](nest.js) merges pieces into rectangular blocks and shelf-packs the
 * blocks. That is fast enough to run on every keystroke, and it pays for the
 * speed twice over: merging only ever pairs two pieces, and a shelf wastes the
 * whole gap above its shortest block.
 *
 * This one places each piece into the notch the cut before it left, and searches
 * over the order and the half-turns rather than trying three fixed sorts. On the
 * roof it was written for it finds 7 sheets where the fast nester finds 9. It
 * takes tens of seconds to do it, which is why it runs from a button and in
 * slices — `createSearch` hands back something the page can drive a few rounds
 * at a time, between paints.
 *
 * Every piece is convex, so `spanAt` gives the exact horizontal extent at any
 * height, two pieces at a fixed vertical offset overlap over exactly one
 * interval of horizontal offsets, and the leftmost lawful position is a sweep
 * over those intervals rather than a search for one.
 */

import { area, bbox, normalise, pt, rotate180, spanAt, translate } from './geometry.js';

const EPS = 1e-9;

/** Heights at which two pieces could touch: their own corners, and the ends. */
function testHeights(a, b, dy, lo, hi) {
  const ys = new Set([lo, hi]);
  for (const v of a) if (v.y > lo + EPS && v.y < hi - EPS) ys.add(v.y);
  for (const v of b) if (v.y + dy > lo + EPS && v.y + dy < hi - EPS) ys.add(v.y + dy);
  return ys;
}

/**
 * The horizontal offsets at which b, raised by dy, would foul a — null if the
 * two never share a height, so b may sit anywhere.
 */
function forbidden(a, b, kerf, dy) {
  const ba = bbox(a);
  const bb = bbox(b);
  const lo = Math.max(ba.minY, bb.minY + dy);
  const hi = Math.min(ba.maxY, bb.maxY + dy);
  if (hi <= lo + EPS) return null;

  let right = -Infinity;
  let left = Infinity;
  for (const y of testHeights(a, b, dy, lo, hi)) {
    const sa = spanAt(a, y);
    const sb = spanAt(b, y - dy);
    if (!sa || !sb) continue;
    right = Math.max(right, sa.max - sb.min + kerf);
    left = Math.min(left, sa.min - sb.max - kerf);
  }
  if (right === -Infinity) return null;
  return { left, right };
}

/** Leftmost x from the edge of the sheet that clears everything already down. */
function leftmost(placed, shape, kerf, dy, limitX, shapeW) {
  const bars = [];
  for (const p of placed) {
    const bar = forbidden(p.vertices, shape, kerf, dy);
    if (bar) bars.push(bar);
  }
  let x = 0;
  // Each shove past a piece can only push right, so the sweep settles in at
  // most as many passes as there are pieces to clear.
  for (let guard = 0; guard <= bars.length; guard++) {
    let moved = false;
    for (const bar of bars) {
      if (x > bar.left + EPS && x < bar.right - EPS) {
        x = bar.right;
        moved = true;
      }
    }
    if (!moved) return x + shapeW <= limitX + EPS ? x : null;
  }
  return null;
}

/**
 * The lowest resting place for a shape, and the leftmost of those.
 *
 * A piece can only come to rest with one of its corners against one of theirs,
 * so those are the heights worth trying. Rounded to a hundredth of a
 * millimetre: two corners a hair apart are the same resting place, and each
 * distinct one costs a full sweep of the sheet.
 */
function fit(placed, shape, kerf, limitX, limitY) {
  const box = bbox(shape);
  const heights = new Set([0]);
  for (const p of placed) for (const v of p.vertices) for (const s of shape) heights.add(Math.round((v.y - s.y) * 1e4) / 1e4);

  let best = null;
  for (const dy of [...heights].sort((a, b) => a - b)) {
    if (dy < -EPS || dy + box.height > limitY + EPS) continue;
    if (best) break;
    const x = leftmost(placed, shape, kerf, dy, limitX, box.width);
    if (x !== null) best = { x, dy };
  }
  return best;
}

const sheetCost = (s) => (s.price != null ? s.price : s.width * s.length);

/** One placed piece, dressed as the one-piece block the drawing expects. */
const asBlock = (piece, vertices, turned) => ({
  block: { placements: [{ piece, vertices, orientation: turned ? 1 : 0 }], area: area(vertices) },
  x: 0,
  y: 0,
});

/** Fill one sheet from the queue, taking whatever fits in the order given. */
function fillSheet(queue, sheet, kerf, margin) {
  const limitX = sheet.width - 2 * margin;
  const limitY = sheet.length - 2 * margin;
  const placed = [];
  const taken = new Set();
  for (const item of queue) {
    const spot = fit(placed, item.shape, kerf, limitX, limitY);
    if (!spot) continue;
    placed.push({ item, vertices: translate(item.shape, spot.x + margin, spot.dy + margin) });
    taken.add(item);
  }
  return { sheet, placed, taken };
}

/** One queue, sheet after sheet, each the size that swallows most area per pound. */
function packQueue(queue, sheetTypes, kerf, margin) {
  let remaining = queue;
  const sheets = [];
  let cost = 0;
  let guard = 0;

  while (remaining.length && guard++ < 200) {
    let best = null;
    for (const sheet of sheetTypes) {
      const trial = fillSheet(remaining, sheet, kerf, margin);
      if (!trial.placed.length) continue;
      const absorbed = trial.placed.reduce((s, p) => s + area(p.vertices), 0);
      const value = absorbed / sheetCost(sheet);
      if (!best || value > best.value) best = { value, trial };
    }
    if (!best) return null;
    sheets.push({
      sheet: best.trial.sheet,
      placements: best.trial.placed.map((p) => asBlock(p.item.piece, p.vertices, p.item.turned)),
    });
    cost += sheetCost(best.trial.sheet);
    remaining = remaining.filter((i) => !best.trial.taken.has(i));
  }
  return remaining.length ? null : { sheets, cost };
}

/** The queue for one order and one set of half-turns. */
function entries(shapes, order, turns) {
  return order.map((i) => ({ piece: shapes[i].piece, turned: turns[i], shape: turns[i] ? shapes[i].turned : shapes[i].flat }));
}

/** Small deterministic PRNG, so the same roof searches the same way twice. */
const mulberry = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * The same piece with a centimetre off its width and its height.
 *
 * A non-uniform scale, so the angles move by a fraction of a degree on a piece
 * two metres long. That is fine for the question it answers — would a little
 * slack in the cutting buy a sheet — and wrong for cutting from, which is why
 * the page will not let a trial plan be ordered.
 */
function shrinkShape(vertices, by) {
  const box = bbox(vertices);
  if (box.width <= by || box.height <= by) return vertices;
  const sx = (box.width - by) / box.width;
  const sy = (box.height - by) / box.height;
  return vertices.map((v) => pt(v.x * sx, v.y * sy));
}

/**
 * The edge lengths of a polygon, in the order the measurements are given.
 *
 * Vertex i is where edge i starts, all the way through — `buildPolygon` builds
 * them that way and neither shifting nor a half turn disturbs it — so the walk
 * round the shape is the edge list.
 */
function edgesOf(vertices) {
  return vertices.map((v, i) => {
    const next = vertices[(i + 1) % vertices.length];
    return Math.round(Math.hypot(next.x - v.x, next.y - v.y) * 10) / 10;
  });
}

/** "690x2500mm x3, 1050x3000mm x4" — what a plan actually asks you to buy. */
function mixOf(sheets) {
  const counts = new Map();
  for (const s of sheets) counts.set(s.sheet.id, (counts.get(s.sheet.id) || 0) + 1);
  // Sorted, so two plans that ask for the same sheets in a different order are
  // recognised as the one plan they are.
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, n]) => `${id} \u00d7${n}`).join(', ');
}

const TOP = 10;

/**
 * A search you can run a few rounds at a time.
 *
 * `step(n)` runs n rounds and says whether anything improved; `best()` is the
 * plan as it stands, in the shape `plan()` returns so the drawing does not care
 * which nester made it. Stopping early is always safe — the first plan is
 * complete, and every one after it is only cheaper.
 */
export function createSearch(pieces, config, opts = {}) {
  const shrink = Number(opts.shrink) || 0;
  const kerf = Number(config.kerf) || 0;
  const margin = Number(config.margin) || 0;
  const sheetTypes = (config.sheets || []).filter((s) => s.width > 0 && s.length > 0);
  const limit = {
    width: Math.max(0, ...sheetTypes.map((s) => s.width)) - 2 * margin,
    length: Math.max(0, ...sheetTypes.map((s) => s.length)) - 2 * margin,
  };

  // A piece bigger than every sheet is set aside rather than left to make every
  // plan a failing one — the same bargain nest.js strikes.
  const shapes = [];
  const tooBig = [];
  for (const piece of pieces) {
    const flat = shrink ? shrinkShape(normalise(piece.vertices), shrink) : normalise(piece.vertices);
    // A trial piece is drawn smaller, so it must be labelled smaller too — the
    // lengths on it are the shape's own, not the ones off the tape. `fitted`
    // goes with them: it marks how far a length moved to close, and these
    // lengths have not been through that.
    const shown = shrink ? { ...piece, edges: edgesOf(flat), fitted: null } : piece;
    const box = bbox(flat);
    if (box.width > limit.width || box.height > limit.length) {
      tooBig.push(asBlock(shown, flat, false).block);
      continue;
    }
    shapes.push({ piece: shown, flat, turned: rotate180(flat) });
  }

  const rand = mulberry(opts.seed ?? 1);
  const dress = (result) =>
    result
      ? { ...result, leftovers: tooBig, blocks: [] }
      : { sheets: [], leftovers: tooBig.concat(shapes.map((s) => asBlock(s.piece, s.flat, false).block)), cost: 0, blocks: [] };

  // Tallest first is the usual opening move for bottom-left-fill, and it is what
  // the search starts from rather than a shuffle.
  let order = shapes.map((_, i) => i).sort((a, b) => bbox(shapes[b].flat).height - bbox(shapes[a].flat).height);
  let turns = shapes.map(() => false);
  let round = 0;

  /**
   * The ten cheapest distinct plans seen, not the ten steps down to the best.
   *
   * Every plan the search tries is offered here, so what comes out is a choice
   * between layouts rather than a history of one. Two plans of the same price
   * that ask you to buy different sheets are different answers, so the sheet
   * mix is part of what makes one distinct.
   */
  const top = [];
  const record = (result, ord, trn) => {
    if (!result) return result;
    const mix = mixOf(result.sheets);
    const key = `${result.cost.toFixed(2)}|${mix}`;
    if (top.some((t) => t.key === key)) return result;
    top.push({ key, cost: result.cost, sheets: result.sheets.length, mix, order: ord.slice(), turns: trn.slice() });
    top.sort((a, b) => a.cost - b.cost || a.sheets - b.sheets);
    top.length = Math.min(top.length, TOP);
    return result;
  };

  const pack = (ord, trn) => record(packQueue(entries(shapes, ord, trn), sheetTypes, kerf, margin), ord, trn);
  let best = sheetTypes.length ? pack(order, turns) : null;

  return {
    get round() {
      return round;
    },
    get cost() {
      return best ? best.cost : Infinity;
    },
    get sheets() {
      return best ? best.sheets.length : 0;
    },
    best: () => dress(best),
    /** The ten on offer, cheapest first. */
    plans: () => top.map((t) => ({ key: t.key, cost: t.cost, sheets: t.sheets, mix: t.mix })),
    /** One of them, packed again — the search keeps the recipe, not the plan. */
    rebuild(key) {
      const found = top.find((t) => t.key === key);
      return found ? dress(packQueue(entries(shapes, found.order, found.turns), sheetTypes, kerf, margin)) : null;
    },
    /** One move away each time: a swap in the order, or a piece turned over. */
    step(rounds = 1) {
      let improved = false;
      for (let n = 0; n < rounds && shapes.length; n++) {
        round++;
        const nextOrder = order.slice();
        const nextTurns = turns.slice();
        if (rand() < 0.7) {
          const i = Math.floor(rand() * nextOrder.length);
          const j = Math.floor(rand() * nextOrder.length);
          [nextOrder[i], nextOrder[j]] = [nextOrder[j], nextOrder[i]];
        } else {
          const i = Math.floor(rand() * nextTurns.length);
          nextTurns[i] = !nextTurns[i];
        }
        const trial = pack(nextOrder, nextTurns);
        if (trial && (!best || trial.cost < best.cost - EPS)) {
          best = trial;
          order = nextOrder;
          turns = nextTurns;
          improved = true;
        }
      }
      return improved;
    },
  };
}
