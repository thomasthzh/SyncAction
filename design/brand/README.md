# SyncAction brand symbol

The SyncAction symbol is original project artwork: two offset rounded tab silhouettes with a forward
triangle cut from their shared center. It contains no lettering and does not derive from Apple or SF
Symbols, Chrome, Edge, or any third-party icon asset.

`syncaction-symbol.svg` is the full blue-to-indigo master used for 48 px and 128 px extension
artwork and copied to the administrator application. `syncaction-symbol-small.svg` is the flat,
purpose-drawn master used at 16 px and 32 px. Their approved geometry and source bytes are enforced
by `apps/extension/test/icon-assets.test.ts`.

Run `pnpm icons:build` at the repository root to regenerate the extension PNGs. The renderer uses
the pinned Sharp version, strips metadata, validates every source and output dimension, and writes
RGBA PNGs deterministically. Generated PNG and administrator assets must not be edited by hand.
