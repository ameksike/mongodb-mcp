/**
 * @file Gateway Entry Point
 * @description Loads environment configuration and starts the RBAC Gateway.
 *
 * Usage:
 *   node src/gateway/index.js
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { GatewayServer } from './GatewayServer.js';

const gateway = new GatewayServer({
    port: Number(process.env.GATEWAY_PORT ?? '4040'),
    upstreamUrl: process.env.MCP_UPSTREAM_URL
        ?? `http://${process.env.MDB_MCP_HTTP_HOST ?? '127.0.0.1'}:${process.env.MDB_MCP_HTTP_PORT ?? '8008'}`,
    keycloakUrl: process.env.KEYCLOAK_URL ?? 'http://localhost:8080',
    realm: process.env.KEYCLOAK_REALM ?? 'mcp',
    audience: process.env.REQUIRED_AUDIENCE ?? 'mcp-server',
    scope: process.env.REQUIRED_SCOPE ?? 'mcp:access',
    rolesPath: resolve('cfg/roles.json'),
});

await gateway.start();
