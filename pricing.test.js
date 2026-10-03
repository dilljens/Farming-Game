import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BALANCE_MAX,
    BALANCE_MIN,
    DEFAULT_ECON,
    DEFAULT_HARVEST,
    activeEcon,
    activeHarvest,
    applyScenario,
    balanceMult,
    computeMarketPrice,
    estateMult,
    eventMult,
    eventSwings,
    normalizeEcon,
    normalizeHarvest,
    normalizeRules,
    rubberbandMult,
    scenarioName,
    scarcityMult,
    seasonIndex,
    seasonMult
} from './pricing.js';

test('rules default off and ignore unknown keys', () => {
    const off = { scarcity: false, seasons: false, rubberband: false, estate: false, balance: false, events: false, customecon: false, customharvest: false };
    assert.deepEqual(normalizeRules(undefined), { ...off, econ: DEFAULT_ECON, harvest: DEFAULT_HARVEST });
    assert.deepEqual(normalizeRules({ scarcity: true, bogus: true }), { ...off, scarcity: true, econ: DEFAULT_ECON, harvest: DEFAULT_HARVEST });
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
    const r = computeMarketPrice(20000, 'grain', { rules: { scarcity: true }, avgOwned: 0.5, players: 6 });
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
    const hi = computeMarketPrice(20000, 'grain', {
        rules: { scarcity: true, seasons: true, rubberband: true }, avgOwned: 0, players: 2, progress: 0.99, rank: 0
    });
    // 2 * 1.25 * 1.1 = 2.75 => 55000
    assert.equal(hi.price, 55000);
    assert.ok(hi.mult <= 3);
});

test('balance: hot crop dear, ignored crops cheap', () => {
    // Room piles into fruit: fruit 30 of 33 crops => ratio 30/11 capped at 2x.
    const totals = { hay: 2, grain: 1, fruit: 30 };
    assert.equal(balanceMult('fruit', totals), BALANCE_MAX);
    assert.equal(balanceMult('hay', totals), BALANCE_MIN);
    assert.ok(balanceMult('grain', totals) < 1);
    // Even split => neutral.
    assert.equal(balanceMult('fruit', { hay: 5, grain: 5, fruit: 5 }), 1);
    // Empty room => neutral, non-crops untouched.
    assert.equal(balanceMult('fruit', { hay: 0, grain: 0, fruit: 0 }), 1);
    assert.equal(balanceMult('tractor', totals), 1);
});

test('balance is a host rule: hot fruit costs more only when enabled', () => {
    const totals = { hay: 1, grain: 1, fruit: 28 };
    const on = computeMarketPrice(25000, 'fruit', { rules: { balance: true }, totals });
    assert.ok(on.mult > 1);
    assert.ok(on.price > 25000);
    assert.deepEqual(on.notes, ['high demand']);
    const off = computeMarketPrice(25000, 'fruit', { rules: {}, totals });
    assert.deepEqual(off, { price: 25000, mult: 1, notes: [] });
});

test('events: deterministic, bounded ±50%, zero-sum across crops', () => {
    const a = eventSwings('AB', 2);
    const b = eventSwings('AB', 2);
    assert.deepEqual(a, b); // same room + season => same swings, every device
    for (const v of a) assert.ok(v >= -0.5 && v <= 0.5, `swing ${v} in range`);
    const sum = a[0] + a[1] + a[2];
    assert.ok(Math.abs(sum) < 1e-9, `swings sum to ~0 (got ${sum})`);
    // Different season (usually) reshuffles the meta.
    assert.notDeepEqual(eventSwings('AB', 2), eventSwings('AB', 3));
    // Zero-sum + bounds hold across thousands of room/season combos
    // (rescale, not clip, keeps the sum exact when centering overshoots).
    for (let i = 0; i < 2000; i++) {
        for (let s = 0; s < 4; s++) {
            const w = eventSwings('R' + i, s);
            for (const v of w) assert.ok(v >= -0.5 && v <= 0.5, `swing ${v} in range`);
            assert.ok(Math.abs(w[0] + w[1] + w[2]) < 1e-9, `swings sum to ~0 (got ${w})`);
        }
    }
    // Non-crops never swing.
    assert.equal(eventMult('tractor', 'AB', 2), 1);
});

test('events is a host rule with boom/bust notes', () => {
    const ctx = { rules: { events: true }, roomCode: 'AB', progress: 0.6 };
    const seen = new Set();
    for (const crop of ['hay', 'grain', 'fruit']) {
        const r = computeMarketPrice(20000, crop, ctx);
        seen.add(r.notes[0] || 'flat');
    }
    assert.ok(seen.size > 1, 'a season mixes booms, busts and flats');
    const off = computeMarketPrice(20000, 'fruit', { rules: {}, roomCode: 'AB', progress: 0.6 });
    assert.deepEqual(off, { price: 20000, mult: 1, notes: [] });
});

test('econ/harvest settings default, clamp, and keep tiers ordered', () => {
    assert.deepEqual(normalizeEcon(undefined), DEFAULT_ECON);
    assert.deepEqual(normalizeEcon({ debtCap: 999999, interestPct: -5, downPct: 'half' }),
        { debtCap: 500000, interestPct: 0, downPct: 20 });
    assert.deepEqual(normalizeHarvest(undefined), DEFAULT_HARVEST);
    const h = normalizeHarvest({ hayMidQty: 8, hayHighQty: 6, hayMidMult: 2, hayHighMult: 1.2, equipRate: 9, equipCap: 99 });
    assert.ok(h.hayHighQty > h.hayMidQty);
    assert.ok(h.hayHighMult >= h.hayMidMult);
    assert.equal(h.equipRate, 2);
    assert.equal(h.equipCap, 10);
});

test('custom numbers apply only when their checkbox is on', () => {
    // Unticked (or missing): standard game, whatever the stored numbers say.
    assert.deepEqual(activeEcon({}), DEFAULT_ECON);
    assert.deepEqual(activeEcon({ customecon: false, econ: { debtCap: 0 } }), DEFAULT_ECON);
    assert.deepEqual(activeHarvest({}), DEFAULT_HARVEST);
    // Ticked: normalized custom numbers.
    assert.deepEqual(activeEcon({ customecon: true, econ: { debtCap: 80000, interestPct: 5, downPct: 30 } }),
        { debtCap: 80000, interestPct: 5, downPct: 30 });
    assert.equal(activeHarvest({ customharvest: true, harvest: { equipCap: 3 } }).equipCap, 3);
    assert.equal(activeHarvest({ customharvest: true }).equipCap, DEFAULT_HARVEST.equipCap);
});

test('mix-and-match: every rule combo prices every asset sanely', () => {
    // Buying must never NaN, go negative, or escape the clamps — whatever
    // the host ticks. Hay additionally never rises above base.
    const flags = ['scarcity', 'seasons', 'rubberband', 'estate', 'balance', 'events'];
    const assets = ['hay', 'grain', 'fruit', 'farm', 'harvester', 'tractor', 'cows'];
    const bases = { hay: 15000 };
    const ctxs = [
        { avgOwned: 0, players: 4, rank: 0, progress: 0.6, myOwned: 2, totals: { hay: 1, grain: 1, fruit: 28 }, roomCode: 'AB' },
        { avgOwned: 2.5, players: 6, rank: 5, progress: 0.1, myOwned: 0, totals: { hay: 0, grain: 0, fruit: 0 }, roomCode: '' },
        { players: 0 } // empty room, bare ctx
    ];
    for (let mask = 0; mask < 64; mask++) {
        const rules = {};
        flags.forEach((f, i) => { if (mask & (1 << i)) rules[f] = true; });
        for (const asset of assets) {
            for (const c of ctxs) {
                const r = computeMarketPrice(bases[asset] || 20000, asset, { ...c, rules });
                assert.ok(Number.isFinite(r.price) && r.price >= 500, `mask ${mask} ${asset}: price ${r.price}`);
                assert.ok(r.mult >= 0.25 && r.mult <= 3, `mask ${mask} ${asset}: mult ${r.mult}`);
                if (asset === 'hay') assert.ok(r.mult <= 1, `mask ${mask} hay above base`);
            }
        }
    }
});

test('hay ceiling: hay never prices above base', () => {
    // Scarcity opener alone would 2x hay; the ceiling holds it at base.
    const r = computeMarketPrice(15000, 'hay', {
        rules: { scarcity: true }, avgOwned: 0, players: 4
    });
    assert.equal(r.mult, 1);
    assert.equal(r.price, 15000);
    // Hay still discounts when the room ignores it.
    const cheap = computeMarketPrice(15000, 'hay', {
        rules: { balance: true }, totals: { hay: 0, grain: 10, fruit: 10 }
    });
    assert.ok(cheap.mult < 1);
    assert.ok(cheap.price < 15000);
});

test('scenarios: every preset normalizes to playable rules', () => {
    for (const key of ['standard', 'drought', 'bull', 'debtfree']) {
        const r = applyScenario(key);
        assert.equal(r.scenario, key, `${key} stamps its name`);
        // Every scenario prices every asset sanely for a mid-size room.
        for (const asset of ['hay', 'grain', 'fruit', 'farm', 'cows', 'harvester', 'tractor']) {
            const out = computeMarketPrice(20000, asset, {
                rules: r, players: 4, rank: 1, progress: 0.3,
                avgOwned: 2, myOwned: 2, totals: { hay: 8, grain: 8, fruit: 8 }, roomCode: 'AB'
            });
            assert.ok(Number.isFinite(out.price) && out.price > 0, `${key}/${asset} sane price`);
        }
    }
    assert.equal(applyScenario('bogus').scenario, undefined, 'unknown preset => no stamp');
});

test('scenarios: drought is harsher than standard', () => {
    const dry = applyScenario('drought');
    const econ = activeEcon(dry);
    const harvest = activeHarvest(dry);
    assert.ok(dry.customecon && dry.customharvest, 'drought enables both number groups');
    assert.ok(econ.debtCap < DEFAULT_ECON.debtCap, 'tighter credit');
    assert.ok(econ.interestPct > DEFAULT_ECON.interestPct, 'pricier debt');
    assert.ok(econ.downPct > DEFAULT_ECON.downPct, 'bigger down payments');
    assert.ok(harvest.hayMidQty > DEFAULT_HARVEST.hayMidQty, 'mid tier harder to reach');
    assert.ok(harvest.hayMidMult < DEFAULT_HARVEST.hayMidMult, 'mid tier pays less');
    assert.ok(harvest.hayHighMult < DEFAULT_HARVEST.hayHighMult, 'high tier pays less');
    assert.ok(harvest.equipRate < DEFAULT_HARVEST.equipRate, 'weaker equipment bonus');
});

test('scenarios: bull market is boom/bust with standard money', () => {
    const bull = applyScenario('bull');
    assert.ok(bull.events && bull.balance && bull.scarcity, 'bull enables rotation rules');
    assert.ok(!bull.customecon && !bull.customharvest, 'money/harvest stay standard');
    assert.deepEqual(activeEcon(bull), DEFAULT_ECON);
    assert.deepEqual(activeHarvest(bull), DEFAULT_HARVEST);
});

test('scenarios: debt-free means cash only', () => {
    const free = applyScenario('debtfree');
    const econ = activeEcon(free);
    assert.equal(econ.debtCap, 0, 'no borrowing room');
    assert.equal(econ.downPct, 100, 'everything is full down payment');
});

test('scenarios: badge names presets, standard, and custom', () => {
    assert.equal(scenarioName(undefined), 'Standard');
    assert.equal(scenarioName({}), 'Standard');
    assert.equal(scenarioName(applyScenario('drought')), 'Drought');
    assert.equal(scenarioName(applyScenario('bull')), 'Bull Market');
    assert.equal(scenarioName({ scarcity: true }), 'Custom', 'hand-mixed rules show Custom');
    assert.equal(scenarioName({ scenario: 'bogus' }), 'Standard', 'forged stamp falls back');
    assert.equal(scenarioName({ scenario: 'bull', events: false }), 'Bull Market', 'stamp wins while present');
});
