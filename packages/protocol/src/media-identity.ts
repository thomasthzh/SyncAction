export const YOUTUBE_MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
export const YOUTUBE_MEDIA_KEY_PATTERN = /^youtube:[A-Za-z0-9_-]{11}$/u;

const BILIBILI_AV_ID_PATTERN = /^av([0-9]{1,20})$/u;
const BILIBILI_MEDIA_KEY_PATTERN = /^bilibili:(av[1-9][0-9]{0,19})$/u;
const BILIBILI_BV_ALPHABET = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
const BILIBILI_BV_BASE = 58n;
const BILIBILI_BV_XOR = 23_442_827_791_579n;
const BILIBILI_BV_MARKER = 1n << 51n;
const BILIBILI_MAX_AID = BILIBILI_BV_MARKER - 1n;

function decodeBilibiliBvId(candidate: string): bigint | undefined {
  if (
    candidate.length !== 12 ||
    !candidate.startsWith("BV1") ||
    [...candidate.slice(3)].some((character) => BILIBILI_BV_ALPHABET.indexOf(character) < 0)
  ) {
    return undefined;
  }

  const characters = [...candidate];
  [characters[3], characters[9]] = [characters[9]!, characters[3]!];
  [characters[4], characters[7]] = [characters[7]!, characters[4]!];
  let encoded = 0n;
  for (const character of characters.slice(3)) {
    encoded = encoded * BILIBILI_BV_BASE + BigInt(BILIBILI_BV_ALPHABET.indexOf(character));
  }
  if (encoded < BILIBILI_BV_MARKER || encoded >= BILIBILI_BV_MARKER << 1n) {
    return undefined;
  }

  const aid = (encoded & BILIBILI_MAX_AID) ^ BILIBILI_BV_XOR;
  return aid > 0n ? aid : undefined;
}

export function canonicalBilibiliMediaId(candidate: string): string | undefined {
  const avMatch = BILIBILI_AV_ID_PATTERN.exec(candidate);
  const aid = avMatch?.[1] === undefined ? decodeBilibiliBvId(candidate) : BigInt(avMatch[1]);
  if (aid === undefined || aid <= 0n || aid > BILIBILI_MAX_AID) {
    return undefined;
  }

  return `av${aid.toString()}`;
}

export function isCanonicalBilibiliMediaKey(candidate: string): boolean {
  const match = BILIBILI_MEDIA_KEY_PATTERN.exec(candidate);
  return match?.[1] !== undefined && canonicalBilibiliMediaId(match[1]) === match[1];
}
