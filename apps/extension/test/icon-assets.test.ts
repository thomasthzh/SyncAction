import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../wxt.config.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fullSvgPath = resolve(repositoryRoot, "design/brand/syncaction-symbol.svg");
const smallSvgPath = resolve(repositoryRoot, "design/brand/syncaction-symbol-small.svg");
const rendererPath = resolve(repositoryRoot, "scripts/render-extension-icons.mjs");
const superadminSvgPath = resolve(repositoryRoot, "apps/superadmin/public/syncaction-symbol.svg");
const vnextIconSourcePath = resolve(repositoryRoot, "apps/extension/src/ui-vnext/icons.tsx");
const iconSizes = [16, 32, 48, 128] as const;

const expectedFullSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="title">
  <title id="title">SyncAction</title>
  <defs>
    <linearGradient
      id="background"
      x1="20"
      y1="16"
      x2="108"
      y2="112"
      gradientUnits="userSpaceOnUse"
    >
      <stop stop-color="#3B82F6" />
      <stop offset="1" stop-color="#4F46E5" />
    </linearGradient>
    <mask id="tabs">
      <rect width="128" height="128" fill="black" />
      <rect x="24" y="27" width="68" height="52" rx="15" fill="white" />
      <rect x="36" y="49" width="68" height="52" rx="15" fill="white" />
      <path d="M58 59.5V89.5L84 74.5Z" fill="black" />
    </mask>
  </defs>
  <rect x="6" y="6" width="116" height="116" rx="29" fill="url(#background)" />
  <rect x="18" y="21" width="92" height="86" fill="#F8FAFC" mask="url(#tabs)" />
</svg>
`;

const expectedSmallSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <mask id="tabs">
      <rect width="128" height="128" fill="black" />
      <rect x="24" y="27" width="68" height="52" rx="15" fill="white" />
      <rect x="36" y="49" width="68" height="52" rx="15" fill="white" />
      <path d="M58 60V90L84 75Z" fill="black" />
    </mask>
  </defs>
  <rect x="6" y="6" width="116" height="116" rx="29" fill="#356FE8" />
  <rect x="18" y="21" width="92" height="86" fill="#F8FAFC" mask="url(#tabs)" />
</svg>
`;

describe("SyncAction brand icon sources", () => {
  it("keeps the vNext logo bound to the generated brand master instead of copied JSX geometry", () => {
    expect(existsSync(vnextIconSourcePath)).toBe(true);
    const source = existsSync(vnextIconSourcePath) ? readFileSync(vnextIconSourcePath, "utf8") : "";
    expect(source).toContain('data-brand-source="design/brand/syncaction-symbol.svg"');
    expect(source).toContain('src="/icon-32.png"');
  });

  it("keeps the approved full and small masters byte-for-byte deterministic", () => {
    expect(readFileSync(fullSvgPath, "utf8")).toBe(expectedFullSvg);
    expect(readFileSync(smallSvgPath, "utf8")).toBe(expectedSmallSvg);
    expect(readFileSync(superadminSvgPath, "utf8")).toBe(expectedFullSvg);
    expect(readFileSync(rendererPath, "utf8").length).toBeGreaterThan(0);
  });

  it.each([
    ["full", fullSvgPath, true, "M58 59.5V89.5L84 74.5Z"],
    ["small", smallSvgPath, false, "M58 60V90L84 75Z"],
  ] as const)(
    "%s master has the approved safe two-tab and negative-triangle construction",
    (_variant, path, usesGradient, trianglePath) => {
      const source = readFileSync(path, "utf8");

      expect(source).toContain('viewBox="0 0 128 128"');
      expect(source).not.toMatch(
        /<(?:text|image|script|foreignObject|metadata|font|use)\b|@font-face|(?:data:|javascript:|file:)/iu,
      );
      expect(source.match(/https?:\/\/[^\s"')]+/gu)).toEqual(["http://www.w3.org/2000/svg"]);
      expect(
        source.match(/<rect x="24" y="27" width="68" height="52" rx="15" fill="white" \/>/gu),
      ).toHaveLength(1);
      expect(
        source.match(/<rect x="36" y="49" width="68" height="52" rx="15" fill="white" \/>/gu),
      ).toHaveLength(1);
      expect(source).toContain(`<path d="${trianglePath}" fill="black" />`);
      if (usesGradient) {
        expect(source).toContain("<linearGradient");
        expect(source).toContain('id="background"');
        expect(source).toContain('x1="20"');
        expect(source).toContain('y1="16"');
        expect(source).toContain('x2="108"');
        expect(source).toContain('y2="112"');
        expect(source).toContain('gradientUnits="userSpaceOnUse"');
        expect(source).toContain('<stop stop-color="#3B82F6" />');
        expect(source).toContain('<stop offset="1" stop-color="#4F46E5" />');
      } else {
        expect(source).not.toContain("<linearGradient");
        expect(source).toContain('fill="#356FE8"');
      }
    },
  );
});

describe("rendered extension icon assets", () => {
  it.each(iconSizes)("%i px icon is exact RGBA artwork with a legible foreground", (size) => {
    const iconPath = resolve(repositoryRoot, `apps/extension/public/icon-${String(size)}.png`);
    const png = decodeRgbaPng(readFileSync(iconPath));

    expect(png.width).toBe(size);
    expect(png.height).toBe(size);
    expect(png.bitDepth).toBe(8);
    expect(png.colorType).toBe(6);
    expect(png.chunkTypes[0]).toBe("IHDR");
    expect(png.chunkTypes.at(-1)).toBe("IEND");
    expect(
      png.chunkTypes.filter((type) => type !== "IHDR" && type !== "IDAT" && type !== "IEND"),
    ).toEqual([]);

    let visiblePixels = 0;
    let transparentPixels = 0;
    let foregroundPixels = 0;
    for (let offset = 0; offset < png.pixels.length; offset += 4) {
      const red = png.pixels[offset] ?? 0;
      const green = png.pixels[offset + 1] ?? 0;
      const blue = png.pixels[offset + 2] ?? 0;
      const alpha = png.pixels[offset + 3] ?? 0;
      if (alpha > 0) {
        visiblePixels += 1;
      } else {
        transparentPixels += 1;
      }
      if (alpha >= 192 && red >= 225 && green >= 225 && blue >= 225) {
        foregroundPixels += 1;
      }
    }

    expect(visiblePixels).toBeGreaterThan(0);
    expect(transparentPixels).toBeGreaterThan(0);
    expect(foregroundPixels).toBeGreaterThanOrEqual(Math.max(8, Math.floor(size * size * 0.1)));
  });

  it("uses the real renderer to reproduce committed pixels and local deterministic bytes", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "syncaction-icon-renderer-"));
    try {
      const brandDirectory = resolve(temporaryRoot, "design/brand");
      await mkdir(brandDirectory, { recursive: true });
      await Promise.all([
        writeFile(resolve(brandDirectory, "syncaction-symbol.svg"), expectedFullSvg),
        writeFile(resolve(brandDirectory, "syncaction-symbol-small.svg"), expectedSmallSvg),
      ]);

      const rendererModule = (await import(pathToFileURL(rendererPath).href)) as {
        readonly renderExtensionIcons?: (options?: {
          readonly repositoryRoot?: string;
        }) => Promise<void>;
      };
      expect(rendererModule.renderExtensionIcons).toBeTypeOf("function");
      if (rendererModule.renderExtensionIcons === undefined) {
        throw new Error("ICON_RENDERER_EXPORT_MISSING");
      }

      await rendererModule.renderExtensionIcons({ repositoryRoot: temporaryRoot });
      for (const size of iconSizes) {
        const rendered = decodeRgbaPng(
          await readFile(resolve(temporaryRoot, `apps/extension/public/icon-${String(size)}.png`)),
        );
        const committed = decodeRgbaPng(
          readFileSync(resolve(repositoryRoot, `apps/extension/public/icon-${String(size)}.png`)),
        );

        expect({
          width: rendered.width,
          height: rendered.height,
          bitDepth: rendered.bitDepth,
          colorType: rendered.colorType,
          chunkTypes: rendered.chunkTypes,
        }).toEqual({
          width: committed.width,
          height: committed.height,
          bitDepth: committed.bitDepth,
          colorType: committed.colorType,
          chunkTypes: committed.chunkTypes,
        });
        expect(rendered.pixels).toEqual(committed.pixels);
      }
      expect(
        await readFile(
          resolve(temporaryRoot, "apps/superadmin/public/syncaction-symbol.svg"),
          "utf8",
        ),
      ).toBe(expectedFullSvg);

      const firstHashes = await hashRenderedAssets(temporaryRoot);
      await rendererModule.renderExtensionIcons({ repositoryRoot: temporaryRoot });
      expect(await hashRenderedAssets(temporaryRoot)).toEqual(firstHashes);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});

describe("strict PNG decoding", () => {
  it("rejects a payload appended after IEND", () => {
    const valid = readFileSync(resolve(repositoryRoot, "apps/extension/public/icon-16.png"));
    const appended = Buffer.concat([valid, Buffer.from("unexpected")]);

    expect(() => decodeRgbaPng(appended)).toThrowError("PNG_TRAILING_DATA");
  });

  it("rejects a nonzero IEND length deterministically", () => {
    const valid = readFileSync(resolve(repositoryRoot, "apps/extension/public/icon-16.png"));
    const malformed = Buffer.from(valid);
    const iendOffset = findPngChunkOffset(malformed, "IEND");
    malformed.writeUInt32BE(1, iendOffset);

    expect(() => decodeRgbaPng(malformed)).toThrowError("PNG_IEND_LENGTH_INVALID:1");
  });

  it("rejects a missing or truncated IEND", () => {
    const valid = readFileSync(resolve(repositoryRoot, "apps/extension/public/icon-16.png"));
    const iendOffset = findPngChunkOffset(valid, "IEND");

    expect(() => decodeRgbaPng(valid.subarray(0, iendOffset))).toThrowError("PNG_IEND_MISSING");
    expect(() => decodeRgbaPng(valid.subarray(0, valid.length - 1))).toThrowError(
      "PNG_CHUNK_BOUNDS_INVALID:IEND",
    );
  });
});

describe("extension icon manifest contract", () => {
  it("maps every required size for both extension and toolbar artwork", () => {
    const expectedIcons = {
      16: "icon-16.png",
      32: "icon-32.png",
      48: "icon-48.png",
      128: "icon-128.png",
    };

    expect(config.manifest).toBeTypeOf("object");
    expect(config.manifest).toMatchObject({
      permissions: ["scripting", "storage", "unlimitedStorage", "tabs", "tabGroups", "sidePanel"],
      icons: expectedIcons,
      action: {
        default_icon: expectedIcons,
      },
    });
  });
});

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly chunkTypes: readonly string[];
  readonly pixels: Buffer;
}

function decodeRgbaPng(file: Buffer): DecodedPng {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(file.subarray(0, signature.length)).toEqual(signature);

  let offset = signature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let foundEnd = false;
  const chunkTypes: string[] = [];
  const compressedParts: Buffer[] = [];
  while (offset < file.length) {
    if (offset + 8 > file.length) {
      throw new Error("PNG_CHUNK_HEADER_TRUNCATED");
    }
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND" && length !== 0) {
      throw new Error(`PNG_IEND_LENGTH_INVALID:${String(length)}`);
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > file.length - dataStart - 4) {
      throw new Error(`PNG_CHUNK_BOUNDS_INVALID:${type}`);
    }
    const data = file.subarray(dataStart, dataEnd);
    chunkTypes.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      expect(data[10]).toBe(0);
      expect(data[11]).toBe(0);
      expect(data[12]).toBe(0);
    } else if (type === "IDAT") {
      compressedParts.push(data);
    } else if (type === "IEND") {
      foundEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }
  if (!foundEnd) {
    throw new Error("PNG_IEND_MISSING");
  }
  if (offset !== file.length) {
    throw new Error("PNG_TRAILING_DATA");
  }

  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(compressedParts.length).toBeGreaterThan(0);
  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(compressedParts));
  expect(filtered).toHaveLength((stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);

  for (let row = 0; row < height; row += 1) {
    const filterOffset = row * (stride + 1);
    const filterType = filtered[filterOffset] ?? 255;
    const sourceOffset = filterOffset + 1;
    const outputOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[sourceOffset + column] ?? 0;
      const left =
        column >= bytesPerPixel ? (pixels[outputOffset + column - bytesPerPixel] ?? 0) : 0;
      const up = row > 0 ? (pixels[outputOffset + column - stride] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? (pixels[outputOffset + column - stride - bytesPerPixel] ?? 0)
          : 0;
      pixels[outputOffset + column] = unfilterByte(filterType, raw, left, up, upperLeft);
    }
  }

  return { width, height, bitDepth, colorType, chunkTypes, pixels };
}

async function hashRenderedAssets(root: string): Promise<Readonly<Record<string, string>>> {
  const relativePaths = [
    ...iconSizes.map((size) => `apps/extension/public/icon-${String(size)}.png`),
    "apps/superadmin/public/syncaction-symbol.svg",
  ];
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => [
      relativePath,
      createHash("sha256")
        .update(await readFile(resolve(root, relativePath)))
        .digest("hex"),
    ]),
  );
  return Object.fromEntries(entries);
}

function findPngChunkOffset(file: Buffer, expectedType: string): number {
  let offset = 8;
  while (offset + 12 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    if (type === expectedType) {
      return offset;
    }
    offset += length + 12;
  }
  throw new Error(`PNG_TEST_CHUNK_MISSING:${expectedType}`);
}

function unfilterByte(
  filterType: number,
  raw: number,
  left: number,
  up: number,
  upperLeft: number,
): number {
  switch (filterType) {
    case 0:
      return raw;
    case 1:
      return (raw + left) & 0xff;
    case 2:
      return (raw + up) & 0xff;
    case 3:
      return (raw + Math.floor((left + up) / 2)) & 0xff;
    case 4:
      return (raw + paethPredictor(left, up, upperLeft)) & 0xff;
    default:
      throw new Error(`PNG_FILTER_UNSUPPORTED:${String(filterType)}`);
  }
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}
