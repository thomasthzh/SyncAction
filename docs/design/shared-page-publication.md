# Shared pages are published explicitly

The extension uses `MANUAL` browser-change policy. A room's page list represents submitted shared
pages; it is not a mirror of every action performed in a participant's browser tab strip.

## User actions

- **Share current page** publishes the current tab.
- Navigating a shared tab locally detaches its collaboration binding and keeps a local pending
  publication. **Submit page update** explicitly updates the original shared page's address.
- If the original page has changed or been removed, preserve the local page and show a conflict.
  **Share as a new page** is a separate explicit choice.
- **Open** opens or focuses the selected shared page only.
- **Remove shared page** requires confirmation in the extension and submits a durable close. Other
  participants' still-bound room tabs may close as a result.
- Closing an ordinary browser tab removes only that local binding. It neither removes the room page
  nor forces that tab to reopen. Local tab ordering is also private.

An address update does not replicate a site's internal data, personalized recommendations, DOM or
video pixels. Reloading the same address is not a room-wide content refresh. Synchronized playback
and sharing a single captured picture are different capabilities and must be described separately.

## Binding and publication invariants

The browser-sync library retains `AUTOMATIC` as its compatibility default; the production extension
explicitly selects `MANUAL`. Program-generated browser effects still use the effect ledger so their
events cannot become new local publication intents.

A successful reconciliation without a browser effect must still revalidate existing bindings against
the confirmed snapshot. An unrelated participant's page change advances the room sequence too.
Without revalidation, an unchanged local page can lose all collaboration despite a synced room.
Loading documents are rechecked on their native completion event; they must not be duplicated by a
second explicit Open.

`bindingValidationKey` is part of page-access invalidation. Sequence and binding count alone cannot
distinguish an early read while validation is pending from the completed validation at the same room
sequence. Heartbeat timestamps and media positions are not page-access invalidations.

`isConfirmedPageDocument` prevents any pending navigation or close from using the previous confirmed
document's collaboration context, including the interval after an acknowledgement but before the
commit arrives. Pointer, drawing, danmaku, media and presence reporting share this rule.

Page publication captures the selected server, room, physical tab and URL. The command router checks
the active page; the application checks the queued runtime context; the observer checks the fresh
browser state before writing. A late rejection is not a substitute for avoiding publication of the
wrong page. Sharing a conflict as new clears its pending association only after these checks.

Pending associations and validated URL baselines are local to the current background runtime. They
do not survive a browser/background restart. When no safe baseline exists, preserve the local page
and require an explicit Open or Share; do not guess that it should be overwritten. Concurrent
submissions retain the existing server ordering semantics, not a distributed compare-and-swap.

## Presence and page access

Being connected, being present in a room, viewing a shared page and matching another page's content
are separate states. A participant outside shared pages is still online. Semantic presence changes
must notify the UI even when no remote logical page needs pointer or media effects; lease-only
renewals should not cause that work.

Site access is browser permission for the extension, not a request to a website operator. Remember
existing effective consent within its server, origin and terms scope. Full data details are
expandable, while the task, scope and concise disclosure remain visible. A failed preflight offers
retry rather than an indefinitely disabled checking button.

For already-loaded child documents, enumerate only the current tab, require both host permission and
application consent per origin, and inject into the exact document ID. A denied child does not
prevent allowed documents from working. Reload replaces root and child document generations even
when the URL is unchanged; old contexts must be discarded and already-loaded child runtimes can
announce themselves again.

## Verification

Regression coverage includes private local closes, explicit navigation submissions and conflicts,
unrelated room-sequence advances, native loading completion, delayed acknowledgement/commit, queued
context changes, own/unbound member presence, first-use iframe injection and same-URL reload.

Rendered fixture tests establish layout and command behavior. Independent extension profiles against
a real isolated backend establish actual collaboration. Neither alone establishes compatibility with
every third-party website or the user's authenticated page.
