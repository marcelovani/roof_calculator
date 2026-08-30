import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPolygon, bbox } from '../src/geometry.js';
import { GAP, layoutRoof } from '../src/roof.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

/** One 100 x 100 square per side, so every side's band is 100 long. */
const square = (id, side) => ({ id, side, edges: [100, 100, 100, 100], vertices: buildPolygon([100, 100, 100, 100]).vertices });
const roof = layoutRoof(['west', 'south', 'east', 'north'].map((side, i) => square(String(i + 1), side)));
const box = (side) => bbox(roof.placements.find((p) => p.side === side).vertices);

test('the eaves box in a footprint the size of the longest sides', () => {
  near(roof.width, 100);
  near(roof.depth, 100);
});

test('the gap sits between pieces, never before the first or after the last', () => {
  const one = layoutRoof([square('1', 'south')]);
  near(bbox(one.placements[0].vertices).minX, 0);
  near(one.width, 100);
});

test('each side is turned onto its own eave, facing the one opposite', () => {
  // West sits on the left and runs in; east on the right and runs in to meet it.
  near(box('west').minX, 0);
  near(box('east').maxX, roof.width);
  // South sits along the bottom and runs up; north along the top and runs down.
  near(box('south').minY, 0);
  near(box('north').maxY, roof.depth);
});

test('a side lays its pieces along the eave in numbered order, a gap apart', () => {
  const pieces = [square('1', 'south'), square('2', 'south'), square('3', 'south')];
  const { placements, eaves } = layoutRoof(pieces);
  // The eave is what the bases measure — the gaps are drawing, not roof.
  near(eaves.south, 300);
  const xs = placements.map((p) => bbox(p.vertices).minX);
  assert.deepEqual(
    placements.map((p) => p.piece.id),
    ['1', '2', '3']
  );
  near(xs[0], 0);
  near(xs[1], 100 + GAP);
  near(xs[2], 200 + 2 * GAP);
});

test('a shorter side is centred against the longer one opposite it', () => {
  const { placements } = layoutRoof([square('1', 'south'), square('2', 'south'), square('3', 'north')]);
  const north = bbox(placements.find((p) => p.side === 'north').vertices);
  near(north.minX, (200 + GAP - 100) / 2);
  near(north.maxX, (200 + GAP + 100) / 2);
});

test('an unmeasured piece is left out of the layout rather than stacked at the origin', () => {
  const { placements, eaves } = layoutRoof([square('1', 'west'), { id: '2', side: 'west', edges: [0, 0, 0, 0], vertices: null }]);
  assert.equal(placements.length, 1);
  near(eaves.west, 100);
});
