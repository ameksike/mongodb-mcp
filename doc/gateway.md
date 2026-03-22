# MCP RBAC Gateway — Usage Guide

## Overview

The RBAC Gateway is an MCP-aware reverse proxy that enforces **Role-Based
Access Control** on the MongoDB MCP Server. It validates Keycloak JWT tokens,
extracts the user's realm role, and filters which MCP tools are visible and
callable for each user.

This implements the **Delegated Authorization** pattern recommended by the
[MongoDB MCP Security Best Practices](https://www.mongodb.com/docs/mcp-server/security-best-practices/)
and the [MCP Authorization specification](https://modelcontextprotocol.io/docs/tutorials/security/authorization).

## Architecture

```
                            ┌────────────────────┐
                            │     Keycloak       │
                            │     :8080 (AS)     │
                            │                    │
                            │  Realm: mcp        │
                            │  Roles: mcp-admin  │
                            │         mcp-analyst│
                            │         mcp-viewer │
                            └────────┬───────────┘
                                     │ JWKS verification
                                     │ + role extraction
┌────────────┐  Bearer      ┌────────┴────────┐           ┌──────────────┐
│   Client   │──────token──>│  RBAC Gateway   │──────────>│  MCP Server  │
│   (Agent)  │              │  :4040          │ (no auth) │  :8008       │
└────────────┘              │                 │           └──────────────┘
                            │  Intercepts:    │
                            │  - tools/list   │
                            │  - tools/call   │
                            └─────────────────┘
```

**Security properties:**

- The MCP Server never sees or validates tokens
- JWT verification uses JWKS (no shared secrets)
- Tokens are triple-checked: issuer, audience (`mcp-server`), scope (`mcp:access`)
- Roles are extracted from the standard `realm_access.roles` JWT claim
- Deny-by-default: users without a recognized role get zero tools
- Both tool listing and tool execution are gated by role
- **Defense in depth:** per-role `readOnly` and `disabledTools` overrides are
  forwarded as `x-mongodb-mcp-read-only` / `x-mongodb-mcp-disabled-tools`
  headers to the upstream MCP Server, which enforces them natively (overrides
  can only restrict, never widen access)

## Roles and Permissions

Each role in `cfg/roles.json` defines a `tools` object with **mutually exclusive**
`allow` or `deny` modes plus an optional `readOnly` flag:

- **`tools.allow`** — Fine-grained tool allow-list enforced at the gateway proxy layer.
  The gateway intercepts `tools/list` responses to filter visible tools and blocks
  unauthorized `tools/call` requests with a JSON-RPC error.
- **`tools.deny`** — MCP Server native category names (e.g. `mongodb`, `atlas`),
  forwarded as `x-mongodb-mcp-disabled-tools` header. The MCP Server handles
  filtering natively — the gateway acts as a transparent proxy.
- **`tools.readOnly`** — Read-only mode, forwarded as `x-mongodb-mcp-read-only`
  header. Disables create/update/delete operations at the MCP Server level.

> `allow` and `deny` are mutually exclusive — a role uses one or the other, never both.

| Role            | Mode  | Value                | readOnly | Description                        |
|-----------------|:-----:|----------------------|:--------:|------------------------------------|
| `mcp-admin`     | allow | `["*"]`              | `false`  | Full access to all MCP tools       |
| `mcp-analyst`   | allow | 14 specific tools    | `true`   | Read, query, analysis, and export  |
| `mcp-demo`      | deny  | `["mongodb"]`        | `true`   | All except mongodb category        |
| `mcp-viewer`    | allow | 5 specific tools     | _(none)_ | Basic read-only browsing           |
| `mcp-guest`     | deny  | `["atlas"]`          | `true`   | All except atlas category          |

The MCP Server starts with the most permissive base configuration
(`readOnly=false`, `disabledTools=none`, `allowRequestOverrides=true`).
Per-request overrides can only make things **stricter**, never more
permissive — this is enforced by the MCP Server itself.

### How overrides work (MCP Server native)

The MongoDB MCP Server reads configuration overrides from HTTP headers using
the `x-mongodb-mcp-*` prefix (kebab-case → camelCase conversion):

| Header                            | Config key       | Override behavior                                       |
|-----------------------------------|------------------|---------------------------------------------------------|
| `x-mongodb-mcp-read-only`        | `readOnly`       | One-way: can only set to `true`, never back to `false`  |
| `x-mongodb-mcp-disabled-tools`   | `disabledTools`  | Merge: adds to the base list, never removes             |

This requires `MDB_MCP_ALLOW_REQUEST_OVERRIDES=true` on the MCP Server (set
by default in the wrapper launcher).

### Allow mode — Detailed Tool Matrix

Roles using `allow` have their tools explicitly listed. The gateway filters
`tools/list` and blocks `tools/call` for unlisted tools.

| Tool                       | admin | analyst  | viewer |
|----------------------------|:-----:|:--------:|:------:|
| `find`                     |   x   |    x     |   x    |
| `count`                    |   x   |    x     |   x    |
| `list-collections`         |   x   |    x     |   x    |
| `collection-schema`        |   x   |    x     |   x    |
| `collection-indexes`       |   x   |    x     |   x    |
| `aggregate`                |   x   |    x     |        |
| `explain`                  |   x   |    x     |        |
| `list-databases`           |   x   |    x     |        |
| `db-stats`                 |   x   |    x     |        |
| `collection-storage-size`  |   x   |    x     |        |
| `export`                   |   x   |    x     |        |
| `mongodb-logs`             |   x   |    x     |        |
| `search-knowledge`         |   x   |    x     |        |
| `list-knowledge-sources`   |   x   |    x     |        |
| _(all other tools)_        |   x   |          |        |

### Deny mode — Category-based exclusion

Roles using `deny` delegate filtering to the MCP Server's native
`disabledTools` mechanism. The gateway forwards the categories as
the `x-mongodb-mcp-disabled-tools` header.

| Role          | Denied categories | Effect                                  |
|---------------|-------------------|-----------------------------------------|
| `mcp-analyst` | `mongodb`         | All mongodb tools disabled              |
| `mcp-guest`   | `atlas`           | All atlas tools disabled                |

Valid category values are defined by the MCP Server: `mongodb`, `atlas`,
`create`, `update`, `delete`, and individual tool names.

The mapping is defined in `cfg/roles.json` and can be edited without
code changes. Restart the gateway after modifying.

## Gateway Code Structure

The gateway follows OOP principles (SOLID, SoC, GRASP) with clear separation
of responsibilities:

| File                | Responsibility                                            |
|---------------------|-----------------------------------------------------------|
| `index.js`          | Entry point — loads config and starts the server           |
| `GatewayServer.js`  | Controller — HTTP server, request orchestration (DI-ready) |
| `TokenVerifier.js`  | JWT/JWKS verification and scope validation                 |
| `RoleResolver.js`   | Role resolution from JWT claims, tool permissions          |
| `McpInterceptor.js` | MCP JSON-RPC filtering (`tools/list`, `tools/call`)        |
| `ProxyHandler.js`   | HTTP reverse proxy with `x-mongodb-mcp-*` header injection |

`GatewayServer` supports Dependency Injection — pass pre-built instances via
the `deps` parameter to override any component for testing or customization.

## Predefined Keycloak Users

The following users are pre-configured in the Keycloak realm import file
(`iac/keycloak/realm-export.json`). They are created automatically when
Keycloak starts with `--import-realm`.

| Username       | Password     | Email                   | Full Name      | Realm Role     | Tools |
|----------------|--------------|-------------------------|----------------|----------------|:-----:|
| `mcp-admin`    | `admin123`   | `admin@example.com`     | Admin User     | `mcp-admin`    |  17   |
| `mcp-analyst`  | `analyst123` | `analyst@example.com`   | Analyst User   | `mcp-analyst`  |  14   |
| `mcp-viewer`   | `viewer123`  | `viewer@example.com`    | Viewer User    | `mcp-viewer`   |   6   |
| `mcpuser`      | `mcppass`    | `mcpuser@example.com`   | MCP User       | `mcp-admin`    |  17   |

> `mcpuser` is a legacy user kept for backwards compatibility with the
> auth proxy (`iac/auth-proxy`). It has `mcp-admin` role.

### Keycloak Realm Configuration

| Setting                  | Value                                     |
|--------------------------|-------------------------------------------|
| Realm name               | `mcp`                                     |
| SSL required             | `none` (development only)                 |
| Brute force protection   | Enabled                                   |
| Registration allowed     | Disabled                                  |
| Login with email         | Enabled                                   |

### OAuth Clients

| Client ID                    | Type           | Secret               | Purpose                    |
|------------------------------|----------------|----------------------|----------------------------|
| `mcp-client`                 | Public         | —                    | User-facing apps (browser, CLI) |
| `mcp-client-confidential`    | Confidential   | `mcp-client-secret`  | Service-to-service, introspection |

### Client Scope: `mcp:access`

Included as a default scope for both clients. Contains two protocol mappers:

- **`audience-mcp-server`** — Adds `"aud": "mcp-server"` to the access token.
  The gateway validates this claim to ensure the token was intended for the
  MCP Server.
- **`realm-roles`** — Maps `realm_access.roles` into the access token.
  The gateway reads this claim to resolve the user's RBAC role.

### Realm Roles

| Role           | Description                                           | Assigned To                 |
|----------------|-------------------------------------------------------|-----------------------------|
| `mcp-admin`    | Full access to all MongoDB MCP tools                  | `mcp-admin`, `mcpuser`      |
| `mcp-analyst`  | Read, query, analysis, and export access to MCP tools | `mcp-analyst`               |
| `mcp-viewer`   | Basic read-only browsing of MCP tools                 | `mcp-viewer`                |

> **Warning:** All credentials above are for development only. Change all
> passwords and secrets before deploying to any shared or production
> environment.

---

## Step-by-Step Usage

### Step 1 — Start the MCP Server

```bash
npm run mcp:wrapper:start
```

### Step 2 — Start Keycloak

```bash
npm run mcp:docker:start

docker compose up keycloak
docker ps
docker logs keycloak
```

Wait until Keycloak is healthy (~30–60 seconds on first run). You can verify:

```bash
curl -s http://localhost:8080/health/ready
```

### Step 3 — Start the RBAC Gateway

```bash
npm run mcp:gateway:start
```

Expected output:

```
========================================
  MCP RBAC Gateway
========================================
  Started   : 3/22/2026, 10:00:00 AM
  Listening : http://0.0.0.0:4040
  Upstream  : http://127.0.0.1:8008
  Keycloak  : http://localhost:8080/realms/mcp
  Audience  : mcp-server
  Scope     : mcp:access
----------------------------------------
  Role permissions:
    mcp-admin      allow ALL tools    RW
    mcp-analyst    allow 14 tools     RO
    mcp-viewer     allow 5 tools      RW
    mcp-guest      deny  1 tools      RO
========================================
```

### Step 4 — Run the test client

The test client accepts `--user` and `--pass` flags to override credentials.
Pass them after `--` so npm forwards them to the script:

```bash
# Uses .env defaults (MCP_AUTH_USERNAME / MCP_AUTH_PASSWORD)
npm run mcp:client:gateway

# As admin (all 17 tools)
npm run mcp:client:gateway -- --user mcp-admin --pass admin123

# As analyst (14 tools)
npm run mcp:client:gateway -- --user mcp-analyst --pass analyst123

# As viewer (6 tools)
npm run mcp:client:gateway -- --user mcp-viewer --pass viewer123
```

> **Priority:** `--user`/`--pass` flags > environment variables > defaults.

### Step 5 — Stop everything

```bash
npm run mcp:docker:stop
# Then Ctrl+C on the gateway and MCP Server terminals
```

---

## Keycloak Interaction Examples (curl)

These examples show how to interact with Keycloak directly via `curl`.
This is useful for understanding the OAuth 2.1 flow, debugging tokens,
and integrating with custom clients.

### 1. Obtain an Access Token (Resource Owner Password Grant)

> **Note:** The password grant is used here for testing convenience.
> In production, use Authorization Code + PKCE.

**As admin:**

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=mcp-client" \
  -d "username=mcp-admin" \
  -d "password=admin123" \
  -d "scope=openid mcp:access"
```

**As analyst:**

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=mcp-client" \
  -d "username=mcp-analyst" \
  -d "password=analyst123" \
  -d "scope=openid mcp:access"
```

**As viewer:**

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=mcp-client" \
  -d "username=mcp-viewer" \
  -d "password=viewer123" \
  -d "scope=openid mcp:access"
```

**Response:**

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "expires_in": 300,
  "refresh_expires_in": 1800,
  "refresh_token": "eyJhbGciOiJIUzUxMiIs...",
  "token_type": "Bearer",
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "scope": "openid mcp:access email profile"
}
```

**Extract just the access token (bash):**

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -d "grant_type=password" \
  -d "client_id=mcp-client" \
  -d "username=mcp-admin" \
  -d "password=admin123" \
  -d "scope=openid mcp:access" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>console.log(JSON.parse(d).access_token));
  ")
echo $TOKEN
```

### 2. Inspect / Decode a Token (without verification)

A JWT has three base64url-encoded parts separated by dots. You can decode
the payload (middle part) to see the claims:

```bash
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)));
"
```

**Example decoded payload:**

```json
{
  "exp": 1742500000,
  "iat": 1742499700,
  "iss": "http://localhost:8080/realms/mcp",
  "aud": "mcp-server",
  "sub": "a1b2c3d4-...",
  "preferred_username": "mcp-analyst",
  "scope": "openid mcp:access email profile",
  "realm_access": {
    "roles": [
      "default-roles-mcp",
      "mcp-analyst"
    ]
  }
}
```

**Key claims:**

| Claim                | Purpose                                      |
|----------------------|----------------------------------------------|
| `iss`                | Issuer — must match Keycloak realm URL        |
| `aud`                | Audience — must be `mcp-server`               |
| `scope`              | Must include `mcp:access`                     |
| `realm_access.roles` | Keycloak realm roles — used by the gateway    |
| `preferred_username` | Human-readable username for audit logs        |
| `exp`                | Expiration time (Unix timestamp)              |
| `sub`                | Subject — unique user ID                      |

### 3. Introspect a Token (server-side verification)

Token introspection asks Keycloak whether a token is still valid. This
requires the confidential client credentials:

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token/introspect \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN" \
  -d "client_id=mcp-client-confidential" \
  -d "client_secret=mcp-client-secret"
```

**Response (active token):**

```json
{
  "active": true,
  "scope": "openid mcp:access email profile",
  "username": "mcp-analyst",
  "realm_access": {
    "roles": ["default-roles-mcp", "mcp-analyst"]
  },
  "client_id": "mcp-client",
  "token_type": "Bearer",
  "exp": 1742500000
}
```

**Response (expired or revoked token):**

```json
{
  "active": false
}
```

### 4. Refresh an Expired Token

Access tokens are short-lived (default: 5 minutes). Use the refresh token
to obtain a new access token without re-entering credentials:

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "client_id=mcp-client" \
  -d "refresh_token=<your-refresh-token>"
```

### 5. Revoke a Token

Explicitly revoke a token to invalidate it before expiration:

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$TOKEN" \
  -d "client_id=mcp-client"
```

### 6. Get Keycloak OpenID Configuration

Discover all available endpoints for the `mcp` realm:

```bash
curl -s http://localhost:8080/realms/mcp/.well-known/openid-configuration | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)));
"
```

This returns the authorization, token, introspection, JWKS, and userinfo
endpoints — everything a client needs to implement the OAuth 2.1 flow.

### 7. Obtain a Service Account Token (Client Credentials Grant)

For machine-to-machine communication without a user context:

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=mcp-client-confidential" \
  -d "client_secret=mcp-client-secret" \
  -d "scope=openid mcp:access"
```

---

## Using Tokens with the Gateway (curl)

Once you have a token, you can interact with the MCP Server through the
gateway using standard MCP Streamable HTTP requests.

### Initialize a session

```bash
curl -s -X POST http://localhost:4040/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "curl-test", "version": "1.0.0" }
    }
  }'
```

### List available tools (filtered by role)

```bash
curl -s -X POST http://localhost:4040/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

An admin will see all 17 tools. A viewer will only see 6.

### Call a tool

```bash
curl -s -X POST http://localhost:4040/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list-databases",
      "arguments": {}
    }
  }'
```

### Tool call denied (role violation)

If a viewer tries to call `aggregate`:

```bash
curl -s -X POST http://localhost:4040/mcp \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "aggregate",
      "arguments": { "database": "test", "collection": "users", "pipeline": [] }
    }
  }'
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32001,
    "message": "Access denied: tool \"aggregate\" is not available for role \"mcp-viewer\""
  }
}
```

---

## VS Code Copilot Integration

The `.vscode/mcp.json` file defines a `mongodb-gateway` server that connects
through the RBAC Gateway. VS Code will prompt you to paste a Bearer token
when connecting.

### How to connect

1. Make sure Keycloak, the MCP Server, and the Gateway are all running
2. Obtain a token for the desired user:

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -d "grant_type=password" \
  -d "client_id=mcp-client" \
  -d "username=mcp-admin" \
  -d "password=admin123" \
  -d "scope=openid mcp:access" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>console.log(JSON.parse(d).access_token));
  "
```

3. In VS Code, open the MCP panel and connect to `mongodb-gateway`
4. Paste the token when prompted

> **Note:** VS Code may show warnings about failing to discover OAuth metadata.
> This is expected — the gateway is not an OAuth server. VS Code will fall
> back to using the manual token from `.vscode/mcp.json`.

### Available users for testing

| Username       | Password     | Role           | Mode  | Access                    |
|----------------|--------------|----------------|:-----:|---------------------------|
| `mcp-admin`    | `admin123`   | `mcp-admin`    | allow | All tools                 |
| `mcp-analyst`  | `analyst123` | `mcp-analyst`  | deny  | All except mongodb category |
| `mcp-viewer`   | `viewer123`  | `mcp-viewer`   | allow | 5 specific tools          |

> Tokens expire after 5 minutes. Obtain a new one if VS Code returns 403.

---

## Customizing Roles

Edit `cfg/roles.json`. Each role has a `description` and a `tools` object.
The `tools` object uses **either** `allow` or `deny` (mutually exclusive),
plus an optional `readOnly` flag:

```json
{
  "roles": {
    "mcp-admin": {
      "description": "Full access",
      "tools": { "allow": ["*"], "readOnly": false }
    },
    "mcp-analyst": {
      "description": "All except mongodb category",
      "tools": { "deny": ["mongodb"], "readOnly": true }
    },
    "mcp-viewer": {
      "description": "Basic read-only browsing",
      "tools": { "allow": ["find", "count", "list-collections", "collection-schema", "collection-indexes"] }
    },
    "mcp-custom": {
      "description": "Custom deny-based role",
      "tools": { "deny": ["atlas", "delete"], "readOnly": true }
    }
  },
  "defaultRole": null,
  "rolePrecedence": ["mcp-admin", "mcp-analyst", "mcp-custom", "mcp-viewer"]
}
```

### Allow mode (gateway-enforced)
- `tools.allow: ["*"]` grants access to all tools
- `tools.allow: ["find", "count", ...]` — only listed tools are visible and callable
- The gateway intercepts `tools/list` and `tools/call` to enforce the list

### Deny mode (MCP Server-enforced)
- `tools.deny: ["mongodb"]` — categories forwarded via `x-mongodb-mcp-disabled-tools` header
- The MCP Server handles filtering natively — the gateway proxies transparently
- Valid category values: `mongodb`, `atlas`, `create`, `update`, `delete`, and individual tool names

### Common options
- `tools.readOnly` — forwarded via `x-mongodb-mcp-read-only` header; can only restrict (`false` → `true`), never widen
- `defaultRole` (set to a role name or `null`) is used when no matching role is found
- `rolePrecedence` determines which role wins when a user has multiple realm roles
- After editing, restart the gateway — no other changes needed

To add the custom role in Keycloak, go to the admin console → `mcp` realm →
Realm Roles → Create Role → assign it to users. You can also add it to
`iac/keycloak/realm-export.json` for automatic provisioning on next fresh
Keycloak start.

---

## Troubleshooting

### Gateway returns `401 Unauthorized`
- Verify the `Authorization: Bearer <token>` header is present
- Ensure Keycloak is running and the `mcp` realm exists

### Gateway returns `403 Forbidden`
- Token may be expired (default: 5 minutes) — obtain a new one
- Check `scope` includes `mcp:access`
- Check `aud` includes `mcp-server`
- Inspect the token payload to verify claims

### Gateway returns `403 — No MCP role assigned`
- The user has no recognized role in `realm_access.roles`
- Assign a role in Keycloak: Users → select user → Role Mappings → Assign Role

### Gateway returns `-32001 Access denied` on tool call
- The tool is not in the allowed list for the user's role
- Check `cfg/roles.json` for the role's tool list
- Upgrade the user's role or add the tool to the role config

### `502 Bad Gateway`
- The upstream MCP Server is not running on port 8008
- Start it with `npm run mcp:wrapper:start`
