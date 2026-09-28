import type { PageCapabilityMessage, PageDisposeReason } from "./messages.js";

export const PAGE_OVERLAY_HOST_ATTRIBUTE = "data-syncaction-page-host";

export const PAGE_SURFACE_NAMES = ["pointer", "media", "danmaku", "drawing"] as const;

export type PageSurfaceName = (typeof PAGE_SURFACE_NAMES)[number];
export type PageOverlayHostState = "ACTIVE" | "PAUSED" | "DISPOSED";

export interface PageOverlayContext {
  roomId: string;
  logicalTabId: string;
  documentRevision: {
    roomEpoch: number;
    tabUpdatedAtSeq: number;
  };
  frameKey?: string;
}

export interface PageOverlayHostOptions {
  document: Document;
  onCapability?: (message: PageCapabilityMessage) => void;
}

export interface PageSurfaceInteraction {
  active: boolean;
  capturesInput: boolean;
}

type SurfaceDisposer = (reason: PageDisposeReason) => void;

export class PageOverlayHost {
  public readonly element: HTMLDivElement;

  readonly #document: Document;
  readonly #onCapability: ((message: PageCapabilityMessage) => void) | undefined;
  readonly #observer: MutationObserver;
  readonly #surfaces = new Map<PageSurfaceName, HTMLElement>();
  readonly #controllers = new Map<PageSurfaceName, Set<SurfaceDisposer>>();
  #context: PageOverlayContext | null = null;
  #recoveryCount = 0;
  #capabilityReported = false;
  #state: PageOverlayHostState = "ACTIVE";

  public constructor(options: PageOverlayHostOptions) {
    this.#document = options.document;
    this.#onCapability = options.onCapability;
    if (this.#document.querySelector(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`) !== null) {
      throw new Error("PAGE_OVERLAY_HOST_ALREADY_MOUNTED");
    }

    this.element = this.#document.createElement("div");
    this.element.setAttribute(PAGE_OVERLAY_HOST_ATTRIBUTE, "");
    this.element.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

    const shadow = this.element.attachShadow({ mode: "closed" });
    const style = this.#document.createElement("style");
    style.textContent = HOST_STYLES;
    shadow.append(style);
    for (const name of PAGE_SURFACE_NAMES) {
      const surface = this.#document.createElement("section");
      surface.dataset.surface = name;
      surface.dataset.active = "false";
      surface.style.pointerEvents = "none";
      shadow.append(surface);
      this.#surfaces.set(name, surface);
      this.#controllers.set(name, new Set());
    }

    this.#document.documentElement.append(this.element);
    this.#observer = new this.#document.defaultView!.MutationObserver(() => {
      this.#handleMountConflict();
    });
    this.#observer.observe(this.#document.documentElement, {
      childList: true,
    });
  }

  public get state(): PageOverlayHostState {
    return this.#state;
  }

  public getPageHostCapability(): PageCapabilityMessage {
    return this.#state === "ACTIVE"
      ? {
          type: "syncaction.page.capability",
          capability: "PAGE_HOST",
          state: "AVAILABLE",
          errorCode: null,
        }
      : {
          type: "syncaction.page.capability",
          capability: "PAGE_HOST",
          state: "DEGRADED",
          errorCode: "PAGE_HOST_CONFLICT",
        };
  }

  public getSurface(name: PageSurfaceName): HTMLElement {
    const surface = this.#surfaces.get(name);
    if (surface === undefined) {
      throw new Error(`UNKNOWN_PAGE_SURFACE:${name}`);
    }
    return surface;
  }

  public clearSurface(name: PageSurfaceName): void {
    this.getSurface(name).replaceChildren();
  }

  public setSurfaceInteraction(name: PageSurfaceName, interaction: PageSurfaceInteraction): void {
    const surface = this.getSurface(name);
    const active = this.#state === "ACTIVE" && interaction.active;
    surface.dataset.active = active ? "true" : "false";
    surface.style.pointerEvents = active && interaction.capturesInput ? "auto" : "none";
  }

  public registerSurfaceController(name: PageSurfaceName, dispose: SurfaceDisposer): () => void {
    const controllers = this.#controllers.get(name);
    if (controllers === undefined) {
      throw new Error(`UNKNOWN_PAGE_SURFACE:${name}`);
    }
    controllers.add(dispose);
    return () => {
      controllers.delete(dispose);
    };
  }

  public updateContext(context: PageOverlayContext): void {
    if (this.#state === "DISPOSED") {
      return;
    }
    const previous = this.#context;
    this.#context = structuredClone(context);
    if (previous === null) {
      return;
    }
    if (previous.roomId !== context.roomId) {
      this.#resetSurfaces("ROOM_SWITCHED");
      return;
    }
    if (
      previous.logicalTabId !== context.logicalTabId ||
      (previous.frameKey ?? "top") !== (context.frameKey ?? "top") ||
      !sameRevision(previous.documentRevision, context.documentRevision)
    ) {
      this.#resetSurfaces("REVISION_CHANGED");
    }
  }

  public dispose(reason: PageDisposeReason): void {
    if (this.#state === "DISPOSED") {
      return;
    }
    this.#state = "DISPOSED";
    this.#observer.disconnect();
    this.#resetSurfaces(reason);
    this.#context = null;
    this.element.remove();
  }

  #resetSurfaces(reason: PageDisposeReason): void {
    for (const name of PAGE_SURFACE_NAMES) {
      const controllers = this.#controllers.get(name);
      if (controllers !== undefined) {
        for (const dispose of [...controllers]) {
          try {
            dispose(reason);
          } catch {
            // One controller cannot prevent the other collaboration surfaces from stopping.
          }
        }
        controllers.clear();
      }
      this.clearSurface(name);
      this.getSurface(name).dataset.active = "false";
      this.getSurface(name).style.pointerEvents = "none";
    }
  }

  #handleMountConflict(): void {
    if (this.#state !== "ACTIVE" || this.element.isConnected) {
      return;
    }
    if (this.#recoveryCount === 0) {
      this.#recoveryCount = 1;
      this.#document.documentElement.append(this.element);
      return;
    }
    this.#state = "PAUSED";
    this.#observer.disconnect();
    this.#resetSurfaces("BACKGROUND_STOPPED");
    if (!this.#capabilityReported) {
      this.#capabilityReported = true;
      this.#onCapability?.({
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      });
    }
  }
}

const PAGE_RUNTIME_KEY = "__syncactionPageCollaborationRuntimeV1__";

export interface InstalledPageRuntime<Runtime> {
  runtime: Runtime;
  created: boolean;
  uninstall(): void;
}

export function installPageCollaborationRuntime<Runtime>(
  scope: Record<string, unknown>,
  create: () => Runtime,
): InstalledPageRuntime<Runtime> {
  if (PAGE_RUNTIME_KEY in scope) {
    const runtime = scope[PAGE_RUNTIME_KEY] as Runtime;
    return {
      runtime,
      created: false,
      uninstall: () => {
        if (scope[PAGE_RUNTIME_KEY] === runtime) {
          delete scope[PAGE_RUNTIME_KEY];
        }
      },
    };
  }

  const runtime = create();
  scope[PAGE_RUNTIME_KEY] = runtime;
  return {
    runtime,
    created: true,
    uninstall: () => {
      if (scope[PAGE_RUNTIME_KEY] === runtime) {
        delete scope[PAGE_RUNTIME_KEY];
      }
    },
  };
}

function sameRevision(
  left: PageOverlayContext["documentRevision"],
  right: PageOverlayContext["documentRevision"],
): boolean {
  return left.roomEpoch === right.roomEpoch && left.tabUpdatedAtSeq === right.tabUpdatedAtSeq;
}

const HOST_STYLES = `
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    pointer-events: none;
  }
  section {
    position: fixed;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  section[data-active="false"] {
    display: none;
  }
`;
