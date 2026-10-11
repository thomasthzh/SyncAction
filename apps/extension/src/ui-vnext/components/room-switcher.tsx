import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { ActionableStatus } from "./actionable-status.js";
import { getFocusableElements } from "../accessibility.js";

export function RoomSwitcher({
  store,
  name,
  isOwner,
  onOpenSettings,
}: {
  readonly store: UiStore;
  readonly name: string;
  readonly isOwner: boolean;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const feedback = useCommandFeedback();

  function close(restoreFocus = true): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLElement>('[aria-current="true"], [role="menuitem"]')
      ?.focus();
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return (
    <div
      class="room-switcher"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const items = [
            ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ) ?? []),
          ];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[
            (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
          ]?.focus();
        } else if (event.key === "Tab" && open) {
          event.preventDefault();
          const root = rootRef.current;
          const next = event.shiftKey
            ? triggerRef.current
            : getFocusableElements(document.body).find(
                (element) =>
                  root !== null &&
                  !root.contains(element) &&
                  (root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
              );
          close(false);
          (next ?? triggerRef.current)?.focus();
        }
      }}
    >
      <button
        class="room-title-button"
        type="button"
        ref={triggerRef}
        aria-label="切换房间"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="room-switcher-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{name}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open ? (
        <div class="room-switcher__menu" id="room-switcher-menu" role="menu" aria-label="我的房间">
          <strong>我的房间</strong>
          {store.discovery.value.rooms.map((candidate) => (
            <button
              type="button"
              role="menuitem"
              key={candidate.id}
              aria-label={candidate.name}
              disabled={feedback.pending !== null}
              aria-current={candidate.id === store.room.value.selectedRoomId ? "true" : undefined}
              onClick={() =>
                void feedback
                  .run(candidate.id, () =>
                    store.command({
                      name: "ROOM_SELECT",
                      payload: { roomId: candidate.id },
                    }),
                  )
                  .then((result) => {
                    if (result?.ok)
                      close(rootRef.current?.contains(document.activeElement) ?? false);
                  })
              }
            >
              <span>{candidate.name}</span>
              {candidate.id === store.room.value.selectedRoomId ? (
                <Icon name="check" size={16} />
              ) : null}
            </button>
          ))}
          {isOwner ? (
            <button
              type="button"
              role="menuitem"
              disabled={feedback.pending !== null}
              onClick={() => {
                close();
                onOpenSettings();
              }}
            >
              房间设置
            </button>
          ) : null}
          <ActionableStatus errorCode={feedback.errorCode} />
        </div>
      ) : null}
    </div>
  );
}
