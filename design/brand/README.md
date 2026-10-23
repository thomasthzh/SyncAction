# SyncAction brand symbol

The SyncAction symbol is original project artwork called **Duet**. Two continuous, softly bent
tracks face one another around a shared open space. Graphite and blue keep their individual
identities while their alignment suggests a shared action. The mark is unframed: no blue tile,
stacked window, play triangle, letter or four-point X is part of the artwork. It does not derive
from Apple, SF Symbols, Chrome, Edge or a third-party asset.

`syncaction-symbol.svg` is the full master for 48 px and larger uses. Its restrained graphite and
blue gradients add slight optical depth without a bevel, glow or external shadow.
`syncaction-symbol-small.svg` uses flat colors, optically heavier tracks and more space between
their terminals at 16 px and 32 px. Its transparent outer margin and empty center are intentional.
`syncaction-symbol-monochrome.svg` is a single-color, unframed print / constrained-surface variant.
`syncaction-symbol-light.svg` preserves both tracks in white and pale blue for dark hero
backgrounds. Keep the two complete curves, rounded terminals and open center; do not compress the
gap or add a carrier shape to the canonical artwork.

Run `pnpm icons:build` to regenerate the extension PNGs, administrator SVG and versioned website v4
SVG variants. It also embeds the full mark in the social cover and renders the social PNG. The
pinned Sharp renderer strips extension PNG metadata, validates source/output dimensions and produces
deterministic RGBA files. Generated assets must not be edited by hand. The icon tests pin reviewed
source hashes, verify transparent padding / both foreground colors and reproduce rendered pixels.

Previous website SVG URLs remain available for cached pages and older films. The current website and
film can use v4 assets after deployment; installed extensions and published ZIP files retain their
embedded icons until the next normal client release. A website update does not replace installed
client binaries.
