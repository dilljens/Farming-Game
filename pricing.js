// Market pricing — room-creator-selectable rules (stored in rooms.rules).
//
// All functions are pure (same inputs => same price on every client) and
// whole-dollar only. Price inputs come from the room's leaderboard snapshot,
// so no server or schema changes beyond the rules JSONB column itself.
//
// Rules:
//   scarcity   crop price follows room abundance: avg owned per player maps
//              to mult = clamp(2 - avg, 0.5, 2). Nobody owns any => 2x
//              (land-grab opener); glut => 0.5x floor. Hay/Grain/Fruit only.
//   seasons    game-year quarters (elapsed / duration) wave crop prices:
//              harvest is cheap, winter is dear. Hay/Grain/Fruit only.
//   rubberband room leader pays 1.1x, trailer pays 0.9x. Everything.
//   estate     your Nth unit costs base * (1 + 0.1 * owned).
//              Farm/Harvester/Tractor only (ridges already scale per unit).
// Combined multiplier clamps to [0.25, 3], then rounds to the nearest $500.
// Player-to-player trades are negotiated and never adjusted.

export const RULE_KEYS = ['scarcity', 'seasons', 'rubberband', 'estate'];

// Assets each rule touches. Cows/ridges: cost is bonus-driven in the modal;
// rubberband still applies there, the rest leave ridges alone.
export const SCARCITY_ASSETS = ['hay', 'grain', 'fruit'];
export const SEASON_ASSETS = ['hay', 'grain', 'fruit'];
export const ESTATE_ASSETS = ['farm', 'harvester', 'tractor'];

export const MIN_MULT = 0.25;
export const MAX_MULT = 3;
export const ROUND_TO = 500;

export function normalizeRules(rules) {
    const src = rules && typeof rules === 'object' ? rules : {};
    const out = {};
    for (const key of RULE_KEYS) out[key] = src[key] === true;
    return out;
}

// avg = room total owned / players. players == 0 => no market, base price.
export function scarcityMult(avgOwned, players) {
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

// [spring, summer, fall, winter] per crop. Fall harvest gluts, winter scarcity.
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
export function rubberbandMult(rank, players) {
    if (!Number.isInteger(rank) || !Number.isFinite(players) || players < 2) return 1;
    if (rank <= 0) return 1.1;
    if (rank >= players - 1) return 0.9;
    return 1;
}

export function estateMult(owned) {
    const n = Math.max(0, Math.floor(Number(owned) || 0));
    return 1 + 0.1 * n;
}

function roundPrice(value) {
    return Math.max(ROUND_TO, Math.round(value / ROUND_TO) * ROUND_TO);
}

// ctx: { rules, avgOwned, myOwned, rank, players, progress }.
// Returns { price, mult, notes } — notes is a short human breakdown for the modal.
export function computeMarketPrice(base, asset, ctx = {}) {
    const rules = normalizeRules(ctx.rules);
    const key = String(asset || '').toLowerCase();
    const mults = [];
    const notes = [];

    if (rules.scarcity && SCARCITY_ASSETS.includes(key)) {
        const m = scarcityMult(ctx.avgOwned, ctx.players);
        mults.push(m);
        if (m > 1) notes.push('scarce');
        else if (m < 1) notes.push('glut');
    }
    if (rules.seasons && SEASON_ASSETS.includes(key)) {
        const season = seasonIndex(ctx.progress);
        const m = seasonMult(key, season);
        mults.push(m);
        if (m !== 1) notes.push(['spring', 'summer', 'fall', 'winter'][season]);
    }
    if (rules.rubberband) {
        const m = rubberbandMult(ctx.rank, ctx.players);
        mults.push(m);
        if (m > 1) notes.push('leader tax');
        else if (m < 1) notes.push('trailer aid');
    }
    if (rules.estate && ESTATE_ASSETS.includes(key)) {
        const m = estateMult(ctx.myOwned);
        mults.push(m);
        if (m > 1) notes.push(`estate x${m.toFixed(1)}`);
    }

    if (mults.length === 0) return { price: Math.round(Number(base) || 0), mult: 1, notes };
    const mult = Math.min(MAX_MULT, Math.max(MIN_MULT, mults.reduce((a, b) => a * b, 1)));
    return { price: roundPrice((Number(base) || 0) * mult), mult, notes };
}
