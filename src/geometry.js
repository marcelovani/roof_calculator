/**
 * Edge lists -> polygon vertices.
 *
 * Edges are given clockwise starting at the bottom-left corner, so the last
 * edge is always the base:
 *
 *   4 sides: [side 1, side 2, side 3, side 4]
 *   3 sides: [side 1, side 2, side 3]
 *
 * The last of them is the base — the edge that sits on the eave.
 *
 * Numbered rather than named, because a piece can be turned or flipped and
 * "left" would then be true only of the way it last happened to be lying.
 *
 * Vertices come back in maths coordinates (y up) with the base on y = 0 and
 * the bottom-left corner at the origin.
 *
 * The sheets are laid the other way up from the way they were measured, so the
 * piece on the page is the mirror of the piece the numbers walk around. The
 * numbers themselves are untouched — the list still starts at side 1 and still
 * runs clockwise — but it runs clockwise around the flipped piece, which puts
 * its first side on the right of the drawing. `asDrawn` is that flip, and it is
 * the only place it happens: apply it to a list of lengths and you have the
 * same list in the order the drawing walks its corners — left, top, right, base.
 *
 * Shifting the walk on a corner was tried and is wrong, however tempting it
 * looks: it closes all 28 pieces as exact trapezoids instead of 12, but only by
 * standing each one on its long edge — 238 cm across a sheet 69 cm wide. The
 * last side is the base because the base is what sits on the eave.
 *
 * It is its own inverse, which is why the same function takes a list back the
 * other way.
 */
export const asDrawn = (list) =>
  list.length === 4 ? [list[2], list[1], list[0], list[3]] : [list[1], list[0], list[2]];

const EPS = 1e-6;

/** Bottom-left, apex, bottom-right from the three sides as they fall on the page. */
function triangle([a, b, c]) {
  if (a <= 0 || b <= 0 || c <= 0) return { error: 'Edges must be greater than zero.' };
  if (a + b <= c || a + c <= b || b + c <= a) {
    return { error: `Triangle inequality fails: ${a} + ${b} + ${c} cannot close.` };
  }
  const x = (a * a - b * b + c * c) / (2 * c);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  return { vertices: [pt(0, 0), pt(x, h), pt(c, 0)] };
}

/**
 * Bottom-left, top-left, top-right, bottom-right from [left, top, right, bottom]
 * as they fall on the page, assuming top is parallel to bottom.
 *
 * That is `asDrawn` order, so `l` here is the length entered as the right-hand
 * edge and `r` the one entered as the left. The errors are worded the way they
 * were entered, since that is what there is to go and correct.
 *
 * With P1 = (x, h) and P2 = (x + t, h), the two edge-length equations reduce to
 * x = ((b - t)^2 + l^2 - r^2) / (2 (b - t)). When b == t the shape is a
 * parallelogram with one degree of freedom left, so we take the rectangle.
 */
function quad([l, t, r, b]) {
  if (l <= 0 || t <= 0 || r <= 0 || b <= 0) return { error: 'Edges must be greater than zero.' };
  const d = b - t;
  let x;
  if (Math.abs(d) < EPS) {
    if (Math.abs(l - r) > Math.max(EPS, 1e-3 * l)) {
      return { error: `Side 2 and side 4 are both ${b} but sides 1 and 3 differ (${r} vs ${l}), so they cannot be parallel.` };
    }
    x = 0;
  } else {
    x = (d * d + l * l - r * r) / (2 * d);
  }
  const hSq = l * l - x * x;
  if (hSq <= EPS) {
    return { error: `No trapezoid closes with these edges (side 1 ${r}, side 2 ${t}, side 3 ${l}, side 4 ${b}).` };
  }
  const h = Math.sqrt(hSq);
  return { vertices: [pt(0, 0), pt(x, h), pt(x + t, h), pt(b, 0)] };
}

export function buildPolygon(edges) {
  if (!Array.isArray(edges)) return { error: 'Edges must be an array.' };
  const nums = edges.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return { error: 'Edges must all be numbers.' };
  if (nums.every((n) => n === 0)) return { empty: true };
  if (nums.length === 3) return triangle(asDrawn(nums));
  if (nums.length === 4) return quad(asDrawn(nums));
  return { error: `${nums.length} edges given; only 3 or 4 are supported.` };
}

export const pt = (x, y) => ({ x, y });

/** Shoelace. */
export function area(vertices) {
  let sum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function bbox(vertices) {
  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Shift so the bounding box starts at the origin. */
export function normalise(vertices) {
  const { minX, minY } = bbox(vertices);
  return vertices.map((v) => pt(v.x - minX, v.y - minY));
}

/**
 * Half a turn. This is the only rotation multiwall allows: the flutes still
 * run the length of the sheet afterwards. A quarter turn would lay them
 * across the slope and trap water; a mirror would put the UV face inward.
 */
export function rotate180(vertices) {
  return normalise(vertices.map((v) => pt(-v.x, -v.y)));
}

/**
 * How a piece is turned over or round, kept apart from the lengths that measure
 * it.
 *
 * A list of edges does not fix a shape on its own — the trapezoid model reads
 * the first and third as the parallel-to-nothing sides with the top parallel to
 * the base, the hip model reads a right angle at the base. Shuffling the
 * numbers to turn a piece therefore moves the constraint too, and what comes
 * back is a different shape with the same edges. So the numbers stay exactly as
 * they were measured and the turn is recorded beside them, as one of the eight
 * ways a shape can be laid down: a quarter turn at a time, mirrored or not.
 *
 * Matrices, because they compose without a table of special cases: whatever the
 * piece is already doing, the new operation is applied on top of it in the
 * order the eye sees it.
 */
const ROT = [
  [1, 0, 0, 1], // 0
  [0, -1, 1, 0], // 90 anticlockwise
  [-1, 0, 0, -1], // 180
  [0, 1, -1, 0], // 270
];
const MIRROR_X = [-1, 0, 0, 1];

/** Screen-space operations, the ones the buttons offer. */
export const OPS = {
  flipH: MIRROR_X,
  flipV: [1, 0, 0, -1],
  turn: [0, 1, -1, 0], // a quarter turn clockwise on the page
};

const mul = (p, q) => [
  p[0] * q[0] + p[1] * q[2],
  p[0] * q[1] + p[1] * q[3],
  p[2] * q[0] + p[3] * q[2],
  p[2] * q[1] + p[3] * q[3],
];

const same = (a, b) => a.every((n, i) => n === b[i]);
const matrixOf = ({ turn = 0, mirror = false } = {}) => {
  const r = ROT[(((turn / 90) % 4) + 4) % 4] || ROT[0];
  return mirror ? mul(r, MIRROR_X) : r;
};

/** Back to something a person can read in the file, and edit by hand. */
function readBack(m) {
  const mirror = m[0] * m[3] - m[1] * m[2] < 0;
  // MIRROR_X is its own inverse, so undoing it leaves the rotation on its own.
  const r = mirror ? mul(m, MIRROR_X) : m;
  const turn = ROT.findIndex((k) => same(k, r));
  return { turn: (turn < 0 ? 0 : turn) * 90, mirror };
}

/** The piece as it now lies, with `op` applied on top of how it lay before. */
export const compose = (orientation, op) => readBack(mul(op, matrixOf(orientation)));

/**
 * The polygon as it lies, brought back to the origin.
 *
 * Vertex order is left alone — mirroring makes the walk anticlockwise, and that
 * is fine: edge i still runs from vertex i, which is what the labels and the
 * nester both count on. `map` puts any other point through the same journey,
 * for the width guide, which is measured off the untouched shape.
 */
export function orient(vertices, orientation) {
  const m = matrixOf(orientation);
  const put = (v) => pt(m[0] * v.x + m[1] * v.y, m[2] * v.x + m[3] * v.y);
  const moved = vertices.map(put);
  const { minX, minY } = bbox(moved);
  const home = (v) => pt(v.x - minX, v.y - minY);
  return { vertices: moved.map(home), map: (v) => home(put(v)) };
}

/** Nothing to say about a piece lying the way it was measured. */
export const isPlain = ({ turn = 0, mirror = false } = {}) => !turn && !mirror;

/**
 * How square is square, in degrees.
 *
 * Half a centimetre misread on a 70 cm edge swings the corner about four tenths
 * of a degree, so half a degree is the tape's own limit: inside it the corner is
 * square as far as anything here can tell, outside it the piece really does
 * lean. On this roof it is also where the numbers sit — the corners that are not
 * square are a degree or more out, and the ones that are come in under 0.45.
 */
const SQUARE_ENOUGH = 0.5;

/**
 * Which corners are square, to the accuracy the measurements have.
 *
 * Not "roughly": a corner a degree off is a corner that is not square, and the
 * mark would be a lie. See `SQUARE_ENOUGH` for where the line is drawn.
 */
export function squareCorners(vertices, tolerance = SQUARE_ENOUGH) {
  if (!Array.isArray(vertices) || vertices.length < 3) return [];
  const limit = Math.cos((90 - tolerance) * (Math.PI / 180));
  const out = [];
  for (let i = 0; i < vertices.length; i++) {
    const here = vertices[i];
    const back = vertices[(i - 1 + vertices.length) % vertices.length];
    const on = vertices[(i + 1) % vertices.length];
    const a = pt(back.x - here.x, back.y - here.y);
    const b = pt(on.x - here.x, on.y - here.y);
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la < EPS || lb < EPS) continue;
    if (Math.abs((a.x * b.x + a.y * b.y) / (la * lb)) <= limit) out.push(i);
  }
  return out;
}

export function translate(vertices, dx, dy) {
  return vertices.map((v) => pt(v.x + dx, v.y + dy));
}

/**
 * Horizontal extent of the polygon at height y, or null if it does not reach.
 * Used to slide two pieces together without overlapping.
 */
export function spanAt(vertices, y) {
  const xs = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (Math.abs(a.y - b.y) < EPS) {
      if (Math.abs(a.y - y) < EPS) xs.push(a.x, b.x);
      continue;
    }
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    if (y < lo - EPS || y > hi + EPS) continue;
    xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  if (!xs.length) return null;
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

/**
 * Bottom-left, top-left, top-right, bottom-right from [left, top, right, bottom],
 * assuming the base meets the left edge square instead of the top being parallel
 * to the bottom.
 *
 * This is the shape of a piece cut against a hip: it sits between two glazing
 * bars, so the sides run parallel and the eave meets them at a right angle,
 * while the top is cut on the slant and is nothing like parallel to the base.
 * All four measured lengths are used exactly — the top-right corner is where
 * the top and right edges reach from the two corners already fixed — so any
 * error in the measuring shows up as the right edge leaning off vertical
 * rather than as a shape that cannot be drawn at all.
 *
 * Takes `asDrawn` order, like `quad`: the right angle is at the first edge as
 * entered, which is the right-hand one on the page.
 */
function squareCorner([l, t, r, b]) {
  if (l <= 0 || t <= 0 || r <= 0 || b <= 0) return { error: 'Edges must be greater than zero.' };
  const d = Math.hypot(b, l);
  if (t + r <= d + EPS || Math.abs(t - r) >= d - EPS) {
    return { error: `Top ${t} and left ${r} cannot reach between the ends of a ${b} base and a ${l} right edge.` };
  }
  // Where the circles of radius t about the top-left corner and radius r about
  // the bottom-right corner cross. Two crossings; the right-hand one is the
  // corner of a piece that does not fold back on itself.
  const a = (t * t - r * r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, t * t - a * a));
  const ux = b / d;
  const uy = -l / d;
  const px = a * ux;
  const py = l + a * uy;
  const c1 = pt(px - h * uy, py + h * ux);
  const c2 = pt(px + h * uy, py - h * ux);
  const corner = c1.x >= c2.x ? c1 : c2;
  if (corner.x <= EPS || corner.y <= EPS) {
    return { error: `No piece closes with these edges (side 1 ${r}, side 2 ${t}, side 3 ${l}, side 4 ${b}).` };
  }
  return { vertices: [pt(0, 0), pt(0, l), corner, pt(b, 0)] };
}

/**
 * The smallest change to a set of edges that lets the piece close.
 *
 * Measurements taken off a roof are relative, not exact, and a few centimetres
 * out is enough that no shape exists at all. Two readings are tried and the one
 * that moves the numbers least wins: the top edge redrawn so the sides run
 * parallel, which changes one number and is usually the answer when the piece
 * was cut against a hip; or the edges pulled the shortest distance (least
 * squares, in cm) that satisfies the triangle inequality.
 *
 * The triangle inequality covers both shapes. A triangle is its three edges. A
 * trapezoid is a parallelogram plus a triangle of sides (left, right,
 * |bottom - top|), so the gap between the parallels stands in for the third
 * side and the change to it is split evenly between top and bottom.
 */

/** Kept in hand so a fitted shape has some height instead of collapsing flat. */
const SLACK = 0.02;

/** Least-squares projection of a triple onto the triangle inequality. */
function fitTriple(sides) {
  const out = sides.slice();
  const slack = SLACK * Math.max(...out);
  for (let pass = 0; pass < 20; pass++) {
    let worst = -1;
    let excess = 0;
    for (let i = 0; i < 3; i++) {
      // The gradient of (a - b - c) has length sqrt(3), so a third of the excess
      // off the long side and a third onto each of the others is the nearest
      // point on the constraint.
      const e = out[i] - out[(i + 1) % 3] - out[(i + 2) % 3] + slack;
      if (e > excess) {
        excess = e;
        worst = i;
      }
    }
    if (worst < 0) break;
    for (let i = 0; i < 3; i++) out[i] += i === worst ? -excess / 3 : excess / 3;
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));

/** Edge lengths that close and the polygon they make, or null if nothing does. */
export function fitPolygon(edges) {
  const nums = (Array.isArray(edges) ? edges : []).map(Number);
  if (!nums.length || nums.some((n) => !Number.isFinite(n)) || nums.every((n) => n === 0)) return null;

  // Which edge is the top and which the base is a fact about the drawing, so
  // the fitting is done there and the answer handed back in the order it came.
  const drawn = asDrawn(nums);
  const candidates = [];
  if (nums.length === 3) {
    candidates.push(fitTriple(drawn));
  } else if (nums.length === 4) {
    const [l, t, r, b] = drawn;
    candidates.push([l, Math.hypot(b, l - r), r, b]);
    const gap = Math.abs(b - t);
    const [left, right, newGap] = fitTriple([l, r, gap]);
    // Half the change to each parallel keeps their sum, and so the piece's
    // width, where the measurements put it.
    const shift = ((newGap - gap) / 2) * (b >= t ? 1 : -1);
    candidates.push([left, t - shift, right, b + shift]);
  } else {
    return null;
  }

  for (const candidate of candidates.sort((a, b) => distance(a, drawn) - distance(b, drawn))) {
    for (const tidy of [candidate.map(round1), candidate]) {
      if (tidy.some((n) => n <= 0)) continue;
      const entered = asDrawn(tidy);
      const result = buildRelaxed(entered);
      if (result.vertices) return { edges: entered, vertices: result.vertices };
    }
  }
  return null;
}

/**
 * The polygon to draw, however the measurements came out: the trapezoid if the
 * edges close as one, otherwise the hip-cut shape, otherwise the nearest edges
 * that close at all. `model` says which, so the drawing can be marked as the
 * approximation it is rather than passing for a measured piece.
 */
export function buildRelaxed(edges) {
  const exact = buildPolygon(edges);
  if (exact.vertices || exact.empty) return { ...exact, model: 'trapezoid' };

  const nums = edges.map(Number);
  if (nums.length === 4) {
    const hip = squareCorner(asDrawn(nums));
    if (hip.vertices) return { ...hip, model: 'hip' };
  }
  return { ...exact, model: null };
}

/**
 * The width of the piece where the slant starts: the perpendicular dropped from
 * the corner at the low end of the top edge onto the opposite side.
 *
 * A piece cut between two glazing bars is a strip of one width the whole way
 * up, so this distance and the base should be the same number. They are not
 * independent — the base, the two sides and the top over-determine the shape —
 * so a top that is a centimetre out swings the corner and the perpendicular
 * comes back wrong. That is what the guide is for: walk the top up or down
 * until the guide reads the base, and the piece is square between the bars.
 *
 * `width` is what the perpendicular measures and `target` is the base it should
 * match. The line is drawn along the perpendicular, so its length on the page
 * is the number printed on it.
 *
 * Four-sided pieces only — three lengths already fix a triangle, so there is
 * nothing for a guide to add.
 */
export function widthGuide(vertices, edges) {
  if (!Array.isArray(vertices) || vertices.length !== 4) return null;
  const nums = (Array.isArray(edges) ? edges : []).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;

  // The top runs between vertices 1 and 2. Whichever sits lower is where the
  // slant starts; the perpendicular goes from there to the side opposite it.
  const low = vertices[2].y < vertices[1].y ? 2 : 1;
  const from = vertices[low];
  const [a, b] = low === 2 ? [vertices[0], vertices[1]] : [vertices[3], vertices[2]];

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) return null;
  // Foot of the perpendicular on the infinite line of that side. Not clamped to
  // the side itself: on a badly measured piece the foot runs off the end, and
  // seeing it do so is the point.
  const t = ((from.x - a.x) * dx + (from.y - a.y) * dy) / lenSq;
  const foot = pt(a.x + t * dx, a.y + t * dy);
  const width = Math.hypot(from.x - foot.x, from.y - foot.y);
  if (width < EPS) return null;

  const drawn = asDrawn(nums);
  return { from, to: foot, width, target: drawn[drawn.length - 1] };
}
