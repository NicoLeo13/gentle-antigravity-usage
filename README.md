# pi-gentle-antigravity-usage

A [Pi](https://pi.dev) extension package that feeds **Google Antigravity subscription quota** into
Gentle Shell's usage panel (`alt+u`), which previously showed `0` for all `antigravity-acp/*` models.

## How it works

The pipeline has three parts, and this package is only the middle bridge:

```
pi-antigravity-acp-provider            pi-gentle-antigravity-usage           gentle-shell
(quota authority; official agy         (this package: event bridge)          (usage panel)
 /usage parsing, 60 s cache)
  antigravity-acp:quota:request  ────▶  snapshot → ProviderUsage  ────▶  gentle-pi:usage-source/v1
  { reply }                                     source.fetch()
```

- **No tokens, no network calls.** The quota numbers come from `pi-antigravity-acp-provider`,
  which runs the official `agy` CLI flow. This extension never reads credentials and never builds
  requests.
- The source is registered on `session_start`, so it always lands after gentle-shell's own
  `USAGE_SOURCE_EVENT` subscription. Re-registration replaces, never accumulates.
- Lossy translation, validated on both ends: `remainingFraction` becomes `usedPercent`, bucket
  labels become window labels (`5h`, `week`, parsed `Nh`/`Nd`), and `resetTime` becomes epoch
  seconds. Unknown window labels fall back to the common 5h plan window.

## Install (Gentle Shell isolated home)

```sh
gentle-shell --isolated -- pi install <path-to-this-folder>
```

## Contract

Imported from two installed components (versions documented, not vendored):

| Channel / schema                        | Owner                       | Seen at                    |
| --------------------------------------- | --------------------------- | -------------------------- |
| `gentle-pi:usage-source/v1`             | gentle-pi 4.5.1 (Shell)     | `lib/shell-usage.ts`       |
| `gentle-pi.usage-source/v1` payload     | gentle-pi 4.5.1 (Shell)     | `lib/shell-usage.ts`       |
| `antigravity-acp:quota:request`         | pi-antigravity-acp-provider | `src/constants.ts`         |
| `AntigravityQuotaSnapshot`              | pi-antigravity-acp-provider | `src/acp/usage-quota.ts`   |

If either side renames a channel, this package stops feeding the panel (gracefully: the panel
falls back to its pending note).

## Cost backfill

`scripts/backfill-costs.ts` retro-prices historical Pi session files that were recorded before
`pi-antigravity-acp-provider` priced turns (the provider used to hardcode `cost: 0`). It applies
the same models.dev catalog rates as the provider patch, computes cost exactly the way pi-ai's
`calculateCost` does (including the 3.1 Pro >200k tier), and rewrites files atomically with a
`.bak` of each original.

Rules worth knowing:

- Only assistant messages of provider `antigravity-acp` with `cost.total === 0` and positive
  per-category tokens are touched.
- Messages that reported only a cumulative `totalTokens` with no input/output/cache split
  (typical streaming `toolUse` updates) are **left at zero**: pricing them would require
  inventing a token breakdown.
- Zero-token turns (`stopReason: error`, empty replies) are left alone — there is nothing to
  price.
- Files modified more recently than `--min-age-seconds` (default 120) are skipped, as are paths
  passed via `--open` (sessions attached to a live pane). Pi appends to session files by path
  (`appendFileSync`), so a rewrite-by-rename never loses future appends, but the running
  process keeps its in-memory view until the pane is restarted — restart the pane first, then
  backfill, to see the recovered totals.

```sh
bun scripts/backfill-costs.ts [--root <sessions-dir>] [--min-age-seconds N] [--open <session.jsonl> ...]
```

## License

MIT.
