/**
 * WorkBuddy 400/11129 and 400/11133 diagnostics. The gateway can omit the rejected field.
 * A structural summary
 * (roles, lengths, tool-call counts, pairing anomalies) narrows the cause without recording
 * any message text, tool arguments, or identifiers.
 */

import { readBoundedResponseBody } from "../lib/bounded-body";

export const WORKBUDDY_INVALID_PARAMS_CODE = "11133";

const GENERIC_11133_EXT_ERROR_CODES = new Set([
  "invalid_parameter_value",
  "400001",
  "invalid_request_error",
]);

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
  const bytes = Buffer.byteLength(rawBody);
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse(rawBody));
  } catch {
    return `unparseable bytes=${bytes}`;
  }
  if (!body) return `non-object bytes=${bytes}`;
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
    `bytes=${bytes}`,
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
  const value = payload.requestId;
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(value) ? value : undefined;
}

/**
 * Log the request shape for parameter rejections. Condense the generic 11133 envelope
 * when WorkBuddy supplies neither a parameter name nor a more specific error message.
 */
export async function normalizeWorkbuddyInvalidParams(
  response: Response,
  requestBody: unknown,
  opts: { signal?: AbortSignal; warn?: (line: string) => void } = {},
): Promise<Response> {
  if (response.status !== 400) return response;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal: opts.signal });
    if (!body.displaySafe) return response;
    const payload = asRecord(JSON.parse(body.text));
    if (!payload) return response;
    const code = String(payload.code);
    if (code !== WORKBUDDY_INVALID_PARAMS_CODE && code !== "11129") return response;
    const warn = opts.warn ?? ((line: string) => { console.warn(line); });
    const requestId = upstreamRequestId(payload);
    warn(
      `[opencodex] workbuddy 400/${code} request shape: `
      + `${summarizeWorkbuddyRequestShape(typeof requestBody === "string" ? requestBody : "")}`
      + `${requestId ? ` upstreamRequestId=${requestId}` : ""}`,
    );
    const error = asRecord(payload.extError);
    if (code === WORKBUDDY_INVALID_PARAMS_CODE
      && typeof error?.code === "string"
      && GENERIC_11133_EXT_ERROR_CODES.has(error.code)
      && error.message === "the request parameters were rejected by the model provider"
      && (error.param === "" || error.param == null)
      && asRecord(payload.retry_policy)?.retry === false) {
      const reference = requestId ? ` Request ID: ${requestId}.` : "";
      const result = Response.json({
        code,
        message: `WorkBuddy (11133): the model provider rejected the request without identifying a parameter.${reference}`,
        type: "invalid_request_error",
      }, { status: response.status, statusText: response.statusText });
      void response.body?.cancel().catch(() => {});
      return result;
    }
  } catch {
    /* diagnostics must never affect the request path */
  }
  return response;
}
