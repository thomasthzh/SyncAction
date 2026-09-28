import { useLayoutEffect, useRef } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { installFocusTrap } from "../accessibility.js";

export interface ModalDialogProps {
  readonly titleId: string;
  readonly pending?: boolean;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
  readonly className?: string;
}

export function ModalDialog({
  titleId,
  pending = false,
  onClose,
  children,
  className = "",
}: ModalDialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    const restoreTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    try {
      if (typeof dialog.showModal === "function" && !dialog.open) {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } catch {
      dialog.setAttribute("open", "");
    }
    const removeFocusTrap = installFocusTrap(dialog, restoreTo);
    return () => {
      if (dialog.open && typeof dialog.close === "function") {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute("open");
        }
      }
      removeFocusTrap();
    };
  }, []);

  function handleKeyDown(event: JSX.TargetedKeyboardEvent<HTMLDialogElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) {
        onClose();
      }
      return;
    }
  }

  return (
    <dialog
      ref={ref}
      class={`modal-dialog ${className}`.trim()}
      aria-labelledby={titleId}
      aria-modal="true"
      role="dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) {
          onClose();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <div class="modal-dialog__surface">{children}</div>
    </dialog>
  );
}
