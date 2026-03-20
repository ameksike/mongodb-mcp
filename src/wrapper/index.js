/**
 * @file src\wrapper\index.js
 * @description Optimized launcher for the MongoDB MCP Server.
 *              Spawns the local binary with scoped environment variables,
 *              avoiding global env pollution.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const isWindows = platform() === 'win32';

/**
 * @const {string} MCP_CMD
 * @description Path to the locally installed mongodb-mcp-server binary.
 *              Uses the `.cmd` shim on Windows.
 */
const MCP_CMD = isWindows
    ? 'node_modules\\.bin\\mongodb-mcp-server.cmd'
    : 'node_modules/.bin/mongodb-mcp-server';

/**
 * @description Environment variable overrides extracted once from {@link process.env}
 *              for clarity and to avoid repeated property lookups.
 */
const {
    MDB_MCP_TRANSPORT,
    MDB_MCP_HTTP_HOST,
    MDB_MCP_HTTP_PORT,
    MDB_MCP_HTTP_BODY_RESPONSE_TYPE,
    MDB_MCP_READ_ONLY,
    MDB_MCP_DISABLED_TOOLS,
    MDB_MCP_INDEX_CHECK,
    MDB_MCP_TELEMETRY,
} = process.env;

/**
 * @const {Object.<string, string>} env
 * @description Merged environment passed to the child process.
 *              Each MDB_MCP_* variable falls back to a safe default
 *              when not defined in `.env` or the host environment.
 */
const env = {
    ...process.env,
    MDB_MCP_TRANSPORT: MDB_MCP_TRANSPORT || 'http',
    MDB_MCP_HTTP_HOST: MDB_MCP_HTTP_HOST || '127.0.0.1',
    MDB_MCP_HTTP_PORT: MDB_MCP_HTTP_PORT || '8008',
    MDB_MCP_HTTP_BODY_RESPONSE_TYPE: MDB_MCP_HTTP_BODY_RESPONSE_TYPE || 'json',
    MDB_MCP_READ_ONLY: MDB_MCP_READ_ONLY || 'true',
    MDB_MCP_DISABLED_TOOLS: MDB_MCP_DISABLED_TOOLS || 'create,update,delete,atlas',
    MDB_MCP_INDEX_CHECK: MDB_MCP_INDEX_CHECK || 'false',
    MDB_MCP_TELEMETRY: MDB_MCP_TELEMETRY || 'enabled',
};

/**
 * @description Spawns the MCP server as a child process.
 * - Uses the local binary to avoid npx overhead on each start.
 * - Inherits stdio for transparent logging and easier debugging.
 * - Enables `shell` on Windows so the `.cmd` shim executes correctly.
 *
 * @type {import('node:child_process').ChildProcess}
 */
const child = spawn(MCP_CMD, [], {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: isWindows,
});

const baseUrl = `http://${env.MDB_MCP_HTTP_HOST}:${env.MDB_MCP_HTTP_PORT}`;

child.stdout.on('data', (data) => {
    process.stdout.write(`[mcp] ${data}`);
});

child.stderr.on('data', (data) => {
    process.stderr.write(`[mcp:err] ${data}`);
});

console.log(`
========================================
  MongoDB MCP Server
========================================
  Status   : running
  URL      : ${baseUrl}
  Endpoint : ${baseUrl}/mcp
----------------------------------------
  LLM Integration (e.g. Claude, GPT):

  Add to your MCP client config:

  {
    "servers": {
      "mongodb": {
        "type": "streamableHttp",
        "url": "${baseUrl}/mcp"
      }
    }
  }
========================================
`);

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