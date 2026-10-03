// Market pricing — room-creator-selectable rules (stored in rooms.rules)
// plus one always-on auto balancer.
//
// All functions are pure (same inputs => same price on every client) and
// whole-dollar only. Price inputs come from the room's leaderboard snapshot,
// so no server or schema changes beyond the rules JSONB column itself.
//
// Rules:
//   market     market-adjusted: crop prices follow room abundance relative
//              to the baseline and player count: avg owned per player maps
//              to mult = clamp(2 - avg, 0.5, 2). Nobody owns any => 2x
//              (land-grab opener); glut => 0.5x floor. Hay/Grain/Fruit only.
//   seasons    game-year quarters (elapsed / duration) wave crop prices:
//              harvest is cheap, winter is dear. Hay/Grain/Fruit only.
//   rubberband room leader pays 1.1x, trailer pays 0.9x. Everything.
//   estate     your Nth unit costs base * (1 + 0.1 * owned).
//              Farm/Harvester/Tractor only (ridges already scale per unit).
//   balance    demand balancer across Hay/Grain/Fruit. Each crop's share of
//              total room crop holdings vs an even split maps to
//              mult = clamp(share * 3, 0.5, 2). The crop everyone piles into
//              gets dear (up to 2x); the ignored ones go cheap (down to 0.5x).
//   events     boom & bust: each game season every crop swings up to ±50%,
//              normalized zero-sum (swings add to 0) so the meta rotates
//              instead of inflating. Deterministic per room + season — same
//              prices on every device, no server round trip.
// Hay never prices above base: its final multiplier always clamps to
// [0.25, 1], so hay only ever discounts. Every other asset may rise above
// base. (Standing hay property — applies no matter which rules are on.)
//
// Host-tunable numbers (stored beside the rule flags in rooms.rules):
//   econ    { debtCap, interestPct, downPct } — max loan $, loan interest %,
//           minimum down-payment %. Defaults { 50000, 10, 20 }.
//   harvest { hayMidQty, hayMidMult, hayHighQty, hayHighMult, equipRate,
//           equipCap } — hay roll-bonus tiers and equipment gain rate/cap.
//           Defaults { 5, 1.5, 10, 2, 0.2, 5 } (today's game).
// The numbers only apply when their checkbox is on: customecon enables the
// econ numbers, customharvest enables the harvest numbers. Everything off
// (or no room doc) plays exactly today's game — hosts mix and match freely.
// Per-rule tuning (stored in rooms.rules.tuning): market/seasons/balance
// effect strength 0–200% (100 = classic), rubberband tax/aid 0–30%,
// estate 0–50% per unit, events max swing 0–50%. Set once at room creation
// beside the flags. Missing tuning normalizes to classic values, so older
// rooms price exactly as before.
// Combined multiplier clamps to [0.25, 3], then rounds to the nearest $500.
// Hay never prices above base: its final multiplier clamps to [0.25, 1], so
// hay only ever discounts. Every other asset may rise above base.
// Player-to-player trades are negotiated and never adjusted.

export const RULE_KEYS = ['market', 'seasons', 'rubberband', 'estate', 'balance', 'events', 'customecon', 'customharvest'];

// Assets each rule touches. Cows/ridges: cost is bonus-driven in the modal;
// rubberband still applies there, the rest leave ridges alone.
export const MARKET_ASSETS = ['hay', 'grain', 'fruit'];
export const SEASON_ASSETS = ['hay', 'grain', 'fruit'];
export const ESTATE_ASSETS = ['farm', 'harvester', 'tractor'];
// Auto balancer scope: the three buyable crop properties.
export const BALANCE_ASSETS = ['hay', 'grain', 'fruit'];
export const BALANCE_MIN = 0.5;
export const BALANCE_MAX = 2;
// Hay may only ever discount from base, never rise above it.
export const HAY_MAX_MULT = 1;

export const MIN_MULT = 0.25;
export const MAX_MULT = 3;
export const ROUND_TO = 500;

export function normalizeRules(rules) {
    let src = rules && typeof rules === 'object' ? rules : {};
    // Legacy alias: the market rule used to be called scarcity — old room
    // docs keep pricing identically.
    if (src.market !== true && src.scarcity === true) src = { ...src, market: true };
    const out = {};
    for (const key of RULE_KEYS) out[key] = src[key] === true;
    out.econ = normalizeEcon(src.econ);
    out.harvest = normalizeHarvest(src.harvest);
    out.tuning = normalizeTuning(src.tuning);
    // Scenario stamp survives only when it names a real preset — a stale or
    // forged name drops off and the badge falls back to Standard/Custom.
    if (typeof src.scenario === 'string' && Object.prototype.hasOwnProperty.call(SCENARIOS, src.scenario)) {
        out.scenario = src.scenario;
    }
    return out;
}

// --- Host-tunable numbers (defaults = today's game) ---

export const DEFAULT_ECON = { debtCap: 50000, interestPct: 10, downPct: 20 };
export const DEFAULT_HARVEST = {
    hayMidQty: 5, hayMidMult: 1.5, hayHighQty: 10, hayHighMult: 2,
    equipRate: 0.2, equipCap: 5
};

function clampNum(v, lo, hi, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

export function normalizeEcon(econ) {
    const src = econ && typeof econ === 'object' ? econ : {};
    return {
        debtCap: Math.round(clampNum(src.debtCap, 0, 500000, DEFAULT_ECON.debtCap) / 100) * 100,
        interestPct: clampNum(src.interestPct, 0, 100, DEFAULT_ECON.interestPct),
        downPct: clampNum(src.downPct, 0, 100, DEFAULT_ECON.downPct)
    };
}

// Live values for the game: custom numbers when their checkbox is on,
// today's defaults otherwise. Scripts.js reads these (never the raw objects).
export function activeEcon(rules) {
    const r = rules && typeof rules === 'object' ? rules : {};
    return r.customecon === true ? normalizeEcon(r.econ) : { ...DEFAULT_ECON };
}

export function activeHarvest(rules) {
    const r = rules && typeof rules === 'object' ? rules : {};
    return r.customharvest === true ? normalizeHarvest(r.harvest) : { ...DEFAULT_HARVEST };
}

// --- Per-rule tuning: one slider per market rule, set at room creation ---
// Strengths scale how hard a rule bites (100 = the classic rule, 200 =
// double, 0 = no effect without unticking). Rubber-band sets the leader
// tax / trailer aid %, estate sets the % per owned unit, events sets the
// max season swing %. Economy/Harvest have no slider — their numbers below
// are the tuning. Absent tuning (older rooms) normalizes to defaults, so
// existing rooms price exactly as before.
export const DEFAULT_TUNING = {
    market: 100, seasons: 100, balance: 100,
    rubberband: 10, estate: 10, events: 50
};

export function normalizeTuning(tuning) {
    const src = tuning && typeof tuning === 'object' ? tuning : {};
    return {
        // Legacy alias alongside the market rename.
        market: clampNum(src.market ?? src.scarcity, 0, 200, DEFAULT_TUNING.market),
        seasons: clampNum(src.seasons, 0, 200, DEFAULT_TUNING.seasons),
        balance: clampNum(src.balance, 0, 200, DEFAULT_TUNING.balance),
        rubberband: clampNum(src.rubberband, 0, 30, DEFAULT_TUNING.rubberband),
        estate: clampNum(src.estate, 0, 50, DEFAULT_TUNING.estate),
        events: clampNum(src.events, 0, 50, DEFAULT_TUNING.events)
    };
}

// Scale a rule's deviation from 1x: 100% = full classic effect.
function scaleStrength(mult, pct) {
    return 1 + (mult - 1) * (clampNum(pct, 0, 200, 100) / 100);
}

// --- Scenarios: one-tap gameplay presets over the flag + number systems ---
// A scenario is just flags + tuned numbers, so applying one is identical to
// ticking the boxes and typing the numbers by hand — same room-doc path,
// same deterministic pricing, no special cases. Guests need no new sync.
export const SCENARIOS = {
    standard: {
        label: 'Standard',
        blurb: 'The classic game: $50k loans, 10% interest, 20% down, standard harvests.',
        flags: {},
        econ: { ...DEFAULT_ECON },
        harvest: { ...DEFAULT_HARVEST }
    },
    drought: {
        label: 'Drought',
        blurb: 'Harsh harvests, tight expensive credit. Hoard cash, buy only what pays.',
        flags: { market: true, seasons: true, customecon: true, customharvest: true },
        econ: { debtCap: 25000, interestPct: 25, downPct: 40 },
        harvest: { hayMidQty: 8, hayMidMult: 1.25, hayHighQty: 15, hayHighMult: 1.5, equipRate: 0.1, equipCap: 3 }
    },
    bull: {
        label: 'Bull Market',
        blurb: 'Boom & bust swings rotate the best crop every season. Chase the boom.',
        flags: { market: true, balance: true, events: true },
        econ: { ...DEFAULT_ECON },
        harvest: { ...DEFAULT_HARVEST }
    },
    debtfree: {
        label: 'Debt-Free',
        blurb: 'No loans at all: 100% down, cash only. Slow and steady wins.',
        flags: { customecon: true },
        econ: { debtCap: 0, interestPct: 0, downPct: 100 },
        harvest: { ...DEFAULT_HARVEST }
    }
};
export const SCENARIO_KEYS = Object.keys(SCENARIOS);

// Rules-plus-scenario-name: applying a preset stamps its key; any hand edit
// clears it (scripts.js deletes it) so the badge falls back to Custom.
export function applyScenario(key) {
    const preset = SCENARIOS[key];
    if (!preset) return normalizeRules({});
    return normalizeRules({ ...preset.flags, econ: preset.econ, harvest: preset.harvest, scenario: key });
}

// Display name for the room badge: preset label, Standard when nothing is
// on, Custom for hand-mixed rules.
export function scenarioName(rules) {
    const r = rules && typeof rules === 'object' ? rules : {};
    if (typeof r.scenario === 'string' && SCENARIOS[r.scenario]) return SCENARIOS[r.scenario].label;
    const anyFlag = RULE_KEYS.some((k) => r[k] === true);
    return anyFlag ? 'Custom' : SCENARIOS.standard.label;
}

// --- Bulk buys: benchmark-unlocked purchase increments ---
// Always-on, like the hay ceiling. While ANY one player holds net worth at
// or above a benchmark, everyone may buy up to the tier multiplier in one
// purchase. Hay and grain (bulk crops) start early and climb to 5x —
// 2x at $150k, 3x at $250k, 5x at $500k; everything else unlocks 2x at
// $250k and caps there. Evaluated live off the leaderboard snapshot, so
// every device agrees with no extra state — dip back below and the tier
// locks again.
export const BULK_TIERS = [
    { min: 150000, mult: 2, bulkOnly: true },
    { min: 250000, mult: 2 },
    { min: 250000, mult: 3, bulkOnly: true },
    { min: 500000, mult: 5, bulkOnly: true }
];
export const BULK_ASSETS = ['hay', 'grain'];

export function boardMaxNetWorth(board) {
    if (!Array.isArray(board) || board.length === 0) return 0;
    let max = 0;
    for (const d of board) {
        const n = Number(d && d.networth) || 0;
        if (n > max) max = n;
    }
    return max;
}

function isBulkAsset(asset) {
    return BULK_ASSETS.includes(String(asset || '').toLowerCase());
}

export function bulkMult(maxNetWorth, asset) {
    const bulk = isBulkAsset(asset);
    const worth = Number(maxNetWorth) || 0;
    let m = 1;
    for (const t of BULK_TIERS) {
        if (worth >= t.min && (!t.bulkOnly || bulk)) m = Math.max(m, t.mult);
    }
    return m;
}

// Next locked tier for the hint line ({mult, min}), or null when maxed.
export function bulkNext(maxNetWorth, asset) {
    const bulk = isBulkAsset(asset);
    const worth = Number(maxNetWorth) || 0;
    const cur = bulkMult(worth, asset);
    for (const t of BULK_TIERS) {
        if ((!t.bulkOnly || bulk) && worth < t.min && t.mult > cur) return { mult: t.mult, min: t.min };
    }
    return null;
}

export function normalizeHarvest(harvest) {
    const src = harvest && typeof harvest === 'object' ? harvest : {};
    const midQty = Math.floor(clampNum(src.hayMidQty, 2, 20, DEFAULT_HARVEST.hayMidQty));
    const midMult = clampNum(src.hayMidMult, 1, 3, DEFAULT_HARVEST.hayMidMult);
    return {
        hayMidQty: midQty,
        hayMidMult: midMult,
        // High tier must sit strictly above the mid tier.
        hayHighQty: Math.max(midQty + 1, Math.floor(clampNum(src.hayHighQty, 3, 30, DEFAULT_HARVEST.hayHighQty))),
        hayHighMult: Math.max(midMult, clampNum(src.hayHighMult, 1, 5, DEFAULT_HARVEST.hayHighMult)),
        equipRate: clampNum(src.equipRate, 0, 2, DEFAULT_HARVEST.equipRate),
        equipCap: Math.floor(clampNum(src.equipCap, 0, 10, DEFAULT_HARVEST.equipCap))
    };
}

// avg = room total owned / players. players == 0 => no market, base price.
export function marketMult(avgOwned, players) {
    if (!Number.isFinite(avgOwned) || !Number.isFinite(players) || players <= 0) return 1;
    return Math.min(2, Math.max(0.5, 2 - avgOwned));
}

// Game-year quarter from progress fraction 0..1 (clamped).
export function seasonIndex(progressFrac) {
    const f = Number(progressFrac);
    if (!Number.isFinite(f) || f <= 0) return 0;
    if (f >= 1) return 3;
    return Math.min(3, Math.floor(f * 4));
}

// [spring, summer, fall, winter] per crop. Fall harvest gluts, winter shortage.
const SEASON_TABLE = {
    hay: [1.0, 0.9, 0.8, 1.25],
    grain: [1.0, 0.9, 0.8, 1.25],
    fruit: [1.1, 0.85, 1.0, 1.3]
};

export function seasonMult(asset, season) {
    const row = SEASON_TABLE[String(asset || '').toLowerCase()];
    if (!row || !Number.isInteger(season) || season < 0 || season > 3) return 1;
    return row[season];
}

// rank = 0-based position in networth-desc board. Unknown/solo => neutral.
// pct = leader tax / trailer aid % (default 10).
export function rubberbandMult(rank, players, pct = DEFAULT_TUNING.rubberband) {
    if (!Number.isInteger(rank) || !Number.isFinite(players) || players < 2) return 1;
    const p = clampNum(pct, 0, 30, DEFAULT_TUNING.rubberband) / 100;
    if (rank <= 0) return 1 + p;
    if (rank >= players - 1) return 1 - p;
    return 1;
}

export function estateMult(owned, pct = DEFAULT_TUNING.estate) {
    const n = Math.max(0, Math.floor(Number(owned) || 0));
    return 1 + (clampNum(pct, 0, 50, DEFAULT_TUNING.estate) / 100) * n;
}

// --- Boom & bust: deterministic per room + season, zero-sum across crops ---
export const EVENT_ASSETS = ['hay', 'grain', 'fruit'];
export const EVENT_MAX_SWING = 0.5; // no crop ever swings more than ±50%

function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Raw draws in [-swing, +swing], mean-subtracted so the three swings sum
// to ~0 (one crop's boom is funded by the others' busts). If centering
// pushes a swing past ±swing, everything rescales (not clips) so the
// zero-sum survives and the cap still holds.
export function eventSwings(roomCode, season, maxSwing = EVENT_MAX_SWING) {
    const cap = clampNum(maxSwing, 0, EVENT_MAX_SWING, EVENT_MAX_SWING);
    const rand = mulberry32(hashSeed(`${String(roomCode || '').toUpperCase()}|${Number(season) || 0}`));
    const raw = [0, 1, 2].map(() => (rand() * 2 - 1) * cap);
    const mean = (raw[0] + raw[1] + raw[2]) / 3;
    const centered = raw.map((v) => v - mean);
    const peak = Math.max(Math.abs(centered[0]), Math.abs(centered[1]), Math.abs(centered[2]));
    if (peak <= cap) return centered;
    const k = cap / peak;
    return centered.map((v) => v * k);
}

export function eventMult(asset, roomCode, season, maxSwing = EVENT_MAX_SWING) {
    const key = String(asset || '').toLowerCase();
    const i = EVENT_ASSETS.indexOf(key);
    if (i < 0) return 1;
    return 1 + eventSwings(roomCode, season, maxSwing)[i];
}

// Demand balancer: the crop everyone piles into gets dear, the ignored
// ones go cheap. share = this crop's fraction of total room crop holdings;
// even split (1/3 each) => 1x. totals = { hay, grain, fruit } room totals.
// Empty room (nothing held) => neutral 1x. Non-crop assets => 1x.
export function balanceMult(asset, totals) {
    const key = String(asset || '').toLowerCase();
    if (!BALANCE_ASSETS.includes(key)) return 1;
    const t = totals && typeof totals === 'object' ? totals : {};
    const nums = BALANCE_ASSETS.map((k) => Math.max(0, Number(t[k]) || 0));
    const sum = nums[0] + nums[1] + nums[2];
    if (!(sum > 0)) return 1;
    const mine = nums[BALANCE_ASSETS.indexOf(key)];
    const ratio = mine / (sum / 3);
    return Math.min(BALANCE_MAX, Math.max(BALANCE_MIN, ratio));
}

function roundPrice(value) {
    return Math.max(ROUND_TO, Math.round(value / ROUND_TO) * ROUND_TO);
}

// ctx: { rules, avgOwned, myOwned, rank, players, progress, totals, roomCode }.
// totals = { hay, grain, fruit } room holdings; feeds the demand balancer.
// roomCode + progress season feed boom & bust (deterministic per room).
// Returns { price, mult, notes } — notes is a short human breakdown for the modal.
export function computeMarketPrice(base, asset, ctx = {}) {
    const rules = normalizeRules(ctx.rules);
    const tuning = rules.tuning;
    const key = String(asset || '').toLowerCase();
    const mults = [];
    const notes = [];

    // Demand balancer: the crop everyone piles into gets dear, the
    // ignored ones go cheap — keeps one dominant strategy from eating
    // the room.
    if (rules.balance && BALANCE_ASSETS.includes(key)) {
        const m = scaleStrength(balanceMult(key, ctx.totals), tuning.balance);
        mults.push(m);
        if (m > 1) notes.push('high demand');
        else if (m < 1) notes.push('low demand');
    }

    if (rules.market && MARKET_ASSETS.includes(key)) {
        const m = scaleStrength(marketMult(ctx.avgOwned, ctx.players), tuning.market);
        mults.push(m);
        if (m > 1) notes.push('scarce');
        else if (m < 1) notes.push('glut');
    }
    if (rules.seasons && SEASON_ASSETS.includes(key)) {
        const season = seasonIndex(ctx.progress);
        const m = scaleStrength(seasonMult(key, season), tuning.seasons);
        mults.push(m);
        if (m !== 1) notes.push(['spring', 'summer', 'fall', 'winter'][season]);
    }
    if (rules.rubberband) {
        const m = rubberbandMult(ctx.rank, ctx.players, tuning.rubberband);
        mults.push(m);
        if (m > 1) notes.push('leader tax');
        else if (m < 1) notes.push('trailer aid');
    }
    if (rules.estate && ESTATE_ASSETS.includes(key)) {
        const m = estateMult(ctx.myOwned, tuning.estate);
        mults.push(m);
        if (m > 1) notes.push(`estate x${m.toFixed(1)}`);
    }
    if (rules.events && EVENT_ASSETS.includes(key)) {
        let m = eventMult(key, ctx.roomCode, seasonIndex(ctx.progress), tuning.events / 100);
        // Hay discounts only — a hay boom clips at base, busts still bite.
        if (key === 'hay') m = Math.min(m, HAY_MAX_MULT);
        mults.push(m);
        if (m >= 1.01) notes.push(`boom +${Math.round((m - 1) * 100)}%`);
        else if (m <= 0.99) notes.push(`bust ${Math.round((m - 1) * 100)}%`);
    }

    if (mults.length === 0) return { price: Math.round(Number(base) || 0), mult: 1, notes };
    let mult = Math.min(MAX_MULT, Math.max(MIN_MULT, mults.reduce((a, b) => a * b, 1)));
    // Hay ceiling: hay discounts only, never above base — no matter which
    // rules (or the balancer) push upward.
    if (key === 'hay') mult = Math.min(mult, HAY_MAX_MULT);
    return { price: roundPrice((Number(base) || 0) * mult), mult, notes };
}
