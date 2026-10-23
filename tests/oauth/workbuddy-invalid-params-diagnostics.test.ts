import { describe, expect, test } from "bun:test";
import {
  logWorkbuddyInvalidParams,
  summarizeWorkbuddyRequestShape,
} from "../../src/oauth/codebuddy-diagnostics";

const SECRET = "SECRET-PROMPT-TEXT";

function body(messages: unknown[]): string {
  return JSON.stringify({ model: "deepseek-v4.1-flash", tools: [{}, {}], messages });
}

describe("workbuddy 11133 request shape", () => {
  test("summarizes roles, lengths and tool calls without leaking content", () => {
    const summary = summarizeWorkbuddyRequestShape(body([
      { role: "system", content: SECRET },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "SECRET-TOOL", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]));
    expect(summary).toContain("messages=4 toolCalls=1 tools=2");
    expect(summary).toContain("tail=[system:18 user:5 assistant:0+tc1 tool:2]");
    expect(summary).toContain("orphanToolResults=0 unansweredToolCalls=0");
    expect(summary).not.toContain("SECRET");
  });

  test("flags orphan tool results, unanswered calls and invalid arguments", () => {
    const summary = summarizeWorkbuddyRequestShape(body([
      { role: "assistant", content: null, tool_calls: [{ id: "a", function: { arguments: "{bad" } }] },
      { role: "tool", tool_call_id: "zzz", content: "x" },
    ]));
    expect(summary).toContain("badArgs=1");
    expect(summary).toContain("orphanToolResults=1");
    expect(summary).toContain("unansweredToolCalls=1");
  });

  test("caps the per-message tail and reports omitted count", () => {
    const messages = Array.from({ length: 50 }, () => ({ role: "user", content: "x" }));
    expect(summarizeWorkbuddyRequestShape(body(messages))).toContain("tail(+10 earlier omitted)");
  });

  test("handles unparseable bodies", () => {
    expect(summarizeWorkbuddyRequestShape("nope")).toBe("unparseable bytes=4");
  });

  test("logs only for 400 with code 11133 and leaves the response readable", async () => {
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    const hit = new Response(JSON.stringify({ code: 11133, msg: "Invalid request parameters", requestId: "rid1" }), { status: 400 });
    await logWorkbuddyInvalidParams(hit, body([{ role: "user", content: SECRET }]), { warn });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("400/11133 request shape");
    expect(lines[0]).toContain("upstreamRequestId=rid1");
    expect(lines[0]).not.toContain(SECRET);
    expect(await hit.text()).toContain("11133");

    await logWorkbuddyInvalidParams(new Response(JSON.stringify({ code: 11102 }), { status: 400 }), "{}", { warn });
    await logWorkbuddyInvalidParams(new Response(JSON.stringify({ code: 11133 }), { status: 500 }), "{}", { warn });
    expect(lines).toHaveLength(1);
  });
});
