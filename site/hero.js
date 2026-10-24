/* global document, window, navigator, IntersectionObserver */

// One real film. A visitor's playback choice survives scrolling and visibility changes.
(() => {
  const video = document.querySelector("#product-film");
  const controls = document.querySelector("#film-actions");
  const toggle = document.querySelector("#film-toggle");
  const sound = document.querySelector("#film-sound");
  const fullscreen = document.querySelector("#film-fullscreen");
  const status = document.querySelector("#film-play-status");
  const chapters = [...document.querySelectorAll("[data-film-time]")];
  if (!video || !controls || !toggle || !sound || !fullscreen || !status) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const connection = navigator.connection;
  let loaded = false;
  let visible = false;
  let pageActive = true;
  let userChoice = false;
  let wantsPlayback = !reduced.matches && !connection?.saveData;
  let suspending = false;
  let pendingSeek = null;
  let playGeneration = 0;
  controls.hidden = false;
  video.muted = true;
  // Until a source exists Chromium's disabled native controls swallow pointer
  // input. Show the poster with working page controls, then enable native UI.
  video.controls = false;
  video.tabIndex = 0;

  function load() {
    if (loaded) return;
    video.controls = true;
    video.src = video.dataset.src;
    const track = video.querySelector("track");
    if (track) track.src = track.dataset.src;
    loaded = true;
  }
  function syncControls() {
    const playing = !video.paused && !video.ended;
    toggle.querySelector("[data-play-icon]").textContent = playing ? "Ⅱ" : "▷";
    toggle.querySelector("[data-play-label]").textContent = playing ? "暂停" : "播放";
    toggle.setAttribute("aria-label", playing ? "暂停宣传片" : "播放宣传片");
    sound.setAttribute("aria-pressed", String(!video.muted));
    sound.querySelector("[data-sound-label]").textContent = video.muted ? "开启声音" : "关闭声音";
  }
  function suspend() {
    playGeneration += 1;
    suspending = true;
    video.pause();
  }
  async function play(explicit = false) {
    if (!explicit && (!wantsPlayback || !visible || document.hidden || !pageActive)) return;
    load();
    suspending = false;
    const generation = ++playGeneration;
    try {
      await video.play();
      if (generation !== playGeneration) return;
      if (!visible || document.hidden || !pageActive) suspend();
      else status.textContent = "";
    } catch (error) {
      if (generation !== playGeneration || error.name === "AbortError") return;
      status.textContent = "点击播放，观看完整影片。";
    }
  }
  function reconcile() {
    if (!visible || document.hidden || !pageActive || !wantsPlayback) suspend();
    else play();
  }
  function userPlay() {
    userChoice = true;
    wantsPlayback = true;
    play(true);
  }
  // Empty native media controls cannot emit `play`; retain that direct entry point
  // when reduced motion or data saving deliberately deferred source attachment.
  video.addEventListener("click", () => {
    if (!loaded) userPlay();
  });
  video.addEventListener("keydown", (event) => {
    if (!loaded && (event.key === " " || event.key === "Enter")) {
      event.preventDefault();
      userPlay();
    }
  });
  toggle.addEventListener("click", () => {
    userChoice = true;
    if (!video.paused) {
      wantsPlayback = false;
      suspend();
      syncControls();
    } else userPlay();
  });
  sound.addEventListener("click", () => {
    video.muted = !video.muted;
    syncControls();
    if (!video.muted) userPlay();
  });
  fullscreen.addEventListener("click", async () => {
    try {
      if (video.requestFullscreen) await video.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else status.textContent = "请使用播放器中的全屏按钮。";
    } catch {
      status.textContent = "请使用播放器中的全屏按钮。";
    }
  });
  video.addEventListener("play", () => {
    suspending = false;
    if (!wantsPlayback) {
      userChoice = true;
      wantsPlayback = true;
    }
    if (!visible || document.hidden || !pageActive) suspend();
    syncControls();
  });
  video.addEventListener("pause", () => {
    if (!suspending && visible && !document.hidden && pageActive) {
      userChoice = true;
      wantsPlayback = false;
    }
    syncControls();
  });
  video.addEventListener("volumechange", syncControls);
  video.addEventListener("loadedmetadata", () => {
    if (pendingSeek !== null) {
      video.currentTime = Math.min(pendingSeek, video.duration);
      pendingSeek = null;
    }
  });
  video.addEventListener("error", () => {
    status.textContent = "影片暂时无法载入，可以使用页尾的下载链接。";
  });
  chapters.forEach((button) => {
    button.addEventListener("click", () => {
      const seconds = Number(button.dataset.filmTime);
      load();
      if (video.readyState >= 1) video.currentTime = seconds;
      else pendingSeek = seconds;
      video.scrollIntoView({ block: "center", behavior: reduced.matches ? "instant" : "smooth" });
      visible = true;
      userPlay();
    });
  });
  video.addEventListener("timeupdate", () => {
    for (const button of chapters) {
      const active =
        video.currentTime >= Number(button.dataset.filmTime) &&
        video.currentTime < Number(button.dataset.filmEnd);
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  });
  function preferencesChanged() {
    if (!userChoice) {
      wantsPlayback = !reduced.matches && !connection?.saveData;
      reconcile();
    }
  }
  reduced.addEventListener("change", preferencesChanged);
  connection?.addEventListener("change", preferencesChanged);
  document.addEventListener("visibilitychange", reconcile);
  window.addEventListener("pagehide", () => {
    pageActive = false;
    suspend();
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    reconcile();
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting && entry.intersectionRatio >= 0.12;
        reconcile();
      },
      { threshold: 0.12 },
    ).observe(video);
  } else {
    visible = true;
    reconcile();
  }
  syncControls();
})();
