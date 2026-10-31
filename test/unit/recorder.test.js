import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeedRecorder } from "../../extension/recorder.js";

const MB = 1e6;

test("records one sample per second at a steady rate", () => {
  const recorder = new SpeedRecorder();
  let bytes = 0;
  recorder.start(0, 0);
  for (let time = 250; time <= 10000; time += 250) {
    bytes += 0.5 * MB; // 2 MB/s
    recorder.update(time, bytes);
  }
  assert.ok(Math.abs(recorder.current() - 2 * MB) < 1);
  const result = recorder.finish(10000, bytes);
  assert.equal(result.samples.interval, 1000);
  assert.equal(result.samples.values.length, 10);
  assert.ok(result.samples.values.every((value) => value === 2 * MB));
  assert.equal(result.avgSpeed, 2 * MB);
  assert.equal(result.peakSpeed, 2 * MB);
  assert.equal(result.received, 20 * MB);
});

test("paused time is a gap and doesn't count against the average", () => {
  const recorder = new SpeedRecorder();
  recorder.start(0, 0);
  let bytes = 0;
  for (let time = 500; time <= 4000; time += 500) { bytes += 1 * MB; recorder.update(time, bytes); } // 2 MB/s for 4 s
  for (let time = 4500; time <= 8000; time += 500) recorder.update(time, bytes, true);               // paused 4 s
  assert.equal(recorder.current(), 0);
  for (let time = 8500; time <= 12000; time += 500) { bytes += 1 * MB; recorder.update(time, bytes); }
  const result = recorder.finish(12000, bytes);
  assert.deepEqual(result.samples.values.slice(4, 8), [null, null, null, null]);
  assert.equal(result.activeMs, 8000);
  assert.equal(result.avgSpeed, 2 * MB);
  assert.equal(result.elapsedMs, 12000);
});

test("a stall reads as zero speed, not as a gap", () => {
  const recorder = new SpeedRecorder();
  recorder.start(0, 0);
  recorder.update(1000, 1 * MB);
  recorder.update(2000, 1 * MB);
  recorder.update(3000, 1 * MB);
  const result = recorder.finish(3000, 1 * MB);
  assert.deepEqual(result.samples.values, [1 * MB, 0, 0]);
});

test("long downloads halve resolution but keep live samples at one second", () => {
  const recorder = new SpeedRecorder({ maxPoints: 240 });
  recorder.start(0, 0);
  let bytes = 0;
  for (let second = 1; second <= 1000; second += 1) {
    bytes += (second % 2 ? 1 : 3) * MB;
    recorder.update(second * 1000, bytes);
  }
  const result = recorder.finish(1000000, bytes);
  assert.ok(result.samples.values.length <= 240);
  assert.equal(result.samples.interval, 8000);
  assert.ok(result.samples.values.every((value) => Math.abs(value - 2 * MB) < 1), "merged samples average correctly");
  assert.equal(recorder.recent(5).length, 5);
  assert.ok(result.peakSpeed >= 2 * MB);
});

test("a single burst doesn't become the peak", () => {
  const recorder = new SpeedRecorder();
  recorder.start(0, 0);
  const pattern = [1, 1, 1, 20, 1, 1, 1, 1];
  let bytes = 0;
  pattern.forEach((rate, index) => { bytes += rate * MB; recorder.update((index + 1) * 1000, bytes); });
  const result = recorder.finish(pattern.length * 1000, bytes);
  assert.ok(result.peakSpeed < 8 * MB, `peak ${result.peakSpeed} should be smoothed`);
  assert.ok(result.peakSpeed > 6 * MB);
});

test("late updates spread bytes across the missed seconds", () => {
  const recorder = new SpeedRecorder();
  recorder.start(0, 0);
  recorder.update(3000, 6 * MB);
  assert.deepEqual(recorder.recent(3), [2 * MB, 2 * MB, 2 * MB]);
});
