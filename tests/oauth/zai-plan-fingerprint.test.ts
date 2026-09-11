import { describe, expect, test } from "bun:test";
import {
  buildOfficialStartPlanHeaders,
  buildStartPlanSystemBlocks,
  officialMetadataUserId,
} from "../../src/oauth/zai-plan";

describe("zai-plan official fingerprint", () => {
  test("model request headers omit X-Device-Mid and query/session ids", () => {
    const headers = buildOfficialStartPlanHeaders({
      jwt: "aaa.bbb.ccc",
      deviceMid: "device-mid-test",
    });
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(headers["X-Title"]).toBe("Z Code@electron");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["X-Device-Mid"]).toBeUndefined();
    expect(headers["x-query-id"]).toBeUndefined();
    expect(headers["X-Query-Id"]).toBeUndefined();
    expect(headers["x-session-id"]).toBeUndefined();
    expect(headers["X-Session-Id"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer aaa.bbb.ccc");
  });

  test("metadata.user_id is official device JSON, not a JWT sub", () => {
    const raw = officialMetadataUserId("mid-1", "sess_abc-def");
    expect(JSON.parse(raw)).toEqual({
      device_id: "mid-1",
      account_uuid: "",
      session_id: "abc-def",
    });
  });

  test("system blocks include desktop context and powered-by inside Environment", () => {
    const blocks = buildStartPlanSystemBlocks("GLM-5.3-Flash");
    expect(blocks.map((b) => b.text).join("\n")).toContain("# ZCode Desktop Context");
    const env = blocks.at(-1)?.text ?? "";
    expect(env.startsWith("# Environment")).toBe(true);
    expect(env).toContain("- You are powered by the model named GLM-5.3-Flash.");
    expect(blocks.some((b) => b.text === "- You are powered by the model named GLM-5.3-Flash.")).toBe(false);
  });
});
