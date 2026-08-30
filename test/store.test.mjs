import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromDefaults } from '../src/store.js';

/**
 * The tolerance is typed on the Cut plan tab and kept with the settings, so
 * what the shipped catalogue says is only where a browser that has never been
 * here starts. These say that the starting point is the file's, and that a
 * catalogue without one starts at nought rather than at nothing.
 */

const cuts = { note: '', cuts: {} };

test('a new browser starts on the tolerance the catalogue ships with', () => {
  assert.equal(fromDefaults(cuts, { allowance: 1, sheets: [] }).settings.allowance, 1);
});

test('a catalogue that says nothing about tolerance starts at nought', () => {
  assert.equal(fromDefaults(cuts, { sheets: [] }).settings.allowance, 0);
});
