/* global document, window, Image, URLSearchParams, performance */

const canvas = document.querySelector("#film");
const ctx = canvas.getContext("2d", { alpha: false });
const logo = new Image();
const C = {
  ink: "#17384c",
  muted: "#5c7383",
  teal: "#087f8c",
  purple: "#7462d5",
  light: "#edf5f8",
  line: "#d7e5eb",
};
const font = '"Segoe UI", "Microsoft YaHei", sans-serif';
const chapters = [
  { start: 0, title: "一个人的网页。", sub: "视频在播放，想法在发生。", feature: "solo" },
  {
    start: 3,
    title: "第二个光标。共同的此刻。",
    sub: "同页已授权，朋友明确加入播放组，再开始一起看。",
    feature: "join",
  },
  {
    start: 7,
    title: "你播放，我跟上。",
    sub: "播放、暂停、调整进度；持续跟随与对齐一次，各有明确动作。",
    feature: "media",
  },
  {
    start: 11,
    title: "好东西，放在一起看。",
    sub: "分享当前页，认出同伴的位置，再打开对应页面。",
    feature: "pages",
  },
  {
    start: 15,
    title: "指向它。说出来。画重点。",
    sub: "同页光标、弹幕、画笔，把讨论放回内容里。",
    feature: "annotations",
  },
  {
    start: 19,
    title: "同一个房间，不止一种节奏。",
    sub: "查看另一播放组，仍留在自己的协作中；查看不等于加入。",
    feature: "groups",
  },
  {
    start: 23,
    title: "邀请与申请，都有清楚的下一步。",
    sub: "邀请由接收者接受；需要审批的加入申请，由房主确认。",
    feature: "invitations",
  },
  {
    start: 27,
    title: "偶尔断开，也知道怎样继续。",
    sub: "就近重新连接，重新读取房间快照；连接和跟随，分别说明。",
    feature: "recovery",
  },
  {
    start: 31,
    title: "第一次，也能走得清楚。",
    sub: "配置服务器、登录或待批准；批准后登录，继续原来的入房目标。",
    feature: "onboarding",
  },
  {
    start: 35,
    title: "靠近一点，授权由你决定。",
    sub: "先阅读并同意网站说明，再允许协作；网站权限随时可撤销。",
    feature: "consent",
  },
  {
    start: 39,
    title: "熟悉的浏览器。自己的选择。",
    sub: "Chrome / Edge 桌面扩展，开源，可自行部署服务器。",
    feature: "open",
  },
  { start: 43, title: "一起看。也一起做点什么。", sub: "SyncAction", feature: "end" },
];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (v) => {
  const x = clamp(v);
  return x * x * (3 - 2 * x);
};
const lerp = (a, b, t) => a + (b - a) * t;
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
function pill(value, x, y, w, color = C.teal, fill = "#e5f3f2") {
  box(x, y, w, 29, fill, 7);
  text(value, x + w / 2, y + 20, 12, color, 600, "center");
}
function button(value, x, y, w = 150, primary = true, active = false) {
  box(
    x,
    y,
    w,
    40,
    primary ? (active ? "#075a65" : C.teal) : "#fff",
    9,
    primary ? undefined : C.line,
  );
  text(value, x + w / 2, y + 26, 14, primary ? "#fff" : C.ink, 600, "center");
}
function avatar(name, x, y, color = C.teal) {
  box(x, y, 34, 34, color === C.teal ? "#d6ecef" : "#e9e4f7", 10);
  text(name, x + 17, y + 23, 14, color, 650, "center");
}
function cursor(x, y, color, name, scale = 1, opacity = 1, click = false) {
  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.shadowColor = "#061b3c35";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 30);
  ctx.lineTo(8, 22);
  ctx.lineTo(15, 36);
  ctx.lineTo(22, 32);
  ctx.lineTo(15, 19);
  ctx.lineTo(28, 18);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.5;
  ctx.fill();
  ctx.stroke();
  ctx.shadowColor = "transparent";
  box(21, 32, Math.max(48, name.length * 13 + 20), 26, color, 6);
  text(name, 31, 50, 12, "#fff", 600);
  if (click) {
    ctx.beginPath();
    ctx.arc(4, 5, 28, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.restore();
}
function move(points, time, duration = 4) {
  const position = clamp(time / duration) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(position));
  const amount = ease(position - index);
  return {
    x: lerp(points[index][0], points[index + 1][0], amount),
    y: lerp(points[index][1], points[index + 1][1], amount),
  };
}
function strokePath(points, color, width = 4, progress = 1) {
  ctx.save();
  ctx.beginPath();
  const segments = Math.max(1, Math.floor((points.length - 1) * clamp(progress)));
  ctx.moveTo(...points[0]);
  for (let i = 1; i <= segments; i++) ctx.lineTo(...points[i]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
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
function chrome(title = "周末，留一点时间给彼此") {
  ctx.save();
  ctx.shadowColor = "#00000025";
  ctx.shadowBlur = 45;
  ctx.shadowOffsetY = 16;
  box(92, 120, 1256, 500, "#fff", 18);
  ctx.restore();
  box(92, 120, 1256, 50, "#e8eff4", 18);
  box(92, 151, 1256, 20, "#e8eff4", 0);
  ["#e9aaa0", "#d9c480", "#93bfa7"].forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(114 + i * 15, 145, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  box(210, 131, 830, 28, "#fff", 7);
  text("◇  " + title, 229, 151, 12, C.muted);
  text("＋", 1316, 153, 23, C.muted);
  line(1028, 187, 1028, 605);
  text("SyncAction", 1052, 200, 15, C.ink, 700);
  pill("示例房间", 1220, 182, 104);
}
function side(joined = true, mode = "watch", solo = false, joining = false) {
  text("周末小聚", 1052, 238, 22, C.ink, 700);
  text("房间已同步 · 演示", 1052, 262, 12, C.muted);
  avatar("你", 1052, 286);
  text("你", 1098, 303, 15, C.ink, 600);
  text(mode === "watch" ? "本设备领播" : "正在查看", 1098, 323, 11, C.muted);
  avatar("林", 1052, 340, C.purple);
  text(solo ? "等待同伴" : "小林", 1098, 357, 15, C.ink, 600);
  text(
    solo ? "来到同页，再一起开始" : joined ? "已加入跟随 · 演示" : "同页已授权 · 尚未跟随",
    1098,
    377,
    11,
    C.muted,
  );
  line(1052, 405, 1322, 405);
  text("本设备状态", 1052, 434, 11, C.muted);
  text(mode === "watch" ? "你在领播" : "查看不改变跟随关系", 1052, 461, 16, C.ink, 650);
  if (joining && !joined) {
    pill("小林的设备 · 示例", 1052, 488, 268, C.purple, "#e9e4f7");
    button("加入播放组", 1052, 532, 268);
  } else {
    pill("网站协作已授权", 1052, 491, 165);
    text(solo ? "等待朋友来到同页" : "小林已明确加入跟随", 1052, 550, 12, C.muted);
  }
}
function watch(t, joined = true, local = 0, media = false) {
  chrome();
  const paused = media && local >= 1.3;
  scenicVideo(paused ? (local >= 2.25 ? 63 : 8.3) : t);
  text("周末，留一点时间给彼此", 142, 535, 22, C.ink, 650);
  const position = media
    ? local < 1.3
      ? 0.3
      : local < 2.25
        ? 0.3
        : lerp(0.3, 0.7, ease((local - 2.25) / 0.6))
    : 0.27 + (t % 5) * 0.014;
  box(142, 559, 705, 5, "#e1eaf0", 3);
  box(142, 559, 705 * position, 5, C.teal, 3);
  ctx.beginPath();
  ctx.arc(142 + 705 * position, 561, 6, 0, Math.PI * 2);
  ctx.fillStyle = C.teal;
  ctx.fill();
  text(paused ? "Ⅱ 已暂停" : "▷ 正在播放", 142, 593, 12, C.muted);
  text(
    media && local > 2.25 ? "01:03 / 01:30" : "00:24 / 01:30",
    994,
    593,
    12,
    C.muted,
    500,
    "right",
  );
  side(joined, "watch", t < 3, t >= 3 && t < 7);
  if (media) {
    pill(
      local >= 2.25 ? "暂停中 · 进度已对齐" : local >= 1.3 ? "暂停已同步" : "持续跟随中",
      681,
      234,
      290,
      "#fff",
      "#126c79db",
    );
    button("对齐一次", 1052, 551, 124, false);
  }
}
function workflowSide(heading, state, lines) {
  box(1040, 214, 289, 383, "#fff", 0);
  text(heading, 1052, 248, 21, C.ink, 700);
  pill(state, 1052, 282, 268);
  lines.forEach((value, index) => text(value, 1052, 356 + index * 35, 14, C.muted));
  text("功能分镜 · 示例状态", 1052, 558, 12, C.muted);
}
function documentPage(t, annotation = false, local = 0, authorized = true) {
  chrome(authorized ? "课程笔记 · 我们的共享页面" : "新网站 · 协作许可示例");
  box(140, 213, 854, 378, "#f5f2eb", 12);
  text("一起读 / NOTES", 179, 253, 13, "#58766f", 650);
  text("好想法，值得一起停留。", 179, 309, 37, C.ink, 650);
  text("少一点“第三段第二行”，", 179, 363, 24, "#506b71");
  text("多一点“你看这里”。", 179, 404, 24, "#506b71");
  text("把重要的内容看清楚，让讨论自然地继续。", 179, 459, 18, C.muted);
  text(authorized ? "页面内容兼容 · 协作已授权" : "该网站协作尚未启用", 179, 557, 12, "#3f7d74");
  if (authorized) side(true, "browse");
  else workflowSide("网站协作", "尚未启用", ["按当前网站决定权限", "先了解，再允许"]);
  if (annotation) {
    const drawn = ease((local - 1.1) / 0.8);
    const pts = Array.from({ length: 50 }, (_, i) => [179 + i * 6.1, 415 + Math.sin(i * 0.12) * 3]);
    if (drawn > 0) strokePath(pts, C.teal, 4, drawn);
    if (local > 1.9) {
      ctx.save();
      ctx.globalAlpha = ease((local - 1.9) / 0.3);
      box(660, 254, 274, 49, "#fff", 12);
      text("小林  这句说得真好！", 681, 286, 16, C.purple, 600);
      ctx.restore();
    }
    if (local > 2.6) {
      pill("光标 · 弹幕 · 画笔", 645, 526, 300);
    }
  }
}
function pages(t, local) {
  chrome("共享页面 · 认出彼此的位置");
  text("我们的共享页面", 142, 229, 30, C.ink, 700);
  const chosen = local > 2;
  const rows = ["课程笔记", "周末片单", "灵感收集"];
  rows.forEach((name, i) => {
    const yy = 259 + i * 86;
    box(142, yy, 852, 70, i === (chosen ? 1 : 0) ? "#e6f3f3" : "#f4f7fa", 10);
    text("0" + (i + 1), 164, yy + 43, 15, C.muted);
    text(name, 219, yy + 32, 19, C.ink, 650);
    text(
      i === 0 ? "小林正在这里 · 演示" : i === 1 && chosen ? "你正在查看 · 演示" : "共享页面",
      219,
      yy + 54,
      11,
      C.muted,
    );
    text("↗", 956, yy + 45, 25, C.teal);
  });
  button(local < 1 ? "分享当前页" : "当前页已分享", 142, 545, 200, local < 1);
  text("选择页面只打开目标，不会自动加入播放组。", 371, 571, 14, C.muted);
  side(true, "browse");
}
function groups(t, local) {
  chrome("同房多播放组 · 各自的节奏");
  text("同一个房间，两段播放", 142, 232, 29, C.ink, 700);
  const selecting = local > 1.5;
  [
    ["播放组 A", "你正在领播 · 我的播放组", "周末短片"],
    ["播放组 B", "仅查看 · 尚未加入", "课程回放"],
  ].forEach(([name, scope, title], i) => {
    const x = 142 + i * 437;
    box(
      x,
      263,
      415,
      242,
      i === 1 && selecting ? "#e9e7f6" : "#f0f6f8",
      13,
      i === 1 && selecting ? "#b8ace6" : C.line,
    );
    pill(name, x + 20, 283, 95, i ? C.purple : C.teal, i ? "#e0daf3" : "#d9edec");
    text(title, x + 20, 363, 29, C.ink, 650);
    text(scope, x + 20, 400, 15, i ? C.purple : C.teal, 600);
    button(i ? "查看这个组" : "返回我的播放组", x + 20, 438, 240, i === 1, selecting && i === 1);
  });
  pill(selecting ? "正在查看 B · 本人仍在 A" : "本设备仍在播放组 A", 142, 542, 852);
  side(true);
}
function invitations(t, local) {
  const request = local >= 2;
  chrome(request ? "房主的消息中心 · 独立设备示例" : "小林的消息中心 · 独立设备示例");
  box(142, 212, 852, 380, "#f1f6f9", 12);
  text("消息中心", 174, 258, 31, C.ink, 700);
  pill(request ? "房主处理申请" : "接收者处理邀请", 736, 232, 224);
  text(request ? "小周申请加入另一个房间" : "小林收到“周末小聚”的邀请", 176, 337, 28, C.ink, 650);
  text(
    request ? "加入申请和邀请，是两条独立的路径。" : "邀请被接受前，不会自动把朋友带入房间。",
    176,
    381,
    18,
    C.muted,
  );
  button(
    request
      ? local > 3.1
        ? "房主已同意"
        : "房主同意加入"
      : local > 1.1
        ? "小林已接受邀请"
        : "接受邀请",
    176,
    432,
    250,
  );
  if (local > 1.1 && !request) pill("由小林确认，进入目标房间", 453, 437, 440);
  if (local > 3.1) pill("房主确认后再入房", 453, 437, 440);
  text("示例账号 / 示例房间 · 未发送真实邀请或申请", 176, 558, 12, C.muted);
  workflowSide(
    request ? "房主处理申请" : "小林处理邀请",
    request
      ? local > 3.1
        ? "房主已批准"
        : "申请待处理"
      : local > 1.1
        ? "本人已接受"
        : "邀请待接受",
    [request ? "另一房间的独立申请" : "由接收者本人确认", "不自动接受或批准"],
  );
}
function recovery(t, local) {
  watch(t, true);
  const restored = local > 2.8;
  box(347, 297, 470, 182, "#fff", 16, C.line);
  pill(
    restored ? "房间已同步" : local > 1.6 ? "正在重新读取房间快照" : "房间同步已断开",
    370,
    318,
    424,
    restored ? C.teal : C.ink,
    restored ? "#e4f3f0" : "#edf2f6",
  );
  text(
    restored ? "已提交的房间信息回来了。" : "保留当前页面，就近继续。",
    376,
    389,
    22,
    C.ink,
    650,
  );
  button(
    restored ? "房间信息已恢复" : local > 1.6 ? "正在恢复连接" : "重新连接",
    376,
    414,
    413,
    true,
    local > 1.6 && !restored,
  );
  workflowSide("连接与恢复", restored ? "房间已同步" : "房间状态待更新", [
    "服务连接单独检测",
    "媒体跟随单独呈现",
  ]);
}
function onboarding(t, local) {
  chrome("第一次使用 · 继续原来的入房目标");
  box(142, 212, 852, 380, "#eff5f8", 12);
  const phase = local < 1 ? 0 : local < 2.7 ? 1 : 2;
  ["配置服务器", "登录 / 等待批准", "继续入房"].forEach((name, i) => {
    pill(
      name,
      175 + i * 269,
      235,
      245,
      i === phase ? "#fff" : C.muted,
      i === phase ? C.teal : "#e0eaf0",
    );
  });
  if (phase === 0) {
    text("连接实际的公共服务器", 176, 333, 28, C.ink, 650);
    box(176, 363, 782, 54, "#fff", 9, C.line);
    text("https://syncaction.thomasthzh.top:58443", 194, 397, 22, C.ink);
    button("验证并连接", 176, 451, 782);
  } else if (phase === 1) {
    text(local < 1.9 ? "账号待批准" : "管理员批准后", 176, 337, 30, C.ink, 650);
    text("审批由服务器管理员完成。", 176, 379, 18, C.muted);
    button("批准后登录", 176, 429, 782, local >= 1.9);
  } else {
    text("继续刚才的入房目标", 176, 335, 31, C.ink, 650);
    text("不用再找一次房间。上下文改变时，重新确认。", 176, 382, 19, C.muted);
    pill("目标：周末小聚 · 示例房间", 176, 428, 782);
  }
  text("先完成对应操作，再继续；此处仅作分镜演绎。", 176, 557, 12, C.muted);
  workflowSide(
    "首次使用",
    phase === 2
      ? "登录完成 · 继续目标"
      : phase === 0
        ? "未登录 · 尚未入房"
        : local < 1.9
          ? "账号待管理员批准"
          : "已批准 · 等待本人登录",
    ["审批按服务器规则进行", "本人点击批准后登录"],
  );
}
function consent(t, local) {
  const agreed = local > 1.5,
    allowed = local > 2.4,
    revoked = local > 3.35;
  documentPage(t, false, 0, allowed && !revoked);
  workflowSide(
    "当前网站的许可",
    revoked ? "协作权限已撤销" : allowed ? "已完成授权 · 示例" : "尚未启用协作",
    ["权限按网站分别管理", revoked ? "停止后续对应协作" : "本人阅读并明确允许"],
  );
  box(318, 204, 587, 384, "#fff", 15, C.line);
  text("允许后，继续当前网站的协作", 345, 251, 25, C.ink, 700);
  text("网站范围：当前示例网站", 345, 282, 14, C.muted);
  line(345, 304, 877, 304);
  text("共享：兼容性摘要、位置、媒体状态、弹幕和画笔", 345, 338, 15, C.ink);
  text("不发送：Cookie、密码、表单文字、网页正文或视频流", 345, 370, 14, C.muted);
  box(345, 397, 21, 21, agreed ? C.teal : "#fff", 4, C.line);
  if (agreed) text("✓", 355, 413, 14, "#fff", 700, "center");
  text("我已阅读并同意当前网站的协作说明", 379, 413, 15, C.ink, 600);
  button(
    revoked ? "该网站协作权限已撤销" : allowed ? "撤销该网站权限" : "允许并继续",
    345,
    448,
    531,
    !allowed,
    agreed && !allowed,
  );
  text(
    revoked ? "已分享页面与消息不会因此自动删除。" : "还可能需要浏览器另行允许网站权限。",
    345,
    540,
    13,
    C.muted,
  );
}
function openSource(t, local) {
  chrome("开源 · Chrome / Edge 桌面扩展");
  box(142, 213, 852, 378, "#eaf3f5", 12);
  text("你的浏览器，你的选择。", 180, 291, 38, C.ink, 700);
  [
    ["C", "Chrome 扩展"],
    ["E", "Edge 扩展"],
  ].forEach(([symbol, name], i) => {
    const x = 180 + i * 394;
    box(x, 324, 365, 113, "#fff", 13, C.line);
    avatar(symbol, x + 20, 355, i ? C.purple : C.teal);
    text(name, x + 70, 373, 23, C.ink, 650);
    text("ZIP 下载 · 解压加载", x + 70, 403, 13, C.muted);
  });
  pill("MIT 开源", 180, 476, 168);
  pill("可自行部署服务端", 366, 476, 270);
  text("更新时覆盖原文件夹，再重新加载，保留扩展身份。", 180, 561, 14, C.muted);
  side(true, "browse");
  if (local > 2) pill("源码与部署指南，在公开仓库中", 658, 476, 300, C.purple, "#e8e3f8");
}
function ending(t) {
  const p = ease((t - 43) / 0.7);
  ctx.save();
  ctx.globalAlpha = p;
  if (logo.complete) ctx.drawImage(logo, 660, 144, 120, 120);
  text("一起看。", 720, 365, 66, "#eff8fb", 750, "center");
  text("也一起做点什么。", 720, 455, 66, "#93d8d3", 750, "center");
  text("syncaction.thomasthzh.top", 720, 540, 31, "#f3f9fc", 550, "center");
  text(
    "Chrome / Edge 桌面扩展 · 开源，可自行部署 · v0.9.12",
    720,
    593,
    18,
    "#b4cedb",
    400,
    "center",
  );
  ctx.restore();
  cursor(482, 516, C.teal, "你", 1, p);
  cursor(971, 518, C.purple, "朋友", 1, p);
}

function renderFilm(seconds) {
  const t = clamp(Number(seconds) || 0, 0, 47);
  const chapterIndex = Math.max(
    0,
    chapters.findLastIndex((c) => t >= c.start),
  );
  const chapter = chapters[chapterIndex],
    local = t - chapter.start;
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, 1440, 810);
  const bg = ctx.createLinearGradient(0, 0, 1440, 810);
  bg.addColorStop(0, "#0c263c");
  bg.addColorStop(1, "#071b2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1440, 810);
  const halo = ctx.createRadialGradient(1080, 260, 20, 1080, 260, 750);
  halo.addColorStop(0, "#257f8525");
  halo.addColorStop(1, "#257f8500");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 1440, 810);
  if (logo.complete) ctx.drawImage(logo, 55, 37, 38, 38);
  text("SyncAction", 105, 64, 23, "#eff8fb", 700);
  text("产品功能演绎 · 本地模拟画面", 1380, 62, 13, "#a4c1d0", 500, "right");
  let cursorCount = 0;
  if (chapter.feature === "end") ending(t);
  else {
    const effect = ease(local / 0.42);
    ctx.save();
    ctx.translate(0, ["solo", "join", "media"].includes(chapter.feature) ? 0 : (1 - effect) * 12);
    ctx.globalAlpha = 1;
    if (["solo", "join", "media"].includes(chapter.feature))
      watch(
        t,
        chapter.feature !== "solo" && (chapter.feature !== "join" || local > 1.25),
        local,
        chapter.feature === "media",
      );
    else if (chapter.feature === "pages") pages(t, local);
    else if (chapter.feature === "annotations") documentPage(t, true, local);
    else if (chapter.feature === "groups") groups(t, local);
    else if (chapter.feature === "invitations") invitations(t, local);
    else if (chapter.feature === "recovery") recovery(t, local);
    else if (chapter.feature === "onboarding") onboarding(t, local);
    else if (chapter.feature === "consent") consent(t, local);
    else if (chapter.feature === "open") openSource(t, local);
    ctx.restore();
    let a = move(
      [
        [330, 303],
        [755, 298],
        [653, 452],
        [336, 535],
      ],
      local,
      chapter.feature === "solo" ? 3 : 4,
    );
    let b = move(
      [
        [1380, 259],
        [1163, 509],
        [780, 378],
        [717, 410],
      ],
      local,
      4,
    );
    let clickA = false,
      clickB = false;
    if (chapter.feature === "join") {
      a = move(
        [
          [376, 368],
          [470, 440],
          [460, 397],
        ],
        local,
      );
      b = move(
        [
          [1400, 300],
          [1180, 548],
          [750, 393],
        ],
        local,
        2.2,
      );
      clickB = local > 1 && local < 1.4;
    }
    if (chapter.feature === "media") {
      a = move(
        [
          [228, 584],
          [226, 584],
          [636, 558],
          [748, 558],
        ],
        local,
      );
      b = { x: a.x + 48, y: a.y - 60 };
      clickA = local > 1.2 && local < 1.5;
    }
    if (chapter.feature === "pages")
      a = move(
        [
          [260, 566],
          [280, 300],
          [904, 383],
          [853, 393],
        ],
        local,
      );
    if (chapter.feature === "annotations") {
      a = move(
        [
          [190, 400],
          [320, 410],
          [470, 411],
          [530, 422],
        ],
        local,
      );
      b = move(
        [
          [836, 303],
          [782, 375],
          [701, 458],
        ],
        local,
      );
    }
    if (chapter.feature === "groups") {
      a = move(
        [
          [300, 458],
          [745, 461],
          [737, 462],
        ],
        local,
      );
      b = { x: 441, y: 385 };
      clickA = local > 1.45 && local < 1.75;
    }
    if (chapter.feature === "invitations") {
      a = move(
        [
          [300, 470],
          [300, 470],
          [331, 450],
          [331, 450],
        ],
        local,
      );
      b = move(
        [
          [761, 390],
          [292, 450],
          [768, 384],
        ],
        local,
      );
      clickB = local > 1 && local < 1.3;
      if (local > 0.9 && local < 1.4) b = { x: 292, y: 450 };
      clickA = local > 3 && local < 3.3;
    }
    if (chapter.feature === "recovery") {
      a = { x: 609, y: 436 };
      b = { x: 840, y: 453 };
      clickA = local > 1.45 && local < 1.75;
    }
    if (chapter.feature === "onboarding") {
      a = move(
        [
          [550, 472],
          [567, 454],
          [579, 451],
          [623, 448],
        ],
        local,
      );
      b = { x: 948, y: 526 };
      clickA = local > 2.4 && local < 2.7;
    }
    if (chapter.feature === "consent") {
      a = move(
        [
          [510, 362],
          [357, 408],
          [630, 470],
          [634, 469],
        ],
        local,
      );
      b = { x: 947, y: 512 };
      clickA =
        (local > 1.45 && local < 1.7) ||
        (local > 2.3 && local < 2.6) ||
        (local > 3.25 && local < 3.5);
      if (local > 1.4 && local < 1.7) a = { x: 355, y: 408 };
    }
    const receiverDevice = chapter.feature === "invitations" && local < 2;
    if (receiverDevice) cursor(b.x, b.y, C.purple, "小林", 0.95, 1, clickB);
    else cursor(a.x, a.y, C.teal, "你", 0.95, 1, clickA);
    cursorCount = 1;
    const remoteAllowed =
      chapter.feature !== "onboarding" &&
      chapter.feature !== "invitations" &&
      (chapter.feature !== "recovery" || local > 2.8) &&
      (chapter.feature !== "consent" || (local > 2.4 && local <= 3.35));
    if (t >= 3 && remoteAllowed) {
      const opacity = ease((t - 3) / 0.25);
      cursor(b.x, b.y, C.purple, "小林", 0.95, opacity, clickB);
      cursorCount = 2;
    }
    if (t >= 3 && t < 3.65) {
      const p = (t - 3) / 0.65;
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.65;
      ctx.beginPath();
      ctx.arc(1190, 320, 35 + p * 135, 0, Math.PI * 2);
      ctx.strokeStyle = "#a4a1ff";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = effect;
    text(chapter.title, 62, 695, 39, "#eff8fb", 700);
    text(chapter.sub, 64, 735, 17, "#adc7d5", 400);
    ctx.restore();
  }
  if (chapter.feature === "end") cursorCount = 2;
  const progress = clamp(t / 47);
  box(63, 776, 1314, 3, "#ffffff18", 2);
  box(63, 776, 1314 * progress, 3, "#93d8d3", 2);
  window.filmState = {
    time: t,
    chapter: chapter.feature,
    cursorCount,
    duration: 47,
    simulation: true,
    friendJoined: chapter.feature === "join" ? local > 1.25 : t >= 7,
    viewingOtherGroup: chapter.feature === "groups" && local > 1.5,
  };
  return window.filmState;
}

window.renderFilm = renderFilm;
window.filmReady = false;
logo.addEventListener("load", () => {
  renderFilm(0);
  window.filmReady = true;
});
logo.src = "/assets/syncaction-symbol.svg";
if (new URLSearchParams(window.location.search).has("render"))
  document.body.classList.add("is-rendering");
const previewButton = document.querySelector("#film-preview");
let started = 0,
  frame,
  playing = false;
function tick(now) {
  const seconds = (now - started) / 1000;
  renderFilm(Math.min(47, seconds));
  if (seconds < 47 && playing) frame = window.requestAnimationFrame(tick);
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
