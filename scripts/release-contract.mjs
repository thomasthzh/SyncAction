import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { strFromU8, zipSync } from "fflate";

const strictReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const lowercaseSha256 = /^[0-9a-f]{64}$/u;
const productionOriginPattern = "https://syncaction.example.com/*";
const sidepanelBackgroundRequiredSince = [0, 9, 5];
const sidepanelBackgroundSha256 =
  "8d042daf646f51c6b995c0aaffc9e5e84646eb8db46d5df46379a23f3384a7ee";

const serverBasePaths = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "eslint.config.mjs",
  "prettier.config.mjs",
  "vitest.config.ts",
  "vitest.integration.config.ts",
  ".dockerignore",
  ".prettierignore",
  "apps/server",
  "apps/superadmin",
  "packages",
  "infra/Dockerfile",
  "infra/compose.local.yml",
  "infra/compose.test.yml",
  "infra/scripts/production-config-contract.ts",
  "scripts/bootstrap-local-admin.mjs",
  "scripts/local-integration-runtime.test.mjs",
  "scripts/local-runtime.mjs",
  "scripts/run-integration-tests.mjs",
  "scripts/start-local-services.mjs",
  "README.md",
  "LICENSE",
  "docs/server.md",
]);

function assertReleaseVersion(version) {
  if (typeof version !== "string" || !strictReleaseVersion.test(version)) {
    throw new Error("RELEASE_VERSION_INVALID");
  }
}

export function releaseAssetNames(version) {
  assertReleaseVersion(version);
  return {
    chrome: `SyncAction-client-chrome-v${version}.zip`,
    edge: `SyncAction-client-edge-v${version}.zip`,
    server: `SyncAction-server-v${version}.tar.gz`,
    checksums: "SHA256SUMS.txt",
  };
}

export function resolveReleaseVersion(rootVersion, requestedVersion) {
  assertReleaseVersion(rootVersion);
  if (requestedVersion !== undefined && requestedVersion !== rootVersion) {
    throw new Error("RELEASE_VERSION_ARGUMENT_MISMATCH");
  }
  return rootVersion;
}

export function pnpmInvocation(arguments_, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
    throw new Error("RELEASE_COMMAND_ARGUMENT_INVALID");
  }
  if (platform !== "win32") {
    return { command: "pnpm", arguments: [...arguments_] };
  }
  if (arguments_.some((argument) => !/^[A-Za-z0-9@._/:=-]+$/u.test(argument))) {
    throw new Error("RELEASE_COMMAND_ARGUMENT_INVALID");
  }
  const comspec =
    typeof options.comspec === "string" && options.comspec.length > 0 ? options.comspec : "cmd.exe";
  return {
    command: comspec,
    arguments: ["/d", "/s", "/c", `pnpm ${arguments_.join(" ")}`],
  };
}

export function createDeterministicExtensionZip(entries) {
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new Error("EXTENSION_ARCHIVE_ENTRIES_INVALID");
  }
  const sortedEntries = {};
  for (const [name, bytes] of Object.entries(entries).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("EXTENSION_ARCHIVE_ENTRY_INVALID");
    }
    sortedEntries[name] = bytes;
  }
  return zipSync(sortedEntries, {
    level: 9,
    mtime: new Date(1980, 0, 1, 0, 0, 0),
  });
}

export function validateExtensionArchive(entries, manifest, version) {
  assertReleaseVersion(version);
  const archiveEntries =
    typeof entries === "object" && entries !== null && !Array.isArray(entries) ? entries : null;
  const entryNames = Array.isArray(entries)
    ? entries
    : archiveEntries === null
      ? []
      : Object.keys(archiveEntries);
  if (!entryNames.includes("manifest.json")) {
    throw new Error("EXTENSION_ROOT_MANIFEST_MISSING");
  }
  for (const entry of entryNames) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.includes("\\") ||
      entry.startsWith("/") ||
      entry.split("/").includes("..")
    ) {
      throw new Error("EXTENSION_ARCHIVE_PATH_INVALID");
    }
    if (entry.toLowerCase().endsWith(".map")) {
      throw new Error("EXTENSION_SOURCE_MAP_FORBIDDEN");
    }
    if (!extensionArchiveEntryAllowed(entry)) {
      throw new Error(`EXTENSION_ARCHIVE_ENTRY_FORBIDDEN:${entry}`);
    }
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("EXTENSION_MANIFEST_INVALID");
  }
  if (manifest.manifest_version !== 3) {
    throw new Error("EXTENSION_MANIFEST_VERSION_INVALID");
  }
  if (manifest.version !== version) {
    throw new Error("EXTENSION_VERSION_MISMATCH");
  }
  if (
    !Array.isArray(manifest.host_permissions) ||
    manifest.host_permissions.length !== 1 ||
    manifest.host_permissions[0] !== productionOriginPattern
  ) {
    throw new Error("EXTENSION_HOST_PERMISSIONS_INVALID");
  }
  if (
    !Array.isArray(manifest.optional_host_permissions) ||
    manifest.optional_host_permissions.length !== 2 ||
    !manifest.optional_host_permissions.includes("http://*/*") ||
    !manifest.optional_host_permissions.includes("https://*/*")
  ) {
    throw new Error("EXTENSION_OPTIONAL_HOST_PERMISSIONS_INVALID");
  }
  const serializedManifest = JSON.stringify(manifest).toLowerCase();
  if (
    serializedManifest.includes("://localhost") ||
    serializedManifest.includes("://127.0.0.1") ||
    serializedManifest.includes("://[::1]")
  ) {
    throw new Error("EXTENSION_LOCAL_ORIGIN_FORBIDDEN");
  }
  if (archiveEntries !== null) {
    for (const [name, bytes] of Object.entries(archiveEntries)) {
      if (!(bytes instanceof Uint8Array)) {
        throw new Error(`EXTENSION_ARCHIVE_ENTRY_INVALID:${name}`);
      }
      if (!/\.(?:css|html|js|json)$/iu.test(name)) {
        continue;
      }
      const content = strFromU8(bytes);
      if (/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/])/iu.test(content)) {
        throw new Error("EXTENSION_LOCAL_ORIGIN_FORBIDDEN");
      }
      if (
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(content) ||
        /postgres(?:ql)?:\/\/[^\s"'`]+/iu.test(content) ||
        /SYNC_ACTION_(?:ACCESS_TOKEN_SECRET|ADMIN_BOOTSTRAP_PASSWORD|ADMIN_TOTP_ENCRYPTION_KEY|ANNOTATION_HMAC_KEY|DATABASE_URL|POSTGRES_PASSWORD)/u.test(
          content,
        )
      ) {
        throw new Error("EXTENSION_SENSITIVE_CONTENT_FORBIDDEN");
      }
    }
    const privacyBytes = archiveEntries["privacy.html"];
    if (!(privacyBytes instanceof Uint8Array)) {
      throw new Error("EXTENSION_PRIVACY_PAGE_MISSING");
    }
    validatePrivacyPage(strFromU8(privacyBytes));
    const sidepanelBackgroundBytes = archiveEntries["sidepanel-background.svg"];
    if (!(sidepanelBackgroundBytes instanceof Uint8Array)) {
      if (releaseVersionAtLeast(version, sidepanelBackgroundRequiredSince)) {
        throw new Error("EXTENSION_SIDEPANEL_BACKGROUND_MISSING");
      }
    } else {
      if (
        releaseVersionAtLeast(version, sidepanelBackgroundRequiredSince) &&
        createHash("sha256").update(sidepanelBackgroundBytes).digest("hex") !==
          sidepanelBackgroundSha256
      ) {
        throw new Error("EXTENSION_SIDEPANEL_BACKGROUND_MISMATCH");
      }
      validateSidepanelBackground(strFromU8(sidepanelBackgroundBytes));
    }
  } else if (!entryNames.includes("privacy.html")) {
    throw new Error("EXTENSION_PRIVACY_PAGE_MISSING");
  }
}

function validatePrivacyPage(content) {
  if (
    typeof content !== "string" ||
    !content.includes("SyncAction 页面协作隐私说明") ||
    !content.includes("披露版本 1") ||
    /<\s*(?:script|form|iframe)\b/iu.test(content) ||
    /\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//iu.test(content)
  ) {
    throw new Error("EXTENSION_PRIVACY_PAGE_INVALID");
  }
}

function validateSidepanelBackground(content) {
  if (
    typeof content !== "string" ||
    content.length > 16_384 ||
    !/^\s*<svg\b[^>]*\bviewBox=["']0 0 480 1200["']/iu.test(content) ||
    !/<\/svg>\s*$/iu.test(content) ||
    /<\s*(?:animate(?:Motion|Transform)?|filter|foreignObject|image|mpath|script|set|style|text|use)\b/iu.test(
      content,
    ) ||
    /\b(?:href|src|on[a-z]+)\s*=/iu.test(content) ||
    /<\?(?:xml-stylesheet)|<!DOCTYPE|url\(\s*["']?\s*(?:data:|https?:|\/\/)/iu.test(content)
  ) {
    throw new Error("EXTENSION_SIDEPANEL_BACKGROUND_INVALID");
  }
}

function releaseVersionAtLeast(version, minimum) {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] !== minimum[index]) {
      return parts[index] > minimum[index];
    }
  }
  return true;
}

function extensionArchiveEntryAllowed(entry) {
  if (
    new Set([
      "assets/",
      "background.js",
      "chunks/",
      "content-scripts/",
      "icon-16.png",
      "icon-32.png",
      "icon-48.png",
      "icon-128.png",
      "manifest.json",
      "page-collaboration.js",
      "privacy.html",
      "sidepanel-background.svg",
      "sidepanel.html",
    ]).has(entry)
  ) {
    return true;
  }
  return /^(?:assets\/[A-Za-z0-9_-]+\.css|chunks\/[A-Za-z0-9_.-]+\.js|content-scripts\/[A-Za-z0-9_.-]+\.js)$/u.test(
    entry,
  );
}

export function serverArchivePaths(version) {
  assertReleaseVersion(version);
  return [...serverBasePaths, releaseNotesRelativePath(version)];
}

export function createServerPackageJson(rootPackage) {
  const scripts = { ...rootPackage.scripts };
  for (const name of ["icons:build", "local:client:chrome", "local:client:edge", "release:build"]) {
    delete scripts[name];
  }
  scripts["test:tooling"] = "node --test scripts/local-integration-runtime.test.mjs";
  return `${JSON.stringify({ ...rootPackage, scripts }, null, 2)}\n`;
}

export async function requireReleaseNotes(repositoryRoot, version, read = readFile) {
  const relativePath = releaseNotesRelativePath(version);
  let content;
  try {
    content = await read(join(repositoryRoot, relativePath), "utf8");
  } catch {
    throw new Error("RELEASE_NOTES_MISSING");
  }
  if (
    typeof content !== "string" ||
    !content.startsWith(`# SyncAction v${version}\n`) ||
    content.trim().length < 100
  ) {
    throw new Error("RELEASE_NOTES_INVALID");
  }
  return relativePath;
}

export function serverArchiveEntryAllowed(path, type, allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return false;
  }
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    return false;
  }
  const segments = path.split("/");
  const forbiddenSegments = new Set([
    ".git",
    ".local",
    ".output",
    ".wxt",
    ".release-artifacts",
    "node_modules",
    "backups",
    "coverage",
    "dist",
    "playwright-report",
    "test-results",
  ]);
  if (
    !["0", "5"].includes(type) ||
    segments.some((segment) => forbiddenSegments.has(segment)) ||
    path.toLowerCase().endsWith(".map") ||
    path === "apps/extension" ||
    path.startsWith("apps/extension/") ||
    segments.at(-1) === ".env" ||
    segments.at(-1)?.startsWith(".env.")
  ) {
    return false;
  }
  if (
    allowedPaths.some((allowedPath) => path === allowedPath || path.startsWith(`${allowedPath}/`))
  ) {
    return true;
  }
  return type === "5" && allowedPaths.some((allowedPath) => allowedPath.startsWith(`${path}/`));
}

export function formatSha256Sums(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("RELEASE_CHECKSUM_RECORDS_INVALID");
  }
  const seenNames = new Set();
  const validated = records.map((record) => {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.name !== "string" ||
      record.name.length === 0 ||
      record.name === "." ||
      record.name === ".." ||
      record.name.includes("/") ||
      record.name.includes("\\") ||
      seenNames.has(record.name)
    ) {
      throw new Error("RELEASE_ASSET_NAME_INVALID");
    }
    if (typeof record.sha256 !== "string" || !lowercaseSha256.test(record.sha256)) {
      throw new Error("RELEASE_SHA256_INVALID");
    }
    seenNames.add(record.name);
    return { name: record.name, sha256: record.sha256 };
  });
  validated.sort((left, right) => left.name.localeCompare(right.name, "en"));
  return `${validated.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function releaseNotesRelativePath(version) {
  assertReleaseVersion(version);
  return `docs/releases/v${version}.md`;
}
