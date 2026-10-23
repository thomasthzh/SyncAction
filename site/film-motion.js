/* global window */

// Authored screen-space attention and actions, not a recording of measured human motion.
// Each person keeps one route. Content cameras never move the pointer overlay.
(() => {
  const duration = 30;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const smooth = (value) => {
    const t = clamp(value);
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  const people = {
    you: { name: "你", color: "#1d1d1f", enters: 0 },
    friend: { name: "小林", color: "#007aff", enters: 3 },
    mei: { name: "小梅", color: "#8056c4", enters: 7.5 },
    zhou: { name: "小周", color: "#b56828", enters: 11.5 },
  };
  // [seconds, tip x/y, optional tangent x/y in pixels per second]. Plain knots
  // pass through. Slow clicks and gestures share exact entry and exit tangents.
  const tracks = {
    you: [
      [0, 435, 300, 150, 30],
      [0.7, 600, 320],
      [1.45, 675, 415],
      [2.35, 738, 395],
      [3.1, 790, 420],
      [3.8, 660, 440],
      [4.6, 525, 435],
      [5.3, 320, 465],
      [5.8, 158, 527],
      [5.98, 145, 530, 40, 5],
      [6.05, 148, 531, 45, 14],
      [6.12, 152, 532, 60, 10],
      [6.55, 520, 570, 603.0769230769231, 0],
      [7.2, 912, 570, 603.0769230769231, 0],
      [7.45, 1030, 560],
      [7.87, 1127, 574, 45, 10],
      [7.95, 1130, 576, 40, 15],
      [8.03, 1134, 577, 50, 10],
      [8.35, 1130, 390],
      [8.85, 810, 280],
      [9.25, 380, 240],
      [9.62, 178, 410],
      [9.9, 270, 505, 493.3333333333333, 75.39822368615503],
      [10.65, 640, 505, 493.3333333333333, -75.39822368615503],
      [10.9, 740, 480],
      [11.5, 815, 395],
      [12.3, 705, 325],
      [13.4, 575, 350],
      [14.3, 470, 420],
      [15.35, 610, 450],
      [16.1, 850, 420],
      [16.7, 1060, 465],
      [16.97, 1067, 468, 40, 20],
      [17.05, 1070, 470, 40, 20],
      [17.13, 1074, 471, 50, 10],
      [17.45, 1175, 435],
      [17.85, 1170, 385],
      [18.15, 1095, 445],
      [18.27, 1073, 468, -35, 12],
      [18.35, 1070, 470, -35, 12],
      [18.43, 1066, 471, -50, 10],
      [18.7, 995, 435],
      [19.15, 900, 415],
      [19.8, 930, 470],
      [20.4, 1042, 566],
      [20.67, 1047, 569, 40, 8],
      [20.75, 1050, 570, 40, 8],
      [20.83, 1054, 571, 50, 10],
      [21.25, 1160, 510],
      [21.8, 1200, 440],
      [22.1, 1115, 375],
      [22.37, 1127, 409, 40, 12],
      [22.45, 1130, 410, 40, 12],
      [22.53, 1134, 411, 50, 12],
      [22.75, 1190, 440],
      [23.1, 1160, 407],
      [23.22, 1133, 409, -40, 12],
      [23.3, 1130, 410, -40, 12],
      [23.38, 1126, 411, -50, 12],
      [23.6, 1065, 440],
      [23.92, 1002, 494, -10, 20],
      [24, 1001, 496, -10, 20],
      [24.08, 1000, 498, -8, 15],
      [24.25, 1035, 530],
      [24.47, 1127, 568, 45, 20],
      [24.55, 1130, 570, 45, 20],
      [24.63, 1134, 571, 50, 10],
      [24.85, 1185, 545],
      [25.1, 1165, 532],
      [25.27, 1133, 568, -40, 15],
      [25.35, 1130, 570, -40, 15],
      [25.43, 1126, 571, -50, 15],
      [25.7, 1175, 635],
      [26, 1230, 670],
      [27, 1280, 652],
      [28, 1270, 600],
      [29, 1220, 570],
      [30, 1170, 585, -40, 25],
    ],
    friend: [
      [0, 1510, 330, 0, 0],
      [2.72, 1510, 330, 0, 0],
      [3, 1440, 340, -420, 160],
      [3.55, 1230, 495],
      [3.97, 1187, 570, 40, 10],
      [4.05, 1190, 571, 40, 8],
      [4.13, 1193, 572, 40, 10],
      [4.32, 1180, 545, -160, -150],
      [4.5, 1110, 495],
      [5.3, 1040, 400],
      [6, 1040, 360, 35, 0],
      [6.8, 1050, 405],
      [7.5, 1160, 430],
      [8.2, 1260, 470],
      [8.82, 1133, 467, -40, 15],
      [8.9, 1130, 468, -40, 15],
      [8.98, 1126, 469, -50, 10],
      [9.3, 1050, 410],
      [9.9, 1090, 470],
      [10.5, 1140, 545],
      [10.87, 1157, 578, 40, 10],
      [10.95, 1160, 580, 40, 10],
      [11.03, 1164, 581, 50, 10],
      [11.4, 1190, 540],
      [12, 1100, 450],
      [12.8, 1000, 410],
      [13.5, 900, 455],
      [14.4, 880, 510],
      [15.4, 965, 540],
      [16.1, 1040, 550],
      [16.8, 1090, 585],
      [17.6, 990, 620],
      [18.3, 780, 610],
      [19, 530, 560],
      [19.57, 337, 569, 40, 8],
      [19.65, 340, 570, 40, 8],
      [19.73, 344, 571, 50, 10],
      [20, 400, 550],
      [20.3, 450, 500],
      [21, 525, 400],
      [21.6, 440, 355],
      [22, 350, 340],
      [22.8, 290, 370],
      [23.5, 325, 430],
      [24.2, 390, 460],
      [25, 430, 420],
      [25.6, 340, 430],
      [26, 250, 450],
      [27, 200, 420],
      [28, 180, 350],
      [29, 210, 340],
      [30, 270, 370, 45, 25],
    ],
    mei: [
      [0, -100, 340, 0, 0],
      [7.2, -100, 340, 0, 0],
      [7.5, 0, 340, 500, -75],
      [7.95, 220, 330],
      [8.5, 330, 355],
      [9.2, 440, 385],
      [9.8, 490, 365],
      [10.4, 540, 330],
      [11, 610, 350],
      [11.5, 660, 380],
      [12.3, 625, 440],
      [13.1, 560, 475],
      [14, 470, 490],
      [14.7, 370, 460],
      [15.4, 340, 400],
      [16.1, 435, 340],
      [16.7, 540, 320],
      [17.4, 630, 370],
      [18.2, 680, 430],
      [19, 615, 470],
      [19.8, 560, 440],
      [20.6, 640, 370],
      [21.3, 670, 330],
      [22, 600, 300],
      [22.8, 530, 315],
      [23.5, 500, 365],
      [24.3, 560, 400],
      [25, 570, 350],
      [25.6, 500, 260],
      [26, 300, 150],
      [27, 255, 120],
      [28, 190, 135],
      [29, 200, 165],
      [30, 280, 170, 60, -5],
    ],
    zhou: [
      [0, 1110, 900, 0, 0],
      [11.22, 1110, 900, 0, 0],
      [11.5, 1110, 810, -40, -460],
      [11.9, 1070, 700],
      [12.5, 1050, 600],
      [13.2, 1100, 520],
      [14, 1160, 430],
      [14.8, 1110, 350],
      [15.5, 1000, 330],
      [16.3, 840, 330],
      [17, 780, 385],
      [17.8, 820, 450],
      [18.5, 850, 510],
      [19.2, 780, 560],
      [20, 730, 500],
      [20.7, 740, 430, -35, 0],
      [21.4, 730, 510],
      [22, 740, 550],
      [22.8, 780, 500],
      [23.6, 740, 435],
      [24.4, 690, 470],
      [25.2, 720, 540],
      [25.65, 770, 660],
      [26, 800, 710],
      [27, 970, 725],
      [28, 1080, 700],
      [29, 1020, 670],
      [30, 920, 710, -70, 35],
    ],
  };
  const targets = {
    join: { id: "join", x: 1060, y: 546, width: 260, height: 50 },
    pause: { id: "pause", x: 88, y: 505, width: 124, height: 50 },
    seek: { id: "seek", x: 180, y: 548, width: 1080, height: 44 },
    share: { id: "share", x: 1020, y: 551, width: 280, height: 50 },
    page: { id: "page", x: 1020, y: 443, width: 280, height: 50 },
    danmaku: { id: "danmaku", x: 1040, y: 555, width: 260, height: 50 },
    view: { id: "view", x: 940, y: 445, width: 320, height: 50 },
    return: { id: "return", x: 940, y: 445, width: 320, height: 50 },
    invitation: { id: "invitation", x: 210, y: 545, width: 270, height: 50 },
    approve: { id: "approve", x: 920, y: 545, width: 270, height: 50 },
    server: { id: "server", x: 990, y: 385, width: 280, height: 50 },
    login: { id: "login", x: 990, y: 385, width: 280, height: 50 },
    consent: { id: "consent", x: 990, y: 485, width: 22, height: 22 },
    allow: { id: "allow", x: 990, y: 545, width: 280, height: 50 },
    revoke: { id: "revoke", x: 990, y: 545, width: 280, height: 50 },
  };
  const clicks = [
    { id: "friend", at: 4.05, target: "join", confirmed: 4.18 },
    { id: "you", at: 6.05, target: "pause", confirmed: 6.17 },
    { id: "you", at: 7.95, target: "share", confirmed: 8.07 },
    { id: "friend", at: 8.9, target: "page", confirmed: 9.02 },
    { id: "friend", at: 10.95, target: "danmaku", confirmed: 11.07 },
    { id: "you", at: 17.05, target: "view", confirmed: 17.17 },
    { id: "you", at: 18.35, target: "return", confirmed: 18.47 },
    { id: "friend", at: 19.65, target: "invitation", confirmed: 19.77 },
    { id: "you", at: 20.75, target: "approve", confirmed: 20.87 },
    { id: "you", at: 22.45, target: "server", confirmed: 22.57 },
    { id: "you", at: 23.3, target: "login", confirmed: 23.42 },
    { id: "you", at: 24, target: "consent", confirmed: 24.12 },
    { id: "you", at: 24.55, target: "allow", confirmed: 24.67 },
    { id: "you", at: 25.35, target: "revoke", confirmed: 25.47 },
  ];

  function tangent(track, index) {
    const point = track[index];
    if (point.length === 5) return { x: point[3], y: point[4] };
    const before = track[index - 1];
    const after = track[index + 1];
    const a = point[0] - before[0];
    const b = after[0] - point[0];
    const incoming = { x: (point[1] - before[1]) / a, y: (point[2] - before[2]) / a };
    const outgoing = { x: (after[1] - point[1]) / b, y: (after[2] - point[2]) / b };
    const x = (incoming.x * b + outgoing.x * a) / (a + b);
    const y = (incoming.y * b + outgoing.y * a) / (a + b);
    const limit =
      Math.min(Math.hypot(incoming.x, incoming.y), Math.hypot(outgoing.x, outgoing.y)) * 1.8;
    const factor = Math.min(1, limit / (Math.hypot(x, y) || 1));
    return { x: x * factor, y: y * factor };
  }
  const velocities = Object.fromEntries(
    Object.entries(tracks).map(([id, track]) => [
      id,
      track.map((_, index) => tangent(track, index)),
    ]),
  );
  const seekProgress = (time) => clamp((time - 6.55) / 0.65);
  const penProgress = (time) => clamp((time - 9.9) / 0.75);
  function position(id, time) {
    if (id === "you" && time >= 6.55 && time <= 7.2)
      return { x: 520 + 392 * seekProgress(time), y: 570, velocity: { x: 392 / 0.65, y: 0 } };
    if (id === "you" && time >= 9.9 && time <= 10.65) {
      const fraction = penProgress(time);
      return {
        x: 270 + 370 * fraction,
        y: 505 + Math.sin(Math.PI * fraction) * 18,
        velocity: { x: 370 / 0.75, y: (Math.cos(Math.PI * fraction) * 18 * Math.PI) / 0.75 },
      };
    }
    const track = tracks[id];
    const found = track.findIndex((point) => point[0] >= time);
    const index = found < 1 ? (time <= 0 ? 1 : track.length - 1) : found;
    const a = track[index - 1];
    const b = track[index];
    const span = b[0] - a[0];
    const t = (time - a[0]) / span;
    const t2 = t * t;
    const t3 = t2 * t;
    const av = velocities[id][index - 1];
    const bv = velocities[id][index];
    const coordinate = (axis, offset) =>
      (2 * t3 - 3 * t2 + 1) * a[offset] +
      (t3 - 2 * t2 + t) * span * av[axis] +
      (-2 * t3 + 3 * t2) * b[offset] +
      (t3 - t2) * span * bv[axis];
    const derivative = (axis, offset) =>
      ((6 * t2 - 6 * t) * a[offset] + (-6 * t2 + 6 * t) * b[offset]) / span +
      (3 * t2 - 4 * t + 1) * av[axis] +
      (3 * t2 - 2 * t) * bv[axis];
    return {
      x: coordinate("x", 1),
      y: coordinate("y", 2),
      velocity: { x: derivative("x", 1), y: derivative("y", 2) },
    };
  }
  function sample(time) {
    const t = Math.min(duration, Math.max(0, Number(time) || 0));
    const cursors = Object.keys(tracks).map((id) => {
      const point = position(id, t);
      const dragging = id === "you" && t >= 6.55 && t <= 7.2;
      const drawing = id === "you" && t >= 9.9 && t <= 10.65;
      const action = clicks.find((event) => event.id === id && Math.abs(t - event.at) <= 0.06);
      return {
        id,
        ...people[id],
        ...point,
        opacity: 1,
        nameOpacity: id === "you" ? 1 : smooth((t - people[id].enters) / 0.12),
        visible: point.x >= 0 && point.x <= 1440 && point.y >= 0 && point.y <= 810,
        click: Boolean(action),
        targetId: action?.target ?? (dragging ? "seek" : null),
        dragging,
        role:
          id === "you"
            ? "owner"
            : id === "friend" && t >= 19 && t < 20.3
              ? "recipient-device"
              : t >= 22 && t < 26
                ? "shared-page-observer"
                : "collaborator",
        tool: drawing ? "pen" : "arrow",
      };
    });
    return { cursors, targets: Object.values(targets), cameraOffset: { x: 0, y: 0 }, time: t };
  }
  function confirmed(target, time) {
    const event = clicks.find((item) => item.target === target);
    return Boolean(event && time >= event.confirmed);
  }
  window.SyncActionFilmMotion = Object.freeze({
    duration,
    sample,
    smooth,
    seekProgress,
    penProgress,
    confirmed,
    clicks,
    tracks,
    targets,
    people,
  });
})();
