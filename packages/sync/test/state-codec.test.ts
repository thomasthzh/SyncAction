import { describe, expect, it } from "vitest";
import { decodeMaterializedState, encodeSnapshotState } from "../src/state-codec.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789e00";
const firstTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e01";
const secondTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e02";
const closedTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e03";

const room = { id: roomId, roomEpoch: 3, serverSeq: 7 };
const rows = [
  {
    roomId,
    logicalTabId: secondTabId,
    url: "https://example.com/second",
    title: "Second",
    favIconUrl: null,
    position: 1,
    createdAtSeq: 2,
    updatedAtSeq: 2,
    closedAtSeq: null,
  },
  {
    roomId,
    logicalTabId: closedTabId,
    url: "https://example.com/closed",
    title: null,
    favIconUrl: null,
    position: 0,
    createdAtSeq: 3,
    updatedAtSeq: 5,
    closedAtSeq: 5,
  },
  {
    roomId,
    logicalTabId: firstTabId,
    url: "https://example.com/first",
    title: null,
    favIconUrl: "https://example.com/favicon.ico",
    position: 0,
    createdAtSeq: 1,
    updatedAtSeq: 7,
    closedAtSeq: null,
  },
];

describe("materialized room state codec", () => {
  it("reconstructs canonical order and preserves tombstones from unsorted rows", () => {
    const state = decodeMaterializedState(room, rows);

    expect(state).toMatchObject({
      roomId,
      roomEpoch: 3,
      serverSeq: 7,
      order: [firstTabId, secondTabId],
      tabs: {
        [firstTabId]: {
          url: "https://example.com/first",
          favIconUrl: "https://example.com/favicon.ico",
          closedAtSeq: null,
        },
        [secondTabId]: {
          title: "Second",
          favIconUrl: null,
          closedAtSeq: null,
        },
        [closedTabId]: {
          favIconUrl: null,
          closedAtSeq: 5,
        },
      },
    });
    expect(encodeSnapshotState(state)).toEqual({
      roomId,
      roomEpoch: 3,
      serverSeq: 7,
      order: [firstTabId, secondTabId],
      tabs: [
        {
          id: firstTabId,
          url: "https://example.com/first",
          favIconUrl: "https://example.com/favicon.ico",
          createdAtSeq: 1,
          updatedAtSeq: 7,
          closedAtSeq: null,
        },
        {
          id: secondTabId,
          url: "https://example.com/second",
          title: "Second",
          favIconUrl: null,
          createdAtSeq: 2,
          updatedAtSeq: 2,
          closedAtSeq: null,
        },
        {
          id: closedTabId,
          url: "https://example.com/closed",
          favIconUrl: null,
          createdAtSeq: 3,
          updatedAtSeq: 5,
          closedAtSeq: 5,
        },
      ],
    });
  });

  it.each([
    {
      name: "duplicate active positions",
      room,
      rows: rows.map((row) => (row.logicalTabId === secondTabId ? { ...row, position: 0 } : row)),
    },
    {
      name: "gapped active positions",
      room,
      rows: rows.map((row) => (row.logicalTabId === secondTabId ? { ...row, position: 2 } : row)),
    },
    {
      name: "unsafe room sequence",
      room: { ...room, serverSeq: Number.MAX_SAFE_INTEGER + 1 },
      rows,
    },
    {
      name: "malformed stored URL",
      room,
      rows: rows.map((row) =>
        row.logicalTabId === firstTabId ? { ...row, url: "file:///secret" } : row,
      ),
    },
  ])(
    "fails closed with RECOVERY_REQUIRED for $name",
    ({ room: invalidRoom, rows: invalidRows }) => {
      expect(() => decodeMaterializedState(invalidRoom, invalidRows)).toThrowError(
        expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
      );
    },
  );
});
