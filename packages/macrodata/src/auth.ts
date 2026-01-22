/**
 * Cloudflare Access JWT validation
 *
 * Validates the Cf-Access-Jwt-Assertion header to ensure requests
 * come through Cloudflare Access (either directly or via MCP portal).
 */

import { jwtVerify, createRemoteJWKSet } from "jose";

export interface AccessJWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  nbf: number;
  iss: string;
  type: string;
  identity_nonce: string;
  sub: string;
  country?: string;
}

export interface AuthResult {
  authenticated: boolean;
  user?: {
    email: string;
    sub: string;
  };
  error?: string;
}

/**
 * Validate the Cloudflare Access JWT from the request
 */
export async function validateAccessJWT(
  request: Request,
  env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_POLICY_AUD?: string },
): Promise<AuthResult> {
  // If no Access config, allow all (for local dev)
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_POLICY_AUD) {
    console.log("[AUTH] No Access config, allowing request");
    return { authenticated: true };
  }

  // Get the JWT from the request headers
  const token = request.headers.get("cf-access-jwt-assertion");

  if (!token) {
    return {
      authenticated: false,
      error: "Missing Cf-Access-Jwt-Assertion header",
    };
  }

  try {
    // Create JWKS from your team domain
    const JWKS = createRemoteJWKSet(
      new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
    );

    // Verify the JWT
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_POLICY_AUD,
    });

    const claims = payload as unknown as AccessJWTPayload;

    return {
      authenticated: true,
      user: {
        email: claims.email,
        sub: claims.sub,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[AUTH] JWT validation failed:", message);
    return {
      authenticated: false,
      error: `Invalid token: ${message}`,
    };
  }
}

/**
 * Create an unauthorized response
 */
export function unauthorizedResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
