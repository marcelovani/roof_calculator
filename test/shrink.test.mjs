import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { bbox, buildPolygon } from '../src/geometry.js';
import { plan } from '../src/nest.js';
import { shrinkPieces } from '../src/nest-blf.js';

/**
 * The trial slack. Typing a number into "every piece N cm smaller" has to
 * change the plan on the screen, not only what a later search does — the box
 * is the answer to "nothing ticked fits these pieces", and an answer that
 * changed nothing below it would be no answer.
 */

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const config = read('sheets.json');
const cuts = read('example-cuts.json');

const pieces = Object.entries(cuts.cuts)
  .map(([id, cut]) => {
    const { vertices } = buildPolygon(cut.edges);
    return vertices ? { id, side: cut.side, edges: cut.edges, vertices, fitted: null } : null;
  })
  .filter(Boolean);

/** The ids of everything the nester had to set aside. */
const unplaced = (result) => (result.leftovers || []).flatMap((b) => b.placements.map((p) => p.piece.id));

/**
 * One width on its own, and a roof built to straddle it: some pieces fit, some
 * are a few centimetres too wide. Built rather than taken from the shipped
 * measurements, because whether that roof happens to straddle a width is not
 * something these tests should depend on — it changes when the example does.
 */
const narrowest = Math.min(...config.sheets.map((s) => s.width));
const oneWidth = { ...config, sheets: config.sheets.filter((s) => s.width === narrowest) };

/** A rectangle w across and h up the sheet, from [left, top, right, base]. */
const slab = (id, w, h) => ({ id, side: 'west', edges: [h, w, h, w], vertices: buildPolygon([h, w, h, w]).vertices, fitted: null });

const straddling = [
  slab('fits', narrowest - 10, 60),
  slab('just-over', narrowest + 1, 60),
  slab('well-over', narrowest + 4, 60),
];

test('no slack leaves the pieces exactly as they were measured', () => {
  assert.equal(shrinkPieces(pieces, 0), pieces);
});

test('slack takes it off both the width and the height, and off every piece', () => {
  const by = 2;
  const shrunk = shrinkPieces(pieces, by);
  assert.equal(shrunk.length, pieces.length);
  for (const [i, piece] of shrunk.entries()) {
    const was = bbox(pieces[i].vertices);
    const now = bbox(piece.vertices);
    assert.ok(Math.abs(now.width - (was.width - by)) < 1e-6, `${piece.id} width ${now.width} from ${was.width}`);
    assert.ok(Math.abs(now.height - (was.height - by)) < 1e-6, `${piece.id} height ${now.height} from ${was.height}`);
  }
});

test('a shrunk piece is labelled with the lengths it now has, not the ones off the tape', () => {
  const [piece] = shrinkPieces(pieces, 3);
  const [was] = pieces;
  assert.notDeepEqual(piece.edges, was.edges);
  assert.equal(piece.edges.length, was.edges.length);
  // The measured lengths were never put through a fit, and neither are these.
  assert.equal(piece.fitted, null);
});

test('the piece keeps its id and its side, so the plan still names the same roof', () => {
  for (const [i, piece] of shrinkPieces(pieces, 1).entries()) {
    assert.equal(piece.id, pieces[i].id);
    assert.equal(piece.side, pieces[i].side);
  }
});

test('a piece narrower than the slack is left alone rather than turned inside out', () => {
  const tiny = [{ id: 't', edges: [3, 4, 5], vertices: buildPolygon([3, 4, 5]).vertices, fitted: null }];
  const box = bbox(shrinkPieces(tiny, 50)[0].vertices);
  assert.ok(box.width > 0 && box.height > 0, `${box.width} x ${box.height}`);
});

test('a piece too wide for the only width ticked is left out, and said to be', () => {
  const left = unplaced(plan(shrinkPieces(straddling, 0), oneWidth));
  assert.deepEqual(left.sort(), ['just-over', 'well-over']);
});

test('enough slack brings a piece back into the plan, and the notice with it', () => {
  const at2 = unplaced(plan(shrinkPieces(straddling, 2), oneWidth));
  assert.deepEqual(at2, ['well-over'], 'a centimetre over should fit with two off');

  const at6 = unplaced(plan(shrinkPieces(straddling, 6), oneWidth));
  assert.deepEqual(at6, [], 'four centimetres over should fit with six off');
});

test('the count of pieces left out never rises as the slack does', () => {
  let previous = Infinity;
  for (const by of [0, 1, 2, 5, 10, 20]) {
    const count = unplaced(plan(shrinkPieces(straddling, by), oneWidth)).length;
    assert.ok(count <= previous, `${count} left out at ${by} cm, against ${previous} at the step before`);
    previous = count;
  }
});

test('slack does not lose a piece — everything is either placed or named as left out', () => {
  for (const by of [0, 2, 10]) {
    const result = plan(shrinkPieces(pieces, by), oneWidth);
    const placed = result.sheets.flatMap((s) => s.placements.flatMap((p) => p.block.placements.map((x) => x.piece.id)));
    const ids = new Set([...placed, ...unplaced(result)]);
    assert.equal(ids.size, pieces.length, `${ids.size} accounted for at ${by} cm, of ${pieces.length}`);
  }
});
