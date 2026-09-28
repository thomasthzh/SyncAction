import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { localPublicOrigin, repositoryRoot } from "./local-runtime.mjs";

const browser = process.argv[2];
if (browser !== "chrome" && browser !== "edge") {
  throw new Error("USAGE_NODE_BUILD_LOCAL_CLIENT_MJS_CHROME_OR_EDGE");
}

const extensionRoot = resolve(repositoryRoot, "apps/extension");
const wxtCli = resolve(extensionRoot, "node_modules/wxt/bin/wxt.mjs");
const child = spawn(
  process.execPath,
  [wxtCli, "build", "--browser", browser, "--mode", "localdev"],
  {
    cwd: extensionRoot,
    env: {
      ...process.env,
      WXT_PUBLIC_SERVER_URL: localPublicOrigin,
    },
    stdio: "inherit",
  },
);
const exitCode = await new Promise((resolvePromise, rejectPromise) => {
  child.once("error", rejectPromise);
  child.once("exit", (code) => resolvePromise(code ?? 1));
});
if (exitCode !== 0) {
  throw new Error(`LOCAL_CLIENT_BUILD_FAILED_${String(exitCode)}`);
}

const outputDirectory = resolve(extensionRoot, `.output/${browser}-mv3-local`);
const manifest = JSON.parse(readFileSync(resolve(outputDirectory, "manifest.json"), "utf8"));
const expectedHostPermissions = [`${localPublicOrigin}/*`];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHostPermissions)) {
  throw new Error("LOCAL_CLIENT_MANIFEST_SERVER_BOUNDARY_MISMATCH");
}
process.stdout.write(
  `Local ${browser} client ready at ${outputDirectory}\n` +
    `Server permission: ${expectedHostPermissions[0]}\n`,
);
