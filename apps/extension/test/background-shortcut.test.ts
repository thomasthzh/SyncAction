import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { PAGE_TOOL_COMMANDS } from "../src/command-bindings.js";
import { PageToolShortcutIntentMessageSchema } from "../src/page-tool-shortcut-intent.js";

const source = ts.createSourceFile(
  "background.ts",
  readFileSync(new URL("../entrypoints/background.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let callback: ts.Expression | undefined;
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "subscribePageToolCommands")
    callback = node.arguments[1];
  ts.forEachChild(node, visit);
}
visit(source);
if (callback === undefined) throw new Error("COMMAND_CALLBACK_MISSING");
const script = ts.transpileModule(`(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture() {
  const tab = { id: 42, windowId: 2, url: "https://video.example/watch" };
  const context = {
    profileId: "test",
    serverOrigin: "https://sync.example",
    serverId: null,
    accountId: "account",
    roomId: "room",
    tabId: 42,
    windowId: 2,
    url: tab.url,
    documentRevision: null,
  };
  const status = {
    selectedProfileId: "test",
    selectedProfile: { baseUrl: "https://sync.example", metadata: null },
    account: { id: "account" },
    selectedRoomId: "room",
  };
  const app = {
    getStatus: vi.fn(async () => structuredClone(status)),
    togglePagePen: vi.fn(),
    toggleDanmakuInput: vi.fn(),
  };
  const cache = { context, access: { enabledFeatures: [] as string[] } };
  const sandbox = {
    PAGE_TOOL_COMMANDS,
    PageToolShortcutIntentMessageSchema,
    currentPageAccess: null as typeof cache | null,
    ready: Promise.resolve(app),
    readyState: Promise.resolve({
      readPageAccess: vi.fn(async () => {
        sandbox.currentPageAccess = cache;
      }),
    }),
    sidePanelApi: { sidePanel: { open: vi.fn(async () => undefined) } },
    shortcutIntents: { enqueue: vi.fn(async () => undefined) },
    browser: {
      runtime: { sendMessage: vi.fn(async () => undefined) },
      tabs: { query: vi.fn(async () => [tab]) },
    },
  };
  const run = runInNewContext(script, sandbox) as (
    command: string,
    sourceTab?: typeof tab,
  ) => Promise<void>;
  return { tab, cache, status, sandbox, run };
}

describe("actual background shortcut callback", () => {
  it("opens in the original gesture and queues the first shortcut after the sidepanel cache was invalidated", async () => {
    const h = fixture();
    const result = h.run(PAGE_TOOL_COMMANDS.pen, h.tab);
    expect(h.sandbox.sidePanelApi.sidePanel.open).toHaveBeenCalledWith({ windowId: 2 });
    expect(h.sandbox.shortcutIntents.enqueue).not.toHaveBeenCalled();
    await result;
    expect(h.sandbox.shortcutIntents.enqueue).toHaveBeenCalledWith(
      "pen",
      h.cache.context,
      expect.any(Number),
    );
    expect(h.sandbox.browser.runtime.sendMessage).toHaveBeenCalledOnce();
  });
  it("does not reinterpret an old shortcut as a newly selected tab", async () => {
    const h = fixture();
    await h.run(PAGE_TOOL_COMMANDS.pen, { ...h.tab, id: 43 });
    expect(h.sandbox.shortcutIntents.enqueue).not.toHaveBeenCalled();
    expect(h.sandbox.browser.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("never guesses a source tab when the native command supplies none", async () => {
    const h = fixture();
    await h.run(PAGE_TOOL_COMMANDS.pen);
    expect(h.sandbox.shortcutIntents.enqueue).not.toHaveBeenCalled();
  });
});
