import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BALANCE_MAX,
    BALANCE_MIN,
    DEFAULT_ECON,
    DEFAULT_HARVEST,
    DEFAULT_TUNING,
    activeEcon,
    activeHarvest,
    applyScenario,
    balanceMult,
    boardMaxNetWorth,
    bulkMult,
    bulkNext,
    computeMarketPrice,
    driftDollars,
    earnedTotals,
    estateMult,
    eventDollars,
    eventSwings,
    eventWalk,
    harvestClock,
    marketBasis,
    normalizeEcon,
    normalizeHarvest,
    normalizeRules,
    normalizeTuning,
    rubberbandMult,
    scenarioName,
    seasonMult
} from './pricing.js';

test('rules default off and ignore unknown keys', () => {
    const off = { seasons: false, rubberband: false, estate: false, balance: false, events: false, customecon: false, customharvest: false };
    assert.deepEqual(normalizeRules(undefined), { ...off, econ: DEFAULT_ECON, harvest: DEFAULT_HARVEST, tuning: DEFAULT_TUNING });
    assert.deepEqual(normalizeRules({ seasons: true, bogus: true }), { ...off, seasons: true, econ: DEFAULT_ECON, harvest: DEFAULT_HARVEST, tuning: DEFAULT_TUNING });
});

test('retired market/scarcity keys are ignored, old rooms just lose the rule', () => {
    const off = { seasons: false, rubberband: false, estate: false, balance: false, events: false, customecon: false, customharvest: false };
    assert.deepEqual(normalizeRules({ market: true, scarcity: true, tuning: { market: 200, scarcity: 200 } }),
        { ...off, econ: DEFAULT_ECON, harvest: DEFAULT_HARVEST, tuning: DEFAULT_TUNING });
});

test('seasons: harvest clock starts normal, walks up and back, scales with players', () => {
    for (const crop of ['hay', 'grain', 'fruit']) {
        assert.equal(seasonMult(crop, 0, 4), 1, `${crop} starts at base`);
        assert.equal(seasonMult(crop, 0, 0), 1, 'no players => no market');
        assert.equal(seasonMult(crop, -5, 4), 1, 'negative harvests clamp to start');
    }
    assert.equal(seasonMult('tractor', 10, 4), 1, 'equipment untouched');
    assert.equal(seasonMult('weeds', 10, 4), 1, 'unknown asset neutral');
    assert.equal(harvestClock({ hay: 2, grain: 3, fruit: 5 }), 10);
    assert.equal(harvestClock({}), 0);
    assert.equal(harvestClock(undefined), 0);
    // Full cycle returns to normal: hay period is 4 harvests per player.
    assert.equal(seasonMult('hay', 16, 4), 1, 'hay cycle is 16 harvests for 4 players');
    assert.equal(seasonMult('hay', 8, 4), 1.25, 'mid-cycle peak');
    // Bigger rooms swing slower: same harvest count, earlier phase.
    assert.ok(seasonMult('hay', 4, 2) > seasonMult('hay', 4, 4), 'more players, slower walk');
    // Crops desync so the dear crop rotates.
    assert.notEqual(seasonMult('hay', 4, 2), seasonMult('fruit', 4, 2));
    // Bounds hold across rooms and harvest counts.
    for (let p = 1; p <= 8; p++) {
        for (let h = 0; h < 200; h++) {
            for (const crop of ['hay', 'grain', 'fruit']) {
                const m = seasonMult(crop, h, p);
                assert.ok(m >= 1 && m <= 1.25, `${crop} H=${h} P=${p} in [1, 1.25]`);
            }
        }
    }
});

test('seasons: mid-cycle peaks carry a high-season note, hay ceiling holds', () => {
    // Hay, 2 players: cycle 8 harvests; H=4 is mid-cycle => seasons pushes
    // 1.25x, inside the $20k hay ceiling (the note names the rule).
    const r = computeMarketPrice(15000, 'hay', {
        rules: { seasons: true }, totals: { hay: 2, grain: 1, fruit: 1 }, players: 2
    });
    assert.equal(r.mult, 1.25);
    assert.equal(r.price, 18800);
    assert.deepEqual(r.notes, ['high season ×1.25']);
    const grain = computeMarketPrice(20000, 'grain', {
        rules: { seasons: true }, totals: { hay: 2, grain: 1, fruit: 1 }, players: 2
    });
    assert.ok(grain.mult > 1 && grain.mult <= 1.25);
    assert.deepEqual(grain.notes, ['high season ×1.2']);
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

test('market basis: starting units excluded, remainder per-capita', () => {
    // 8-player room UP: 11 hay / 10 grain on the board is nearly all grant.
    assert.deepEqual(earnedTotals({ hay: 11, grain: 10, fruit: 0 }, 8), { hay: 3, grain: 2, fruit: 0 });
    assert.deepEqual(marketBasis({ hay: 11, grain: 10, fruit: 0 }, 8), { hay: 0.375, grain: 0.25, fruit: 0 });
    // Solo opening prices at exactly base.
    assert.deepEqual(marketBasis({ hay: 1, grain: 1, fruit: 0 }, 1), { hay: 0, grain: 0, fruit: 0 });
    // Grant floors at zero; empty rooms are safe.
    assert.deepEqual(marketBasis({ hay: 0, grain: 1, fruit: 0 }, 4), { hay: 0, grain: 0, fruit: 0 });
    assert.deepEqual(marketBasis({ hay: 5, grain: 5, fruit: 5 }, 0), { hay: 5, grain: 5, fruit: 5 });
});

test('market basis calms big rooms: UP grain demand-only, solo at base', () => {
    const ctx = { rules: { balance: true, seasons: true, events: true }, players: 8, rank: undefined, avgOwned: 0, myOwned: 0, roomCode: 'UP' };
    const grain = computeMarketPrice(20000, 'grain', { ...ctx, totals: marketBasis({ hay: 11, grain: 10, fruit: 0 }, 8) });
    assert.equal(grain.price, 24200);
    assert.deepEqual(grain.notes, ['high demand ×1.2']);
    const solo = computeMarketPrice(20000, 'grain', { ...ctx, players: 1, totals: marketBasis({ hay: 1, grain: 1, fruit: 0 }, 1) });
    assert.deepEqual(solo, { price: 20000, mult: 1, notes: [] });
});

test('combined mults multiply then round: 1.1 tax x 1.1 estate on 25k', () => {
    const r = computeMarketPrice(25000, 'farm', {
        rules: { rubberband: true, estate: true }, rank: 0, players: 4, myOwned: 1
    });
    assert.equal(r.price, 30300); // 25000*1.21=30250 -> 30300
    assert.deepEqual(r.notes, ['leader tax ×1.1', 'estate ×1.1']);
});

test('combined mult clamps to [0.25, 3]', () => {
    const hi = computeMarketPrice(20000, 'tractor', {
        rules: { rubberband: true, estate: true }, rank: 0, players: 4, myOwned: 25
    });
    // 1.1 x 3.5 = 3.85 => clamped to 3 => 60000
    assert.equal(hi.mult, 3);
    assert.equal(hi.price, 60000);
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
    assert.equal(on.price, 49900); // 2x demand minus the $100 mean-reversion drift
    assert.deepEqual(on.notes, ['high demand ×2', 'drift -$100']);
    const off = computeMarketPrice(25000, 'fruit', { rules: {}, totals });
    assert.deepEqual(off, { price: 25000, mult: 1, notes: [] });
});

test('events: each crop walks ±$100 a harvest, deterministic per room', () => {
    // No harvests => flat; junk counts clamp to flat; non-crops never walk.
    assert.equal(eventWalk('grain', 'AB', 0), 0);
    assert.equal(eventWalk('grain', 'AB', -5), 0);
    assert.equal(eventWalk('tractor', 'AB', 50), 0);
    assert.equal(eventWalk('weeds', 'AB', 50), 0);
    // Every single step is exactly ±$100.
    for (const crop of ['hay', 'grain', 'fruit']) {
        for (let h = 0; h < 200; h++) {
            const step = eventWalk(crop, 'AB', h + 1) - eventWalk(crop, 'AB', h);
            assert.ok(step === 100 || step === -100, `${crop} harvest ${h} steps $${step}`);
        }
    }
    // Crops walk separately — same room and harvest count, different paths.
    const paths = ['hay', 'grain', 'fruit'].map((c) => eventWalk(c, 'AB', 50));
    assert.ok(new Set(paths).size > 1, 'walks diverge across crops');
    // More harvests keep walking (path extends, never restarts).
    assert.notEqual(eventWalk('grain', 'AB', 50), eventWalk('grain', 'AB', 51));
});

test('events: deterministic, bounded, zero-sum across crops', () => {
    const base = 20000;
    const a = eventSwings('AB', 25, base);
    const b = eventSwings('AB', 25, base);
    assert.deepEqual(a, b); // same room + harvest count => same swings, every device
    for (const v of a) assert.ok(v >= -0.5 * base && v <= 0.5 * base, `swing $${v} in range`);
    const sum = a[0] + a[1] + a[2];
    assert.ok(Math.abs(sum) < 1e-6, `swings sum to ~$0 (got $${sum})`);
    // Zero harvests => flat walk.
    assert.deepEqual(eventSwings('AB', 0, base), [0, 0, 0]);
    // More harvests move the walk (26 can echo 25 when every crop steps the
    // same way, so compare across a wider gap).
    assert.notDeepEqual(eventSwings('AB', 25, base), eventSwings('AB', 35, base));
    // A tighter host cap holds: custom 10% ceiling on a 100-harvest walk.
    for (const v of eventSwings('AB', 100, base, 0.1)) assert.ok(v >= -0.1 * base && v <= 0.1 * base, `swing $${v} in cap`);
    // Zero-sum + bounds hold across hundreds of rooms and walk lengths
    // (rescale, not clip, keeps the sum exact when centering overshoots).
    for (let i = 0; i < 500; i++) {
        for (const h of [1, 7, 25, 100, 300]) {
            const w = eventSwings('R' + i, h, base);
            for (const v of w) assert.ok(v >= -0.5 * base && v <= 0.5 * base, `swing $${v} in range`);
            assert.ok(Math.abs(w[0] + w[1] + w[2]) < 1e-6, `swings sum to ~$0 (got ${w})`);
        }
    }
    // Non-crops never swing.
    assert.equal(eventDollars('tractor', 'AB', 25, base), 0);
});

test('events is a host rule with boom/bust notes', () => {
    // 15 room harvests: grain busts, fruit booms, hay holds near flat.
    const ctx = { rules: { events: true }, roomCode: 'AB', totals: { hay: 5, grain: 5, fruit: 5 } };
    const seen = new Set();
    for (const crop of ['hay', 'grain', 'fruit']) {
        const r = computeMarketPrice(20000, crop, ctx);
        seen.add(r.notes[0] || 'flat');
    }
    assert.ok(seen.size > 1, 'a walk mixes booms, busts and flats');
    const off = computeMarketPrice(20000, 'fruit', { rules: {}, roomCode: 'AB', totals: { hay: 5, grain: 5, fruit: 5 } });
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
    // the host ticks. Hay additionally never rises above $20k, fruit never
    // drops below $20k.
    const flags = ['seasons', 'rubberband', 'estate', 'balance', 'events'];
    const assets = ['hay', 'grain', 'fruit', 'farm', 'harvester', 'tractor', 'cows'];
    const bases = { hay: 15000 };
    const ctxs = [
        { avgOwned: 0, players: 4, rank: 0, myOwned: 2, totals: { hay: 1, grain: 1, fruit: 28 }, roomCode: 'AB' },
        { avgOwned: 2.5, players: 6, rank: 5, myOwned: 0, totals: { hay: 0, grain: 0, fruit: 0 }, roomCode: '' },
        { players: 0 } // empty room, bare ctx
    ];
    for (let mask = 0; mask < 32; mask++) {
        const rules = {};
        flags.forEach((f, i) => { if (mask & (1 << i)) rules[f] = true; });
        for (const asset of assets) {
            for (const c of ctxs) {
                const r = computeMarketPrice(bases[asset] || 20000, asset, { ...c, rules });
                assert.ok(Number.isFinite(r.price) && r.price >= 500, `mask ${mask} ${asset}: price ${r.price}`);
                assert.ok(r.mult >= 0.25 && r.mult <= 3, `mask ${mask} ${asset}: mult ${r.mult}`);
                if (asset === 'hay') {
                    assert.ok(r.mult <= 20000 / 15000 + 1e-9, `mask ${mask} hay above $20k`);
                    assert.ok(r.price <= 20000, `mask ${mask} hay price above $20k`);
                }
                if (asset === 'fruit') {
                    assert.ok(r.mult >= 20000 / 25000 - 1e-9, `mask ${mask} fruit below $20k`);
                    assert.ok(r.price >= 20000, `mask ${mask} fruit price below $20k`);
                }
            }
        }
    }
});

test('hay ceiling: hay never prices above $20k', () => {
    // Balance alone would 2x hay when the room piles in; the $20k ceiling
    // holds it (the $100 downward drift still applies underneath).
    const r = computeMarketPrice(15000, 'hay', {
        rules: { balance: true }, totals: { hay: 28, grain: 1, fruit: 1 }
    });
    assert.ok(r.mult <= 20000 / 15000 + 1e-9);
    assert.equal(r.price, 19900);
    assert.deepEqual(r.notes, ['high demand ×2', 'drift -$100']);
    // Hay still discounts when the room ignores it.
    const cheap = computeMarketPrice(15000, 'hay', {
        rules: { balance: true }, totals: { hay: 0, grain: 10, fruit: 10 }
    });
    assert.ok(cheap.mult < 1);
    assert.ok(cheap.price < 15000);
});

test('estate covers cattle: room-average cows surcharge ranch prices', () => {
    // Room averages 2 head (combined farm + ranch counts): 1.2x on $10k.
    const r = computeMarketPrice(10000, 'cows', {
        rules: { estate: true }, myOwned: 2, players: 4
    });
    assert.equal(r.mult, 1.2);
    assert.equal(r.price, 12000);
    assert.deepEqual(r.notes, ['estate ×1.2']);
    // No cattle on average => base, no note.
    const flat = computeMarketPrice(10000, 'cows', {
        rules: { estate: true }, myOwned: 0, players: 4
    });
    assert.deepEqual(flat, { price: 10000, mult: 1, notes: [] });
});

test('fruit floor: fruit never prices below $20k', () => {
    // Balance alone would halve ignored fruit; the $20k floor holds it (the
    // $100 upward drift still applies underneath).
    const r = computeMarketPrice(25000, 'fruit', {
        rules: { balance: true }, totals: { hay: 10, grain: 10, fruit: 0 }
    });
    assert.ok(r.mult >= 20000 / 25000 - 1e-9);
    assert.equal(r.price, 20100);
    assert.deepEqual(r.notes, ['low demand ×0.5', 'drift +$100']);
    // A bust walk clips at base too (same as hay booms clip at base).
    const bust = computeMarketPrice(25000, 'fruit', {
        rules: { events: true }, totals: { hay: 0, grain: 0, fruit: 0 }, roomCode: 'FLOOR'
    });
    assert.ok(bust.mult >= 1);
    assert.ok(bust.price >= 25000);
    // Fruit still rises when the room piles in.
    const dear = computeMarketPrice(25000, 'fruit', {
        rules: { balance: true }, totals: { hay: 1, grain: 1, fruit: 28 }
    });
    assert.ok(dear.mult > 1);
    assert.ok(dear.price > 25000);
});

test('fresh rooms open at base: starting holdings move no rule', () => {
    // 4 players holding only their starting 1 hay + 1 grain, every rule on.
    const totals = marketBasis({ hay: 4, grain: 4, fruit: 0 }, 4);
    assert.deepEqual(totals, { hay: 0, grain: 0, fruit: 0 });
    const rules = { balance: true, seasons: true, rubberband: true, estate: true, events: true };
    for (const [asset, base] of [['hay', 15000], ['grain', 20000], ['fruit', 25000], ['farm', 5000], ['harvester', 10000], ['tractor', 10000]]) {
        const r = computeMarketPrice(base, asset, { rules, totals, players: 4, roomCode: 'FRESH' });
        assert.equal(r.price, base, `${asset} opens at base`);
        assert.deepEqual(r.notes, [], `${asset} opens with no modifiers`);
    }
});

test('scenarios: every preset normalizes to playable rules', () => {
    for (const key of ['standard', 'drought', 'bull', 'debtfree']) {
        const r = applyScenario(key);
        assert.equal(r.scenario, key, `${key} stamps its name`);
        // Every scenario prices every asset sanely for a mid-size room.
        for (const asset of ['hay', 'grain', 'fruit', 'farm', 'cows', 'harvester', 'tractor']) {
            const out = computeMarketPrice(20000, asset, {
                rules: r, players: 4, rank: 1,
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
    assert.ok(bull.events && bull.balance, 'bull enables rotation rules');
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
    assert.equal(scenarioName({ seasons: true }), 'Custom', 'hand-mixed rules show Custom');
    assert.equal(scenarioName({ scenario: 'bogus' }), 'Standard', 'forged stamp falls back');
    assert.equal(scenarioName({ scenario: 'bull', events: false }), 'Bull Market', 'stamp wins while present');
});

test('bulk tiers: benchmarks unlock increments, hay/grain climb highest', () => {
    // Below the first benchmark: single only, every asset.
    for (const asset of ['hay', 'grain', 'farm', 'cows', 'tractor']) {
        assert.equal(bulkMult(0, asset), 1, `${asset} @0`);
        assert.equal(bulkMult(149999, asset), 1, `${asset} @149999`);
    }
    // $150k: hay/grain unlock 2x early; the rest wait for $250k.
    assert.equal(bulkMult(150000, 'hay'), 2);
    assert.equal(bulkMult(200000, 'grain'), 2);
    assert.equal(bulkMult(200000, 'farm'), 1, 'non-bulk still single below $250k');
    assert.equal(bulkMult(200000, 'cows'), 1, 'ridges wait for $250k');
    // $250k: everything unlocks 2x (the documented OTB rule, now enforced),
    // and hay/grain climb to 3x.
    for (const asset of ['hay', 'grain', 'farm', 'cows', 'harvester', 'tractor', 'fruit']) {
        assert.ok(bulkMult(250000, asset) >= 2, `${asset} @250k`);
    }
    assert.equal(bulkMult(250000, 'hay'), 3);
    assert.equal(bulkMult(300000, 'grain'), 3);
    assert.equal(bulkMult(300000, 'farm'), 2, 'non-bulk capped at 2x');
    // $500k: hay/grain reach 5x, everything else still 2x.
    assert.equal(bulkMult(500000, 'hay'), 5);
    assert.equal(bulkMult(5000000, 'grain'), 5, 'never above 5x');
    assert.equal(bulkMult(5000000, 'tractor'), 2, 'never above 2x off-bulk');
    // Junk input stays safe.
    assert.equal(bulkMult(NaN, 'hay'), 1);
    assert.equal(bulkMult(-100, 'hay'), 1);
    assert.equal(bulkMult(1000000, 'weeds'), 2, 'unknown asset treated as non-bulk');
    assert.equal(bulkMult(200000, 'weeds'), 1);
});

test('bulk next: hint line names the coming tier or null at max', () => {
    assert.deepEqual(bulkNext(0, 'hay'), { mult: 2, min: 150000 });
    assert.deepEqual(bulkNext(200000, 'hay'), { mult: 3, min: 250000 });
    assert.deepEqual(bulkNext(300000, 'grain'), { mult: 5, min: 500000 });
    assert.equal(bulkNext(500000, 'hay'), null, 'hay maxed at 5x');
    assert.deepEqual(bulkNext(0, 'farm'), { mult: 2, min: 250000 });
    assert.deepEqual(bulkNext(200000, 'farm'), { mult: 2, min: 250000 });
    assert.equal(bulkNext(250000, 'farm'), null, 'non-bulk maxes at 2x');
});

test('board max: highest net worth wins, empty/junk is zero', () => {
    assert.equal(boardMaxNetWorth([]), 0);
    assert.equal(boardMaxNetWorth(undefined), 0);
    assert.equal(boardMaxNetWorth([{ networth: 100 }, { networth: 300000 }, { networth: 50000 }]), 300000);
    assert.equal(boardMaxNetWorth([{ networth: 'bogus' }, {}]), 0);
    assert.equal(boardMaxNetWorth([{ networth: -50 }]), 0, 'debt is not a benchmark');
});

test('tuning defaults to classic values and clamps into range', () => {
    assert.deepEqual(normalizeTuning(undefined), DEFAULT_TUNING);
    assert.deepEqual(normalizeTuning({}), DEFAULT_TUNING);
    const t = normalizeTuning({ seasons: 0, balance: 999, rubberband: 30, estate: 50, events: 0 });
    assert.deepEqual(t, { seasons: 0, balance: 200, rubberband: 30, estate: 50, events: 0 });
    assert.deepEqual(normalizeTuning({ rubberband: -5, estate: 'bogus', events: 51 }),
        { ...DEFAULT_TUNING, rubberband: 0, estate: 10, events: 50 });
});

test('missing tuning prices exactly like the classic rules (old rooms safe)', () => {
    const ctx = { players: 4, rank: 0, myOwned: 2, totals: { hay: 8, grain: 8, fruit: 8 }, roomCode: 'AB' };
    const flags = { seasons: true, rubberband: true, estate: true, balance: true, events: true };
    const legacy = computeMarketPrice(20000, 'grain', { ...ctx, rules: flags });
    const tuned = computeMarketPrice(20000, 'grain', { ...ctx, rules: { ...flags, tuning: { ...DEFAULT_TUNING } } });
    assert.deepEqual(tuned, legacy);
});

test('strength sliders scale seasons/balance around 1x', () => {
    // Grain, 2 players: cycle 10 harvests; H=5 is mid-cycle => classic 1.25x.
    const base = { rules: { seasons: true }, totals: { hay: 2, grain: 2, fruit: 1 }, players: 2 };
    assert.equal(computeMarketPrice(20000, 'grain', base).mult, 1.25);
    const double = computeMarketPrice(20000, 'grain', { ...base, rules: { seasons: true, tuning: { seasons: 200 } } });
    assert.ok(Math.abs(double.mult - 1.5) < 1e-9, 'peak doubled: 1 + 0.25*2');
    const off = computeMarketPrice(20000, 'grain', { ...base, rules: { seasons: true, tuning: { seasons: 0 } } });
    assert.deepEqual(off, { price: 20000, mult: 1, notes: [] });
    // Balance still scales the same way (hot fruit 2x at full strength).
    const hot = computeMarketPrice(20000, 'fruit', {
        rules: { balance: true, tuning: { balance: 50 } }, totals: { hay: 1, grain: 1, fruit: 28 }
    });
    assert.ok(Math.abs(hot.mult - 1.5) < 1e-9, 'half strength: 1 + (2-1)*0.5');
});

test('rubberband slider sets the leader tax / trailer aid', () => {
    assert.equal(rubberbandMult(0, 6, 20), 1.2);
    assert.equal(rubberbandMult(5, 6, 20), 0.8);
    assert.equal(rubberbandMult(2, 6, 20), 1, 'middle stays neutral');
    assert.equal(rubberbandMult(0, 6, 0), 1, 'zero aid is silent');
    const r = computeMarketPrice(25000, 'farm', {
        rules: { rubberband: true, tuning: { rubberband: 30 } }, rank: 0, players: 4
    });
    assert.equal(r.mult, 1.3);
});

test('estate slider sets the extra cost per owned unit', () => {
    assert.equal(estateMult(3, 20), 1.6);
    assert.equal(estateMult(3, 0), 1);
    const r = computeMarketPrice(25000, 'farm', {
        rules: { estate: true, tuning: { estate: 50 } }, myOwned: 2
    });
    assert.equal(r.mult, 2);
});

test('events slider caps the walk swing, zero-sum survives', () => {
    const base = 20000;
    for (let i = 0; i < 500; i++) {
        for (const h of [1, 10, 60]) {
            const w = eventSwings('R' + i, h, base, 0.2);
            for (const v of w) assert.ok(v >= -0.2 * base && v <= 0.2 * base, `swing $${v} respects the 20% cap`);
            assert.ok(Math.abs(w[0] + w[1] + w[2]) < 1e-6, 'still zero-sum');
        }
    }
    assert.deepEqual(eventSwings('AB', 25, base, 0), [0, 0, 0], '0% swing is flat');
    const m = eventDollars('grain', 'AB', 25, base, 0.1);
    assert.ok(Math.abs(m) <= 0.1 * base, 'walk respects the 10% cap');
    // Same walk, smaller cap => same direction, never bigger.
    for (let i = 0; i < 200; i++) {
        const full = eventSwings('Q' + i, 40, base);
        const small = eventSwings('Q' + i, 40, base, 0.1);
        for (let k = 0; k < 3; k++) {
            assert.ok(Math.abs(small[k]) <= Math.abs(full[k]) + 1e-6, 'smaller cap never overshoots');
        }
    }
});

test('drift: mean-reversion in $100 tickets, capped, crops only', () => {
    // UP room basis: hay over-held drifts down, fruit under-held drifts up.
    const up = { hay: 0.375, grain: 0.25, fruit: 0 };
    assert.equal(driftDollars('hay', up), -100);
    assert.equal(driftDollars('grain', up), 0);
    assert.equal(driftDollars('fruit', up), 100);
    // Even splits and empty rooms drift nowhere; estates never drift.
    assert.equal(driftDollars('grain', { hay: 2, grain: 2, fruit: 2 }), 0);
    assert.equal(driftDollars('grain', { hay: 0, grain: 0, fruit: 0 }), 0);
    assert.equal(driftDollars('farm', up), 0);
    // Corners clamp at one ticket — never dominates the price.
    assert.equal(driftDollars('grain', { hay: 0, grain: 100, fruit: 0 }), -100);
    assert.equal(driftDollars('fruit', { hay: 0, grain: 100, fruit: 0 }), 100);
});
