/* global window */

// Stable identities move in canvas space throughout the film, including offscreen.
// Authored curved routes pass through browsing points; only purposeful stops dwell.
(() => {
  const duration = 36;
  const smooth = (value) => {
    const t = Math.min(1, Math.max(0, value));
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  const people = {
    you: { name: "你", color: "#1d1d1f" },
    friend: { name: "小林", color: "#007aff" },
    mei: { name: "小梅", color: "#8056c4" },
    zhou: { name: "小周", color: "#b56828" },
  };
  // A fourth value marks a deliberate stop. Other knots retain their tangent.
  const tracks = {
    you: [
      [0, 410, 300, "stop"],
      [0.56, 582, 310],
      [1.12, 687, 365],
      [1.44, 704, 404, "stop"],
      [1.7, 704, 404, "stop"],
      [2.42, 652, 466],
      [3.34, 562, 443],
      [4.2, 526, 402],
      [4.68, 530, 405, "stop"],
      [5.08, 530, 405, "stop"],
      [5.78, 345, 481],
      [6.35, 190, 577],
      [6.63, 185, 584, "stop"],
      [6.88, 185, 584, "stop"],
      [7.16, 340, 562],
      [7.35, 353.5, 561, "stop"],
      [8.05, 635.5, 561, "stop"],
      [8.22, 635.5, 561, "stop"],
      [8.75, 455, 522],
      [9.36, 256, 557],
      [9.64, 242, 565, "stop"],
      [9.88, 242, 565, "stop"],
      [10.38, 571, 432],
      [10.82, 948, 387],
      [10.91, 954, 390, "stop"],
      [11.13, 954, 390, "stop"],
      [11.78, 703, 348],
      [12.43, 291, 386],
      [12.76, 179, 415, "stop"],
      [12.9, 179, 415, "stop"],
      [13.6, 477.9, 415 + Math.sin(49 * 0.12) * 3, "stop"],
      [13.77, 477.9, 415 + Math.sin(49 * 0.12) * 3, "stop"],
      [14.42, 571, 385],
      [15.38, 707, 451],
      [15.74, 719, 458, "stop"],
      [15.98, 719, 458, "stop"],
      [16.42, 514, 423],
      [16.88, 285, 456],
      [17.0, 282, 458, "stop"],
      [17.22, 282, 458, "stop"],
      [17.93, 489, 369],
      [18.73, 776, 396],
      [19.45, 980, 447],
      [20.14, 991, 452, "stop"],
      [20.39, 991, 452, "stop"],
      [21.18, 1045, 420],
      [21.96, 1070, 466, "stop"],
      [22.25, 1070, 466, "stop"],
      [22.94, 910, 392],
      [23.76, 468, 421],
      [24.56, 326, 471, "stop"],
      [24.86, 326, 471, "stop"],
      [25.31, 470, 416],
      [25.87, 720, 466],
      [25.99, 730, 471, "stop"],
      [26.24, 730, 471, "stop"],
      [26.9, 782, 375],
      [27.64, 800.5, 407.5, "stop"],
      [27.94, 800.5, 407.5, "stop"],
      [28.25, 1037, 462],
      [28.44, 1045, 468, "stop"],
      [29.44, 1045, 468, "stop"],
      [29.88, 897, 388],
      [30.38, 650, 386],
      [31.12, 438, 392],
      [31.6, 377, 435, "stop"],
      [31.92, 377, 435, "stop"],
      [32.55, 419, 494],
      [33.25, 430, 510],
      [34.08, 416, 522, "stop"],
      [34.48, 416, 522, "stop"],
      [35.3, 453, 524],
      [36, 467, 512, "stop"],
    ],
    friend: [
      [0, 1510, 330, "stop"],
      [2.75, 1510, 330, "stop"],
      [3, 1441, 336],
      [3.52, 1230, 472],
      [3.91, 1180, 552, "stop"],
      [4.3, 1180, 552, "stop"],
      [4.8, 1087, 459],
      [5.42, 904, 401],
      [6.12, 833, 423, "stop"],
      [6.54, 833, 423, "stop"],
      [7.42, 770, 475],
      [8.3, 723, 451],
      [9.2, 679, 341],
      [9.7, 652, 324, "stop"],
      [10.1, 652, 324, "stop"],
      [11.17, 591, 335],
      [12.1, 622, 321],
      [13.05, 749, 332],
      [13.5, 770, 350, "stop"],
      [13.89, 770, 350, "stop"],
      [14.62, 725, 419],
      [15.31, 688, 396],
      [16.16, 621, 341],
      [17.26, 469, 376],
      [18.42, 304, 443],
      [18.87, 292, 452, "stop"],
      [19.14, 292, 452, "stop"],
      [19.71, 142, 420],
      [20.37, -92, 428],
      [21.18, -120, 950],
      [24.6, 1530, 950],
      [29.76, 1530, 520, "stop"],
      [30, 1441, 520],
      [30.6, 1214, 451],
      [31.4, 1086, 397, "stop"],
      [31.79, 1086, 397, "stop"],
      [32.5, 1030, 449],
      [33.3, 1010, 480],
      [34.08, 1019, 499],
      [34.5, 1030, 500, "stop"],
      [34.8, 1030, 500, "stop"],
      [35.48, 1002, 522],
      [36, 987, 518, "stop"],
    ],
    mei: [
      [0, -120, 280, "stop"],
      [30.12, -120, 280, "stop"],
      [30.5, -76, 280],
      [31.15, 216, 322],
      [31.7, 372, 306, "stop"],
      [32.02, 372, 306, "stop"],
      [32.75, 452, 281],
      [33.46, 460, 290],
      [34.25, 447, 280, "stop"],
      [34.62, 447, 280, "stop"],
      [35.39, 467, 296],
      [36, 485, 290, "stop"],
    ],
    zhou: [
      [0, 1110, 900, "stop"],
      [30.72, 1110, 900, "stop"],
      [31, 1106, 811],
      [31.43, 1177, 613],
      [31.7, 1190, 485, "stop"],
      [32.02, 1190, 485, "stop"],
      [32.72, 1130, 340],
      [33.48, 1030, 310],
      [34.18, 1043, 295],
      [34.52, 1050, 293, "stop"],
      [34.88, 1050, 293, "stop"],
      [35.48, 1073, 311],
      [36, 1085, 306, "stop"],
    ],
  };
  const targets = {
    join: { id: "join", x: 1052, y: 532, width: 268, height: 40 },
    pause: { id: "pause", x: 142, y: 575, width: 122, height: 30 },
    seek: { id: "seek", x: 142, y: 548, width: 705, height: 27 },
    share: { id: "share", x: 142, y: 545, width: 200, height: 40 },
    page: { id: "page", x: 142, y: 345, width: 852, height: 70 },
    view: { id: "view", x: 599, y: 438, width: 240, height: 40 },
    return: { id: "return", x: 162, y: 438, width: 240, height: 40 },
    invitation: { id: "invitation", x: 176, y: 432, width: 250, height: 40 },
    approve: { id: "approve", x: 866, y: 432, width: 250, height: 40 },
    reconnect: { id: "reconnect", x: 910, y: 446, width: 320, height: 40 },
    server: { id: "server", x: 176, y: 451, width: 300, height: 40 },
    login: { id: "login", x: 580, y: 451, width: 300, height: 40 },
    consent: { id: "consent", x: 790, y: 397, width: 21, height: 21 },
    allow: { id: "allow", x: 790, y: 448, width: 510, height: 40 },
    revoke: { id: "revoke", x: 790, y: 448, width: 510, height: 40 },
  };
  const clicks = [
    { id: "friend", at: 4.15, target: "join", confirmed: 4.3 },
    { id: "you", at: 6.75, target: "pause", confirmed: 6.85 },
    { id: "you", at: 9.75, target: "share", confirmed: 9.9 },
    { id: "you", at: 11, target: "page", confirmed: 11.12 },
    { id: "you", at: 15.85, target: "view", confirmed: 15.95 },
    { id: "you", at: 17.1, target: "return", confirmed: 17.2 },
    { id: "friend", at: 19, target: "invitation", confirmed: 19.12 },
    { id: "you", at: 20.25, target: "approve", confirmed: 20.37 },
    { id: "you", at: 22.1, target: "reconnect", confirmed: 22.25 },
    { id: "you", at: 24.7, target: "server", confirmed: 24.85 },
    { id: "you", at: 26.1, target: "login", confirmed: 26.23 },
    { id: "you", at: 27.8, target: "consent", confirmed: 27.92 },
    { id: "you", at: 28.55, target: "allow", confirmed: 28.67 },
    { id: "you", at: 29.3, target: "revoke", confirmed: 29.42 },
  ];
  function tangent(track, index) {
    const point = track[index];
    if (!index || index === track.length - 1 || point[3] === "stop") return { x: 0, y: 0 };
    const before = track[index - 1];
    const after = track[index + 1];
    const a = point[0] - before[0];
    const b = after[0] - point[0];
    const incoming = { x: (point[1] - before[1]) / a, y: (point[2] - before[2]) / a };
    const outgoing = { x: (after[1] - point[1]) / b, y: (after[2] - point[2]) / b };
    const x = (incoming.x * b + outgoing.x * a) / (a + b);
    const y = (incoming.y * b + outgoing.y * a) / (a + b);
    const limit = Math.min(
      1000,
      Math.hypot(incoming.x, incoming.y) * 1.8,
      Math.hypot(outgoing.x, outgoing.y) * 1.8,
    );
    // A reversal is a meaningful correction, not an opportunity for a spline loop.
    if (x * incoming.x + y * incoming.y < 0 || x * outgoing.x + y * outgoing.y < 0)
      return { x: 0, y: 0 };
    const factor = Math.min(1, limit / (Math.hypot(x, y) || 1));
    return { x: x * factor, y: y * factor };
  }
  const velocities = Object.fromEntries(
    Object.entries(tracks).map(([id, track]) => [
      id,
      track.map((_, index) => tangent(track, index)),
    ]),
  );
  function position(id, time) {
    const track = tracks[id];
    if (time <= track[0][0]) return { x: track[0][1], y: track[0][2] };
    const index = track.findIndex((point) => point[0] >= time);
    if (index < 1) return { x: track.at(-1)[1], y: track.at(-1)[2] };
    const a = track[index - 1];
    const b = track[index];
    const span = b[0] - a[0];
    const t = (time - a[0]) / span;
    const t2 = t * t;
    const t3 = t2 * t;
    const h1 = 2 * t3 - 3 * t2 + 1;
    const h2 = t3 - 2 * t2 + t;
    const h3 = -2 * t3 + 3 * t2;
    const h4 = t3 - t2;
    const av = velocities[id][index - 1];
    const bv = velocities[id][index];
    return {
      x: h1 * a[1] + h2 * span * av.x + h3 * b[1] + h4 * span * bv.x,
      y: h1 * a[2] + h2 * span * av.y + h3 * b[2] + h4 * span * bv.y,
    };
  }
  const seekProgress = (time) => smooth((time - 7.35) / 0.7);
  const penProgress = (time) => smooth((time - 12.9) / 0.7);
  function sample(time) {
    const t = Math.min(duration, Math.max(0, Number(time) || 0));
    const cursors = Object.keys(tracks).map((id) => {
      const point = position(id, t);
      const dragging = id === "you" && t >= 7.35 && t <= 8.05;
      const drawing = id === "you" && t >= 12.9 && t <= 13.6;
      if (dragging) {
        point.x = 353.5 + 282 * seekProgress(t);
        point.y = 561;
      }
      if (drawing) {
        const fraction = penProgress(t);
        point.x = 179 + 298.9 * fraction;
        point.y = 415 + Math.sin(49 * 0.12 * fraction) * 3;
      }
      const action = clicks.find((event) => event.id === id && Math.abs(t - event.at) <= 0.065);
      return {
        id,
        ...people[id],
        ...point,
        opacity: 1,
        visible: point.x > -76 && point.x < 1445 && point.y > -57 && point.y < 843,
        click: Boolean(action),
        targetId: action?.target ?? (dragging ? "seek" : null),
        dragging,
        role:
          id === "you"
            ? "owner"
            : id === "friend" && t >= 18 && t < 21
              ? "recipient-device"
              : "collaborator",
        tool: drawing ? "pen" : "arrow",
      };
    });
    return { cursors, targets: Object.values(targets), cameraOffset: { x: 0, y: 0 }, time: t };
  }
  function confirmed(target, time) {
    return time >= clicks.find((event) => event.target === target).confirmed;
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
