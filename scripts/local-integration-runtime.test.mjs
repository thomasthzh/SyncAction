import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("local integration tests use an isolated loopback PostgreSQL database", async () => {
  const runtime = await import("./local-runtime.mjs");

  assert.equal(
    runtime.localTestDatabaseUrl,
    "postgresql://syncaction_test:syncaction_test@127.0.0.1:55432/syncaction_test",
  );
  assert.notEqual(runtime.localTestDatabaseUrl, runtime.localDatabaseUrl);
  assert.equal(
    runtime.localTestDatabaseUrlForPort(61_234),
    "postgresql://syncaction_test:syncaction_test@127.0.0.1:61234/syncaction_test",
  );
});

test("integration database selection falls back when the preferred port is unavailable", async () => {
  const runtime = await import("./local-runtime.mjs");
  const attempts = [];
  const selected = await runtime.selectAvailableLoopbackPort(55_432, async (port) => {
    attempts.push(port);
    if (port === 55_432) {
      throw Object.assign(new Error("reserved"), { code: "EACCES" });
    }
    return 61_234;
  });

  assert.equal(selected, 61_234);
  assert.deepEqual(attempts, [55_432, 0]);
});

test("integration database selection does not hide unexpected port probe failures", async () => {
  const runtime = await import("./local-runtime.mjs");

  await assert.rejects(
    runtime.selectAvailableLoopbackPort(55_432, async () => {
      throw Object.assign(new Error("unexpected"), { code: "ENETDOWN" });
    }),
    /unexpected/u,
  );
});

test("the documented integration command uses the self-contained runner", async () => {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));

  assert.equal(packageJson.scripts["test:integration"], "node scripts/run-integration-tests.mjs");
  const compose = await readFile(resolve(repositoryRoot, "infra/compose.test.yml"), "utf8");
  assert.match(compose, /SYNC_ACTION_TEST_DATABASE_PORT:-55432/u);
});

test("legacy local secrets are atomically upgraded without rotating existing credentials", async () => {
  const runtime = await import("./local-runtime.mjs");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "syncaction-secrets-"));
  const secretsPath = resolve(temporaryDirectory, "runtime-secrets.json");
  const legacy = {
    version: 1,
    accessTokenSecret: Buffer.alloc(32, 7).toString("base64url"),
    adminTotpEncryptionKey: Buffer.alloc(32, 11).toString("base64url"),
  };
  const annotationHmacKey = Buffer.alloc(32, 23).toString("base64url");
  await writeFile(secretsPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  try {
    const upgraded = runtime.loadOrCreateLocalSecretsAt(secretsPath, () => annotationHmacKey);
    assert.deepEqual(upgraded, {
      ...legacy,
      version: 2,
      annotationHmacKey,
    });
    assert.deepEqual(JSON.parse(await readFile(secretsPath, "utf8")), upgraded);
    assert.deepEqual(
      runtime.loadOrCreateLocalSecretsAt(secretsPath, () => {
        throw new Error("a valid upgraded file must not rotate");
      }),
      upgraded,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the local annotation key is routed only to the public service", async () => {
  const localLauncher = await readFile(
    resolve(repositoryRoot, "scripts/start-local-services.mjs"),
    "utf8",
  );
  assert.match(localLauncher, /SYNC_ACTION_ANNOTATION_HMAC_KEY:\s*secrets\.annotationHmacKey/u);
  const localPublicBlock = localLauncher.slice(
    localLauncher.indexOf("  const publicService"),
    localLauncher.indexOf("  const adminService"),
  );
  const localAdminBlock = localLauncher.slice(
    localLauncher.indexOf("  const adminService"),
    localLauncher.indexOf("  writeProcessState"),
  );
  assert.match(localPublicBlock, /SYNC_ACTION_ANNOTATION_HMAC_KEY/u);
  assert.doesNotMatch(localAdminBlock, /SYNC_ACTION_ANNOTATION_HMAC_KEY/u);
});

test("the local launcher rejects an occupied loopback port before trusting another instance", async () => {
  const runtime = await import("./local-runtime.mjs");
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  try {
    await assert.rejects(
      runtime.assertLoopbackPortAvailable("127.0.0.1", address.port),
      new RegExp(`LOCAL_SERVICE_PORT_IN_USE_${String(address.port)}`, "u"),
    );
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((cause) => (cause === undefined ? resolvePromise() : rejectPromise(cause)));
    });
  }

  await assert.doesNotReject(runtime.assertLoopbackPortAvailable("127.0.0.1", address.port));
});
