import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../site/film-motion.js", import.meta.url), "utf8");
const window = {};
runInNewContext(source, { window });
const motion = window.SyncActionFilmMotion;
const duration = 32;
const rate = 120;
const ids = ["you", "friend", "mei", "zhou"];
// Film-specific jump guards, not measured human behavior or platform standards.
const maxSpeed = 1200;
const maxAcceleration = 18000;
const cursor = (time, id) => motion.sample(time).cursors.find((value) => value.id === id);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const plain = (value) => JSON.parse(JSON.stringify(value));
const velocity = (time, id) => {
  const before = cursor(time - 0.00001, id);
  const after = cursor(time + 0.00001, id);
  return { x: (after.x - before.x) / 0.00002, y: (after.y - before.y) / 0.00002 };
};
const inside = (point, target) =>
  point.x >= target.x &&
  point.x <= target.x + target.width &&
  point.y >= target.y &&
  point.y <= target.y + target.height;
const nearEdge = (point) => point.x <= 1 || point.x >= 1439 || point.y <= 1 || point.y >= 809;

test("four persistent identities keep continuous positions, including before each entrance", () => {
  assert.equal(motion.duration, duration);
  let previous;
  let previousVelocity;
  for (let frame = 0; frame <= duration * rate; frame++) {
    const sample = motion.sample(frame / rate);
    assert.deepEqual(plain(sample.cursors.map(({ id }) => id)), ids);
    assert.deepEqual(plain(sample.cameraOffset), { x: 0, y: 0 });
    const currentVelocity = [];
    sample.cursors.forEach((point, index) => {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.equal(point.opacity, 1, `pointer vanishes at ${sample.time}`);
      assert.equal(point.name, motion.people[point.id].name);
      assert.equal(point.color, motion.people[point.id].color);
      assert.ok(point.nameOpacity >= 0 && point.nameOpacity <= 1);
      if (!point.visible) assert.ok(nearEdge(point), `hidden inside frame at ${sample.time}`);
      if (!previous) return;
      const before = previous.cursors[index];
      const value = { x: (point.x - before.x) * rate, y: (point.y - before.y) * rate };
      currentVelocity.push(value);
      assert.ok(Math.hypot(value.x, value.y) <= maxSpeed, `${point.id} jumps at ${sample.time}`);
      if (point.visible !== before.visible)
        assert.ok(nearEdge(point) || nearEdge(before), `interior reappearance at ${sample.time}`);
      if (previousVelocity)
        assert.ok(
          distance(value, previousVelocity[index]) * rate <= maxAcceleration,
          `${point.id} abrupt velocity at ${sample.time}`,
        );
    });
    previous = sample;
    if (currentVelocity.length) previousVelocity = currentVelocity;
  }
});

test("hero camera and chapter changes do not reset a pointer's position or velocity", () => {
  for (const time of [3, 5.8, 8.5, 11.6, 14, 18.5, 21, 24, 28]) {
    for (const id of ids)
      assert.ok(distance(cursor(time - 0.000001, id), cursor(time + 0.000001, id)) < 0.003);
  }
  for (const [id, track] of Object.entries(motion.tracks)) {
    for (const [time] of track.slice(1, -1)) {
      assert.ok(distance(cursor(time - 0.000001, id), cursor(time + 0.000001, id)) < 0.003);
      assert.ok(
        distance(velocity(time - 0.0001, id), velocity(time + 0.0001, id)) < 10,
        `velocity reset at ${id}:${time}`,
      );
    }
  }
});

test("people progressively enter on their beats, then remain in the picture through the ending", () => {
  const entrances = [
    ["friend", 3],
    ["mei", 8.5],
    ["zhou", 14],
  ];
  for (const [id, time] of entrances) {
    assert.equal(cursor(time - 1 / rate, id).visible, false, `${id} enters too early`);
    const first = cursor(time, id);
    assert.ok(first.visible && nearEdge(first), `${id} must enter with their tip at an edge`);
    assert.equal(cursor(time - 1 / rate, id).nameOpacity, 0);
    for (let sample = time; sample <= duration; sample += 1 / rate)
      assert.ok(cursor(sample, id).visible, `${id} leaves again at ${sample}`);
  }
  for (const [time, count] of [
    [0, 1],
    [3.2, 2],
    [8.7, 3],
    [14.8, 4],
    [28, 4],
    [32, 4],
  ])
    assert.equal(motion.sample(time).cursors.filter(({ visible }) => visible).length, count);
  for (let time = 14.8; time <= duration; time += 1 / rate) {
    const points = motion.sample(time).cursors;
    assert.equal(points.filter(({ visible }) => visible).length, 4);
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++)
        assert.ok(distance(points[a], points[b]) > 60, `quartet overlaps at ${time}`);
  }
});

test("travel has shallow curves and momentum, while reading holds are staggered", () => {
  for (const [id, time] of [
    ["you", 0.45],
    ["you", 5.7],
    ["friend", 3.46],
    ["friend", 9.98],
    ["mei", 8.91],
    ["zhou", 14.43],
  ]) {
    const speed = velocity(time, id);
    assert.ok(Math.hypot(speed.x, speed.y) > 25, `${id} mechanically stops at ${time}`);
  }
  for (const [id, start, end] of [
    ["you", 0.16, 0.45],
    ["friend", 4.19, 4.65],
    ["mei", 10.02, 10.61],
  ]) {
    const a = cursor(start, id);
    const b = cursor(end, id);
    const p = cursor((start + end) / 2, id);
    const offset = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / distance(a, b);
    assert.ok(offset > 1, `${id} remains a straight-line tween`);
  }
  // One person's reading hold must not freeze everyone or force a shared idle loop.
  assert.ok(distance(cursor(15.04, "you"), cursor(15.3, "you")) < 0.01);
  assert.ok(distance(cursor(15.04, "friend"), cursor(15.3, "friend")) > 20);
  assert.ok(distance(cursor(15.8, "mei"), cursor(16.4, "mei")) < 0.01);
  assert.ok(distance(cursor(15.8, "zhou"), cursor(16.4, "zhou")) > 20);
});

test("semantic clicks settle on the actual control, and confirmation follows the click", () => {
  const actions = [
    ["friend", 4.05, "join"],
    ["you", 6.25, "pause"],
    ["you", 9.15, "share"],
    ["friend", 10.5, "page"],
    ["friend", 13.1, "danmaku"],
    ["you", 19, "view"],
    ["you", 20.1, "return"],
    ["friend", 21.8, "invitation"],
    ["you", 22.85, "approve"],
    ["you", 24.65, "server"],
    ["you", 25.65, "login"],
    ["you", 26.25, "consent"],
    ["you", 26.7, "allow"],
    ["you", 27.5, "revoke"],
  ];
  assert.equal(motion.clicks.length, actions.length);
  for (const [id, time, targetId] of actions) {
    const point = cursor(time, id);
    assert.ok(inside(point, motion.targets[targetId]), `${targetId} misses its drawn control`);
    assert.ok(point.visible && point.click);
    assert.equal(point.targetId, targetId);
    for (const offset of [-0.07, 0.07])
      assert.ok(
        distance(point, cursor(time + offset, id)) < 0.1,
        `${targetId} clicks while travelling`,
      );
    const event = motion.clicks.find(({ target }) => target === targetId);
    assert.ok(event.confirmed > time);
    assert.equal(motion.confirmed(targetId, event.confirmed - 1 / rate), false);
    assert.equal(motion.confirmed(targetId, event.confirmed), true);
  }
  const pointing = cursor(16.1, "zhou");
  assert.deepEqual({ x: pointing.x, y: pointing.y }, { x: 1080, y: 460 });
  assert.equal(pointing.click, false);
  assert.equal(pointing.targetId, null);
  assert.equal(motion.targets.marker, undefined);
});

test("seeking stays paused and drawing uses the renderer's exact pen tip progress", () => {
  for (let step = 0; step <= 84; step++) {
    const time = 7 + step / rate;
    const point = cursor(time, "you");
    assert.ok(Math.abs(point.x - 520 - 392 * motion.seekProgress(time)) < 0.0001);
    assert.equal(point.y, 570);
    assert.ok(inside(point, motion.targets.seek));
    assert.equal(motion.confirmed("pause", time), true);
  }
  for (let step = 0; step <= 114; step++) {
    const time = 12.15 + step / rate;
    const point = cursor(time, "you");
    const progress = motion.penProgress(time);
    assert.ok(Math.abs(point.x - 270 - 370 * progress) < 0.0001);
    assert.ok(Math.abs(point.y - 505 - Math.sin(Math.PI * progress) * 18) < 0.0001);
  }
  for (const time of [7, 7.7, 12.15, 13.1])
    assert.ok(distance(cursor(time - 0.0001, "you"), cursor(time + 0.0001, "you")) < 0.001);
});

test("private setup actions keep the three observers over the separate shared content", () => {
  for (let time = 24; time < 28; time += 1 / rate) {
    for (const id of ["friend", "mei", "zhou"]) {
      const point = cursor(time, id);
      assert.equal(point.role, "shared-page-observer");
      assert.ok(point.x < 850, `${id} crosses into another person's private controls`);
      assert.equal(point.click, false);
    }
  }
  assert.equal(cursor(21.8, "friend").role, "recipient-device");
  assert.equal(cursor(22.85, "you").role, "owner");
});

test("the ending leaves the central brand area clear and retains independent motion", () => {
  const brand = { x: 350, y: 230, width: 750, height: 390 };
  for (let time = 28; time <= duration; time += 1 / rate) {
    for (const point of motion.sample(time).cursors) {
      assert.equal(inside(point, brand), false, `pointer covers the brand at ${time}`);
      // The right/down name badge must also remain outside the central text area.
      assert.equal(
        inside({ x: point.x + 76, y: point.y + 57 }, brand),
        false,
        `name badge covers the brand at ${time}`,
      );
    }
  }
  for (const id of ids) {
    let travelled = 0;
    for (let frame = 28 * rate + 1; frame <= duration * rate; frame++)
      travelled += distance(cursor((frame - 1) / rate, id), cursor(frame / rate, id));
    assert.ok(travelled > 60, `${id} freezes for the ending`);
  }
});

test("out-of-order rendering and seeking remain deterministic", () => {
  const times = [0, 3, 6.25, 8.5, 12.6, 14, 18.5, 24, 28, 30, 32];
  const first = times.map((time) => plain(motion.sample(time)));
  for (const time of [...times].reverse()) motion.sample(time);
  assert.deepEqual(
    times.map((time) => plain(motion.sample(time))),
    first,
  );
  assert.deepEqual(plain(motion.sample(-1)), plain(motion.sample(0)));
  assert.deepEqual(plain(motion.sample(33)), plain(motion.sample(32)));
});
