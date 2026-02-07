/**
 * Model catalog — Section 2.9 of the Unified LLM Client Spec.
 */

import type { ModelInfo } from "./types.js";

export const MODEL_CATALOG: ModelInfo[] = [
  // Anthropic
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    display_name: "Claude Opus 4.6",
    context_window: 200000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["opus"],
  },
  {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    display_name: "Claude Sonnet 4.5",
    context_window: 200000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["sonnet"],
  },
  // OpenAI
  {
    id: "gpt-5.2",
    provider: "openai",
    display_name: "GPT-5.2",
    context_window: 1047576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
  },
  {
    id: "gpt-5.2-mini",
    provider: "openai",
    display_name: "GPT-5.2 Mini",
    context_window: 1047576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
  },
  {
    id: "gpt-5.2-codex",
    provider: "openai",
    display_name: "GPT-5.2 Codex",
    context_window: 1047576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["codex"],
  },
  // Gemini
  {
    id: "gemini-3-pro-preview",
    provider: "gemini",
    display_name: "Gemini 3 Pro (Preview)",
    context_window: 1048576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
  },
  {
    id: "gemini-3-flash-preview",
    provider: "gemini",
    display_name: "Gemini 3 Flash (Preview)",
    context_window: 1048576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gemini-flash"],
  },
];

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_CATALOG.find(
    (m) => m.id === modelId || m.aliases?.includes(modelId),
  );
}

export function listModels(provider?: string): ModelInfo[] {
  if (!provider) return [...MODEL_CATALOG];
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

export function getLatestModel(
  provider: string,
  capability?: string,
): ModelInfo | undefined {
  const models = listModels(provider).filter((m) => {
    if (!capability) return true;
    if (capability === "reasoning") return m.supports_reasoning;
    if (capability === "vision") return m.supports_vision;
    if (capability === "tools") return m.supports_tools;
    return true;
  });
  return models[0]; // First in list = newest/best
}
