import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFile, mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import {
  createDeterministicExtensionZip,
  createServerPackageJson,
  formatSha256Sums,
  pnpmInvocation,
  releaseAssetNames,
  requireReleaseNotes,
  resolveReleaseVersion,
  serverArchiveEntryAllowed,
  serverArchivePaths,
  sha256File,
  validateExtensionArchive,
} from "./release-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const requestedVersion = resolveReleaseVersion(rootPackage.version, process.argv[2]);
const packageFiles = [
  "package.json",
  "apps/extension/package.json",
  "apps/server/package.json",
  "apps/superadmin/package.json",
];

const names = releaseAssetNames(requestedVersion);
await verifyPackageVersions(requestedVersion);
const releasePaths = serverArchivePaths(requestedVersion);
await requireReleaseNotes(repositoryRoot, requestedVersion);
const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
if (!/^[0-9a-f]{40}$/u.test(commit)) {
  throw new Error("RELEASE_COMMIT_INVALID");
}
const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  capture: true,
});
if (status.trim() !== "") {
  throw new Error("RELEASE_WORKTREE_NOT_CLEAN");
}

const artifactsRoot = resolve(repositoryRoot, ".release-artifacts");
const outputDirectory = resolve(artifactsRoot, `v${requestedVersion}`);
if (
  relative(artifactsRoot, outputDirectory).startsWith("..") ||
  outputDirectory === artifactsRoot
) {
  throw new Error("RELEASE_OUTPUT_BOUNDARY_INVALID");
}
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await runPnpm(["--filter", "@syncaction/extension", "zip"]);
await runPnpm(["--filter", "@syncaction/extension", "zip:edge"]);

const wxtOutput = join(repositoryRoot, "apps", "extension", ".output");
const clientAssets = [
  {
    source: join(wxtOutput, `syncactionextension-${requestedVersion}-chrome.zip`),
    destination: join(outputDirectory, names.chrome),
  },
  {
    source: join(wxtOutput, `syncactionextension-${requestedVersion}-edge.zip`),
    destination: join(outputDirectory, names.edge),
  },
];
for (const asset of clientAssets) {
  await copyFile(asset.source, asset.destination);
  await normalizeAndValidateClientZip(asset.destination, requestedVersion);
}

const serverAsset = join(outputDirectory, names.server);
const archivePrefix = `SyncAction-server-v${requestedVersion}/`;
await run("git", [
  "archive",
  "--format=tar.gz",
  `--prefix=${archivePrefix}`,
  `--output=${serverAsset}`,
  `--add-virtual-file=${archivePrefix}package.json:${createServerPackageJson(rootPackage)}`,
  "HEAD",
  ...releasePaths.filter((path) => path !== "package.json"),
]);
await validateServerArchive(serverAsset, archivePrefix, releasePaths);

const records = [];
for (const name of [names.chrome, names.edge, names.server]) {
  records.push({
    name,
    sha256: await sha256File(join(outputDirectory, name)),
  });
}
await writeFile(join(outputDirectory, names.checksums), formatSha256Sums(records), "utf8");

process.stdout.write(`SyncAction v${requestedVersion}\n`);
process.stdout.write(`commit ${commit}\n`);
for (const record of records) {
  process.stdout.write(`${record.sha256}  ${join(outputDirectory, record.name)}\n`);
}
process.stdout.write(`${join(outputDirectory, names.checksums)}\n`);

async function verifyPackageVersions(version) {
  for (const packageFile of packageFiles) {
    const parsed = JSON.parse(await readFile(join(repositoryRoot, packageFile), "utf8"));
    if (parsed.version !== version) {
      throw new Error(`RELEASE_PACKAGE_VERSION_MISMATCH:${packageFile}`);
    }
  }
}

async function normalizeAndValidateClientZip(path, version) {
  const entries = unzipSync(new Uint8Array(await readFile(path)));
  const manifestBytes = entries["manifest.json"];
  if (manifestBytes === undefined) {
    validateExtensionArchive(entries, null, version);
    return;
  }
  const manifest = JSON.parse(strFromU8(manifestBytes));
  validateExtensionArchive(entries, manifest, version);
  await writeFile(path, createDeterministicExtensionZip(entries));
  const normalizedEntries = unzipSync(new Uint8Array(await readFile(path)));
  const normalizedManifestBytes = normalizedEntries["manifest.json"];
  if (normalizedManifestBytes === undefined) {
    throw new Error("EXTENSION_ROOT_MANIFEST_MISSING");
  }
  validateExtensionArchive(
    normalizedEntries,
    JSON.parse(strFromU8(normalizedManifestBytes)),
    version,
  );
}

async function validateServerArchive(path, prefix, allowedPaths) {
  const archive = gunzipSync(await readFile(path));
  const entries = listTarEntries(archive);
  const contentEntries = entries.filter((entry) => !["g", "x", "L", "K"].includes(entry.type));
  if (contentEntries.length === 0) {
    throw new Error("SERVER_ARCHIVE_EMPTY");
  }
  for (const entry of contentEntries) {
    if (!entry.name.startsWith(prefix)) {
      throw new Error(`SERVER_ARCHIVE_PREFIX_INVALID:${entry.name}`);
    }
    const unprefixed = entry.name.slice(prefix.length).replace(/\/$/u, "");
    if (unprefixed === "") {
      continue;
    }
    if (!serverArchiveEntryAllowed(unprefixed, entry.type, allowedPaths)) {
      throw new Error(`SERVER_ARCHIVE_PATH_FORBIDDEN:${unprefixed}`);
    }
  }
  const entryNames = new Set(contentEntries.map((entry) => entry.name.replace(/\/$/u, "")));
  for (const required of [
    `${prefix}package.json`,
    `${prefix}apps/server/package.json`,
    `${prefix}apps/superadmin/package.json`,
    `${prefix}infra/Dockerfile`,
    `${prefix}LICENSE`,
    `${prefix}docs/server.md`,
  ]) {
    if (!entryNames.has(required)) {
      throw new Error(`SERVER_ARCHIVE_REQUIRED_PATH_MISSING:${required}`);
    }
  }
  if ([...entryNames].some((name) => name.includes("/apps/extension/"))) {
    throw new Error("SERVER_ARCHIVE_CLIENT_SOURCE_FORBIDDEN");
  }
}

function listTarEntries(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const sizeText = readTarText(header, 124, 12).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("SERVER_ARCHIVE_HEADER_INVALID");
    }
    const typeByte = header[156] ?? 0;
    entries.push({
      name: prefix === "" ? name : `${prefix}/${name}`,
      type: typeByte === 0 ? "0" : String.fromCharCode(typeByte),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return Buffer.from(terminator === -1 ? field : field.subarray(0, terminator)).toString("utf8");
}

function runPnpm(arguments_) {
  const invocation = pnpmInvocation(arguments_, {
    platform: process.platform,
    comspec: process.env.ComSpec,
  });
  return run(invocation.command, invocation.arguments);
}

function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    if (options.capture && child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(new Error(`RELEASE_COMMAND_FAILED:${command}:${String(code)}`));
      }
    });
  });
}
