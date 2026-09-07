import assert from 'node:assert/strict';
import test from 'node:test';
import {
    computeMarketPrice,
    estateMult,
    normalizeRules,
    rubberbandMult,
    scarcityMult,
    seasonIndex,
    seasonMult
} from './pricing.js';

test('rules default off and ignore unknown keys', () => {
    assert.deepEqual(normalizeRules(undefined), { scarcity: false, seasons: false, rubberband: false, estate: false });
    assert.deepEqual(normalizeRules({ scarcity: true, bogus: true }), { scarcity: true, seasons: false, rubberband: false, estate: false });
});

test('scarcity: avg 1 => base, glut floors, empty room neutral', () => {
    assert.equal(scarcityMult(1, 6), 1);
    assert.equal(scarcityMult(3, 6), 0.5); // avg 3 => 2-3 floored
    assert.equal(scarcityMult(0, 6), 2); // nobody owns any => land-grab opener
    assert.equal(scarcityMult(0, 0), 1); // no market yet
    assert.equal(scarcityMult(NaN, 6), 1);
});

test('season quarters from progress fraction', () => {
    assert.equal(seasonIndex(0), 0);
    assert.equal(seasonIndex(0.24), 0);
    assert.equal(seasonIndex(0.25), 1);
    assert.equal(seasonIndex(0.5), 2);
    assert.equal(seasonIndex(0.99), 3);
    assert.equal(seasonIndex(5), 3);
    assert.equal(seasonIndex(-1), 0);
});

test('season table: fall harvest cheap, winter dear', () => {
    assert.equal(seasonMult('hay', 2), 0.8);
    assert.equal(seasonMult('hay', 3), 1.25);
    assert.equal(seasonMult('fruit', 1), 0.85);
    assert.equal(seasonMult('tractor', 3), 1); // equipment untouched
    assert.equal(seasonMult('hay', 9), 1);
});

test('rubberband: leader taxed, trailer aided, middle neutral', () => {
    assert.equal(rubberbandMult(0, 6), 1.1);
    assert.equal(rubberbandMult(5, 6), 0.9);
    assert.equal(rubberbandMult(2, 6), 1);
    assert.equal(rubberbandMult(0, 1), 1); // solo => neutral
    assert.equal(rubberbandMult(undefined, 6), 1);
});

test('estate: tenth-percent per owned unit', () => {
    assert.equal(estateMult(0), 1);
    assert.equal(estateMult(3), 1.3);
    assert.equal(estateMult(-2), 1);
});

test('all rules off => base price, no notes', () => {
    const r = computeMarketPrice(20000, 'hay', { rules: {} });
    assert.deepEqual(r, { price: 20000, mult: 1, notes: [] });
});

test('scarcity-only example: avg 0.5 => 1.5x, rounded to $500', () => {
    const r = computeMarketPrice(20000, 'hay', { rules: { scarcity: true }, avgOwned: 0.5, players: 6 });
    assert.equal(r.mult, 1.5);
    assert.equal(r.price, 30000);
    assert.deepEqual(r.notes, ['scarce']);
});

test('combined mults multiply then round: 1.1 tax x 1.1 estate on 25k', () => {
    const r = computeMarketPrice(25000, 'farm', {
        rules: { rubberband: true, estate: true }, rank: 0, players: 4, myOwned: 1
    });
    assert.equal(r.price, 30500); // 25000*1.21=30250 -> 30500
    assert.deepEqual(r.notes, ['leader tax', 'estate x1.1']);
});

test('combined mult clamps to [0.25, 3]', () => {
    const hi = computeMarketPrice(20000, 'hay', {
        rules: { scarcity: true, seasons: true, rubberband: true }, avgOwned: 0, players: 2, progress: 0.99, rank: 0
    });
    // 2 * 1.25 * 1.1 = 2.75 => 55000
    assert.equal(hi.price, 55000);
    assert.ok(hi.mult <= 3);
});
