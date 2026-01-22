/**
 * Extended environment types for Macrodata
 * These extend the generated worker-configuration.d.ts types
 */

// Secrets that are set via wrangler secret put
declare global {
  interface Env {
    // Web search
    BRAVE_SEARCH_API_KEY?: string;
    // Browser Rendering API
    CF_API_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
    // Optional: for deep refine tasks using external models
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    // Cloudflare Access JWT validation
    ACCESS_TEAM_DOMAIN?: string; // e.g., "https://myteam.cloudflareaccess.com"
    ACCESS_POLICY_AUD?: string; // The Application Audience (AUD) tag
  }
}

export {};
