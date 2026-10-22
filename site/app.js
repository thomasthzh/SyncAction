/* global document, window, navigator, IntersectionObserver */

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const demo = document.querySelector(".experience");
const status = document.querySelector("#demo-status");
const playButton = document.querySelector("#demo-play");
const joinButton = document.querySelector("#demo-join");
const progress = document.querySelector("#demo-progress");
const time = document.querySelector("#demo-time");
const friendState = document.querySelector("#friend-state");
const youState = document.querySelector("#you-state");
const contextLabel = document.querySelector("#context-label");
const contextValue = document.querySelector("#context-value");
const note = document.querySelector("#demo-note");
const markButton = document.querySelector("#demo-mark");
const resetButton = document.querySelector("#demo-reset");
const pageButtons = [...document.querySelectorAll("[data-page]")];
const copyButton = document.querySelector("#copy-server");
const serverAddress = document.querySelector("#server-address");
const copyStatus = document.querySelector("#copy-status");

let activeScene = "watch";
let playing = false;
let joined = false;
let marked = false;
let selectedPage = "课程笔记";
let seconds = 24;
let timer;
let visible = true;

function announce(message) {
  status.textContent = message;
}

function updateContext() {
  contextLabel.textContent =
    activeScene === "watch" ? "本设备状态" : activeScene === "browse" ? "正在查看" : "标记状态";
  if (activeScene === "watch") {
    contextValue.textContent = "你在领播 · 演示";
    youState.textContent = "正在领播 · 演示";
    friendState.textContent = joined ? "已加入跟随 · 演示" : "尚未跟随 · 演示";
  } else if (activeScene === "browse") {
    contextValue.textContent = selectedPage;
    youState.textContent = "正在浏览 · 演示";
    friendState.textContent = "正在看课程笔记 · 演示";
  } else {
    contextValue.textContent = marked ? "重点已标出 · 演示" : "等待你的标记";
    youState.textContent = "同页标记 · 演示";
    friendState.textContent = "正在看同一页 · 演示";
  }
}

function renderProgress() {
  progress.value = String(seconds);
  const formatted = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  time.textContent = `${formatted} / 01:30`;
  progress.setAttribute(
    "aria-valuetext",
    `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒，共 1 分 30 秒`,
  );
}

function renderPlayback() {
  playButton.setAttribute("aria-pressed", String(playing));
  playButton.replaceChildren();
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = playing ? "Ⅱ" : "▷";
  playButton.append(icon, playing ? " 暂停演示" : " 播放演示");
}

function syncClock() {
  window.clearInterval(timer);
  timer = undefined;
  if (!playing || activeScene !== "watch" || !visible || document.hidden) return;
  timer = window.setInterval(() => {
    seconds += 1;
    if (seconds >= 90) {
      seconds = 90;
      playing = false;
      renderPlayback();
      syncClock();
      announce("演示播放结束。可以重新播放，或切换到一起浏览。");
    }
    renderProgress();
  }, 1000);
}

function selectScene(tab, focus = false) {
  activeScene = tab.dataset.scene;
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute("aria-controls");
  if (activeScene !== "watch") {
    playing = false;
    renderPlayback();
  }
  syncClock();
  updateContext();
  if (focus) tab.focus();
  const messages = {
    watch: "试着播放，再让朋友加入。所有操作都只在此页模拟。",
    browse: `当前选择：${selectedPage}。选择页面只更新本地演示，不会打开网站或加入播放组。`,
    mark: marked
      ? "演示标记已显示。可以重置，再试一次。"
      : "试着标出一个重点。此演示不授予任何网站权限。",
  };
  announce(messages[activeScene]);
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectScene(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectScene(tabs[next], true);
  });
});

playButton.addEventListener("click", () => {
  if (seconds >= 90) seconds = 0;
  playing = !playing;
  renderProgress();
  renderPlayback();
  syncClock();
  announce(playing ? "本地演示开始播放；进度只用于示意，没有加载真实视频。" : "本地演示已暂停。");
});

joinButton.addEventListener("click", () => {
  joined = !joined;
  joinButton.setAttribute("aria-pressed", String(joined));
  joinButton.textContent = joined ? "让朋友退出演示" : "让朋友加入演示";
  updateContext();
  announce(
    joined
      ? "模拟小林加入跟随。真实使用时，朋友需要在自己的设备上明确加入播放组。"
      : "模拟小林退出跟随。你仍在原来的演示中。",
  );
});

progress.addEventListener("input", () => {
  seconds = Number(progress.value);
  renderProgress();
});

pageButtons.forEach((button) =>
  button.addEventListener("click", () => {
    selectedPage = button.dataset.page;
    for (const item of pageButtons) item.setAttribute("aria-pressed", String(item === button));
    updateContext();
    announce(
      `你正在查看示例页面“${selectedPage}”，小林仍在课程笔记。只改变查看对象，不自动加入播放组。`,
    );
  }),
);

function renderMark() {
  note.classList.toggle("is-marked", marked);
  markButton.setAttribute("aria-pressed", String(marked));
  markButton.textContent = marked ? "收起这个标记" : "标出这个重点";
  updateContext();
}

markButton.addEventListener("click", () => {
  marked = !marked;
  renderMark();
  announce(
    marked ? "模拟画笔、光标和弹幕已经呈现。真实使用需先完成网站授权。" : "本地演示标记已收起。",
  );
});

resetButton.addEventListener("click", () => {
  marked = false;
  renderMark();
  announce("标记演示已重置，可以重新标出重点。");
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(serverAddress.value);
    copyStatus.textContent = "已复制。到扩展侧栏的“配置服务器”中粘贴。";
  } catch {
    serverAddress.focus();
    serverAddress.select();
    copyStatus.textContent = "请手动复制已选中的地址，再到扩展侧栏粘贴。";
  }
});

document.addEventListener("visibilitychange", syncClock);
window.addEventListener("pagehide", () => window.clearInterval(timer));
window.addEventListener("pageshow", syncClock);
if ("IntersectionObserver" in window) {
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      syncClock();
    },
    { threshold: 0 },
  ).observe(demo);
}

function revealLinkedQuestion() {
  const question = document.querySelector("#privacy-question");
  if (window.location.hash === "#privacy-question") question.open = true;
}
window.addEventListener("hashchange", revealLinkedQuestion);
revealLinkedQuestion();
renderProgress();
