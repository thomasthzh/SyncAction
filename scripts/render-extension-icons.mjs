import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceSize = 128;
const iconSizes = [16, 32, 48, 128];

export async function renderExtensionIcons(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const fullSourcePath = resolve(repositoryRoot, "design/brand/syncaction-symbol.svg");
  const smallSourcePath = resolve(repositoryRoot, "design/brand/syncaction-symbol-small.svg");
  const extensionPublicPath = resolve(repositoryRoot, "apps/extension/public");
  const superadminPublicPath = resolve(repositoryRoot, "apps/superadmin/public");
  const [fullSource, smallSource] = await Promise.all([
    readFile(fullSourcePath),
    readFile(smallSourcePath),
  ]);

  await Promise.all([
    assertSvgSource(fullSourcePath, fullSource),
    assertSvgSource(smallSourcePath, smallSource),
  ]);

  let stagingPath;
  try {
    stagingPath = await mkdtemp(resolve(repositoryRoot, ".syncaction-icons-"));
    const stagedExtensionPath = resolve(stagingPath, "extension");
    const stagedSuperadminPath = resolve(stagingPath, "superadmin");
    await Promise.all([
      mkdir(stagedExtensionPath, { recursive: true }),
      mkdir(stagedSuperadminPath, { recursive: true }),
    ]);

    const stagedIcons = [];
    for (const size of iconSizes) {
      const source = size <= 32 ? smallSource : fullSource;
      const stagedPath = resolve(stagedExtensionPath, `icon-${String(size)}.png`);
      const { data, info } = await sharp(source)
        .resize({
          width: size,
          height: size,
          fit: "contain",
        })
        .ensureAlpha()
        .png({
          adaptiveFiltering: false,
          compressionLevel: 9,
          effort: 10,
          palette: false,
        })
        .toBuffer({ resolveWithObject: true });

      assertDimensions(stagedPath, info.width, info.height, size);
      if (info.format !== "png" || info.channels !== 4) {
        throw new Error(
          `ICON_OUTPUT_FORMAT_INVALID:${stagedPath}:${info.format}:${String(info.channels)}`,
        );
      }
      await writeFile(stagedPath, stripPngAncillaryChunks(data));
      stagedIcons.push({ size, stagedPath });
    }

    const stagedSuperadminSvg = resolve(stagedSuperadminPath, "syncaction-symbol.svg");
    await writeFile(stagedSuperadminSvg, fullSource);

    await Promise.all(
      stagedIcons.map(({ size, stagedPath }) => assertRenderedPng(stagedPath, size)),
    );
    const stagedSvg = await readFile(stagedSuperadminSvg);
    if (!stagedSvg.equals(fullSource)) {
      throw new Error("ICON_ADMIN_SVG_MISMATCH");
    }

    await Promise.all([
      mkdir(extensionPublicPath, { recursive: true }),
      mkdir(superadminPublicPath, { recursive: true }),
    ]);
    for (const { size, stagedPath } of stagedIcons) {
      await rename(stagedPath, resolve(extensionPublicPath, `icon-${String(size)}.png`));
    }
    await rename(stagedSuperadminSvg, resolve(superadminPublicPath, "syncaction-symbol.svg"));
  } finally {
    if (stagingPath !== undefined) {
      await rm(stagingPath, { force: true, recursive: true });
    }
  }
}

async function assertSvgSource(path, source) {
  const metadata = await sharp(source).metadata();
  assertDimensions(path, metadata.width, metadata.height, sourceSize);
  if (metadata.format !== "svg") {
    throw new Error(`ICON_SOURCE_FORMAT_INVALID:${path}:${String(metadata.format)}`);
  }
}

async function assertRenderedPng(path, expectedSize) {
  const metadata = await sharp(path).metadata();
  assertDimensions(path, metadata.width, metadata.height, expectedSize);
  if (
    metadata.format !== "png" ||
    metadata.channels !== 4 ||
    metadata.depth !== "uchar" ||
    metadata.hasAlpha !== true
  ) {
    throw new Error(
      `ICON_OUTPUT_FORMAT_INVALID:${path}:${String(metadata.format)}:${String(metadata.channels)}:${String(metadata.depth)}:${String(metadata.hasAlpha)}`,
    );
  }
  const data = await readFile(path);
  if (!stripPngAncillaryChunks(data).equals(data)) {
    throw new Error(`ICON_OUTPUT_METADATA_PRESENT:${path}`);
  }
}

function assertDimensions(path, width, height, expectedSize) {
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(
      `ICON_DIMENSIONS_INVALID:${path}:${String(width)}x${String(height)}:${String(expectedSize)}x${String(expectedSize)}`,
    );
  }
}

function stripPngAncillaryChunks(data) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!data.subarray(0, signature.length).equals(signature)) {
    throw new Error("ICON_OUTPUT_PNG_SIGNATURE_INVALID");
  }

  const outputParts = [data.subarray(0, signature.length)];
  let offset = signature.length;
  let foundEnd = false;
  while (offset < data.length) {
    if (offset + 8 > data.length) {
      throw new Error("ICON_OUTPUT_PNG_CHUNK_HEADER_TRUNCATED");
    }
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND" && length !== 0) {
      throw new Error(`ICON_OUTPUT_PNG_IEND_LENGTH_INVALID:${String(length)}`);
    }
    const dataStart = offset + 8;
    const chunkEnd = dataStart + length + 4;
    if (length > data.length - dataStart - 4) {
      throw new Error(`ICON_OUTPUT_PNG_CHUNK_INVALID:${type}`);
    }
    if (type === "IHDR" || type === "IDAT" || type === "IEND") {
      outputParts.push(data.subarray(offset, chunkEnd));
    } else if (/^[A-Z]/u.test(type)) {
      throw new Error(`ICON_OUTPUT_PNG_CRITICAL_CHUNK_UNEXPECTED:${type}`);
    }
    offset = chunkEnd;
    if (type === "IEND") {
      foundEnd = true;
      break;
    }
  }
  if (!foundEnd || offset !== data.length) {
    throw new Error("ICON_OUTPUT_PNG_END_INVALID");
  }
  return Buffer.concat(outputParts);
}

function isDirectExecution() {
  const invokedPath = argv[1];
  return invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url;
}

if (isDirectExecution()) {
  await renderExtensionIcons();
}
