/**
 * WorkBuddy 400/11133 diagnostics. The gateway answers "request parameters were rejected"
 * without saying which part, and the outbound body is never logged. A structural summary
 * (roles, lengths, tool-call counts, pairing anomalies) narrows the cause without recording
 * any message text, tool arguments, or identifiers.
 */

import { readBoundedResponseBody } from "../lib/bounded-body";

export const WORKBUDDY_INVALID_PARAMS_CODE = "11133";

/** Last N messages are listed individually; older ones only feed the totals. */
const SHAPE_TAIL_MESSAGES = 40;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function contentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    const record = asRecord(part);
    if (typeof record?.text === "string") total += record.text.length;
    else total += JSON.stringify(part ?? null).length;
  }
  return total;
}

function toolCallsOf(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls.map(asRecord).filter((call): call is Record<string, unknown> => !!call)
    : [];
}

function argumentsParse(call: Record<string, unknown>): boolean {
  const args = asRecord(call.function)?.arguments;
  if (typeof args !== "string") return false;
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}

/** Structure only: never message text, tool names, arguments, or ids. */
export function summarizeWorkbuddyRequestShape(rawBody: string): string {
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse(rawBody));
  } catch {
    return `unparseable bytes=${rawBody.length}`;
  }
  if (!body) return `non-object bytes=${rawBody.length}`;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tokens: string[] = [];
  let toolCalls = 0;
  let badArgs = 0;
  let emptyContent = 0;
  let reasoningMessages = 0;
  let orphanToolResults = 0;
  const open = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = asRecord(messages[index]) ?? {};
    const role = typeof message.role === "string" ? message.role : "?";
    const length = contentLength(message.content);
    const calls = toolCallsOf(message);
    toolCalls += calls.length;
    for (const call of calls) {
      if (!argumentsParse(call)) badArgs += 1;
      if (typeof call.id === "string") open.add(call.id);
    }
    if (role === "tool") {
      const id = message.tool_call_id;
      if (typeof id === "string" && open.delete(id)) { /* paired */ } else orphanToolResults += 1;
    }
    if (length === 0 && calls.length === 0) emptyContent += 1;
    if (typeof message.reasoning_content === "string" && message.reasoning_content) reasoningMessages += 1;
    if (index >= messages.length - SHAPE_TAIL_MESSAGES) {
      tokens.push(`${role}:${length}${calls.length ? `+tc${calls.length}` : ""}`);
    }
  }
  const unansweredToolCalls = open.size;
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  const omitted = Math.max(0, messages.length - SHAPE_TAIL_MESSAGES);
  return [
    `bytes=${rawBody.length}`,
    `model=${typeof body.model === "string" ? body.model : "?"}`,
    `messages=${messages.length}`,
    `toolCalls=${toolCalls}`,
    `tools=${tools}`,
    `badArgs=${badArgs}`,
    `emptyContent=${emptyContent}`,
    `reasoningMsgs=${reasoningMessages}`,
    `orphanToolResults=${orphanToolResults}`,
    `unansweredToolCalls=${unansweredToolCalls}`,
    `tail${omitted ? `(+${omitted} earlier omitted)` : ""}=[${tokens.join(" ")}]`,
  ].join(" ");
}

function upstreamRequestId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.requestId === "string" ? payload.requestId : undefined;
}

/**
 * Logs the request shape when WorkBuddy rejects with 400/11133. Best effort: never throws and
 * never consumes the caller's response (works on a clone).
 */
export async function logWorkbuddyInvalidParams(
  response: Response,
  requestBody: unknown,
  opts: { signal?: AbortSignal; warn?: (line: string) => void } = {},
): Promise<void> {
  if (response.status !== 400) return;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal: opts.signal });
    if (!body.displaySafe) return;
    const payload = asRecord(JSON.parse(body.text));
    if (!payload || String(payload.code) !== WORKBUDDY_INVALID_PARAMS_CODE) return;
    const warn = opts.warn ?? ((line: string) => { console.warn(line); });
    const requestId = upstreamRequestId(payload);
    warn(
      `[opencodex] workbuddy 400/${WORKBUDDY_INVALID_PARAMS_CODE} request shape: `
      + `${summarizeWorkbuddyRequestShape(typeof requestBody === "string" ? requestBody : "")}`
      + `${requestId ? ` upstreamRequestId=${requestId}` : ""}`,
    );
  } catch {
    /* diagnostics must never affect the request path */
  }
}
