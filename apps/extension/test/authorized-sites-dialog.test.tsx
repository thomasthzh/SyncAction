// @vitest-environment happy-dom

import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthorizedSitesDialog,
  type AuthorizedSiteView,
} from "../src/ui-vnext/components/authorized-sites-dialog.js";
import {
  TestUiStore,
  byRole,
  click,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(() => {
  unmountPanel();
});

describe("AuthorizedSitesDialog", () => {
  it("loads only the selected profile and removes one exact browser grant through the UI command", async () => {
    const store = new TestUiStore();
    store.shell.value = {
      ...store.shell.value,
      selectedProfileId: "server-a",
    };
    let rows: AuthorizedSiteView[] = [
      {
        record: {
          profileId: "server-a",
          origin: "https://video.example",
          serverTermsVersion: "2026-07-30",
          disclosureVersion: 1,
          acceptedAtClientMs: 1_785_312_345_678,
          bundle: "PAGE_COLLABORATION",
          policySyncPending: false,
        },
        browserPermissionGranted: true,
      },
      {
        record: {
          profileId: "server-a",
          origin: "https://news.example:8443",
          serverTermsVersion: "2026-07-30",
          disclosureVersion: 1,
          acceptedAtClientMs: 1_785_312_345_679,
          bundle: "PAGE_COLLABORATION",
          policySyncPending: true,
        },
        browserPermissionGranted: false,
      },
    ];
    const load = vi.fn(async (profileId: string) => {
      expect(profileId).toBe("server-a");
      return structuredClone(rows);
    });
    store.responder = async (command) => {
      if (command.name === "PAGE_PERMISSION_REMOVE") {
        rows = rows.map((row) =>
          row.record.origin === command.payload.origin
            ? { ...row, browserPermissionGranted: false }
            : row,
        );
      }
      return success();
    };
    const root = renderPanel(
      <AuthorizedSitesDialog
        store={store}
        profileId="server-a"
        load={load}
        onClose={() => undefined}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(root.textContent).toContain("https://video.example");
    expect(root.textContent).toContain("https://news.example:8443");
    expect(root.textContent).toContain("已授权");
    expect(root.textContent).toContain("已撤销");
    expect(root.textContent).toContain("策略记录待同步");

    await click(byRole(root, "button", "撤销 https://video.example"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "PAGE_PERMISSION_REMOVE",
      payload: { origin: "https://video.example" },
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain("历史同意记录仍保留");
  });

  it("renders an empty state without synthesizing records from browser permissions", async () => {
    const store = new TestUiStore();
    const root = renderPanel(
      <AuthorizedSitesDialog
        store={store}
        profileId="syncaction-production"
        load={async () => []}
        onClose={() => undefined}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(root.textContent).toContain("暂无已同意站点");
  });
});
