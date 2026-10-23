import { describe, expect, test } from "bun:test";
import {
  applyWorkbuddyChatHeaders,
  workbuddyConversationIdFrom,
  type WorkbuddyChatMeta,
} from "../../src/oauth/codebuddy-headers";

/**
 * Global WorkBuddy requires all three conversation headers.
 *
 * Probed against www.workbuddy.ai on 2026-10-23 with a live global account and the rest
 * of this header table held constant: omitting X-Conversation-ID answers HTTP 400
 * {"code":"11-128","msg":"request illegal"}, adding it answers 200. A caller without
 * prompt_cache_key (Codex, DSH, plain Chat clients) is exactly the case that omitted it.
 */
function globalHeaders(meta?: WorkbuddyChatMeta): Record<string, string> {
  const headers: Record<string, string> = {};
  applyWorkbuddyChatHeaders(headers, "global", null, meta);
  return headers;
}

const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;

describe("workbuddy global conversation headers", () => {
  test("always sends X-Conversation-ID, even with no conversation key", () => {
    const headers = globalHeaders();
    expect(headers["X-Conversation-ID"]).toMatch(UUID_V4_SHAPE);
    expect(headers["X-Conversation-Request-ID"]).toMatch(HEX32);
    expect(headers["X-Conversation-Message-ID"]).toMatch(HEX32);
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Message-ID"]);
    expect(headers["X-Root-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
  });

  test("a seeded conversation keeps one stable id and never echoes the seed", () => {
    const first = globalHeaders({ conversationId: "client-thread-abc", conversationRequestId: "client-thread-abc" });
    const second = globalHeaders({ conversationId: "client-thread-abc", conversationRequestId: "client-thread-abc" });
    expect(first["X-Conversation-ID"]).toBe(second["X-Conversation-ID"]);
    expect(first["X-Conversation-ID"]).toMatch(UUID_V4_SHAPE);
    expect(JSON.stringify(first)).not.toContain("client-thread-abc");
    expect(first["X-Conversation-Request-ID"]).toBe(first["X-Conversation-ID"].replace(/-/g, ""));
  });

  test("a generated id differs per request so turns do not share a conversation", () => {
    const first = globalHeaders()["X-Conversation-ID"];
    const second = globalHeaders()["X-Conversation-ID"];
    expect(first).not.toBe(second);
    expect(first).toMatch(UUID_V4_SHAPE);
  });

  test("different seeds map to different conversations", () => {
    expect(workbuddyConversationIdFrom("a")).not.toBe(workbuddyConversationIdFrom("b"));
    expect(workbuddyConversationIdFrom("a")).toBe(workbuddyConversationIdFrom("a"));
  });

  test("CN keeps its own table and also gets a conversation id", () => {
    const headers: Record<string, string> = {};
    applyWorkbuddyChatHeaders(headers, "cn", { uid: "u-1", enterpriseId: "e-1" });
    expect(headers["X-Conversation-ID"]).toMatch(UUID_V4_SHAPE);
    expect(headers["User-Agent"]).toBe("CodeBuddyIDE");
    expect(headers["X-Enterprise-Id"]).toBe("e-1");
  });
});
