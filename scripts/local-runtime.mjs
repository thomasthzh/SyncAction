import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const localStateDirectory = resolve(repositoryRoot, ".local");
export const localSecretsPath = resolve(localStateDirectory, "runtime-secrets.json");
export const localProcessesPath = resolve(localStateDirectory, "service-processes.json");
export const localRuntimeLockPath = resolve(localStateDirectory, "service-runner.lock");
export const localDatabaseUrl =
  "postgresql://syncaction_local:syncaction_local@127.0.0.1:55433/syncaction_local";
export const localTestDatabaseUrl =
  "postgresql://syncaction_test:syncaction_test@127.0.0.1:55432/syncaction_test";
export const localPublicOrigin = "http://127.0.0.1:29373";
export const localAdminOrigin = "http://127.0.0.1:29374";

export function localTestDatabaseUrlForPort(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("INVALID_LOCAL_TEST_DATABASE_PORT");
  }
  return `postgresql://syncaction_test:syncaction_test@127.0.0.1:${String(port)}/syncaction_test`;
}

export async function selectAvailableLoopbackPort(
  preferredPort,
  reservePort = reserveLoopbackPort,
) {
  if (!Number.isSafeInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new Error("INVALID_LOCAL_TEST_DATABASE_PORT");
  }
  try {
    return await reservePort(preferredPort);
  } catch (cause) {
    if (cause?.code !== "EACCES" && cause?.code !== "EADDRINUSE") {
      throw cause;
    }
    return reservePort(0);
  }
}

export function ensureLocalStateDirectory() {
  mkdirSync(localStateDirectory, { recursive: true });
}

export function acquireLocalRuntimeLock() {
  ensureLocalStateDirectory();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(localRuntimeLockPath, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ version: 1, runnerPid: process.pid }, null, 2)}\n`,
        "utf8",
      );
      closeSync(descriptor);
      descriptor = undefined;
      try {
        chmodSync(localRuntimeLockPath, 0o600);
      } catch {
        // Windows ACLs, rather than POSIX modes, protect this ignored local-only file.
      }
      return () => {
        const lock = readLock();
        if (lock?.runnerPid === process.pid) {
          rmSync(localRuntimeLockPath, { force: true });
        }
      };
    } catch (cause) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        rmSync(localRuntimeLockPath, { force: true });
      }
      if (cause?.code !== "EEXIST") {
        throw cause;
      }
      const lock = readLock();
      if (lock !== undefined && isProcessRunning(lock.runnerPid)) {
        throw new Error(`LOCAL_SERVICES_ALREADY_RUNNING_${String(lock.runnerPid)}`, { cause });
      }
      if (lock === undefined && isRecentLock()) {
        throw new Error("LOCAL_SERVICES_ALREADY_STARTING", { cause });
      }
      rmSync(localRuntimeLockPath, { force: true });
    }
  }
  throw new Error("LOCAL_RUNTIME_LOCK_ACQUISITION_FAILED");
}

export function loadOrCreateLocalSecrets() {
  return loadOrCreateLocalSecretsAt(localSecretsPath);
}

export function loadOrCreateLocalSecretsAt(
  secretsPath,
  createSecret = () => randomBytes(32).toString("base64url"),
) {
  mkdirSync(dirname(secretsPath), { recursive: true });
  if (existsSync(secretsPath)) {
    const current = parseSecrets(readFileSync(secretsPath, "utf8"));
    if (current.version === 2) {
      return current;
    }
    const annotationHmacKey = createSecret();
    if (!isBase64UrlSecret(annotationHmacKey)) {
      throw new Error("INVALID_LOCAL_RUNTIME_SECRETS");
    }
    const upgraded = {
      version: 2,
      accessTokenSecret: current.accessTokenSecret,
      adminTotpEncryptionKey: current.adminTotpEncryptionKey,
      annotationHmacKey,
    };
    writeSecretsAtomically(secretsPath, upgraded);
    return upgraded;
  }
  const secrets = {
    version: 2,
    accessTokenSecret: createSecret(),
    adminTotpEncryptionKey: createSecret(),
    annotationHmacKey: createSecret(),
  };
  if (
    !isBase64UrlSecret(secrets.accessTokenSecret) ||
    !isBase64UrlSecret(secrets.adminTotpEncryptionKey) ||
    !isBase64UrlSecret(secrets.annotationHmacKey)
  ) {
    throw new Error("INVALID_LOCAL_RUNTIME_SECRETS");
  }
  writeSecretsAtomically(secretsPath, secrets);
  return secrets;
}

export function readLocalSecrets() {
  if (!existsSync(localSecretsPath)) {
    throw new Error("LOCAL_RUNTIME_NOT_INITIALIZED");
  }
  return loadOrCreateLocalSecretsAt(localSecretsPath);
}

export async function assertLoopbackPortAvailable(host, port) {
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("INVALID_LOCAL_SERVICE_PORT");
  }
  const server = createServer();
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const rejectOnError = (cause) => rejectPromise(cause);
      server.once("error", rejectOnError);
      server.listen({ host, port, exclusive: true }, () => {
        server.off("error", rejectOnError);
        resolvePromise();
      });
    });
  } catch (cause) {
    if (cause?.code === "EADDRINUSE") {
      throw new Error(`LOCAL_SERVICE_PORT_IN_USE_${String(port)}`, { cause });
    }
    throw new Error(`LOCAL_SERVICE_PORT_CHECK_FAILED_${String(port)}`, { cause });
  } finally {
    if (server.listening) {
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((cause) => (cause === undefined ? resolvePromise() : rejectPromise(cause)));
      });
    }
  }
}

async function reserveLoopbackPort(port) {
  const server = createServer();
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("LOCAL_TEST_DATABASE_PORT_ADDRESS_INVALID");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((cause) => (cause === undefined ? resolvePromise() : rejectPromise(cause)));
      });
    }
  }
}

function readLock() {
  if (!existsSync(localRuntimeLockPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(localRuntimeLockPath, "utf8"));
    if (parsed?.version === 1 && Number.isSafeInteger(parsed.runnerPid) && parsed.runnerPid > 0) {
      return parsed;
    }
  } catch {
    // A malformed or partially written lock is stale and can be replaced.
  }
  return undefined;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause?.code === "EPERM";
  }
}

function isRecentLock() {
  try {
    return Date.now() - statSync(localRuntimeLockPath).mtimeMs < 5_000;
  } catch {
    return false;
  }
}

function parseSecrets(serialized) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("INVALID_LOCAL_RUNTIME_SECRETS");
  }
  if (
    (parsed?.version !== 1 && parsed?.version !== 2) ||
    !isBase64UrlSecret(parsed.accessTokenSecret) ||
    !isBase64UrlSecret(parsed.adminTotpEncryptionKey) ||
    (parsed.version === 2 && !isBase64UrlSecret(parsed.annotationHmacKey))
  ) {
    throw new Error("INVALID_LOCAL_RUNTIME_SECRETS");
  }
  if (parsed.version === 1) {
    return {
      version: 1,
      accessTokenSecret: parsed.accessTokenSecret,
      adminTotpEncryptionKey: parsed.adminTotpEncryptionKey,
    };
  }
  return {
    version: 2,
    accessTokenSecret: parsed.accessTokenSecret,
    adminTotpEncryptionKey: parsed.adminTotpEncryptionKey,
    annotationHmacKey: parsed.annotationHmacKey,
  };
}

function writeSecretsAtomically(secretsPath, secrets) {
  const temporaryPath = `${secretsPath}.${String(process.pid)}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, secretsPath);
  try {
    chmodSync(secretsPath, 0o600);
  } catch {
    // Windows ACLs, rather than POSIX modes, protect this ignored local-only file.
  }
}

function isBase64UrlSecret(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}
