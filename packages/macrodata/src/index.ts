/**
 * Macrodata - Cloud Memory MCP Server
 *
 * A remote MCP server that provides persistent memory for coding agents.
 * Built on Cloudflare Workers with Vectorize for semantic search.
 *
 * OAuth authentication via @cloudflare/workers-oauth-provider.
 * Google/GitHub act as upstream identity providers.
 */

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Google, GitHub, generateState, generateCodeVerifier } from "arctic";
import { MemoryAgent } from "./mcp-agent";

// Re-export the Durable Object class for wrangler
export { MemoryAgent };

// Pending OAuth flow (stored in KV during redirect to Google/GitHub)
interface PendingIdentityAuth {
  provider: "google" | "github";
  state: string;
  codeVerifier: string | null;
  mcpOAuthRequest: unknown; // The original MCP OAuth request info
  createdAt: number;
}

// Extend Env with OAuth vars
declare global {
  interface Env {
    OAUTH_KV: KVNamespace;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    OAUTH_REDIRECT_BASE?: string;
  }
}

// Helper to create upstream identity providers
function createIdentityProviders(env: Env) {
  const providers: {
    google?: Google;
    github?: GitHub;
  } = {};

  const baseUrl = env.OAUTH_REDIRECT_BASE;
  if (!baseUrl) {
    console.warn("[OAUTH] OAUTH_REDIRECT_BASE not set");
    return providers;
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = new Google(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      `${baseUrl}/callback/google`
    );
  }

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = new GitHub(
      env.GITHUB_CLIENT_ID,
      env.GITHUB_CLIENT_SECRET,
      `${baseUrl}/callback/github`
    );
  }

  return providers;
}

// Allowed Cloudflare AI Gateway workers (for MCP portal access without OAuth)
const allowedWorkers = new Set([
  "agents-gateway.workers.dev",
  "gateway.agents.cloudflare.com",
  "agw.ai.cfdata.org",
]);

/**
 * Default handler - handles non-API requests including:
 * - /authorize - MCP OAuth authorization endpoint (shows consent UI)
 * - /callback/google and /callback/github - upstream identity provider callbacks
 * - /health - health check
 */
const defaultHandler = {
  async fetch(
    request: Request,
    env: any,
    ctx: any
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        name: "macrodata",
        status: "ok",
        version: "0.3.0",
        oauth: "cloudflare-provider",
      });
    }

    // MCP OAuth authorization endpoint
    if (url.pathname === "/authorize") {
      try {
        // Parse the MCP OAuth request
        const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);

        if (!clientInfo) {
          return new Response("Unknown client", { status: 400 });
        }

        // Redirect to Google/GitHub for identity verification
        const providers = createIdentityProviders(env);

        if (providers.google) {
          const state = generateState();
          const codeVerifier = generateCodeVerifier();
          const scopes = ["openid", "email", "profile"];

          const authUrl = providers.google.createAuthorizationURL(state, codeVerifier, scopes);
          authUrl.searchParams.set("access_type", "offline");
          authUrl.searchParams.set("prompt", "consent");

          // Store pending auth info in KV
          const pending: PendingIdentityAuth = {
            provider: "google",
            state,
            codeVerifier,
            mcpOAuthRequest: oauthReqInfo,
            createdAt: Date.now(),
          };
          await env.OAUTH_KV.put(
            `pending:${state}`,
            JSON.stringify(pending),
            { expirationTtl: 600 } // 10 minute expiry
          );

          return Response.redirect(authUrl.toString(), 302);
        } else if (providers.github) {
          const state = generateState();
          const scopes = ["user:email"];

          const authUrl = providers.github.createAuthorizationURL(state, scopes);

          // Store pending auth info in KV
          const pending: PendingIdentityAuth = {
            provider: "github",
            state,
            codeVerifier: null,
            mcpOAuthRequest: oauthReqInfo,
            createdAt: Date.now(),
          };
          await env.OAUTH_KV.put(
            `pending:${state}`,
            JSON.stringify(pending),
            { expirationTtl: 600 }
          );

          return Response.redirect(authUrl.toString(), 302);
        }

        return new Response("No identity provider configured. Set GOOGLE_CLIENT_ID/SECRET or GITHUB_CLIENT_ID/SECRET.", { status: 500 });
      } catch (error) {
        console.error("[AUTHORIZE] Error:", error);
        return new Response(
          `Authorization error: ${error instanceof Error ? error.message : String(error)}`,
          { status: 400 }
        );
      }
    }

    // Google OAuth callback
    if (url.pathname === "/callback/google") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`OAuth error: ${error}`, { status: 400 });
      }

      if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
      }

      // Retrieve pending auth info
      const pendingJson = await env.OAUTH_KV.get(`pending:${state}`);
      if (!pendingJson) {
        return new Response("Invalid or expired OAuth state", { status: 400 });
      }

      const pending = JSON.parse(pendingJson) as PendingIdentityAuth;
      if (pending.provider !== "google" || !pending.codeVerifier) {
        return new Response("Invalid OAuth state", { status: 400 });
      }

      const providers = createIdentityProviders(env);
      if (!providers.google) {
        return new Response("Google OAuth not configured", { status: 500 });
      }

      try {
        // Exchange code for tokens
        const tokens = await providers.google.validateAuthorizationCode(
          code,
          pending.codeVerifier
        );

        // Get user info from Google
        const userResponse = await fetch(
          "https://www.googleapis.com/oauth2/v2/userinfo",
          {
            headers: { Authorization: `Bearer ${tokens.accessToken()}` },
          }
        );

        if (!userResponse.ok) {
          throw new Error(`Failed to get user info: ${userResponse.status}`);
        }

        const userInfo = (await userResponse.json()) as { email: string; name?: string };

        // Complete the MCP OAuth flow
        const mcpRequest = pending.mcpOAuthRequest as Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: mcpRequest,
          userId: userInfo.email,
          metadata: {
            provider: "google",
            email: userInfo.email,
            name: userInfo.name,
            authenticatedAt: new Date().toISOString(),
          },
          scope: mcpRequest.scope ?? [],
          props: {
            userId: userInfo.email,
            provider: "google",
            email: userInfo.email,
          },
        });

        // Clean up pending auth
        await env.OAUTH_KV.delete(`pending:${state}`);

        return Response.redirect(redirectTo, 302);
      } catch (error) {
        console.error("[CALLBACK/GOOGLE] Error:", error);
        return new Response(
          `OAuth callback error: ${error instanceof Error ? error.message : String(error)}`,
          { status: 400 }
        );
      }
    }

    // GitHub OAuth callback
    if (url.pathname === "/callback/github") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`OAuth error: ${error}`, { status: 400 });
      }

      if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
      }

      // Retrieve pending auth info
      const pendingJson = await env.OAUTH_KV.get(`pending:${state}`);
      if (!pendingJson) {
        return new Response("Invalid or expired OAuth state", { status: 400 });
      }

      const pending = JSON.parse(pendingJson) as PendingIdentityAuth;
      if (pending.provider !== "github") {
        return new Response("Invalid OAuth state", { status: 400 });
      }

      const providers = createIdentityProviders(env);
      if (!providers.github) {
        return new Response("GitHub OAuth not configured", { status: 500 });
      }

      try {
        // Exchange code for tokens
        const tokens = await providers.github.validateAuthorizationCode(code);

        // Get user info from GitHub
        const userResponse = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokens.accessToken()}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "macrodata-mcp",
          },
        });

        if (!userResponse.ok) {
          throw new Error(`Failed to get user info: ${userResponse.status}`);
        }

        const user = (await userResponse.json()) as { email: string | null; login: string; name?: string };

        // If email not public, fetch from emails endpoint
        let email = user.email;
        if (!email) {
          const emailsResponse = await fetch("https://api.github.com/user/emails", {
            headers: {
              Authorization: `Bearer ${tokens.accessToken()}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "macrodata-mcp",
            },
          });

          if (emailsResponse.ok) {
            const emails = (await emailsResponse.json()) as Array<{
              email: string;
              primary: boolean;
            }>;
            const primary = emails.find((e) => e.primary);
            email = primary?.email ?? emails[0]?.email ?? user.login;
          } else {
            email = user.login;
          }
        }

        // Complete the MCP OAuth flow
        const mcpRequest = pending.mcpOAuthRequest as Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: mcpRequest,
          userId: email,
          metadata: {
            provider: "github",
            email,
            login: user.login,
            name: user.name,
            authenticatedAt: new Date().toISOString(),
          },
          scope: mcpRequest.scope ?? [],
          props: {
            userId: email,
            provider: "github",
            email,
            login: user.login,
          },
        });

        // Clean up pending auth
        await env.OAUTH_KV.delete(`pending:${state}`);

        return Response.redirect(redirectTo, 302);
      } catch (error) {
        console.error("[CALLBACK/GITHUB] Error:", error);
        return new Response(
          `OAuth callback error: ${error instanceof Error ? error.message : String(error)}`,
          { status: 400 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

/**
 * MCP API handler - receives requests with valid access tokens
 * The OAuthProvider has already verified the token.
 */
const mcpApiHandler = {
  async fetch(
    request: Request,
    env: any,
    ctx: any
  ): Promise<Response> {
    // Check for Cloudflare AI Gateway bypass (trusted workers)
    const cfWorker = request.headers.get("cf-worker");
    const isFromPortal = cfWorker && allowedWorkers.has(cfWorker);

    if (isFromPortal) {
      console.log(`[MCP] Request from Cloudflare portal (${cfWorker}), allowing without OAuth`);
    } else if (ctx.props) {
      console.log(`[MCP] Authenticated request from: ${ctx.props.email} (${ctx.props.provider})`);
    } else {
      console.log(`[MCP] Request without props - may be from portal or test`);
    }

    // Route to the MCP Durable Object
    return MemoryAgent.serve("/mcp", { sessionId: "singleton" }).fetch(
      request,
      env,
      ctx
    );
  },
};

/**
 * The OAuthProvider-wrapped worker
 *
 * This handles:
 * - OAuth token endpoint at /oauth/token
 * - Client registration at /oauth/register
 * - RFC 8414 metadata at /.well-known/oauth-authorization-server
 * - Authorization flow starting at /authorize
 * - Protected MCP endpoint at /mcp
 */
export default new OAuthProvider({
  // MCP endpoint is protected
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,

  // Everything else goes to default handler
  defaultHandler,

  // OAuth endpoints
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  // Refresh tokens last 30 days
  refreshTokenTTL: 30 * 24 * 60 * 60,
});
