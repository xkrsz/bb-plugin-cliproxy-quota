---
name: cpa-quota
description: Check Claude, Codex and other subscription quotas in the user's CLIProxyAPI (CPA) instance. Use when asked about remaining usage, rate limits, which account is near its limit, or when a request fails with a quota or rate-limit error.
---

# CPA quota

CLIProxyAPI (CPA) proxies Claude, Codex and other subscription traffic and
rotates between the accounts it holds. This plugin reads each account's quota
from CPA's management API.

```sh
bb cpa-quota status            # cached up to 60s
bb cpa-quota status --refresh  # fetch fresh numbers
bb cpa-quota status --json     # Snapshot JSON: { baseUrl, fetchedAt, error, accounts[] }
```

Each account has `provider`, `label`, `plan`, `status`, `windows[]`
(`label`, `usedPercent` 0-100, `resetsAt` ISO), `notes[]`, `cooldowns[]`
and `source`:

- `live`: read from the provider's usage endpoint just now (Claude, Codex).
- `signals`: parsed from rate-limit headers on the last proxied request. Can be
  stale; check `observedAt`.
- `none`: CPA has no quota data for this provider.

The same data shows on the "CPA quotas" sidebar page and in the sidebar footer.

## Settings

`bb plugin config cpa-quota` shows them.

- `baseUrl`: CPA URL, default `http://localhost:8317`.
- `managementKeyFile`: file holding the management key, default
  `~/.config/cliproxyapi/management-key` on the bb server machine.
- `managementKey`: secret override. Never pass the key on a command line in a
  shared transcript; prefer the key file.

Do not change CPA accounts or settings from here. Use the CPA management panel
at `<baseUrl>/management.html`.
