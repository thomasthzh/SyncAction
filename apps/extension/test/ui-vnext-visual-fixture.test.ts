import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaTargetSchema } from "@syncaction/protocol";
import { WatchPreparationSchema } from "../src/watch-preparation.js";
import { createVisualStore } from "../visual/fixture-store.js";

describe("vNext browser visual fixture", () => {
  it("provides dense lobby and room states without browser-extension APIs", () => {
    const lobby = createVisualStore("lobby");
    const room = createVisualStore("room");
    const source = readFileSync(resolve(import.meta.dirname, "../visual/fixture-store.ts"), "utf8");
    const viteConfig = readFileSync(
      resolve(import.meta.dirname, "../visual/vite.config.ts"),
      "utf8",
    );
    const fixtureEntrypoint = readFileSync(
      resolve(import.meta.dirname, "../visual/main.tsx"),
      "utf8",
    );
    const productionEntrypoint = readFileSync(
      resolve(import.meta.dirname, "../entrypoints/sidepanel/main.ts"),
      "utf8",
    );

    expect(lobby.room.value.selectedRoomId).toBeNull();
    expect(lobby.discovery.value.publicRooms).toHaveLength(3);
    expect(room.collaboration.value.pages).toHaveLength(20);
    expect(room.collaboration.value.members).toHaveLength(20);
    expect(room.room.value.runtime?.media?.playbackGroups).toHaveLength(2);
    expect(source).not.toMatch(/wxt\/browser|chrome\.|browser\.runtime/u);
    expect(viteConfig).toContain('publicDir: resolve(import.meta.dirname, "../public")');
    expect(fixtureEntrypoint).toContain('document.documentElement.dataset.visualStage = "true"');
    expect(productionEntrypoint).not.toContain("visualStage");
  });
});

it("uses valid media identities for real preparation and session persistence", () => {
  for (const fixture of [
    "room",
    "room-watch-prepare",
    "room-watch-submitted",
    "room-device-leader",
    "room-device-follower",
    "room-device-unknown",
  ] as const) {
    const store = createVisualStore(fixture);
    for (const group of store.room.value.runtime!.media!.playbackGroups)
      expect(() => MediaTargetSchema.parse(group.target)).not.toThrow();
    if (store.room.value.watchPreparation != null)
      expect(() => WatchPreparationSchema.parse(store.room.value.watchPreparation)).not.toThrow();
  }
});
