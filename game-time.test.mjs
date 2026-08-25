import assert from 'node:assert/strict';
import test from 'node:test';
import {
    GAME_MAX_DURATION_MS,
    GAME_MIN_DURATION_MS,
    INACTIVITY_BUFFER_MS,
    MAX_TIME_WINDOW_MS,
    MIN_TIME_WINDOW_MS,
    buildElapsedHistory,
    clampGameDuration,
    getTimeWindow
} from './game-time.mjs';

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
