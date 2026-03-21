/**
 * @file McpInterceptor — MCP JSON-RPC message interception and RBAC filtering.
 * @description Information Expert for MCP protocol awareness. Handles filtering
 *              of tools/list responses and blocking of unauthorized tools/call
 *              requests based on the user's resolved role.
 */

export class McpInterceptor {
    /**
     * @param {import('./RoleResolver.js').RoleResolver} roleResolver
     */
    constructor(roleResolver) {
        this.roleResolver = roleResolver;
    }

    /**
     * Filter a tools/list JSON-RPC response to only include allowed tools.
     * @param {object}   body          Parsed JSON-RPC response
     * @param {string[]} allowedTools  Allowed tool names (or ["*"])
     * @param {string}   user          Username for logging
     * @param {string}   role          Role name for logging
     * @returns {object} Modified response with filtered tools
     */
    filterToolsList(body, allowedTools, user, role) {
        if (!body?.result?.tools) return body;

        if (allowedTools.includes('*')) {
            const names = body.result.tools.map((t) => t.name);
            console.log(`[gateway:rbac] tools/list for user="${user}" role="${role}" — ALL ${names.length} tools enabled:`);
            names.forEach((n) => console.log(`  [gateway:rbac]   ✔ ${n}`));
            return body;
        }

        const original = body.result.tools;
        const kept = [];
        const removed = [];

        for (const t of original) {
            if (allowedTools.includes(t.name)) {
                kept.push(t);
            } else {
                removed.push(t.name);
            }
        }

        body.result.tools = kept;

        console.log(`[gateway:rbac] tools/list for user="${user}" role="${role}" — ${kept.length}/${original.length} tools enabled:`);
        kept.forEach((t) => console.log(`  [gateway:rbac]   ✔ ${t.name}`));
        if (removed.length) {
            console.log(`[gateway:rbac] ${removed.length} tools hidden:`);
            removed.forEach((n) => console.log(`  [gateway:rbac]   ✘ ${n}`));
        }

        return body;
    }

    /**
     * Check if a tools/call request targets an allowed tool.
     * @param {object}   body          Parsed JSON-RPC request
     * @param {string[]} allowedTools  Allowed tool names
     * @returns {{ allowed: boolean, toolName: string }}
     */
    checkToolCall(body, allowedTools) {
        const toolName = body?.params?.name ?? '';
        return {
            allowed: this.roleResolver.isToolAllowed(toolName, allowedTools),
            toolName,
        };
    }

    /**
     * Build a JSON-RPC error response for denied tool calls.
     * @param {number|string} id        JSON-RPC request id
     * @param {string}        toolName  Denied tool name
     * @param {string}        role      User's role
     * @returns {string} Serialized JSON-RPC error response
     */
    buildAccessDenied(id, toolName, role) {
        return JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
                code: -32001,
                message: `Access denied: tool "${toolName}" is not available for role "${role}"`,
            },
        });
    }
}
