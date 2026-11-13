// CPA Quota frontend: a sidebar page listing every CLIProxyAPI account with
// its quota windows, plus a compact disclosure above the sidebar footer. Data
// comes from the server's quota_get RPC; the server publishes "quota-updated"
// whenever any surface fetches a fresh snapshot.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import type { Account, QuotaWindow, Snapshot, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Same mark as the Account Pooler, so both pool views read as one family. */
const PLUGIN_ICON = "Layers";

/** The page refetches on this interval while it is open. */
const POLL_MS = 120_000;

// ---------------------------------------------------------------- data

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (force: boolean) => {
      setLoading(true);
      rpc
        .call("quota_get", { force })
        .then(
          (next) => {
            setSnapshot(next);
            setError(null);
          },
          (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setLoading(false));
    },
    [rpc],
  );
  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  // Another window or `bb cpa-quota status --refresh` fetched a fresh
  // snapshot; read it from the server cache.
  useRealtime("quota-updated", () => load(false));
  return { snapshot, error, loading, refresh: () => load(true) };
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------- formatting

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function parseTime(iso: string | null): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

function resetIn(window: QuotaWindow, now: number): string | null {
  const at = parseTime(window.resetsAt);
  if (at === null) return null;
  return at <= now ? "due" : formatDuration(at - now);
}

function resetClock(window: QuotaWindow): string | null {
  const at = parseTime(window.resetsAt);
  if (at === null) return null;
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ageText(iso: string | null, now: number): string {
  const at = parseTime(iso);
  if (at === null) return "unknown";
  const ms = now - at;
  return ms < 60_000 ? "just now" : `${formatDuration(ms)} ago`;
}

const numberFormat = new Intl.NumberFormat();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- severity

type Level = "ok" | "warn" | "full";

function levelOf(percent: number): Level {
  if (percent >= 90) return "full";
  if (percent >= 70) return "warn";
  return "ok";
}

const BAR: Record<Level, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  full: "bg-red-500",
};

const TEXT: Record<Level, string> = {
  ok: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  full: "text-red-600 dark:text-red-400",
};

function isDown(account: Account): boolean {
  return account.disabled || account.unavailable || account.status !== "active";
}

function downLabel(account: Account): string {
  if (account.disabled) return "Disabled";
  if (account.unavailable) return "Unavailable";
  return account.status.charAt(0).toUpperCase() + account.status.slice(1);
}

/** The window closest to its limit: what decides whether the account can take work. */
function tightest(account: Account): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const window of account.windows) {
    if (best === null || window.usedPercent > best.usedPercent) best = window;
  }
  return best;
}

// ---------------------------------------------------------------- providers

/** CPA provider keys mapped to bb agent provider ids, for their logos. */
const AGENT_PROVIDER: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
};

const PROVIDER_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "gemini-cli": "Gemini CLI",
  qwen: "Qwen",
  iflow: "iFlow",
  antigravity: "Antigravity",
  vertex: "Vertex",
};

function providerName(provider: string): string {
  return PROVIDER_NAME[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  const { providers } = useProviders();
  const agentId = AGENT_PROVIDER[provider] ?? provider;
  const record = providers.find((candidate) => candidate.id === agentId) ?? { id: agentId };
  return (
    <ProviderIcon
      providerKind="agent"
      provider={record}
      fallback="Bot"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
    />
  );
}

function groupByProvider(accounts: Account[]): Array<[string, Account[]]> {
  const groups = new Map<string, Account[]>();
  for (const account of accounts) {
    const list = groups.get(account.provider) ?? [];
    list.push(account);
    groups.set(account.provider, list);
  }
  return [...groups.entries()];
}

// ---------------------------------------------------------------- shared bits

function Bar({ percent, className }: { percent: number; className?: string }) {
  const width = Math.min(100, Math.max(percent, percent > 0 ? 2 : 0));
  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", BAR[levelOf(percent)])}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function Pill({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "bad" | "accent" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium leading-none",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "accent" && "bg-primary/10 text-primary",
        tone === "bad" && "bg-red-500/10 text-red-600 dark:text-red-400",
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- page

function WindowRow({ window, now }: { window: QuotaWindow; now: number }) {
  const level = levelOf(window.usedPercent);
  const reset = resetIn(window, now);
  const clock = resetClock(window);
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {window.label}
        </span>
        <span className={cn("font-mono text-[13px] font-medium tabular-nums", TEXT[level])}>
          {Math.round(window.usedPercent)}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={window.label}
        aria-valuenow={window.usedPercent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <Bar percent={window.usedPercent} className="mt-1.5 h-1.5" />
      </div>
      {reset ? (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Icon name="RotateCcw" className="size-3" aria-hidden />
          <span>{reset === "due" ? "Reset due" : `Resets in ${reset}`}</span>
          {clock ? <span className="opacity-70">· {clock}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function AccountCard({ account, now }: { account: Account; now: number }) {
  const down = isDown(account);
  const top = tightest(account);
  const exhausted = top !== null && top.usedPercent >= 100;
  const total = account.success + account.failed;
  const failRate = total > 0 ? (account.failed / total) * 100 : 0;
  return (
    <article
      className={cn(
        "flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-colors",
        down || exhausted ? "border-red-500/40" : "border-border",
      )}
    >
      <header className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <ProviderMark provider={account.provider} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={account.label}>
            {account.label}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                down ? "bg-red-500" : exhausted ? "bg-amber-500" : "bg-emerald-500",
              )}
              aria-hidden
            />
            <span>{down ? downLabel(account) : exhausted ? "Limit reached" : "Active"}</span>
          </div>
        </div>
        {account.plan ? <Pill tone="accent">{account.plan.toUpperCase()}</Pill> : null}
      </header>

      {account.statusMessage ? (
        <p className="mt-3 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400">
          {account.statusMessage}
        </p>
      ) : null}

      <div className="mt-4 flex-1 space-y-3.5">
        {account.windows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No quota data yet.</p>
        ) : (
          account.windows.map((window) => <WindowRow key={window.label} window={window} now={now} />)
        )}
      </div>

      {account.notes.length > 0 || account.cooldowns.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {account.notes.map((note) => (
            <Pill key={note}>{note}</Pill>
          ))}
          {account.cooldowns.map((cooldown) => (
            <Pill key={cooldown} tone="bad">
              <Icon name="Pause" className="size-3" aria-hidden />
              {cooldown}
            </Pill>
          ))}
        </div>
      ) : null}

      {account.fetchError ? (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          Usage lookup failed: {account.fetchError}
        </p>
      ) : null}

      <footer className="mt-4 flex items-center gap-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1" title="Where the quota numbers came from">
          <Icon
            name={account.source === "none" ? "CloudOff" : "Clock"}
            className="size-3"
            aria-hidden
          />
          {account.source === "live"
            ? `Live, ${ageText(account.observedAt, now)}`
            : account.source === "signals"
              ? `Last request, ${ageText(account.observedAt, now)}`
              : "No usage source"}
        </span>
        <span className="ml-auto tabular-nums" title={`${account.success} ok, ${account.failed} failed`}>
          {numberFormat.format(total)} req
          {account.failed > 0 ? (
            <span className={cn(failRate >= 5 && "text-red-600 dark:text-red-400")}>
              {" "}
              · {failRate < 0.1 ? "<0.1" : failRate.toFixed(1)}% failed
            </span>
          ) : null}
        </span>
      </footer>
    </article>
  );
}

function ProviderSection({ provider, accounts, now }: { provider: string; accounts: Account[]; now: number }) {
  const ready = accounts.filter((account) => !isDown(account) && (tightest(account)?.usedPercent ?? 0) < 100);
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <ProviderMark provider={provider} />
        <h2 className="text-sm font-semibold">{providerName(provider)}</h2>
        <span className="text-xs text-muted-foreground">
          {ready.length} of {accounts.length} ready
        </span>
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
        {accounts.map((account) => (
          <AccountCard key={account.id} account={account} now={now} />
        ))}
      </div>
    </section>
  );
}

function EmptyState({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
    >
      <Icon name={icon} className="size-5" aria-hidden />
      {children}
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]" aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-48 animate-pulse rounded-xl border border-border bg-muted/40" />
      ))}
    </div>
  );
}

function QuotaPage() {
  const { snapshot, error, loading, refresh } = useSnapshot();
  const now = useNow(30_000);
  const problem = error ?? snapshot?.error ?? null;
  const groups = useMemo(() => (snapshot ? groupByProvider(snapshot.accounts) : []), [snapshot]);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-5xl px-4 pb-8 pt-4 md:px-6 md:pt-6">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {snapshot ? (
              <span className="flex items-center gap-1.5 truncate">
                <Icon name="ComputerCloud" className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{hostOf(snapshot.baseUrl)}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">updated {ageText(snapshot.fetchedAt, now)}</span>
              </span>
            ) : (
              "CLIProxyAPI"
            )}
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {problem ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400"
          >
            <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{problem}</span>
          </div>
        ) : null}

        <div className="mt-6 space-y-8">
          {snapshot === null ? (
            error ? null : <SkeletonCards />
          ) : snapshot.accounts.length === 0 && !snapshot.error ? (
            <EmptyState icon="Info">No accounts in CPA yet. Add one in the management panel.</EmptyState>
          ) : (
            groups.map(([provider, accounts]) => (
              <ProviderSection key={provider} provider={provider} accounts={accounts} now={now} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- footer

function CompactWindow({ window, now }: { window: QuotaWindow; now: number }) {
  const reset = resetIn(window, now);
  const clock = resetClock(window);
  const level = levelOf(window.usedPercent);
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_3.5rem_2.25rem] items-center gap-2 text-[11px]"
      title={reset ? `${window.label}: resets ${reset === "due" ? "now" : `in ${reset}`}${clock ? ` (${clock})` : ""}` : window.label}
    >
      <span className="flex min-w-0 items-baseline gap-1 text-muted-foreground">
        <span className="truncate">{window.label}</span>
        {reset && reset !== "due" ? <span className="shrink-0 opacity-60">{reset}</span> : null}
      </span>
      <Bar percent={window.usedPercent} className="h-1" />
      <span className={cn("text-right font-mono tabular-nums", TEXT[level])}>
        {Math.round(window.usedPercent)}%
      </span>
    </div>
  );
}

/** Compact view shown above the sidebar footer row. */
function FooterQuota({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const { snapshot, error, loading, refresh } = useSnapshot();
  const navigate = useBbNavigate();
  const now = useNow(30_000);
  const problem = error ?? snapshot?.error ?? null;
  return (
    <div className="max-h-[60vh] overflow-y-auto px-2 pb-2 pt-1.5 text-sm">
      <div className="flex items-center gap-1.5 pl-1">
        <Icon name={PLUGIN_ICON} className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium">CPA quotas</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {snapshot ? ageText(snapshot.fetchedAt, now) : ""}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Refresh quotas"
          onClick={refresh}
          disabled={loading}
        >
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Open quota page"
          onClick={() => {
            navigate.toPluginPanel("quotas");
            dismiss();
          }}
        >
          <Icon name="Maximize2" className="size-3.5" />
        </Button>
      </div>
      {problem ? (
        <p className="mt-1 px-1 text-[11px] text-red-600 dark:text-red-400">{problem}</p>
      ) : null}
      {snapshot === null ? (
        error ? null : (
          <div className="mt-2 space-y-1.5 px-1" aria-hidden>
            {[0, 1].map((index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        )
      ) : (
        <div className="mt-1.5 space-y-1">
          {snapshot.accounts.map((account) => {
            const down = isDown(account);
            return (
              <div key={account.id} className="rounded-md px-1.5 py-1.5 hover:bg-muted/50">
                <div className="flex items-center gap-1.5 text-xs">
                  <ProviderMark provider={account.provider} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate" title={account.label}>
                    {account.label}
                  </span>
                  {down ? (
                    <span className="shrink-0 text-[11px] text-red-600 dark:text-red-400">
                      {downLabel(account)}
                    </span>
                  ) : account.plan ? (
                    <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
                      {account.plan}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 space-y-0.5 pl-5">
                  {account.windows.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No quota data</p>
                  ) : (
                    account.windows.map((window) => (
                      <CompactWindow key={window.label} window={window} now={now} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "quotas",
    title: "CPA quotas",
    icon: PLUGIN_ICON,
    path: "quotas",
    component: QuotaPage,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "quota",
    label: "CPA quotas",
    icon: PLUGIN_ICON,
    component: FooterQuota,
  });
});
