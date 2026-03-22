/**
 * @file McpServerLauncher — Child-process manager for the MongoDB MCP Server.
 * @description Information Expert (GRASP) for process lifecycle: environment
 *              loading, spawning, stdio piping, graceful shutdown, and banner.
 */

import { config as loadDotenv } from 'dotenv';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export class McpServerLauncher {
    /**
     * @param {Object.<string, string>} [overrides] MDB_MCP_* overrides applied after .env loading
     */
    constructor(overrides = {}) {
        this.overrides = overrides;
        this.env = null;
        this.child = null;
        this.cmd = 'npx mongodb-mcp-server';
    }

    /**
     * Load .env file (if present) and merge with defaults and overrides.
     * Must be called before start().
     */
    load() {
        loadDotenv();
        this.env = {
            ...process.env,
            MDB_MCP_TRANSPORT: process.env.MDB_MCP_TRANSPORT || 'http',
            MDB_MCP_HTTP_HOST: process.env.MDB_MCP_HTTP_HOST || '127.0.0.1',
            MDB_MCP_HTTP_PORT: process.env.MDB_MCP_HTTP_PORT || '8008',
            MDB_MCP_HTTP_BODY_RESPONSE_TYPE: process.env.MDB_MCP_HTTP_BODY_RESPONSE_TYPE || 'json',
            MDB_MCP_READ_ONLY: process.env.MDB_MCP_READ_ONLY || 'false',
            MDB_MCP_DISABLED_TOOLS: process.env.MDB_MCP_DISABLED_TOOLS || 'none',
            MDB_MCP_ALLOW_REQUEST_OVERRIDES: process.env.MDB_MCP_ALLOW_REQUEST_OVERRIDES || 'true',
            MDB_MCP_INDEX_CHECK: process.env.MDB_MCP_INDEX_CHECK || 'false',
            MDB_MCP_TELEMETRY: process.env.MDB_MCP_TELEMETRY || 'enabled',
            ...this.overrides,
        };
        this.baseUrl = `http://${this.env.MDB_MCP_HTTP_HOST}:${this.env.MDB_MCP_HTTP_PORT}`;
    }

    /**
     * Spawn the MCP server and wire up lifecycle hooks.
     */
    start() {
        this.load();
        this.child = spawn(this.cmd, [], {
            env: this.env,
            stdio: ['inherit', 'pipe', 'pipe'],
            shell: platform() === 'win32',
        });

        this.child.stdout.on('data', (data) => process.stdout.write(`[mcp] ${data}`));
        this.child.stderr.on('data', (data) => process.stderr.write(`[mcp:err] ${data}`));
        this.child.on('exit', (code, signal) => {
            console.log(`[launcher] MongoDB MCP server exited with code=${code}, signal=${signal}`);
            process.exit(code ?? 0);
        });

        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());

        this.printBanner();
    }

    /**
     * Gracefully terminate the child process.
     */
    shutdown() {
        console.log('\n[launcher] Shutting down MongoDB MCP server...');
        if (this.child && !this.child.killed) {
            this.child.kill('SIGTERM');
        }
    }

    /**
     * Print the startup banner.
     * @private
     */
    printBanner() {
        const now = new Date().toLocaleString();

        console.log(`
========================================
  MongoDB MCP Server
========================================
  Started  : ${now}
  Status   : running
  URL      : ${this.baseUrl}
  Endpoint : ${this.baseUrl}/mcp
----------------------------------------
  LLM Integration (e.g. Claude, GPT):

  Add to your MCP client config:

  {
    "servers": {
      "mongodb": {
        "type": "streamableHttp",
        "url": "${this.baseUrl}/mcp"
      }
    }
  }
========================================
`);
    }
}
