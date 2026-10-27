import { expect, test } from "bun:test";
import { formatAccountTable, type AccountDeps } from "../../src/cli/account";
import { fetchRows } from "../../src/cli/account-api";

test("ZCode account quota reaches both JSON rows and the human table as exact models", async () => {
  const paths: string[] = [];
  const deps: AccountDeps = { baseUrl: "http://localhost:10100", fetchImpl: (async input => {
    paths.push(String(input));
    return Response.json({ activeAccountId: "test-a", accounts: [{ id: "test-a", active: true, quota: {
      updatedAt: Date.now(), customWindows: [
        { label: "Flash", scope: "model", modelId: "GLM-5.3-Flash", percent: 100 },
        { label: "GLM", scope: "model", modelId: "GLM-5.3", percent: 25 },
      ],
    } }] });
  }) as typeof fetch };
  const result = await fetchRows(deps, deps.baseUrl!, "zai-plan", "oauth", { refresh: true });
  expect(paths[0]).toContain("provider=zai-plan&quota=1&refresh=1");
  const table = formatAccountTable(result.rows, true);
  expect(table).toContain("GLM-5.3-Flash 100%"); expect(table).toContain("GLM-5.3 25%");
  expect(JSON.stringify(result.rows)).toContain('"modelId":"GLM-5.3-Flash"');
});
