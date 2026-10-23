# SyncAction brand symbol

The SyncAction symbol is original project artwork called **Converge**: four rounded pointers face
one shared focus. Each person keeps a distinct position; the open center represents the common
webpage. This replaces the two overlapping tabs and play triangle, so the identity includes browsing
and collaboration as well as watching. It contains no lettering and does not derive from Apple, SF
Symbols, Chrome, Edge, or any third-party icon asset.

`syncaction-symbol.svg` is the blue master for 48 px and 128 px artwork. Its slight vertical light
falloff gives the tile depth without a glossy overlay or an external shadow.
`syncaction-symbol-small.svg` is the flat, optically heavier master for 16 px and 32 px.
`syncaction-symbol-monochrome.svg` is the unframed, single-color mark for print or constrained
surfaces. Preserve all four pointers and the open center; do not add a play triangle, letter, or
decorative glow. Their safe vector structure, approved source hashes and generated assets are
enforced by `apps/extension/test/icon-assets.test.ts`.

Run `pnpm icons:build` at the repository root to regenerate the extension PNGs. The renderer uses
the pinned Sharp version, strips metadata, validates every source and output dimension, and writes
RGBA PNGs deterministically. It also copies the master to the administrator and product site, embeds
it in the social cover, and renders the social PNG. Generated assets must not be edited by hand.

The website and film can use the mark immediately after deployment. Installed extensions and
published ZIP files retain their embedded icons until the next normal client release; a website
update does not replace already installed client binaries.
