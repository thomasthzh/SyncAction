import { defineConfig } from "wxt";
import {
  PRODUCTION_PUBLIC_SERVER_ORIGIN,
  publicServerHostPermission,
  resolvePublicServerOrigin,
} from "./src/server-origin.js";

const publicServerOrigin = resolvePublicServerOrigin(process.env.WXT_PUBLIC_SERVER_URL);
const isLocalServerBuild = publicServerOrigin !== PRODUCTION_PUBLIC_SERVER_ORIGIN;

export default defineConfig({
  imports: false,
  manifestVersion: 3,
  outDirTemplate: isLocalServerBuild
    ? "{{browser}}-mv{{manifestVersion}}-local"
    : "{{browser}}-mv{{manifestVersion}}{{modeSuffix}}",
  manifest: {
    name: "SyncAction",
    description: "Shared, durable browser tab workspaces.",
    minimum_chrome_version: "116",
    permissions: ["scripting", "storage", "unlimitedStorage", "tabs", "tabGroups", "sidePanel"],
    host_permissions: [publicServerHostPermission(publicServerOrigin)],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    icons: {
      16: "icon-16.png",
      32: "icon-32.png",
      48: "icon-48.png",
      128: "icon-128.png",
    },
    action: {
      default_title: "SyncAction",
      default_icon: {
        16: "icon-16.png",
        32: "icon-32.png",
        48: "icon-48.png",
        128: "icon-128.png",
      },
    },
    commands: {
      "toggle-danmaku-input": {
        suggested_key: {
          default: "Alt+T",
        },
        description: "Toggle the SyncAction danmaku input",
      },
      "toggle-page-pen": {
        suggested_key: {
          default: "Alt+P",
        },
        description: "Toggle the SyncAction page pen",
      },
    },
  },
});
