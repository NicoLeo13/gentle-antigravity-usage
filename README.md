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

## License

MIT.
