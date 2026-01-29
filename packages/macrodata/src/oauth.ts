/**
 * OAuth Authentication using Arctic
 *
 * Replaces Cloudflare Access JWT auth with proper OAuth (Google/GitHub).
 * Single-user setup: first user to authenticate owns this instance.
 */

import { Google, GitHub, generateState, generateCodeVerifier } from "arctic";
import type { OAuth2Tokens } from "arctic";

// Provider types
export type OAuthProvider = "google" | "github";

// Stored auth data
export interface StoredAuth {
  provider: OAuthProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  email: string;
  createdAt: string;
}

// Pending OAuth flow (stored temporarily during redirect)
export interface PendingOAuth {
  provider: OAuthProvider;
  state: string;
  codeVerifier: string | null; // Only Google uses PKCE
  createdAt: number;
}

// Auth result from checking current session
export interface AuthResult {
  authenticated: boolean;
  user?: {
    email: string;
    provider: OAuthProvider;
  };
  error?: string;
}

/**
 * Create OAuth providers from env
 */
export function createProviders(env: {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_BASE?: string;
}) {
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

/**
 * Start Google OAuth flow
 */
export function startGoogleAuth(google: Google): {
  url: URL;
  state: string;
  codeVerifier: string;
} {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const scopes = ["openid", "email", "profile"];

  const url = google.createAuthorizationURL(state, codeVerifier, scopes);
  // Request refresh token
  url.searchParams.set("access_type", "offline");
  // Force consent to always get refresh token
  url.searchParams.set("prompt", "consent");

  return { url, state, codeVerifier };
}

/**
 * Start GitHub OAuth flow
 */
export function startGitHubAuth(github: GitHub): {
  url: URL;
  state: string;
} {
  const state = generateState();
  const scopes = ["user:email"];

  const url = github.createAuthorizationURL(state, scopes);

  return { url, state };
}

/**
 * Complete Google OAuth flow
 */
export async function completeGoogleAuth(
  google: Google,
  code: string,
  codeVerifier: string
): Promise<{ tokens: OAuth2Tokens; email: string }> {
  const tokens = await google.validateAuthorizationCode(code, codeVerifier);

  // Get user info from Google
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.status}`);
  }

  const userInfo = (await response.json()) as { email: string };

  return { tokens, email: userInfo.email };
}

/**
 * Complete GitHub OAuth flow
 */
export async function completeGitHubAuth(
  github: GitHub,
  code: string
): Promise<{ tokens: OAuth2Tokens; email: string }> {
  const tokens = await github.validateAuthorizationCode(code);

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

  const user = (await userResponse.json()) as { email: string | null };

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
      email = primary?.email ?? emails[0]?.email ?? "unknown";
    } else {
      email = "unknown";
    }
  }

  return { tokens, email };
}

/**
 * Refresh Google access token
 */
export async function refreshGoogleToken(
  google: Google,
  refreshToken: string
): Promise<OAuth2Tokens> {
  return google.refreshAccessToken(refreshToken);
}

/**
 * Convert OAuth2Tokens to StoredAuth format
 */
export function tokensToStoredAuth(
  tokens: OAuth2Tokens,
  provider: OAuthProvider,
  email: string
): StoredAuth {
  return {
    provider,
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
    expiresAt: tokens.accessTokenExpiresAt()?.toISOString() ?? null,
    email,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Check if stored auth is expired (with 5 min buffer)
 */
export function isAuthExpired(auth: StoredAuth): boolean {
  if (!auth.expiresAt) {
    // GitHub OAuth apps don't expire
    return false;
  }

  const expiresAt = new Date(auth.expiresAt);
  const buffer = 5 * 60 * 1000; // 5 minutes
  return Date.now() > expiresAt.getTime() - buffer;
}

/**
 * Create error response
 */
export function errorResponse(message: string, status: number = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create redirect response
 */
export function redirectResponse(url: string | URL): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
}

/**
 * Create JSON response
 */
export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
