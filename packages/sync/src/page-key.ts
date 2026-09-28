import { createHmac } from "node:crypto";
import {
  AnnotationPageKeySchema,
  RoomIdSchema,
  canonicalSharedPageIdentity,
  type AnnotationPageKey,
} from "@syncaction/protocol";

const HMAC_KEY_BYTES = 32;
const YOUTUBE_IDENTITY_PATTERN = /^youtube:[A-Za-z0-9_-]{11}$/u;
const BILIBILI_IDENTITY_PATTERN = /^bilibili:av[1-9][0-9]{0,19}$/u;

export interface AnnotationPageKeyInput {
  roomId: unknown;
  canonicalPageIdentity: unknown;
}

export interface AnnotationPageKeyDerivationPort {
  derive(input: AnnotationPageKeyInput): AnnotationPageKey;
}

export class AnnotationPageKeyDeriver implements AnnotationPageKeyDerivationPort {
  readonly #key: Uint8Array;

  public constructor(keyInput: unknown) {
    if (!(keyInput instanceof Uint8Array) || keyInput.byteLength !== HMAC_KEY_BYTES) {
      throw new Error("INVALID_ANNOTATION_HMAC_KEY");
    }
    this.#key = Uint8Array.from(keyInput);
  }

  public derive(input: AnnotationPageKeyInput): AnnotationPageKey {
    const roomId = RoomIdSchema.safeParse(input.roomId);
    if (!roomId.success || !isCanonicalPageIdentity(input.canonicalPageIdentity)) {
      throw new Error("INVALID_ANNOTATION_PAGE_IDENTITY");
    }

    return AnnotationPageKeySchema.parse(
      createHmac("sha256", this.#key)
        .update(roomId.data)
        .update("\0")
        .update(input.canonicalPageIdentity)
        .digest("base64url"),
    );
  }
}

function isCanonicalPageIdentity(input: unknown): input is string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 4_100 ||
    input.includes("\0")
  ) {
    return false;
  }
  if (YOUTUBE_IDENTITY_PATTERN.test(input) || BILIBILI_IDENTITY_PATTERN.test(input)) {
    return true;
  }
  if (!input.startsWith("url:")) {
    return false;
  }
  try {
    return canonicalSharedPageIdentity(input.slice(4)) === input;
  } catch {
    return false;
  }
}
