import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import {
  localAdminOrigin,
  localDatabaseUrl,
  loadOrCreateLocalSecrets,
  repositoryRoot,
} from "./local-runtime.mjs";

const requiredCredentialNames = [
  "SYNC_ACTION_ADMIN_BOOTSTRAP_USERNAME",
  "SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD",
  "SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_SECRET",
];
for (const name of requiredCredentialNames) {
  if (typeof process.env[name] !== "string" || process.env[name].length === 0) {
    throw new Error(`MISSING_${name}`);
  }
}

const secrets = loadOrCreateLocalSecrets();
const child = spawn(
  process.execPath,
  ["--import", "tsx", resolve(repositoryRoot, "apps/superadmin/src/bootstrap.ts")],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      SYNC_ACTION_ADMIN_PUBLIC_ORIGIN: localAdminOrigin,
      SYNC_ACTION_DATABASE_URL: localDatabaseUrl,
      SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY: secrets.adminTotpEncryptionKey,
    },
    stdio: "inherit",
  },
);
const exitCode = await new Promise((resolvePromise, rejectPromise) => {
  child.once("error", rejectPromise);
  child.once("exit", (code) => resolvePromise(code ?? 1));
});
if (exitCode !== 0) {
  throw new Error(`LOCAL_ADMIN_BOOTSTRAP_FAILED_${String(exitCode)}`);
}
