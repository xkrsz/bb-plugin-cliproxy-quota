# bb-plugin-cliproxy-quota

[bb](https://getbb.app) plugin that shows subscription quotas for every account in a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) instance.

- Claude: 5h session, weekly and per-model weekly limits, extra-usage spend.
- Codex: primary and secondary windows, code review limits, credits.
- Any other provider CPA supports: utilization from the rate-limit headers of its last proxied request.

It adds a "CPA quotas" sidebar page, a quick view in the sidebar footer, a `bb cpa-quota status` command, and a skill so agents can check quotas themselves.

## Install

```sh
bb plugin install https://github.com/xkrsz/bb-plugin-cliproxy-quota
```

The plugin id is `cpa-quota`.

## Setup

The plugin needs CPA's management key (`remote-management.secret-key` in the CPA config). Put it in a file on the machine that runs the bb server:

```sh
mkdir -p ~/.config/cliproxyapi
(umask 077; cat > ~/.config/cliproxyapi/management-key)   # paste the key, then Ctrl-D
```

If CPA doesn't run on `http://localhost:8317`, point the plugin at it:

```sh
bb plugin config cpa-quota set baseUrl https://cpa.example.com
bb cpa-quota status --refresh
```

| Setting | Default | |
| --- | --- | --- |
| `baseUrl` | `http://localhost:8317` | CPA URL |
| `managementKeyFile` | `~/.config/cliproxyapi/management-key` | File holding the management key |
| `managementKey` | | Secret override for the key file |

For a remote CPA, set `remote-management.allow-remote: true` in its config.

## How it works

The server asks CPA for its auth files, then for each Claude and Codex account calls the provider's usage endpoint through CPA's `/v0/management/api-call`. CPA injects the account's token, so the plugin never sees provider credentials. Snapshots are cached for 60 seconds.

- `quota.ts`: management API client and parsers.
- `server.ts`: settings, snapshot cache, `quota_get` RPC, CLI.
- `app.tsx`: sidebar page and footer view.
- `skills/cpa-quota`: agent instructions.

## Develop

```sh
npm install
bb plugin build
bb plugin install .
```
