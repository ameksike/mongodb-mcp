/**
 * @file MCP Test Client
 * @description Standards-compliant MCP client that connects to a MongoDB MCP Server
 *              via Streamable HTTP transport and runs a diagnostic suite.
 *
 *              Supports two modes:
 *              - Direct: connects straight to the MCP Server (no auth)
 *              - OAuth:  obtains a Bearer token from Keycloak, then connects
 *                        through the Auth Proxy (Delegated Authorization)
 *
 *              Implements the full MCP lifecycle per the specification:
 *              1. Initialization  - capability negotiation & version agreement
 *              2. Operation       - tool discovery, resource listing, tool calls, ping
 *              3. Shutdown        - graceful session teardown
 *
 * @see https://modelcontextprotocol.io/docs/learn/client-concepts
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 * @see https://www.mongodb.com/docs/mcp-server/security-best-practices/
 *
 * Usage:
 *   node src/client/index.js                                    # direct (no auth)
 *   node src/client/index.js --auth                             # auth with env vars
 *   node src/client/index.js --auth --user mcp-admin --pass admin123
 */

import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseArg(flag) {
    const idx = process.argv.indexOf(flag);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const useAuth = process.argv.includes('--auth');

const DIRECT_URL = process.env.MCP_SERVER_URL
    ?? `http://${process.env.MDB_MCP_HTTP_HOST ?? '127.0.0.1'}:${process.env.MDB_MCP_HTTP_PORT ?? '8008'}`;

const PROXY_URL = process.env.MCP_PROXY_URL ?? 'http://127.0.0.1:4040';

const SERVER_URL = useAuth ? PROXY_URL : DIRECT_URL;

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? 'mcp';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'mcp-client';
const MCP_AUTH_USERNAME = parseArg('--user') ?? process.env.MCP_AUTH_USERNAME ?? 'mcpuser';
const MCP_AUTH_PASSWORD = parseArg('--pass') ?? process.env.MCP_AUTH_PASSWORD ?? 'mcppass';

// ---------------------------------------------------------------------------
// OAuth 2.1 — Resource Owner Password Grant (for testing only)
// In production, use Authorization Code + PKCE flow.
// ---------------------------------------------------------------------------

async function obtainAccessToken() {
    const tokenUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

    const body = new URLSearchParams({
        grant_type: 'password',
        client_id: KEYCLOAK_CLIENT_ID,
        username: MCP_AUTH_USERNAME,
        password: MCP_AUTH_PASSWORD,
        scope: 'openid mcp:access',
    });

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token request failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    return data.access_token;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (label, msg) => console.log(`[client:${label}] ${msg}`);
const pass = (name) => console.log(`  PASS  ${name}`);
const fail = (name, err) => console.error(`  FAIL  ${name} -> ${err}`);

let passed = 0;
let failed = 0;

async function run(name, fn) {
    try {
        const result = await fn();
        pass(name);
        passed++;
        return result;
    } catch (err) {
        fail(name, err.message ?? err);
        failed++;
        return undefined;
    }
}

/**
 * Create transport with optional Bearer token for auth proxy.
 * Attempts Streamable HTTP first, falls back to SSE for older servers.
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#backwards-compatibility
 */
function createTransport(accessToken) {
    const headers = accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined;

    return {
        async connect(client) {
            // 1. Try Streamable HTTP (current spec)
            try {
                const transport = new StreamableHTTPClientTransport(
                    new URL(`${SERVER_URL}/mcp`),
                    { requestInit: { headers } },
                );
                await client.connect(transport);
                log('transport', 'Connected via Streamable HTTP');
                return transport;
            } catch {
                log('transport', 'Streamable HTTP failed, trying SSE fallback...');
            }

            // 2. Fallback to legacy SSE transport (protocol 2024-11-05)
            const transport = new SSEClientTransport(
                new URL(`${SERVER_URL}/sse`),
                { requestInit: { headers } },
            );
            await client.connect(transport);
            log('transport', 'Connected via SSE (legacy)');
            return transport;
        },
    };
}

// ---------------------------------------------------------------------------
// Diagnostic suite
// ---------------------------------------------------------------------------

async function main() {
    console.log(`
========================================
  MCP Test Client — Diagnostic Suite
========================================
  Target : ${SERVER_URL}
  Auth   : ${useAuth ? `OAuth 2.1 (Keycloak) — user: ${MCP_AUTH_USERNAME}` : 'none (direct)'}
========================================
`);

    // -- Phase 0: Authentication (if --auth) ----------------------------------

    let accessToken;
    if (useAuth) {
        log('auth', 'Requesting access token from Keycloak...');
        accessToken = await run('obtain access token', async () => {
            const token = await obtainAccessToken();
            log('auth', `Token obtained (${token.length} chars)`);
            return token;
        });

        if (!accessToken) {
            console.error('\nCannot continue without a token. Exiting.');
            process.exit(1);
        }
    }

    // -- Phase 1: Initialization ----------------------------------------------

    const client = new Client(
        { name: 'mcp-test-client', version: '1.0.0' },
        {
            capabilities: {
                roots:    { listChanged: true },
                sampling: {},
            },
        },
    );

    log('init', 'Phase 1: Initialization — connecting & negotiating capabilities...');

    const connector = createTransport(accessToken);
    const serverInfo = await run('initialize & handshake', async () => {
        await connector.connect(client);
        const info = client.getServerVersion();
        log('init', `Server: ${info?.name} v${info?.version}`);
        return info;
    });

    if (!serverInfo) {
        console.error('\nCannot continue without a connection. Exiting.');
        process.exit(1);
    }

    // -- Phase 2: Operation ---------------------------------------------------

    log('ops', 'Phase 2: Operation — running diagnostic checks...\n');

    // 2a. Ping — basic health check
    await run('ping', async () => {
        await client.ping();
        log('ping', 'Server responded to ping');
    });

    // 2b. List tools
    const tools = await run('list tools', async () => {
        const { tools: list } = await client.listTools();
        log('tools', `Discovered ${list.length} tool(s):`);
        for (const t of list) {
            const desc = (t.description ?? '').slice(0, 72);
            console.log(`           - ${t.name}: ${desc}`);
        }
        return list;
    });

    // 2c. Call a read-only tool
    if (tools?.length) {
        const safePattern =
            /find|list|count|query|search|read|get|show|explain|aggregate|schema|collstat|log|stats/i;
        const target = tools.find((t) => safePattern.test(t.name)) ?? tools[0];

        log('call', `Calling tool "${target.name}" (empty args to validate protocol)...`);

        await run(`call tool: ${target.name}`, async () => {
            const result = await client.callTool(
                { name: target.name, arguments: {} },
            );
            const preview = JSON.stringify(result).slice(0, 300);
            log('call', `Response: ${preview}`);
            return result;
        });
    }

    // 2d. List resources
    await run('list resources', async () => {
        const { resources } = await client.listResources();
        log('resources', `Found ${resources.length} resource(s):`);
        for (const r of resources) {
            console.log(`           - ${r.name}: ${r.uri}`);
        }
        return resources;
    });

    // 2e. Read a resource
    await run('read resource: config', async () => {
        const { contents } = await client.readResource({ uri: 'config://config' });
        const preview = JSON.stringify(contents).slice(0, 200);
        log('resources', `Config resource: ${preview}`);
        return contents;
    });

    // -- Phase 3: Shutdown ----------------------------------------------------

    log('shutdown', 'Phase 3: Shutdown — closing session...');

    await run('graceful shutdown', async () => {
        await client.close();
        log('shutdown', 'Session closed');
    });

    // -- Summary --------------------------------------------------------------

    console.log(`
========================================
  Results: ${passed} passed, ${failed} failed
========================================
`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(`[client:fatal] ${err.message ?? err}`);
    process.exit(1);
});
