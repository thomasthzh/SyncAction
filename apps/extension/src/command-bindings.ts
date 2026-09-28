export const PAGE_TOOL_COMMANDS = {
  danmaku: "toggle-danmaku-input",
  pen: "toggle-page-pen",
} as const;

export type PageToolCommand = (typeof PAGE_TOOL_COMMANDS)[keyof typeof PAGE_TOOL_COMMANDS];

export interface ChromiumCommandBindingsApi {
  commands: {
    getAll(): Promise<Array<{ name: string; shortcut?: string | undefined }>>;
    onCommand: {
      addListener(listener: (command: string) => void): void;
      removeListener(listener: (command: string) => void): void;
    };
  };
  tabs: {
    create(options: { url: string }): Promise<unknown>;
  };
}

export interface PageToolCommandBinding {
  command: PageToolCommand;
  suggestedShortcut: "Alt+T" | "Alt+P";
  actualShortcut: string | null;
  state: "BOUND" | "UNBOUND";
}

export interface PageToolCommandBindings {
  danmaku: PageToolCommandBinding;
  pen: PageToolCommandBinding;
}

export async function readPageToolCommandBindings(
  api: Pick<ChromiumCommandBindingsApi, "commands">,
): Promise<PageToolCommandBindings> {
  const commands = await api.commands.getAll();
  const shortcuts = new Map<string, string>();
  for (const command of commands) {
    if (
      (command.name === PAGE_TOOL_COMMANDS.danmaku || command.name === PAGE_TOOL_COMMANDS.pen) &&
      typeof command.shortcut === "string" &&
      command.shortcut.trim().length > 0
    ) {
      shortcuts.set(command.name, command.shortcut.trim());
    }
  }
  return {
    danmaku: binding(
      PAGE_TOOL_COMMANDS.danmaku,
      "Alt+T",
      shortcuts.get(PAGE_TOOL_COMMANDS.danmaku),
    ),
    pen: binding(PAGE_TOOL_COMMANDS.pen, "Alt+P", shortcuts.get(PAGE_TOOL_COMMANDS.pen)),
  };
}

export function chromiumExtensionShortcutsUrl(userAgentInput: unknown): string {
  const userAgent = typeof userAgentInput === "string" ? userAgentInput : "";
  return /\bEdg\//u.test(userAgent)
    ? "edge://extensions/shortcuts"
    : "chrome://extensions/shortcuts";
}

export async function openChromiumExtensionShortcuts(
  api: Pick<ChromiumCommandBindingsApi, "tabs">,
  userAgentInput: unknown,
): Promise<void> {
  await api.tabs.create({ url: chromiumExtensionShortcutsUrl(userAgentInput) });
}

export function subscribePageToolCommands(
  api: Pick<ChromiumCommandBindingsApi, "commands">,
  onCommand: (command: PageToolCommand) => void | Promise<void>,
): () => void {
  const listener = (command: string): void => {
    if (command !== PAGE_TOOL_COMMANDS.danmaku && command !== PAGE_TOOL_COMMANDS.pen) {
      return;
    }
    void Promise.resolve(onCommand(command)).catch(() => undefined);
  };
  api.commands.onCommand.addListener(listener);
  return () => api.commands.onCommand.removeListener(listener);
}

function binding(
  command: PageToolCommand,
  suggestedShortcut: "Alt+T" | "Alt+P",
  actualShortcut: string | undefined,
): PageToolCommandBinding {
  return {
    command,
    suggestedShortcut,
    actualShortcut: actualShortcut ?? null,
    state: actualShortcut === undefined ? "UNBOUND" : "BOUND",
  };
}
