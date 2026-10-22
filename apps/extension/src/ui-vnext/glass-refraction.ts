/** A neutral center with outward sampling at the rounded rim, in sRGB map channels. */
export function createGlassRefractionMap(
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const corner = Math.min(radius, width / 2, height / 2);
  const bezel = Math.min(12, corner);

  // The content plane is neutral. Only the rounded rim needs the distance/normal
  // calculation; opening a tall dialog should not run it for every interior pixel.
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 128;
    pixels[index + 1] = 128;
    pixels[index + 2] = 128;
    pixels[index + 3] = 255;
  }
  if (bezel <= 0) return pixels;
  const edge = Math.ceil(corner);

  for (let y = 0; y < height; y++) {
    const middleRow = y >= edge && y < height - edge;
    for (let x = 0; x < width; x++) {
      if (middleRow && x === edge && width - edge > edge) x = width - edge;
      const dx = x + 0.5 - width / 2;
      const dy = y + 0.5 - height / 2;
      const qx = Math.abs(dx) - (width / 2 - corner);
      const qy = Math.abs(dy) - (height / 2 - corner);
      const outsideX = Math.max(qx, 0);
      const outsideY = Math.max(qy, 0);
      const length = Math.hypot(outsideX, outsideY);
      const depth = corner - (length + Math.min(Math.max(qx, qy), 0));
      let normalX = 0;
      let normalY = 0;
      if (depth > 0 && depth < bezel) {
        const bend = Math.sin((depth / bezel) * Math.PI);
        normalX = (length > 0 ? outsideX / length : qx > qy ? 1 : 0) * Math.sign(dx) * bend;
        normalY = (length > 0 ? outsideY / length : qx > qy ? 0 : 1) * Math.sign(dy) * bend;
      }
      const index = (y * width + x) * 4;
      pixels[index] = 128 + normalX * 127;
      pixels[index + 1] = 128 + normalY * 127;
    }
  }
  return pixels;
}
