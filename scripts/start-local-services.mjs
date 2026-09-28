import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLocalRuntimeLock,
  assertLoopbackPortAvailable,
  ensureLocalStateDirectory,
  loadOrCreateLocalSecrets,
  localAdminOrigin,
  localDatabaseUrl,
  localProcessesPath,
  localPublicOrigin,
  repositoryRoot,
} from "./local-runtime.mjs";

const composeArguments = ["compose", "-p", "syncaction-local", "-f", "infra/compose.local.yml"];
const tsxPackage = resolve(repositoryRoot, "node_modules/tsx/package.json");
const services = [];
let shuttingDown = false;
let releaseRuntimeLock;

try {
  releaseRuntimeLock = acquireLocalRuntimeLock();
  await main();
} catch (cause) {
  if (releaseRuntimeLock !== undefined) {
    await shutdown(1);
  }
  if (
    cause instanceof Error &&
    (cause.message.startsWith("LOCAL_SERVICES_ALREADY_RUNNING_") ||
      cause.message === "LOCAL_SERVICES_ALREADY_STARTING")
  ) {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 1;
  } else {
    throw cause;
  }
}

async function main() {
  if (!existsSync(tsxPackage)) {
    throw new Error("DEPENDENCIES_NOT_INSTALLED_RUN_PNPM_INSTALL");
  }

  ensureLocalStateDirectory();
  const secrets = loadOrCreateLocalSecrets();
  await assertLoopbackPortAvailable("127.0.0.1", 29373);
  await assertLoopbackPortAvailable("127.0.0.1", 29374);
  startDatabase();

  const publicService = startService("public", "apps/server/src/main.ts", {
    SYNC_ACTION_PUBLIC_HOST: "127.0.0.1",
    SYNC_ACTION_PUBLIC_PORT: "29373",
    SYNC_ACTION_DATABASE_URL: localDatabaseUrl,
    SYNC_ACTION_ACCESS_TOKEN_SECRET: secrets.accessTokenSecret,
    SYNC_ACTION_ANNOTATION_HMAC_KEY: secrets.annotationHmacKey,
  });
  await waitForReady("public", `${localPublicOrigin}/readyz`, publicService);

  const adminService = startService("admin", "apps/superadmin/src/main.ts", {
    NODE_ENV: "development",
    SYNC_ACTION_ADMIN_HOST: "127.0.0.1",
    SYNC_ACTION_ADMIN_PORT: "29374",
    SYNC_ACTION_ADMIN_PUBLIC_ORIGIN: localAdminOrigin,
    SYNC_ACTION_DATABASE_URL: localDatabaseUrl,
    SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY: secrets.adminTotpEncryptionKey,
  });
  await waitForReady("admin", `${localAdminOrigin}/readyz`, adminService);

  writeProcessState();
  process.stdout.write(
    [
      "",
      "SyncAction local services are ready:",
      `  public: ${localPublicOrigin}`,
      `  admin:  ${localAdminOrigin}`,
      "  data:   PostgreSQL on 127.0.0.1:55433 (persistent Docker volume)",
      "",
      "Keep this process running. Press Ctrl+C to stop the Node services.",
      "The database remains persisted and can be stopped with pnpm local:db:down.",
      "",
    ].join("\n"),
  );

  await new Promise((resolvePromise, rejectPromise) => {
    const stop = () => {
      void shutdown(0).then(resolvePromise, rejectPromise);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    for (const service of services) {
      service.process.once("exit", (code, signal) => {
        if (shuttingDown) {
          return;
        }
        const cause = new Error(
          `${service.name.toUpperCase()}_SERVICE_EXITED_${String(code ?? signal ?? "UNKNOWN")}`,
        );
        void shutdown(1).then(() => rejectPromise(cause), rejectPromise);
      });
    }
  });
}

function startDatabase() {
  const result = spawnSync("docker", [...composeArguments, "up", "-d", "--wait"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error("LOCAL_DATABASE_START_FAILED", { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`LOCAL_DATABASE_START_FAILED_${String(result.status)}`);
  }
}

function startService(name, entrypoint, extraEnvironment) {
  const service = {
    name,
    process: spawn(process.execPath, ["--import", "tsx", resolve(repositoryRoot, entrypoint)], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...extraEnvironment,
      },
      stdio: "inherit",
    }),
  };
  services.push(service);
  return service;
}

async function waitForReady(name, url, service) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (service.process.exitCode !== null) {
      throw new Error(`${name.toUpperCase()}_SERVICE_EXITED_BEFORE_READY`);
    }
    try {
      const response = await globalThis.fetch(url, {
        signal: globalThis.AbortSignal.timeout(1_500),
      });
      if (response.ok && (await response.json()).status === "ready") {
        return;
      }
    } catch {
      // Startup, migration, and the first TCP bind can legitimately take a few seconds.
    }
    await delay(250);
  }
  throw new Error(`${name.toUpperCase()}_SERVICE_READY_TIMEOUT`);
}

function writeProcessState() {
  writeFileSync(
    localProcessesPath,
    `${JSON.stringify(
      {
        version: 1,
        runnerPid: process.pid,
        services: Object.fromEntries(
          services.map((service) => [service.name, service.process.pid]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  rmSync(localProcessesPath, { force: true });
  for (const service of services) {
    if (service.process.exitCode === null) {
      service.process.kill("SIGTERM");
    }
  }
  await Promise.all(
    services.map(
      (service) =>
        new Promise((resolvePromise) => {
          if (service.process.exitCode !== null) {
            resolvePromise();
            return;
          }
          const timeout = setTimeout(() => {
            service.process.kill("SIGKILL");
            resolvePromise();
          }, 5_000);
          service.process.once("exit", () => {
            clearTimeout(timeout);
            resolvePromise();
          });
        }),
    ),
  );
  releaseRuntimeLock?.();
  process.exitCode = exitCode;
}
