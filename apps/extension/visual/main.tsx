import { render } from "preact";
import { useState } from "preact/hooks";
import { App } from "../src/ui-vnext/app.js";
import { PermissionDialog } from "../src/ui-vnext/components/permission-dialog.js";
import "../src/ui-vnext/styles.css";
import { createVisualStore, FIXTURE_NOW_MS, type VisualFixture } from "./fixture-store.js";

const root = document.getElementById("sidepanel-app");
if (root === null) {
  throw new Error("MISSING_VISUAL_ROOT");
}

const requestedFixture = new URLSearchParams(globalThis.location.search).get("fixture");
const fixture: VisualFixture =
  requestedFixture === "room-unshared"
    ? "room-unshared"
    : requestedFixture === "room"
      ? "room"
      : requestedFixture === "guest"
        ? "guest"
        : "lobby";
document.documentElement.dataset.fixture = fixture;
document.documentElement.dataset.visualStage = "true";

render(
  requestedFixture?.startsWith("permission") ? (
    <PermissionPreview failed={requestedFixture === "permission-error"} />
  ) : (
    <App
      store={createVisualStore(fixture)}
      now={() => FIXTURE_NOW_MS}
      serviceStatusProbe={{ probe: async () => ({ latencyMs: 34 }) }}
    />
  ),
  root,
);

function PermissionPreview({ failed }: { failed: boolean }) {
  const [ready, setReady] = useState(!failed);
  const [open, setOpen] = useState(true);
  if (!open) return <p>本地视觉验收：对话框已关闭。</p>;
  return (
    <PermissionDialog
      feature="DRAWING"
      origin="https://video.example"
      browserPermission="https://video.example/*"
      termsVersion="visual-fixture"
      privacyPageUrl="privacy.html"
      ready={ready}
      externalErrorCode={ready ? null : "PAGE_PERMISSION_UNAVAILABLE"}
      onRetry={() => setReady(true)}
      onConfirm={() => ({ granted: true, errorCode: null, policySyncPending: false })}
      onClose={() => setOpen(false)}
    />
  );
}
