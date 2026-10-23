/* global document, window, Image, URLSearchParams, performance */
const canvas = document.querySelector("#film");
const ctx = canvas.getContext("2d", { alpha: false });
const logo = new Image();
const motion = window.SyncActionFilmMotion;
const duration = 36;
const C = { ink: "#1d1d1f", muted: "#6e6e73", teal: "#0071e3", purple: "#007aff", line: "#dedee3" };
const font = '"Segoe UI", "Microsoft YaHei", sans-serif';
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (v) => {
  const t = clamp(v);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const chapters = [
  [0, "solo", "一个人的网页。", "视频在播放，想法在发生。"],
  [3, "join", "第二个光标。共同的此刻。", "小林在自己的设备加入播放组，再开始一起看。"],
  [6, "media", "你停下，我们也在这一秒。", "暂停、调整进度。朋友跟随对齐，暂停状态保持。"],
  [9, "pages", "好东西，不用再找一次。", "分享当前页，找到同伴，再打开对应页面。"],
  [12, "annotations", "你看这里。", "同页光标、弹幕、画笔，让讨论留在内容里。"],
  [15, "groups", "同一房间，各有节奏。", "查看 B 组时，仍在 A 组。查看与加入，是不同动作。"],
  [
    18,
    "invitations",
    "每个加入，都出于本人意愿。",
    "邀请由接收者接受；另一房间的加入申请，由房主确认。",
  ],
  [21, "recovery", "断开片刻，继续刚才。", "重新连接，读取已提交的房间快照。媒体跟随单独确认。"],
  [
    24,
    "onboarding",
    "第一次，也走得清楚。",
    "验证服务器、等待批准、本人登录，然后继续原入房目标。",
  ],
  [27, "consent", "靠近一点，仍由你决定。", "阅读、同意、允许；网站协作权限随时可以撤销。"],
  [30, "quartet", "四个人，同一页。", "切换到另一个已授权页面，一起看、讨论、画重点。"],
  [33, "end", "一起看。也一起做点什么。", "Chrome / Edge 桌面扩展 · MIT 开源 · 可自行部署"],
].map(([start, feature, title, sub]) => ({ start, feature, title, sub }));
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
function pill(value, x, y, w, color = C.teal, fill = "#eaf2fc") {
  box(x, y, w, 29, fill, 9);
  text(value, x + w / 2, y + 20, 12, color, 600, "center");
}
function button(value, x, y, w = 150, primary = true, enabled = true) {
  box(
    x,
    y,
    w,
    40,
    enabled ? (primary ? C.teal : "#fff") : "#ededf0",
    10,
    primary ? undefined : C.line,
  );
  text(
    value,
    x + w / 2,
    y + 26,
    14,
    enabled ? (primary ? "#fff" : C.ink) : "#8e8e93",
    600,
    "center",
  );
}
function paper(x, y, w, h, r = 20) {
  ctx.save();
  ctx.shadowColor = "#00000012";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 12;
  box(x, y, w, h, "#fff", r);
  ctx.restore();
}
function avatar(name, x, y, color = C.teal) {
  box(x, y, 32, 32, "#eff3f8", 11);
  text(name, x + 16, y + 22, 13, color, 650, "center");
}
function cursor(pointer, labelOnly = false) {
  const { x, y, click, tool } = pointer;
  const color =
    pointer.color ?? { you: C.ink, friend: "#007aff", mei: "#a05acb", zhou: "#b46e13" }[pointer.id];
  const name = pointer.name ?? { you: "你", friend: "小林", mei: "小梅", zhou: "小周" }[pointer.id];
  ctx.save();
  ctx.translate(x, y);
  if (labelOnly) {
    const width = name.length === 1 ? 43 : 55;
    box(17, 30, width, 23, "#fffffff2", 11, "#dedee3");
    ctx.beginPath();
    ctx.arc(26, 41.5, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    text(name, 33, 45, 11, C.ink, 500);
    ctx.restore();
    return;
  }
  ctx.shadowColor = "#00000024";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  if (tool === "pen") {
    ctx.moveTo(0, 0);
    ctx.lineTo(4, -11);
    ctx.lineTo(17, -24);
    ctx.lineTo(24, -17);
    ctx.lineTo(11, -4);
  } else {
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 24);
    ctx.lineTo(6, 18);
    ctx.lineTo(11, 29);
    ctx.lineTo(16, 27);
    ctx.lineTo(11, 16);
    ctx.lineTo(21, 16);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.6;
  ctx.fill();
  ctx.stroke();
  ctx.shadowColor = "transparent";
  if (click) {
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.strokeStyle = color + "66";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}
function browserFrame(title = "周末，留一点时间给彼此") {
  paper(92, 120, 1256, 500);
  box(92, 120, 1256, 50, "#eff0f2", 20);
  box(92, 150, 1256, 20, "#eff0f2", 0);
  ["#e9aaa0", "#d9c480", "#93bfa7"].forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(114 + i * 15, 145, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  box(210, 131, 830, 28, "#fff", 8);
  text(title, 229, 151, 12, C.muted);
  text("＋", 1316, 153, 23, C.muted);
}
function scenicVideo(t, x = 140, y = 214, w = 854, h = 288) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 12);
  ctx.clip();
  const sky = ctx.createLinearGradient(x, y, x, y + h);
  sky.addColorStop(0, "#89b8bc");
  sky.addColorStop(0.64, "#e7d9b1");
  sky.addColorStop(0.65, "#83b6bd");
  sky.addColorStop(1, "#396480");
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.arc(x + w * 0.72 + Math.sin(t * 0.12) * 5, y + h * 0.3, 36, 0, Math.PI * 2);
  ctx.fillStyle = "#fff0bd";
  ctx.fill();
  const drift = Math.sin(t * 0.15) * 9;
  ctx.beginPath();
  ctx.moveTo(x - 30, y + h);
  ctx.bezierCurveTo(
    x + w * 0.14,
    y + h * 0.45 + drift,
    x + w * 0.4,
    y + h * 0.95,
    x + w * 0.62,
    y + h,
  );
  ctx.closePath();
  ctx.fillStyle = "#436e77";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + w * 0.4, y + h);
  ctx.bezierCurveTo(
    x + w * 0.68,
    y + h * 0.75,
    x + w * 0.83,
    y + h * 0.58 - drift,
    x + w + 20,
    y + h * 0.72,
  );
  ctx.lineTo(x + w + 20, y + h + 10);
  ctx.closePath();
  ctx.fillStyle = "#345c70";
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    const yy = y + h * 0.7 + i * 13;
    line(
      x + w * 0.43 + Math.sin(t * 0.6 + i) * 15,
      yy,
      x + w * 0.67 + Math.sin(t * 0.6 + i) * 15,
      yy,
      "#e9ead01d",
      2,
    );
  }
  text("THE QUIET MOMENT", x + 28, y + 40, 13, "#244c5a", 650);
  text("一起，把时间慢下来。", x + 29, y + 65, 15, "#375d62", 400);
  pill("示意视频画面", x + w - 111, y + h - 35, 99, "#fff", "#123e4ca0");
  ctx.restore();
}

function watch(t, join = false) {
  browserFrame();
  scenicVideo(t, 140, 214, 854, 288);
  text("周末，留一点时间给彼此", 142, 535, 22, C.ink, 650);
  box(142, 559, 705, 5, "#e1eaf0", 3);
  box(142, 559, 705 * (0.27 + t * 0.008), 5, C.teal, 3);
  text("▷ 正在播放", 142, 592, 12, C.muted);
  line(1028, 187, 1028, 605);
  text("周末小聚", 1052, 234, 23, C.ink, 650);
  text("房间已同步 · 功能演绎", 1052, 260, 12, C.muted);
  avatar("你", 1052, 292, C.ink);
  text("你 · 房主设备领播", 1097, 314, 14, C.ink, 600);
  avatar("林", 1052, 346);
  text(join ? "本设备 · 小林" : "等待同伴", 1097, 366, 14, C.ink, 600);
  const joined = motion.confirmed("join", t);
  text(
    join ? (joined ? "已加入跟随" : "同页已授权 · 尚未跟随") : "来到同页，再一起开始",
    1097,
    389,
    11,
    C.muted,
  );
  if (join) {
    pill("小林的设备 · 本人操作", 1052, 470, 268);
    button(joined ? "已明确加入跟随" : "加入播放组", 1052, 532, 268, !joined);
  } else pill("网站协作已授权", 1052, 532, 268);
}
function media(t) {
  const paused = motion.confirmed("pause", t),
    seek = motion.seekProgress(t);
  paper(92, 120, 1256, 500);
  scenicVideo(paused ? lerp(6.85, 63, seek) : t, 116, 142, 1208, 388);
  pill("房主的观看面", 142, 163, 180, C.ink, "#ffffffdb");
  pill(
    paused ? (seek > 0.99 ? "暂停中 · 进度已对齐" : "暂停已同步") : "持续跟随中",
    1080,
    163,
    222,
    "#fff",
    "#1d1d1fc9",
  );
  box(142, 559, 705, 5, "#dedee3", 3);
  box(142, 559, 705 * lerp(0.3, 0.7, seek), 5, C.teal, 3);
  ctx.beginPath();
  ctx.arc(142 + 705 * lerp(0.3, 0.7, seek), 561, 6, 0, Math.PI * 2);
  ctx.fillStyle = C.teal;
  ctx.fill();
  box(142, 575, 122, 30, "#f5f5f7", 8, C.line);
  text(paused ? "Ⅱ 已暂停" : "▷ 正在播放", 155, 595, 12, C.muted);
  text("本设备领播 → 小林跟随", 950, 573, 18, C.ink, 600);
  text("对齐一次与持续跟随是独立操作", 950, 598, 12, C.muted);
}
function pages(t) {
  paper(92, 120, 1256, 500);
  text("我们的共享页面", 142, 221, 32, C.ink, 650);
  text("页面的位置，也能找到彼此。", 142, 245, 14, C.muted);
  const chosen = motion.confirmed("page", t);
  ["课程笔记", "周末片单", "灵感收集"].forEach((name, i) => {
    const y = 259 + i * 86;
    box(142, y, 852, 70, i === (chosen ? 1 : 0) ? "#eaf2fc" : "#f5f5f7", 12);
    text("0" + (i + 1), 164, y + 43, 15, C.muted);
    text(name, 219, y + 32, 20, C.ink, 600);
    text(
      i === 0 ? "小林正在这里" : i === 1 && chosen ? "你正在查看" : "共享页面",
      219,
      y + 54,
      11,
      C.muted,
    );
    text("↗", 956, y + 45, 25, C.teal);
  });
  button(
    motion.confirmed("share", t) ? "当前页已分享" : "分享当前页",
    142,
    545,
    200,
    !motion.confirmed("share", t),
  );
  text("只打开页面，不会自动加入播放组。", 371, 571, 14, C.muted);
  avatar("林", 1060, 290);
  text("小林", 1107, 310, 17, C.ink, 600);
  line(1076, 335, 1076, 455, C.line, 2);
  box(1053, 464, 260, 92, "#f5f5f7", 14);
  text("找到位置", 1074, 498, 19, C.ink, 600);
  text("再决定如何一起看", 1074, 526, 13, C.muted);
}
function stroke(t) {
  const progress = motion.penProgress(t);
  if (progress <= 0) return;
  ctx.beginPath();
  ctx.moveTo(179, 415);
  for (let i = 1; i <= 80; i++) {
    const f = Math.min(progress, i / 80);
    ctx.lineTo(179 + 298.9 * f, 415 + Math.sin(49 * 0.12 * f) * 3);
    if (f >= progress) break;
  }
  ctx.strokeStyle = C.teal;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.stroke();
}
function annotations(t) {
  paper(92, 120, 1256, 500);
  text("一起读 / NOTES", 179, 221, 13, C.muted, 600);
  text("好想法，值得一起停留。", 179, 304, 42, C.ink, 650);
  text("少一点“第三段第二行”，", 179, 363, 25, C.muted);
  text("多一点“你看这里”。", 179, 404, 25, C.muted);
  text("把重要的内容看清楚，让讨论自然地继续。", 179, 474, 18, C.muted);
  stroke(t);
  const p = ease((t - 13.65) / 0.24);
  ctx.save();
  ctx.globalAlpha = p;
  box(860, 256, 370, 64, "#eaf2fc", 20);
  text("小林  这句说得真好。", 888, 297, 21, C.teal, 600);
  ctx.restore();
  pill("光标", 179, 548, 100);
  pill("弹幕", 293, 548, 100);
  pill("画笔", 407, 548, 100);
  text("网站已授权 · 内容兼容", 1226, 580, 12, C.muted, 500, "right");
}
function groups(t) {
  text("周末小聚 / 播放组", 142, 171, 16, C.muted, 600);
  const selected = motion.confirmed("view", t) && !motion.confirmed("return", t);
  [
    ["播放组 A", "周末短片", "你正在领播 · 我的播放组"],
    ["播放组 B", "课程回放", "仅查看 · 尚未加入"],
  ].forEach(([name, title, scope], i) => {
    const x = 142 + i * 437;
    paper(x, 205, 415, 320);
    box(x, 205, 415, 5, i ? "#a05acb" : C.teal, 2);
    text(name, x + 20, 257, 18, i ? "#9353bc" : C.teal, 600);
    text(title, x + 20, 335, 34, C.ink, 650);
    text(scope, x + 20, 383, 15, C.muted);
    button(i ? "查看这个组" : "返回我的播放组", x + 20, 438, 240, i === 1);
  });
  box(1040, 205, 289, 320, "#1d1d1f", 20);
  text(selected ? "查看 B" : "留在 A", 1071, 300, 35, "#fff", 650);
  text("查看不改变成员关系", 1071, 346, 16, "#c7c7cf");
  pill("本设备仍属于 A", 1071, 400, 224, C.ink, "#fff");
  pill(selected ? "正在查看 B · 本人仍在 A" : "本设备仍在播放组 A", 142, 552, 852);
}
function invitations(t) {
  [
    [100, "小林的设备", "接收者本人接受邀请", "周末小聚邀请你加入", "invitation"],
    [790, "房主的设备", "另一房间的独立申请", "小周申请加入另一个房间", "approve"],
  ].forEach(([x, title, scope, subject, target], i) => {
    paper(x, 155, 550, 430);
    text(title, x + 32, 207, 20, i ? C.ink : C.teal, 650);
    text(scope, x + 32, 237, 13, C.muted);
    line(x + 32, 265, x + 518, 265);
    text(subject, x + 32, 335, 25, C.ink, 600);
    text("确认来自本人，不自动接受或批准。", x + 32, 378, 15, C.muted);
    const confirmed = motion.confirmed(target, t);
    button(
      confirmed ? (i ? "房主已批准" : "小林已接受邀请") : i ? "同意加入" : "接受邀请",
      i ? 866 : 176,
      432,
      250,
      !confirmed,
    );
    text(confirmed ? "确认后继续目标房间" : "等待本人操作", x + 32, 545, 13, C.muted);
  });
}
function recovery(t) {
  paper(92, 120, 1256, 500);
  scenicVideo(t, 116, 142, 744, 450);
  const restored = t >= 23,
    connecting = motion.confirmed("reconnect", t);
  text("连接与恢复", 910, 202, 16, C.muted, 600);
  text(restored ? "回来了。" : "稍等一下。", 910, 271, 40, C.ink, 650);
  text(restored ? "房间快照已重新读取" : "当前页面保留在这里", 910, 320, 20, C.ink, 600);
  text("房间连接", 910, 370, 13, C.muted);
  pill(
    restored ? "已同步" : connecting ? "重新连接中" : "暂时断开",
    1050,
    349,
    180,
    restored ? C.teal : C.ink,
  );
  button(
    restored ? "房间信息已恢复" : connecting ? "正在读取房间快照" : "重新连接",
    910,
    446,
    320,
    !restored,
  );
  text("媒体跟随状态另行确认", 910, 546, 14, C.muted);
}
function onboarding(t) {
  const server = motion.confirmed("server", t),
    login = motion.confirmed("login", t),
    approved = t >= 25.6;
  text("第一次使用", 142, 171, 16, C.muted, 600);
  [
    [142, "01", "配置服务器"],
    [546, "02", "登录 / 等待批准"],
    [950, "03", "继续原目标"],
  ].forEach(([x, no, title], i) => {
    const active = (i === 0 && !server) || (i === 1 && server && !login) || (i === 2 && login);
    paper(x, 208, 350, 315);
    text(no, x + 28, 260, 17, active ? C.teal : C.muted, 600);
    text(title, x + 28, 307, 25, C.ink, 650);
    if (active) box(x + 28, 331, 62, 3, C.teal, 2);
  });
  text("验证公共服务器地址", 176, 382, 17, C.muted);
  text("syncaction.thomasthzh.top", 176, 411, 15, C.ink);
  button(server ? "服务器已验证" : "验证并连接", 176, 451, 300, !server);
  text(
    !server ? "尚未登录" : login ? "本人登录完成" : approved ? "管理员已批准" : "账号待批准",
    580,
    382,
    20,
    C.ink,
    600,
  );
  text("审批由服务器管理员完成", 580, 411, 14, C.muted);
  button(login ? "登录已完成" : "批准后登录", 580, 451, 300, !login, approved);
  text(login ? "目标：周末小聚" : "尚未入房", 984, 385, 20, C.ink, 600);
  text(login ? "无需再找一次房间" : "完成对应步骤后继续", 984, 424, 14, C.muted);
  text("上下文改变时重新确认", 984, 478, 13, C.muted);
}
function consent(t) {
  paper(92, 120, 1256, 500);
  text("授权，是自己的选择。", 140, 260, 40, C.ink, 650);
  text("仅限当前网站", 142, 317, 21, C.muted);
  text("不传输 Cookie、密码、表单文字、", 142, 382, 16, C.muted);
  text("网页正文、截图或视频流。", 142, 413, 16, C.muted);
  text("撤销不自动删除已分享页面与消息。", 142, 553, 13, C.muted);
  const agreed = motion.confirmed("consent", t),
    allowed = motion.confirmed("allow", t),
    revoked = motion.confirmed("revoke", t);
  box(766, 184, 560, 402, "#f5f5f7", 20);
  text("当前网站的协作许可", 790, 247, 25, C.ink, 650);
  text("兼容性摘要、位置、媒体状态、弹幕和画笔", 790, 306, 15, C.ink);
  text("浏览器还可能另行要求网站权限", 790, 343, 14, C.muted);
  box(790, 397, 21, 21, agreed ? C.teal : "#fff", 4, C.line);
  if (agreed) text("✓", 800.5, 413, 14, "#fff", 700, "center");
  text("我已阅读并同意网站协作说明", 824, 413, 15, C.ink, 600);
  button(
    revoked ? "协作权限已撤销" : allowed ? "撤销该网站权限" : "允许并继续",
    790,
    448,
    510,
    !allowed,
    agreed && !revoked,
  );
  text(revoked ? "已停止后续协作" : "按当前网站分别管理", 790, 549, 14, C.muted);
}
function quartet(t) {
  browserFrame("另一个已授权页面 · 同页协作演绎");
  scenicVideo(t, 124, 220, 558, 260);
  text("一起看这段。", 143, 530, 26, C.ink, 650);
  text("播放组 A · 你领播 · 三人跟随", 143, 567, 14, C.muted);
  box(724, 200, 598, 392, "#f8f8fa", 18);
  text("一起留下想法", 748, 251, 30, C.ink, 650);
  text("你看这段的节奏。", 748, 308, 24, C.ink, 600);
  text("小林：我们再看一遍。", 748, 355, 18, C.teal);
  text("小梅：这里值得画重点。", 748, 401, 18, "#9353bc");
  text("小周：我也在这一页。", 748, 447, 18, "#9d6518");
  const p = ease((t - 31.6) / 0.65);
  line(748, 321, 748 + 315 * p, 321, C.teal, 3);
  ["你", "林", "梅", "周"].forEach((n, i) =>
    avatar(n, 1070 + i * 48, 139, [C.ink, C.teal, "#9353bc", "#9d6518"][i]),
  );
  text("四个独立设备 · 已授权兼容页面示例", 1310, 573, 12, C.muted, 500, "right");
}
function ending(t) {
  const p = ease((t - 33) / 0.5);
  ctx.save();
  ctx.globalAlpha = p;
  if (logo.complete) ctx.drawImage(logo, 658, 145, 124, 124);
  text("一起看。", 720, 389, 64, C.ink, 700, "center");
  text("也一起做点什么。", 720, 472, 64, C.teal, 700, "center");
  text("syncaction.thomasthzh.top", 720, 558, 28, C.ink, 500, "center");
  text("Chrome / Edge 桌面扩展 · MIT 开源 · 可自行部署", 720, 627, 17, C.muted, 400, "center");
  ctx.restore();
}
const scenes = {
  solo: (t) => watch(t),
  join: (t) => watch(t, true),
  media,
  pages,
  annotations,
  groups,
  invitations,
  recovery,
  onboarding,
  consent,
  quartet,
  end: ending,
};
function drawScene(chapter, t, alpha = 1, entry = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const scale = lerp(0.985, 1, entry);
  ctx.translate(720, 370);
  ctx.scale(scale, scale);
  ctx.translate(-720, -370);
  scenes[chapter.feature](t);
  ctx.restore();
}
function renderFilm(seconds) {
  const t = clamp(Number(seconds) || 0, 0, duration);
  const index = Math.max(
    0,
    chapters.findLastIndex((c) => t >= c.start),
  );
  const chapter = chapters[index],
    local = t - chapter.start;
  const state = motion.sample(t);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#f5f5f7";
  ctx.fillRect(0, 0, 1440, 810);
  if (logo.complete) ctx.drawImage(logo, 55, 37, 38, 38);
  text("SyncAction", 105, 64, 23, C.ink, 650);
  text("功能演绎 · 本地模拟", 1380, 62, 12, C.muted, 500, "right");
  const blend = ease(local / 0.28);
  if (index > 0 && blend < 1) drawScene(chapters[index - 1], chapter.start - 0.001, 1 - blend, 1);
  drawScene(chapter, t, index === 0 ? 1 : blend, chapter.feature === "end" ? 1 : blend);
  // Keep typography continuous too; the old thought leaves as the new one arrives.
  if (index > 0 && blend < 1 && chapters[index - 1].feature !== "end") {
    const previous = chapters[index - 1];
    ctx.save();
    ctx.globalAlpha = 1 - blend;
    text(previous.title, 720, 692 - 12 * blend, 42, C.ink, 650, "center");
    text(previous.sub, 720, 735 - 12 * blend, 16, C.muted, 400, "center");
    ctx.restore();
  }
  if (chapter.feature !== "end") {
    ctx.save();
    ctx.globalAlpha = index === 0 ? 1 : blend;
    text(chapter.title, 720, 692 + (1 - blend) * 12, 42, C.ink, 650, "center");
    text(chapter.sub, 720, 735 + (1 - blend) * 12, 16, C.muted, 400, "center");
    ctx.restore();
  }
  // Pointer coordinates and identities survive every content transition.
  // Labels sit behind every pointer body, so one name never hides another person.
  state.cursors.forEach((pointer) => cursor(pointer, true));
  state.cursors.forEach((pointer) => cursor(pointer));
  box(63, 776, 1314, 2, "#dedee3", 1);
  if (t > 0) box(63, 776, (1314 * t) / duration, 2, C.teal, 1);
  window.filmState = {
    ...state,
    time: t,
    duration,
    chapter: chapter.feature,
    cursorCount: state.cursors.filter((p) => p.visible).length,
    simulation: true,
    transition: blend,
  };
  return window.filmState;
}
window.renderFilm = renderFilm;
window.filmReady = false;
logo.addEventListener("load", () => {
  renderFilm(0);
  window.filmReady = true;
});
logo.src = "/assets/syncaction-symbol-v3.svg";
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
