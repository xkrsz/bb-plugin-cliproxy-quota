// CPA Quota: shows subscription quota for every account in a CLIProxyAPI
// instance. One cached snapshot feeds the sidebar page (RPC), the
// `bb cpa-quota` CLI, and the skill in skills/cpa-quota.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CpaClient, fetchSnapshot, snapshotSchema, type Snapshot } from "./quota";

export type { Account, QuotaWindow, Snapshot } from "./quota";

export const rpcContract = defineRpcContract({
  quota_get: {
    input: z.object({ force: z.boolean() }),
    output: snapshotSchema,
  },
});

/** Realtime channel app.tsx listens on after each fresh snapshot. */
const QUOTA_UPDATED = "quota-updated";
/** Snapshots younger than this are served from memory. */
const CACHE_MS = 60_000;

const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "CPA base URL",
      default: "http://localhost:8317",
    },
    managementKey: {
      type: "string",
      label: "Management key (overrides the key file)",
      secret: true,
    },
    managementKeyFile: {
      type: "string",
      label: "Management key file",
      default: "~/.config/cliproxyapi/management-key",
    },
  });

  async function resolveConfig(): Promise<{ baseUrl: string; key: string | null }> {
    const { baseUrl, managementKey, managementKeyFile } = await settings.get();
    const url = baseUrl.trim().replace(/\/+$/, "");
    if (typeof managementKey === "string" && managementKey.trim() !== "") {
      return { baseUrl: url, key: managementKey.trim() };
    }
    if (managementKeyFile.trim() === "") return { baseUrl: url, key: null };
    try {
      const key = (await readFile(expandHome(managementKeyFile.trim()), "utf8")).trim();
      return { baseUrl: url, key: key === "" ? null : key };
    } catch {
      return { baseUrl: url, key: null };
    }
  }

  const MISSING_KEY =
    "No CPA management key. Put it in ~/.config/cliproxyapi/management-key (mode 600) " +
    "or set managementKey with `bb plugin config cpa-quota set managementKey ...`.";

  {
    const initial = await resolveConfig();
    if (initial.key === null) bb.status.needsConfiguration(MISSING_KEY);
  }

  let cached: Snapshot | null = null;
  let inFlight: Promise<Snapshot> | null = null;

  async function snapshot(force: boolean): Promise<Snapshot> {
    if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_MS) {
      return cached;
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const { baseUrl, key } = await resolveConfig();
      const next: Snapshot =
        key === null
          ? { baseUrl, fetchedAt: new Date().toISOString(), error: MISSING_KEY, accounts: [] }
          : await fetchSnapshot(new CpaClient(baseUrl, key), baseUrl);
      cached = next;
      bb.realtime.publish(QUOTA_UPDATED, { fetchedAt: next.fetchedAt });
      return next;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  bb.rpc.register(rpcContract, {
    quota_get: ({ force }) => snapshot(force),
  });

  const usage = [
    "Usage:",
    "  bb cpa-quota status [--refresh] [--json]",
    "",
    "Shows quota windows for every account in CLIProxyAPI. Results are cached",
    "for 60s; --refresh bypasses the cache.",
  ].join("\n");

  function relative(iso: string | null): string {
    if (iso === null) return "";
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "resets now";
    const minutes = Math.round(ms / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    const parts = days > 0 ? [`${days}d`, `${hours}h`] : hours > 0 ? [`${hours}h`, `${mins}m`] : [`${mins}m`];
    return `resets in ${parts.join(" ")}`;
  }

  function formatSnapshot(snap: Snapshot): string {
    if (snap.error) return `Error: ${snap.error}`;
    if (snap.accounts.length === 0) return `No accounts in ${snap.baseUrl}.`;
    const lines: string[] = [];
    for (const account of snap.accounts) {
      const flags = [
        account.plan,
        account.status,
        account.disabled ? "disabled" : null,
        account.unavailable ? "unavailable" : null,
      ].filter(Boolean);
      lines.push(`${account.provider}  ${account.label}  (${flags.join(", ")})`);
      if (account.statusMessage) lines.push(`  status: ${account.statusMessage}`);
      for (const window of account.windows) {
        lines.push(
          `  ${window.label.padEnd(22)} ${`${window.usedPercent}%`.padStart(6)}  ${relative(window.resetsAt)}`,
        );
      }
      if (account.windows.length === 0) lines.push("  no quota data");
      if (account.source === "signals") lines.push(`  (from last request headers, ${account.observedAt ?? "unknown time"})`);
      if (account.fetchError) lines.push(`  usage lookup failed: ${account.fetchError}`);
      for (const note of account.notes) lines.push(`  ${note}`);
      for (const cooldown of account.cooldowns) lines.push(`  cooldown: ${cooldown}`);
    }
    lines.push(`fetched ${snap.fetchedAt}`);
    return lines.join("\n");
  }

  bb.cli.register({
    name: "cpa-quota",
    summary: "Show subscription quotas from CLIProxyAPI",
    commands: [
      {
        name: "status",
        summary: "Quota windows for every CPA account",
        usage: "bb cpa-quota status [--refresh] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const refresh = argv.includes("--refresh");
      const [command, ...rest] = argv.filter((arg) => arg !== "--json" && arg !== "--refresh");
      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage };
      }
      if (command !== "status" || rest.length > 0) return { exitCode: 1, stderr: usage };
      const snap = await snapshot(refresh);
      return {
        exitCode: snap.error ? 1 : 0,
        stdout: json ? JSON.stringify(snap) : formatSnapshot(snap),
      };
    },
  });
}
