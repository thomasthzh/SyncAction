import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  isPageControllerMessage,
  parsePageOutboundMessageFromSender,
} from "../src/page-collaboration/messages.js";

type Listener = (
  message: unknown,
  sender: unknown,
  respond: (response?: unknown) => void,
) => unknown;
const source = ts.createSourceFile(
  "background.ts",
  readFileSync(new URL("../entrypoints/background.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let callback: ts.Expression | undefined;
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "browser.runtime.onMessage.addListener"
  )
    callback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (callback === undefined) throw new Error("BACKGROUND_MESSAGE_LISTENER_MISSING");
// Execute the actual entrypoint callback with controlled ports, without booting
// the application, browser profile, network or storage. No dispatch is reimplemented.
const callbackScript = ts.transpileModule(`(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const context = {
  roomId: "018f8f8e-4b5c-4d6e-8f90-123456789a01",
  logicalTabId: "018f8f8e-4b5c-4d6e-8f90-123456789a02",
  documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 4 },
  frameKey: "top",
};
const sender = {
  tab: { id: 42 },
  frameId: 0,
  url: "https://example.com/watch",
  documentId: "document-a",
  documentLifecycle: "active",
};
const report = {
  type: "syncaction.danmaku.report",
  controller: "danmaku",
  context,
  hidden: false,
  inputOpen: true,
};

function fixture() {
  const app = { handleDanmakuReport: vi.fn(async (): Promise<void> => undefined) };
  const pageCollaborationPort = { validateOutboundMessage: vi.fn(async () => true) };
  const listener = runInNewContext(callbackScript, {
    parsePageOutboundMessageFromSender,
    isPageControllerMessage,
    pageCollaborationPort,
    ready: Promise.resolve(app),
  }) as Listener;
  return { app, pageCollaborationPort, listener };
}

function nativeDispatch(listener: Listener, message: unknown, sourceSender: unknown = sender) {
  let resolve!: (response: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  let open = true;
  let responded = false;
  const respond = vi.fn((value?: unknown) => {
    if (open && !responded) {
      responded = true;
      resolve(value);
    }
  });
  const returned = listener(message, sourceSender, respond);
  if (returned !== true) {
    open = false;
    if (!responded) resolve(undefined);
  }
  // Prevent an intentionally dropped rejected Promise from becoming a global
  // test error. Its settlement never supplies or retains the native response.
  void Promise.resolve(returned).catch(() => undefined);
  return { response, returned, respond };
}

describe("background native message response channel", () => {
  it("keeps a recognized report pending until the validated application dispatch finishes", async () => {
    const { app, listener } = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.handleDanmakuReport.mockImplementationOnce(async () => held);
    const request = nativeDispatch(listener, report);
    let settled = false;
    void request.response.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(app.handleDanmakuReport).toHaveBeenCalledOnce());
    expect(request.returned).toBe(true);
    expect(settled).toBe(false);
    expect(request.respond).not.toHaveBeenCalled();
    release();
    await expect(request.response).resolves.toBeUndefined();
    expect(app.handleDanmakuReport).toHaveBeenCalledWith(42, 0, report);
    expect(request.respond).toHaveBeenCalledOnce();
  });

  it("leaves unknown messages unclaimed and synchronously closes an invalid known sender", () => {
    const { app, listener, pageCollaborationPort } = fixture();
    const unknown = nativeDispatch(listener, { type: "another.listener.message" });
    expect(unknown.returned).toBeUndefined();
    expect(unknown.respond).not.toHaveBeenCalled();
    const invalid = nativeDispatch(listener, report, {});
    expect(invalid.returned).toBeUndefined();
    expect(invalid.respond).toHaveBeenCalledOnce();
    expect(invalid.respond).toHaveBeenCalledWith();
    expect(pageCollaborationPort.validateOutboundMessage).not.toHaveBeenCalled();
    expect(app.handleDanmakuReport).not.toHaveBeenCalled();
  });

  it.each(["validation-refused", "validation-rejected", "application"] as const)(
    "closes a rejected %s path without leaking errors or dispatching an unauthorized report",
    async (failure) => {
      const { app, listener, pageCollaborationPort } = fixture();
      if (failure === "validation-refused")
        pageCollaborationPort.validateOutboundMessage.mockResolvedValueOnce(false);
      else if (failure === "validation-rejected")
        pageCollaborationPort.validateOutboundMessage.mockRejectedValueOnce(
          new Error("PRIVATE_DIAGNOSTIC"),
        );
      else app.handleDanmakuReport.mockRejectedValueOnce(new Error("PRIVATE_DIAGNOSTIC"));
      const request = nativeDispatch(listener, report);
      expect(request.returned).toBe(true);
      await expect(request.response).resolves.toBeUndefined();
      expect(request.respond).toHaveBeenCalledOnce();
      if (failure !== "application") expect(app.handleDanmakuReport).not.toHaveBeenCalled();
      else expect(app.handleDanmakuReport).toHaveBeenCalledOnce();
    },
  );
});
