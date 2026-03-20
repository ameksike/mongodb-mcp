# MongoDB MCP Server — Setup Guide

This guide covers two deployment modes for the MongoDB MCP Server:

1. **Direct Mode** — No authentication, local development
2. **Proxy Mode** — OAuth 2.1 delegated authorization via Keycloak

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Docker](https://www.docker.com/) and Docker Compose (only for Proxy Mode)
- A MongoDB connection string (Atlas or local)

## Project Structure

```
mongodb-mcp/
├── src/
│   ├── wrapper/index.js      # MCP Server launcher (local binary)
│   └── client/index.js       # MCP test client (direct & auth modes)
├── infra/
│   ├── keycloak/
│   │   └── realm-export.json  # Pre-configured Keycloak realm
│   └── auth-proxy/
│       ├── server.js          # OAuth 2.1 reverse proxy (Resource Server)
│       ├── Dockerfile
│       └── package.json
├── docker-compose.yml         # Keycloak + Auth Proxy (+ optional MCP Server)
├── .env                       # Environment configuration
└── .vscode/mcp.json           # VS Code Copilot MCP integration
```

---

## 1. Direct Mode (No Authentication)

Best for local development and quick testing. The MCP Server runs on your
machine and accepts connections without authentication.

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Configure environment

Copy `.env.example` to `.env` and set your MongoDB connection string:

```bash
cp .env.example .env
```

Edit `.env`:

```env
MDB_MCP_CONNECTION_STRING=mongodb+srv://user:password@cluster.mongodb.net
MDB_MCP_HTTP_PORT=8008
MDB_MCP_READ_ONLY=true
```

### Step 3 — Start the MCP Server

```bash
npm run mcp:wrapper:start
```

You should see:

```
========================================
  MongoDB MCP Server
========================================
  Status   : running
  URL      : http://127.0.0.1:8008
  Endpoint : http://127.0.0.1:8008/mcp
========================================
```

### Step 4 — Test the connection

Open a second terminal:

```bash
npm run mcp:client:start
```

Expected output: all 7 diagnostic checks pass (connect, ping, list tools,
call tool, list resources, read resource, shutdown).

### Step 5 — Connect VS Code Copilot

The `.vscode/mcp.json` file already includes a `mongodb` server entry:

```json
{
  "servers": {
    "mongodb": {
      "type": "http",
      "url": "http://127.0.0.1:8008/mcp"
    }
  }
}
```

VS Code Copilot will automatically detect and connect to the MCP Server.

---

## 2. Proxy Mode (OAuth 2.1 — Keycloak)

Implements **Delegated Authorization** as recommended by the
[MongoDB MCP Security Best Practices](https://www.mongodb.com/docs/mcp-server/security-best-practices/).

### Architecture

```
                              ┌───────────────────┐
                              │     Keycloak      │
                              │  :8080 (AS)       │
                              │  Issues JWT tokens│
                              └────────┬──────────┘
                                       │ JWKS verification
┌────────────┐  Bearer token  ┌────────┴─────────┐           ┌──────────────┐
│   Client   │───────────────>│   Auth Proxy     │──────────>│  MCP Server  │
│   (Agent)  │                │   :3000 (RS)     │ (no token)│  :8008       │
└────────────┘                └──────────────────┘           └──────────────┘
```

**Key security properties:**
- The MCP Server **never** sees or validates tokens
- The Auth Proxy strips the `Authorization` header before forwarding
- JWT verification uses JWKS (no shared secrets)
- Tokens are scoped with `audience: mcp-server` and `scope: mcp:access`

### Step 1 — Start the MCP Server locally

The MCP Server runs on your host machine (not in Docker), since the
`mongodb-mcp` service is commented out in `docker-compose.yml` by default:

```bash
npm run mcp:wrapper:start
```

### Step 2 — Start Keycloak and the Auth Proxy

```bash
npm run mcp:docker:start
```

This starts:
- **Keycloak** on `http://localhost:8080` — with a pre-imported `mcp` realm
- **Auth Proxy** on `http://localhost:3000` — waits for Keycloak to be healthy

> **Note:** First startup may take 1–2 minutes while Keycloak initializes and
> imports the realm configuration.

### Step 3 — Verify Keycloak is ready

Open `http://localhost:8080` in your browser and log in:

| Field    | Value   |
|----------|---------|
| Username | `admin` |
| Password | `admin` |

Navigate to the **mcp** realm. You should see:
- **Clients:** `mcp-client` (public) and `mcp-client-confidential`
- **Users:** `mcpuser`
- **Client Scopes:** `mcp:access`

### Step 4 — Test with OAuth authentication

```bash
npm run mcp:client:auth
```

This command:
1. Requests an access token from Keycloak (using the test user credentials)
2. Connects to the MCP Server **through the Auth Proxy** at `:3000`
3. Runs the full diagnostic suite with the Bearer token attached

Expected output: all 8 checks pass (token + 7 MCP diagnostics).

### Step 5 — Obtain a token manually (optional)

You can request a token directly using `curl`:

```bash
curl -s -X POST http://localhost:8080/realms/mcp/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=mcp-client" \
  -d "username=mcpuser" \
  -d "password=mcppass" \
  -d "scope=openid mcp:access"
```

The response includes an `access_token` field. Use it with:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
```

### Step 6 — Connect VS Code Copilot (secure)

The `.vscode/mcp.json` includes a `mongodb-secure` server entry:

```json
{
  "servers": {
    "mongodb-secure": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${input:mcpToken}"
      }
    }
  },
  "inputs": [
    {
      "id": "mcpToken",
      "type": "promptString",
      "description": "Paste your Keycloak Bearer token for MCP access",
      "password": true
    }
  ]
}
```

When Copilot connects, VS Code will prompt you for the token. Paste the
`access_token` obtained from Keycloak.

### Step 7 — Stop the stack

```bash
npm run mcp:docker:stop
```

---

## Test Credentials

| Resource               | Username / ID                | Password / Secret       |
|------------------------|------------------------------|-------------------------|
| Keycloak Admin Console | `admin`                      | `admin`                 |
| MCP Test User          | `mcpuser`                    | `mcppass`               |
| Public OAuth Client    | `mcp-client`                 | *(none — public client)*|
| Confidential Client    | `mcp-client-confidential`    | `mcp-client-secret`     |

> **Warning:** These are development credentials. Change all passwords and
> secrets before deploying to any shared or production environment.

---

## npm Scripts Reference

| Script                   | Description                                       |
|--------------------------|---------------------------------------------------|
| `npm run mcp:wrapper:start` | Start the MCP Server locally                   |
| `npm run mcp:client:start`  | Run diagnostics — direct mode (no auth)         |
| `npm run mcp:client:auth`   | Run diagnostics — OAuth mode (via proxy)        |
| `npm run mcp:docker:start`  | Start Keycloak + Auth Proxy                     |
| `npm run mcp:docker:stop`   | Stop all Docker services                        |

---

## Troubleshooting

### `EACCES: permission denied` on port 8008
The port may be reserved by Windows. Change `MDB_MCP_HTTP_PORT` in `.env` to
another port (e.g., `8009`).

### `EADDRINUSE: address already in use`
A previous MCP Server instance is still running. Kill it:
```bash
taskkill /F /IM node.exe
```

### Auth Proxy returns `401 Unauthorized`
- Verify Keycloak is running: `http://localhost:8080/health/ready`
- Ensure the token hasn't expired (default: 5 minutes)
- Check that the `mcp` realm was imported correctly

### Auth Proxy returns `403 Forbidden`
- The token is valid but missing the required scope or audience
- Verify `mcp:access` scope is assigned to the client in Keycloak
- Check the `audience-mcp-server` mapper exists in the `mcp:access` scope

### Keycloak health check fails
First startup can be slow. Wait up to 2 minutes. Check logs:
```bash
docker-compose logs keycloak
```
