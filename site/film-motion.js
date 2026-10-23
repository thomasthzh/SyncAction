/* global window */

// Each person has one screen-space route. Hero cameras move the page, never a pointer.
// Short intentional movements alternate with reading; plain knots preserve momentum.
(() => {
  const duration = 32;
  const smooth = (value) => {
    const t = Math.min(1, Math.max(0, value));
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  const people = {
    you: { name: "你", color: "#1d1d1f", enters: 0 },
    friend: { name: "小林", color: "#007aff", enters: 3 },
    mei: { name: "小梅", color: "#8056c4", enters: 8.5 },
    zhou: { name: "小周", color: "#b56828", enters: 14 },
  };
  // Only explicit stops pause. Shallow curves, varied holds and sparse corrections
  // are authored for each person's attention, rather than random decorative jitter.
  const tracks = {
    you: [
      [0, 435, 300, "stop"],
      [0.16, 435, 300, "stop"],
      [0.45, 562, 302],
      [0.7, 615, 325, "stop"],
      [1.35, 615, 325, "stop"],
      [1.64, 664, 452],
      [1.84, 665, 460, "stop"],
      [2.48, 665, 460, "stop"],
      [2.82, 730, 435, "stop"],
      [3.45, 730, 435, "stop"],
      [3.8, 660, 398],
      [4.04, 570, 420, "stop"],
      [5.32, 570, 420, "stop"],
      [5.7, 360, 470],
      [6.1, 154, 527],
      [6.17, 148, 531, "stop"],
      [6.36, 148, 531, "stop"],
      [6.81, 506, 567],
      [6.94, 520, 570, "stop"],
      [7, 520, 570, "stop"],
      [7.7, 912, 570, "stop"],
      [8.45, 912, 570, "stop"],
      [8.74, 1088, 562],
      [9.05, 1130, 576, "stop"],
      [9.3, 1130, 576, "stop"],
      [10.68, 1130, 576, "stop"],
      [11.2, 748, 506],
      [11.88, 277, 501],
      [12.05, 270, 505, "stop"],
      [12.15, 270, 505, "stop"],
      [13.1, 640, 505, "stop"],
      [13.35, 640, 505, "stop"],
      [13.73, 438, 418],
      [14.08, 370, 390, "stop"],
      [15.31, 370, 390, "stop"],
      [15.62, 258, 339],
      [15.9, 210, 350, "stop"],
      [16.82, 210, 350, "stop"],
      [17.26, 462, 406],
      [17.69, 720, 423],
      [18.13, 790, 430, "stop"],
      [18.36, 790, 430, "stop"],
      [18.72, 1063, 466],
      [18.91, 1070, 470, "stop"],
      [20.24, 1070, 470, "stop"],
      [20.71, 1044, 549],
      [21.03, 1050, 570, "stop"],
      [22.98, 1050, 570, "stop"],
      [23.38, 1193, 512],
      [23.58, 1200, 520, "stop"],
      [24.08, 1200, 520, "stop"],
      [24.34, 1138, 414],
      [24.55, 1130, 410, "stop"],
      [25.79, 1130, 410, "stop"],
      [26.02, 1006, 491],
      [26.17, 1001, 496, "stop"],
      [26.33, 1001, 496, "stop"],
      [26.55, 1124, 566],
      [26.62, 1130, 570, "stop"],
      [27.64, 1130, 570, "stop"],
      [28.05, 1178, 519],
      [28.25, 1180, 510, "stop"],
      [29.37, 1180, 510, "stop"],
      [29.67, 1226, 477],
      [29.94, 1230, 480, "stop"],
      [30.91, 1230, 480, "stop"],
      [31.24, 1192, 533],
      [31.59, 1190, 540, "stop"],
      [32, 1190, 540, "stop"],
    ],
    friend: [
      [0, 1510, 330, "stop"],
      [2.77, 1510, 330, "stop"],
      [3, 1439, 340],
      [3.46, 1244, 497],
      [3.78, 1185, 567],
      [3.96, 1190, 571, "stop"],
      [4.19, 1190, 571, "stop"],
      [4.65, 1034, 457],
      [4.98, 938, 444, "stop"],
      [6.46, 938, 444, "stop"],
      [6.78, 843, 469],
      [7.04, 825, 480, "stop"],
      [8.2, 825, 480, "stop"],
      [8.55, 699, 396],
      [8.85, 650, 390, "stop"],
      [9.59, 650, 390, "stop"],
      [9.98, 923, 435],
      [10.31, 1134, 464],
      [10.42, 1130, 468, "stop"],
      [10.65, 1130, 468, "stop"],
      [11.0, 1030, 393],
      [11.27, 1018, 390, "stop"],
      [12.38, 1018, 390, "stop"],
      [12.71, 1150, 570],
      [13.01, 1160, 580, "stop"],
      [13.23, 1160, 580, "stop"],
      [13.61, 1058, 398],
      [13.92, 980, 370, "stop"],
      [15.03, 980, 370, "stop"],
      [15.33, 886, 337],
      [15.6, 870, 345, "stop"],
      [16.28, 870, 345, "stop"],
      [16.62, 955, 409],
      [16.93, 973, 418, "stop"],
      [17.3, 973, 418, "stop"],
      [17.7, 970, 604],
      [18.1, 820, 640],
      [18.75, 644, 510, "stop"],
      [20.2, 644, 510, "stop"],
      [20.69, 433, 541],
      [21.39, 336, 566],
      [21.71, 340, 570, "stop"],
      [21.94, 340, 570, "stop"],
      [22.35, 391, 485],
      [22.6, 400, 480, "stop"],
      [23.5, 400, 480, "stop"],
      [23.84, 344, 354],
      [24.1, 330, 350, "stop"],
      [25.4, 330, 350, "stop"],
      [25.74, 460, 474],
      [26.04, 470, 470, "stop"],
      [26.72, 470, 470, "stop"],
      [27.1, 303, 448],
      [27.45, 245, 470, "stop"],
      [28.63, 245, 470, "stop"],
      [28.97, 203, 413],
      [29.23, 200, 410, "stop"],
      [30.46, 200, 410, "stop"],
      [30.78, 237, 459],
      [31.06, 245, 462, "stop"],
      [32, 245, 462, "stop"],
    ],
    mei: [
      [0, -100, 340, "stop"],
      [8.24, -100, 340, "stop"],
      [8.5, 1, 340],
      [8.91, 238, 336],
      [9.2, 333, 350, "stop"],
      [10.02, 333, 350, "stop"],
      [10.31, 430, 408],
      [10.61, 453, 398, "stop"],
      [11.7, 453, 398, "stop"],
      [12.0, 507, 341],
      [12.29, 510, 335, "stop"],
      [13.54, 510, 335, "stop"],
      [13.89, 628, 378],
      [14.2, 650, 385, "stop"],
      [15.15, 650, 385, "stop"],
      [15.47, 564, 470],
      [15.75, 550, 480, "stop"],
      [17.11, 550, 480, "stop"],
      [17.42, 660, 364],
      [17.73, 670, 350, "stop"],
      [19.0, 670, 350, "stop"],
      [19.4, 551, 332],
      [19.71, 530, 340, "stop"],
      [21.36, 530, 340, "stop"],
      [21.7, 619, 397],
      [21.99, 630, 400, "stop"],
      [23.26, 630, 400, "stop"],
      [23.63, 525, 311],
      [23.91, 510, 310, "stop"],
      [25.24, 510, 310, "stop"],
      [25.58, 432, 334],
      [25.89, 420, 340, "stop"],
      [26.78, 420, 340, "stop"],
      [27.11, 334, 219],
      [27.47, 250, 160, "stop"],
      [28.58, 250, 160, "stop"],
      [28.93, 190, 137],
      [29.19, 180, 140, "stop"],
      [30.3, 180, 140, "stop"],
      [30.63, 233, 164],
      [30.94, 240, 170, "stop"],
      [32, 240, 170, "stop"],
    ],
    zhou: [
      [0, 1110, 900, "stop"],
      [13.72, 1110, 900, "stop"],
      [14, 1107, 809],
      [14.43, 1067, 556],
      [14.75, 1070, 480, "stop"],
      [15.49, 1070, 480, "stop"],
      [15.72, 1084, 460],
      [16.01, 1080, 460, "stop"],
      [16.21, 1080, 460, "stop"],
      [16.5, 1178, 389],
      [16.83, 1190, 390, "stop"],
      [17.79, 1190, 390, "stop"],
      [18.18, 982, 543],
      [18.55, 880, 560, "stop"],
      [19.93, 880, 560, "stop"],
      [20.25, 747, 421],
      [20.56, 730, 410, "stop"],
      [21.47, 730, 410, "stop"],
      [21.81, 659, 494],
      [22.08, 650, 500, "stop"],
      [23.6, 650, 500, "stop"],
      [23.94, 681, 413],
      [24.24, 680, 400, "stop"],
      [25.55, 680, 400, "stop"],
      [25.85, 611, 473],
      [26.1, 610, 485, "stop"],
      [26.7, 610, 485, "stop"],
      [27.04, 660, 652],
      [27.39, 670, 680, "stop"],
      [27.8, 670, 680, "stop"],
      [28.23, 928, 674],
      [28.6, 1100, 680, "stop"],
      [29.64, 1100, 680, "stop"],
      [29.99, 1195, 656],
      [30.29, 1200, 660, "stop"],
      [31.13, 1200, 660, "stop"],
      [31.44, 1128, 690],
      [31.72, 1120, 690, "stop"],
      [32, 1120, 690, "stop"],
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
    { id: "you", at: 6.25, target: "pause", confirmed: 6.38 },
    { id: "you", at: 9.15, target: "share", confirmed: 9.28 },
    { id: "friend", at: 10.5, target: "page", confirmed: 10.64 },
    { id: "friend", at: 13.1, target: "danmaku", confirmed: 13.22 },
    { id: "you", at: 19, target: "view", confirmed: 19.12 },
    { id: "you", at: 20.1, target: "return", confirmed: 20.22 },
    { id: "friend", at: 21.8, target: "invitation", confirmed: 21.92 },
    { id: "you", at: 22.85, target: "approve", confirmed: 22.97 },
    { id: "you", at: 24.65, target: "server", confirmed: 24.78 },
    { id: "you", at: 25.65, target: "login", confirmed: 25.78 },
    { id: "you", at: 26.25, target: "consent", confirmed: 26.37 },
    { id: "you", at: 26.7, target: "allow", confirmed: 26.82 },
    { id: "you", at: 27.5, target: "revoke", confirmed: 27.62 },
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
      1100,
      Math.hypot(incoming.x, incoming.y) * 1.8,
      Math.hypot(outgoing.x, outgoing.y) * 1.8,
    );
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
  const seekProgress = (time) => smooth((time - 7) / 0.7);
  const penProgress = (time) => smooth((time - 12.15) / 0.95);
  function sample(time) {
    const t = Math.min(duration, Math.max(0, Number(time) || 0));
    const cursors = Object.keys(tracks).map((id) => {
      const point = position(id, t);
      const dragging = id === "you" && t >= 7 && t <= 7.7;
      const drawing = id === "you" && t >= 12.15 && t <= 13.1;
      if (dragging) {
        point.x = 520 + 392 * seekProgress(t);
        point.y = 570;
      }
      if (drawing) {
        const fraction = penProgress(t);
        point.x = 270 + 370 * fraction;
        point.y = 505 + Math.sin(Math.PI * fraction) * 18;
      }
      const action = clicks.find((event) => event.id === id && Math.abs(t - event.at) <= 0.055);
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
            : id === "friend" && t >= 21 && t < 22.3
              ? "recipient-device"
              : t >= 24 && t < 28
                ? "shared-page-observer"
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
