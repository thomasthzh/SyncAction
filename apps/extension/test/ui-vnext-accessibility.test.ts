// @vitest-environment happy-dom

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { h } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { TestUiStore, renderPanel, unmountPanel } from "./ui-vnext-test-harness.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vnextRoot = resolve(extensionRoot, "src/ui-vnext");
const iconsPath = resolve(vnextRoot, "icons.tsx");
const stylesPath = resolve(vnextRoot, "styles.css");
const sidepanelStylesPath = resolve(extensionRoot, "entrypoints/sidepanel/style.css");
const sidepanelBackgroundPath = resolve(extensionRoot, "public/sidepanel-background.svg");
const expectedIconNames = [
  "logo",
  "chevron",
  "users",
  "message",
  "server",
  "share",
  "play",
  "sync",
  "danmaku",
  "pen",
  "invite",
  "leave",
  "transfer",
  "trash",
  "close",
] as const;

afterEach(() => unmountPanel());

describe("vNext accessibility and visual-system contract", () => {
  it("publishes the complete locally owned icon set", () => {
    expect(existsSync(iconsPath)).toBe(true);
    const source = readIfPresent(iconsPath);
    for (const name of expectedIconNames) {
      expect(source).toContain(`"${name}"`);
    }
    expect(source).toContain('viewBox="0 0 24 24"');
    expect(source).toContain('stroke="currentColor"');
    expect(source).toContain('strokeLinecap="round"');
    expect(source).toContain('strokeLinejoin="round"');
    expect(source).toContain('data-brand-source="design/brand/syncaction-symbol.svg"');
    expect(source).not.toMatch(/<(?:text|foreignObject|script)\b|https?:\/\//iu);
  });

  it("gives every icon-only control an accessible name and removes product glyphs", () => {
    const source = readVnextSource();
    const buttonBlocks = source.match(/<button\b[\s\S]*?<\/button>/gu) ?? [];
    const iconButtons = buttonBlocks.filter((block) =>
      /class=["'][^"']*(?:icon-button|dock-tool__button)[^"']*["']/u.test(block),
    );
    expect(iconButtons.length).toBeGreaterThanOrEqual(8);
    for (const button of iconButtons) {
      expect(button).toMatch(/\baria-label=/u);
      expect(button).toMatch(/\btitle=/u);
    }
    expect(source).not.toMatch(/[↗✎⌄◌‹›×＋−✓♢↑◆]/u);

    const root = renderPanel(h(App, { store: new TestUiStore() }));
    for (const button of root.querySelectorAll("button")) {
      if (button.textContent?.trim() === "") {
        expect(button.getAttribute("aria-label")?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every interactive target at least 44px and uses visible keyboard focus", () => {
    const styles = readIfPresent(stylesPath);
    expect(styles).toMatch(
      /button,\s*input,\s*select,\s*textarea\s*\{[\s\S]*?min-block-size:\s*44px/iu,
    );
    expect(styles).toContain(":focus-visible");
    expect(styles).not.toMatch(/:focus(?!-(?:visible|within))\b/u);
    expect(styles).toMatch(/\.server-button\s*\{[^}]*min-height:\s*44px/iu);
    expect(styles).toMatch(/\.compact-button\s*\{[^}]*min-height:\s*44px/iu);
    expect(styles).toMatch(
      /\.shared-tab-row \.member-avatar\s*\{[^}]*min-inline-size:\s*44px[^}]*min-block-size:\s*44px/iu,
    );
  });

  it("ships only local visual assets and no remote font or stylesheet dependency", () => {
    const source = `${readVnextSource()}\n${readIfPresent(stylesPath)}\n${readIfPresent(
      sidepanelStylesPath,
    )}`;
    expect(source).not.toMatch(
      /@font-face|@import\s+url|url\(\s*["']?https?:|src\s*=\s*["']https?:/iu,
    );
  });

  it("uses the editorial glass token system with no row-level blur", () => {
    const styles = readIfPresent(stylesPath);
    for (const declaration of [
      "color-scheme: light",
      "--sa-bg: #f7f4ee",
      "--sa-paper: #fffdf9",
      "--sa-navy: #0a2240",
      "--sa-ink: #303842",
      "--sa-muted: #68717c",
      "--sa-champagne: #b68a45",
      "--sa-blue-gray: #dfe6ec",
      "--sa-glass: rgb(255 253 249 / 72%)",
      "--sa-line: rgb(10 34 64 / 13%)",
      "--sa-danger: #c93434",
      "--sa-radius-card: 18px",
      "--sa-radius-control: 12px",
      "--sa-ease: cubic-bezier(0.22, 1, 0.36, 1)",
    ]) {
      expect(styles).toContain(declaration);
    }
    expect(styles).not.toMatch(
      /(?:shared-tab-row|message-card|member-row|directory-row)[^{]*\{[^}]*backdrop-filter/iu,
    );
    expect(styles).not.toMatch(
      /transition(?:-property)?:[^;]*(?:width|height|inset|margin|padding)/iu,
    );
  });

  it("removes motion and transparency when the operating system requests it", () => {
    const styles = readIfPresent(stylesPath);
    const reducedMotion = mediaBlock(styles, "prefers-reduced-motion: reduce");
    expect(reducedMotion).toContain("transition: none !important");
    expect(reducedMotion).toContain("animation: none !important");
    expect(reducedMotion).toContain("transform: none !important");

    const reducedTransparency = mediaBlock(styles, "prefers-reduced-transparency: reduce");
    expect(reducedTransparency).toContain("backdrop-filter: none");
    expect(reducedTransparency).toContain("var(--sa-paper)");
    expect(reducedTransparency).toContain("background-image: none");
    expect(reducedTransparency).toContain("background-color: var(--sa-paper)");
    expect(mediaBlock(styles, "forced-colors: active")).toContain("CanvasText");
  });

  it("contains the 320px panel and never relies on danger color alone", () => {
    const styles = readIfPresent(stylesPath);
    expect(styles).toMatch(/body\s*\{[\s\S]*?width:\s*100%/iu);
    expect(styles).toContain("--sa-panel-max: 480px");
    expect(styles).toMatch(
      /\.syncaction-app\s*\{[\s\S]*?inline-size:\s*min\(100%,\s*var\(--sa-panel-max\)\)[\s\S]*?min-block-size:\s*100dvh/iu,
    );
    expect(styles).toMatch(/\.syncaction-app\s*\{[\s\S]*?margin-inline:\s*auto/iu);
    expect(styles).toContain("overflow-x: clip");
    expect(styles).toContain("@media (max-width: 359px)");
    expect(styles).not.toContain("@media (max-width: 360px)");
    expect(styles).toMatch(
      /(?:shared-tab-row|message-card|playback-group-card)[^{]*\{[\s\S]*?min-width:\s*0/iu,
    );

    const dangerButtons = (readVnextSource().match(/<button\b[\s\S]*?<\/button>/gu) ?? []).filter(
      (block) => /danger-button/u.test(block),
    );
    expect(dangerButtons.length).toBeGreaterThan(0);
    for (const button of dangerButtons) {
      expect(button).toMatch(/\p{Script=Han}|\{action\.label\}/u);
    }
  });

  it("owns a lightweight local background inside the panel instead of the page", () => {
    const styles = readIfPresent(stylesPath);
    const background = readIfPresent(sidepanelBackgroundPath);
    const bodyBlock = styles.slice(styles.indexOf("body {"), styles.indexOf("* {"));
    const appBlock = styles.slice(
      styles.indexOf(".syncaction-app {"),
      styles.indexOf(".sa-icon {"),
    );

    expect(existsSync(sidepanelBackgroundPath)).toBe(true);
    expect(appBlock).toContain('url("/sidepanel-background.svg")');
    expect(bodyBlock).not.toContain("sidepanel-background.svg");
    expect(background).toContain('viewBox="0 0 480 1200"');
    expect(background.trimEnd().endsWith("</svg>")).toBe(true);
    expect(background).not.toMatch(/<(?:script|foreignObject|text|filter)\b/iu);
    expect(background).not.toMatch(/\b(?:href|src)=["']https?:\/\//iu);
  });
});

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readVnextSource(): string {
  return readdirSync(vnextRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name)))
    .map((entry) => readFileSync(resolve(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

function mediaBlock(source: string, query: string): string {
  const start = source.indexOf(`@media (${query})`);
  if (start < 0) {
    return "";
  }
  const next = source.indexOf("@media", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}
