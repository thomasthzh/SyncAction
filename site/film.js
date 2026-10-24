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
// Scene geometry is independent of the pointer overlay. Controls stay fixed while
// being used; the three quiet hero reframings happen between those operations.
function vignette(strength = 0.7) {
  const gradient = ctx.createRadialGradient(720, 370, 200, 720, 400, 900);
  gradient.addColorStop(0, "#03080b00");
  gradient.addColorStop(1, `rgba(0, 4, 12, ${strength})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1440, 810);
}
function eyebrow(value, x = 80, y = 102, light = true) {
  text(value, x, y, 15, light ? "#bbc1ca" : "#747982", 500);
}
function deviceTitle(value, x, y) {
  dot(x, y - 5, "#a3b4ce", 3);
  text(value, x + 15, y, 13, "#b9c0cc", 500);
}
function solo(t) {
  backdrop();
  const open = ease(t / 2.9);
  sceneImage(t, 0, lerp(74, 38, open), 1440, lerp(662, 734, open), 0, 1.13 - open * 0.035);
  shade(0, 35, 1440, 740, "#020a1410", "#020711c9");
  vignette(0.37);
  eyebrow("周末放映室", 82, 112);
  alpha(ease((t - 0.2) / 0.55), () => {
    text("这一刻。", 82, 636, 78, "#f5f5f7", 600);
    text("想和你一起。", 86, 685, 23, "#cad0d9", 400);
  });
  line(1070, 690, 1330, 690, "#ffffff3b", 2);
  line(1070, 690, 1170 + t * 12, 690, "#f5f5f7", 2);
  text("Ⅱ", 1040, 696, 17, "#e4e9ef");
  text("00:24", 1330, 729, 13, "#c0c6cf", 400, "right");
}
function joinHero(t) {
  backdrop();
  const p = ease((t - 3) / 0.5);
  sceneImage(t, 0, lerp(38, 0, p), 1440, lerp(734, 810, p), 0, 1.09 + (t - 3) * 0.013);
  shade(0, 0, 1440, 810, "#00000010", "#030813cc");
  vignette(0.36);
  alpha(ease((t - 3) / 0.42), () => {
    text("一起。", 71, 427, 218, "#f5f5f7", 600);
    text("目光，在此相遇。", 87, 492, 30, "#d7dce5", 400);
  });
  // A single local device action makes the promise concrete without a tutorial wall.
  box(1036, 418, 300, 194, "#101722ed", 23, "#ffffff24");
  deviceTitle("小林自己的设备", 1060, 451);
  text(
    motion.confirmed("join", t) ? "我们，开始一起看。" : "同一个播放组。",
    1060,
    495,
    23,
    "#fff",
    600,
  );
  text(
    motion.confirmed("join", t) ? "已对齐领播状态" : "由小林本人加入",
    1060,
    524,
    13,
    "#bac5d5",
    400,
  );
  button(
    motion.confirmed("join", t) ? "已加入 · 跟随播放" : "加入播放组",
    1060,
    546,
    260,
    true,
    motion.confirmed("join", t),
  );
  text("各自的设备，同一个此刻。", 86, 731, 17, "#d2d8e0", 400);
}
function media(t) {
  backdrop();
  const p = motion.seekProgress(t),
    stopped = motion.confirmed("pause", t);
  eyebrow("同一段进度。同一个节奏。", 88, 112);
  // Macro: one oversized clock and an exposed timeline replace the browser shell.
  text(mediaClock(p), 78, 402, 174, "#f5f5f7", 600);
  text(stopped ? "PAUSED TOGETHER" : "PLAYING TOGETHER", 89, 447, 13, "#9fb2cc", 500);
  sceneImage(t, 1060, 151, 272, 153, 16, 1.08);
  box(1057, 337, 278, 91, "#141920", 15, "#ffffff1c");
  dot(1080, 363, "#a9c7ee", 3);
  text("小林 · 跟随者", 1093, 369, 14, "#d2d9e2", 500);
  text(stopped ? "已对齐，保持暂停。" : "正在跟随播放。", 1080, 402, 17, "#f5f5f7", 500);
  button(stopped ? "Ⅱ 已暂停" : "Ⅱ 暂停", 88, 505, 124, true, stopped);
  line(180, 570, 1260, 570, "#343942", 6);
  line(180, 570, lerp(520, 912, p), 570, "#a8c5ef", 6);
  dot(lerp(520, 912, p), 570, "#fff", 8);
  for (let i = 0; i <= 24; i++) line(180 + i * 45, 599, 180 + i * 45, i % 4 ? 609 : 625, "#555b66");
  text("00:00", 180, 663, 16, "#a8afb9", 400);
  text("01:30", 1260, 663, 16, "#a8afb9", 400, "right");
  text("你停下，我们也在这一秒。", 88, 738, 26, "#d9dfe8", 500);
}
function pages(t) {
  backdrop();
  // Bright editorial content creates a deliberate change of material and scale.
  box(36, 104, 930, 620, "#f2f3f5", 24);
  sceneImage(t, 520, 124, 426, 580, 15, 1.22);
  text("周末的目的地", 82, 161, 14, "#7a7f86", 500);
  text("下一站。", 78, 323, 86, "#1d1d1f", 650);
  text("去看更大的世界。", 83, 384, 34, "#3a3e43", 500);
  line(86, 429, 148, 429, "#2f3945", 2);
  text("把好东西，", 83, 488, 24, "#797f88", 400);
  text("带到同伴身边。", 83, 526, 24, "#797f88", 400);
  text("共享页面 / 功能示意", 83, 676, 12, "#8d939b", 400);
  deviceTitle(t < 8.5 ? "你的设备" : "小林自己的设备", 1020, 265);
  text("一个链接。", 1020, 325, 35, "#f5f5f7", 600);
  text("另一种相聚。", 1020, 373, 35, "#f5f5f7", 600);
  text(
    motion.confirmed("page", t) ? "已在本设备打开" : "打开后，自行决定是否跟随",
    1020,
    418,
    14,
    "#a9b4c5",
    400,
  );
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
  sceneImage(t, 0, 0, 1440, 810, 0, 1.16);
  shade(0, 0, 1440, 810, "#02050c10", "#030912d1");
  vignette(0.55);
  eyebrow("把想法，留在你指向的地方。", 82, 112);
  text("就从这里，出发。", 266, 476, 42, "#f5f5f7", 600);
  const p = motion.penProgress(t);
  if (p > 0) {
    ctx.beginPath();
    ctx.moveTo(270, 505);
    for (let i = 1; i <= 100; i++) {
      const q = (p * i) / 100;
      ctx.lineTo(270 + 370 * q, 505 + Math.sin(q * Math.PI) * 18);
    }
    ctx.strokeStyle = "#e8bc71";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
  }
  box(1016, 423, 312, 192, "#111b28ec", 22, "#ffffff24");
  deviceTitle("小林自己的设备", 1040, 457);
  text("这个风景，值得一起看。", 1040, 510, 19, "#edf0f5", 500);
  button(
    motion.confirmed("danmaku", t) ? "弹幕已发送" : "发送弹幕",
    1040,
    555,
    260,
    true,
    motion.confirmed("danmaku", t),
  );
  if (motion.confirmed("danmaku", t)) {
    const x = 700 - (t - 11.07) * 180;
    box(x, 234, 322, 43, "#fffffff0", 21);
    text("小林：这个风景，值得一起看。", x + 20, 262, 17, C.ink, 500);
  }
  text("光标 · 弹幕 · 画笔", 82, 724, 32, "#f1f3f7", 500);
  text("已授权的兼容页面", 82, 757, 13, "#b1bbc9", 400);
}
function quartet(t) {
  backdrop();
  const local = t - 11.5;
  // Three authored framings: immersive wide -> intimate crop -> the whole shared
  // surface. The photograph moves; all four arrows keep their global position.
  if (local < 1.2) {
    const p = ease(local / 0.72);
    sceneImage(t, 0, 0, 1440, 810, 0, lerp(1.16, 1.06, p));
    shade(0, 0, 1440, 810, "#00020a0a", "#030912c5");
    shade(0, 0, 1440, 360, "#030912b8", "#03091200");
    alpha(ease(local / 0.36), () => {
      text("相隔很远。", 80, 175, 81, "#f5f5f7", 600);
      text("也能，很近。", 84, 229, 29, "#c8d0dd", 400);
    });
  } else if (local < 2.9) {
    const push = ease((local - 1.2) / 0.36);
    const settle = ease((local - 1.56) / 1.34);
    const zoom = local < 1.56 ? lerp(1.06, 1.52, push) : lerp(1.52, 1.31, settle);
    sceneImage(t, 0, 0, 1440, 810, 0, zoom);
    shade(0, 0, 1440, 810, "#00030b0a", "#030912d4");
    shade(0, 0, 1440, 360, "#030912b8", "#03091200");
    alpha(1 - push, () => {
      text("相隔很远。", 80, 175, 81, "#f5f5f7", 600);
      text("也能，很近。", 84, 229, 29, "#c8d0dd", 400);
    });
    alpha(push, () => {
      text("近到，", 81, 664, 78, "#f5f5f7", 600);
      text("看见同一处心动。", 351, 664, 37, "#e3e8ef", 500);
      text("四个光标 / 各自的设备", 86, 711, 14, "#b4c0ce", 400);
    });
  } else {
    const p = ease((local - 2.9) / 0.65);
    const x = lerp(0, 74, p),
      y = lerp(0, 145, p);
    const w = lerp(1440, 1292, p),
      h = lerp(810, 577, p);
    ctx.save();
    ctx.shadowColor = "#a0bce330";
    ctx.shadowBlur = 90;
    box(x, y, w, h, "#142033", lerp(0, 25, p), "#c5d6ee38");
    ctx.restore();
    sceneImage(t, x + 2, y + 2, w - 4, h - 4, lerp(0, 23, p), lerp(1.31, 1.06, p));
    shade(x + 2, y + 2, w - 4, h - 4, "#00020a08", "#030e20ba");
    alpha(p, () => {
      text("此刻，相逢。", 79, 107, 65, "#f5f5f7", 600);
      text("同一个网页，同一个此刻。", 111, 655, 36, "#f5f5f7", 500);
      text("已授权的兼容页面", 114, 696, 13, "#c0cad8", 400);
    });
  }
}
function groups(t) {
  backdrop();
  const viewB = motion.confirmed("view", t) && !motion.confirmed("return", t);
  sceneImage(t, 0, 112, 830, 604, 0, 1.28);
  shade(0, 112, 830, 604, "#06101c20", "#040a15d2");
  text("各有节奏。", 78, 340, 93, "#f5f5f7", 600);
  text("仍在一起。", 83, 405, 41, "#d6dfeb", 500);
  text("A 组 / 你正在参与", 83, 651, 20, "#d6dfeb", 500);
  deviceTitle("你的设备", 940, 265);
  text(viewB ? "正在查看 B 组" : "你的播放组", 940, 334, 32, "#fff", 600);
  text("查看另一组，不会自动加入。", 940, 382, 20, "#b1bdd0", 400);
  text("你的参与：仍在 A 组", 940, 418, 15, "#a9bedc", 400);
  button(viewB ? "返回 A 组" : "查看 B 组", 940, 445, 320, true);
  text("查看 ≠ 加入", 940, 602, 17, "#91a4bf", 400);
}
function invitations(t) {
  backdrop();
  // A quiet dip separates simultaneous local decisions. No pointer operates the
  // other person's device, and the two room contexts stay explicitly distinct.
  eyebrow("靠近，由自己决定。", 80, 112);
  line(720, 228, 720, 632, "#ffffff22");
  deviceTitle("小林自己的设备", 210, 291);
  text("一个邀请。", 202, 389, 68, "#f5f5f7", 600);
  text("接收者本人接受", 210, 444, 22, "#a8b3c4", 400);
  button(
    motion.confirmed("invitation", t) ? "已接受邀请" : "接受房间邀请",
    210,
    545,
    270,
    true,
    motion.confirmed("invitation", t),
  );
  deviceTitle("另一房间 / 房主设备", 920, 291);
  text("一份默契。", 911, 389, 68, "#f5f5f7", 600);
  text("加入申请由房主批准", 920, 444, 22, "#a8b3c4", 400);
  button(
    motion.confirmed("approve", t) ? "已批准申请" : "批准加入申请",
    920,
    545,
    270,
    true,
    motion.confirmed("approve", t),
  );
  if (t >= 21.1)
    alpha(ease((t - 21.1) / 0.24), () => {
      text("重连，读取已提交的房间状态。继续刚才。", 720, 720, 18, "#b0bac9", 400, "center");
    });
}
function consent(t) {
  backdrop();
  // A large shared scene stays alive while the small new-device panel states the
  // real setup and per-site permission sequence. Revoking this site leaves the
  // independent already-authorized page on the left intact.
  sceneImage(t, 0, 0, 875, 810, 0, 1.26);
  shade(0, 0, 875, 810, "#00040a1a", "#031022cd");
  text("心有共鸣。", 79, 174, 72, "#f5f5f7", 600);
  text("自由有界。", 83, 251, 62, "#d7dfeb", 500);
  text("另一个已授权页面", 84, 699, 16, "#d2dae6", 400);
  text("同伴继续观看与讨论。", 84, 733, 22, "#edf1f7", 400);
  const logged = motion.confirmed("login", t),
    allowed = motion.confirmed("allow", t),
    revoked = motion.confirmed("revoke", t);
  deviceTitle("另一台新设备 / 首次使用", 990, 255);
  text(logged ? "仅授权这个网站。" : "连接，然后相聚。", 990, 319, 29, "#f5f5f7", 600);
  text(
    logged
      ? "example.org"
      : t >= 22.95
        ? "管理员已批准 · 等待本人登录"
        : motion.confirmed("server", t)
          ? "服务器已验证 · 等待批准"
          : "验证服务器，再登录",
    990,
    355,
    14,
    "#b2bdcf",
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
    text("由本人确认网站权限", 990, 465, 14, "#c3ccda", 400);
    box(990, 485, 22, 22, motion.confirmed("consent", t) ? "#337bfa" : "#fff", 5, "#a4a4ae");
    if (motion.confirmed("consent", t)) text("✓", 1001, 502, 17, "#fff", 600, "center");
    text("我已阅读并同意", 1022, 502, 14, "#cbd3df", 400);
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
      "#a7b4c9",
      400,
    );
  } else text("登录后继续原来的入房目标", 990, 505, 14, "#a7b4c9", 400);
}
function ending(t) {
  backdrop();
  const p = ease((t - 26) / 0.7);
  // The ending uses the same untouched center reserved by all four moving routes.
  alpha(p, () => {
    ctx.drawImage(logo, 685, 224, 70, 70);
    text("SyncAction", 720, 342, 25, "#b9c4d4", 500, "center");
    text("天涯共此时", 720, 469, 114, "#f5f5f7", 600, "center");
    text("syncaction.thomasthzh.top", 720, 554, 24, "#a6bedf", 400, "center");
    text("Chrome / Edge 桌面扩展 · 开源 · 可自行部署", 720, 615, 14, "#949fac", 400, "center");
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
  const transitionLength = chapter.feature === "quartet" || chapter.feature === "join" ? 0.12 : 0.2;
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
  text("SyncAction", 80, 43, 14, "#c6ceda", 500);
  text("产品功能演绎", 1360, 43, 11, "#a5aeba", 400, "right");
  state.cursors.forEach((pointer) => cursor(pointer, true));
  state.cursors.forEach((pointer) => cursor(pointer));
  window.filmState = {
    ...state,
    time: t,
    duration,
    chapter: chapter.feature,
    shot:
      chapter.feature === "quartet"
        ? t < 12.7
          ? "immersive-wide"
          : t < 14.4
            ? "intimate-crop"
            : "shared-surface"
        : chapter.feature,
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
