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

// Pending external MCP OAuth flow
interface PendingMcpAuth {
  mcpName: string;
  mcpEndpoint: string;
  state: string;
  codeVerifier: string;
  userId: string; // The macrodata user connecting this MCP
  createdAt: number;
}

// Connected MCP stored in user's DO
interface ConnectedMcp {
  name: string;
  endpoint: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  connectedAt: string;
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
    ALLOWED_USERS?: string; // Comma-separated list of allowed emails
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

// Helper to check if user is allowed
function isAllowedUser(email: string, env: Env): boolean {
  const allowedUsers = env.ALLOWED_USERS;
  if (!allowedUsers) {
    // No allowlist configured = nobody allowed (locked down by default)
    return false;
  }
  const allowed = allowedUsers.split(",").map(e => e.trim().toLowerCase());
  return allowed.includes(email.toLowerCase());
}

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

        // Check if user is allowed
        if (!isAllowedUser(userInfo.email, env)) {
          console.warn(`[CALLBACK/GOOGLE] Rejected user: ${userInfo.email}`);
          return new Response("Access denied. Your account is not authorized to use this service.", { status: 403 });
        }

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

        // Check if user is allowed
        if (!isAllowedUser(email, env)) {
          console.warn(`[CALLBACK/GITHUB] Rejected user: ${email}`);
          return new Response("Access denied. Your account is not authorized to use this service.", { status: 403 });
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

// Simple HTML layout for settings pages
function settingsLayout(title: string, content: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Macrodata</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 600px;
      margin: 0 auto;
      padding: 2rem;
      background: #f5f5f5;
    }
    h1 { color: #333; }
    .card {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .mcp-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 0;
      border-bottom: 1px solid #eee;
    }
    .mcp-item:last-child { border-bottom: none; }
    .mcp-name { font-weight: 600; }
    .mcp-endpoint { color: #666; font-size: 0.875rem; }
    .btn {
      padding: 0.5rem 1rem;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-size: 0.875rem;
    }
    .btn-primary { background: #2563eb; color: white; }
    .btn-danger { background: #dc2626; color: white; }
    .btn:hover { opacity: 0.9; }
    input[type="text"], input[type="url"] {
      width: 100%;
      padding: 0.5rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-bottom: 0.75rem;
    }
    label { display: block; margin-bottom: 0.25rem; font-weight: 500; }
    .form-group { margin-bottom: 1rem; }
    .status { padding: 0.5rem; border-radius: 4px; margin-bottom: 1rem; }
    .status-success { background: #d1fae5; color: #065f46; }
    .status-error { background: #fee2e2; color: #991b1b; }
    .empty { color: #666; font-style: italic; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${content}
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

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
    const url = new URL(request.url);

    // OAuth is required - ctx.props contains the authenticated user info
    if (ctx.props) {
      console.log(`[MCP] Authenticated request from: ${ctx.props.email} (${ctx.props.provider})`);
    } else {
      console.log(`[MCP] Request without authentication props`);
      return new Response("Unauthorized", { status: 401 });
    }

    const userId = ctx.props.email;

    // Settings: List connected MCPs
    if (url.pathname === "/settings/mcps" && request.method === "GET") {
      // Get connected MCPs from user's KV storage (shared with DO)
      const mcpsJson = await env.OAUTH_KV.get(`user:${userId}:mcps`);
      const mcps: ConnectedMcp[] = mcpsJson ? JSON.parse(mcpsJson) : [];

      const status = url.searchParams.get("status");
      const statusHtml = status === "connected"
        ? '<div class="status status-success">MCP connected successfully!</div>'
        : status === "error"
        ? `<div class="status status-error">Error: ${url.searchParams.get("message") || "Connection failed"}</div>`
        : "";

      const mcpListHtml = mcps.length > 0
        ? mcps.map(mcp => `
          <div class="mcp-item">
            <div>
              <div class="mcp-name">${escapeHtml(mcp.name)}</div>
              <div class="mcp-endpoint">${escapeHtml(mcp.endpoint)}</div>
            </div>
            <form method="POST" action="/settings/mcps/delete" style="display: inline;">
              <input type="hidden" name="name" value="${escapeHtml(mcp.name)}">
              <button type="submit" class="btn btn-danger">Remove</button>
            </form>
          </div>
        `).join("")
        : '<p class="empty">No MCPs connected yet.</p>';

      return settingsLayout("Connected MCPs", `
        ${statusHtml}
        <div class="card">
          <h2>Your MCPs</h2>
          ${mcpListHtml}
        </div>
        <div class="card">
          <h2>Add MCP</h2>
          <form method="POST" action="/settings/mcps/add">
            <div class="form-group">
              <label for="name">Name</label>
              <input type="text" id="name" name="name" placeholder="e.g., My GitHub MCP" required>
            </div>
            <div class="form-group">
              <label for="endpoint">Endpoint URL</label>
              <input type="url" id="endpoint" name="endpoint" placeholder="https://my-mcp.example.com" required>
            </div>
            <button type="submit" class="btn btn-primary">Connect MCP</button>
          </form>
        </div>
      `);
    }

    // Settings: Add MCP (initiate OAuth discovery and redirect)
    if (url.pathname === "/settings/mcps/add" && request.method === "POST") {
      const formData = await request.formData();
      const name = formData.get("name") as string;
      const endpoint = formData.get("endpoint") as string;

      if (!name || !endpoint) {
        return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=Missing+name+or+endpoint`, 302);
      }

      try {
        // Discover OAuth metadata from the MCP
        const metadataUrl = new URL("/.well-known/oauth-authorization-server", endpoint);
        const metadataRes = await fetch(metadataUrl.toString());

        if (!metadataRes.ok) {
          throw new Error(`MCP doesn't support OAuth discovery (${metadataRes.status})`);
        }

        const metadata = await metadataRes.json() as {
          authorization_endpoint: string;
          token_endpoint: string;
          scopes_supported?: string[];
        };

        // Generate PKCE
        const state = generateState();
        const codeVerifier = generateCodeVerifier();

        // Store pending auth
        const pending: PendingMcpAuth = {
          mcpName: name,
          mcpEndpoint: endpoint,
          state,
          codeVerifier,
          userId,
          createdAt: Date.now(),
        };
        await env.OAUTH_KV.put(
          `pending-mcp:${state}`,
          JSON.stringify({ ...pending, tokenEndpoint: metadata.token_endpoint }),
          { expirationTtl: 600 }
        );

        // Build authorization URL
        const authUrl = new URL(metadata.authorization_endpoint);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", `macrodata:${userId}`); // Dynamic client ID
        authUrl.searchParams.set("redirect_uri", `${env.OAUTH_REDIRECT_BASE}/settings/mcps/callback`);
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("code_challenge", await generateCodeChallenge(codeVerifier));
        authUrl.searchParams.set("code_challenge_method", "S256");
        if (metadata.scopes_supported?.length) {
          authUrl.searchParams.set("scope", metadata.scopes_supported.join(" "));
        }

        return Response.redirect(authUrl.toString(), 302);
      } catch (error) {
        const message = encodeURIComponent(error instanceof Error ? error.message : "Unknown error");
        return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=${message}`, 302);
      }
    }

    // Settings: OAuth callback from external MCP
    if (url.pathname === "/settings/mcps/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=${encodeURIComponent(error)}`, 302);
      }

      if (!code || !state) {
        return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=Missing+code+or+state`, 302);
      }

      // Get pending auth
      const pendingJson = await env.OAUTH_KV.get(`pending-mcp:${state}`);
      if (!pendingJson) {
        return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=Invalid+or+expired+state`, 302);
      }

      const pending = JSON.parse(pendingJson) as PendingMcpAuth & { tokenEndpoint: string };

      try {
        // Exchange code for tokens
        const tokenRes = await fetch(pending.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${env.OAUTH_REDIRECT_BASE}/settings/mcps/callback`,
            client_id: `macrodata:${pending.userId}`,
            code_verifier: pending.codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          const errorText = await tokenRes.text();
          throw new Error(`Token exchange failed: ${errorText}`);
        }

        const tokens = await tokenRes.json() as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };

        // Store the connected MCP
        const mcpsJson = await env.OAUTH_KV.get(`user:${pending.userId}:mcps`);
        const mcps: ConnectedMcp[] = mcpsJson ? JSON.parse(mcpsJson) : [];

        // Remove existing MCP with same name if any
        const filtered = mcps.filter(m => m.name !== pending.mcpName);

        filtered.push({
          name: pending.mcpName,
          endpoint: pending.mcpEndpoint,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
          connectedAt: new Date().toISOString(),
        });

        await env.OAUTH_KV.put(`user:${pending.userId}:mcps`, JSON.stringify(filtered));

        // Clean up pending auth
        await env.OAUTH_KV.delete(`pending-mcp:${state}`);

        return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps?status=connected`, 302);
      } catch (error) {
        const message = encodeURIComponent(error instanceof Error ? error.message : "Unknown error");
        return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=${message}`, 302);
      }
    }

    // Settings: Delete MCP
    if (url.pathname === "/settings/mcps/delete" && request.method === "POST") {
      const formData = await request.formData();
      const name = formData.get("name") as string;

      if (name) {
        const mcpsJson = await env.OAUTH_KV.get(`user:${userId}:mcps`);
        const mcps: ConnectedMcp[] = mcpsJson ? JSON.parse(mcpsJson) : [];
        const filtered = mcps.filter(m => m.name !== name);
        await env.OAUTH_KV.put(`user:${userId}:mcps`, JSON.stringify(filtered));
      }

      return Response.redirect(`${env.OAUTH_REDIRECT_BASE}/settings/mcps`, 302);
    }

    // Route MCP requests to the Durable Object (per-user)
    return MemoryAgent.serve("/mcp", { sessionId: userId }).fetch(
      request,
      env,
      ctx
    );
  },
};

// Helper to escape HTML
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Generate S256 code challenge from verifier
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * The OAuthProvider-wrapped worker
 *
 * This handles:
 * - OAuth token endpoint at /oauth/token
 * - Client registration at /oauth/register
 * - RFC 8414 metadata at /.well-known/oauth-authorization-server
 * - Authorization flow starting at /authorize
 * - Protected MCP endpoint at /mcp
 * - Protected settings at /settings/*
 */
export default new OAuthProvider({
  // API routes are protected (both /mcp and /settings)
  apiRoute: ["/mcp", "/settings"],
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
