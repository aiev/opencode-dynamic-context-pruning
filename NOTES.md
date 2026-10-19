# Fork notes (aiev)

This fork of `Tarquinen/opencode-dynamic-context-pruning` exists to run the tokenizer fix in
production before it lands upstream. `master` mirrors upstream; the fork-specific branches are:

- **`fix/tokenizer-cost`** — the upstream PR branch: fix + tests + benches, no fork-only changes.
- **`fork/dogfood`** — `fix/tokenizer-cost` + a version marker (`3.2.1-fork.1`). This is what the
  machine below runs; notes about the setup live here.

Upstream links: PR (draft) #663, issues #638 / #659 (with our measurements), related PRs
#639 / #660 / #621.

## What the fix does (short)

`lib/token-utils.ts` only: reuse one WASM tokenizer instead of building one per call, memoize exact
counts (LRU), and bound the per-call work (head/middle/tail sampling above
`DCP_TOKEN_COUNT_MAX_EXACT_CHARS`, default 16k characters; long single-character runs are always
sampled). `estimateTokensBatch` counts per item. Env: `DCP_TOKEN_COUNT_MAX_EXACT_CHARS`,
`DCP_TOKEN_DEBUG=1`.

## Local install (OpenCode V2)

```jsonc
// ~/.config/opencode/opencode.json (server side)
"plugins": [
  { "package": "/home/tiago/Projects/opencode-dynamic-context-pruning" },
  // ...other plugins
],
"permissions": [{ "action": "compress", "resource": "*", "effect": "allow" }],
```

```jsonc
// ~/.config/opencode/cli.json (TUI side)
"plugins": [
  "/home/tiago/Projects/opencode-dynamic-context-pruning",
  // ...other plugins
],
```

```jsonc
// ~/.config/opencode/dcp.jsonc
"autoUpdate": false,
```

Build before running (the plugin entry `server.js` re-exports `dist/index.js`, so `dist/` must be
current):

```sh
npm ci --legacy-peer-deps
npm run build
```

Then restart the service (and the TUI). Local-path installs are not auto-updatable: `lib/update.ts`
only rewrites package dirs inside a `node_modules/<name>@<semver-range>` wrapper.

## Sync with upstream

```sh
git fetch upstream
git switch fix/tokenizer-cost && git rebase upstream/master && git push --force-with-lease
git switch fork/dogfood      && git rebase fix/tokenizer-cost && git push --force-with-lease
```

## Rollback

Restore the config backups (`~/.config/opencode/*.bak-antes-fork-20261019`), restart service + TUI,
and the npm-installed `@tarquinen/opencode-dcp@latest` takes over again. As an emergency stop-gap
the previous local tokenizer hotfix is still available: `~/.local/bin/dcp-tokenizer-hotfix`
(patches the tokenizer copy inside the OpenCode npm cache).

## License

Upstream is AGPL-3.0-or-later; this fork keeps the same license and attribution. The only
modification is in `lib/token-utils.ts` (plus tests and bench scripts); source stays public here.