// Market pricing — room-creator-selectable rules (stored in rooms.rules)
// plus one always-on auto balancer.
//
// All functions are pure (same inputs => same price on every client) and
// whole-dollar only. Price inputs come from the room's leaderboard snapshot,
// so no server or schema changes beyond the rules JSONB column itself.
//
// Rules:
//   seasons    harvest-clock wave: prices start at base and walk up and down
//              as the room's total harvests grow. Each crop rides its own
//              cycle whose length is a multiple of the player count
//              (hay 4x, grain 5x, fruit 6x players), so the dear crop keeps
//              rotating. Peaks at +25%, never below base. Hay/Grain/Fruit.
//   rubberband room leader pays 1.1x, trailer pays 0.9x. Everything.
//   estate     your Nth unit costs base * (1 + 0.1 * owned) — crops per
//              earned unit, cattle per 2 head, farms/equipment per unit.
//              Crops/Harvester/Tractor/Cows (ridges already scale per unit).
//   balance    demand tickets across Hay/Grain/Fruit: deviation from the
//              even split maps to $500 per unit, ticketed to $100 steps and
//              capped at ±$1000. Crowded crops premium, ignored ones discount.
//   events     boom & bust: each crop walks its own random path — every
//              room harvest moves a crop ±$100. Walk deviations are
//              normalized zero-sum (swings add to ~$0) so the meta rotates
//              instead of inflating, capped at ±50% of base. Deterministic
//              per room + harvest count — same prices on every device, no
//              server round trip.
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
// Per-rule tuning (stored in rooms.rules.tuning): seasons/balance effect
// strength 0–200% (100 = classic), rubberband tax/aid 0–30%, estate 0–50%
// per unit, events max swing 0–50%. Set once at room creation beside the
// flags. Missing tuning normalizes to classic values, so older rooms price
// exactly as before. (Retired keys like market/scarcity are ignored.)
// Combined multiplier clamps to [0.25, 3], then rounds to the nearest $500.
// Hay never prices above base: its final multiplier clamps to [0.25, 1], so
// hay only ever discounts. Every other asset may rise above base.
// Player-to-player trades are negotiated and never adjusted.

export const RULE_KEYS = ['seasons', 'rubberband', 'estate', 'balance', 'events', 'customecon', 'customharvest'];

// Assets each rule touches. Cows/ridges: cost is bonus-driven in the modal;
// rubberband still applies there, the rest leave ridges alone.
export const SEASON_ASSETS = ['hay', 'grain', 'fruit'];
// Estate scope: owned property — crops per unit held, cattle per 2 head,
// farms and equipment per unit. The surcharge keys off room-average
// ownership, so every device quotes it. (The board's cattle count mixes
// farm + ranch head, so farm cows ride along at the cattle rate.)
export const ESTATE_ASSETS = ['hay', 'grain', 'fruit', 'farm', 'cows', 'harvester', 'tractor'];
// Auto balancer scope: the three buyable crop properties.
export const BALANCE_ASSETS = ['hay', 'grain', 'fruit'];
export const BALANCE_MIN = 0.5;
export const BALANCE_MAX = 2;
// Hay may rise above its $15,000 base but never past its $20,000 ceiling.
export const HAY_CEILING = 20000;
// Fruit may dip below its $25,000 base but never past its $20,000 floor.
export const FRUIT_FLOOR = 20000;

export const MIN_MULT = 0.25;
export const MAX_MULT = 3;
export const ROUND_TO = 100; // prices tick in $100 steps, never faster
// Crops never add past 1.5x no matter how rules stack — seasons and
// estate add together, but the combined crop multiplier stops here.
export const CROP_MAX_MULT = 1.5;

export function normalizeRules(rules) {
    // Retired keys (market/scarcity) fall off here: only RULE_KEYS survive,
    // so old rooms simply stop applying the removed rule.
    const src = rules && typeof rules === 'object' ? rules : {};
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
// max walk swing %. Economy/Harvest have no slider — their numbers below
// are the tuning. Absent tuning (older rooms) normalizes to defaults, so
// existing rooms price exactly as before.
export const DEFAULT_TUNING = {
    seasons: 100, balance: 100,
    rubberband: 10, estate: 10, events: 50
};

export function normalizeTuning(tuning) {
    const src = tuning && typeof tuning === 'object' ? tuning : {};
    return {
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
        flags: { seasons: true, customecon: true, customharvest: true },
        econ: { debtCap: 25000, interestPct: 25, downPct: 40 },
        harvest: { hayMidQty: 8, hayMidMult: 1.25, hayHighQty: 15, hayHighMult: 1.5, equipRate: 0.1, equipCap: 3 }
    },
    bull: {
        label: 'Bull Market',
        blurb: 'Boom & bust walks rotate the best crop every harvest. Chase the boom.',
        flags: { balance: true, events: true },
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

// Harvest clock: total room crop holdings stand in for how many harvests
// have happened (same leaderboard snapshot on every device, so every
// device walks the same wave).
export function harvestClock(totals) {
    const t = totals && typeof totals === 'object' ? totals : {};
    return ['hay', 'grain', 'fruit'].reduce((s, k) => s + Math.max(0, Number(t[k]) || 0), 0);
}

// Starting inventory is granted, not earned: every player starts with 1 hay
// + 1 grain, and those free units must not count as ownership for market
// rules (otherwise every room opens demand-spiked). Earned totals subtract
// the per-player grant, floored at zero — deterministic from the same
// snapshot, so every device still agrees.
export const STARTING_HOLDINGS = { hay: 1, grain: 1, fruit: 0 };
export function earnedTotals(totals, players) {
    const t = totals && typeof totals === 'object' ? totals : {};
    const P = Math.max(0, Math.floor(Number(players) || 0));
    const out = {};
    for (const k of ['hay', 'grain', 'fruit']) {
        out[k] = Math.max(0, (Number(t[k]) || 0) - (STARTING_HOLDINGS[k] || 0) * P);
    }
    return out;
}

// Per-capita market basis: earned room holdings divided by player count, so
// seasons and walks move at the same pace in a 2-player room and an 8-player
// room — room size stops accelerating the market. Share-based rules (the
// demand balancer) are ratio-invariant, so only clock-driven effects calm
// down. Deterministic from the same snapshot, so every device still agrees.
export function marketBasis(totals, players) {
    const P = Math.max(1, Math.floor(Number(players) || 0));
    const earned = earnedTotals(totals, players);
    const out = {};
    for (const k of ['hay', 'grain', 'fruit']) out[k] = earned[k] / P;
    return out;
}

// Seasons ride the harvest clock, not the wall clock. Each crop walks a
// triangle wave from base up to +25% and back: a full up-down cycle takes
// 4/5/6 harvests per player (hay/grain/fruit), so bigger rooms swing
// slower and the dear crop rotates. Pure integer-ratio arithmetic — no
// transcendentals — so every device lands on the exact same price.
export const SEASON_PERIODS = { hay: 4, grain: 5, fruit: 6 }; // x players
export const SEASON_AMPLITUDE = 0.25;

export function seasonMult(asset, harvests, players) {
    const key = String(asset || '').toLowerCase();
    const per = SEASON_PERIODS[key];
    const P = Math.floor(Number(players) || 0);
    const H = Math.max(0, Number(harvests) || 0);
    if (!per || P <= 0) return 1;
    const L = per * P;
    const f = (H % L) / L;
    return 1 + SEASON_AMPLITUDE * (1 - Math.abs(2 * f - 1));
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

export function estateMult(owned, pct = DEFAULT_TUNING.estate, per = 1) {
    // per = units per estate step: 1 for most property, 2 for cattle (every
    // second cow adds a step). Fractional room averages floor down.
    const step = Math.max(1, Math.floor(Number(per) || 1));
    const n = Math.max(0, Math.floor((Number(owned) || 0) / step));
    return 1 + (clampNum(pct, 0, 50, DEFAULT_TUNING.estate) / 100) * n;
}

// --- Boom & bust: per-crop random walks stepped by room harvests ---
// Each crop walks its own path: every room harvest moves that crop ±$100,
// the sign drawn deterministically from (room, crop, harvest index) so
// every device walks the same path. Walk deviations are mean-subtracted so
// the three sum to ~$0 (one crop's boom is funded by the others' busts)
// and rescaled — not clipped — past the dollar cap (the host's max-swing %
// of that crop's base price).
export const EVENT_ASSETS = ['hay', 'grain', 'fruit'];
export const EVENT_MAX_SWING = 0.5; // no crop ever walks past ±50% of base
export const EVENT_STEP_DOLLARS = 100; // each harvest moves a crop ±$100

function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
}

// One deterministic ±1 step per (room, crop, harvest index): same inputs
// => same step on every device.
function walkStep(room, cropIdx, i) {
    return (hashSeed(`${room}|${cropIdx}|${i}`) & 1) ? 1 : -1;
}

// Raw walk deviation in dollars for one crop after H room harvests.
// Non-crops and negative counts stay at $0.
export function eventWalk(asset, roomCode, harvests) {
    const idx = EVENT_ASSETS.indexOf(String(asset || '').toLowerCase());
    if (idx < 0) return 0;
    const H = Math.max(0, Math.floor(Number(harvests) || 0));
    const room = String(roomCode || '').toUpperCase();
    let d = 0;
    for (let i = 1; i <= H; i++) d += EVENT_STEP_DOLLARS * walkStep(room, idx, i);
    return d;
}

// Raw walk deviations in dollars, mean-subtracted so the three sum to ~$0.
// If centering pushes a swing past the dollar cap, everything rescales (not
// clips) so the zero-sum survives and the cap still holds.
export function eventSwings(roomCode, harvests, base, maxSwing = EVENT_MAX_SWING) {
    const cap = clampNum(maxSwing, 0, EVENT_MAX_SWING, EVENT_MAX_SWING) * Math.max(0, Number(base) || 0);
    if (cap === 0) return [0, 0, 0]; // silenced rule (or baseless asset): flat, no walk to run
    const raw = EVENT_ASSETS.map((_, i) => eventWalk(EVENT_ASSETS[i], roomCode, harvests));
    const mean = (raw[0] + raw[1] + raw[2]) / 3;
    const centered = raw.map((v) => v - mean);
    const peak = Math.max(Math.abs(centered[0]), Math.abs(centered[1]), Math.abs(centered[2]));
    if (peak <= cap) return centered;
    const k = cap / peak;
    return centered.map((v) => v * k);
}

export function eventDollars(asset, roomCode, harvests, base, maxSwing = EVENT_MAX_SWING) {
    const key = String(asset || '').toLowerCase();
    const i = EVENT_ASSETS.indexOf(key);
    if (i < 0) return 0;
    return eventSwings(roomCode, harvests, base, maxSwing)[i];
}

// --- Mean-reversion drift: pull concentrated crops back toward the average ---
// Deviation-driven and per-capita: $500 of pull per unit of per-capita
// deviation from the room crop average, quantized to $100 tickets and
// capped at ±$500 — over-held crops cheapen, under-held crops dear. Under
// the hay ceiling (clips rises) and fruit floor (clips drops) this is the
// term that keeps all three crops visibly alive: piled hay drifts down,
// ignored fruit drifts up.
export const DRIFT_PER_CAPITA = 500;
export const DRIFT_TICKET = 100;
export const DRIFT_MAX = 500;
export function driftDollars(asset, totals) {
    const key = String(asset || '').toLowerCase();
    if (!BALANCE_ASSETS.includes(key)) return 0;
    const t = totals && typeof totals === 'object' ? totals : {};
    const nums = BALANCE_ASSETS.map((k) => Math.max(0, Number(t[k]) || 0));
    const sum = nums[0] + nums[1] + nums[2];
    if (!(sum > 0)) return 0;
    const dev = nums[BALANCE_ASSETS.indexOf(key)] - sum / 3;
    const q = Math.round((-DRIFT_PER_CAPITA * dev) / DRIFT_TICKET) * DRIFT_TICKET;
    const clamped = Math.max(-DRIFT_MAX, Math.min(DRIFT_MAX, q));
    return clamped === 0 ? 0 : clamped; // normalize -0 (strict-equal tests)
}
// --- Demand tickets: gradual pressure for/against the crowded crop ---
// The hot crop's premium (and ignored crops' discount) move in $100 tickets
// up to ±$1000 — never an instant ×1.5–×2 jump. Driven by earned room
// holdings: $500 per unit of deviation from the even split, scaled by the
// host's balance strength, ticketed, then capped.
export const DEMAND_PER_UNIT = 500;
export const DEMAND_TICKET = 100;
export const DEMAND_MAX = 1000;
export function demandDollars(asset, totals, strengthPct = 100) {
    const key = String(asset || '').toLowerCase();
    if (!BALANCE_ASSETS.includes(key)) return 0;
    const t = totals && typeof totals === 'object' ? totals : {};
    const nums = BALANCE_ASSETS.map((k) => Math.max(0, Number(t[k]) || 0));
    const sum = nums[0] + nums[1] + nums[2];
    if (!(sum > 0)) return 0;
    const dev = nums[BALANCE_ASSETS.indexOf(key)] - sum / 3;
    const s = clampNum(strengthPct, 0, 200, 100) / 100;
    const q = Math.round((DEMAND_PER_UNIT * dev * s) / DEMAND_TICKET) * DEMAND_TICKET;
    const clamped = Math.max(-DEMAND_MAX, Math.min(DEMAND_MAX, q));
    return clamped === 0 ? 0 : clamped; // normalize -0 (strict-equal tests)
}
// Raw demand-balancer multiplier (kept for the rule's unit tests and tuning
// math): share = this crop's fraction of total room crop holdings;
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

// Every mult-type modifier names its value: "high demand ×1.2", not bare
// "high demand". Dollar terms (boom/bust/drift) already carry theirs.
function fmtMult(m) {
    return `×${m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// ctx: { rules, avgOwned, myOwned, rank, players, totals, roomCode }.
// totals = { hay, grain, fruit } room holdings; feeds the demand balancer,
// the seasons harvest clock, and the boom & bust random walks
// (deterministic per room + harvest count).
// Returns { price, mult, notes } — notes is a short human breakdown for the modal.
export function computeMarketPrice(base, asset, ctx = {}) {
    const rules = normalizeRules(ctx.rules);
    const tuning = rules.tuning;
    const key = String(asset || '').toLowerCase();
    const mults = [];
    const notes = [];

    // Demand balancer: the crop everyone piles into gets dear, the
    // ignored ones go cheap — expressed as $100 demand tickets (up to
    // ±$1000), never an instant mult jump. Scaled by the balance strength.
    let demand = 0;
    if (rules.balance && BALANCE_ASSETS.includes(key)) {
        demand = demandDollars(key, ctx.totals, tuning.balance);
        if (demand !== 0) notes.push(`${demand > 0 ? 'high' : 'low'} demand ${demand > 0 ? '+' : '-'}$${Math.abs(demand).toLocaleString()}`);
    }

    if (rules.seasons && SEASON_ASSETS.includes(key)) {
        const m = scaleStrength(seasonMult(key, harvestClock(ctx.totals), ctx.players), tuning.seasons);
        mults.push(m);
        if (m > 1.01) notes.push(`high season ${fmtMult(m)}`);
    }
    if (rules.rubberband) {
        const m = rubberbandMult(ctx.rank, ctx.players, tuning.rubberband);
        mults.push(m);
        if (m > 1) notes.push(`leader tax ${fmtMult(m)}`);
        else if (m < 1) notes.push(`trailer aid ${fmtMult(m)}`);
    }
    if (rules.estate && ESTATE_ASSETS.includes(key)) {
        // Crops count earned units only — the starting hay+grain grant never
        // pays estate (fresh rooms stay at base). Cattle steps every 2 head.
        const owned = BALANCE_ASSETS.includes(key)
            ? Math.max(0, (Number(ctx.myOwned) || 0) - (STARTING_HOLDINGS[key] || 0))
            : ctx.myOwned;
        const m = estateMult(owned, tuning.estate, key === 'cows' ? 2 : 1);
        mults.push(m);
        if (m > 1) notes.push(`estate ${fmtMult(m)}`);
    }
    // Random-walk dollars live outside the mults (added to the price, not
    // multiplied) so every step is a flat $100 ticket.
    let walkDollars = 0;
    if (rules.events && EVENT_ASSETS.includes(key)) {
        const walk = eventDollars(key, ctx.roomCode, harvestClock(ctx.totals), base, tuning.events / 100);
        const rw = Math.round(walk);
        if (rw !== 0) {
            walkDollars = rw;
            notes.push(`${rw > 0 ? 'boom' : 'bust'} ${rw > 0 ? '+' : '-'}$${Math.abs(rw).toLocaleString()}`);
        }
    }
    // Mean-reversion drift rides with any motion rule (balance or events):
    // gradual $100-ticket lean against concentration, same snapshot math.
    let drift = 0;
    if ((rules.balance || rules.events) && BALANCE_ASSETS.includes(key)) {
        drift = driftDollars(key, ctx.totals);
        if (drift !== 0) notes.push(`drift ${drift > 0 ? '+' : '-'}$${Math.abs(drift).toLocaleString()}`);
    }

    if (mults.length === 0 && walkDollars === 0 && drift === 0 && demand === 0) return { price: Math.round(Number(base) || 0), mult: 1, notes };
    const b = Number(base) || 0;
    let mult = Math.min(MAX_MULT, Math.max(MIN_MULT, 1 + mults.reduce((s, m) => s + (m - 1), 0)));
    // Crops stop at 1.5x combined, however seasons and estate stack.
    if (BALANCE_ASSETS.includes(key)) mult = Math.min(mult, CROP_MAX_MULT);
    // Hay ceiling / fruit floor, expressed against this asset's own base so
    // the caps stay exact: hay never past $20k, fruit never under $20k.
    if (key === 'hay' && b > 0) mult = Math.min(mult, HAY_CEILING / b);
    if (key === 'fruit' && b > 0) mult = Math.max(mult, FRUIT_FLOOR / b);
    let price = roundPrice(b * mult + walkDollars + drift + demand);
    // The dollar terms move after the mult, so the caps re-apply to the
    // final price (a hay spike or sub-floor fruit can never leak through).
    if (key === 'hay') price = Math.min(price, HAY_CEILING);
    if (key === 'fruit') price = Math.max(price, FRUIT_FLOOR);
    return { price, mult, notes };
}
