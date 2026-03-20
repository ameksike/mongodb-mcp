/**
 * @file MCP Auth Proxy — OAuth 2.1 Resource Server (RS)
 * @description Reverse proxy that sits in front of the MongoDB MCP Server.
 *              Validates Bearer tokens (JWT) issued by Keycloak before
 *              forwarding requests to the upstream MCP Server.
 *
 *              Follows MongoDB MCP Security Best Practices:
 *              - Delegated Authorization via OAuth 2.1
 *              - Proxy pattern: MCP Server never sees or validates tokens
 *              - JWKS-based token verification (no shared secrets)
 *
 * @see https://www.mongodb.com/docs/mcp-server/security-best-practices/
 */

import { createServer, request as httpRequest } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const {
    PROXY_PORT = '3030',
    MCP_UPSTREAM_URL = 'http://mongodb-mcp:8008',
    KEYCLOAK_ISSUER_URL = 'http://keycloak:8080/realms/mcp',
    KEYCLOAK_PUBLIC_URL,
    REQUIRED_AUDIENCE = 'mcp-server',
    REQUIRED_SCOPE = 'mcp:access',
} = process.env;

const expectedIssuer = KEYCLOAK_PUBLIC_URL || KEYCLOAK_ISSUER_URL;
const JWKS_URL = new URL(`${KEYCLOAK_ISSUER_URL}/protocol/openid-connect/certs`);
const jwks = createRemoteJWKSet(JWKS_URL);

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

async function verifyToken(token) {
    const result = await jwtVerify(token, jwks, {
        issuer: expectedIssuer,
        audience: REQUIRED_AUDIENCE,
    });

    const scopes = (result.payload.scope ?? '').split(' ');
    if (!scopes.includes(REQUIRED_SCOPE)) {
        throw new Error(`Missing required scope: ${REQUIRED_SCOPE}`);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(res, status, error, detail) {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error, ...(detail && { detail }) }));
}

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    'access-control-expose-headers': 'Mcp-Session-Id',
    'access-control-max-age': '86400',
};

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
    }

    // Apply CORS to all responses
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
        res.setHeader(k, v);
    }

    // Extract Bearer token
    const authHeader = req.headers['authorization'] ?? '';
    const match = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
        return sendError(res, 401, 'Unauthorized', 'Missing or malformed Bearer token');
    }

    // Validate JWT
    let payload;
    try {
        const result = await verifyToken(match[1]);
        payload = result.payload;
    } catch (err) {
        console.warn(`[proxy] token rejected: ${err.message}`);
        return sendError(res, 403, 'Forbidden', err.message);
    }

    const sub = payload.sub ?? 'unknown';
    const user = payload.preferred_username ?? sub;
    console.log(`[proxy] ${req.method} ${req.url} — user=${user} (sub=${sub})`);

    // Forward to upstream MCP Server (strip Authorization header)
    const upstream = new URL(req.url, MCP_UPSTREAM_URL);
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['authorization'];
    delete fwdHeaders['host'];
    fwdHeaders['x-authenticated-user'] = sub;
    fwdHeaders['x-authenticated-username'] = user;

    const proxyReq = httpRequest(
        {
            hostname: upstream.hostname,
            port: upstream.port,
            path: upstream.pathname + upstream.search,
            method: req.method,
            headers: fwdHeaders,
        },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        },
    );

    proxyReq.on('error', (err) => {
        console.error(`[proxy] upstream error: ${err.message}`);
        sendError(res, 502, 'Bad Gateway', err.message);
    });

    req.pipe(proxyReq);
});

server.listen(Number(PROXY_PORT), '0.0.0.0', () => {
    console.log(`
========================================
  MCP Auth Proxy (OAuth 2.1 RS)
========================================
  Listening : http://0.0.0.0:${PROXY_PORT}
  Upstream  : ${MCP_UPSTREAM_URL}
  Issuer    : ${expectedIssuer}
  Audience  : ${REQUIRED_AUDIENCE}
  Scope     : ${REQUIRED_SCOPE}
========================================
`);
});
