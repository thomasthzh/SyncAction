import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";
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

const productionOriginPattern = "https://syncaction.example.com/*";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privacyBytes = new TextEncoder().encode(`<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>SyncAction 页面协作隐私说明</title></head>
  <body><p>页面协作披露版本 1</p><h1>SyncAction 页面协作隐私说明</h1></body>
</html>`);

test("ESLint excludes repository-local worktrees and their generated artifacts", async () => {
  const source = await readFile(resolve(repositoryRoot, "eslint.config.mjs"), "utf8");
  assert.match(source, /["']\.worktrees\/\*\*["']/u);
});

test("Windows pnpm scripts run through ComSpec with shell-safe fixed arguments", () => {
  assert.deepEqual(
    pnpmInvocation(["--filter", "@syncaction/extension", "zip"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments: ["/d", "/s", "/c", "pnpm --filter @syncaction/extension zip"],
    },
  );
  assert.throws(
    () =>
      pnpmInvocation(["zip & whoami"], {
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      }),
    /RELEASE_COMMAND_ARGUMENT_INVALID/u,
  );
});

test("extension ZIP normalization is byte-stable regardless of input entry order", () => {
  const first = createDeterministicExtensionZip({
    "z-last.txt": new TextEncoder().encode("last"),
    "manifest.json": new TextEncoder().encode('{"version":"0.9.0"}'),
  });
  const second = createDeterministicExtensionZip({
    "manifest.json": new TextEncoder().encode('{"version":"0.9.0"}'),
    "z-last.txt": new TextEncoder().encode("last"),
  });
  assert.deepEqual(first, second);
});

test("release asset names are client/server explicit", () => {
  assert.deepEqual(releaseAssetNames("0.9.0"), {
    chrome: "SyncAction-client-chrome-v0.9.0.zip",
    edge: "SyncAction-client-edge-v0.9.0.zip",
    server: "SyncAction-server-v0.9.0.tar.gz",
    checksums: "SHA256SUMS.txt",
  });
});

test("release versions must be strict semantic triples", () => {
  for (const version of ["v0.8.1", "0.8", "0.8.1-beta.1", "01.8.1", "0.8.1.0", ""]) {
    assert.throws(() => releaseAssetNames(version), /RELEASE_VERSION_INVALID/u);
  }
});

test("release build derives its version from the root package and treats a CLI value as an assertion", async () => {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  assert.equal(resolveReleaseVersion(packageJson.version), packageJson.version);
  assert.equal(packageJson.scripts["release:build"], "node scripts/build-release.mjs");
  assert.equal(resolveReleaseVersion("0.9.0", undefined), "0.9.0");
  assert.equal(resolveReleaseVersion("0.9.0", "0.9.0"), "0.9.0");
  assert.throws(
    () => resolveReleaseVersion("0.9.0", "0.8.1"),
    /RELEASE_VERSION_ARGUMENT_MISMATCH/u,
  );
});

test("extension archives require a production root manifest", () => {
  assert.doesNotThrow(() =>
    validateExtensionArchive(
      [
        "manifest.json",
        "privacy.html",
        "background.js",
        "content-scripts/content.js",
        "icon-128.png",
      ],
      {
        manifest_version: 3,
        name: "SyncAction",
        version: "0.9.0",
        host_permissions: [productionOriginPattern],
        optional_host_permissions: ["http://*/*", "https://*/*"],
      },
      "0.9.0",
    ),
  );

  assert.throws(
    () =>
      validateExtensionArchive(
        ["SyncAction/manifest.json", "SyncAction/background.js", "privacy.html"],
        {
          manifest_version: 3,
          version: "0.9.0",
          host_permissions: [productionOriginPattern],
          optional_host_permissions: ["http://*/*", "https://*/*"],
        },
        "0.9.0",
      ),
    /EXTENSION_ROOT_MANIFEST_MISSING/u,
  );
  assert.throws(
    () =>
      validateExtensionArchive(
        ["manifest.json", "background.js", "privacy.html"],
        {
          manifest_version: 3,
          version: "0.8.0",
          host_permissions: [productionOriginPattern],
          optional_host_permissions: ["http://*/*", "https://*/*"],
        },
        "0.9.0",
      ),
    /EXTENSION_VERSION_MISMATCH/u,
  );
});

test("extension archives reject local origins, source maps, and unexpected server permissions", () => {
  const productionManifest = {
    manifest_version: 3,
    version: "0.9.0",
    host_permissions: [productionOriginPattern],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  };
  assert.throws(
    () =>
      validateExtensionArchive(
        ["manifest.json", "privacy.html", "background.js", "background.js.map"],
        productionManifest,
        "0.9.0",
      ),
    /EXTENSION_SOURCE_MAP_FORBIDDEN/u,
  );
  assert.throws(
    () =>
      validateExtensionArchive(
        ["manifest.json", "background.js", "privacy.html"],
        {
          ...productionManifest,
          host_permissions: [productionOriginPattern, "http://127.0.0.1:29373/*"],
        },
        "0.9.0",
      ),
    /EXTENSION_HOST_PERMISSIONS_INVALID/u,
  );
  assert.throws(
    () =>
      validateExtensionArchive(
        ["manifest.json", "background.js", "privacy.html"],
        {
          ...productionManifest,
          externally_connectable: { matches: ["http://localhost/*"] },
        },
        "0.9.0",
      ),
    /EXTENSION_LOCAL_ORIGIN_FORBIDDEN/u,
  );
});

test("extension archive content rejects local servers, sensitive configuration, and dev files", () => {
  const manifest = {
    manifest_version: 3,
    version: "0.9.0",
    host_permissions: [productionOriginPattern],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  assert.throws(
    () =>
      validateExtensionArchive(
        {
          "manifest.json": manifestBytes,
          "privacy.html": privacyBytes,
          "background.js": new TextEncoder().encode('fetch("http://127.0.0.1:29373/healthz")'),
        },
        manifest,
        "0.9.0",
      ),
    /EXTENSION_LOCAL_ORIGIN_FORBIDDEN/u,
  );
  assert.throws(
    () =>
      validateExtensionArchive(
        {
          "manifest.json": manifestBytes,
          "privacy.html": privacyBytes,
          "background.js": new TextEncoder().encode(
            "const key = 'SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY'",
          ),
        },
        manifest,
        "0.9.0",
      ),
    /EXTENSION_SENSITIVE_CONTENT_FORBIDDEN/u,
  );
  assert.throws(
    () =>
      validateExtensionArchive(
        {
          "manifest.json": manifestBytes,
          "privacy.html": privacyBytes,
          "background.js": new TextEncoder().encode("void 0"),
          "server/bootstrap.ts": new TextEncoder().encode("export {}"),
        },
        manifest,
        "0.9.0",
      ),
    /EXTENSION_ARCHIVE_ENTRY_FORBIDDEN/u,
  );
});

test("extension archives require a self-contained non-executable privacy disclosure", () => {
  const manifest = {
    manifest_version: 3,
    version: "0.9.0",
    host_permissions: [productionOriginPattern],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  assert.doesNotThrow(() =>
    validateExtensionArchive(
      {
        "manifest.json": manifestBytes,
        "privacy.html": privacyBytes,
        "background.js": new TextEncoder().encode("void 0"),
      },
      manifest,
      "0.9.0",
    ),
  );
  assert.throws(
    () =>
      validateExtensionArchive(
        {
          "manifest.json": manifestBytes,
          "background.js": new TextEncoder().encode("void 0"),
        },
        manifest,
        "0.9.0",
      ),
    /EXTENSION_PRIVACY_PAGE_MISSING/u,
  );
  for (const forbidden of [
    "<script>location.href='https://remote.example'</script>",
    '<img src="https://remote.example/tracker.png">',
    '<form action="/collect"></form>',
    '<iframe src="/embedded"></iframe>',
    "<p>missing required disclosure markers</p>",
  ]) {
    assert.throws(
      () =>
        validateExtensionArchive(
          {
            "manifest.json": manifestBytes,
            "privacy.html": new TextEncoder().encode(forbidden),
            "background.js": new TextEncoder().encode("void 0"),
          },
          manifest,
          "0.9.0",
        ),
      /EXTENSION_PRIVACY_PAGE_INVALID/u,
    );
  }
});

test("extension archives allow only the inert local side-panel background", () => {
  const manifest = {
    manifest_version: 3,
    version: "0.9.0",
    host_permissions: [productionOriginPattern],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const validateBackground = (background) =>
    validateExtensionArchive(
      {
        "manifest.json": manifestBytes,
        "privacy.html": privacyBytes,
        "background.js": new TextEncoder().encode("void 0"),
        "sidepanel-background.svg": new TextEncoder().encode(background),
      },
      manifest,
      "0.9.0",
    );

  assert.doesNotThrow(() =>
    validateBackground(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 1200"><path d="M0 0L1 1"/></svg>',
    ),
  );
  for (const forbidden of [
    "<svg><script>void 0</script></svg>",
    "<svg><foreignObject><p>html</p></foreignObject></svg>",
    "<svg><text>remote content</text></svg>",
    '<svg><filter id="blur"/></svg>',
    '<svg><image href="https://remote.example/background.png"/></svg>',
    '<svg viewBox="0 0 480 1200"><animateMotion dur="1s"/></svg>',
    '<svg viewBox="0 0 480 1200"><animateTransform dur="1s"/></svg>',
  ]) {
    assert.throws(() => validateBackground(forbidden), /EXTENSION_SIDEPANEL_BACKGROUND_INVALID/u);
  }
  assert.throws(
    () =>
      validateExtensionArchive(
        ["manifest.json", "privacy.html", "background.js", "decor.svg"],
        manifest,
        "0.9.0",
      ),
    /EXTENSION_ARCHIVE_ENTRY_FORBIDDEN/u,
  );
});

test("v0.9.5 and newer extension archives require the exact app-owned side-panel background", () => {
  const version = "0.9.5";
  const manifest = {
    manifest_version: 3,
    version,
    host_permissions: [productionOriginPattern],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const backgroundBytes = readFileSync(
    resolve(repositoryRoot, "apps/extension/public/sidepanel-background.svg"),
  );
  const requiredEntries = {
    "manifest.json": manifestBytes,
    "privacy.html": privacyBytes,
    "background.js": new TextEncoder().encode("void 0"),
  };

  assert.doesNotThrow(() =>
    validateExtensionArchive(
      { ...requiredEntries, "sidepanel-background.svg": backgroundBytes },
      manifest,
      version,
    ),
  );
  assert.throws(
    () => validateExtensionArchive(requiredEntries, manifest, version),
    /EXTENSION_SIDEPANEL_BACKGROUND_MISSING/u,
  );
  assert.throws(
    () =>
      validateExtensionArchive(
        {
          ...requiredEntries,
          "sidepanel-background.svg": new TextEncoder().encode(
            `${backgroundBytes.toString("utf8")}<!-- changed -->`,
          ),
        },
        manifest,
        version,
      ),
    /EXTENSION_SIDEPANEL_BACKGROUND_MISMATCH/u,
  );
});

test("server archive allow-list excludes every client and generated-data boundary", () => {
  const paths = serverArchivePaths("0.9.0");
  assert.ok(paths.includes("apps/server"));
  assert.ok(paths.includes("apps/superadmin"));
  assert.ok(paths.includes("packages"));
  assert.ok(paths.includes("infra/Dockerfile"));
  assert.ok(paths.includes("infra/compose.local.yml"));
  assert.ok(paths.includes("infra/compose.test.yml"));
  assert.ok(paths.includes("infra/scripts/production-config-contract.ts"));
  assert.equal(paths.includes("infra"), false);
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("LICENSE"));
  assert.ok(paths.includes("docs/server.md"));
  assert.ok(paths.includes("docs/releases/v0.9.0.md"));
  assert.equal(paths.includes("docs/releases/v0.8.1.md"), false);
  for (const forbidden of [
    "apps/extension",
    ".env",
    ".git",
    ".local",
    ".output",
    "node_modules",
    "backups",
    ".release-artifacts",
    "docs/private-notes.md",
    "infra/compose.production.yml",
    "scripts/local-service-supervisor.test.mjs",
  ]) {
    assert.equal(
      paths.some((path) => path === forbidden || path.startsWith(`${forbidden}/`)),
      false,
      `server allow-list contains ${forbidden}`,
    );
  }
});

test("server package commands reference only included tooling and leave the source package intact", () => {
  const source = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const original = JSON.parse(JSON.stringify(source));
  const serverPackage = JSON.parse(createServerPackageJson(source));
  const paths = serverArchivePaths(source.version);

  assert.deepEqual(source, original);
  assert.equal(serverPackage.version, source.version);
  assert.deepEqual(serverPackage.dependencies, source.dependencies);
  assert.deepEqual(serverPackage.devDependencies, source.devDependencies);
  assert.equal(
    serverPackage.scripts["test:tooling"],
    "node --test scripts/local-integration-runtime.test.mjs",
  );
  assert.equal(serverPackage.scripts.test, source.scripts.test);
  for (const name of ["icons:build", "local:client:chrome", "local:client:edge", "release:build"]) {
    assert.equal(serverPackage.scripts[name], undefined);
  }
  for (const command of Object.values(serverPackage.scripts)) {
    for (const [path] of command.matchAll(/scripts\/[A-Za-z0-9_.-]+\.mjs/gu)) {
      assert.ok(paths.includes(path), `server command references omitted ${path}`);
      assert.ok(existsSync(resolve(repositoryRoot, path)), `server tooling missing: ${path}`);
    }
  }
  for (const path of [
    "eslint.config.mjs",
    "prettier.config.mjs",
    "vitest.config.ts",
    "vitest.integration.config.ts",
  ]) {
    assert.ok(paths.includes(path), `server tooling configuration missing: ${path}`);
  }
});

test("git archive injects exactly one server-only root package under the release prefix", () => {
  const source = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const serverPackageJson = createServerPackageJson(source);
  const prefix = `SyncAction-server-v${source.version}/`;
  const result = spawnSync(
    "git",
    [
      "archive",
      "--format=tar",
      `--prefix=${prefix}`,
      `--add-virtual-file=${prefix}package.json:${serverPackageJson}`,
      "HEAD",
      "LICENSE",
    ],
    { cwd: repositoryRoot, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  const entries = new Map();
  const archive = result.stdout;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8"), 8);
    assert.equal(entries.has(name), false, `duplicate archive entry: ${name}`);
    entries.set(name, archive.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(entries.get(`${prefix}package.json`), serverPackageJson);
  assert.ok(entries.has(`${prefix}LICENSE`));
  assert.equal(entries.has("package.json"), false);
});

test("release notes are version-specific and required before packaging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "syncaction-release-notes-"));
  try {
    await assert.rejects(requireReleaseNotes(directory, "0.9.0"), /RELEASE_NOTES_MISSING/u);
    const { mkdir } = await import("node:fs/promises");
    const releaseDirectory = join(directory, "docs", "releases");
    await mkdir(releaseDirectory, { recursive: true });
    await writeFile(
      join(releaseDirectory, "v0.9.0.md"),
      `# SyncAction v0.9.0\n\n${"Release acceptance. ".repeat(10)}\n`,
      "utf8",
    );
    assert.equal(await requireReleaseNotes(directory, "0.9.0"), "docs/releases/v0.9.0.md");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("server archive permits only allow-listed content and synthesized parent directories", () => {
  const paths = serverArchivePaths("0.9.0");
  assert.equal(serverArchiveEntryAllowed("apps", "5", paths), true);
  assert.equal(serverArchiveEntryAllowed("docs/releases", "5", paths), true);
  assert.equal(serverArchiveEntryAllowed("apps", "0", paths), false);
  assert.equal(serverArchiveEntryAllowed("apps/server/src/main.ts", "0", paths), true);
  assert.equal(serverArchiveEntryAllowed("apps/extension", "5", paths), false);
  assert.equal(serverArchiveEntryAllowed("backups", "5", paths), false);
  assert.equal(serverArchiveEntryAllowed("infra/compose.local.yml", "0", paths), true);
  assert.equal(serverArchiveEntryAllowed("infra/.env.production.example", "0", paths), false);
  assert.equal(serverArchiveEntryAllowed("infra/.env.production", "0", paths), false);
  assert.equal(
    serverArchiveEntryAllowed("packages/example/node_modules/file.js", "0", paths),
    false,
  );
  assert.equal(serverArchiveEntryAllowed(".local/service-processes.json", "0", paths), false);
  assert.equal(serverArchiveEntryAllowed("packages/example/dist/index.js", "0", paths), false);
  assert.equal(serverArchiveEntryAllowed("packages/example/source.js.map", "0", paths), false);
  assert.equal(serverArchiveEntryAllowed("apps/server/secret-link", "2", paths), false);
});

test("checksum records are validated and sorted", () => {
  const firstHash = "a".repeat(64);
  const secondHash = "0".repeat(64);
  assert.equal(
    formatSha256Sums([
      { name: "SyncAction-server-v0.9.0.tar.gz", sha256: firstHash },
      { name: "SyncAction-client-chrome-v0.9.0.zip", sha256: secondHash },
    ]),
    [
      `${secondHash}  SyncAction-client-chrome-v0.9.0.zip`,
      `${firstHash}  SyncAction-server-v0.9.0.tar.gz`,
      "",
    ].join("\n"),
  );
  assert.throws(
    () => formatSha256Sums([{ name: "asset.zip", sha256: "A".repeat(64) }]),
    /RELEASE_SHA256_INVALID/u,
  );
  assert.throws(
    () => formatSha256Sums([{ name: "../asset.zip", sha256: firstHash }]),
    /RELEASE_ASSET_NAME_INVALID/u,
  );
});

test("sha256File hashes file bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "syncaction-release-contract-"));
  const path = join(directory, "fixture.txt");
  try {
    await writeFile(path, "SyncAction\n", "utf8");
    assert.equal(
      await sha256File(path),
      "41cb7579f4c2eeb932336b3649389bfc29901ba4c86a14b51918b1e01dae9c3d",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
