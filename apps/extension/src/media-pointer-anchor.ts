import {
  MediaIdentitySchema,
  type MediaIdentity,
  type PointerAnchor,
  type PointerPathSegment,
} from "@syncaction/protocol";

const MEDIA_MARKER_PREFIX = "syncaction-media";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// The wire still carries at most 12 tag/nth segments. A reserved root with
// nth=2 cannot resolve as a Document path, including in older clients.
// Canonical ASCII media keys fit losslessly: at most 198 bytes -> 11 chunks.
export function buildMediaPointerAnchor(
  identityInput: MediaIdentity,
  x: number,
  y: number,
): PointerAnchor | null {
  const parsed = MediaIdentitySchema.safeParse(identityInput);
  if (
    !parsed.success ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    return null;
  }
  const identity = parsed.data;
  let encoded = "";
  let buffer = 0;
  let bits = 0;
  for (const character of identity.mediaKey) {
    buffer = (buffer << 8) | character.charCodeAt(0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  const path: PointerPathSegment[] = [
    { tagName: `${MEDIA_MARKER_PREFIX}-v1-${identity.provider.toLowerCase()}`, nthOfType: 2 },
  ];
  for (let index = 0; index < encoded.length; index += 31) {
    path.push({ tagName: `m${encoded.slice(index, index + 31)}`, nthOfType: 1 });
  }
  return { path, x, y };
}

export function isReservedMediaPointerAnchor(path: readonly PointerPathSegment[]): boolean {
  return path[0]?.tagName.startsWith(MEDIA_MARKER_PREFIX) === true;
}

export function matchesMediaPointerAnchor(anchor: PointerAnchor, identity: MediaIdentity): boolean {
  const expected = buildMediaPointerAnchor(identity, anchor.x, anchor.y);
  return (
    expected !== null &&
    expected.path.length === anchor.path.length &&
    expected.path.every(
      (segment, index) =>
        segment.tagName === anchor.path[index]?.tagName &&
        segment.nthOfType === anchor.path[index]?.nthOfType,
    )
  );
}
