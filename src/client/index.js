/**
 * @file MCP Test Client
 * @description Connects to a MongoDB MCP Server via Streamable HTTP and runs
 *              a diagnostic suite that validates connectivity, tool discovery,
 *              and tool execution.
 *
 * Usage:
 *   node src/client/index.js                        # defaults to http://127.0.0.1:8008
 *   MCP_SERVER_URL=http://host:port node src/client/index.js
 */

import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.MCP_SERVER_URL
    ?? `http://${process.env.MDB_MCP_HTTP_HOST ?? '127.0.0.1'}:${process.env.MDB_MCP_HTTP_PORT ?? '8008'}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (label, msg) => console.log(`[client:${label}] ${msg}`);
const pass = (name) => console.log(`  PASS  ${name}`);
const fail = (name, err) => console.error(`  FAIL  ${name} -> ${err}`);

/**
 * Safely execute a test step and report result.
 * @param {string}   name Test label
 * @param {Function} fn   Async function that returns a result
 * @returns {*} The value returned by fn, or undefined on failure.
 */
async function run(name, fn) {
    try {
        const result = await fn();
        pass(name);
        return result;
    } catch (err) {
        fail(name, err.message ?? err);
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function main() {
    console.log(`
========================================
  MCP Test Client
========================================
  Server   : ${SERVER_URL}
  Endpoint : ${SERVER_URL}/mcp
========================================
`);

    // 1. Transport & connection ------------------------------------------------

    log('init', 'Creating Streamable HTTP transport...');
    const transport = new StreamableHTTPClientTransport(
        new URL(`${SERVER_URL}/mcp`),
    );

    const client = new Client(
        { name: 'mcp-test-client', version: '1.0.0' },
        { capabilities: {} },
    );

    const serverInfo = await run('connect', async () => {
        await client.connect(transport);
        const info = client.getServerVersion();
        log('init', `Connected to ${info?.name} v${info?.version}`);
        return info;
    });

    if (!serverInfo) {
        console.error('\nCannot continue without a connection. Exiting.');
        process.exit(1);
    }

    // 2. List tools ------------------------------------------------------------

    const tools = await run('list tools', async () => {
        const { tools: list } = await client.listTools();
        log('tools', `Found ${list.length} tool(s):`);
        for (const t of list) {
            console.log(`           - ${t.name}: ${(t.description ?? '').slice(0, 80)}`);
        }
        return list;
    });

    // 3. Call a read-only tool -------------------------------------------------

    if (tools?.length) {
        const readTools = tools.filter((t) =>
            /find|list|count|query|search|read|get|show|explain|aggregate|schema|collstat/i.test(t.name),
        );

        const target = readTools[0] ?? tools[0];
        log('call', `Testing tool "${target.name}" with empty args...`);

        await run(`call tool: ${target.name}`, async () => {
            const result = await client.callTool({
                name: target.name,
                arguments: {},
            });
            const preview = JSON.stringify(result).slice(0, 300);
            log('call', `Response preview: ${preview}`);
            return result;
        });
    }

    // 4. Ping ------------------------------------------------------------------

    await run('ping', async () => {
        await client.ping();
        log('ping', 'Server responded to ping');
    });

    // 5. List resources (if supported) -----------------------------------------

    await run('list resources', async () => {
        const { resources } = await client.listResources();
        log('resources', `Found ${resources.length} resource(s)`);
        for (const r of resources) {
            console.log(`           - ${r.name}: ${r.uri}`);
        }
        return resources;
    });

    // 6. Summary ---------------------------------------------------------------

    console.log(`
========================================
  Diagnostic complete
========================================
`);

    await client.close();
    process.exit(0);
}

main().catch((err) => {
    console.error(`[client:fatal] ${err.message ?? err}`);
    process.exit(1);
});
