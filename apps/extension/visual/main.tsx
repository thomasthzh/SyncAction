import { render } from "preact";
import { App } from "../src/ui-vnext/app.js";
import "../src/ui-vnext/styles.css";
import { createVisualStore, FIXTURE_NOW_MS, type VisualFixture } from "./fixture-store.js";

const root = document.getElementById("sidepanel-app");
if (root === null) {
  throw new Error("MISSING_VISUAL_ROOT");
}

const fixture: VisualFixture =
  new URLSearchParams(globalThis.location.search).get("fixture") === "room" ? "room" : "lobby";
document.documentElement.dataset.fixture = fixture;
document.documentElement.dataset.visualStage = "true";

render(
  <App
    store={createVisualStore(fixture)}
    now={() => FIXTURE_NOW_MS}
    serviceStatusProbe={{ probe: async () => ({ latencyMs: 34 }) }}
  />,
  root,
);
