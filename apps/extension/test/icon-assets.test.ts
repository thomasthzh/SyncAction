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

const monochromeSvgPath = resolve(repositoryRoot, "design/brand/syncaction-symbol-monochrome.svg");
const siteSvgPath = resolve(repositoryRoot, "site/assets/syncaction-symbol-v4.svg");
const siteSmallSvgPath = resolve(repositoryRoot, "site/assets/syncaction-symbol-small-v4.svg");
const siteMonochromeSvgPath = resolve(
  repositoryRoot,
  "site/assets/syncaction-symbol-monochrome-v4.svg",
);
const lightSvgPath = resolve(repositoryRoot, "design/brand/syncaction-symbol-light.svg");
const siteLightSvgPath = resolve(repositoryRoot, "site/assets/syncaction-symbol-light-v4.svg");
const expectedLightSvg = readFileSync(lightSvgPath, "utf8");
const expectedFullSvg = readFileSync(fullSvgPath, "utf8");
const expectedSmallSvg = readFileSync(smallSvgPath, "utf8");
const expectedMonochromeSvg = readFileSync(monochromeSvgPath, "utf8");

describe("SyncAction brand icon sources", () => {
  it("keeps the vNext logo bound to the generated brand master instead of copied JSX geometry", () => {
    expect(existsSync(vnextIconSourcePath)).toBe(true);
    const source = existsSync(vnextIconSourcePath) ? readFileSync(vnextIconSourcePath, "utf8") : "";
    expect(source).toContain('data-brand-source="design/brand/syncaction-symbol.svg"');
    expect(source).toContain('src="/icon-32.png"');
  });

  it("pins the reviewed Duet masters and website variants", () => {
    expect(createHash("sha256").update(expectedFullSvg).digest("hex")).toBe(
      "ca839f38fa0b42560a0468b08fac6d5c7cc30f399d3580c14cf00cd3eee4b862",
    );
    expect(createHash("sha256").update(expectedSmallSvg).digest("hex")).toBe(
      "ecad810a65de3b3341c0bbace85354cbcc21d65d2c232d4e10e2ea378edc6a3b",
    );
    expect(createHash("sha256").update(expectedMonochromeSvg).digest("hex")).toBe(
      "093e3dd087aea8c0c05f23486964d3932a7d26a5f2806f7b43062851bab3edc5",
    );
    expect(createHash("sha256").update(expectedLightSvg).digest("hex")).toBe(
      "c0ba5404eac233ff3a1bd36c846c4948c3e22a1eca9ca40b21f9d7a1e7f9a2ff",
    );
    expect(readFileSync(siteLightSvgPath, "utf8")).toBe(expectedLightSvg);
    expect(readFileSync(superadminSvgPath, "utf8")).toBe(expectedFullSvg);
    expect(readFileSync(siteSvgPath, "utf8")).toBe(expectedFullSvg);
    expect(readFileSync(siteSmallSvgPath, "utf8")).toBe(expectedSmallSvg);
    expect(readFileSync(siteMonochromeSvgPath, "utf8")).toBe(expectedMonochromeSvg);
    expect(readFileSync(rendererPath, "utf8").length).toBeGreaterThan(0);
  });

  it.each([
    ["full", fullSvgPath, true],
    ["small", smallSvgPath, false],
    ["monochrome", monochromeSvgPath, false],
    ["light", lightSvgPath, false],
  ] as const)("%s master uses two safe open local vector tracks", (variant, path, usesGradient) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain('viewBox="0 0 128 128"');
    expect(source).not.toMatch(
      /<(?:text|image|script|foreignObject|metadata|font|use)\b|@font-face|(?:data:|javascript:|file:)/iu,
    );
    expect(source.match(/https?:\/\/[^\s"')]+/gu)).toEqual(["http://www.w3.org/2000/svg"]);
    expect(source.match(/<path\b/gu)).toHaveLength(2);
    expect(source).toContain('fill="none"');
    expect(source).toContain('stroke-linecap="round"');
    expect(source).not.toMatch(/<(?:rect|polygon|circle)\b/iu);
    expect(source.includes("<linearGradient")).toBe(usesGradient);
    if (variant === "monochrome") expect(source.match(/stroke="currentColor"/gu)).toHaveLength(2);
    if (variant === "small") expect(source).toContain('stroke-width="22"');
  });

  it("embeds the same current mark in the social cover", () => {
    const source = readFileSync(resolve(repositoryRoot, "site/assets/social-cover.svg"), "utf8");
    expect(source).toContain(
      expectedFullSvg.replace(
        /<svg\b[^>]*>/u,
        '<svg x="64" y="56" width="48" height="48" viewBox="0 0 128 128">',
      ),
    );
    expect(source).not.toContain('d="M88 80v13l11-6.5Z"');
  });
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
    let graphitePixels = 0;
    let bluePixels = 0;
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
      if (alpha >= 192) {
        foregroundPixels += 1;
        if (red < 110 && green < 120 && blue < 140) graphitePixels += 1;
        if (blue >= 180 && blue > red + 60 && blue > green + 30) bluePixels += 1;
      }
    }

    expect(visiblePixels).toBeGreaterThan(0);
    expect(transparentPixels).toBeGreaterThanOrEqual(Math.floor(size * size * 0.5));
    expect(foregroundPixels).toBeGreaterThanOrEqual(Math.floor(size * size * 0.2));
    expect(graphitePixels).toBeGreaterThanOrEqual(Math.floor(size * size * 0.08));
    expect(bluePixels).toBeGreaterThanOrEqual(Math.floor(size * size * 0.08));
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
      [size / 2, size / 2],
    ] as const) {
      expect(png.pixels[(y * size + x) * 4 + 3]).toBe(0);
    }
  });

  it("uses the real renderer to reproduce committed pixels and local deterministic bytes", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "syncaction-icon-renderer-"));
    try {
      const brandDirectory = resolve(temporaryRoot, "design/brand");
      await mkdir(brandDirectory, { recursive: true });
      await Promise.all([
        writeFile(resolve(brandDirectory, "syncaction-symbol.svg"), expectedFullSvg),
        writeFile(resolve(brandDirectory, "syncaction-symbol-light.svg"), expectedLightSvg),
        writeFile(resolve(brandDirectory, "syncaction-symbol-small.svg"), expectedSmallSvg),
        writeFile(
          resolve(brandDirectory, "syncaction-symbol-monochrome.svg"),
          expectedMonochromeSvg,
        ),
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
      expect(
        await readFile(resolve(temporaryRoot, "site/assets/syncaction-symbol-v4.svg"), "utf8"),
      ).toBe(expectedFullSvg);
      expect(
        await readFile(
          resolve(temporaryRoot, "site/assets/syncaction-symbol-small-v4.svg"),
          "utf8",
        ),
      ).toBe(expectedSmallSvg);
      expect(
        await readFile(
          resolve(temporaryRoot, "site/assets/syncaction-symbol-monochrome-v4.svg"),
          "utf8",
        ),
      ).toBe(expectedMonochromeSvg);

      expect(
        await readFile(
          resolve(temporaryRoot, "site/assets/syncaction-symbol-light-v4.svg"),
          "utf8",
        ),
      ).toBe(expectedLightSvg);
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
    "site/assets/syncaction-symbol-v4.svg",
    "site/assets/syncaction-symbol-small-v4.svg",
    "site/assets/syncaction-symbol-monochrome-v4.svg",
    "site/assets/syncaction-symbol-light-v4.svg",
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
