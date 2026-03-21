/**
 * @file ProxyHandler — HTTP reverse proxy to the upstream MCP Server.
 * @description Information Expert for HTTP proxying. Handles request forwarding,
 *              header manipulation, body buffering, and response interception
 *              for both JSON and SSE content types.
 */

import { request as httpRequest } from 'node:http';

export class ProxyHandler {
    /**
     * @param {string} upstreamUrl  Base URL of the upstream MCP Server
     */
    constructor(upstreamUrl) {
        this.upstreamUrl = upstreamUrl;
    }

    /**
     * Build proxy-safe forwarding headers.
     * Strips auth and host, injects authenticated user metadata.
     * @param {object} originalHeaders  Incoming request headers
     * @param {object} authContext       { sub, username, role }
     * @param {Buffer} [bodyBuffer]      Buffered body (to recalculate content-length)
     * @returns {object} Headers for the upstream request
     */
    buildForwardHeaders(originalHeaders, authContext, bodyBuffer) {
        const headers = { ...originalHeaders };
        delete headers['authorization'];
        delete headers['host'];
        headers['x-authenticated-user'] = authContext.sub;
        headers['x-authenticated-username'] = authContext.username;
        headers['x-authenticated-role'] = authContext.role;

        if (bodyBuffer) {
            headers['content-length'] = String(bodyBuffer.length);
        }

        return headers;
    }

    /**
     * Forward a request to the upstream MCP Server and pipe the response back.
     * @param {import('node:http').IncomingMessage} req    Client request
     * @param {import('node:http').ServerResponse}  res    Client response
     * @param {object}  headers   Forwarded headers
     * @param {Buffer}  [body]    Buffered request body
     */
    forward(req, res, headers, body) {
        const upstream = new URL(req.url, this.upstreamUrl);
        const opts = this._proxyOpts(upstream, req.method, headers);

        console.log(`[gateway:proxy] Forwarding ${req.method} ${req.url} -> ${this.upstreamUrl}${upstream.pathname}`);

        const proxyReq = httpRequest(opts, (proxyRes) => {
            console.log(`[gateway:proxy] Upstream responded: ${proxyRes.statusCode} (${proxyRes.headers['content-type'] ?? 'no content-type'})`);
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error(`[gateway] upstream error: ${err.message}`);
            ProxyHandler.sendError(res, 502, 'Bad Gateway', err.message);
        });

        this._sendBody(proxyReq, req, body);
    }

    /**
     * Forward a request and intercept the response for transformation.
     * Buffers the full upstream response and passes it to the callback.
     * @param {import('node:http').IncomingMessage} req       Client request
     * @param {import('node:http').ServerResponse}  res       Client response
     * @param {object}  headers    Forwarded headers
     * @param {Buffer}  [body]     Buffered request body
     * @param {function} onResponse  Callback(proxyRes, upstreamBody)
     */
    forwardAndIntercept(req, res, headers, body, onResponse) {
        const upstream = new URL(req.url, this.upstreamUrl);
        const opts = this._proxyOpts(upstream, req.method, headers);

        console.log(`[gateway:proxy] Forwarding tools/list -> ${this.upstreamUrl}${upstream.pathname} (will filter response)`);

        const proxyReq = httpRequest(opts, async (proxyRes) => {
            console.log(`[gateway:proxy] Upstream responded: ${proxyRes.statusCode} — applying RBAC filter...`);
            const upstreamBody = await ProxyHandler.collectBody(proxyRes);
            onResponse(proxyRes, upstreamBody);
        });

        proxyReq.on('error', (err) => {
            console.error(`[gateway] upstream error: ${err.message}`);
            ProxyHandler.sendError(res, 502, 'Bad Gateway', err.message);
        });

        this._sendBody(proxyReq, req, body);
    }

    /**
     * Build http.request options from a parsed URL.
     * @private
     */
    _proxyOpts(url, method, headers) {
        return {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers,
        };
    }

    /**
     * Send the appropriate body to the proxy request.
     * @private
     */
    _sendBody(proxyReq, req, body) {
        if (body) {
            proxyReq.end(body);
        } else if (req.method === 'GET' || req.method === 'DELETE') {
            proxyReq.end();
        } else {
            req.pipe(proxyReq);
        }
    }

    /**
     * Buffer a readable stream into a single Buffer.
     * @param {import('node:stream').Readable} stream
     * @returns {Promise<Buffer>}
     */
    static collectBody(stream) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
        });
    }

    /**
     * Send an error JSON response (if headers not yet sent).
     * @param {import('node:http').ServerResponse} res
     * @param {number} status   HTTP status code
     * @param {string} error    Error label
     * @param {string} [detail] Additional detail
     */
    static sendError(res, status, error, detail) {
        if (res.headersSent) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error, ...(detail && { detail }) }));
    }
}
