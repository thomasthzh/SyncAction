import { describe, expect, it } from "vitest";
import {
  createPendingRoomJoinStorage,
  PENDING_ROOM_JOIN_KEY,
  type PendingRoomJoin,
} from "../src/pending-room-join.js";
import { isPlaceholderServerOrigin } from "../src/server-configuration.js";

const destination: PendingRoomJoin = {
  version: 1,
  profileId: "team",
  serverOrigin: "https://team.example",
  serverId: "10000000-0000-4000-8000-000000000001",
  roomId: "20000000-0000-4000-8000-000000000001",
  roomName: "一起看",
  joinPolicy: "OPEN",
};

function area() {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(key: string) {
      return { [key]: values[key] };
    },
    async set(items: Record<string, unknown>) {
      Object.assign(values, structuredClone(items));
    },
    async remove(key: string) {
      delete values[key];
    },
  };
}

describe("non-sensitive pending room destination", () => {
  it("survives a new storage instance and serializes cancellation after a pending write", async () => {
    const storageArea = area();
    const storage = createPendingRoomJoinStorage(storageArea);
    await storage.write(destination);
    expect(await createPendingRoomJoinStorage(storageArea).read()).toEqual(destination);
    await Promise.all([storage.write(destination), storage.write(null)]);
    expect(await storage.read()).toBeNull();
  });

  it.each([
    { password: "never-persist" },
    { command: { name: "AUTH_LOGIN" } },
    { serverOrigin: "https://user:secret@team.example" },
  ])("rejects a corrupt or credential-bearing record %j", async (extra) => {
    const storageArea = area();
    storageArea.values[PENDING_ROOM_JOIN_KEY] = { ...destination, ...extra };
    expect(await createPendingRoomJoinStorage(storageArea).read()).toBeNull();
  });

  it("does not classify arbitrary example or production origins as the distribution placeholder", () => {
    expect(isPlaceholderServerOrigin("https://syncaction.example.com/")).toBe(true);
    for (const origin of [
      "https://team.example.com",
      "https://syncaction.example.com:8443",
      "https://demo.syncaction.example",
      "https://syncaction.example.com.attacker.test",
      "https://syncaction.example.com/path",
    ]) {
      expect(isPlaceholderServerOrigin(origin)).toBe(false);
    }
  });
});
