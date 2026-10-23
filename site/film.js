/* global document, window, Image, URLSearchParams, performance */
const canvas = document.querySelector("#film");
const ctx = canvas.getContext("2d", { alpha: false });
const logo = new Image(),
  landscape = new Image();
const motion = window.SyncActionFilmMotion;
const duration = 32;
const C = { ink: "#1d1d1f", muted: "#85858b", blue: "#377dff", line: "#dedee3" };
const font = '"Segoe UI", "Microsoft YaHei", sans-serif';
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (v) => {
  const p = clamp(v);
  return p * p * (3 - 2 * p);
};
const lerp = (a, b, p) => a + (b - a) * p;
const chapters = [
  [0, "solo", "一个人的网页。"],
  [3, "join", "让另一个人，走进此刻。"],
  [5.8, "media", "一停。都停。"],
  [8.5, "pages", "把好东西，带过来。"],
  [11.6, "annotations", "不用说「左边一点」。"],
  [14, "quartet", "同一刻。我们，都在。"],
  [18.5, "groups", "在一起，也各有节奏。"],
  [21, "invitations", "每一次加入，都由本人决定。"],
  [24, "consent", "开始清楚。边界也清楚。"],
  [28, "end", "一起看。也一起做点什么。"],
].map(([start, feature, title]) => ({ start, feature, title }));
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
function chrome(x, y, w, title = "周末，留一点时间给彼此") {
  box(x, y, w, 43, "#f1f1f4", [18, 18, 0, 0]);
  ["#e6aaa2", "#e4d09a", "#9dc6a8"].forEach((c, i) => dot(x + 22 + i * 15, y + 22, c, 4));
  box(x + w * 0.25, y + 9, w * 0.5, 26, "#fff", 7);
  text(title, x + w / 2, y + 27, 11, "#7c7c83", 400, "center");
}
function pageTitle(title, subtitle, dark = false, size = 62) {
  text(title, 80, 144, size, dark ? "#f5f5f7" : C.ink, 700);
  if (subtitle) text(subtitle, 84, 184, 18, dark ? "#a9abb3" : "#78787e", 400);
}
function footer(value, dark = false) {
  text(value, 80, 748, 16, dark ? "#adafb8" : "#71717a", 400);
}
function mediaClock(progress) {
  const seconds = lerp((340 / 1080) * 90, (732 / 1080) * 90, progress);
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(Math.floor((seconds - whole) * 100)).padStart(2, "0")}`;
}
function solo(t) {
  ctx.fillStyle = "#f5f5f7";
  ctx.fillRect(0, 0, 1440, 810);
  const p = ease(t / 2.8);
  ctx.save();
  ctx.translate(720, 421);
  ctx.scale(lerp(0.98, 1.015, p), lerp(0.98, 1.015, p));
  ctx.translate(-720, -421);
  paper(130, 127, 1180, 566);
  chrome(130, 127, 1180);
  sceneImage(t, 147, 186, 1146, 422, 7, 1.05 + t * 0.003);
  shade(147, 406, 1146, 202);
  text("THE SHARED MOMENT", 185, 552, 13, "#ffffffcc", 500);
  text("周末，留一点时间给彼此", 185, 585, 24, "#fff", 600);
  line(166, 637, 1190, 637, "#d9d9de", 3);
  line(166, 637, 550 + t * 15, 637, "#55555b", 3);
  text("Ⅱ", 166, 672, 20);
  text("正在播放", 204, 670, 13, "#77777e");
  text("01:30", 1273, 670, 13, "#77777e", 400, "right");
  ctx.restore();
  text("一个人的网页。", 80, 88, 28, C.ink, 600);
}
function joinHero(t) {
  const p = ease((t - 3) / 0.64);
  ctx.fillStyle = "#07090e";
  ctx.fillRect(0, 0, 1440, 810);
  sceneImage(
    t,
    lerp(147, 0, p),
    lerp(186, 0, p),
    lerp(1146, 1440, p),
    lerp(422, 810, p),
    lerp(7, 0, p),
    1.06,
  );
  shade(0, 0, 1440, 810, "#00000018", "#02060bcc");
  alpha(ease((t - 3.1) / 0.34), () => {
    text("此刻。", 78, 328, 136, "#fff", 700);
    text("不止你一个。", 82, 447, 100, "#fff", 700);
  });
  paper(1032, 398, 320, 230, true, 24);
  text("小林自己的设备", 1060, 434, 15, "#aeb2bd", 400);
  text(
    motion.confirmed("join", t) ? "一起看，已加入。" : "加入你的播放组",
    1060,
    480,
    23,
    "#fff",
    600,
  );
  text(
    motion.confirmed("join", t) ? "媒体跟随已确认" : "由小林本人确认",
    1060,
    514,
    14,
    "#aeb2bd",
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
  footer("各自打开内容，在同一个房间相遇。", true);
}
function media(t) {
  ctx.fillStyle = "#08090d";
  ctx.fillRect(0, 0, 1440, 810);
  const p = motion.seekProgress(t);
  pageTitle("一停。都停。", "暂停、调整进度。同伴跟随对齐，暂停状态保持。", true, 76);
  const stopped = motion.confirmed("pause", t);
  text(stopped ? "PAUSED TOGETHER" : "PLAYING TOGETHER", 88, 280, 13, "#7d94c7", 600);
  text(mediaClock(p), 78, 432, 145, "#f5f5f7", 600);
  box(1020, 270, 310, 160, "#17191f", 22, "#333640");
  dot(1050, 306, "#4384ff", 6);
  text("小林 · 跟随者", 1068, 312, 17, "#d4d6dd", 500);
  text(mediaClock(p), 1047, 367, 35, "#fff", 600);
  text(stopped ? "已对齐 · 保持暂停" : "正在跟随播放", 1048, 400, 14, "#9094a0", 400);
  button(stopped ? "Ⅱ 已暂停" : "Ⅱ 暂停", 88, 505, 124, true, stopped);
  line(180, 570, 1260, 570, "#373940", 6);
  line(180, 570, lerp(520, 912, p), 570, "#5c95ff", 6);
  dot(lerp(520, 912, p), 570, "#fff", 8);
  for (let i = 0; i <= 12; i++)
    line(180 + i * 90, 600, 180 + i * 90, i % 3 ? 610 : 620, "#55575f", 1);
  text("00:00", 180, 652, 14, "#8e919b");
  text("01:30", 1260, 652, 14, "#8e919b", 400, "right");
  footer("连接房间与跟随媒体，是两个明确的状态。", true);
}
function article(t, x = 80, y = 226, w = 865, h = 440) {
  paper(x, y, w, h);
  sceneImage(t, x + w * 0.54, y + 18, w * 0.44, h - 36, 14, 1.3);
  text("OUTSIDE / 一起探索", x + 28, y + 44, 12, "#888891", 600);
  text("下一站。", x + 28, y + 110, 47, C.ink, 700);
  text("去看更大的世界。", x + 28, y + 164, 33, C.ink, 600);
  ["把值得一看的页面，", "带到朋友面前。", "想法也有了落点。"].forEach((v, i) =>
    text(v, x + 30, y + 239 + i * 35, 20, "#7a7a82", 400),
  );
  text("一段旅程，几个人的期待。", x + 30, y + h - 39, 13, "#9898a0", 400);
}
function pages(t) {
  ctx.fillStyle = "#f5f5f7";
  ctx.fillRect(0, 0, 1440, 810);
  pageTitle("把好东西，带过来。", "第三个光标加入。共享页面，也找到同伴所在的位置。");
  article(t);
  paper(988, 226, 344, 440);
  text(t < 10 ? "你的设备" : "小林自己的设备", 1020, 257, 13, "#85858e", 400);
  text("房间的共享页面", 1020, 293, 22, C.ink, 600);
  text("周末的目的地", 1020, 322, 17, C.ink, 600);
  text("小梅在这个页面", 1020, 352, 14, "#85858e", 400);
  line(1020, 379, 1300, 379);
  text(
    motion.confirmed("page", t) ? "已在本设备打开" : "打开后，自己决定是否跟随",
    1020,
    415,
    14,
    "#7a7a84",
    400,
  );
  button(
    motion.confirmed("page", t) ? "页面已打开" : "打开同伴页面",
    1020,
    443,
    280,
    false,
    motion.confirmed("page", t),
  );
  button(
    motion.confirmed("share", t) ? "当前页已分享" : "分享当前页",
    1020,
    551,
    280,
    false,
    motion.confirmed("share", t),
  );
  footer("打开页面与加入播放组分别确认，不替你做决定。");
}
function annotations(t) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1440, 810);
  pageTitle("不用说「左边一点」。", "光标指过去。弹幕说出来。画笔把重点留下。");
  sceneImage(t, 75, 229, 900, 438, 18, 1.17);
  shade(75, 229, 900, 438, "#00000000", "#020916ae");
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
  paper(1010, 318, 326, 323);
  text("小林自己的设备", 1040, 354, 13, "#85858e", 400);
  text("小林的想法", 1040, 386, 20, C.ink, 600);
  text("这个风景，值得一起看。", 1040, 414, 17, "#6f6f78", 400);
  text("主动发送到当前页面", 1040, 451, 13, "#8b8b93", 400);
  button(
    motion.confirmed("danmaku", t) ? "弹幕已发送" : "发送弹幕",
    1040,
    555,
    260,
    false,
    motion.confirmed("danmaku", t),
  );
  if (motion.confirmed("danmaku", t)) {
    box(500 - (t - 13.22) * 95, 298, 318, 45, "#ffffffed", 22);
    text("小林：这个风景，值得一起看。", 520 - (t - 13.22) * 95, 327, 17, C.ink, 500);
  }
  footer("在已授权的兼容页面，讨论直接落在内容上。");
}
function quartet(t) {
  ctx.fillStyle = "#06070b";
  ctx.fillRect(0, 0, 1440, 810);
  const p = ease((t - 14) / 0.88);
  const x = lerp(0, 68, p),
    y = lerp(0, 200, p),
    w = lerp(1440, 1304, p),
    h = lerp(810, 506, p);
  text("同一刻。", 72, 172, 118, "#f5f5f7", 700);
  ctx.save();
  ctx.shadowColor = "#4477ff35";
  ctx.shadowBlur = 80;
  box(x, y, w, h, "#16191e", 24, "#b6ccff55");
  ctx.restore();
  sceneImage(t, x + 3, y + 3, w - 6, h - 6, 21, 1.06 + p * 0.025);
  shade(x + 3, y + 3, w - 6, h - 6, "#00000008", "#020914c9");
  alpha(p, () => {
    box(91, 220, 270, 37, "#15181ddd", 18, "#ffffff28");
    text("周末小聚 / 已授权的兼容页面", 109, 245, 13, "#d4d9e2", 500);
    ["#1d1d1f", "#007aff", "#8056c4", "#b56828"].forEach((c, i) => {
      dot(1190 + i * 35, 238, "#fff", 12);
      dot(1190 + i * 35, 238, c, 8);
    });
    text("我们，都在。", 112, 622, 100, "#fff", 700);
    text("四个光标。各自的设备。共同的目光。", 118, 665, 22, "#d6dce7", 400);
    line(1020, 460, 1160, 460, "#e5b75a", 3);
    text("就看这里", 1040, 434, 15, "#f7deab", 500);
  });
  if (t >= 16.4)
    alpha(ease((t - 16.4) / 0.3), () => {
      box(975, 310, 300, 62, "#ffffffec", 17);
      text("小梅：标出来，就更清楚。", 995, 348, 17, C.ink, 500);
    });
  footer("同页光标 · 弹幕 · 画笔 · 跟随播放", true);
}
function groups(t) {
  ctx.fillStyle = "#f5f5f7";
  ctx.fillRect(0, 0, 1440, 810);
  const viewB = motion.confirmed("view", t) && !motion.confirmed("return", t);
  pageTitle("在一起，也各有节奏。", "同一房间可以有多个播放组。查看别组，不会改变自己的参与状态。");
  const lift = ease((t - 18.5) / 0.4) * 8;
  paper(80, 260 - lift, 708, 397);
  sceneImage(t, 99, 280 - lift, 670, 234, 12, 1.05);
  text("A 组 / 你正在这里参与", 108, 561 - lift, 25, C.ink, 600);
  text("周末小聚 · 本设备参与状态保留", 108, 601 - lift, 16, "#7b7b84", 400);
  paper(882, 260, 450, 397);
  text(viewB ? "正在查看 B 组" : "回到 A 组", 920, 321, 28, C.ink, 600);
  text(viewB ? "浏览另一组的信息" : "继续自己的协作", 920, 368, 18, "#7c7c85", 400);
  text("你的播放参与：仍在 A 组", 920, 412, 16, "#28724d", 500);
  button(viewB ? "返回 A 组" : "查看 B 组", 940, 445, 320);
  text("查看 ≠ 加入", 920, 583, 17, "#8b8b93", 400);
  footer("四人在房间里。每个人都能选择自己的节奏。");
}
function invitations(t) {
  ctx.fillStyle = "#08090e";
  ctx.fillRect(0, 0, 1440, 810);
  pageTitle("靠近，由自己决定。", "邀请与加入申请，各自有清楚的确认人。", true);
  paper(150, 274, 490, 380, true);
  paper(810, 274, 490, 380, true);
  text("小林的设备", 190, 323, 14, "#9095a2", 400);
  text("有人邀请你", 190, 398, 40, "#fff", 650);
  text("邀请由接收者接受", 190, 447, 18, "#a5a9b5", 400);
  button(
    motion.confirmed("invitation", t) ? "已接受邀请" : "接受房间邀请",
    210,
    545,
    270,
    true,
    motion.confirmed("invitation", t),
  );
  text("另一个房间 / 房主设备", 850, 323, 14, "#9095a2", 400);
  text("有人申请加入", 850, 398, 40, "#fff", 650);
  text("加入申请由房主批准", 850, 447, 18, "#a5a9b5", 400);
  button(
    motion.confirmed("approve", t) ? "已批准申请" : "批准加入申请",
    920,
    545,
    270,
    true,
    motion.confirmed("approve", t),
  );
  if (t > 23.3)
    alpha(ease((t - 23.3) / 0.2), () => {
      box(400, 673, 640, 44, "#1c2638", 22, "#3d4d67");
      text("重新连接，读取已提交的房间状态。继续刚才。", 720, 702, 18, "#d0ddf1", 500, "center");
    });
  footer("独立功能演绎；媒体是否跟随，仍由本人明确确认。", true);
}
function consent(t) {
  ctx.fillStyle = "#f5f5f7";
  ctx.fillRect(0, 0, 1440, 810);
  pageTitle("开始清楚。边界也清楚。", "首次使用有指引。允许哪些网站，也由你掌握。", false, 58);
  paper(80, 229, 780, 450);
  sceneImage(t, 98, 247, 744, 414, 15, 1.12);
  shade(98, 247, 744, 414, "#00000000", "#031022ba");
  text("继续一起看。", 128, 596, 48, "#fff", 650);
  text("另一个已授权页面 / 同伴继续交流", 132, 631, 15, "#d5dbe5", 400);
  paper(956, 229, 362, 450);
  const logged = motion.confirmed("login", t),
    allowed = motion.confirmed("allow", t),
    revoked = motion.confirmed("revoke", t);
  text("另一台新设备 / 首次使用演示", 990, 271, 14, "#898993", 400);
  text(logged ? "网站协作许可" : "第一次使用", 990, 315, 27, C.ink, 650);
  text(
    logged
      ? "新网站 example.org"
      : t >= 25.1
        ? "管理员已批准 · 等待本人登录"
        : motion.confirmed("server", t)
          ? "服务器已验证 · 等待管理员批准"
          : "验证服务器，再登录或等待批准",
    990,
    351,
    13,
    "#7b7b85",
    400,
  );
  button(
    logged
      ? "已登录 · 保留原入房目标"
      : t >= 25.1
        ? "登录并继续"
        : motion.confirmed("server", t)
          ? "服务器已验证"
          : "验证服务器",
    990,
    385,
    280,
    false,
    logged || motion.confirmed("server", t),
  );
  if (logged) {
    text("仅授权这个网站的协作能力", 990, 466, 15, C.ink, 500);
    box(990, 485, 22, 22, motion.confirmed("consent", t) ? "#337bfa" : "#fff", 5, "#a4a4ae");
    if (motion.confirmed("consent", t)) text("✓", 1001, 502, 17, "#fff", 600, "center");
    text("我已阅读并同意", 1022, 502, 14, "#6c6c76", 400);
    button(
      revoked ? "已撤销网站协作" : allowed ? "撤销网站协作" : "允许网站协作",
      990,
      545,
      280,
      false,
      revoked,
      motion.confirmed("consent", t),
    );
    text(
      revoked ? "后续协作已停止，历史数据保留" : "浏览器网站权限仍需本人确认",
      990,
      635,
      13,
      "#84848e",
      400,
    );
  } else {
    text("登录后继续原来的入房目标", 990, 499, 15, "#92929b", 400);
  }
  footer("各自播放自己的内容；不传输视频流，也不读取密码或表单正文。");
}
function ending(t) {
  ctx.fillStyle = "#06070a";
  ctx.fillRect(0, 0, 1440, 810);
  const p = ease((t - 28) / 0.55);
  ctx.save();
  ctx.translate(720, 346);
  ctx.scale(lerp(1.18, 1, p), lerp(1.18, 1, p));
  ctx.shadowColor = "#4080ff48";
  ctx.shadowBlur = 80;
  ctx.drawImage(logo, -73, -166, 146, 146);
  ctx.restore();
  alpha(p, () => {
    text("SyncAction", 720, 408, 88, "#f5f5f7", 650, "center");
    text("一起看。也一起做点什么。", 720, 485, 40, "#d7d9e0", 500, "center");
    text("syncaction.thomasthzh.top", 720, 563, 25, "#669dff", 500, "center");
    text("Chrome / Edge 桌面扩展 · MIT 开源 · 可自行部署", 720, 649, 15, "#9195a1", 400, "center");
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
  const t = clamp(Number(seconds) || 0, 0, duration),
    index = Math.max(
      0,
      chapters.findLastIndex((c) => t >= c.start),
    );
  const chapter = chapters[index],
    local = t - chapter.start,
    state = motion.sample(t);
  ctx.globalAlpha = 1;
  const cut = ["solo", "join", "pages", "quartet", "end"].includes(chapter.feature),
    blend = cut ? 1 : ease(local / 0.18);
  scenes[chapter.feature](t);
  if (index > 0 && blend < 1)
    alpha(1 - blend, () => scenes[chapters[index - 1].feature](chapter.start - 0.001));
  const dark = ["join", "media", "quartet", "invitations", "end"].includes(chapter.feature);
  text("SyncAction", 80, 45, 17, dark ? "#f1f1f3" : C.ink, 600);
  text("功能演绎 / 本地模拟", 1360, 45, 12, dark ? "#a5a9b4" : "#83838c", 400, "right");
  state.cursors.forEach((pointer) => cursor(pointer, true));
  state.cursors.forEach((pointer) => cursor(pointer));
  window.filmState = {
    ...state,
    time: t,
    duration,
    chapter: chapter.feature,
    cursorCount: state.cursors.filter((p) => p.visible).length,
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
