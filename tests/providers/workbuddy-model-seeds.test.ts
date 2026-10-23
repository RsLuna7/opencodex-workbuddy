import { describe, expect, test } from "bun:test";
import {
  WORKBUDDY_MODELS,
  WORKBUDDY_MODEL_CONTEXT_WINDOWS,
  WORKBUDDY_MODEL_INPUT_MODALITIES,
  WORKBUDDY_MODEL_MAX_OUTPUT_TOKENS,
  WORKBUDDY_NO_VISION_MODELS,
} from "../../src/providers/registry/workbuddy-seeds";
import { getProviderRegistryEntry } from "../../src/providers/registry";

describe("workbuddy model seeds", () => {
  test("every roster model carries modalities, context and output limits", () => {
    for (const id of WORKBUDDY_MODELS) {
      expect(WORKBUDDY_MODEL_INPUT_MODALITIES[id]).toBeDefined();
      expect(WORKBUDDY_MODEL_CONTEXT_WINDOWS[id]).toBeGreaterThan(0);
      expect(WORKBUDDY_MODEL_MAX_OUTPUT_TOKENS[id]).toBeGreaterThan(0);
    }
  });

  test("noVisionModels is exactly the text-only modality rows", () => {
    const textOnly = WORKBUDDY_MODELS.filter(id => !WORKBUDDY_MODEL_INPUT_MODALITIES[id]!.includes("image"));
    expect([...WORKBUDDY_NO_VISION_MODELS].sort()).toEqual([...textOnly].sort());
  });

  test("deepseek-v4.1-flash and glm-5.3-flash are image-capable", () => {
    for (const id of ["deepseek-v4.1-flash", "glm-5.3-flash"]) {
      expect(WORKBUDDY_MODEL_INPUT_MODALITIES[id]).toEqual(["text", "image"]);
      expect(WORKBUDDY_NO_VISION_MODELS).not.toContain(id);
    }
  });

  test("the registry row publishes the seeds", () => {
    const entry = getProviderRegistryEntry("workbuddy");
    expect(entry?.models).toEqual([...WORKBUDDY_MODELS]);
    expect(entry?.modelInputModalities?.["deepseek-v4.1-flash"]).toEqual(["text", "image"]);
    expect(entry?.noVisionModels).toEqual([...WORKBUDDY_NO_VISION_MODELS]);
  });
});
