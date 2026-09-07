import assert from 'node:assert/strict';
import test from 'node:test';
import {
    GAME_MAX_DURATION_MS,
    GAME_MIN_DURATION_MS,
    INACTIVITY_BUFFER_MS,
    MAX_HISTORY_POINTS,
    MAX_TIME_WINDOW_MS,
    MIN_TIME_WINDOW_MS,
    buildElapsedHistory,
    capHistoryPoints,
    clampGameDuration,
    getTimeWindow,
    mergeHistoriesByPlayer
} from './game-time.js';

test('compresses long unchanged breaks to the five-minute buffer', () => {
    const points = buildElapsedHistory([
        { t: 0, v: 100 },
        { t: 60 * 1000, v: 110 },
        { t: 24 * 60 * 60 * 1000, v: 120 }
    ], 0);

    assert.deepEqual(points.map((point) => point.x), [0, 60 * 1000, 6 * 60 * 1000]);
    assert.deepEqual(getTimeWindow(points), { min: 0, max: 6 * 60 * 1000 });
});

test('keeps chart windows and game durations within their limits', () => {
    assert.equal(clampGameDuration(1), GAME_MIN_DURATION_MS);
    assert.equal(clampGameDuration(Infinity), GAME_MAX_DURATION_MS);
    assert.equal(INACTIVITY_BUFFER_MS, 5 * 60 * 1000);
});

test('window opens at the first change and holds five minutes', () => {
    const firstChange = 10 * 60 * 1000;
    assert.deepEqual(
        getTimeWindow([{ x: firstChange }]),
        { min: firstChange, max: firstChange + MIN_TIME_WINDOW_MS }
    );
    assert.deepEqual(getTimeWindow([]), { min: 0, max: MIN_TIME_WINDOW_MS });
});

test('grows the window with activity but never past the cap', () => {
    const start = 5 * 60 * 1000;
    const grown = getTimeWindow([
        { x: start },
        { x: start + MAX_TIME_WINDOW_MS * 2 }
    ]);
    assert.deepEqual(grown, { min: start, max: start + MAX_TIME_WINDOW_MS });
});

test('does not let pre-game points move the game-time baseline', () => {
    const points = buildElapsedHistory([
        { t: 0, v: 100 },
        { t: 100, v: 105 },
        { t: 110, v: 110 }
    ], 100);

    assert.deepEqual(points.map((point) => point.x), [0, 10]);
    assert.deepEqual(points.map((point) => point.v), [105, 110]);
});

test('merges duplicate player docs into one line', () => {
    const merged = mergeHistoriesByPlayer([
        { username: 'Al', roomCode: 'AB', gameCreatedAt: 1000, history: [{ t: 1000, v: 10 }, { t: 3000, v: 30 }] },
        { username: 'Al', roomCode: 'AB', gameCreatedAt: 1000, history: [{ t: 2000, v: 20 }] },
        { username: 'Bo', roomCode: 'AB', gameCreatedAt: 1000, history: [{ t: 1000, v: 5 }] }
    ]);

    assert.equal(merged.length, 2);
    const al = merged.find((group) => group.username === 'Al');
    assert.deepEqual(al.history.map((point) => point.v), [10, 20, 30]);
    assert.equal(al.gameCreatedAt, 1000);
});

test('keeps same names in different rooms on separate lines', () => {
    const merged = mergeHistoriesByPlayer([
        { username: 'Al', roomCode: 'AB', gameCreatedAt: 1000, history: [{ t: 1000, v: 10 }] },
        { username: 'Al', roomCode: 'CD', gameCreatedAt: 1000, history: [{ t: 1000, v: 50 }] }
    ]);

    assert.equal(merged.length, 2);
});

test('room AB + user CD does not fold into room ABC + user D', () => {
    const merged = mergeHistoriesByPlayer([
        { username: 'CD', roomCode: 'AB', gameCreatedAt: 1000, history: [{ t: 1000, v: 10 }] },
        { username: 'D', roomCode: 'ABC', gameCreatedAt: 1000, history: [{ t: 1000, v: 50 }] }
    ]);

    assert.equal(merged.length, 2);
});

test('skips docs with no usable history or start time', () => {
    const merged = mergeHistoriesByPlayer([
        { username: 'Al', roomCode: 'AB', gameCreatedAt: 1000, history: [] },
        { username: 'Bo', roomCode: 'AB', gameCreatedAt: 'not-a-time', history: [{ t: 1000, v: 5 }] },
        null
    ]);

    assert.deepEqual(merged, []);
});

test('cap keeps short histories untouched', () => {
    const points = [{ t: 1, v: 1 }, { t: 2, v: 2 }];
    assert.deepEqual(capHistoryPoints(points, 500), points);
    assert.equal(MAX_HISTORY_POINTS, 500);
});

test('cap thins instead of truncating so the full range stays visible', () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, v: i }));
    const capped = capHistoryPoints(points, 5);
    assert.equal(capped.length, 5);
    // range anchor first, live tail last, order kept
    assert.deepEqual(capped.map((point) => point.t), [0, 1000, 4000, 6000, 9000]);
});
