import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { area, bbox, buildPolygon } from '../src/geometry.js';
import { plan } from '../src/nest.js';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const data = { ...read('sheets.json'), ...read('example-cuts.json') };
const pieces = Object.entries(data.cuts)
  .map(([id, cut]) => {
    const { vertices } = buildPolygon(cut.edges);
    return vertices ? { id, side: cut.side, edges: cut.edges, vertices } : null;
  })
  .filter(Boolean);
const result = plan(pieces, data);

const placed = () =>
  result.sheets.flatMap((s) => s.placements.flatMap((p) => p.block.placements.map((x) => x.piece.id)));

test('every piece is placed exactly once', () => {
  const ids = placed();
  assert.equal(ids.length, pieces.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.leftovers.length, 0);
});

test('no piece sticks out of its sheet, bar the allowance across it', () => {
  const allowance = Number(data.allowance) || 0;
  for (const [i, sheet] of result.sheets.entries()) {
    for (const p of sheet.placements) {
      for (const pl of p.block.placements) {
        const bb = bbox(pl.vertices);
        const where = `sheet ${i + 1}, piece ${pl.piece.id}`;
        assert.ok(p.x + bb.minX >= -1e-6, `${where} off the left edge`);
        assert.ok(p.x + bb.maxX <= sheet.sheet.width + allowance + 1e-6, `${where} off the right edge`);
        assert.ok(p.y + bb.minY >= -1e-6, `${where} off the bottom edge`);
        assert.ok(p.y + bb.maxY <= sheet.sheet.length + 1e-6, `${where} off the top edge`);
      }
    }
  }
});

test('blocks on a sheet do not overlap', () => {
  for (const [i, sheet] of result.sheets.entries()) {
    const ps = sheet.placements;
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        const A = ps[a];
        const B = ps[b];
        const apart =
          A.x + A.block.width <= B.x + 1e-6 ||
          B.x + B.block.width <= A.x + 1e-6 ||
          A.y + A.block.height <= B.y + 1e-6 ||
          B.y + B.block.height <= A.y + 1e-6;
        assert.ok(apart, `sheet ${i + 1}: blocks ${a} and ${b} overlap`);
      }
    }
  }
});

test('pairing and half turns preserve the glazed area', () => {
  const fromPieces = pieces.reduce((s, p) => s + area(p.vertices), 0);
  const fromBlocks = result.blocks.reduce((s, b) => s + b.area, 0);
  assert.ok(Math.abs(fromPieces - fromBlocks) < 1, `${fromPieces} vs ${fromBlocks}`);
});

test('pairing actually happens on a roof of trapezoids and triangles', () => {
  const paired = result.blocks.filter((b) => b.placements.length > 1);
  assert.ok(paired.length > 0, 'nothing paired');
  // Some, not every: a merge that saves area without a turn is a good merge
  // too, and the worked example has one — three pieces stacked upright.
  assert.ok(paired.some((b) => b.placements.some((p) => p.orientation === 180)), 'no half turn used');
});

test('a piece too big for any sheet does not take the rest of the roof with it', () => {
  const oversized = { id: 'huge', side: 'west', edges: [500, 500, 500, 500], vertices: buildPolygon([500, 500, 500, 500]).vertices };
  const withOversized = plan([...pieces, oversized], data);
  const ids = withOversized.sheets.flatMap((s) => s.placements.flatMap((p) => p.block.placements.map((x) => x.piece.id)));
  assert.equal(withOversized.leftovers.length, 1);
  assert.equal(withOversized.leftovers[0].placements[0].piece.id, 'huge');
  assert.equal(new Set(ids).size, pieces.length);
});

test('the allowance is across the sheet only, never along it', () => {
  const slab = (id, w, h) => ({ id, side: 'north', edges: [h, w, h, w], vertices: buildPolygon([h, w, h, w]).vertices });
  const only = { units: 'cm', kerf: 0, margin: 0, allowance: 1, sheets: [{ id: 's', width: 210, length: 250, price: 100 }] };

  // Three 70s make 210 exactly, and 70 + 70 + 71 is the centimetre over.
  const across = plan([slab('a', 70, 100), slab('b', 70, 100), slab('c', 71, 100)], only);
  assert.equal(across.leftovers.length, 0);
  assert.equal(across.sheets.length, 1);

  // The same centimetre along the sheet buys nothing: 251 does not go into 250.
  const along = plan([slab('d', 100, 251)], only);
  assert.equal(along.leftovers.length, 1);
});
