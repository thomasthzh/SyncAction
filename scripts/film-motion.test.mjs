import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../site/film-motion.js", import.meta.url), "utf8");
const window = {};
runInNewContext(source, { window });
const motion = window.SyncActionFilmMotion;
const duration = 30;
const rate = 120;
const ids = ["you", "friend", "mei", "zhou"];
const cursor = (time, id) => motion.sample(time).cursors.find((value) => value.id === id);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const speed = (point) => Math.hypot(point.velocity.x, point.velocity.y);
const plain = (value) => JSON.parse(JSON.stringify(value));
const inside = (point, target) =>
  point.x >= target.x &&
  point.x <= target.x + target.width &&
  point.y >= target.y &&
  point.y <= target.y + target.height;
const nearEdge = (point) => point.x <= 1 || point.x >= 1439 || point.y <= 1 || point.y >= 809;
const overlaps = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const numericVelocity = (time, id, delta = 0.000001) => {
  const a = cursor(time - delta, id),
    b = cursor(time + delta, id);
  return { x: (b.x - a.x) / (2 * delta), y: (b.y - a.y) / (2 * delta) };
};

// These are film-specific numerical acceptance limits, not measurements of humans.
test("persistent identities keep finite screen-space positions without jumps or opacity cuts", () => {
  assert.equal(motion.duration, duration);
  let previous;
  for (let frame = 0; frame <= duration * rate; frame++) {
    const state = motion.sample(frame / rate);
    assert.deepEqual(plain(state.cursors.map(({ id }) => id)), ids);
    assert.deepEqual(plain(state.cameraOffset), { x: 0, y: 0 });
    state.cursors.forEach((point, index) => {
      assert.ok([point.x, point.y, point.velocity.x, point.velocity.y].every(Number.isFinite));
      assert.equal(point.opacity, 1);
      assert.equal(point.name, motion.people[point.id].name);
      assert.equal(point.color, motion.people[point.id].color);
      assert.ok(point.nameOpacity >= 0 && point.nameOpacity <= 1);
      assert.ok(speed(point) < 1800, `${point.id} excessive sweep at ${state.time}`);
      if (!previous) return;
      const before = previous.cursors[index];
      assert.ok(distance(point, before) * rate < 1800, `${point.id} jumps at ${state.time}`);
      assert.ok(
        distance(point.velocity, before.velocity) * rate < 18000,
        `${point.id} abrupt acceleration at ${state.time}`,
      );
      if (point.visible !== before.visible)
        assert.ok(
          nearEdge(point) || nearEdge(before),
          `${point.id} reappears inside at ${state.time}`,
        );
    });
    previous = state;
  }
});

test("ordinary knots, chapter boundaries and gesture boundaries preserve C1 continuity", () => {
  const chapters = [3, 5.8, 7.5, 9.6, 11.5, 16.5, 19, 22, 26];
  for (const id of ids) {
    const times = [...chapters, ...motion.tracks[id].slice(1, -1).map(([time]) => time)];
    for (const time of times) {
      const a = cursor(time - 0.000001, id),
        b = cursor(time + 0.000001, id);
      assert.ok(distance(a, b) < 0.004, `position reset at ${id}:${time}`);
      assert.ok(distance(a.velocity, b.velocity) < 0.05, `velocity reset at ${id}:${time}`);
      assert.ok(
        distance(numericVelocity(time, id), cursor(time, id).velocity) < 0.025,
        `reported velocity differs from position derivative at ${id}:${time}`,
      );
    }
  }
});

test("entrances are progressive edge crossings and every visible pair stays separate", () => {
  for (const [id, time] of [
    ["friend", 3],
    ["mei", 7.5],
    ["zhou", 11.5],
  ]) {
    assert.equal(cursor(time - 1 / rate, id).visible, false, `${id} enters early`);
    assert.equal(cursor(time - 1 / rate, id).nameOpacity, 0);
    assert.ok(cursor(time, id).visible && nearEdge(cursor(time, id)));
    for (let frame = time * rate; frame <= duration * rate; frame++)
      assert.ok(cursor(frame / rate, id).visible, `${id} exits after entrance at ${frame / rate}`);
  }
  for (const [time, count] of [
    [0, 1],
    [3, 2],
    [7.5, 3],
    [11.5, 4],
    [26, 4],
    [30, 4],
  ])
    assert.equal(motion.sample(time).cursors.filter(({ visible }) => visible).length, count);
  for (let frame = 0; frame <= duration * rate; frame++) {
    const points = motion.sample(frame / rate).cursors.filter(({ visible }) => visible);
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++)
        assert.ok(
          distance(points[a], points[b]) > 60,
          `${points[a].id}/${points[b].id} overlap at ${frame / rate}`,
        );
  }
});

test("every entered pointer keeps moving, with curved independent reading and action routes", () => {
  for (const id of ids) {
    for (let frame = motion.people[id].enters * rate; frame <= duration * rate; frame++) {
      const time = frame / rate,
        point = cursor(time, id);
      assert.ok(speed(point) > 3, `${id} stops at ${time}`);
      if (time + 0.1 <= duration)
        assert.ok(
          distance(point, cursor(time + 0.1, id)) > 0.3,
          `${id} freezes in the 0.1s window beginning ${time}`,
        );
    }
  }
  for (const [id, start, end] of [
    ["you", 0, 0.7],
    ["friend", 3, 3.55],
    ["mei", 7.5, 7.95],
    ["zhou", 11.5, 11.9],
  ]) {
    const a = cursor(start, id),
      b = cursor(end, id),
      p = cursor((start + end) / 2, id);
    const offset = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / distance(a, b);
    assert.ok(offset > 1, `${id} moves on a straight tween`);
  }
  // Their reading directions differ; there is no shared orbit or synchronized idle path.
  for (const time of [12.5, 15, 21.5, 28.5]) {
    const velocities = motion.sample(time).cursors.map(({ velocity }) => velocity);
    for (let a = 0; a < velocities.length; a++)
      for (let b = a + 1; b < velocities.length; b++)
        assert.ok(distance(velocities[a], velocities[b]) > 10, `shared route at ${time}`);
  }
});

test("slow moving clicks hit actual controls and confirmation follows each action", () => {
  const actions = [
    ["friend", 4.05, "join", 4.18],
    ["you", 6.05, "pause", 6.17],
    ["you", 7.95, "share", 8.07],
    ["friend", 8.9, "page", 9.02],
    ["friend", 10.95, "danmaku", 11.07],
    ["you", 17.05, "view", 17.17],
    ["you", 18.35, "return", 18.47],
    ["friend", 19.65, "invitation", 19.77],
    ["you", 20.75, "approve", 20.87],
    ["you", 22.45, "server", 22.57],
    ["you", 23.3, "login", 23.42],
    ["you", 24, "consent", 24.12],
    ["you", 24.55, "allow", 24.67],
    ["you", 25.35, "revoke", 25.47],
  ];
  assert.equal(motion.clicks.length, actions.length);
  for (const [id, at, target, confirmed] of actions) {
    assert.deepEqual(plain(motion.clicks.find((event) => event.target === target)), {
      id,
      at,
      target,
      confirmed,
    });
    const point = cursor(at, id);
    assert.ok(point.visible && point.click);
    assert.equal(point.targetId, target);
    assert.ok(speed(point) >= 12 && speed(point) <= 80, `${target} must click while slowly moving`);
    for (let step = -12; step <= 12; step++)
      assert.ok(
        inside(cursor(at + step * 0.005, id), motion.targets[target]),
        `${target} leaves hit area during click`,
      );
    assert.equal(motion.confirmed(target, confirmed - 0.0001), false);
    assert.equal(motion.confirmed(target, confirmed), true);
    assert.ok(confirmed > at);
  }
  assert.equal(motion.targets.marker, undefined);
  assert.equal(motion.confirmed("unknown", 30), false);
});

test("paused seeking and annotation use shared progress with nonzero endpoint derivatives", () => {
  for (let step = 0; step <= 100; step++) {
    const fraction = step / 100,
      t = 6.55 + fraction * 0.65,
      point = cursor(t, "you");
    assert.ok(Math.abs(motion.seekProgress(t) - fraction) < 0.0000001);
    assert.ok(Math.abs(point.x - 520 - 392 * fraction) < 0.000001);
    assert.equal(point.y, 570);
    assert.ok(inside(point, motion.targets.seek));
    assert.ok(motion.confirmed("pause", t));
    assert.ok(point.dragging && point.targetId === "seek");
  }
  for (let step = 0; step <= 100; step++) {
    const fraction = step / 100,
      t = 9.9 + fraction * 0.75,
      point = cursor(t, "you");
    assert.ok(Math.abs(motion.penProgress(t) - fraction) < 0.0000001);
    assert.ok(Math.abs(point.x - 270 - 370 * fraction) < 0.000001);
    assert.ok(Math.abs(point.y - 505 - Math.sin(Math.PI * fraction) * 18) < 0.000001);
    assert.equal(point.tool, "pen");
  }
  for (const time of [6.55, 7.2, 9.9, 10.65]) {
    assert.ok(speed(cursor(time, "you")) > 490, `gesture stops at ${time}`);
    assert.ok(
      distance(cursor(time - 0.000001, "you").velocity, cursor(time + 0.000001, "you").velocity) <
        0.05,
      `gesture tangent breaks at ${time}`,
    );
  }
  for (const fn of [motion.seekProgress, motion.penProgress]) {
    assert.equal(fn(-1), 0);
    assert.equal(fn(30), 1);
  }
});

test("private setup keeps other people over their separate shared content", () => {
  for (let frame = 22 * rate; frame < 26 * rate; frame++)
    for (const id of ["friend", "mei", "zhou"]) {
      const point = cursor(frame / rate, id);
      assert.equal(point.role, "shared-page-observer");
      assert.ok(point.x < 850, `${id} crosses into private device controls`);
      assert.equal(point.click, false);
    }
  assert.equal(cursor(19.65, "friend").role, "recipient-device");
  assert.equal(cursor(20.75, "you").role, "owner");
});

test("four distinct moving corners leave the full central brand and name-badge area clear", () => {
  const brand = { x: 350, y: 230, width: 750, height: 390 };
  const travelled = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let frame = 26 * rate; frame <= duration * rate; frame++) {
    const time = frame / rate;
    for (const point of motion.sample(time).cursors) {
      assert.equal(
        overlaps({ x: point.x - 4, y: point.y - 4, width: 38, height: 46 }, brand),
        false,
        `${point.id} arrow covers the brand at ${time}`,
      );
      assert.equal(
        overlaps(
          {
            x: point.x + 13,
            y: point.y + 26,
            width: point.name.length === 1 ? 51 : 63,
            height: 31,
          },
          brand,
        ),
        false,
        `${point.id} name covers the brand at ${time}`,
      );
      if (frame > 26 * rate)
        travelled[point.id] += distance(point, cursor(time - 1 / rate, point.id));
    }
  }
  for (const id of ids) assert.ok(travelled[id] > 180, `${id} freezes for the ending`);
});

test("arbitrary render order is deterministic and clamps only beyond the film", () => {
  const times = [0, 3, 6.05, 6.55, 7.2, 7.5, 9.9, 10.65, 11.5, 16.5, 22, 26, 29.99, 30];
  const first = times.map((time) => plain(motion.sample(time)));
  for (const time of [...times].reverse()) motion.sample(time);
  assert.deepEqual(
    times.map((time) => plain(motion.sample(time))),
    first,
  );
  assert.deepEqual(plain(motion.sample(-1)), plain(motion.sample(0)));
  assert.deepEqual(plain(motion.sample(31)), plain(motion.sample(30)));
  for (const id of ids) assert.ok(distance(cursor(29.9, id), cursor(30, id)) > 0.3);
});
