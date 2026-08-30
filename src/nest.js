/**
 * Pair complementary pieces into rectangular blocks, then shelf-pack the
 * blocks into sheets.
 *
 * The flutes run the length of the sheet and must run down the slope, so a
 * piece may only be placed as-is or turned a half turn. That rules out the
 * quarter turns an ordinary nester relies on, which is why pairing does the
 * heavy lifting here: a trapezoid and a half-turned trapezoid or triangle
 * collapse into something close to a rectangle, and rectangles pack well.
 */

import { area, bbox, normalise, pt, spanAt, translate } from './geometry.js';

const SAMPLES = 24;

/**
 * Smallest horizontal offset that lets b sit to the right of a without touching,
 * at vertical offset dy. Zero if one is entirely above the other: they can share
 * the same column, which is what lets a small triangle drop into the space a
 * diagonal cut leaves behind.
 *
 * Both spans are piecewise linear in y, so their difference peaks at a corner of
 * one or the other. Every vertex height is tested, which makes this exact rather
 * than a sampling of it.
 */
function clearance(a, b, kerf, dy) {
  const ba = bbox(a);
  const bb = bbox(b);
  const lo = Math.max(ba.minY, bb.minY + dy);
  const hi = Math.min(ba.maxY, bb.maxY + dy);
  if (hi <= lo) return 0;

  const ys = new Set([lo, hi]);
  for (let i = 1; i < SAMPLES; i++) ys.add(lo + ((hi - lo) * i) / SAMPLES);
  for (const v of a) if (v.y > lo && v.y < hi) ys.add(v.y);
  for (const v of b) if (v.y + dy > lo && v.y + dy < hi) ys.add(v.y + dy);

  let offset = 0;
  for (const y of ys) {
    const sa = spanAt(a, y);
    const sb = spanAt(b, y - dy);
    if (!sa || !sb) continue;
    offset = Math.max(offset, sa.max - sb.min + kerf);
  }
  return offset;
}

/** The whole of b clear of the whole of a. */
function groupClearance(as, bs, kerf, dy) {
  let offset = 0;
  for (const a of as) {
    for (const b of bs) offset = Math.max(offset, clearance(a.vertices, b.vertices, kerf, dy));
  }
  return offset;
}

function blockFromPlacements(placements) {
  const all = placements.flatMap((p) => p.vertices);
  const bb = bbox(all);
  return {
    width: bb.width,
    height: bb.height,
    area: placements.reduce((sum, p) => sum + area(p.vertices), 0),
    placements,
  };
}

const boxArea = (block) => block.width * block.height;

function rebase(placements) {
  const bb = bbox(placements.flatMap((p) => p.vertices));
  return placements.map((p) => ({ ...p, vertices: translate(p.vertices, -bb.minX, -bb.minY) }));
}

function singleBlock(piece) {
  return blockFromPlacements([{ piece, orientation: 0, vertices: normalise(piece.vertices) }]);
}

/** The whole block given a half turn — every piece in it turns with it. */
function turnBlock(block) {
  const bb = bbox(block.placements.flatMap((p) => p.vertices));
  return blockFromPlacements(
    rebase(
      block.placements.map((p) => ({
        piece: p.piece,
        orientation: p.orientation ? 0 : 180,
        vertices: p.vertices.map((v) => pt(bb.minX + bb.maxX - v.x, bb.minY + bb.maxY - v.y)),
      }))
    )
  );
}

/**
 * Heights worth trying when sliding b against a: bottom-aligned, top-aligned,
 * and every height at which a corner of one meets a corner of the other. A
 * triangle only drops into a notch when its point lines up with the corner the
 * notch starts at, so those alignments are where the good fits are.
 */
function offsetCandidates(a, b) {
  const av = a.placements.flatMap((p) => p.vertices);
  const bv = b.placements.flatMap((p) => p.vertices);
  const ys = new Set([0, a.height - b.height]);
  for (const v of av) {
    for (const w of bv) {
      const dy = v.y - w.y;
      if (dy > -b.height && dy < a.height) ys.add(Math.round(dy * 100) / 100);
    }
  }
  return [...ys];
}

/** The tightest bounding box the two blocks make together, or null if none fits. */
function tryMerge(a, b, kerf, limit) {
  let best = null;
  for (const candidate of [b, turnBlock(b)]) {
    for (const dy of offsetCandidates(a, candidate)) {
      const dx = groupClearance(a.placements, candidate.placements, kerf, dy);
      const merged = blockFromPlacements(
        rebase([
          ...a.placements,
          ...candidate.placements.map((p) => ({ ...p, vertices: translate(p.vertices, dx, dy) })),
        ])
      );
      if (merged.width > limit.width || merged.height > limit.length) continue;
      if (!best || boxArea(merged) < boxArea(best)) best = merged;
    }
  }
  return best;
}

/**
 * Greedy best-first merging. Every piece starts as a block of its own and the
 * pair that wastes least is merged, over and over, until no merge saves
 * anything — so a pair can take a third piece, and a fourth, rather than the
 * two-piece pairings this used to stop at.
 *
 * A merge that no sheet can hold is not offered: it would take every piece in it
 * out of the plan at once.
 */
export function buildBlocks(pieces, kerf, limit = { width: Infinity, length: Infinity }) {
  let counter = 0;
  const tag = (block) => Object.assign(block, { key: counter++ });
  let blocks = pieces.map((piece) => tag(singleBlock(piece)));

  // Merging is not symmetric — b slides against a — so both ways round are
  // tried, and both are worth keeping once computed: only the pairs involving
  // the block just merged are ever new.
  const seen = new Map();
  const evaluate = (a, b) => {
    const key = `${a.key}:${b.key}`;
    if (!seen.has(key)) {
      const merged = tryMerge(a, b, kerf, limit);
      seen.set(key, { merged, saved: merged ? boxArea(a) + boxArea(b) - boxArea(merged) : 0 });
    }
    return seen.get(key);
  };

  for (;;) {
    let best = null;
    for (let i = 0; i < blocks.length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i === j) continue;
        const { merged, saved } = evaluate(blocks[i], blocks[j]);
        if (merged && saved > (best ? best.saved : 1e-6)) best = { i, j, merged, saved };
      }
    }
    if (!best) return blocks;
    blocks = blocks.filter((_, k) => k !== best.i && k !== best.j).concat(tag(best.merged));
  }
}

/**
 * Shelf packing, first fit by decreasing height. Sheet length is the flute
 * axis, so a block's height is measured against the sheet's length.
 */
function packInto(blocks, sheet, kerf, margin, allowance = 0) {
  // Across the sheet only. A run of pieces measured off a roof adds up to a
  // little more than the roof is, and the saw cut takes some of it back; a
  // centimetre of that is under the tolerance of the job. Along the sheet the
  // same slack would buy nothing and cost a whole extra sheet, so it is not
  // given there.
  const usableW = sheet.width - 2 * margin + allowance;
  const usableL = sheet.length - 2 * margin;
  const sheets = [];
  const leftovers = [];

  const open = () => {
    const s = { sheet, shelves: [], usedY: 0, placements: [] };
    sheets.push(s);
    return s;
  };

  const tryPlace = (s, block) => {
    for (const shelf of s.shelves) {
      if (block.height <= shelf.height && shelf.cursorX + block.width <= usableW) {
        s.placements.push({ block, x: margin + shelf.cursorX, y: margin + shelf.y });
        shelf.cursorX += block.width + kerf;
        return true;
      }
    }
    const y = s.shelves.length === 0 ? 0 : s.usedY + kerf;
    if (y + block.height <= usableL && block.width <= usableW) {
      s.shelves.push({ y, height: block.height, cursorX: block.width + kerf });
      s.usedY = y + block.height;
      s.placements.push({ block, x: margin, y: margin + y });
      return true;
    }
    return false;
  };

  for (const block of blocks) {
    if (block.width > usableW || block.height > usableL) {
      leftovers.push(block);
      continue;
    }
    if (sheets.some((s) => tryPlace(s, block))) continue;
    tryPlace(open(), block);
  }
  return { sheets, leftovers };
}

const sheetCost = (sheet) => (sheet.price != null ? sheet.price : sheet.width * sheet.length);

/**
 * Shelf packing is sensitive to the order blocks arrive in, and which order wins
 * depends on the shapes, so each plan is tried every way round and the cheapest
 * kept. Three orderings cost nothing next to the merging above.
 */
const ORDERINGS = [
  (a, b) => b.height - a.height,
  (a, b) => b.width - a.width,
  (a, b) => b.width * b.height - a.width * a.height,
];

/** One sheet size for the whole job. */
function singleTypePlan(blocks, sheet, kerf, margin, allowance) {
  return ORDERINGS.map((order) => {
    const { sheets, leftovers } = packInto([...blocks].sort(order), sheet, kerf, margin, allowance);
    return { sheets, leftovers, cost: sheets.length * sheetCost(sheet) };
  }).reduce((a, b) => (b.leftovers.length - a.leftovers.length || b.cost - a.cost) < 0 ? b : a);
}

/** Fill one sheet at a time, each time with whichever size swallows most area per pound. */
function mixedPlan(blocks, sheetTypes, kerf, margin, allowance, order = ORDERINGS[0]) {
  let remaining = [...blocks].sort(order);
  const sheets = [];
  const leftovers = [];
  let cost = 0;
  let guard = 0;

  while (remaining.length && guard++ < 500) {
    let best = null;
    for (const sheet of sheetTypes) {
      const trial = packInto(remaining, sheet, kerf, margin, allowance);
      if (!trial.sheets.length) continue;
      const first = trial.sheets[0];
      const absorbed = first.placements.reduce((sum, p) => sum + p.block.area, 0);
      const value = absorbed / sheetCost(sheet);
      if (!best || value > best.value) best = { value, sheet, first };
    }
    if (!best) {
      leftovers.push(...remaining);
      break;
    }
    sheets.push(best.first);
    cost += sheetCost(best.sheet);
    const placed = new Set(best.first.placements.map((p) => p.block));
    remaining = remaining.filter((b) => !placed.has(b));
  }
  return { sheets, leftovers, cost };
}

export function plan(pieces, config) {
  const kerf = Number(config.kerf) || 0;
  const margin = Number(config.margin) || 0;
  const allowance = Number(config.allowance) || 0;
  const sheetTypes = (config.sheets || []).filter((s) => s.width > 0 && s.length > 0);
  const limit = {
    width: Math.max(0, ...sheetTypes.map((s) => s.width)) - 2 * margin + allowance,
    length: Math.max(0, ...sheetTypes.map((s) => s.length)) - 2 * margin,
  };
  const blocks = buildBlocks(pieces, kerf, limit);
  if (!sheetTypes.length) return { sheets: [], leftovers: blocks, cost: 0, blocks };

  // A piece bigger than every sheet is set aside first. Left in, it makes every
  // plan a failing one, and the cheapest failing plan is the one that buys a
  // single small sheet and abandons the rest of the roof.
  const tooBig = blocks.filter((b) => b.width > limit.width || b.height > limit.length);
  const packable = blocks.filter((b) => !tooBig.includes(b));

  const plans = sheetTypes.map((s) => singleTypePlan(packable, s, kerf, margin, allowance));
  for (const order of ORDERINGS) plans.push(mixedPlan(packable, sheetTypes, kerf, margin, allowance, order));

  const usable = plans.filter((p) => !p.leftovers.length);
  const pool = usable.length ? usable : plans;
  const best = pool.reduce((a, b) => (b.cost < a.cost ? b : a));
  return { ...best, leftovers: [...best.leftovers, ...tooBig], blocks };
}
