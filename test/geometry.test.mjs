import assert from 'node:assert/strict';
import { test } from 'node:test';
import { area, asDrawn, bbox, buildPolygon, buildRelaxed, fitPolygon, rotate180, spanAt, squareCorners, widthGuide } from '../src/geometry.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

/**
 * These tests describe a piece by the edges as they land on the page — left,
 * top, right, base — because that is what the assertions are about. `entered`
 * turns that into the list someone would type to get it, which is the same
 * journey back: `asDrawn` is its own inverse.
 */
const entered = asDrawn;

test('3-4-5 triangle is right-angled and 6 units of area', () => {
  const { vertices } = buildPolygon(entered([3, 4, 5]));
  near(area(vertices), 6);
  near(bbox(vertices).width, 5);
});

test('triangle inequality is rejected rather than drawn', () => {
  assert.match(buildPolygon(entered([40, 50, 100])).error, /Triangle inequality/);
});

test('four equal edges give a square, not a rhombus', () => {
  const { vertices } = buildPolygon(entered([20, 20, 20, 20]));
  near(area(vertices), 400);
  near(bbox(vertices).height, 20);
});

test('a symmetric trapezoid closes with the top parallel to the bottom', () => {
  // Bottom 120, top 100, sides sqrt(10^2 + 40^2) — height should be 40.
  const side = Math.hypot(10, 40);
  const { vertices } = buildPolygon(entered([side, 100, side, 120]));
  near(bbox(vertices).height, 40, 1e-9);
  near(area(vertices), ((120 + 100) / 2) * 40, 1e-6);
  near(vertices[1].y, vertices[2].y);
});

test('the sides land on the page in the order side 3, side 2, side 1, side 4', () => {
  // The piece is cut the other way up from the way it was measured, so the walk
  // that goes clockwise round the piece goes anticlockwise round the drawing:
  // side 1 lands on the right. The base is untouched — it is what sits on the
  // eave, and turning the piece over does not change that.
  assert.deepEqual(asDrawn([1, 2, 3, 4]), [3, 2, 1, 4]);
  assert.deepEqual(asDrawn([1, 2, 3]), [2, 1, 3]);
  // Its own inverse, which is what lets one function do the journey both ways.
  assert.deepEqual(asDrawn(asDrawn([1, 2, 3, 4])), [1, 2, 3, 4]);
  assert.deepEqual(asDrawn(asDrawn([1, 2, 3])), [1, 2, 3]);
});

test('a right-angled trapezoid keeps its vertical edge where it was drawn', () => {
  const { vertices } = buildPolygon(entered([40, 100, Math.hypot(20, 40), 120]));
  near(vertices[0].x, vertices[1].x);
  near(bbox(vertices).height, 40);
});

test('edges that cannot close as a trapezoid are rejected', () => {
  assert.match(buildPolygon(entered([10, 100, 10, 200])).error, /No trapezoid closes/);
});

test('parallel edges of equal length with unequal sides are rejected', () => {
  assert.match(buildPolygon(entered([30, 50, 40, 50])).error, /cannot be parallel/);
});

test('an unmeasured piece is empty, not an error', () => {
  assert.equal(buildPolygon(entered([0, 0, 0, 0])).empty, true);
});

test('a half turn preserves area and bounding box', () => {
  const { vertices } = buildPolygon(entered([Math.hypot(10, 40), 100, Math.hypot(10, 40), 120]));
  const turned = rotate180(vertices);
  near(area(turned), area(vertices));
  near(bbox(turned).width, bbox(vertices).width);
  near(bbox(turned).height, bbox(vertices).height);
});

test('a half-turned trapezoid nests against the original', () => {
  const side = Math.hypot(10, 40);
  const { vertices } = buildPolygon(entered([side, 100, side, 120]));
  const turned = rotate180(vertices);
  // Halfway up, the original reaches further right than the turned copy starts.
  const a = spanAt(vertices, 20);
  const b = spanAt(turned, 20);
  near(a.max - a.min, 110);
  near(b.max - b.min, 110);
});

test('a piece whose sides run parallel is drawn square to the base, not dropped', () => {
  // Left 200, right 150, base 70: the top is the slant between them, so the
  // top is nowhere near parallel to the bottom and the trapezoid solver fails.
  const { vertices, model, error } = buildRelaxed(entered([200, Math.hypot(70, 50), 150, 70]));
  assert.equal(error, undefined);
  assert.equal(model, 'hip');
  near(vertices[1].x, 0);
  near(vertices[1].y, 200);
  near(vertices[2].x, 70, 1e-6);
  near(vertices[2].y, 150, 1e-6);
});

test('a trapezoid that closes is still drawn as a trapezoid', () => {
  const side = Math.hypot(10, 40);
  assert.equal(buildRelaxed(entered([side, 100, side, 120])).model, 'trapezoid');
});

test('the fit changes the one edge it has to, not all four', () => {
  const drawn = asDrawn(fitPolygon(entered([159, 85, 40, 70])).edges);
  assert.deepEqual([drawn[0], drawn[2], drawn[3]], [159, 40, 70]);
  near(drawn[1], Math.round(Math.hypot(70, 119) * 10) / 10, 1e-9);
});

test('a fitted triangle closes and stays close to what was measured', () => {
  const { edges, vertices } = fitPolygon(entered([40, 50, 100]));
  assert.ok(vertices);
  assert.ok(area(vertices) > 0);
  asDrawn(edges).forEach((e, i) => assert.ok(Math.abs(e - [40, 50, 100][i]) < 6, `edge ${i} moved too far`));
});

test('edges that cannot be measured at all have no fit', () => {
  assert.equal(fitPolygon(entered([0, 0, 0, 0])), null);
  assert.equal(fitPolygon(entered(['a', 2, 3])), null);
});

test('the width guide is the perpendicular from the corner where the slant starts', () => {
  // Left 240 rises higher than right 171, so
  // the slant starts at the top-right corner and the perpendicular drops from
  // there onto the left edge.
  const edges = entered([240, 98, 171, 69]);
  const { vertices } = buildRelaxed(edges);
  const guide = widthGuide(vertices, edges);
  near(guide.from.x, vertices[2].x);
  near(guide.from.y, vertices[2].y);
  const side = { x: vertices[1].x - vertices[0].x, y: vertices[1].y - vertices[0].y };
  const line = { x: guide.to.x - guide.from.x, y: guide.to.y - guide.from.y };
  near(side.x * line.x + side.y * line.y, 0, 1e-9);
  near(Math.hypot(line.x, line.y), guide.width, 1e-9);
});

test('the guide reads the base back when the piece is square between the bars', () => {
  // Sides 200 and 240 a base of 69 apart: the top that closes it is the slant
  // between them, and the perpendicular is then the base itself.
  const edges = entered([200, Math.hypot(69, 40), 240, 69]);
  const guide = widthGuide(buildRelaxed(edges).vertices, edges);
  near(guide.width, 69, 1e-6);
  near(guide.target, 69);
});

test('a top that is out swings the width away from the base', () => {
  const edges = entered([240, 98, 171, 69]);
  const guide = widthGuide(buildRelaxed(edges).vertices, edges);
  assert.ok(Math.abs(guide.width - 69) > 0.1, `${guide.width} should not match the base`);
  assert.ok(Math.abs(guide.width - 69) < 3, `${guide.width} should be near the base`);
});

test('the guide drops onto the right edge when the top-left corner is the lower one', () => {
  const edges = entered([171, 98, 240, 69]);
  const { vertices } = buildRelaxed(edges);
  const guide = widthGuide(vertices, edges);
  near(guide.from.y, vertices[1].y);
  const side = { x: vertices[2].x - vertices[3].x, y: vertices[2].y - vertices[3].y };
  const line = { x: guide.to.x - guide.from.x, y: guide.to.y - guide.from.y };
  near(side.x * line.x + side.y * line.y, 0, 1e-9);
});

test('there is no width guide for a triangle or for edges that make no shape', () => {
  assert.equal(widthGuide(buildPolygon(entered([3, 4, 5])).vertices, [3, 4, 5]), null);
  assert.equal(widthGuide(null, entered([171, 104, 241, 69])), null);
  assert.equal(widthGuide(buildRelaxed(entered([171, 104, 241, 69])).vertices, [171, 0, 241, 69]), null);
});

test('square corners are found where the measurements can tell, and not where they lean', () => {
  // 3-4-5: one right angle, between the two short sides.
  assert.deepEqual(squareCorners(buildPolygon(entered([3, 4, 5])).vertices), [1]);
  assert.deepEqual(squareCorners(buildPolygon(entered([100, 100, 100, 100])).vertices), [0, 1, 2, 3]);
  // A right-angled trapezoid: square at both ends of the vertical side.
  assert.deepEqual(squareCorners(buildPolygon(entered([40, 100, Math.hypot(20, 40), 120])).vertices), [0, 1]);
  // The same piece with that side read off the tape as 44.72 is 0.02° out, which
  // is the tape, not the piece — it keeps both marks.
  assert.deepEqual(squareCorners(buildPolygon(entered([40, 100, 44.72, 120])).vertices), [0, 1]);
  // A symmetric trapezoid leans at every corner, and gets nothing.
  assert.deepEqual(squareCorners(buildPolygon(entered([Math.hypot(10, 40), 100, Math.hypot(10, 40), 120])).vertices), []);
  // Where the line is: piece 6 of this roof is 0.4° off at the corner where its
  // 78 base meets the 118 side, which is the tape and not the piece, so it is
  // marked — and would not be on a tolerance tighter than the tape.
  assert.deepEqual(squareCorners(buildRelaxed([118, 88, 78]).vertices), [0]);
  assert.deepEqual(squareCorners(buildRelaxed([118, 88, 78]).vertices, 0.3), []);
});
