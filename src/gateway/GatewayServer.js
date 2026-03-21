/**
 * @file GatewayServer — Controller that orchestrates all gateway components.
 * @description Creates the HTTP server, wires together TokenVerifier,
 *              RoleResolver, McpInterceptor, and ProxyHandler. Handles the
 *              full request lifecycle: CORS, authentication, authorization,
 *              MCP interception, and proxying.
 *
 *              Follows the Controller pattern (GRASP) — delegates domain
 *              logic to specialist classes while coordinating the flow.
 *
 *              Supports Dependency Injection: pass pre-built instances via
 *              the `deps` parameter to override any component. When omitted,
 *              default instances are created from the grouped `config`.
 */

import { createServer } from 'node:http';
import { TokenVerifier } from './TokenVerifier.js';
import { RoleResolver } from './RoleResolver.js';
import { McpInterceptor } from './McpInterceptor.js';
import { ProxyHandler } from './ProxyHandler.js';

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    'access-control-expose-headers': 'Mcp-Session-Id',
    'access-control-max-age': '86400',
};

export class GatewayServer {
    /**
     * @param {object}  config
     * @param {number}  config.port                       Gateway listen port
     * @param {object}  config.tokenVerifier              TokenVerifier config
     * @param {string}  config.tokenVerifier.keycloakUrl  Keycloak base URL
     * @param {string}  config.tokenVerifier.realm        Keycloak realm name
     * @param {string}  config.tokenVerifier.audience     Required JWT audience
     * @param {string}  config.tokenVerifier.scope        Required JWT scope
     * @param {object}  config.roleResolver               RoleResolver config
     * @param {string}  config.roleResolver.source        Path to roles JSON file
     * @param {object}  config.proxy                      ProxyHandler config
     * @param {string}  config.proxy.upstreamUrl          MCP Server base URL
     *
     * @param {object}  [deps]                         Optional pre-built dependencies
     * @param {TokenVerifier}  [deps.tokenVerifier]    Custom token verifier
     * @param {RoleResolver}   [deps.roleResolver]     Custom role resolver
     * @param {McpInterceptor} [deps.interceptor]      Custom MCP interceptor
     * @param {ProxyHandler}   [deps.proxy]            Custom proxy handler
     */
    constructor(config, deps = {}) {
        this.port = config.port;
        this.gatewayUrl = config.gatewayUrl ?? `http://127.0.0.1:${config.port}`;

        this.tokenVerifier = deps.tokenVerifier ?? new TokenVerifier(config.tokenVerifier);
        this.roleResolver = deps.roleResolver ?? new RoleResolver(config.roleResolver);
        this.interceptor = deps.interceptor ?? new McpInterceptor({ roleResolver: this.roleResolver });
        this.proxy = deps.proxy ?? new ProxyHandler(config.proxy);

        this.resourceMetadata = {
            resource: this.gatewayUrl,
            authorization_servers: [this.tokenVerifier.issuer],
            scopes_supported: ['openid', this.tokenVerifier.requiredScope],
            bearer_methods_supported: ['header'],
        };

        this.server = createServer((req, res) => this._handleRequest(req, res));
    }

    /**
     * Load async dependencies and start listening.
     */
    async start() {
        await this.roleResolver.load();
        this.server.listen(this.port, '0.0.0.0', () => this._printBanner());
    }

    /**
     * Main request handler — orchestrates the full gateway pipeline.
     * @private
     */
    async _handleRequest(req, res) {
        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS_HEADERS);
            return res.end();
        }

        for (const [k, v] of Object.entries(CORS_HEADERS)) {
            res.setHeader(k, v);
        }

        // -- OAuth Protected Resource Metadata (RFC 9728) ---------------------

        if (req.url === '/.well-known/oauth-protected-resource') {
            console.log(`[gateway:meta] Serving OAuth Protected Resource Metadata`);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(this.resourceMetadata));
        }

        // -- Authentication ---------------------------------------------------

        console.log(`[gateway:req] ${req.method} ${req.url} — incoming request`);

        const token = TokenVerifier.extractBearer(req.headers['authorization']);
        if (!token) {
            console.warn(`[gateway:auth] REJECTED — no Bearer token provided`);
            const metaUrl = `${this.gatewayUrl}/.well-known/oauth-protected-resource`;
            return ProxyHandler.sendError(res, 401, 'Unauthorized', 'Missing or malformed Bearer token', {
                'www-authenticate': `Bearer resource_metadata="${metaUrl}"`,
            });
        }

        console.log(`[gateway:auth] Bearer token received (${token.length} chars), verifying...`);

        let payload;
        try {
            payload = await this.tokenVerifier.verify(token);
            console.log(`[gateway:auth] Token verified — issuer=${payload.iss} aud=${payload.aud} scope="${payload.scope}"`);
        } catch (err) {
            console.warn(`[gateway:auth] Token REJECTED — ${err.message}`);
            return ProxyHandler.sendError(res, 403, 'Forbidden', err.message);
        }

        // -- Role resolution --------------------------------------------------

        const realmRoles = payload.realm_access?.roles ?? [];
        const user = payload.preferred_username ?? payload.sub ?? 'unknown';
        const sub = payload.sub ?? 'unknown';

        console.log(`[gateway:user] Authenticated: user="${user}" sub=${sub}`);
        console.log(`[gateway:user] Realm roles: [${realmRoles.join(', ')}]`);

        const resolved = this.roleResolver.resolve(realmRoles);

        if (!resolved) {
            console.warn(`[gateway:rbac] No matching MCP role for user="${user}" — access denied`);
            return ProxyHandler.sendError(res, 403, 'Forbidden', 'No MCP role assigned to this user');
        }

        const { role, allowedTools } = resolved;
        const toolDisplay = allowedTools.includes('*') ? 'ALL tools' : allowedTools.join(', ');
        console.log(`[gateway:rbac] Role resolved: "${role}" — enabled tools: [${toolDisplay}]`);

        // -- Parse request body -----------------------------------------------

        let reqBody = null;
        let reqBodyRaw = null;

        if (req.method === 'POST') {
            reqBodyRaw = await ProxyHandler.collectBody(req);
            try {
                reqBody = JSON.parse(reqBodyRaw.toString());
            } catch { /* not JSON */ }
        }

        if (reqBody?.method) {
            console.log(`[gateway:mcp] JSON-RPC method: "${reqBody.method}" id=${reqBody.id ?? 'n/a'}`);
        }

        // -- MCP interception: tools/call (block unauthorized) ----------------

        if (reqBody?.method === 'tools/call') {
            const { allowed, toolName } = this.interceptor.checkToolCall(reqBody, allowedTools);
            if (!allowed) {
                console.warn(`[gateway:rbac] DENIED tools/call "${toolName}" — user="${user}" role="${role}" does not include this tool`);
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(this.interceptor.buildAccessDenied(reqBody.id, toolName, role));
            }
            console.log(`[gateway:rbac] ALLOWED tools/call "${toolName}" — user="${user}" role="${role}"`);
        }

        // -- Build forwarding headers -----------------------------------------

        const authContext = { sub, username: user, role };
        const fwdHeaders = this.proxy.buildForwardHeaders(req.headers, authContext, reqBodyRaw);

        // -- MCP interception: tools/list (filter response) -------------------

        const needsFiltering = reqBody?.method === 'tools/list' && !allowedTools.includes('*');

        if (needsFiltering) {
            this.proxy.forwardAndIntercept(req, res, fwdHeaders, reqBodyRaw, (proxyRes, upstreamBody) => {
                this._filterToolsListResponse(res, proxyRes, upstreamBody, allowedTools, user, role);
            });
            return;
        }

        // -- Default: transparent proxy ---------------------------------------

        this.proxy.forward(req, res, fwdHeaders, reqBodyRaw);
    }

    /**
     * Apply RBAC filtering to a tools/list upstream response.
     * Handles both JSON and SSE content types.
     * @private
     */
    _filterToolsListResponse(res, proxyRes, upstreamBody, allowedTools, user, role) {
        const contentType = proxyRes.headers['content-type'] ?? '';

        if (contentType.includes('text/event-stream')) {
            const raw = upstreamBody.toString();
            const filtered = raw.replace(
                /^data: (.+)$/gm,
                (_match, jsonStr) => {
                    try {
                        const msg = JSON.parse(jsonStr);
                        if (msg?.result?.tools) {
                            const modified = this.interceptor.filterToolsList(msg, allowedTools, user, role);
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
            try {
                const msg = JSON.parse(upstreamBody.toString());
                const modified = this.interceptor.filterToolsList(msg, allowedTools, user, role);
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
    }

    /**
     * Print the startup banner with configuration details.
     * @private
     */
    _printBanner() {
        const toolSummary = Object.entries(this.roleResolver.roles)
            .map(([r, def]) => `    ${r.padEnd(14)} ${def.tools.includes('*') ? 'ALL tools' : `${def.tools.length} tools`}`)
            .join('\n');

        console.log(`
========================================
  MCP RBAC Gateway
========================================
  Listening : http://0.0.0.0:${this.port}
  Upstream  : ${this.proxy.upstreamUrl}
  Keycloak  : ${this.tokenVerifier.issuer}
  Audience  : ${this.tokenVerifier.audience}
  Scope     : ${this.tokenVerifier.requiredScope}
----------------------------------------
  Role permissions:
${toolSummary}
========================================
`);
    }
}
