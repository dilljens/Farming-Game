export const GAME_MIN_DURATION_MS = 60 * 60 * 1000;
export const GAME_MAX_DURATION_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_GAME_DURATION_MS = GAME_MAX_DURATION_MS;
export const MIN_TIME_WINDOW_MS = 5 * 60 * 1000;
export const MAX_TIME_WINDOW_MS = 5 * 60 * 60 * 1000;
export const INACTIVITY_BUFFER_MS = 5 * 60 * 1000;
// Cap on stored chart points per player. Raised so long games keep their
// full range (thinning below preserves the span instead of cutting history).
export const MAX_HISTORY_POINTS = 500;

function newGameId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `game-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function asTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (value && Number.isFinite(value.seconds)) {
        return value.seconds * 1000 + Math.round((value.nanoseconds || 0) / 1e6);
    }
    return NaN;
}

export function clampGameDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration)) return DEFAULT_GAME_DURATION_MS;
    return Math.min(GAME_MAX_DURATION_MS, Math.max(GAME_MIN_DURATION_MS, duration));
}

export function createGame(createdAt = Date.now()) {
    return {
        id: newGameId(),
        createdAt: asTimestamp(createdAt),
        durationMs: DEFAULT_GAME_DURATION_MS
    };
}

export function normalizeGame(game, fallbackCreatedAt = Date.now()) {
    const createdAt = asTimestamp(game?.createdAt);
    return {
        id: typeof game?.id === 'string' && game.id ? game.id : newGameId(),
        createdAt: Number.isFinite(createdAt) ? createdAt : asTimestamp(fallbackCreatedAt),
        durationMs: clampGameDuration(game?.durationMs)
    };
}

export function normalizeHistoryPoints(points) {
    const byTimestamp = new Map();
    (Array.isArray(points) ? points : []).forEach((point) => {
        const t = asTimestamp(point?.t);
        const v = Number(point?.v);
        if (Number.isFinite(t) && Number.isFinite(v)) {
            byTimestamp.set(t, { t, v });
        }
    });
    return [...byTimestamp.values()].sort((a, b) => a.t - b.t);
}

// Cap stored points WITHOUT cutting the visible range: keep the first
// point (the range anchor) plus an evenly-spaced sample spanning through
// the latest point, so a long game's line always covers its full span and
// the live tail is never dropped.
export function capHistoryPoints(points, maxPoints = MAX_HISTORY_POINTS) {
    const list = Array.isArray(points) ? points : [];
    const max = Math.max(0, Math.floor(Number(maxPoints) || 0));
    if (list.length <= max) return list.slice();
    if (max < 2) return [];
    const rest = list.slice(1);
    const keep = max - 1;
    const out = [list[0]];
    if (keep === 1) {
        out.push(rest[rest.length - 1]);
    } else {
        for (let i = 0; i < keep; i++) {
            out.push(rest[Math.round((i * (rest.length - 1)) / (keep - 1))]);
        }
    }
    return normalizeHistoryPoints(out);
}

// Merge leaderboard docs that belong to the same player in the same room.
// One human can own several docs (phone + desktop, or a fresh anonymous
// sign-in after clearing storage): plotted separately they share a label
// and color and fold over each other like one broken line. Merged, they
// form the single stock-like line the chart is meant to show.
export function mergeHistoriesByPlayer(entries, maxPoints = MAX_HISTORY_POINTS) {
    const groups = new Map();
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
        if (!entry || !Array.isArray(entry.history) || entry.history.length === 0) return;
        const createdAt = asTimestamp(entry.gameCreatedAt);
        if (!Number.isFinite(createdAt)) return;
        const key = `${entry.roomCode || ''}${entry.username || '?'}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                username: entry.username,
                roomCode: entry.roomCode ?? null,
                history: [],
                gameCreatedAt: createdAt
            };
            groups.set(key, group);
        }
        group.history = group.history.concat(entry.history);
        if (createdAt < group.gameCreatedAt) group.gameCreatedAt = createdAt;
    });
    return [...groups.values()].map((group) => ({
        username: group.username,
        roomCode: group.roomCode,
        gameCreatedAt: group.gameCreatedAt,
        history: capHistoryPoints(normalizeHistoryPoints(group.history), maxPoints)
    }));
}

// Turn wall-clock history into game time. A gap with no recorded state change
// never consumes more than the five-minute break buffer on the chart.
export function buildElapsedHistory(points, createdAt, inactivityBuffer = INACTIVITY_BUFFER_MS) {
    const gameStart = asTimestamp(createdAt);
    const normalized = normalizeHistoryPoints(points)
        .filter((point) => !Number.isFinite(gameStart) || point.t >= gameStart);
    if (normalized.length === 0) return [];

    let previousTimestamp = Number.isFinite(gameStart) ? gameStart : normalized[0].t;
    let elapsed = 0;

    return normalized.map((point) => {
        // Ignore stale points from before this game and do not let them move
        // the baseline backwards for subsequent points.
        const effectiveTimestamp = Number.isFinite(gameStart)
            ? Math.max(point.t, gameStart)
            : point.t;
        const gap = Math.max(0, effectiveTimestamp - previousTimestamp);
        elapsed += Math.min(gap, inactivityBuffer);
        previousTimestamp = Math.max(previousTimestamp, effectiveTimestamp);
        return { ...point, x: elapsed };
    });
}

// The visible window opens at the first recorded state change (not game
// creation) and stays exactly five minutes wide until elapsed time exceeds
// five minutes, then grows up to the five-hour cap.
export function getTimeWindow(elapsedPoints) {
    const xs = (Array.isArray(elapsedPoints) ? elapsedPoints : [])
        .map((point) => Number(point?.x))
        .filter((x) => Number.isFinite(x));
    const start = xs.length ? Math.min(...xs) : 0;
    const latest = xs.length ? Math.max(...xs) : 0;
    const width = Math.min(
        MAX_TIME_WINDOW_MS,
        Math.max(MIN_TIME_WINDOW_MS, latest - start)
    );
    return { min: start, max: start + width };
}

export function formatGameTime(value) {
    const totalSeconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (part) => String(part).padStart(2, '0');
    return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${minutes}:${pad(seconds)}`;
}
