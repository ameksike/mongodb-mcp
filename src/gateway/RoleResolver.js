/**
 * @file RoleResolver — RBAC role resolution and tool permission checking.
 * @description Information Expert for role-based access control. Loads the
 *              role configuration, resolves effective roles from JWT claims,
 *              and determines tool-level permissions.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class RoleResolver {
    /**
     * @param {string} configDir  Directory containing roles.json
     */
    constructor(configDir) {
        const raw = readFileSync(join(configDir, 'roles.json'), 'utf-8');
        this.config = JSON.parse(raw);
    }

    /**
     * Resolve the effective role for a user based on Keycloak realm roles.
     * Uses precedence order defined in roles.json.
     * @param {string[]} realmRoles  Array of realm role names from the JWT
     * @returns {{ role: string, allowedTools: string[] } | null}
     */
    resolve(realmRoles) {
        for (const roleName of this.config.rolePrecedence) {
            if (realmRoles.includes(roleName)) {
                return {
                    role: roleName,
                    allowedTools: this.config.roles[roleName].tools,
                };
            }
        }

        if (this.config.defaultRole && this.config.roles[this.config.defaultRole]) {
            return {
                role: this.config.defaultRole,
                allowedTools: this.config.roles[this.config.defaultRole].tools,
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
        return this.config.roles;
    }
}
