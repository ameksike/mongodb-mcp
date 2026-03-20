/**
 * @file MCP RBAC Gateway
 * @description MCP-aware reverse proxy that enforces Role-Based Access Control.
 *              Validates Keycloak JWT tokens, extracts realm roles, and filters
 *              MCP tools based on the user's assigned role.
 *
 *              Follows:
 *              - MongoDB MCP Security Best Practices (Delegated Authorization)
 *              - MCP Specification (Streamable HTTP transport)
 *              - OAuth 2.1 (JWT + JWKS verification)
 *
 * @see https://www.mongodb.com/docs/mcp-server/security-best-practices/
 * @see https://modelcontextprotocol.io/docs/tutorials/security/authorization
 *
 * Usage:
 *   node src/gateway/index.js
 */

import 'dotenv/config';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const {
    GATEWAY_PORT = '4000',
    MCP_UPSTREAM_URL = `http://${process.env.MDB_MCP_HTTP_HOST ?? '127.0.0.1'}:${process.env.MDB_MCP_HTTP_PORT ?? '8008'}`,
    KEYCLOAK_URL = 'http://localhost:8080',
    KEYCLOAK_REALM = 'mcp',
    REQUIRED_AUDIENCE = 'mcp-server',
    REQUIRED_SCOPE = 'mcp:access',
} = process.env;

const KEYCLOAK_ISSUER_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
const JWKS_URL = new URL(`${KEYCLOAK_ISSUER_URL}/protocol/openid-connect/certs`);
const jwks = createRemoteJWKSet(JWKS_URL);

// ---------------------------------------------------------------------------
// RBAC configuration
// ---------------------------------------------------------------------------

const rolesConfig = JSON.parse(
    readFileSync(join(__dirname, 'roles.json'), 'utf-8'),
);

/**
 * Resolve the effective role for a user based on their Keycloak realm roles.
 * Uses precedence order: first match in rolePrecedence wins.
 * @param {string[]} realmRoles
 * @returns {{ role: string, allowedTools: string[] } | null}
 */
function resolveRole(realmRoles) {
    for (const roleName of rolesConfig.rolePrecedence) {
        if (realmRoles.includes(roleName)) {
            const roleDef = rolesConfig.roles[roleName];
            return {
                role: roleName,
                allowedTools: roleDef.tools,
            };
        }
    }

    if (rolesConfig.defaultRole && rolesConfig.roles[rolesConfig.defaultRole]) {
        const roleDef = rolesConfig.roles[rolesConfig.defaultRole];
        return {
            role: rolesConfig.defaultRole,
            allowedTools: roleDef.tools,
        };
    }

    return null;
}

/**
 * Check if a tool is allowed for the resolved role.
 * @param {string} toolName
 * @param {string[]} allowedTools
 * @returns {boolean}
 */
function isToolAllowed(toolName, allowedTools) {
    return allowedTools.includes('*') || allowedTools.includes(toolName);
}

// ---------------------------------------------------------------------------
// JWT validation
// ---------------------------------------------------------------------------

async function verifyToken(token) {
    const result = await jwtVerify(token, jwks, {
        issuer: KEYCLOAK_ISSUER_URL,
        audience: REQUIRED_AUDIENCE,
    });

    const scopes = (result.payload.scope ?? '').split(' ');
    if (!scopes.includes(REQUIRED_SCOPE)) {
        throw new Error(`Missing required scope: ${REQUIRED_SCOPE}`);
    }

    return result.payload;
}

// ---------------------------------------------------------------------------
// MCP message interception
// ---------------------------------------------------------------------------

/**
 * Filter a tools/list response to only include tools allowed for the role.
 * @param {object} body  Parsed JSON-RPC response
 * @param {string[]} allowedTools
 * @returns {object} Modified response
 */
function filterToolsListResponse(body, allowedTools) {
    if (!body?.result?.tools || allowedTools.includes('*')) return body;

    const original = body.result.tools.length;
    body.result.tools = body.result.tools.filter((t) =>
        allowedTools.includes(t.name),
    );
    const filtered = body.result.tools.length;

    if (original !== filtered) {
        console.log(`[gateway:rbac] tools/list filtered: ${original} -> ${filtered}`);
    }

    return body;
}

/**
 * Check if a tools/call request targets an allowed tool.
 * @param {object} body  Parsed JSON-RPC request
 * @param {string[]} allowedTools
 * @returns {{ allowed: boolean, toolName: string }}
 */
function checkToolCallRequest(body, allowedTools) {
    const toolName = body?.params?.name ?? '';
    return {
        allowed: isToolAllowed(toolName, allowedTools),
        toolName,
    };
}

/**
 * Build a JSON-RPC error response for denied tool calls.
 */
function buildAccessDeniedResponse(id, toolName, role) {
    return JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
            code: -32001,
            message: `Access denied: tool "${toolName}" is not available for role "${role}"`,
        },
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(res, status, error, detail) {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error, ...(detail && { detail }) }));
}

function collectBody(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    'access-control-expose-headers': 'Mcp-Session-Id',
    'access-control-max-age': '86400',
};

// ---------------------------------------------------------------------------
// Gateway HTTP Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
    }

    for (const [k, v] of Object.entries(CORS_HEADERS)) {
        res.setHeader(k, v);
    }

    // -- Authentication -------------------------------------------------------

    const authHeader = req.headers['authorization'] ?? '';
    const match = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
        return sendError(res, 401, 'Unauthorized', 'Missing or malformed Bearer token');
    }

    let payload;
    try {
        payload = await verifyToken(match[1]);
    } catch (err) {
        console.warn(`[gateway:auth] token rejected: ${err.message}`);
        return sendError(res, 403, 'Forbidden', err.message);
    }

    // -- Role resolution ------------------------------------------------------

    const realmRoles = payload.realm_access?.roles ?? [];
    const user = payload.preferred_username ?? payload.sub ?? 'unknown';
    const resolved = resolveRole(realmRoles);

    if (!resolved) {
        console.warn(`[gateway:rbac] no matching role for user=${user} roles=[${realmRoles}]`);
        return sendError(res, 403, 'Forbidden', 'No MCP role assigned to this user');
    }

    const { role, allowedTools } = resolved;
    console.log(`[gateway] ${req.method} ${req.url} — user=${user} role=${role}`);

    // -- Read request body (for POST interception) ----------------------------

    let reqBody;
    let reqBodyRaw;
    if (req.method === 'POST') {
        reqBodyRaw = await collectBody(req);
        try {
            reqBody = JSON.parse(reqBodyRaw.toString());
        } catch {
            reqBody = null;
        }
    }

    // -- MCP message interception: tools/call ---------------------------------

    if (reqBody?.method === 'tools/call') {
        const { allowed, toolName } = checkToolCallRequest(reqBody, allowedTools);
        if (!allowed) {
            console.warn(`[gateway:rbac] DENIED tools/call "${toolName}" for user=${user} role=${role}`);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(buildAccessDeniedResponse(reqBody.id, toolName, role));
        }
        console.log(`[gateway:rbac] ALLOWED tools/call "${toolName}" for user=${user} role=${role}`);
    }

    // -- Proxy to upstream MCP Server -----------------------------------------

    const upstream = new URL(req.url, MCP_UPSTREAM_URL);
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders['authorization'];
    delete fwdHeaders['host'];
    fwdHeaders['x-authenticated-user'] = payload.sub ?? 'unknown';
    fwdHeaders['x-authenticated-username'] = user;
    fwdHeaders['x-authenticated-role'] = role;

    // If we buffered the body, recalculate content-length
    if (reqBodyRaw) {
        fwdHeaders['content-length'] = String(reqBodyRaw.length);
    }

    const proxyOpts = {
        hostname: upstream.hostname,
        port: upstream.port,
        path: upstream.pathname + upstream.search,
        method: req.method,
        headers: fwdHeaders,
    };

    // -- MCP message interception: tools/list (filter response) ---------------

    const needsToolFiltering = reqBody?.method === 'tools/list' && !allowedTools.includes('*');

    if (needsToolFiltering) {
        // Buffer the upstream response so we can modify it
        const proxyReq = httpRequest(proxyOpts, async (proxyRes) => {
            const upstreamBody = await collectBody(proxyRes);
            const contentType = proxyRes.headers['content-type'] ?? '';

            if (contentType.includes('text/event-stream')) {
                // SSE stream — parse events, filter tool list in each message event
                const raw = upstreamBody.toString();
                const filtered = raw.replace(
                    /^data: (.+)$/gm,
                    (_match, jsonStr) => {
                        try {
                            const msg = JSON.parse(jsonStr);
                            if (msg?.result?.tools) {
                                const modified = filterToolsListResponse(msg, allowedTools);
                                return `data: ${JSON.stringify(modified)}`;
                            }
                        } catch { /* not JSON, pass through */ }
                        return _match;
                    },
                );
                const resFwdHeaders = { ...proxyRes.headers };
                delete resFwdHeaders['content-length'];
                resFwdHeaders['transfer-encoding'] = 'chunked';
                res.writeHead(proxyRes.statusCode, resFwdHeaders);
                res.end(filtered);
            } else {
                // JSON response — filter directly
                try {
                    const msg = JSON.parse(upstreamBody.toString());
                    const modified = filterToolsListResponse(msg, allowedTools);
                    const modifiedStr = JSON.stringify(modified);
                    const resFwdHeaders = { ...proxyRes.headers };
                    resFwdHeaders['content-length'] = String(Buffer.byteLength(modifiedStr));
                    res.writeHead(proxyRes.statusCode, resFwdHeaders);
                    res.end(modifiedStr);
                } catch {
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(upstreamBody);
                }
            }
        });

        proxyReq.on('error', (err) => {
            console.error(`[gateway] upstream error: ${err.message}`);
            sendError(res, 502, 'Bad Gateway', err.message);
        });

        if (reqBodyRaw) {
            proxyReq.end(reqBodyRaw);
        } else {
            proxyReq.end();
        }
        return;
    }

    // -- Default: transparent proxy -------------------------------------------

    const proxyReq = httpRequest(proxyOpts, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error(`[gateway] upstream error: ${err.message}`);
        sendError(res, 502, 'Bad Gateway', err.message);
    });

    if (reqBodyRaw) {
        proxyReq.end(reqBodyRaw);
    } else if (req.method === 'GET' || req.method === 'DELETE') {
        proxyReq.end();
    } else {
        req.pipe(proxyReq);
    }
});

server.listen(Number(GATEWAY_PORT), '0.0.0.0', () => {
    const toolSummary = Object.entries(rolesConfig.roles)
        .map(([r, def]) => `    ${r.padEnd(14)} ${def.tools.includes('*') ? 'ALL tools' : `${def.tools.length} tools`}`)
        .join('\n');

    console.log(`
========================================
  MCP RBAC Gateway
========================================
  Listening : http://0.0.0.0:${GATEWAY_PORT}
  Upstream  : ${MCP_UPSTREAM_URL}
  Keycloak  : ${KEYCLOAK_ISSUER_URL}
  Audience  : ${REQUIRED_AUDIENCE}
  Scope     : ${REQUIRED_SCOPE}
----------------------------------------
  Role permissions:
${toolSummary}
========================================
`);
});
