/**
 * ZCode Plan (zcode.z.ai) login. Prefer importing the desktop JWT from
 * ~/.zcode/v2/credentials.json; browser CLI poll is the fallback.
 */
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, release, userInfo } from "node:os";
import { join } from "node:path";
import type { LocalTokenImportMode, OAuthController, OAuthCredentials } from "./types";

export const ZAI_PLAN_PROVIDER_ID = "zai-plan";
export const ZAI_PLAN_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
export const ZAI_PLAN_MESSAGES_URL = `${ZAI_PLAN_BASE_URL}/v1/messages`;
export const ZAI_ULTRA_MESSAGES_URL = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";
export const ZAI_PLAN_APP_VERSION = "3.11.2";
export const ZAI_ORIGIN = "https://zcode.z.ai";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ZaiPlanOAuthMetadata {
  deviceMid?: string;
  userId?: string;
}

function padB64(s: string): string {
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

function decryptEncV1(value: string, secret: string): string {
  const [ns, ts, cs] = value.slice("enc:v1:".length).split(".");
  if (!ns || !ts || !cs) throw new Error("malformed enc:v1");
  const nonce = Buffer.from(padB64(ns), "base64url");
  const tag = Buffer.from(padB64(ts), "base64url");
  const ct = Buffer.from(padB64(cs), "base64url");
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function secretCandidates(): string[] {
  const user = userInfo().username || process.env.USERNAME || "unknown";
  const plat = platform() === "win32" ? "win32" : platform();
  const home = homedir();
  return [...new Set([
    `zcode-credential-fallback:${plat}:${home}:${user}`,
    `zcode-credential-fallback:${plat}:${home.replaceAll("\\", "/")}:${user}`,
  ])];
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const mid = token.split(".")[1];
    if (!mid) return null;
    return JSON.parse(Buffer.from(padB64(mid), "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function jwtUserId(token: string): string | undefined {
  const payload = jwtPayload(token);
  const raw = payload?.user_id ?? payload?.sub;
  return raw != null ? String(raw) : undefined;
}

function readDeviceMid(): string {
  const path = join(homedir(), ".zcode", "v2", "telemetry-state.json");
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { deviceMid?: unknown };
    if (typeof json.deviceMid === "string" && json.deviceMid.length >= 8) return json.deviceMid;
  } catch { /* generate */ }
  return crypto.randomUUID();
}

function readCodingPlanKey(): string | undefined {
  const cfgPath = join(homedir(), ".zcode", "v2", "config.json");
  if (!existsSync(cfgPath)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      provider?: Record<string, { options?: { apiKey?: string } }>;
    };
    const key = cfg.provider?.["builtin:zai-coding-plan"]?.options?.apiKey?.trim();
    if (key && key.split(".").length === 2 && key.length >= 20) return key;
  } catch { /* ignore */ }
  return undefined;
}

function credentialFromJwt(access: string, source: OAuthCredentials["source"], extra?: { email?: string; refresh?: string; codingKey?: string }): OAuthCredentials {
  const userId = jwtUserId(access);
  const codingKey = extra?.codingKey ?? readCodingPlanKey();
  const cred: OAuthCredentials = {
    access,
    refresh: extra?.refresh?.trim() || access,
    expires: Date.now() + DEFAULT_TTL_MS,
    source,
    zaiPlan: {
      deviceMid: readDeviceMid(),
      sessionId: crypto.randomUUID(),
      ...(userId ? { userId } : {}),
      ...(codingKey ? { codingKey } : {}),
    },
  };
  if (userId) cred.accountId = userId;
  if (extra?.email) cred.email = extra.email;
  return cred;
}

export function importLocalZcodeJwt(): OAuthCredentials | null {
  const credPath = join(homedir(), ".zcode", "v2", "credentials.json");
  const cfgPath = join(homedir(), ".zcode", "v2", "config.json");
  if (!existsSync(credPath) && !existsSync(cfgPath)) return null;

  if (existsSync(credPath)) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, unknown>;
      const sealed = cred.zcodejwttoken;
      if (typeof sealed === "string" && sealed.startsWith("enc:v1:")) {
        for (const secret of secretCandidates()) {
          try {
            const jwt = decryptEncV1(sealed, secret);
            if (jwt.split(".").length === 3) {
              let email: string | undefined;
              const infoSealed = cred["oauth:zai:user_info"];
              if (typeof infoSealed === "string" && infoSealed.startsWith("enc:v1:")) {
                try {
                  const info = JSON.parse(decryptEncV1(infoSealed, secret)) as { email?: unknown };
                  if (typeof info.email === "string") email = info.email;
                } catch { /* ignore */ }
              }
              return credentialFromJwt(jwt, "local-cli", { email });
            }
          } catch { /* next secret */ }
        }
      }
    } catch {
      return null;
    }
  }

  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        provider?: Record<string, { options?: { apiKey?: string } }>;
      };
      const jwt = cfg.provider?.["builtin:zai-start-plan"]?.options?.apiKey
        ?? cfg.provider?.["builtin:zai-coding-plan"]?.options?.apiKey;
      if (typeof jwt === "string" && jwt.split(".").length === 3) {
        return credentialFromJwt(jwt, "local-cli");
      }
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Login cancelled", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Login cancelled", "AbortError"));
    }, { once: true });
  });
}

async function pasteJwt(ctrl: OAuthController): Promise<OAuthCredentials> {
  while (true) {
    if (ctrl.signal?.aborted) {
      throw ctrl.signal.reason ?? new DOMException("Login cancelled", "AbortError");
    }
    const input = (await ctrl.onManualCodeInput?.())?.trim();
    if (!input) continue;
    const jwt = input.includes("code=") ? "" : input;
    const token = jwt.includes(".") && jwt.split(".").length === 3 ? jwt : "";
    if (!token) throw new Error("Paste the ZCode Plan JWT (three dot-separated parts)");
    return credentialFromJwt(token, "manual");
  }
}

async function cliPollLogin(ctrl: OAuthController): Promise<OAuthCredentials> {
  const pollToken = randomBytes(32).toString("hex");
  const init = await fetch(`${ZAI_ORIGIN}/api/v1/oauth/cli/init`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pollToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ provider: "zai" }),
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(ctrl.signal ? [ctrl.signal] : [])]),
  });
  if (!init.ok) throw new Error(`ZCode login init failed: HTTP ${init.status}`);
  const started = await init.json() as { data?: { flow_id?: string; authorize_url?: string } };
  const flowId = started.data?.flow_id;
  const authorizeUrl = started.data?.authorize_url;
  if (!flowId || !authorizeUrl) throw new Error("ZCode login did not return a flow");

  ctrl.onAuth?.({
    url: authorizeUrl,
    instructions: "Sign in to ZCode in the browser, or paste a Plan JWT. A logged-in ZCode desktop can also be imported automatically.",
  });
  ctrl.onProgress?.("Waiting for ZCode authentication...");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ctrl.signal?.aborted) {
      throw ctrl.signal.reason ?? new DOMException("Login cancelled", "AbortError");
    }
    const poll = await fetch(`${ZAI_ORIGIN}/api/v1/oauth/cli/poll/${flowId}`, {
      headers: { Authorization: `Bearer ${pollToken}` },
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(ctrl.signal ? [ctrl.signal] : [])]),
    });
    if (poll.ok) {
      const body = await poll.json() as {
        data?: { token?: string; zcodejwttoken?: string; accessToken?: string; user?: { email?: string } };
      };
      const token = body.data?.token || body.data?.zcodejwttoken || body.data?.accessToken;
      if (typeof token === "string" && token.split(".").length === 3) {
        return credentialFromJwt(token, "oauth", { email: body.data?.user?.email });
      }
    }
    await sleep(POLL_INTERVAL_MS, ctrl.signal);
  }
  throw new Error("ZCode login timed out. Start the login again.");
}

export async function loginZaiPlan(
  ctrl: OAuthController = {},
  opts?: { importLocal?: LocalTokenImportMode },
): Promise<OAuthCredentials> {
  const mode = opts?.importLocal ?? "fallback";
  if (mode !== "off") {
    const local = importLocalZcodeJwt();
    if (local) {
      ctrl.onProgress?.("Imported ZCode desktop login");
      return local;
    }
    if (mode === "only") throw new Error("No ZCode desktop credentials at ~/.zcode/v2");
  }
  if (ctrl.onManualCodeInput) {
    return await Promise.race([cliPollLogin(ctrl), pasteJwt(ctrl)]);
  }
  return await cliPollLogin(ctrl);
}

export async function refreshZaiPlanToken(
  _refresh: string,
  _signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  const local = importLocalZcodeJwt();
  if (local) return local;
  const access = credential?.access?.trim();
  if (!access) throw new Error("ZCode Plan refresh requires a JWT");
  return credentialFromJwt(access, credential?.source ?? "oauth", {
    email: credential?.email,
    refresh: credential?.refresh,
  });
}

export function zaiPlanOsRelease(): string {
  try {
    return release();
  } catch {
    return "10.0.26200";
  }
}

/**
 * Official `buildZCodeSourceHeadersFromContext` (billing / non-model).
 * Model requests use `csn`/`usn` instead — those omit X-Device-Mid.
 */
export function buildZaiPlanIdentityHeaders(deviceMid: string): Record<string, string> {
  const n = ZAI_PLAN_APP_VERSION;
  return {
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": `ZCode/${n}`,
    "X-ZCode-App-Version": n,
    "X-Title": "Z Code@electron",
    "X-ZCode-Agent": "glm",
    "X-Platform": "win32-x64",
    "X-Release-Channel": "production",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": "Asia/Shanghai",
    "X-Os-Category": "windows",
    "X-Os-Version": zaiPlanOsRelease(),
    "X-Device-Mid": deviceMid,
  };
}

/** Official `csn` + `usn` + X-ZCode-Agent. No X-Device-Mid / x-query-id / x-session-id. */
export function buildOfficialStartPlanHeaders(opts: {
  jwt: string;
  deviceMid: string;
  captcha?: string;
}): Record<string, string> {
  const { "X-Device-Mid": _omit, ...identity } = buildZaiPlanIdentityHeaders(opts.deviceMid);
  void _omit;
  return {
    ...identity,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    authorization: `Bearer ${opts.jwt}`,
    "x-request-id": crypto.randomUUID(),
    "x-zcode-trace-id": crypto.randomUUID(),
    ...(opts.captcha
      ? {
        "X-Aliyun-Captcha-Verify-Param": opts.captcha,
        "X-Aliyun-Captcha-Verify-Region": "cn",
      }
      : {}),
  };
}

/** Official `createAnthropicRequestMetadataUserId` (UIo). Not the JWT sub. */
export function officialMetadataUserId(deviceMid: string, sessionId: string): string {
  let sid = sessionId;
  for (const prefix of ["sess_", "subagent_agent_"]) {
    if (sid.startsWith(prefix) && sid.length > prefix.length) sid = sid.slice(prefix.length);
  }
  return JSON.stringify({ device_id: deviceMid, account_uuid: "", session_id: sid });
}

export const ZAI_PLAN_MODEL_MAP: Record<string, string> = {
  "glm-5.3-flash": "GLM-5.3-Flash",
  "glm-5.3": "GLM-5.3",
  "glm-5.2": "GLM-5.2",
  "glm-5-turbo": "GLM-5-Turbo",
};

export function canonicalZaiPlanModel(modelId: string): string {
  const trimmed = modelId.trim();
  return ZAI_PLAN_MODEL_MAP[trimmed.toLowerCase()] ?? trimmed;
}

const EPHEMERAL = { type: "ephemeral" as const };

const ZAI_PLAN_HARNESS = "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.";

/** Official `buildDesktopContextSection` (Ylt). Required while desktopContextPrompt.enabled. */
export const ZAI_PLAN_DESKTOP_CONTEXT = [
  "# ZCode Desktop Context",
  "",
  "### Files & URLs",
  "- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).",
  "- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
  "- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).",
  "",
  "### Inline Code Comments",
  "- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.",
  "- Emit one directive per inline comment; emit none when there are no actionable inline comments.",
  "- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).",
  "- Optional attributes: start, end (1-based line numbers), priority (0-3).",
  "- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
  "- Keep line ranges tight; end defaults to start.",
  "- Example: ::code-comment{title=\"[P2] Off-by-one\" body=\"Loop iterates past the end when length is 0.\" file=\"/path/to/foo.ts\" start=10 end=11 priority=2}",
].join("\n");

export function buildStartPlanSystemBlocks(model?: string) {
  const env = [
    "# Environment",
    "You have been invoked in the following environment:",
    "- Primary working directory: unknown",
    "- Is a git repository: no",
    "- Platform: unknown",
    "- Shell: unknown",
    "- OS Version: unknown",
    ...(model ? [`- You are powered by the model named ${model}.`] : []),
  ].join("\n");
  return [
    { type: "text", text: "You are ZCode, an interactive coding agent", cache_control: EPHEMERAL },
    { type: "text", text: ZAI_PLAN_HARNESS, cache_control: EPHEMERAL },
    { type: "text", text: ZAI_PLAN_DESKTOP_CONTEXT, cache_control: EPHEMERAL },
    { type: "text", text: env, cache_control: EPHEMERAL },
  ];
}

export const ZAI_PLAN_SYSTEM_BLOCKS = buildStartPlanSystemBlocks();
