---
name: Native binaries and the linux-x64 assumption
description: Why the workspace install config must not exclude non-Linux native binaries in a project that is also built on macOS/Windows.
---

The upstream workspace template excluded every non-linux-x64 optional native
binary (rollup, esbuild, lightningcss, Tailwind oxide, ngrok) through `"-"`
overrides in `pnpm-workspace.yaml`, on the reasoning that the repl only runs
linux-x64.

This project also gets built on the operator's own macOS/Windows machine,
because that is where the desktop shell is packaged. There the exclusions
surface as `Cannot find module @rollup/rollup-darwin-x64` at build time.

**Why:** pnpm installs only the optional binary matching the host, so the
exclusions saved nothing on a linux-only host while making the repo unbuildable elsewhere.

**How to apply:** whenever this workspace config is re-synced from a template or
regenerated, check that those platform exclusions have not come back. A build
failure naming a `-darwin-` or `-win32-` package is this, not a broken install
on the user's side — though their `node_modules` from before the fix has to be
removed, since the tree still matches the old lockfile.
