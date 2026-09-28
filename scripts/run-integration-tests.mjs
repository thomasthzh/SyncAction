import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  localTestDatabaseUrlForPort,
  repositoryRoot,
  selectAvailableLoopbackPort,
} from "./local-runtime.mjs";

let testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (process.env.TEST_DATABASE_URL === undefined) {
  const databasePort = await selectAvailableLoopbackPort(55_432);
  const environment = {
    ...process.env,
    SYNC_ACTION_TEST_DATABASE_PORT: String(databasePort),
  };
  run("docker", ["compose", "-f", "infra/compose.test.yml", "up", "-d", "--wait"], environment);
  testDatabaseUrl = localTestDatabaseUrlForPort(databasePort);
}

if (testDatabaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL_SELECTION_FAILED");
}

const vitestEntrypoint = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitestEntrypoint)) {
  throw new Error("DEPENDENCIES_NOT_INSTALLED_RUN_PNPM_INSTALL");
}

run(process.execPath, [vitestEntrypoint, "run", "--config", "vitest.integration.config.ts"], {
  ...process.env,
  TEST_DATABASE_URL: testDatabaseUrl,
});

function run(command, arguments_, environment = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
