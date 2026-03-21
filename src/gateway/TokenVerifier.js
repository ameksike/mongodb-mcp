/**
 * @file TokenVerifier — JWT verification via Keycloak JWKS.
 * @description Information Expert for token validation. Encapsulates all
 *              OAuth 2.1 token verification logic: JWKS key fetching,
 *              issuer/audience validation, and scope checking.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

export class TokenVerifier {
    /**
     * @param {object} opts
     * @param {string} opts.keycloakUrl    Keycloak base URL (e.g. http://localhost:8080)
     * @param {string} opts.realm          Keycloak realm name
     * @param {string} opts.audience       Required audience claim
     * @param {string} opts.scope          Required scope claim
     */
    constructor({ keycloakUrl, realm, audience, scope }) {
        this.issuer = `${keycloakUrl}/realms/${realm}`;
        this.audience = audience;
        this.requiredScope = scope;
        this.jwks = createRemoteJWKSet(
            new URL(`${this.issuer}/protocol/openid-connect/certs`),
        );
    }

    /**
     * Verify a JWT access token against Keycloak JWKS.
     * @param {string} token  Raw JWT string
     * @returns {Promise<object>} Decoded JWT payload
     * @throws {Error} If verification, issuer, audience, or scope check fails
     */
    async verify(token) {
        const { payload } = await jwtVerify(token, this.jwks, {
            issuer: this.issuer,
            audience: this.audience,
        });

        const scopes = (payload.scope ?? '').split(' ');
        if (!scopes.includes(this.requiredScope)) {
            throw new Error(`Missing required scope: ${this.requiredScope}`);
        }

        return payload;
    }

    /**
     * Extract Bearer token from an Authorization header value.
     * @param {string} header  Authorization header (e.g. "Bearer eyJ...")
     * @returns {string|null}  Raw token or null if malformed
     */
    static extractBearer(header) {
        const match = (header ?? '').match(/^Bearer\s+(\S+)$/i);
        return match ? match[1] : null;
    }
}
