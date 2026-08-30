import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDesigns } from '../src/render.js';

/**
 * The design list is the only way into a design, so what a row offers is what
 * the page can do. These say which buttons a row has and when it says which
 * design is the one being worked on.
 */

const design = (name, pieces = 2) => ({
  name,
  cuts: Object.fromEntries(Array.from({ length: pieces }, (_, i) => [String(i + 1), { edges: [10, 10, 10] }])),
  flags: [],
});

/** One row's markup, by the id it was built from. */
const rowFor = (html, id) => {
  const start = html.indexOf(`data-design="${id}"`);
  assert.notEqual(start, -1, `no row for ${id}`);
  return html.slice(html.lastIndexOf('<li', start), html.indexOf('</li>', start));
};

const buttons = (row) => [...row.matchAll(/class="design-(open|edit)[^"]*"/g)].map((m) => m[1]);

test('an empty list offers a roof to start from rather than an empty list', () => {
  const html = renderDesigns({}, null, 'cm');
  assert.match(html, /id="design-new"/);
  assert.doesNotMatch(html, /design-row/);
});

test('the roof we ship is offered only when there is nothing to open', () => {
  assert.doesNotMatch(renderDesigns({ a: design('One') }, 'a', 'cm'), /id="design-new"/);
});

test('every row can be edited', () => {
  const html = renderDesigns({ a: design('One'), b: design('Two') }, 'a', 'cm');
  assert.deepEqual(buttons(rowFor(html, 'a')).includes('edit'), true);
  assert.deepEqual(buttons(rowFor(html, 'b')).includes('edit'), true);
});

test('a design that is not the current one can be opened', () => {
  const html = renderDesigns({ a: design('One'), b: design('Two') }, 'a', 'cm');
  assert.deepEqual(buttons(rowFor(html, 'b')), ['open', 'edit']);
});

test('the current design has nothing to open, so it does not offer it', () => {
  const html = renderDesigns({ a: design('One'), b: design('Two') }, 'a', 'cm');
  assert.deepEqual(buttons(rowFor(html, 'a')), ['edit']);
});

test('the current design is marked as such when there is another to confuse it with', () => {
  const html = renderDesigns({ a: design('One'), b: design('Two') }, 'a', 'cm');
  assert.match(rowFor(html, 'a'), /<span class="tag">current<\/span>/);
  assert.doesNotMatch(rowFor(html, 'b'), /class="tag"/);
});

test('one design on its own is not marked current — there is nothing it could be current against', () => {
  const html = renderDesigns({ a: design('One') }, 'a', 'cm');
  const row = rowFor(html, 'a');
  assert.doesNotMatch(row, /class="tag"/);
  assert.doesNotMatch(row, /design-row current/);
  // Still the current one, so still nothing to open.
  assert.deepEqual(buttons(row), ['edit']);
});

test('the name is escaped rather than pasted into the markup', () => {
  const html = renderDesigns({ a: design('<script>x</script>') }, 'a', 'cm');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('a row says how many pieces the design holds', () => {
  const html = renderDesigns({ a: design('One', 1), b: design('Two', 7) }, 'a', 'cm');
  assert.match(rowFor(html, 'a'), /1 piece</);
  assert.match(rowFor(html, 'b'), /7 pieces</);
});
