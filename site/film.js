/* global document, window, Image, URLSearchParams, performance */
const canvas = document.querySelector("#film");
let ctx = canvas.getContext("2d", { alpha: false });
const transitionCanvas = document.createElement("canvas");
transitionCanvas.width = 1440;
transitionCanvas.height = 810;
const transitionContext = transitionCanvas.getContext("2d", { alpha: false });
let transitionChapter = -1;
const logo = new Image(),
  landscape = new Image();
const motion = window.SyncActionFilmMotion;
const duration = 30;
const C = { ink: "#1d1d1f", muted: "#85858b", blue: "#377dff", line: "#dedee3" };
const font = '"Segoe UI", "Microsoft YaHei", sans-serif';
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (v) => {
  const p = clamp(v);
  return p * p * (3 - 2 * p);
};
const lerp = (a, b, p) => a + (b - a) * p;
const chapters = [
  [0, "solo"],
  [3, "join"],
  [5.8, "media"],
  [7.5, "pages"],
  [9.6, "annotations"],
  [11.5, "quartet"],
  [16.5, "groups"],
  [19, "invitations"],
  [22, "consent"],
  [26, "end"],
].map(([start, feature]) => ({ start, feature }));
function box(x, y, w, h, fill, radius = 12, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
function text(value, x, y, size = 20, color = C.ink, weight = 500, align = "left") {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, y);
}
function line(x1, y1, x2, y2, color = C.line, width = 1) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}
function alpha(value, draw) {
  ctx.save();
  ctx.globalAlpha *= clamp(value);
  draw();
  ctx.restore();
}
function paper(x, y, w, h, dark = false, radius = 24) {
  ctx.save();
  ctx.shadowColor = dark ? "#00000060" : "#151d3020";
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 22;
  box(x, y, w, h, dark ? "#18191de8" : "#ffffff", radius, dark ? "#ffffff24" : "#e3e4e8");
  ctx.restore();
}
function button(value, x, y, w, dark = false, active = false, enabled = true) {
  box(x, y, w, 50, !enabled ? "#e7e7ec" : active ? "#e6f1ff" : dark ? "#f5f5f7" : C.ink, 13);
  text(
    value,
    x + w / 2,
    y + 32,
    17,
    !enabled ? "#92929b" : active ? "#1761bd" : dark ? C.ink : "#fff",
    600,
    "center",
  );
}
function dot(x, y, color, r = 5) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}
function arrow(x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 24);
  ctx.lineTo(6, 18);
  ctx.lineTo(11, 29);
  ctx.lineTo(16, 27);
  ctx.lineTo(11, 16);
  ctx.lineTo(21, 16);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();
}
function cursor(pointer, labelOnly = false) {
  const { x, y, name, color, click, tool } = pointer;
  ctx.save();
  ctx.translate(x, y);
  if (labelOnly) {
    ctx.globalAlpha *= pointer.nameOpacity ?? 1;
    const w = name.length === 1 ? 43 : 55;
    box(17, 30, w, 23, "#ffffffed", 11, "#00000014");
    dot(26, 41.5, color, 2.5);
    text(name, 33, 45, 11, C.ink, 500);
  } else {
    ctx.shadowColor = "#00000055";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    if (tool === "pen") {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(4, -11);
      ctx.lineTo(17, -24);
      ctx.lineTo(24, -17);
      ctx.lineTo(11, -4);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.6;
      ctx.fill();
      ctx.stroke();
    } else arrow(0, 0, color);
    ctx.shadowColor = "transparent";
    if (click) {
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.strokeStyle = color + "80";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  ctx.restore();
}
function sceneImage(t, x, y, w, h, radius = 0, zoom = 1) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.clip();
  const iw = landscape.naturalWidth,
    ih = landscape.naturalHeight,
    scale = Math.max(w / iw, h / ih) * zoom;
  const dw = iw * scale,
    dh = ih * scale,
    drift = Math.sin(t * 0.13) * Math.max(0, dw - w) * 0.12;
  ctx.drawImage(landscape, x - (dw - w) / 2 + drift, y - (dh - h) / 2, dw, dh);
  ctx.restore();
}
function shade(x, y, w, h, top = "#03080b00", bottom = "#03080bd9") {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}
function mediaClock(progress) {
  const seconds = lerp((340 / 1080) * 90, (732 / 1080) * 90, progress);
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(Math.floor((seconds - whole) * 100)).padStart(2, "0")}`;
}

function backdrop() {
  ctx.fillStyle = "#08090c";
  ctx.fillRect(0, 0, 1440, 810);
}
function label(value, x, y, light = true) {
  text(value, x, y, 16, light ? "#b0b4be" : "#747982", 400);
}
function headline(value, x = 78, y = 151, size = 100) {
  text(value, x, y, size, "#f5f5f7", 650);
}
function browserFrame(t, x, y, w, h, zoom = 1.05) {
  ctx.save();
  ctx.shadowColor = "#00000080";
  ctx.shadowBlur = 54;
  ctx.shadowOffsetY = 28;
  box(x, y, w, h, "#16181d", 24, "#ffffff33");
  ctx.restore();
  sceneImage(t, x + 2, y + 38, w - 4, h - 40, 21, zoom);
  box(x + 2, y + 2, w - 4, 37, "#17191d", [22, 22, 0, 0]);
  ["#d6afaa", "#cfc49c", "#a4c1b4"].forEach((color, i) => dot(x + 24 + i * 13, y + 20, color, 3));
  text("一个属于我们的房间", x + w / 2, y + 24, 11, "#b0b4be", 400, "center");
}
function solo(t) {
  backdrop();
  headline("一个网页。", 78, 149, 104);
  const p = ease(t / 3);
  browserFrame(
    t,
    lerp(68, 42, p),
    lerp(214, 195, p),
    lerp(1304, 1356, p),
    lerp(540, 542, p),
    1.05 + t * 0.006,
  );
  shade(70, 460, 1300, 250, "#00000000", "#06101db8");
  text("值得看的风景。", 108, 627, 37, "#fff", 600);
  label("想和你一起。", 110, 663);
  line(110, 694, 1310, 694, "#ffffff40", 3);
  line(110, 694, 400 + t * 30, 694, "#e2e8f4", 3);
  text("Ⅱ", 110, 724, 18, "#fff");
}
function joinHero(t) {
  backdrop();
  const p = ease((t - 3) / 0.54);
  sceneImage(
    t,
    lerp(44, 0, p),
    lerp(233, 0, p),
    lerp(1352, 1440, p),
    lerp(502, 810, p),
    lerp(21, 0, p),
    1.08 + (t - 3) * 0.007,
  );
  shade(0, 0, 1440, 810, "#00000018", "#02060bcc");
  alpha(ease((t - 3.04) / 0.38), () => {
    headline("一起。", 76, 374, 212);
    text("让同伴，走进此刻。", 88, 438, 32, "#e4e8ef", 500);
  });
  paper(1032, 398, 320, 230, true, 24);
  label("小林自己的设备", 1060, 434);
  text(
    motion.confirmed("join", t) ? "我们，开始一起看。" : "加入你的播放组",
    1060,
    483,
    25,
    "#fff",
    600,
  );
  label(motion.confirmed("join", t) ? "媒体跟随已确认" : "由小林本人确认", 1060, 519);
  button(
    motion.confirmed("join", t) ? "已加入 · 跟随播放" : "加入播放组",
    1060,
    546,
    260,
    true,
    motion.confirmed("join", t),
  );
  label("各自的设备。同一刻的目光。", 84, 748);
}
function media(t) {
  backdrop();
  const p = motion.seekProgress(t),
    stopped = motion.confirmed("pause", t);
  headline("一停。都停。", 78, 151, 101);
  label("跟随领播，同步播放状态。", 84, 197);
  text(mediaClock(p), 78, 433, 155, "#f5f5f7", 600);
  text(stopped ? "PAUSED TOGETHER" : "PLAYING TOGETHER", 88, 269, 13, "#9baecb", 500);
  box(1020, 270, 310, 160, "#191c22", 22, "#ffffff20");
  dot(1050, 306, "#9bc1ff", 5);
  text("小林 · 跟随者", 1067, 312, 17, "#d4d6dd", 500);
  text(mediaClock(p), 1047, 368, 36, "#fff", 600);
  label(stopped ? "已对齐 · 保持暂停" : "正在跟随播放", 1048, 403);
  button(stopped ? "Ⅱ 已暂停" : "Ⅱ 暂停", 88, 505, 124, true, stopped);
  line(180, 570, 1260, 570, "#3a3e47", 6);
  line(180, 570, lerp(520, 912, p), 570, "#97bcff", 6);
  dot(lerp(520, 912, p), 570, "#fff", 8);
  for (let i = 0; i <= 24; i++) line(180 + i * 45, 599, 180 + i * 45, i % 4 ? 609 : 625, "#555b66");
  label("00:00", 180, 657);
  text("01:30", 1260, 657, 16, "#b0b4be", 400, "right");
}
function pages(t) {
  backdrop();
  headline("把好东西，带过来。", 78, 150, 84);
  paper(80, 226, 865, 440);
  sceneImage(t, 520, 244, 407, 404, 14, 1.2);
  text("下一站。", 112, 333, 59, C.ink, 650);
  text("去看更大的世界。", 114, 385, 34, C.ink, 600);
  ["分享一个页面，", "也分享一个想法。"].forEach((value, index) =>
    text(value, 114, 472 + index * 37, 23, "#777c87", 400),
  );
  paper(988, 226, 344, 440, true);
  label(t < 8.5 ? "你的设备" : "小林自己的设备", 1020, 265);
  text("房间的共享页面", 1020, 313, 25, "#fff", 600);
  label("周末的目的地", 1020, 349);
  label(motion.confirmed("page", t) ? "已在本设备打开" : "打开后，自行决定是否跟随", 1020, 415);
  button(
    motion.confirmed("page", t) ? "页面已打开" : "打开同伴页面",
    1020,
    443,
    280,
    true,
    motion.confirmed("page", t),
  );
  button(
    motion.confirmed("share", t) ? "当前页已分享" : "分享当前页",
    1020,
    551,
    280,
    true,
    motion.confirmed("share", t),
  );
}
function annotations(t) {
  backdrop();
  headline("想法，直接落在内容上。", 78, 150, 77);
  sceneImage(t, 75, 229, 900, 438, 20, 1.17);
  shade(75, 229, 900, 438, "#00000008", "#020916bc");
  text("就从这里，出发。", 266, 476, 42, "#fff", 650);
  const p = motion.penProgress(t);
  if (p > 0) {
    ctx.beginPath();
    ctx.moveTo(270, 505);
    for (let i = 1; i <= 100; i++) {
      const q = (p * i) / 100;
      ctx.lineTo(270 + 370 * q, 505 + Math.sin(q * Math.PI) * 18);
    }
    ctx.strokeStyle = "#e5b75a";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
  }
  paper(1010, 318, 326, 323, true);
  label("小林自己的设备", 1040, 354);
  text("说出来。", 1040, 408, 31, "#fff", 600);
  label("这个风景，值得一起看。", 1040, 450);
  button(
    motion.confirmed("danmaku", t) ? "弹幕已发送" : "发送弹幕",
    1040,
    555,
    260,
    true,
    motion.confirmed("danmaku", t),
  );
  if (motion.confirmed("danmaku", t)) {
    const x = 500 - (t - 11.07) * 95;
    box(x, 298, 318, 45, "#fffffff0", 22);
    text("小林：这个风景，值得一起看。", x + 20, 327, 17, C.ink, 500);
  }
  label("光标 · 弹幕 · 画笔 / 已授权的兼容页面", 80, 748);
}
function quartet(t) {
  backdrop();
  const p = 1 - Math.pow(1 - clamp((t - 11.5) / 0.8), 3);
  const breathe = Math.sin((t - 12.3) * 0.5) * 4;
  const x = lerp(0, 66, p),
    y = lerp(0, 205 + breathe, p),
    w = lerp(1440, 1308, p),
    h = lerp(810, 506, p);
  ctx.save();
  ctx.shadowColor = "#7faaff30";
  ctx.shadowBlur = 100;
  ctx.shadowOffsetY = 10;
  box(x, y, w, h, "#15181d", 25, "#bdd2f352");
  ctx.restore();
  sceneImage(t, x + 3, y + 3, w - 6, h - 6, 22, 1.075 + p * 0.025);
  shade(x + 3, y + 3, w - 6, h - 6, "#00000008", "#031022b0");
  alpha(p, () => {
    headline("我们，都在。", 72, 158, 123);
    text("四个光标。一个共同的此刻。", 111, 649, 42, "#fff", 600);
    label("各自的设备 / 已授权的兼容页面", 115, 687);
    line(1020, 460, 1160, 460, "#e5b75a", 3);
    text("就看这里", 1035, 437, 18, "#f6dfb3", 500);
  });
  // One large subject replaces the previous collection of badges and floating cards.
}
function groups(t) {
  backdrop();
  const viewB = motion.confirmed("view", t) && !motion.confirmed("return", t);
  headline("同房间。各有节奏。", 78, 152, 90);
  browserFrame(t, 80, 260, 708, 397, 1.06);
  shade(82, 500, 704, 155, "#00000000", "#020814c9");
  text("A 组 / 你正在参与", 108, 561, 27, "#fff", 600);
  label("本设备的播放参与保留", 108, 603);
  paper(882, 260, 450, 397, true);
  text(viewB ? "正在查看 B 组" : "你的播放组", 920, 329, 30, "#fff", 600);
  label("查看另一组，不会自动加入。", 920, 375);
  text("你的参与：仍在 A 组", 920, 414, 17, "#b7c8e3", 500);
  button(viewB ? "返回 A 组" : "查看 B 组", 940, 445, 320, true);
  label("查看 ≠ 加入", 920, 588);
}
function invitations(t) {
  backdrop();
  headline("靠近，由自己决定。", 78, 150, 89);
  paper(150, 274, 490, 380, true);
  paper(810, 274, 490, 380, true);
  label("小林的设备", 190, 323);
  text("有人邀请你", 190, 399, 43, "#fff", 600);
  label("接收者本人接受", 190, 447);
  button(
    motion.confirmed("invitation", t) ? "已接受邀请" : "接受房间邀请",
    210,
    545,
    270,
    true,
    motion.confirmed("invitation", t),
  );
  label("另一房间 / 房主设备", 850, 323);
  text("有人申请加入", 850, 399, 43, "#fff", 600);
  label("由房主批准", 850, 447);
  button(
    motion.confirmed("approve", t) ? "已批准申请" : "批准加入申请",
    920,
    545,
    270,
    true,
    motion.confirmed("approve", t),
  );
  if (t >= 21.1)
    alpha(ease((t - 21.1) / 0.25), () => {
      label("重新连接，读取已提交的状态。继续刚才。", 400, 714);
    });
}
function consent(t) {
  backdrop();
  headline("共享此刻。保留边界。", 78, 150, 85);
  browserFrame(t, 80, 229, 780, 450, 1.08);
  shade(98, 420, 744, 241, "#00000000", "#031022bd");
  text("继续，一起看。", 128, 596, 47, "#fff", 600);
  label("另一个已授权页面 / 同伴继续交流", 132, 636);
  paper(956, 229, 362, 450, true);
  const logged = motion.confirmed("login", t),
    allowed = motion.confirmed("allow", t),
    revoked = motion.confirmed("revoke", t);
  label("另一台新设备 / 首次使用", 990, 271);
  text(logged ? "网站协作许可" : "从这里开始", 990, 315, 28, "#fff", 600);
  text(
    logged
      ? "新网站 example.org"
      : t >= 22.95
        ? "管理员已批准 · 等待本人登录"
        : motion.confirmed("server", t)
          ? "服务器已验证 · 等待批准"
          : "验证服务器，再登录",
    990,
    353,
    14,
    "#a7aebb",
    400,
  );
  button(
    logged
      ? "已登录 · 保留入房目标"
      : t >= 22.95
        ? "登录并继续"
        : motion.confirmed("server", t)
          ? "服务器已验证"
          : "验证服务器",
    990,
    385,
    280,
    true,
    logged || motion.confirmed("server", t),
  );
  if (logged) {
    label("仅授权这个网站", 990, 465);
    box(990, 485, 22, 22, motion.confirmed("consent", t) ? "#337bfa" : "#fff", 5, "#a4a4ae");
    if (motion.confirmed("consent", t)) text("✓", 1001, 502, 17, "#fff", 600, "center");
    text("我已阅读并同意", 1022, 502, 14, "#c1c6d0", 400);
    button(
      revoked ? "已撤销网站协作" : allowed ? "撤销网站协作" : "允许网站协作",
      990,
      545,
      280,
      true,
      revoked,
      motion.confirmed("consent", t),
    );
    text(
      revoked
        ? "停止后续协作，保留历史数据"
        : allowed
          ? "网站协作已允许 · 可随时撤销"
          : "浏览器权限由本人确认",
      990,
      635,
      14,
      "#a7aebb",
      400,
    );
  } else label("登录后继续原来的入房目标", 990, 503);
}
function ending(t) {
  backdrop();
  const p = ease((t - 26) / 0.6);
  ctx.save();
  ctx.translate(720, 330);
  ctx.scale(lerp(1.12, 1, p), lerp(1.12, 1, p));
  ctx.drawImage(logo, -61, -120, 122, 122);
  ctx.restore();
  alpha(p, () => {
    text("SyncAction", 720, 427, 88, "#f5f5f7", 600, "center");
    text("一个网页。我们，都在。", 720, 493, 39, "#c2c9d5", 500, "center");
    text("syncaction.thomasthzh.top", 720, 569, 26, "#9abfff", 500, "center");
    text("Chrome / Edge 桌面扩展 · 开源 · 可自行部署", 720, 658, 15, "#9a9fac", 400, "center");
  });
}
const scenes = {
  solo,
  join: joinHero,
  media,
  pages,
  annotations,
  quartet,
  groups,
  invitations,
  consent,
  end: ending,
};
function renderFilm(seconds) {
  const t = clamp(Number(seconds) || 0, 0, duration);
  const index = Math.max(
    0,
    chapters.findLastIndex((chapter) => t >= chapter.start),
  );
  const chapter = chapters[index],
    state = motion.sample(t);
  ctx.globalAlpha = 1;
  scenes[chapter.feature](t);
  // Shared dark field and matching object scales carry transitions. The pointer
  // overlay is drawn exactly once afterwards in its continuous global space.
  const transitionLength =
    chapter.feature === "quartet" || chapter.feature === "join" ? 0.24 : 0.32;
  const blend = index ? ease((t - chapter.start) / transitionLength) : 1;
  if (index && blend < 1) {
    if (transitionChapter !== index) {
      const mainContext = ctx;
      try {
        ctx = transitionContext;
        ctx.globalAlpha = 1;
        scenes[chapters[index - 1].feature](chapter.start - 0.001);
        transitionChapter = index;
      } finally {
        ctx = mainContext;
      }
    }
    alpha(1 - blend, () => ctx.drawImage(transitionCanvas, 0, 0));
  }
  text("SyncAction", 80, 43, 16, "#d7dbe4", 600);
  text("产品功能演绎", 1360, 43, 12, "#a5a9b4", 400, "right");
  state.cursors.forEach((pointer) => cursor(pointer, true));
  state.cursors.forEach((pointer) => cursor(pointer));
  window.filmState = {
    ...state,
    time: t,
    duration,
    chapter: chapter.feature,
    cursorCount: state.cursors.filter((pointer) => pointer.visible).length,
    simulation: true,
    transition: blend,
    cameraOffset: { x: 0, y: 0 },
  };
  return window.filmState;
}

window.renderFilm = renderFilm;
window.filmReady = false;
Promise.all([
  new Promise((resolve) => {
    logo.onload = resolve;
  }),
  new Promise((resolve) => {
    landscape.onload = resolve;
  }),
]).then(() => {
  renderFilm(0);
  window.filmReady = true;
});
logo.src = "/assets/syncaction-symbol-light-v4.svg";
landscape.src = "/assets/film-v4-landscape.jpg";
if (new URLSearchParams(window.location.search).has("render"))
  document.body.classList.add("is-rendering");
const previewButton = document.querySelector("#film-preview");
let started = 0,
  frame,
  playing = false;
function tick(now) {
  const seconds = (now - started) / 1000;
  renderFilm(Math.min(duration, seconds));
  if (seconds < duration && playing) frame = window.requestAnimationFrame(tick);
  else {
    playing = false;
    previewButton.textContent = "重新播放分镜";
  }
}
previewButton.addEventListener("click", () => {
  if (playing) {
    playing = false;
    window.cancelAnimationFrame(frame);
    previewButton.textContent = "重新播放分镜";
  } else {
    playing = true;
    started = performance.now();
    previewButton.textContent = "停止分镜";
    frame = window.requestAnimationFrame(tick);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && playing) {
    playing = false;
    window.cancelAnimationFrame(frame);
    previewButton.textContent = "重新播放分镜";
  }
});
window.addEventListener("pagehide", () => window.cancelAnimationFrame(frame));
