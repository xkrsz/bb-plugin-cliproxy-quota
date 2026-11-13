// Fetches and normalizes subscription quotas from a CLIProxyAPI (CPA)
// management API. Pure module: no bb imports, so tests can drive it with a
// fake fetch.
import { z } from "zod";

export const windowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});
export type QuotaWindow = z.infer<typeof windowSchema>;

export const accountSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  plan: z.string().nullable(),
  status: z.string(),
  statusMessage: z.string(),
  disabled: z.boolean(),
  unavailable: z.boolean(),
  success: z.number(),
  failed: z.number(),
  cooldowns: z.array(z.string()),
  source: z.enum(["live", "signals", "none"]),
  observedAt: z.string().nullable(),
  fetchError: z.string().nullable(),
  windows: z.array(windowSchema),
  notes: z.array(z.string()),
});
export type Account = z.infer<typeof accountSchema>;

export const snapshotSchema = z.object({
  baseUrl: z.string(),
  fetchedAt: z.string(),
  error: z.string().nullable(),
  accounts: z.array(accountSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

type Json = Record<string, unknown>;
type Fetch = typeof fetch;

const isObj = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const clampPercent = (value: number) =>
  Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
const epochToIso = (value: unknown): string | null => {
  const n = num(value);
  return n === null || n <= 0 ? null : new Date(n * 1000).toISOString();
};

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export class CpaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly managementKey: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.managementKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`CPA ${path} returned HTTP ${response.status}`);
    }
    return response.json();
  }

  async authFiles(): Promise<Json[]> {
    const body = await this.request("/v0/management/auth-files");
    const files = isObj(body) ? body.files : null;
    return Array.isArray(files) ? files.filter(isObj) : [];
  }

  /** Proxies a request through CPA, which swaps $TOKEN$ for the account's token. */
  async apiCall(authIndex: string, url: string, header: Record<string, string>) {
    const body = await this.request("/v0/management/api-call", {
      method: "POST",
      body: JSON.stringify({ authIndex, method: "GET", url, header }),
    });
    if (!isObj(body)) throw new Error("CPA api-call returned no body");
    const status = num(body.status_code) ?? 0;
    let parsed: unknown = body.body;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // Leave as text; the status check below reports it.
      }
    }
    if (status < 200 || status >= 300) {
      const detail =
        isObj(parsed) && isObj(parsed.error)
          ? str(parsed.error.message)
          : typeof parsed === "string"
            ? parsed.slice(0, 160)
            : null;
      throw new Error(`upstream HTTP ${status}${detail ? `: ${detail}` : ""}`);
    }
    if (!isObj(parsed)) throw new Error("upstream returned non-JSON body");
    return parsed;
  }
}

// ---- Claude ----------------------------------------------------------------

const CLAUDE_LEGACY_WINDOWS: Array<[string, string]> = [
  ["five_hour", "5h session"],
  ["seven_day", "Weekly (all models)"],
  ["seven_day_opus", "Weekly Opus"],
  ["seven_day_sonnet", "Weekly Sonnet"],
  ["iguana_necktie", "Weekly Fable"],
  ["seven_day_oauth_apps", "Weekly OAuth apps"],
  ["seven_day_cowork", "Weekly Cowork"],
];

function claudeLimitLabel(limit: Json): string {
  const kind = str(limit.kind) ?? "limit";
  const scope = isObj(limit.scope) ? limit.scope : null;
  const model = scope && isObj(scope.model) ? str(scope.model.display_name) : null;
  const surface = scope && isObj(scope.surface) ? str(scope.surface.display_name) : null;
  if (kind === "session") return "5h session";
  if (kind === "weekly_all") return "Weekly (all models)";
  if (kind === "weekly_scoped") return `Weekly ${model ?? surface ?? "scoped"}`;
  const pretty = kind.replace(/_/g, " ");
  return model ? `${pretty} ${model}` : pretty;
}

export function parseClaudeUsage(body: Json): { windows: QuotaWindow[]; notes: string[] } {
  const windows: QuotaWindow[] = [];
  const notes: string[] = [];
  if (Array.isArray(body.limits) && body.limits.length > 0) {
    for (const limit of body.limits.filter(isObj)) {
      const percent = num(limit.percent);
      if (percent === null) continue;
      windows.push({
        label: claudeLimitLabel(limit),
        usedPercent: clampPercent(percent),
        resetsAt: str(limit.resets_at),
      });
    }
  } else {
    for (const [key, label] of CLAUDE_LEGACY_WINDOWS) {
      const bucket = body[key];
      if (!isObj(bucket)) continue;
      const utilization = num(bucket.utilization);
      if (utilization === null) continue;
      windows.push({
        label,
        usedPercent: clampPercent(utilization),
        resetsAt: str(bucket.resets_at),
      });
    }
  }
  for (const [key, label] of CLAUDE_LEGACY_WINDOWS) {
    const bucket = body[key];
    if (!isObj(bucket)) continue;
    const used = num(bucket.used_dollars);
    const limit = num(bucket.limit_dollars);
    if (used !== null && limit !== null) {
      notes.push(`${label}: $${used.toFixed(2)} of $${limit.toFixed(2)}`);
    }
    const locked = str(bucket.locked_reason);
    if (locked) notes.push(`${label} locked: ${locked}`);
  }
  const extra = isObj(body.extra_usage) ? body.extra_usage : null;
  if (extra && extra.is_enabled === true) {
    const places = num(extra.decimal_places) ?? 2;
    const scale = 10 ** places;
    const used = num(extra.used_credits);
    const limit = num(extra.monthly_limit);
    const currency = str(extra.currency) ?? "";
    const fmt = (n: number) => `${(n / scale).toFixed(2)} ${currency}`.trim();
    notes.push(
      `Extra usage on${used !== null ? `: ${fmt(used)}` : ""}${limit !== null ? ` of ${fmt(limit)}/month` : ""}`,
    );
    if (extra.spend_limit_reached === true) notes.push("Extra usage spend limit reached");
  }
  return { windows, notes };
}

// ---- Codex -----------------------------------------------------------------

function codexWindowLabel(seconds: number | null, prefix: string): string {
  let base: string;
  if (seconds === null || seconds <= 0) base = "window";
  else if (seconds === 604_800) base = "Weekly";
  else if (seconds % 86_400 === 0) base = `${seconds / 86_400}d`;
  else if (seconds % 3600 === 0) base = `${seconds / 3600}h`;
  else base = `${Math.round(seconds / 60)}m`;
  return prefix ? `${prefix} ${base}` : base;
}

function codexWindows(rateLimit: unknown, prefix: string): QuotaWindow[] {
  if (!isObj(rateLimit)) return [];
  const result: QuotaWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = rateLimit[key];
    if (!isObj(window)) continue;
    const used = num(window.used_percent);
    if (used === null) continue;
    result.push({
      label: codexWindowLabel(num(window.limit_window_seconds), prefix),
      usedPercent: clampPercent(used),
      resetsAt: epochToIso(window.reset_at),
    });
  }
  return result;
}

export function parseCodexUsage(body: Json): {
  windows: QuotaWindow[];
  notes: string[];
  plan: string | null;
} {
  const windows = codexWindows(body.rate_limit, "");
  windows.push(...codexWindows(body.code_review_rate_limit, "Code review"));
  if (Array.isArray(body.additional_rate_limits)) {
    for (const extra of body.additional_rate_limits.filter(isObj)) {
      const name =
        str(extra.limit_name) ?? str(extra.metered_feature) ?? str(extra.name) ?? "Extra";
      windows.push(...codexWindows(extra.rate_limit ?? extra, name));
    }
  }
  const notes: string[] = [];
  const rateLimit = isObj(body.rate_limit) ? body.rate_limit : null;
  if (rateLimit?.limit_reached === true) notes.push("Rate limit reached");
  const credits = isObj(body.credits) ? body.credits : null;
  if (credits?.unlimited === true) notes.push("Credits: unlimited");
  else if (credits?.has_credits === true) {
    const balance = num(credits.balance);
    if (balance !== null) notes.push(`Credits: ${Math.round(balance).toLocaleString("en-US")}`);
  }
  const resets = isObj(body.rate_limit_reset_credits) ? body.rate_limit_reset_credits : null;
  const resetCount = resets ? num(resets.available_count) : null;
  if (resetCount) notes.push(`Limit resets available: ${resetCount}`);
  return { windows, notes, plan: str(body.plan_type) };
}

// ---- Signals fallback (any provider) ---------------------------------------

/**
 * CPA records rate-limit response headers per account as quota.signals. Used
 * when the live usage call fails and for providers without a usage endpoint.
 */
export function parseSignals(signals: Json): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const anthropic: Array<[string, string]> = [
    ["5h", "5h session"],
    ["7d", "Weekly (all models)"],
  ];
  for (const [key, label] of anthropic) {
    const util = num(signals[`Anthropic-Ratelimit-Unified-${key}-Utilization`]);
    if (util === null) continue;
    windows.push({
      label,
      usedPercent: clampPercent(util * 100),
      resetsAt: epochToIso(signals[`Anthropic-Ratelimit-Unified-${key}-Reset`]),
    });
  }
  for (const which of ["Primary", "Secondary"]) {
    const used = num(signals[`X-Codex-${which}-Used-Percent`]);
    const minutes = num(signals[`X-Codex-${which}-Window-Minutes`]);
    if (used === null || !minutes) continue;
    windows.push({
      label: codexWindowLabel(minutes * 60, ""),
      usedPercent: clampPercent(used),
      resetsAt: epochToIso(signals[`X-Codex-${which}-Reset-At`]),
    });
  }
  if (windows.length > 0) return windows;
  // Unknown provider: surface any header that looks like a utilization or
  // used-percent value.
  for (const [key, value] of Object.entries(signals)) {
    const n = num(value);
    if (n === null) continue;
    if (/utiliz/i.test(key)) {
      windows.push({ label: key, usedPercent: clampPercent(n <= 1 ? n * 100 : n), resetsAt: null });
    } else if (/used[-_]?percent/i.test(key)) {
      windows.push({ label: key, usedPercent: clampPercent(n), resetsAt: null });
    }
  }
  return windows;
}

// ---- Assembly ---------------------------------------------------------------

function cooldownText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (!isObj(entry)) return String(entry);
  const model = str(entry.model) ?? str(entry.name);
  const until =
    str(entry.until) ?? str(entry.next_retry_after) ?? str(entry.retry_after) ?? str(entry.reset_at);
  const reason = str(entry.reason) ?? str(entry.message);
  return [model, until ? `until ${until}` : null, reason].filter(Boolean).join(" ") ||
    JSON.stringify(entry).slice(0, 160);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function buildAccount(client: CpaClient, file: Json): Promise<Account> {
  const provider = (str(file.provider) ?? str(file.type) ?? "unknown").toLowerCase();
  const id = str(file.auth_index) ?? str(file.id) ?? str(file.name) ?? "unknown";
  const idToken = isObj(file.id_token) ? file.id_token : null;
  const quota = isObj(file.quota) ? file.quota : null;
  const signals = quota && isObj(quota.signals) ? quota.signals : null;
  const account: Account = {
    id,
    provider,
    label: str(file.label) ?? str(file.email) ?? str(file.name) ?? id,
    plan: (idToken ? str(idToken.plan_type) : null) ?? str(file.plan_type),
    status: str(file.status) ?? "unknown",
    statusMessage: str(file.status_message) ?? "",
    disabled: file.disabled === true,
    unavailable: file.unavailable === true,
    success: num(file.success) ?? 0,
    failed: num(file.failed) ?? 0,
    cooldowns: Array.isArray(file.cooldowns) ? file.cooldowns.map(cooldownText) : [],
    source: "none",
    observedAt: quota ? str(quota.observed_at) : null,
    fetchError: null,
    windows: [],
    notes: [],
  };

  const authIndex = str(file.auth_index);
  if (authIndex && !account.disabled) {
    try {
      if (provider === "claude") {
        const body = await client.apiCall(authIndex, CLAUDE_USAGE_URL, {
          Authorization: "Bearer $TOKEN$",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-cli/2.1.322 (external, cli)",
          Accept: "application/json",
        });
        Object.assign(account, parseClaudeUsage(body));
        account.source = "live";
        account.observedAt = new Date().toISOString();
      } else if (provider === "codex") {
        const header: Record<string, string> = {
          Authorization: "Bearer $TOKEN$",
          "User-Agent": "codex-tui/0.149.1",
        };
        const accountId = idToken ? str(idToken.chatgpt_account_id) : null;
        if (accountId) header["Chatgpt-Account-Id"] = accountId;
        const body = await client.apiCall(authIndex, CODEX_USAGE_URL, header);
        const parsed = parseCodexUsage(body);
        account.windows = parsed.windows;
        account.notes = parsed.notes;
        account.plan = parsed.plan ?? account.plan;
        account.source = "live";
        account.observedAt = new Date().toISOString();
      }
    } catch (cause) {
      account.fetchError = errorText(cause);
    }
  }

  if (account.source === "none" && signals) {
    account.windows = parseSignals(signals);
    if (account.windows.length > 0) account.source = "signals";
  }
  return account;
}

export async function fetchSnapshot(client: CpaClient, baseUrl: string): Promise<Snapshot> {
  const fetchedAt = new Date().toISOString();
  let files: Json[];
  try {
    files = await client.authFiles();
  } catch (cause) {
    return { baseUrl, fetchedAt, error: errorText(cause), accounts: [] };
  }
  const accounts = await Promise.all(files.map((file) => buildAccount(client, file)));
  accounts.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
  );
  return { baseUrl, fetchedAt, error: null, accounts };
}
