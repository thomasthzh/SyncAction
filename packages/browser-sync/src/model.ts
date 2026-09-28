import { RoomIdSchema } from "@syncaction/protocol";
import { z } from "zod";

const BrowserObjectIdSchema = z.number().int().nonnegative().safe();
const BrowserIndexSchema = z.number().int().nonnegative().safe();

export const BrowserWindowSchema = z
  .object({
    windowId: BrowserObjectIdSchema,
    type: z.enum(["normal", "popup", "app", "devtools", "panel"]),
    incognito: z.boolean(),
  })
  .strict();

export const BrowserGroupSchema = z
  .object({
    groupId: BrowserObjectIdSchema,
    windowId: BrowserObjectIdSchema,
    title: z.string().max(256).nullable(),
    color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]),
    collapsed: z.boolean(),
  })
  .strict();

export const BrowserTabSchema = z
  .object({
    tabId: BrowserObjectIdSchema,
    windowId: BrowserObjectIdSchema,
    groupId: BrowserObjectIdSchema.nullable(),
    index: BrowserIndexSchema,
    url: z.string().max(4_096).nullable(),
    title: z.string().max(512).nullable(),
    status: z.enum(["loading", "complete"]),
    pinned: z.boolean(),
  })
  .strict();

export const BrowserStateSchema = z
  .object({
    browserSessionId: z.string().uuid(),
    windows: z.array(BrowserWindowSchema).max(1_000),
    groups: z.array(BrowserGroupSchema).max(2_000),
    tabs: z.array(BrowserTabSchema).max(20_000),
  })
  .strict()
  .superRefine((state, context) => {
    const windows = new Map<number, BrowserWindow>();
    for (const [index, window] of state.windows.entries()) {
      if (windows.has(window.windowId)) {
        context.addIssue({
          code: "custom",
          path: ["windows", index, "windowId"],
          message: "browser window IDs must be unique",
        });
      }
      windows.set(window.windowId, window);
    }

    const groups = new Map<number, BrowserGroup>();
    for (const [index, group] of state.groups.entries()) {
      if (groups.has(group.groupId)) {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "groupId"],
          message: "browser group IDs must be unique",
        });
      }
      if (!windows.has(group.windowId)) {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "windowId"],
          message: "browser group must reference an existing window",
        });
      }
      groups.set(group.groupId, group);
    }

    const tabIds = new Set<number>();
    const windowIndexes = new Set<string>();
    for (const [index, tab] of state.tabs.entries()) {
      if (tabIds.has(tab.tabId)) {
        context.addIssue({
          code: "custom",
          path: ["tabs", index, "tabId"],
          message: "browser tab IDs must be unique",
        });
      }
      tabIds.add(tab.tabId);
      const indexIdentity = `${tab.windowId}:${tab.index}`;
      if (windowIndexes.has(indexIdentity)) {
        context.addIssue({
          code: "custom",
          path: ["tabs", index, "index"],
          message: "browser tab indexes must be unique within a window",
        });
      }
      windowIndexes.add(indexIdentity);
      if (!windows.has(tab.windowId)) {
        context.addIssue({
          code: "custom",
          path: ["tabs", index, "windowId"],
          message: "browser tab must reference an existing window",
        });
      }
      if (tab.groupId !== null) {
        const group = groups.get(tab.groupId);
        if (group === undefined || group.windowId !== tab.windowId) {
          context.addIssue({
            code: "custom",
            path: ["tabs", index, "groupId"],
            message: "browser tab must reference a group in the same window",
          });
        }
      }
    }
  });

export type BrowserWindow = z.infer<typeof BrowserWindowSchema>;
export type BrowserGroup = z.infer<typeof BrowserGroupSchema>;
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
export type BrowserState = z.infer<typeof BrowserStateSchema>;

export type RoomGroupDiscovery =
  | { kind: "MISSING" }
  | { kind: "AMBIGUOUS"; reason: "DUPLICATE_ROOM_GROUP" }
  | { kind: "UNSAFE"; reason: "INCOGNITO_ROOM_GROUP" | "UNSUPPORTED_WINDOW" }
  | { kind: "FOUND"; group: BrowserGroup; tabs: BrowserTab[] };

export function roomGroupTitle(roomIdInput: unknown): string {
  const roomId = RoomIdSchema.parse(roomIdInput);
  return `SyncAction · ${roomId.slice(0, 8)}`;
}

export function discoverRoomGroup(stateInput: unknown, roomIdInput: unknown): RoomGroupDiscovery {
  const state = BrowserStateSchema.parse(stateInput);
  const title = roomGroupTitle(roomIdInput);
  const matches = state.groups.filter((group) => group.title === title);
  if (matches.length === 0) {
    return { kind: "MISSING" };
  }
  if (matches.length > 1) {
    return { kind: "AMBIGUOUS", reason: "DUPLICATE_ROOM_GROUP" };
  }
  const group = matches[0]!;
  const window = state.windows.find((candidate) => candidate.windowId === group.windowId)!;
  if (window.type !== "normal") {
    return { kind: "UNSAFE", reason: "UNSUPPORTED_WINDOW" };
  }
  if (window.incognito) {
    return { kind: "UNSAFE", reason: "INCOGNITO_ROOM_GROUP" };
  }
  return {
    kind: "FOUND",
    group,
    tabs: state.tabs
      .filter((tab) => tab.groupId === group.groupId)
      .toSorted((left, right) => left.index - right.index),
  };
}
