import { expect, test } from "bun:test";
import { providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

test("codebuddy selector uses this fork's WorkBuddy OAuth provider, not the upstream CLI preset", () => {
  const workbuddy = PROVIDER_REGISTRY.find(row => row.id === "workbuddy");
  expect(workbuddy).toMatchObject({ alias: "codebuddy", adapter: "workbuddy", authKind: "oauth" });
  expect(PROVIDER_REGISTRY.some(row => row.id === "codebuddy" || row.id === "codebuddy-cn")).toBe(false);
  const config = {
    defaultProvider: "workbuddy",
    providers: { workbuddy: providerConfigSeed(workbuddy!) },
  } as OcxConfig;
  const route = routeModel(config, "codebuddy/auto");
  expect(route.providerName).toBe("workbuddy");
  expect(route.provider.adapter).toBe("workbuddy");
  expect(route.modelId).toBe("auto");
});
