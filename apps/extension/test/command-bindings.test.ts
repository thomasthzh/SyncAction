import { describe, expect, it, vi } from "vitest";
import {
  PAGE_TOOL_COMMANDS,
  chromiumExtensionShortcutsUrl,
  openChromiumExtensionShortcuts,
  readPageToolCommandBindings,
  subscribePageToolCommands,
  type ChromiumCommandBindingsApi,
} from "../src/command-bindings.js";

class FakeCommandsApi implements ChromiumCommandBindingsApi {
  public commandEntries: Array<{ name: string; shortcut?: string }> = [];
  public readonly createdTabs: string[] = [];
  public commandListener: ((command: string) => void) | undefined;

  public readonly commands = {
    getAll: async () => structuredClone(this.commandEntries),
    onCommand: {
      addListener: (listener: (command: string) => void) => {
        this.commandListener = listener;
      },
      removeListener: (listener: (command: string) => void) => {
        if (this.commandListener === listener) {
          this.commandListener = undefined;
        }
      },
    },
  };

  public readonly tabs = {
    create: async ({ url }: { url: string }) => {
      this.createdTabs.push(url);
      return {};
    },
  };
}

describe("page tool command bindings", () => {
  it("reports browser-assigned shortcuts instead of assuming manifest suggestions", async () => {
    const api = new FakeCommandsApi();
    api.commandEntries = [
      { name: PAGE_TOOL_COMMANDS.danmaku, shortcut: "Alt+Shift+T" },
      { name: PAGE_TOOL_COMMANDS.pen, shortcut: "Ctrl+Shift+P" },
    ];

    await expect(readPageToolCommandBindings(api)).resolves.toEqual({
      danmaku: {
        command: "toggle-danmaku-input",
        suggestedShortcut: "Alt+T",
        actualShortcut: "Alt+Shift+T",
        state: "BOUND",
      },
      pen: {
        command: "toggle-page-pen",
        suggestedShortcut: "Alt+P",
        actualShortcut: "Ctrl+Shift+P",
        state: "BOUND",
      },
    });
  });

  it("uses accessible side-panel fallback state for conflicts, missing, and user-cleared bindings", async () => {
    const api = new FakeCommandsApi();
    api.commandEntries = [{ name: PAGE_TOOL_COMMANDS.danmaku, shortcut: "" }];

    await expect(readPageToolCommandBindings(api)).resolves.toMatchObject({
      danmaku: { actualShortcut: null, state: "UNBOUND" },
      pen: { actualShortcut: null, state: "UNBOUND" },
    });

    api.commandEntries = [
      { name: PAGE_TOOL_COMMANDS.danmaku, shortcut: "Alt+T" },
      { name: PAGE_TOOL_COMMANDS.pen, shortcut: "Alt+P" },
    ];
    await expect(readPageToolCommandBindings(api)).resolves.toMatchObject({
      danmaku: { actualShortcut: "Alt+T", state: "BOUND" },
      pen: { actualShortcut: "Alt+P", state: "BOUND" },
    });
    api.commandEntries[0] = { name: PAGE_TOOL_COMMANDS.danmaku, shortcut: "" };
    await expect(readPageToolCommandBindings(api)).resolves.toMatchObject({
      danmaku: { actualShortcut: null, state: "UNBOUND" },
    });
  });

  it("opens the correct Chromium shortcut page and never invents a web URL", async () => {
    const api = new FakeCommandsApi();

    expect(chromiumExtensionShortcutsUrl("Mozilla/5.0 Edg/140.0")).toBe(
      "edge://extensions/shortcuts",
    );
    expect(chromiumExtensionShortcutsUrl("Mozilla/5.0 Chrome/140.0")).toBe(
      "chrome://extensions/shortcuts",
    );
    await openChromiumExtensionShortcuts(api, "Mozilla/5.0 Edg/140.0");
    await openChromiumExtensionShortcuts(api, "Mozilla/5.0 Chrome/140.0");

    expect(api.createdTabs).toEqual([
      "edge://extensions/shortcuts",
      "chrome://extensions/shortcuts",
    ]);
  });

  it("routes only the two declared commands and can remove its listener", () => {
    const api = new FakeCommandsApi();
    const onCommand = vi.fn();
    const unsubscribe = subscribePageToolCommands(api, onCommand);

    api.commandListener?.("unknown-command");
    api.commandListener?.(PAGE_TOOL_COMMANDS.danmaku);
    api.commandListener?.(PAGE_TOOL_COMMANDS.pen);
    expect(onCommand.mock.calls).toEqual([[PAGE_TOOL_COMMANDS.danmaku], [PAGE_TOOL_COMMANDS.pen]]);

    unsubscribe();
    expect(api.commandListener).toBeUndefined();
  });
});
