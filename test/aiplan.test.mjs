import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPolygon } from '../src/geometry.js';
import { planJson, promptFor, readPlan } from '../src/aiplan.js';
import { plan } from '../src/nest.js';

const piece = (id) => ({ id, side: 'west', edges: [100, 100, 100, 100], vertices: buildPolygon([100, 100, 100, 100]).vertices });
const pieces = [piece('1'), piece('2')];
const config = { kerf: 0, margin: 0, sheets: [{ id: 'big', width: 210, length: 250, price: 100 }] };
const at = (id, x, y, orientation = 0) => ({ id, x, y, orientation });
const asPlan = (spots) => JSON.stringify({ sheets: [{ sheet: 'big', pieces: spots }] });

test('a legal arrangement comes back clean, and priced', () => {
  const { problems, sheets, cost } = readPlan(asPlan([at('1', 0, 0), at('2', 105, 0)]), pieces, config);
  assert.deepEqual(problems, []);
  assert.equal(sheets.length, 1);
  assert.equal(cost, 100);
});

test('overlapping pieces are caught', () => {
  const { problems } = readPlan(asPlan([at('1', 0, 0), at('2', 50, 50)]), pieces, config);
  assert.match(problems.join(' '), /1 and 2 overlap/);
});

test('touching along a cut line is not an overlap', () => {
  const { problems } = readPlan(asPlan([at('1', 0, 0), at('2', 100, 0)]), pieces, config);
  assert.deepEqual(problems, []);
});

test('a piece off the edge of the sheet is caught', () => {
  const { problems } = readPlan(asPlan([at('1', 0, 0), at('2', 150, 0)]), pieces, config);
  assert.match(problems.join(' '), /hangs off sheet/);
});

test('a piece left out, or placed twice, is caught', () => {
  assert.match(readPlan(asPlan([at('1', 0, 0)]), pieces, config).problems.join(' '), /Never placed: 2/);
  assert.match(
    readPlan(asPlan([at('1', 0, 0), at('1', 105, 0), at('2', 0, 105)]), pieces, config).problems.join(' '),
    /Placed more than once: 1/
  );
});

test('a quarter turn is refused', () => {
  const { problems } = readPlan(asPlan([at('1', 0, 0, 90), at('2', 105, 0)]), pieces, config);
  assert.match(problems.join(' '), /orientation 90 is not allowed/);
});

test('a sheet or piece that does not exist is named, not crashed on', () => {
  const bad = JSON.stringify({ sheets: [{ sheet: 'nope', pieces: [at('1', 0, 0)] }, { sheet: 'big', pieces: [at('99', 0, 0)] }] });
  const { problems } = readPlan(bad, pieces, config);
  assert.match(problems.join(' '), /no such sheet as "nope"/);
  assert.match(problems.join(' '), /no such piece as "99"/);
});

test('anything that is not JSON is reported rather than thrown', () => {
  assert.match(readPlan('here is your plan!', pieces, config).problems[0], /not JSON/);
});

test('the prompt carries the rules, the sheets and the corners', () => {
  const text = promptFor(pieces, config);
  assert.match(text, /half turn/);
  assert.match(text, /No quarter\s+turns and no mirroring/);
  assert.match(text, /big: 210 x 250/);
  assert.match(text, /corners \[0,0\]/);
});

test('a plan written out is read back as the same arrangement', () => {
  const nested = plan(pieces, config);
  const { problems, sheets, cost } = readPlan(planJson(nested), pieces, config);
  assert.deepEqual(problems, []);
  assert.equal(sheets.length, nested.sheets.length);
  assert.equal(cost, nested.cost);
});

test('a half turn survives being written out, whichever nester labelled it', () => {
  const turned = { ...pieces[0], vertices: pieces[0].vertices };
  const asSheet = (orientation) => ({
    sheets: [
      {
        sheet: config.sheets[0],
        placements: [{ x: 0, y: 0, block: { placements: [{ piece: turned, orientation, vertices: turned.vertices }] } }],
      },
    ],
  });
  // nest.js says 180, nest-blf.js says 1; both mean the same half turn.
  assert.equal(JSON.parse(planJson(asSheet(180))).sheets[0].pieces[0].orientation, 180);
  assert.equal(JSON.parse(planJson(asSheet(1))).sheets[0].pieces[0].orientation, 180);
  assert.equal(JSON.parse(planJson(asSheet(0))).sheets[0].pieces[0].orientation, 0);
});
