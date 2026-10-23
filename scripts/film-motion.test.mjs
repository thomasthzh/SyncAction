import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../site/film-motion.js", import.meta.url), "utf8");
const window = {};
runInNewContext(source, { window });
const motion = window.SyncActionFilmMotion;
const duration = 36;
const rate = 120;
const ids = ["you", "friend", "mei", "zhou"];
// Project regression guards; these do not establish human-likeness or a platform standard.
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
const nearEdge = (point) => point.x < 0 || point.x > 1436 || point.y < 0 || point.y > 806;

test("all four identities retain finite continuous positions, including their offscreen travel", () => {
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
      assert.equal(point.opacity, 1, `pointer disappears in place at ${sample.time}`);
      assert.equal(point.name, motion.people[point.id].name);
      assert.equal(point.color, motion.people[point.id].color);
      if (!point.visible) assert.ok(nearEdge(point), `hidden inside frame at ${sample.time}`);
      if (!previous) return;
      const before = previous.cursors[index];
      const value = { x: (point.x - before.x) * rate, y: (point.y - before.y) * rate };
      currentVelocity.push(value);
      assert.ok(
        Math.hypot(value.x, value.y) <= maxSpeed,
        `${point.id} position jump at ${sample.time}`,
      );
      if (point.visible !== before.visible)
        assert.ok(nearEdge(point) && nearEdge(before), `interior reappearance at ${sample.time}`);
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

test("chapter transitions and every authored knot keep position and velocity continuous", () => {
  for (const time of [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]) {
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

test("browsing routes curve and pass through waypoints instead of stopping at each one", () => {
  for (const [id, time] of [
    ["you", 0.56],
    ["you", 1.12],
    ["you", 10.38],
    ["friend", 3.52],
    ["friend", 7.42],
    ["mei", 31.15],
    ["zhou", 31.43],
  ]) {
    const speed = velocity(time, id);
    assert.ok(Math.hypot(speed.x, speed.y) > 25, `${id} mechanically stops at ${time}`);
  }
  // The midpoint of each selected travel segment must leave its straight chord.
  for (const [id, start, end] of [
    ["you", 0.56, 1.12],
    ["you", 9.88, 10.38],
    ["friend", 4.3, 4.8],
    ["mei", 30.5, 31.15],
  ]) {
    const a = cursor(start, id);
    const b = cursor(end, id);
    const p = cursor((start + end) / 2, id);
    const chordDistance =
      Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / distance(a, b);
    assert.ok(chordDistance > 1.5, `${id} remains a straight-line tween`);
  }
});

test("beat entrances use edges, and the final quartet stays distinct and present", () => {
  assert.equal(cursor(2.75, "friend").visible, false);
  assert.ok(cursor(3, "friend").visible && cursor(3, "friend").x >= 1440);
  for (const time of [0, 3, 12, 21, 27, 29.7]) {
    assert.equal(cursor(time, "mei").visible, false);
    assert.equal(cursor(time, "zhou").visible, false);
  }
  assert.equal(cursor(21.5, "friend").visible, false);
  assert.equal(cursor(29.7, "friend").visible, false);
  assert.ok(cursor(30, "friend").visible && cursor(30, "friend").x >= 1440);
  assert.ok(cursor(30.5, "mei").x <= 0);
  assert.ok(cursor(31, "zhou").y >= 810);
  for (let time = 31.7; time <= 36; time += 1 / rate) {
    const points = motion.sample(time).cursors;
    assert.equal(points.filter(({ visible }) => visible).length, 4);
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++)
        assert.ok(distance(points[a], points[b]) > 60, `quartet overlaps at ${time}`);
  }
  for (const id of ids) {
    assert.ok(distance(cursor(33.2, id), cursor(35.9, id)) > 15, `${id} freezes during the ending`);
    assert.equal(cursor(19, "friend").role, "recipient-device");
  }
});

test("each semantic click settles on its actual control before the UI confirms", () => {
  const actions = [
    ["friend", 4.15, "join"],
    ["you", 6.75, "pause"],
    ["you", 9.75, "share"],
    ["you", 11, "page"],
    ["you", 15.85, "view"],
    ["you", 17.1, "return"],
    ["friend", 19, "invitation"],
    ["you", 20.25, "approve"],
    ["you", 22.1, "reconnect"],
    ["you", 24.7, "server"],
    ["you", 26.1, "login"],
    ["you", 27.8, "consent"],
    ["you", 28.55, "allow"],
    ["you", 29.3, "revoke"],
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
        `${targetId} clicks while still travelling`,
      );
    const event = motion.clicks.find(({ target }) => target === targetId);
    assert.ok(event.confirmed > time);
    assert.equal(motion.confirmed(targetId, event.confirmed - 1 / rate), false);
    assert.equal(motion.confirmed(targetId, event.confirmed), true);
  }
});

test("paused seeking and pen strokes share the renderer's exact progress and tip", () => {
  for (let step = 0; step <= 84; step++) {
    const seekTime = 7.35 + step / rate;
    const seek = cursor(seekTime, "you");
    assert.ok(Math.abs(seek.x - 353.5 - 282 * motion.seekProgress(seekTime)) < 0.0001);
    assert.equal(seek.y, 561);
    assert.ok(inside(seek, motion.targets.seek));
    assert.equal(motion.confirmed("pause", seekTime), true);
    const penTime = 12.9 + step / rate;
    const pen = cursor(penTime, "you");
    const progress = motion.penProgress(penTime);
    assert.ok(Math.abs(pen.x - 179 - 298.9 * progress) < 0.0001);
    assert.ok(Math.abs(pen.y - 415 - Math.sin(49 * 0.12 * progress) * 3) < 0.0001);
    assert.equal(pen.tool, "pen");
  }
  for (const time of [7.35, 8.05, 12.9, 13.6])
    assert.ok(distance(cursor(time - 0.0001, "you"), cursor(time + 0.0001, "you")) < 0.001);
});

test("out-of-order rendering and seeking remain deterministic", () => {
  const times = [0, 3, 4.15, 13.2, 18, 21, 27, 30, 31.7, 33, 36];
  const first = times.map((time) => plain(motion.sample(time)));
  for (const time of [...times].reverse()) motion.sample(time);
  assert.deepEqual(
    times.map((time) => plain(motion.sample(time))),
    first,
  );
  assert.deepEqual(plain(motion.sample(-1)), plain(motion.sample(0)));
  assert.deepEqual(plain(motion.sample(37)), plain(motion.sample(36)));
});
