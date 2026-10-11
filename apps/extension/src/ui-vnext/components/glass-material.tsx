import { useId, useLayoutEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import { createGlassRefractionMap } from "../glass-refraction.js";

/** Decorative only. One map per size, never per pointer event, scroll or animation frame. */
export function GlassMaterial(): JSX.Element {
  const id = `sa-glass-${useId()}`;
  const surface = useRef<HTMLSpanElement>(null);
  const mapImage = useRef<SVGFEImageElement>(null);

  useLayoutEffect(() => {
    const element = surface.current;
    const image = mapImage.current;
    if (element === null || image === null) return;
    const preference = matchMedia(
      "(prefers-reduced-transparency: reduce), (forced-colors: active)",
    );
    let frame = 0;
    let sizeKey = "";
    let observer: ResizeObserver | undefined;

    function update(): void {
      frame = 0;
      if (preference.matches || element === null || image === null) return;
      const width = Math.round(element.clientWidth);
      const height = Math.round(element.clientHeight);
      if (width === 0 || height === 0) return;
      const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
      const key = `${width}:${height}:${radius}`;
      if (key === sizeKey) return;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) return;
      const data = context.createImageData(width, height);
      data.data.set(createGlassRefractionMap(width, height, radius));
      context.putImageData(data, 0, 0);
      // Percentages resolve against the zero-sized definition SVG, not the glass box.
      image.setAttribute("width", String(width));
      image.setAttribute("height", String(height));
      image.setAttribute("href", canvas.toDataURL());
      element.dataset.refracting = "true";
      sizeKey = key;
    }

    function configure(): void {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      if (preference.matches) {
        delete element!.dataset.refracting;
        sizeKey = "";
        return;
      }
      update();
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(update);
      });
      observer.observe(element!);
    }

    configure();
    preference.addEventListener("change", configure);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", configure);
    };
  }, []);

  return (
    <span
      ref={surface}
      class="glass-material"
      aria-hidden="true"
      style={{ "--sa-refraction": `url(#${id})` }}
    >
      <svg class="glass-material__definition" width="0" height="0" focusable="false">
        <defs>
          <filter id={id} x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
            <feImage ref={mapImage} width="1" height="1" preserveAspectRatio="none" result="rim" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="rim"
              scale="18"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
    </span>
  );
}
