import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPolygon } from '../src/geometry.js';
import { fillPrompt, pieceList, planJson, promptFor, promptTemplate, readPlan, sheetList } from '../src/aiplan.js';
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

test('the prompt names each list where it goes, and takes it back', () => {
  const template = promptTemplate(config);
  assert.deepEqual(template.match(/\[(sheets|pieces|plan)\]/g), ['[sheets]', '[pieces]', '[plan]']);

  const filled = fillPrompt(template, { sheets: sheetList(config), pieces: pieceList(pieces), plan: '{}' });
  assert.equal(filled.match(/\[(sheets|pieces|plan)\]/g), null);
  assert.match(filled, /big: 210 x 250/);
  assert.match(filled, /^ {2}1 \(west\)/m);
  assert.match(filled, /\{\}$/);
});

test('a list nobody supplied leaves its token standing rather than a hole', () => {
  assert.match(fillPrompt('take [sheets] and [pieces]', { sheets: 'these' }), /take these and \[pieces\]/);
});

test('the checker holds a plan to the kerf the nesters pack to', () => {
  const withKerf = { ...config, kerf: 2 };
  // Touching along a cut line is fine at kerf nought and not fine at kerf 2.
  assert.deepEqual(readPlan(asPlan([at('1', 0, 0), at('2', 100, 0)]), pieces, config).problems, []);
  assert.match(
    readPlan(asPlan([at('1', 0, 0), at('2', 100, 0)]), pieces, withKerf).problems.join(' '),
    /1 and 2 are less than 2 cm apart/,
  );
  assert.deepEqual(readPlan(asPlan([at('1', 0, 0), at('2', 102, 0)]), pieces, withKerf).problems, []);
});

test('the prompt says whatever the config says about the saw cut and the tolerance', () => {
  assert.match(promptFor(pieces, { ...config, kerf: 0, allowance: 1 }), /butt straight up against each other/);
  assert.match(promptFor(pieces, { ...config, kerf: 0, allowance: 1 }), /you have 1 cm more than the sheet says/);
  assert.match(promptFor(pieces, { ...config, kerf: 0.5 }), /Leave 0\.5 cm between pieces for the saw cut/);
  assert.doesNotMatch(promptFor(pieces, { ...config, kerf: 0.5 }), /butt straight up/);
});

test('a plan survives its own rounding — the millimetre it is written at', () => {
  // Two pieces butted against each other at a coordinate that does not land on
  // a millimetre: written out, the pair move toward each other and must not
  // then be called overlapping.
  const tight = JSON.stringify({ sheets: [{ sheet: 'big', pieces: [at('1', 0, 0), at('2', 100.04, 0)] }] });
  assert.deepEqual(readPlan(tight, pieces, config).problems, []);
  // A millimetre of rounding is forgiven; a centimetre of overlap is not.
  const clashing = JSON.stringify({ sheets: [{ sheet: 'big', pieces: [at('1', 0, 0), at('2', 99, 0)] }] });
  assert.match(readPlan(clashing, pieces, config).problems.join(' '), /1 and 2 overlap/);
});

test('a written-out position is a plain number, not the float that made it', () => {
  const piece = { id: 'p', side: 'north', vertices: buildPolygon([100, 100, 100, 100]).vertices };
  const at706 = {
    sheets: [{ sheet: config.sheets[0], placements: [{ x: 70.6, y: 0, block: { placements: [{ piece, orientation: 0, vertices: piece.vertices }] } }] }],
  };
  assert.match(planJson(at706), /"x":70\.6,/);
});
