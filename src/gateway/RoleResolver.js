/**
 * @file RoleResolver — RBAC role resolution and tool permission checking.
 * @description Information Expert for role-based access control. Loads the
 *              role configuration asynchronously on demand, resolves effective
 *              roles from JWT claims, and determines tool-level permissions.
 *
 *              Construction is synchronous and lightweight — no I/O occurs
 *              until load() is called. Once loaded, the configuration is
 *              cached in memory. This lazy-load pattern makes it trivial to
 *              swap the data source (file, database, API) by extending this
 *              class and overriding load().
 */

import { readFile } from 'node:fs/promises';

export class RoleResolver {
    /**
     * @param {object} opts
     * @param {string} opts.source  Path to the roles JSON file (or any source identifier)
     */
    constructor({ source }) {
        this.source = source;
        this._config = null;
    }

    /**
     * Load role configuration into memory. No-op if already loaded.
     * Override this method to load from a different data source.
     * @returns {Promise<void>}
     */
    async load() {
        if (this._config) return;
        const raw = await readFile(this.source, 'utf-8');
        this._config = JSON.parse(raw);
    }

    /**
     * Resolve the effective role for a user based on Keycloak realm roles.
     * Uses precedence order defined in the configuration.
     * @param {string[]} realmRoles  Array of realm role names from the JWT
     * @returns {{ role: string, allowedTools: string[] } | null}
     */
    resolve(realmRoles) {
        for (const roleName of this._config.rolePrecedence) {
            if (realmRoles.includes(roleName)) {
                return {
                    role: roleName,
                    allowedTools: this._config.roles[roleName].tools,
                };
            }
        }

        if (this._config.defaultRole && this._config.roles[this._config.defaultRole]) {
            return {
                role: this._config.defaultRole,
                allowedTools: this._config.roles[this._config.defaultRole].tools,
            };
        }

        return null;
    }

    /**
     * Check if a specific tool is allowed for the given tool list.
     * @param {string}   toolName      Tool name to check
     * @param {string[]} allowedTools  Array of allowed tool names (or ["*"])
     * @returns {boolean}
     */
    isToolAllowed(toolName, allowedTools) {
        return allowedTools.includes('*') || allowedTools.includes(toolName);
    }

    /** @returns {object} Raw roles configuration for display purposes */
    get roles() {
        return this._config.roles;
    }
}
