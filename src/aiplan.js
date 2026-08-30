/**
 * A cutting plan worked out somewhere else and pasted back.
 *
 * The nester here is a greedy one: it merges pieces into blocks and shelf-packs
 * the blocks, which is quick and predictable but leaves the diagonal slack a
 * person — or a model given the shapes — can sometimes see how to use. There is
 * no way to call out from a static page, so the exchange is by hand: copy the
 * prompt, paste the answer back.
 *
 * Nothing pasted is taken on trust. The arrangement is checked against the same
 * rules the nester works under — inside the sheet, no overlaps, every piece
 * placed once, half turns only — and what it costs is put next to what the
 * nester managed. An arrangement that breaks a rule is still drawn, with the
 * breakages listed, because seeing where it went wrong is the useful part.
 */

import { area, bbox, normalise, rotate180, translate } from './geometry.js';

/**
 * A tenth of a centimetre — a millimetre — is the precision everything here is
 * exchanged at: the corners the model is given, and the positions it sends back.
 * So it is also how close two pieces may come before they are called overlapping.
 * Any less and the nester's own plan, written out and read straight back in,
 * fails on its own rounding.
 */
const PRECISION = 0.1;

// Multiplying back by a tenth reintroduces the float noise the rounding just
// took out — 70.6 comes back as 70.60000000000001 — so it is trimmed off again.
const round = (n) => Number((Math.round(n / PRECISION) * PRECISION).toFixed(6));

/** The pieces as coordinates, which is what an arrangement has to be made of. */
export function pieceList(pieces) {
  return pieces
    .filter((p) => p.vertices)
    .map((p) => {
      const v = normalise(p.vertices);
      const bb = bbox(v);
      const corners = v.map((c) => `[${round(c.x)},${round(c.y)}]`).join(' ');
      return `  ${p.id} (${p.side}): ${round(bb.width)} x ${round(bb.height)}, ${round(area(v) / 10000)} m2, corners ${corners}`;
    })
    .join('\n');
}

/** The catalogue as the model needs to see it. */
export function sheetList(config) {
  return (config.sheets || [])
    .map((s) => `  ${s.id}: ${s.width} x ${s.length}${s.price != null ? `, £${s.price}` : ''}`)
    .join('\n');
}

/**
 * The lists put back into the prompt that names them.
 *
 * A token nobody has a value for is left standing rather than blanked: a prompt
 * still asking for `[pieces]` is a prompt whose pieces went missing, and that is
 * worth seeing rather than hiding.
 */
export function fillPrompt(template, parts) {
  return template.replace(/\[(sheets|pieces|plan)\]/g, (whole, key) => (key in parts ? parts[key] : whole));
}

/** The whole thing, lists and all — what a copy of the prompt amounts to. */
export function promptFor(pieces, config, plan = '') {
  return fillPrompt(promptTemplate(config), { sheets: sheetList(config), pieces: pieceList(pieces), plan }).trimEnd();
}

/**
 * The prompt with a hole where each list goes.
 *
 * The catalogue runs to fifty lines and the pieces to thirty, and between them
 * they bury the eight lines of rules that are the part worth reading. So each
 * list gets a box of its own on the page and the prompt keeps a `[token]` where
 * it belongs — which also says plainly where each box is used.
 */
export function promptTemplate(config) {
  return `Arrange these polycarbonate pieces on as little sheet as possible.

Everything is in centimetres, x across the sheet and y along it, measured from
the bottom-left corner of the sheet with y running up.

Rules, all of them hard:
- A piece may be placed as it is, or turned a half turn (180 degrees). No quarter
  turns and no mirroring: the flutes must run along the length of the sheet and
  the UV face must stay up.
- Pieces may not overlap.
${
    Number(config.kerf)
      ? `- Leave ${config.kerf} cm between pieces for the saw cut.`
      : `- Pieces may butt straight up against each other: the saw cut is not worth
  planning around, it comes out of the tolerance below.`
  }
- Along the sheet, no piece may cross the end. The length is the length.
- Across the sheet you have ${config.allowance || 0} cm more than the sheet says. So a 210 wide
  sheet takes three pieces 70 wide, and takes 70 + 70 + 71 as well.
${config.margin ? `- Leave ${config.margin} cm unused at the sheet edge.\n` : ''}- Every piece must be placed exactly once. The one exception is a piece that fits
  no sheet in the catalogue at all: leave that one out, and it will be reported
  as unplaced rather than counted against you.
- Sheets may be used more than once; you pay for each one you use.

Sheets available (id: width x length, price):
[sheets]

Pieces (id: bounding box, area, corners anticlockwise from the bottom-left):
[pieces]

The corners are the piece as it stands. If you turn a piece, turn it about its
own centre; x and y are then where the bottom-left corner of its bounding box
sits on the sheet.

Answer with JSON and nothing else:

{"sheets":[
{"sheet":"690x2500mm","pieces":[{"id":"3","orientation":0,"x":0,"y":0},{"id":"4","orientation":180,"x":0,"y":232}]}
]}

A line per sheet, no indentation. Nothing is gained by pretty-printing it.

Cheapest total wins. Say nothing else — the answer is read by a machine.

Anything below this line is the arrangement the nester already found. Every
piece in it is placed legally, so it is a floor and not a suggestion: beat it on
total price, or return it unchanged if you cannot. If nothing follows it, there
is no floor and you are starting from nothing.

[plan]`;
}

/**
 * Convex polygons, so a separating axis settles it — and the same axes answer
 * whether the two are the saw cut apart.
 *
 * Only the two polygons' own edge normals are tried, which is all the theorem
 * needs to prove an overlap. As a distance it is exact where the pieces face
 * each other along an edge, and a shade generous where two corners pass at an
 * angle. At a kerf of nought — where the roof stands today — it is the plain
 * overlap test either way.
 */
function overlaps(a, b, clearance = 0) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const axis = { x: -(q.y - p.y), y: q.x - p.x };
      const project = (poly2) => {
        const dots = poly2.map((v) => v.x * axis.x + v.y * axis.y);
        return { min: Math.min(...dots), max: Math.max(...dots) };
      };
      const pa = project(a);
      const pb = project(b);
      // A shared cut line is not an overlap, and neither is a millimetre of
      // rounding. The projections are onto an axis that was never normalised, so
      // the gap asked for has to be scaled the same way.
      const gap = (clearance - PRECISION) * Math.hypot(axis.x, axis.y);
      if (pa.max <= pb.min - gap || pb.max <= pa.min - gap) return false;
    }
  }
  return true;
}

/**
 * A pasted arrangement turned into the same shape of result the nester returns,
 * plus everything wrong with it.
 */
export function readPlan(text, pieces, config) {
  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { problems: [`That is not JSON: ${err.message}`], sheets: [], leftovers: [], cost: 0 };
  }

  const catalogue = new Map((config.sheets || []).map((s) => [String(s.id), s]));
  const byId = new Map(pieces.filter((p) => p.vertices).map((p) => [String(p.id), p]));
  const margin = Number(config.margin) || 0;
  const allowance = Number(config.allowance) || 0;
  const kerf = Number(config.kerf) || 0;
  const placedIds = [];
  const sheets = [];

  for (const [index, entry] of (parsed && Array.isArray(parsed.sheets) ? parsed.sheets : []).entries()) {
    const sheet = catalogue.get(String(entry.sheet));
    if (!sheet) {
      problems.push(`Sheet ${index + 1}: no such sheet as "${entry.sheet}" in the catalogue.`);
      continue;
    }
    const placements = [];
    for (const spot of entry.pieces || []) {
      const piece = byId.get(String(spot.id));
      if (!piece) {
        problems.push(`Sheet ${index + 1}: no such piece as "${spot.id}".`);
        continue;
      }
      const turned = Number(spot.orientation) === 180;
      if (Number(spot.orientation) !== 0 && !turned) {
        problems.push(`Piece ${spot.id}: orientation ${spot.orientation} is not allowed — 0 or 180 only.`);
      }
      const shape = turned ? rotate180(piece.vertices) : normalise(piece.vertices);
      const vertices = translate(shape, Number(spot.x) || 0, Number(spot.y) || 0);
      const box = bbox(vertices);
      // The same tolerance the nesters pack to: a centimetre across the sheet,
      // nothing along it.
      if (
        box.minX < margin - PRECISION ||
        box.minY < margin - PRECISION ||
        box.maxX > sheet.width - margin + allowance + PRECISION ||
        box.maxY > sheet.length - margin + PRECISION
      ) {
        problems.push(`Piece ${spot.id} hangs off sheet ${index + 1} (${sheet.id}).`);
      }
      placedIds.push(String(piece.id));
      placements.push({ piece, orientation: turned ? 180 : 0, vertices });
    }

    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        if (overlaps(placements[i].vertices, placements[j].vertices, kerf)) {
          problems.push(
            `Pieces ${placements[i].piece.id} and ${placements[j].piece.id} ${kerf ? `are less than ${kerf} cm apart` : 'overlap'} on sheet ${index + 1}.`,
          );
        }
      }
    }

    // renderCutPlan draws blocks at an offset, so each piece is its own block
    // sitting at the origin — the coordinates are already absolute.
    sheets.push({
      sheet,
      placements: placements.map((p) => ({
        x: 0,
        y: 0,
        block: { width: sheet.width, height: sheet.length, area: area(p.vertices), placements: [p] },
      })),
    });
  }

  if (parsed && !Array.isArray(parsed.sheets)) problems.push('No "sheets" list in that — expected {"sheets": [ ... ]}.');

  const counts = new Map();
  for (const id of placedIds) counts.set(id, (counts.get(id) || 0) + 1);
  const twice = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const missing = [...byId.keys()].filter((id) => !counts.has(id));
  if (twice.length) problems.push(`Placed more than once: ${twice.join(', ')}.`);
  if (missing.length) problems.push(`Never placed: ${missing.join(', ')}.`);

  const cost = sheets.reduce((sum, s) => sum + (s.sheet.price != null ? s.sheet.price : 0), 0);
  return { sheets, leftovers: [], cost, problems, blocks: [] };
}

/**
 * A plan written back out in the shape readPlan reads in.
 *
 * The nester keeps its pieces inside blocks, and a block sits at an offset on
 * the sheet, so the coordinates on the screen are the two added together. A
 * model has no use for the blocks — they are how the nester thinks, not part of
 * the arrangement — so they are flattened away here and every piece is given
 * where its bounding box sits on the sheet.
 */
export function planJson(result) {
  const sheets = (result.sheets || []).map((s) => ({
    sheet: s.sheet.id,
    pieces: s.placements.flatMap((slot) =>
      slot.block.placements.map((p) => {
        const box = bbox(translate(p.vertices, slot.x, slot.y));
        // The two nesters label a half turn differently — 180 in nest.js, 1 in
        // nest-blf.js — and the drawing only ever asks whether it is turned at
        // all. So the test here is the same one: truthy, not a particular number.
        return { id: p.piece.id, orientation: p.orientation ? 180 : 0, x: round(box.minX), y: round(box.minY) };
      }),
    ),
  }));
  // A line per sheet: still readable down the page, and a third of the size of
  // the same thing indented. The plan is the part of the prompt that grows with
  // the roof, so it is the part worth keeping tight.
  return `{"sheets":[\n${sheets.map((s) => JSON.stringify(s)).join(',\n')}\n]}`;
}
