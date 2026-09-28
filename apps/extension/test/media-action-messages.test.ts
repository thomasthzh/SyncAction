import { describe, expect, it } from "vitest";
import { readMediaActionMessage } from "../src/media-action-messages.js";

const playbackGroupId = "00000000-0000-4000-8000-000000000101";
const proposalId = "00000000-0000-4000-8000-000000000201";
const userId = "00000000-0000-4000-8000-000000000301";

describe("media side-panel action messages", () => {
  it.each([
    {
      type: "syncaction.media.member.jump",
      userId,
    },
    {
      type: "syncaction.media.group.align-once",
      playbackGroupId,
    },
    {
      type: "syncaction.media.group.join",
      playbackGroupId,
    },
    {
      type: "syncaction.media.proposal.decide",
      playbackGroupId,
      proposalId,
      decision: "APPROVE",
    },
    {
      type: "syncaction.media.proposal.decide",
      playbackGroupId,
      proposalId,
      decision: "REJECT",
    },
  ] as const)("accepts the exact $type contract", (message) => {
    expect(readMediaActionMessage(message)).toEqual(message);
  });

  it.each([
    {
      type: "syncaction.media.member.jump",
      userId,
      unexpected: true,
    },
    {
      type: "syncaction.media.group.align-once",
      playbackGroupId: "not-a-uuid",
    },
    {
      type: "syncaction.media.group.join",
    },
    {
      type: "syncaction.media.proposal.decide",
      playbackGroupId,
      proposalId,
      decision: "ALLOW",
    },
  ])("rejects a malformed known media action without partially routing it", (message) => {
    expect(() => readMediaActionMessage(message)).toThrowError("MEDIA_ACTION_MESSAGE_INVALID");
  });

  it("returns null for unrelated runtime messages", () => {
    expect(readMediaActionMessage({ type: "syncaction.app.status.get" })).toBeNull();
    expect(readMediaActionMessage(null)).toBeNull();
  });
});
