/**
 * The pieces laid out as the roof is seen from above.
 *
 * Each piece is drawn with its base on the ground and the slope running up the
 * page, which is what you want when cutting one but not when checking the roof
 * as a whole. So each side is turned onto its own eave — west and east facing
 * each other, north and south facing each other — and the pieces of a side are
 * laid along that eave in the order they are numbered, each starting where the
 * one before it ended.
 *
 * Nothing is fitted or nudged in the process: pieces are placed at the length
 * of their own base, so a gap or an overlap between two of them is a
 * disagreement between the measurements, and the point of the view is to see it.
 */

import { bbox, pt, translate } from './geometry.js';

/** Anticlockwise from the west side, which is the order the pieces are numbered. */
export const SIDE_ORDER = ['west', 'south', 'east', 'north'];

/**
 * A quarter turn per side. A piece arrives with its base along +x and its slope
 * running +y; it leaves with the slope pointing into the roof from its own eave,
 * and the eave itself running the way the numbering goes.
 */
const TURN = {
  south: (v) => v,
  west: (v) => pt(v.y, -v.x),
  east: (v) => pt(-v.y, v.x),
  north: (v) => pt(-v.x, -v.y),
};

/**
 * Drawn between one piece and the next along an eave. The pieces butt up against
 * each other on the roof, but a shared line reads as one shape from above, so
 * they are held apart by a couple of centimetres to keep the count visible.
 */
export const GAP = 4;

const byNumber = (a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id));

/**
 * What the piece takes up along the eave, and where that run starts.
 *
 * The base is the last edge on a piece lying the way it was measured, but a
 * piece that has been turned is standing on a different edge — and one that has
 * been flipped is standing on the same edge in a different place. So the eave
 * is read off the drawing: the edge sitting on the ground is the one the roof
 * sees. On an untouched piece this is the base, to the centimetre.
 */
function ground(vertices) {
  const floor = Math.min(...vertices.map((v) => v.y));
  let run = 0;
  let from = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (Math.abs(a.y - floor) > 1e-6 || Math.abs(b.y - floor) > 1e-6) continue;
    const span = Math.abs(b.x - a.x);
    if (span <= run) continue;
    run = span;
    from = Math.min(a.x, b.x);
  }
  // A piece balanced on one corner has no edge on the ground; it stands on the
  // width it covers, which is the only honest answer.
  if (!run) return { run: Math.max(...vertices.map((v) => v.x)) - Math.min(...vertices.map((v) => v.x)), from: Math.min(...vertices.map((v) => v.x)) };
  return { run, from };
}

/** One side's pieces in a row, each set a gap along from the one before it. */
function band(pieces, side) {
  let cursor = 0;
  let eave = 0;
  const laid = pieces
    .filter((p) => p.side === side && p.vertices)
    .sort(byNumber)
    .map((piece) => {
      // Butted up against the one before it by the edge it stands on, so its far
      // corner plus the gap is where the next piece starts.
      const { run, from } = ground(piece.vertices);
      const vertices = translate(piece.vertices, cursor - from, 0);
      cursor += run + GAP;
      eave += run;
      return { piece, vertices };
    });
  // The eave is what the bases measure; the span is what that takes up on the
  // page once the gaps are in.
  return { laid, eave, span: Math.max(0, cursor - GAP) };
}

export function layoutRoof(pieces) {
  const bands = new Map(SIDE_ORDER.map((side) => [side, band(pieces, side)]));
  const eaves = Object.fromEntries(SIDE_ORDER.map((side) => [side, bands.get(side).eave]));
  const spans = Object.fromEntries(SIDE_ORDER.map((side) => [side, bands.get(side).span]));

  // The footprint the eaves enclose. Opposite sides rarely measure the same, so
  // the longer of each pair sets the size and the shorter is centred on it.
  const width = Math.max(spans.south, spans.north);
  const depth = Math.max(spans.west, spans.east);
  const middle = (span, length) => (span - length) / 2;

  const offsets = {
    south: { x: middle(width, spans.south), y: 0 },
    north: { x: width - middle(width, spans.north), y: depth },
    west: { x: 0, y: depth - middle(depth, spans.west) },
    east: { x: width, y: middle(depth, spans.east) },
  };

  const placements = SIDE_ORDER.flatMap((side) =>
    bands.get(side).laid.map(({ piece, vertices }) => ({
      piece,
      side,
      vertices: vertices.map((v) => {
        const turned = TURN[side](v);
        return pt(turned.x + offsets[side].x, turned.y + offsets[side].y);
      }),
    }))
  );

  const extent = placements.length ? bbox(placements.flatMap((p) => p.vertices)) : bbox([pt(0, 0), pt(width, depth)]);
  return { placements, eaves, width, depth, extent };
}
