import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../site/film-motion.js", import.meta.url), "utf8");
const window = {};
runInNewContext(source, { window });
const motion = window.SyncActionFilmMotion;
const duration = 47;
const rate = 120;
// Product-specific regression limits, not platform design standards.
const maxSpeed = 1200;
const maxAcceleration = 18000;
const cursor = (time, id) => motion.sample(time).cursors.find((value) => value.id === id);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const plain = (value) => JSON.parse(JSON.stringify(value));
const inside = (point, target) =>
  point.x >= target.x &&
  point.x <= target.x + target.width &&
  point.y >= target.y &&
  point.y <= target.y + target.height;
const nearEdge = (point) => point.x < 0 || point.x > 1436 || point.y < 0 || point.y > 806;

test("the whole film retains both identities and continuous positions, including offscreen travel", () => {
  let previous;
  let previousVelocity;
  for (let frame = 0; frame <= duration * rate; frame++) {
    const sample = motion.sample(frame / rate);
    assert.deepEqual(plain(sample.cursors.map(({ id }) => id)), ["you", "friend"]);
    assert.deepEqual(plain(sample.cameraOffset), { x: 0, y: 0 });
    const velocity = [];
    sample.cursors.forEach((point, index) => {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.equal(point.opacity, 1, `identity must not disappear in place at ${sample.time}`);
      assert.equal(typeof point.visible, "boolean");
      if (!point.visible) {
        assert.ok(nearEdge(point), `hidden pointer inside the frame at ${sample.time}`);
      }
      if (!previous) return;
      const before = previous.cursors[index];
      const value = { x: (point.x - before.x) * rate, y: (point.y - before.y) * rate };
      velocity.push(value);
      assert.ok(Math.hypot(value.x, value.y) <= maxSpeed, `position jump at ${sample.time}`);
      if (point.visible !== before.visible) {
        assert.ok(nearEdge(point) && nearEdge(before), `interior reappearance at ${sample.time}`);
      }
      if (previousVelocity) {
        const acceleration = distance(value, previousVelocity[index]) * rate;
        assert.ok(acceleration <= maxAcceleration, `abrupt velocity change at ${sample.time}`);
      }
    });
    previous = sample;
    if (velocity.length) previousVelocity = velocity;
  }
});

test("chapter changes do not reset a pointer or camera", () => {
  for (const time of [3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43]) {
    for (const id of ["you", "friend"]) {
      assert.ok(distance(cursor(time - 0.000001, id), cursor(time + 0.000001, id)) < 0.003);
    }
    assert.deepEqual(plain(motion.sample(time).cameraOffset), { x: 0, y: 0 });
  }
});

test("the second person enters from the right on the 3-second beat and keeps their identity", () => {
  assert.equal(cursor(2.8, "friend").visible, false);
  assert.equal(cursor(3, "friend").visible, true);
  assert.ok(cursor(3, "friend").x >= 1440);
  assert.equal(cursor(24.15, "friend").role, "recipient-device");
  assert.equal(cursor(26.15, "you").role, "owner");
  assert.equal(cursor(38.8, "friend").visible, false);
  assert.equal(cursor(39, "friend").visible, true);
  assert.ok(cursor(39, "friend").x >= 1440);
});

test("clicks land on their named controls after a stable hold, then confirm", () => {
  const actions = [
    ["friend", 4.18, "join", 1180, 552],
    ["you", 8.3, "pause", 185, 584],
    ["you", 12, "share", 242, 565],
    ["you", 13.8, "page", 954, 390],
    ["you", 20.55, "view", 719, 458],
    ["you", 21.9, "return", 282, 458],
    ["friend", 24.15, "invitation", 292, 450],
    ["you", 26.15, "approve", 331, 450],
    ["you", 28.55, "reconnect", 609, 436],
    ["you", 31.75, "server", 567, 471],
    ["you", 33.55, "login", 567, 449],
    ["you", 36.5, "consent", 355.5, 407.5],
    ["you", 37.4, "allow", 610.5, 468],
    ["you", 38.35, "revoke", 610.5, 468],
  ];
  assert.equal(motion.clicks.length, actions.length);
  for (const [id, time, targetId, x, y] of actions) {
    const point = cursor(time, id);
    const target = motion.sample(time).targets.find(({ id }) => id === targetId);
    assert.ok(target && inside(point, target), `${targetId} misses its control`);
    assert.deepEqual({ x: point.x, y: point.y }, { x, y });
    assert.ok(point.visible && point.click);
    assert.equal(point.targetId, targetId);
    for (const offset of [-0.075, 0.075]) {
      assert.ok(
        distance(point, cursor(time + offset, id)) < 0.01,
        `${targetId} is not held steady`,
      );
    }
    const event = motion.clicks.find(({ target }) => target === targetId);
    assert.ok(event.confirmed > time);
    assert.equal(motion.confirmed(targetId, event.confirmed - 1 / rate), false);
    assert.equal(motion.confirmed(targetId, event.confirmed), true);
  }
});

test("dragging follows the seek bar continuously after pause confirmation", () => {
  assert.deepEqual({ x: cursor(9.25, "you").x, y: cursor(9.25, "you").y }, { x: 353.5, y: 561 });
  assert.deepEqual({ x: cursor(9.95, "you").x, y: cursor(9.95, "you").y }, { x: 635.5, y: 561 });
  let previousX = -Infinity;
  for (let time = 9.25; time <= 9.95; time += 1 / rate) {
    const point = cursor(time, "you");
    assert.ok(point.dragging && point.targetId === "seek");
    assert.ok(point.x >= previousX && inside(point, motion.targets.seek));
    assert.equal(point.y, 561);
    assert.equal(motion.confirmed("pause", time), true);
    previousX = point.x;
  }
});

test("changing into and out of the pen does not teleport its tip", () => {
  const start = cursor(16.1, "you");
  const end = cursor(16.9, "you");
  assert.deepEqual({ x: start.x, y: start.y }, { x: 179, y: 415 });
  assert.ok(Math.abs(end.x - 477.9) < 0.001 && end.y > 410 && end.y < 420);
  assert.equal(start.tool, "pen");
  assert.equal(end.tool, "pen");
  for (const time of [16.1, 16.9]) {
    assert.ok(distance(cursor(time - 0.0001, "you"), cursor(time + 0.0001, "you")) < 0.001);
  }
  assert.equal(cursor(16.9001, "you").tool, "arrow");
});

test("seeking and out-of-order rendering produce the same complete motion state", () => {
  const times = [0, 3, 4.18, 16.5, 23, 25.4, 35, 39, 43, 47];
  const first = times.map((time) => plain(motion.sample(time)));
  for (const time of [...times].reverse()) motion.sample(time);
  assert.deepEqual(
    times.map((time) => plain(motion.sample(time))),
    first,
  );
  assert.deepEqual(plain(motion.sample(-1)), plain(motion.sample(0)));
  assert.deepEqual(plain(motion.sample(48)), plain(motion.sample(47)));
});
