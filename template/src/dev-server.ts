import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "./handler.js";

const PORT = Number(process.env.PORT) || 3000;
const OAUTH_SERVER_URL = process.env.OAUTH_SERVER_URL || "http://localhost:5173";
const BOUND_ORG_ID = process.env.BOUND_ORG_ID || "";

// --- JWKS cache ---
interface JWK { kty: string; n: string; e: string; alg?: string; kid?: string; use?: string }
interface JWKS { keys: JWK[] }
let cachedJwks: JWKS | null = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min for local dev

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : http;
    mod.get(url, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function getJwks(): Promise<JWKS> {
  const now = Date.now();
  if (cachedJwks && now - jwksCachedAt < JWKS_CACHE_TTL_MS) return cachedJwks;
  const jwks = (await fetchJson(`${OAUTH_SERVER_URL}/.well-known/jwks.json`)) as JWKS;
  cachedJwks = jwks;
  jwksCachedAt = now;
  return jwks;
}

function base64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyRS256(token: string, jwk: JWK): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  const isValid = crypto.verify(
    "sha256", Buffer.from(`${headerB64}.${payloadB64}`),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    base64urlDecode(signatureB64),
  );
  if (!isValid) return null;
  return JSON.parse(base64urlDecode(payloadB64).toString());
}

async function validateToken(authHeader: string | undefined): Promise<{ valid: true; claims: Record<string, unknown> } | { valid: false; reason: string }> {
  if (!authHeader?.startsWith("Bearer ")) return { valid: false, reason: "Missing or invalid Authorization header" };
  const token = authHeader.slice(7);
  try {
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(base64urlDecode(headerB64).toString()) as { alg: string; kid?: string };
    if (header.alg !== "RS256") return { valid: false, reason: "Unsupported algorithm" };
    const jwks = await getJwks();
    const jwk = header.kid ? jwks.keys.find(k => k.kid === header.kid) : jwks.keys[0];
    if (!jwk) return { valid: false, reason: "No matching key in JWKS" };
    const payload = verifyRS256(token, jwk);
    if (!payload) return { valid: false, reason: "Invalid signature" };
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return { valid: false, reason: "Token expired" };
    if (BOUND_ORG_ID && payload.org_id !== BOUND_ORG_ID) return { valid: false, reason: `org_id mismatch: expected ${BOUND_ORG_ID}, got ${payload.org_id}` };
    return { valid: true, claims: payload };
  } catch (e) {
    return { valid: false, reason: String(e) };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// --- HTTP server simulating API Gateway ---
const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  console.log(`[req] ${req.method} ${url.pathname}`);

  // Protected Resource Metadata (RFC 9728)
  if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    const resource = `http://localhost:${PORT}/mcp`;
    const metadata = {
      resource,
      authorization_servers: [`${OAUTH_SERVER_URL}/oauth/${BOUND_ORG_ID}`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:access"],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(metadata));
    return;
  }

  // MCP endpoint — only POST, simulating API Gateway POST /mcp route
  if (url.pathname === "/mcp" && req.method === "POST") {
    // JWT validation (simulates Lambda Authorizer)
    const result = await validateToken(req.headers.authorization);

    if (!result.valid) {
      console.log(`[auth] rejected: ${result.reason}`);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }

    console.log(`[auth] accepted: user=${result.claims.sub} org=${result.claims.org_id} role=${result.claims.org_role}`);

    // Read request body
    const body = await readBody(req);

    // Build a fake API Gateway event to invoke the real Lambda handler
    const event: APIGatewayProxyEventV2 = {
      version: "2.0",
      routeKey: "POST /mcp",
      rawPath: "/mcp",
      rawQueryString: url.search.replace(/^\?/, ""),
      headers: req.headers as Record<string, string>,
      body,
      isBase64Encoded: false,
      requestContext: {
        accountId: "local",
        apiId: "local",
        domainName: `localhost:${PORT}`,
        domainPrefix: "localhost",
        http: {
          method: "POST",
          path: "/mcp",
          protocol: "HTTP/1.1",
          sourceIp: "127.0.0.1",
          userAgent: req.headers["user-agent"] ?? "",
        },
        requestId: crypto.randomUUID(),
        routeKey: "POST /mcp",
        stage: "$default",
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
        authorizer: {
          lambda: {
            userId: String(result.claims.sub ?? ""),
            orgId: String(result.claims.org_id ?? ""),
            orgRole: String(result.claims.org_role ?? ""),
          },
        },
      } as APIGatewayProxyEventV2["requestContext"],
    };

    // Invoke the actual Lambda handler
    const lambdaResult = await handler(event);

    // Send the Lambda response back
    res.writeHead(lambdaResult.statusCode ?? 200, lambdaResult.headers as Record<string, string>);
    res.end(lambdaResult.body ?? "");
    return;
  }

  // Default: not found / method not allowed
  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  }));
});

httpServer.listen(PORT, () => {
  console.log(`MCP dev server (with OAuth gateway) running at http://localhost:${PORT}`);
  console.log(`  OAuth server: ${OAUTH_SERVER_URL}`);
  console.log(`  Bound org ID: ${BOUND_ORG_ID || "(not set — org check disabled)"}`);
  console.log(`  PRM: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
  console.log(`  MCP: http://localhost:${PORT}/mcp`);
});
