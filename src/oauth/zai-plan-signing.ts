/**
 * ZCode client signing V4 (Ed25519 + 8-bit PoW).
 * Protocol: handshake POST {origin}/api/paas/c1f3a7e2/v2/client, then
 * X-Client-Ts/Version/Sig/Nonce, X-App-Id, X-Client-Pow, canonical X-Session-Id.
 * Start-plan JWT paths are never signed. Two-part API keys only.
 */
import { hkdfSync } from "node:crypto";
import { ZAI_PLAN_APP_VERSION, ZAI_ORIGIN } from "./zai-plan";

const APP_ID = "zcode";
const POW_BITS = 8;
const NONCE_BYTES = 16;
const POW_NONCE_BYTES = 12;
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const GATE_URL = `${ZAI_ORIGIN}/api/v1/agent/configs`;

const UNSIGNED = new Set([
  "/api/v1/zcode-plan/anthropic/v1/messages",
  "/api/v1/zcode-plan/chat/completions",
  "/api/v1/off-peak/anthropic/v1/messages",
]);

const encoder = new TextEncoder();

export function parseTwoPartKey(credential: string): { id: string; secret: string } | undefined {
  const dot = credential.indexOf(".");
  if (dot <= 0 || dot !== credential.lastIndexOf(".")) return undefined;
  const id = credential.slice(0, dot).trim();
  const secret = credential.slice(dot + 1).trim();
  return id && secret ? { id, secret } : undefined;
}

function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(n: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hkdf(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(KDF_SALT, "utf8"), Buffer.from(info, "utf8"), 32));
}

function leadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== 0) return false;
  const rem = bits % 8;
  if (rem === 0) return true;
  return ((bytes[full] ?? 255) & ((255 << (8 - rem)) & 255)) === 0;
}

async function proofOfWork(apiKeyId: string, sessionId: string, ts: string): Promise<string> {
  const seedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`${apiKeyId}\n${APP_ID}\n${sessionId}\n${ts}`)));
  const seed = hex(seedDigest).slice(0, 32);
  const nonce = randomHex(POW_NONCE_BYTES);
  for (let counter = 0; counter < 5_000_000; counter++) {
    const candidate = `${nonce}${counter.toString(16).padStart(8, "0")}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`${seed}\n${candidate}`)));
    if (leadingZeroBits(digest, POW_BITS)) return candidate;
  }
  throw new Error("ZCode Plan PoW failed");
}

async function decryptPriv(apiKeyId: string, secret: string, privateCipher: string): Promise<CryptoKey> {
  const cipher = fromB64(privateCipher);
  if (cipher.byteLength <= 28) throw new Error("privateCipher too short");
  const aesKey = await crypto.subtle.importKey("raw", new Uint8Array(hkdf(secret, "ed25519_priv")), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: cipher.slice(0, 12), additionalData: utf8(apiKeyId), tagLength: 128 },
    aesKey,
    cipher.slice(12),
  ));
  const pkcs8 = fromB64(new TextDecoder().decode(plain));
  return crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, ["sign"]);
}

function handshakeMac(secret: string, message: string): string {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha256", hkdf(secret, "getSignKey_hmac")).update(message).digest("base64");
}

let cachedKey: { cred: string; origin: string; key: CryptoKey; at: number } | null = null;
let bypass = false;
let verifyFails = 0;

export function resetZaiPlanSigning(): void {
  cachedKey = null;
  bypass = false;
  verifyFails = 0;
}

async function handshake(origin: string, id: string, secret: string): Promise<CryptoKey> {
  const ts = String(Date.now());
  const nonce = randomHex(NONCE_BYTES);
  const sig = handshakeMac(secret, `get_sign_key\n${id}\n${ts}\n${nonce}`);
  const cred = `${id}.${secret}`;
  const origins = [origin, "https://api.z.ai", "https://zcode.z.ai"];
  let last = "handshake failed";
  for (const o of [...new Set(origins)]) {
    try {
      const resp = await fetch(`${o}${HANDSHAKE_PATH}`, {
        method: "POST",
        headers: { Authorization: cred, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: cred, nonce, sig, ts }),
        signal: AbortSignal.timeout(12_000),
      });
      if (resp.status !== 200) {
        last = `handshake_http_${resp.status}`;
        continue;
      }
      const envelope = await resp.json() as { code?: unknown; msg?: unknown; data?: { privateCipher?: unknown } };
      if (envelope.code !== 200 || typeof envelope.data?.privateCipher !== "string") {
        last = `handshake_rejected:${String(envelope.msg ?? envelope.code)}`;
        continue;
      }
      return await decryptPriv(id, secret, envelope.data.privateCipher);
    } catch (err) {
      last = String((err as Error).message ?? err);
    }
  }
  throw new Error(last);
}

export async function applyZaiPlanSigning(opts: {
  url: string;
  headers: Record<string, string>;
  credential: string;
  appVersion?: string;
}): Promise<Record<string, string>> {
  if (bypass) return opts.headers;
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    return opts.headers;
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  if (UNSIGNED.has(path)) return opts.headers;

  const parts = parseTwoPartKey(opts.credential);
  if (!parts) return opts.headers;

  const sessionId = Object.entries(opts.headers).find(([k]) => k.toLowerCase() === "x-session-id")?.[1]?.trim();
  if (!sessionId) return opts.headers;

  const appVersion = opts.appVersion ?? ZAI_PLAN_APP_VERSION;
  const cacheHit = cachedKey
    && cachedKey.cred === opts.credential
    && Date.now() - cachedKey.at < 50 * 60_000;
  let key = cacheHit ? cachedKey!.key : null;
  if (!key) {
    key = await handshake(parsed.origin, parts.id, parts.secret);
    cachedKey = { cred: opts.credential, origin: parsed.origin, key, at: Date.now() };
  }

  const ts = String(Date.now());
  const nonce = randomHex(NONCE_BYTES);
  const pow = await proofOfWork(parts.id, sessionId, ts);
  const sigBytes = new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    key,
    utf8(`${parts.id}\n${ts}\n${appVersion}\n${sessionId}\n${nonce}`),
  ));
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith("x-client-") || lower === "x-app-id" || lower === "x-session-id") continue;
    next[k] = v;
  }
  next["X-Client-Ts"] = ts;
  next["X-Client-Version"] = appVersion;
  next["X-Client-Sig"] = b64(sigBytes);
  next["X-Session-Id"] = sessionId;
  next["X-Client-Nonce"] = nonce;
  next["X-App-Id"] = APP_ID;
  next["X-Client-Pow"] = pow;
  return next;
}

export async function isZaiPlanVerifyFailure(resp: Response): Promise<boolean> {
  if (resp.status !== 401) return false;
  try {
    const body = await resp.clone().json() as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | undefined;
    const error = body.error as Record<string, unknown> | undefined;
    const candidates = [body.msg, body.reason, data?.reason, error?.reason, error?.message];
    return candidates.some((v) => v === "VERIFY_SIGNATURE_INVALID" || v === "VERIFY_APIKEY_EXPIRED");
  } catch {
    return false;
  }
}

export function noteZaiPlanVerifyFailure(): "retry" | "bypass" {
  cachedKey = null;
  verifyFails += 1;
  if (verifyFails >= 2) {
    bypass = true;
    return "bypass";
  }
  return "retry";
}

export async function gateSigningEnabled(credential: string): Promise<boolean> {
  try {
    const resp = await fetch(GATE_URL, {
      headers: { "x-api-key": credential, "User-Agent": `ZCode/${ZAI_PLAN_APP_VERSION}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return false;
    const parsed = await resp.json() as { code?: unknown; data?: { codingPlanSignature?: { enable?: unknown } } };
    return parsed.code === 0 && parsed.data?.codingPlanSignature?.enable === true;
  } catch {
    return false;
  }
}
