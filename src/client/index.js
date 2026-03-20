/**
 * @file MCP Test Client
 * @description Standards-compliant MCP client that connects to a MongoDB MCP Server
 *              via Streamable HTTP transport and runs a diagnostic suite.
 *
 *              Implements the full MCP lifecycle per the specification:
 *              1. Initialization  - capability negotiation & version agreement
 *              2. Operation       - tool discovery, resource listing, tool calls, ping
 *              3. Shutdown        - graceful session teardown
 *
 * @see https://modelcontextprotocol.io/docs/learn/client-concepts
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * Usage:
 *   node src/client/index.js                                          # defaults
 *   MCP_SERVER_URL=http://host:port node src/client/index.js          # custom URL
 */

import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.MCP_SERVER_URL
    ?? `http://${process.env.MDB_MCP_HTTP_HOST ?? '127.0.0.1'}:${process.env.MDB_MCP_HTTP_PORT ?? '8008'}`;

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (label, msg) => console.log(`[client:${label}] ${msg}`);
const pass = (name) => console.log(`  PASS  ${name}`);
const fail = (name, err) => console.error(`  FAIL  ${name} -> ${err}`);

let passed = 0;
let failed = 0;

/**
 * Execute a test step, report result, and track stats.
 * @param {string}   name Test label
 * @param {Function} fn   Async function that returns a result
 * @returns {*} The value returned by fn, or undefined on failure.
 */
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
 * Attempt Streamable HTTP first; fall back to SSE for older servers.
 * This follows the backwards-compatibility strategy from the MCP spec.
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#backwards-compatibility
 * @returns {import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport|import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport}
 */
function createTransport() {
    return {
        async connect(client) {
            // 1. Try Streamable HTTP (current spec)
            try {
                const transport = new StreamableHTTPClientTransport(
                    new URL(`${SERVER_URL}/mcp`),
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
========================================
`);

    // -- Phase 1: Initialization ----------------------------------------------
    // The SDK handles the full handshake:
    //   client -> initialize (protocolVersion, capabilities, clientInfo)
    //   server -> InitializeResult (protocolVersion, capabilities, serverInfo)
    //   client -> notifications/initialized
    // We declare client capabilities so the server knows what we support.

    const client = new Client(
        { name: 'mcp-test-client', version: '1.0.0' },
        {
            capabilities: {
                roots:      { listChanged: true },
                sampling:   {},
            },
        },
    );

    log('init', 'Phase 1: Initialization — connecting & negotiating capabilities...');

    const connector = createTransport();
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
