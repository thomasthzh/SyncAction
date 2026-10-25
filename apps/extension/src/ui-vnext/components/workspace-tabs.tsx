import { useRef } from "preact/hooks";
import type { JSX } from "preact";

export interface WorkspaceTab {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

/** Local task navigation: it never changes room, page, or playback participation. */
export function WorkspaceTabs({
  id,
  label,
  tabs,
  selected,
  onSelect,
}: {
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly WorkspaceTab[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div class="workspace-tabs" role="tablist" aria-label={label} ref={root}>
      {tabs.map((tab, index) => (
        <button
          type="button"
          role="tab"
          id={`${id}-tab-${tab.id}`}
          key={tab.id}
          aria-controls={`${id}-panel-${tab.id}`}
          aria-selected={selected === tab.id}
          tabIndex={selected === tab.id ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            onSelect(tabs[next]!.id);
            root.current?.querySelector<HTMLButtonElement>(`#${id}-tab-${tabs[next]!.id}`)?.focus();
          }}
        >
          <span>{tab.label}</span>
          {tab.count === undefined ? null : <small>{tab.count}</small>}
        </button>
      ))}
    </div>
  );
}
