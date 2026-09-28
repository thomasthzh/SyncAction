import type { ComponentChildren, JSX } from "preact";

export const iconNames = [
  "logo",
  "chevron",
  "users",
  "message",
  "server",
  "share",
  "play",
  "sync",
  "danmaku",
  "pen",
  "invite",
  "leave",
  "transfer",
  "trash",
  "close",
] as const;

export type IconName = (typeof iconNames)[number];

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}

export function Icon({ name, size = 20, className = "" }: IconProps): JSX.Element {
  const classNames = `sa-icon sa-icon--${name} ${className}`.trim();
  if (name === "logo") {
    return (
      <img
        class={classNames}
        src="/icon-32.png"
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        data-brand-source="design/brand/syncaction-symbol.svg"
      />
    );
  }
  return (
    <svg
      class={classNames}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {pathsFor(name)}
    </svg>
  );
}

function pathsFor(name: Exclude<IconName, "logo">): ComponentChildren {
  switch (name) {
    case "chevron":
      return <path d="m9 6 6 6-6 6" />;
    case "users":
      return (
        <>
          <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20" />
          <circle cx="10" cy="8" r="3" />
          <path d="M16 5.2a3 3 0 0 1 0 5.6M18 15.4a3.5 3.5 0 0 1 2 3.1V20" />
        </>
      );
    case "message":
      return (
        <>
          <path d="M5 18.2 3.8 21l3.4-1.1c1.4.7 3 1.1 4.8 1.1 5 0 9-3.8 9-8.5S17 4 12 4s-9 3.8-9 8.5c0 2.2.8 4.2 2 5.7Z" />
          <path d="M8 12h.01M12 12h.01M16 12h.01" />
        </>
      );
    case "server":
      return (
        <>
          <rect x="3" y="4" width="18" height="6" rx="2" />
          <rect x="3" y="14" width="18" height="6" rx="2" />
          <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
        </>
      );
    case "share":
      return (
        <>
          <path d="M14 4h6v6M20 4l-9 9" />
          <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
        </>
      );
    case "play":
      return <path d="m9 7 8 5-8 5Z" />;
    case "sync":
      return (
        <>
          <path d="M20 7h-5V2" />
          <path d="M20 7a8 8 0 0 0-13.7-2.6L4 7" />
          <path d="M4 17h5v5" />
          <path d="M4 17a8 8 0 0 0 13.7 2.6L20 17" />
        </>
      );
    case "danmaku":
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M7 9h7M7 13h10M7 17h5" />
        </>
      );
    case "pen":
      return (
        <>
          <path d="m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16Z" />
          <path d="m14.7 6.5 2.8 2.8M4 20l1.2-4" />
        </>
      );
    case "invite":
      return (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.2 2.9" />
          <path d="M18 12v6M15 15h6" />
        </>
      );
    case "leave":
      return (
        <>
          <path d="M14 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-3" />
          <path d="M10 12h11M18 9l3 3-3 3" />
        </>
      );
    case "transfer":
      return (
        <>
          <path d="M4 7h13M14 4l3 3-3 3" />
          <path d="M20 17H7M10 14l-3 3 3 3" />
        </>
      );
    case "trash":
      return (
        <>
          <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
          <path d="M10 11v5M14 11v5" />
        </>
      );
    case "close":
      return <path d="m6 6 12 12M18 6 6 18" />;
  }
}
