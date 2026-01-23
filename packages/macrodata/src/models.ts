/**
 * Model providers for Macrodata
 *
 * Uses Cloudflare AI Gateway with the unified provider for all external models.
 * This gives us a single interface for Google, Anthropic, etc. via BYOK.
 */

import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";

/**
 * Model tier for task categorization
 */
export type ModelTier = "fast" | "thinking" | "local";

/**
 * Model configuration
 */
export interface ModelConfig {
  /** Model identifier in provider/model format for unified, or @cf/ for workers-ai */
  model: string;
  /** Human-readable description */
  description: string;
  /** Whether this uses Workers AI (local) or AI Gateway (external) */
  local: boolean;
}

/**
 * Default model configuration by tier
 * Model names are internal - users only see tier names
 */
export const DEFAULT_MODELS: Record<ModelTier, ModelConfig> = {
  // Fast: quick tasks, cheap
  fast: {
    model: "google-ai-studio/gemini-2.5-flash",
    description: "Quick responses, lower cost",
    local: false,
  },
  // Thinking: deep reasoning, analysis
  thinking: {
    model: "anthropic/claude-opus-4-20250514",
    description: "Deep reasoning and analysis",
    local: false,
  },
  // Local: Workers AI only (free, no external deps)
  local: {
    model: "@cf/moonshotai/kimi-k2-instruct",
    description: "Free, runs locally on Cloudflare",
    local: true,
  },
};

/**
 * Environment variables needed for model providers
 */
interface ModelEnv {
  AI: Ai;
  CF_ACCOUNT_ID?: string;
  CF_AIG_GATEWAY_ID?: string;
  CF_API_TOKEN?: string;
}

/**
 * Resolve a model tier to a ModelConfig
 * Only accepts tier names - no direct model IDs exposed
 */
function resolveModel(tier: string): ModelConfig {
  if (tier in DEFAULT_MODELS) {
    return DEFAULT_MODELS[tier as ModelTier];
  }

  // Unknown tier - fall back to fast
  console.warn(`[MODELS] Unknown tier "${tier}", falling back to "fast"`);
  return DEFAULT_MODELS.fast;
}

/**
 * Create a model provider for the given tier or model ID
 */
export function createModel(
  env: ModelEnv,
  modelOrTier: string = "fast",
): LanguageModel {
  const config = resolveModel(modelOrTier);

  // Workers AI for local models
  if (config.local) {
    const workersAI = createWorkersAI({ binding: env.AI });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return workersAI(config.model as any);
  }

  // AI Gateway for external models
  if (!env.CF_ACCOUNT_ID || !env.CF_AIG_GATEWAY_ID || !env.CF_API_TOKEN) {
    console.warn(
      "[MODELS] AI Gateway not configured, falling back to Workers AI",
    );
    const workersAI = createWorkersAI({ binding: env.AI });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return workersAI("@cf/moonshotai/kimi-k2-instruct" as any);
  }

  const aigateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_AIG_GATEWAY_ID,
    apiKey: env.CF_API_TOKEN,
  });

  const unified = createUnified();
  return aigateway(unified(config.model));
}

/**
 * Format available model tiers for display in tool descriptions
 */
export function formatModelOptions(): string {
  const lines = Object.entries(DEFAULT_MODELS).map(
    ([tier, config]) => `- "${tier}": ${config.description}`,
  );

  return `Available model tiers:\n${lines.join("\n")}`;
}
