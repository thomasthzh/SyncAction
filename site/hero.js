/* global document, window, navigator, IntersectionObserver, ResizeObserver, MutationObserver */

// A finite illustration. Stable pointer elements stay outside the moving page camera.
(() => {
  const stage = document.querySelector("#hero-stage");
  const camera = document.querySelector("#hero-camera");
  const toggle = document.querySelector("#hero-motion-toggle");
  const replay = document.querySelector("#hero-motion-replay");
  const status = document.querySelector("#hero-motion-status");
  const ids = ["you", "friend", "mei", "zhou"];
  const pointers = ids.map((id) => stage?.querySelector(`[data-hero-pointer="${id}"]`));
  if (!stage || !camera || !toggle || !replay || !status || pointers.some((node) => !node)) return;
  if (pointers.some((node) => typeof node.animate !== "function")) return;
  if (!("IntersectionObserver" in window) || !("ResizeObserver" in window)) return;

  const duration = 5000;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const connection = navigator.connection;
  const filmDialog = document.querySelector("#film-dialog");
  const prefersStatic = () => reduced.matches || Boolean(connection?.saveData);
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const entrances = [0, 1000, 2000, 3000];
  let animations = [];
  let visible = false;
  let pageActive = true;
  let wanted = !prefersStatic();
  let staticMode = !wanted;
  let finished = false;
  let cameraFrame = 0;
  let scrollListening = false;
  let width = 0;
  let height = 0;
  let generation = 0;

  function elapsed() {
    return Number(animations[0]?.currentTime ?? (finished || staticMode ? duration : 0));
  }

  // Coordinates are relative to each CSS final position; entry coordinates use an edge.
  function route(index, anchor) {
    const point = (time, x, y, stop = false) => ({ time, x, y, stop });
    const local = (time, x, y, stop = false) =>
      point(time, anchor.x + x * width, anchor.y + y * height, stop);
    const end = (time) => point(time, anchor.x, anchor.y, true);
    return [
      [
        local(0, 0.12, -0.12, true),
        local(180, 0.12, -0.12, true),
        local(540, 0.21, -0.18),
        local(820, 0.22, -0.15, true),
        local(1450, 0.22, -0.15, true),
        local(1840, 0.12, -0.03),
        local(2190, 0.08, 0.03, true),
        local(3100, 0.08, 0.03, true),
        local(3470, 0.01, -0.03),
        end(3790),
        end(duration),
      ],
      [
        point(0, width + 80, anchor.y + height * 0.04, true),
        point(770, width + 80, anchor.y + height * 0.04, true),
        point(1000, width - 1, anchor.y + height * 0.02),
        local(1420, 0.08, 0.07),
        local(1740, 0.04, 0.08, true),
        local(3050, 0.04, 0.08, true),
        local(3450, -0.02, 0.02),
        end(3810),
        end(duration),
      ],
      [
        point(0, -80, anchor.y + height * 0.08, true),
        point(1780, -80, anchor.y + height * 0.08, true),
        point(2000, 1, anchor.y + height * 0.08),
        local(2420, -0.14, 0.01),
        local(2780, -0.04, -0.04, true),
        local(3490, -0.04, -0.04, true),
        local(3820, 0.01, -0.01),
        end(4130),
        end(duration),
      ],
      [
        point(0, anchor.x - width * 0.06, height + 80, true),
        point(2780, anchor.x - width * 0.06, height + 80, true),
        point(3000, anchor.x - width * 0.06, height - 1),
        local(3410, -0.05, 0.09),
        local(3750, -0.04, 0.03, true),
        local(4170, -0.04, 0.03, true),
        local(4440, 0.01, -0.01),
        end(4770),
        end(duration),
      ],
    ][index];
  }

  function keyframes(points, anchor) {
    const velocities = points.map((point, index) => {
      if (point.stop || !index || index === points.length - 1) return { x: 0, y: 0 };
      const before = points[index - 1];
      const after = points[index + 1];
      const a = point.time - before.time;
      const b = after.time - point.time;
      const incoming = { x: (point.x - before.x) / a, y: (point.y - before.y) / a };
      const outgoing = { x: (after.x - point.x) / b, y: (after.y - point.y) / b };
      const x = (incoming.x * b + outgoing.x * a) / (a + b);
      const y = (incoming.y * b + outgoing.y * a) / (a + b);
      const limit =
        1.6 * Math.min(Math.hypot(incoming.x, incoming.y), Math.hypot(outgoing.x, outgoing.y));
      const factor = Math.min(1, limit / (Math.hypot(x, y) || 1));
      return { x: x * factor, y: y * factor };
    });
    const frames = [];
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      const span = b.time - a.time;
      const count = a.x === b.x && a.y === b.y ? 1 : 6;
      for (let step = index === 1 ? 0 : 1; step <= count; step++) {
        const t = step / count;
        const h1 = 2 * t ** 3 - 3 * t ** 2 + 1;
        const h2 = t ** 3 - 2 * t ** 2 + t;
        const h3 = -2 * t ** 3 + 3 * t ** 2;
        const h4 = t ** 3 - t ** 2;
        const av = velocities[index - 1];
        const bv = velocities[index];
        const x = h1 * a.x + h2 * span * av.x + h3 * b.x + h4 * span * bv.x;
        const y = h1 * a.y + h2 * span * av.y + h3 * b.y + h4 * span * bv.y;
        frames.push({
          offset: (a.time + span * t) / duration,
          transform: `translate3d(${(x - anchor.x).toFixed(2)}px, ${(y - anchor.y).toFixed(2)}px, 0)`,
        });
      }
    }
    return frames;
  }

  function build(time = 0) {
    generation += 1;
    const currentGeneration = generation;
    for (const animation of animations) animation.cancel();
    animations = [];
    width = stage.clientWidth;
    height = stage.clientHeight;
    pointers.forEach((node, index) => {
      const anchor = { x: node.offsetLeft, y: node.offsetTop };
      const animation = node.animate(keyframes(route(index, anchor), anchor), {
        duration,
        fill: "both",
        easing: "linear",
      });
      animation.pause();
      animation.currentTime = time;
      animations.push(animation);
      const name = node.querySelector("[data-hero-name]");
      if (name && index) {
        const opacity = name.animate(
          [
            { offset: 0, opacity: 0 },
            { offset: entrances[index] / duration, opacity: 0 },
            { offset: (entrances[index] + 120) / duration, opacity: 1 },
            { offset: 1, opacity: 1 },
          ],
          { duration, fill: "both" },
        );
        opacity.pause();
        opacity.currentTime = time;
        animations.push(opacity);
      }
    });
    animations[0].addEventListener("finish", () => {
      if (generation !== currentGeneration) return;
      finished = true;
      wanted = false;
      sync("finished");
    });
  }

  function resetCamera() {
    camera.style.setProperty("--hero-camera-scale", "1");
    camera.style.setProperty("--hero-camera-y", "0px");
    camera.style.setProperty("--hero-camera-tilt", "0deg");
  }

  function scheduleCamera() {
    if (cameraFrame || !scrollListening) return;
    cameraFrame = window.requestAnimationFrame(() => {
      cameraFrame = 0;
      if (!scrollListening) return;
      const bounds = stage.getBoundingClientRect();
      const progress = clamp(-bounds.top / Math.max(bounds.height, 1));
      camera.style.setProperty("--hero-camera-scale", String(1 + progress * 0.045));
      camera.style.setProperty("--hero-camera-y", `${(-progress * 24).toFixed(2)}px`);
      camera.style.setProperty("--hero-camera-tilt", `${(progress * -1.6).toFixed(2)}deg`);
    });
  }

  function sync(reason) {
    const available = visible && pageActive && !document.hidden && !filmDialog?.open;
    const running = available && wanted && !staticMode && !finished;
    for (const animation of animations) {
      if (running) animation.play();
      else animation.pause();
    }
    const scrolling = available && !prefersStatic();
    if (scrolling !== scrollListening) {
      scrollListening = scrolling;
      if (scrolling) {
        window.addEventListener("scroll", scheduleCamera, { passive: true });
        window.addEventListener("resize", scheduleCamera, { passive: true });
        scheduleCamera();
      } else {
        window.removeEventListener("scroll", scheduleCamera);
        window.removeEventListener("resize", scheduleCamera);
        window.cancelAnimationFrame(cameraFrame);
        cameraFrame = 0;
      }
    }
    if (prefersStatic()) resetCamera();
    const state = staticMode
      ? "static"
      : finished
        ? "finished"
        : running
          ? "playing"
          : wanted
            ? "suspended"
            : "paused";
    stage.dataset.playbackState = state;
    stage.dataset.playbackIntent = wanted ? "play" : "pause";
    stage.dataset.motionTime = String(Math.round(elapsed()));
    stage.dataset.motionReason = reason;
    toggle.textContent = wanted && !finished ? "暂停演绎" : "播放演绎";
    toggle.setAttribute("aria-pressed", String(wanted && !finished));
    status.textContent =
      state === "finished" || state === "static"
        ? "四个光标，同在一个页面。可播放或重播功能演绎。"
        : state === "playing"
          ? "正在播放一次功能演绎。"
          : state === "suspended"
            ? "演绎已暂缓，返回此区域后继续。"
            : "演绎已暂停。";
  }

  function start(restart) {
    if (restart || staticMode || finished) {
      staticMode = false;
      finished = false;
      build(0);
    }
    wanted = true;
    sync(restart ? "replay" : "play");
  }

  toggle.addEventListener("click", () => {
    if (wanted && !finished) {
      wanted = false;
      sync("user-pause");
    } else start(false);
  });
  replay.addEventListener("click", () => start(true));

  function preferenceChanged() {
    if (prefersStatic()) wanted = false;
    sync("preference");
  }
  reduced.addEventListener("change", preferenceChanged);
  connection?.addEventListener("change", preferenceChanged);
  document.addEventListener("visibilitychange", () => sync("visibility"));
  const intersection = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      sync("intersection");
    },
    { threshold: 0 },
  );
  const resize = new ResizeObserver(() => {
    if (animations.length && (width !== stage.clientWidth || height !== stage.clientHeight)) {
      const time = Math.min(duration, elapsed());
      build(time);
      sync("resize");
    }
    scheduleCamera();
  });
  intersection.observe(stage);
  resize.observe(stage);
  if (filmDialog)
    new MutationObserver(() => sync("film-dialog")).observe(filmDialog, {
      attributes: true,
      attributeFilter: ["open"],
    });
  window.addEventListener("pagehide", () => {
    pageActive = false;
    visible = false;
    intersection.disconnect();
    resize.disconnect();
    sync("pagehide");
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    intersection.observe(stage);
    resize.observe(stage);
    sync("pageshow");
  });

  if (!staticMode) build();
  toggle.hidden = false;
  replay.hidden = false;
  sync("ready");
})();
