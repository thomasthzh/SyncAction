import type { Database } from "@syncaction/database";
import { assertRoomInvariants, type LogicalTabState, type RoomState } from "@syncaction/domain";
import type { LogicalTabId } from "@syncaction/protocol";
import type { Transaction } from "kysely";
import { SyncError } from "./errors.js";

const NEW_TAB_TEMPORARY_POSITION = -2_147_483_648;

function storedTab(tab: LogicalTabState) {
  return {
    url: tab.url,
    title: tab.title ?? null,
    favIconUrl: tab.favIconUrl ?? null,
    createdAtSeq: tab.createdAtSeq,
    updatedAtSeq: tab.updatedAtSeq,
    closedAtSeq: tab.closedAtSeq,
  };
}

export async function writeMaterializedState(
  transaction: Transaction<Database>,
  previous: RoomState,
  next: RoomState,
): Promise<void> {
  try {
    assertRoomInvariants(previous);
    assertRoomInvariants(next);
    if (
      previous.roomId !== next.roomId ||
      previous.roomEpoch !== next.roomEpoch ||
      next.serverSeq !== previous.serverSeq + 1
    ) {
      throw new Error("materializer requires one reducer step in the same room epoch");
    }

    const previousTabs = new Set(
      Object.values(previous.tabs)
        .filter((tab): tab is LogicalTabState => tab !== undefined)
        .map((tab) => tab.id),
    );
    const nextTabs = Object.values(next.tabs).filter(
      (tab): tab is LogicalTabState => tab !== undefined,
    );
    const createdTabs = nextTabs.filter((tab) => !previousTabs.has(tab.id));
    if (createdTabs.length > 1 || previousTabs.size + createdTabs.length !== nextTabs.length) {
      throw new Error("one operation may add at most one tab and may not remove tombstones");
    }

    const created = createdTabs[0];
    if (created !== undefined) {
      await transaction
        .insertInto("roomTabs")
        .values({
          roomId: next.roomId,
          logicalTabId: created.id,
          ...storedTab(created),
          position: NEW_TAB_TEMPORARY_POSITION,
        })
        .execute();
    }

    for (const tab of nextTabs) {
      if (tab.id === created?.id) {
        continue;
      }
      const result = await transaction
        .updateTable("roomTabs")
        .set(storedTab(tab))
        .where("roomId", "=", next.roomId)
        .where("logicalTabId", "=", tab.id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(`missing materialized row for ${tab.id}`);
      }
    }

    const nextActiveIds = new Set<LogicalTabId>(next.order);
    for (const [index, logicalTabId] of previous.order.entries()) {
      if (!nextActiveIds.has(logicalTabId)) {
        continue;
      }
      await transaction
        .updateTable("roomTabs")
        .set({ position: -(index + 1) })
        .where("roomId", "=", next.roomId)
        .where("logicalTabId", "=", logicalTabId)
        .where("closedAtSeq", "is", null)
        .execute();
    }
    for (const [index, logicalTabId] of next.order.entries()) {
      const result = await transaction
        .updateTable("roomTabs")
        .set({ position: index })
        .where("roomId", "=", next.roomId)
        .where("logicalTabId", "=", logicalTabId)
        .where("closedAtSeq", "is", null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(`missing active materialized row for ${logicalTabId}`);
      }
    }
  } catch (cause) {
    if (cause instanceof SyncError) {
      throw cause;
    }
    throw new SyncError("RECOVERY_REQUIRED", { cause });
  }
}
