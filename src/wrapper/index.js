// start-mongodb-mcp.js
// Optimized launcher for MongoDB MCP Server on Windows, no global env pollution.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const isWindows = platform() === 'win32';

// Resolve the local binary installed via npm
const MCP_CMD = isWindows
    ? 'node_modules\\.bin\\mongodb-mcp-server.cmd'
    : 'node_modules/.bin/mongodb-mcp-server';

// Helper with safe defaults
function withDefault(value, def) {
    return value === undefined || value === '' ? def : value;
}

const env = {
    ...process.env,
    MDB_MCP_TRANSPORT: withDefault(process.env.MDB_MCP_TRANSPORT, 'http'),
    MDB_MCP_HTTP_HOST: withDefault(process.env.MDB_MCP_HTTP_HOST, '127.0.0.1'),
    MDB_MCP_HTTP_PORT: withDefault(process.env.MDB_MCP_HTTP_PORT, '8000'),
    MDB_MCP_HTTP_BODY_RESPONSE_TYPE: withDefault(
        process.env.MDB_MCP_HTTP_BODY_RESPONSE_TYPE,
        'json'
    ),
    MDB_MCP_READ_ONLY: withDefault(process.env.MDB_MCP_READ_ONLY, 'true'),
    MDB_MCP_DISABLED_TOOLS: withDefault(
        process.env.MDB_MCP_DISABLED_TOOLS,
        'create,update,delete,atlas'
    ),
    MDB_MCP_INDEX_CHECK: withDefault(process.env.MDB_MCP_INDEX_CHECK, 'false'),
    MDB_MCP_TELEMETRY: withDefault(process.env.MDB_MCP_TELEMETRY, 'enabled'),
};

// Simple perf / stability choices:
// - use local binary (no npx overhead each start)
// - inherit stdio for fast logging and easy debugging
// - shell:true for Windows so the .cmd shim is executed correctly
const child = spawn(MCP_CMD, [], {
    env,
    stdio: 'inherit',
    shell: isWindows,
});

// Graceful shutdown (Ctrl+C, LM Studio stop, etc.)
const shutdown = () => {
    console.log('\n[launcher] Shutting down MongoDB MCP server...');
    if (!child.killed) {
        child.kill('SIGTERM');
    }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

child.on('exit', (code, signal) => {
    console.log(
        `[launcher] MongoDB MCP server exited with code=${code}, signal=${signal}`
    );
    process.exit(code ?? 0);
});