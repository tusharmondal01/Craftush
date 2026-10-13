import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraAt, cropForCamera, normalizeEvents, screenPointToSource } from '../public/cursor/camera.js';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const poseNear = (actual, expected, tolerance = 1e-9) => {
  for (const key of ['x', 'y', 'zoom']) near(actual[key], expected[key], tolerance);
};

test('random seeking yields the same poses as chronological export', () => {
  const events = [
    { time: 1, duration: 1, x: .2, y: .8, zoom: 3 },
    { time: 1.45, duration: .8, x: .9, y: .1, zoom: 1.5 },
    { time: 4, duration: 2, x: .4, y: .5, zoom: 4 },
  ];
  const times = [0, 1, 1.2, 1.45, 1.8, 2.25, 3, 4.6, 6, 10];
  const expected = new Map(times.map(time => [time, cameraAt(events, time)]));
  for (const time of [6, 1.45, 0, 10, 1.2, 4.6, 2.25, 1, 3, 1.8]) assert.deepEqual(cameraAt(events, time), expected.get(time));
});

test('overlapping event starts at the exact interrupted pose without a positional jump', () => {
  const first = { time: 1, duration: 2, x: .1, y: .9, zoom: 4 };
  const second = { time: 1.7, duration: .8, x: .9, y: .2, zoom: 1.2 };
  const interrupted = cameraAt([first], second.time);
  poseNear(cameraAt([first, second], second.time), interrupted);
  poseNear(cameraAt([first, second], second.time + 1e-6), interrupted, 1e-7);
  poseNear(cameraAt([first, second], 2.5), { x: .9, y: .2, zoom: 1.2 });
});

test('zoom has a geometric halfway point and smooth stationary endpoints', () => {
  const events = [{ time: 1, duration: 1, x: 1, y: 0, zoom: 4 }];
  poseNear(cameraAt(events, 1.5), { x: .75, y: .25, zoom: 2 });
  poseNear(cameraAt(events, 1), { x: .5, y: .5, zoom: 1 });
  poseNear(cameraAt(events, 2), { x: 1, y: 0, zoom: 4 });
  const epsilon = 1e-4;
  assert.ok(Math.abs(cameraAt(events, 1 + epsilon).x - .5) / epsilon < 1e-6);
  assert.ok(Math.abs(1 - cameraAt(events, 2 - epsilon).x) / epsilon < 1e-6);
  for (let time = 1; time <= 2; time += .01) {
    const pose = cameraAt(events, time);
    assert.ok(pose.x >= .5 && pose.x <= 1 && pose.y >= 0 && pose.y <= .5 && pose.zoom >= 1 && pose.zoom <= 4);
  }
});

test('sanitization rejects non-finite events, clamps values and preserves latest same-time edit', () => {
  const input = [
    { id: 'old', time: 2, duration: .1, x: -1, y: 2, zoom: 8 },
    { id: 'bad', time: NaN, duration: 1, x: .5, y: .5, zoom: 2 },
    { id: 'new', time: 2, duration: 5, x: .8, y: .4, zoom: 3 },
    { id: 'early', time: -1, duration: .01, x: -1, y: 2, zoom: .1 },
    { id: 'infinite', time: 4, duration: Infinity, x: .5, y: .5, zoom: 2 },
  ];
  const snapshot = structuredClone(input);
  const events = normalizeEvents(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(events.map(event => event.id), ['early', 'new']);
  assert.deepEqual(events[0], { id: 'early', time: 0, duration: .15, x: 0, y: 1, zoom: 1, easing: 'smooth' });
  assert.equal(events[1].duration, 2.5);
  poseNear(cameraAt(input, 10), { x: .8, y: .4, zoom: 3 });
});

test('mobile cover crops remain within the source at every edge and preserve frame aspect', () => {
  for (const x of [0, .5, 1]) for (const y of [0, .5, 1]) for (const zoom of [1, 2, 5]) {
    const crop = cropForCamera(1080, 1920, 1280, 720, { x, y, zoom });
    assert.ok(crop.sx >= 0 && crop.sy >= 0);
    assert.ok(crop.sx + crop.cropW <= 1080 + 1e-9);
    assert.ok(crop.sy + crop.cropH <= 1920 + 1e-9);
    near(crop.cropW / crop.cropH, 1280 / 720);
  }
  const natural = cropForCamera(1080, 1920, 720, 1280, { x: .5, y: .5, zoom: 1 });
  near(natural.cropW, 1080); near(natural.cropH, 1920);
  assert.throws(() => cropForCamera(0, 1920, 720, 1280), RangeError);
});

test('source point mapping accounts for portrait letterboxing and zoomed edge clamping', () => {
  const mobile = cropForCamera(1080, 1920, 1280, 720, { fit: 'contain', zoom: 1 });
  near(mobile.fw, 405); near(mobile.fx, 437.5);
  assert.equal(screenPointToSource(100, 360, mobile), null);
  assert.deepEqual(screenPointToSource(640, 360, mobile), { x: .5, y: .5 });
  assert.deepEqual(screenPointToSource(mobile.fx, 0, mobile), { x: 0, y: 0 });
  assert.deepEqual(screenPointToSource(mobile.fx + mobile.fw, 720, mobile), { x: 1, y: 1 });
  const corner = cropForCamera(1080, 1920, 720, 1280, { x: 1, y: 1, zoom: 2 });
  assert.deepEqual(screenPointToSource(360, 640, corner), { x: .75, y: .75 });
  assert.equal(screenPointToSource(NaN, 0, corner), null);
});
