/* global window */

// One world-space timeline per person. Chapters never reposition a pointer.
// Quintic interpolation has zero velocity and acceleration at semantic stops.
(() => {
  const smooth = (value) => {
    const t = Math.min(1, Math.max(0, value));
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  const tracks = {
    you: [
      [0, 410, 300],
      [1.25, 620, 325],
      [2.6, 735, 455],
      [3.3, 700, 470],
      [5.6, 530, 430],
      [8.05, 185, 584],
      [8.5, 185, 584],
      [9.05, 353.5, 561],
      [9.25, 353.5, 561],
      [9.95, 635.5, 561],
      [10.2, 635.5, 561],
      [11.85, 242, 565],
      [12.15, 242, 565],
      [13.65, 954, 390],
      [14, 954, 390],
      [16, 179, 415],
      [16.1, 179, 415],
      [16.9, 477.9, 415 + Math.sin(49 * 0.12) * 3],
      [17.15, 477.9, 415 + Math.sin(49 * 0.12) * 3],
      [18.4, 520, 445],
      [20.3, 719, 458],
      [20.75, 719, 458],
      [21.75, 282, 458],
      [22, 282, 458],
      [23, -80, 458],
      [24, -80, 900],
      [24.8, 331, 900],
      [26.05, 331, 450],
      [26.4, 331, 450],
      [28.35, 609, 436],
      [28.8, 609, 436],
      [30.2, 690, 400],
      [31.65, 567, 471],
      [31.9, 567, 471],
      [33.4, 567, 449],
      [33.8, 567, 449],
      [35.2, 530, 360],
      [36.35, 355.5, 407.5],
      [36.7, 355.5, 407.5],
      [37.2, 610.5, 468],
      [38.7, 610.5, 468],
      [40.1, 380, 374],
      [41.4, 460, 558],
      [43.7, 475, 535],
      [47, 475, 535],
    ],
    friend: [
      [0, 1510, 330],
      [2.8, 1510, 330],
      [3, 1441, 330],
      [4.03, 1180, 552],
      [4.4, 1180, 552],
      [6, 849, 401],
      [6.9, 736, 390],
      [8.5, 845, 480],
      [10.5, 840, 430],
      [12.5, 650, 300],
      [15.4, 615, 335],
      [17.2, 785, 335],
      [18.5, 717, 460],
      [20.2, 730, 350],
      [22.3, 440, 400],
      [24, 292, 450],
      [24.4, 292, 450],
      [25.3, -80, 450],
      [27, -80, 900],
      [36, 1510, 900],
      [38.8, 1510, 520],
      [39, 1441, 520],
      [40.3, 1070, 525],
      [42, 995, 510],
      [43.7, 990, 535],
      [47, 990, 535],
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
    approve: { id: "approve", x: 176, y: 432, width: 250, height: 40 },
    reconnect: { id: "reconnect", x: 376, y: 414, width: 413, height: 40 },
    server: { id: "server", x: 176, y: 451, width: 782, height: 40 },
    login: { id: "login", x: 176, y: 429, width: 782, height: 40 },
    consent: { id: "consent", x: 345, y: 397, width: 21, height: 21 },
    allow: { id: "allow", x: 345, y: 448, width: 531, height: 40 },
    revoke: { id: "revoke", x: 345, y: 448, width: 531, height: 40 },
  };
  const clicks = [
    { id: "friend", at: 4.18, target: "join", confirmed: 4.35 },
    { id: "you", at: 8.3, target: "pause", confirmed: 8.4 },
    { id: "you", at: 12, target: "share", confirmed: 12.3 },
    { id: "you", at: 13.8, target: "page", confirmed: 13.95 },
    { id: "you", at: 20.55, target: "view", confirmed: 20.65 },
    { id: "you", at: 21.9, target: "return", confirmed: 22 },
    { id: "friend", at: 24.15, target: "invitation", confirmed: 24.3 },
    { id: "you", at: 26.15, target: "approve", confirmed: 26.3 },
    { id: "you", at: 28.55, target: "reconnect", confirmed: 28.65 },
    { id: "you", at: 31.75, target: "server", confirmed: 32 },
    { id: "you", at: 33.55, target: "login", confirmed: 33.7 },
    { id: "you", at: 36.5, target: "consent", confirmed: 36.6 },
    { id: "you", at: 37.4, target: "allow", confirmed: 37.5 },
    { id: "you", at: 38.35, target: "revoke", confirmed: 38.45 },
  ];
  function position(track, time) {
    if (time <= track[0][0]) return { x: track[0][1], y: track[0][2] };
    for (let i = 1; i < track.length; i++) {
      if (time > track[i][0]) continue;
      const previous = track[i - 1],
        next = track[i];
      const fraction = smooth((time - previous[0]) / (next[0] - previous[0]));
      return {
        x: previous[1] + (next[1] - previous[1]) * fraction,
        y: previous[2] + (next[2] - previous[2]) * fraction,
      };
    }
    return { x: track.at(-1)[1], y: track.at(-1)[2] };
  }
  function sample(time) {
    const t = Math.min(47, Math.max(0, Number(time) || 0));
    const cursors = Object.entries(tracks).map(([id, track]) => {
      const point = position(track, t);
      // The pen follows the actual curved underline, with identical endpoints.
      if (id === "you" && t >= 16.1 && t <= 16.9) {
        const fraction = smooth((t - 16.1) / 0.8);
        point.x = 179 + 298.9 * fraction;
        point.y = 415 + Math.sin(49 * 0.12 * fraction) * 3;
      }
      const action = clicks.find((event) => event.id === id && Math.abs(t - event.at) <= 0.065);
      const dragging = id === "you" && t >= 9.25 && t <= 9.95;
      return {
        id,
        ...point,
        opacity: 1,
        visible: point.x > -76 && point.x < 1445 && point.y > -57 && point.y < 843,
        click: Boolean(action),
        targetId: action?.target ?? (dragging ? "seek" : null),
        dragging,
        role: id === "you" ? "owner" : t >= 23 && t < 25.4 ? "recipient-device" : "collaborator",
        tool: id === "you" && t >= 16.1 && t <= 16.9 ? "pen" : "arrow",
      };
    });
    return { cursors, targets: Object.values(targets), cameraOffset: { x: 0, y: 0 }, time: t };
  }
  function confirmed(target, time) {
    return time >= clicks.find((event) => event.target === target).confirmed;
  }
  window.SyncActionFilmMotion = Object.freeze({
    sample,
    smooth,
    confirmed,
    clicks,
    tracks,
    targets,
  });
})();
