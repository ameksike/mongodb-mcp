# 🍃 MongoDB MCP Server

A ready-to-use integration of the [MongoDB MCP Server](https://www.mongodb.com/docs/mcp-server/overview/)
with multiple deployment modes — from a simple local launcher to a fully
secured RBAC gateway with Keycloak authentication.

Explore how to connect AI agents and LLM clients (Claude, VS Code Copilot,
Cursor, etc.) to your MongoDB databases through the
[Model Context Protocol](https://modelcontextprotocol.io/).

---

## 📋 Table of Contents

| #  | Section                                          | Description                                    |
|----|--------------------------------------------------|------------------------------------------------|
| 1  | [Deployment Modes](#-deployment-modes)           | Compare the three available modes              |
| 2  | [Quick Start](#-quick-start)                     | Get running in 2 minutes (basic mode)          |
| 3  | [Project Structure](#-project-structure)         | Directory layout overview                      |
| 4  | [Test Client](#-test-client)                     | Built-in MCP diagnostic client                 |
| 5  | [VS Code Copilot](#-vs-code-copilot-integration) | Connect VS Code to the MCP Server              |
| 6  | [Docker Compose](#-docker-compose)               | Run the full stack with containers             |
| 7  | [Documentation](#-documentation)                 | Links to detailed guides                       |
| 8  | [npm Scripts](#-npm-scripts)                     | All available commands at a glance             |
| 9  | [References](#-references)                       | Official docs and specifications               |

---

## 🔀 Deployment Modes

This project supports three deployment modes, each adding a layer of
security on top of the previous one:

### 🟢 Basic Mode — Direct Connection

The simplest setup. The MCP Server runs locally and accepts connections
without authentication. Best for **local development** and quick testing.

```
┌────────────┐           ┌──────────────┐
│   Client   │──────────>│  MCP Server  │
│   (Agent)  │   :8008   │  (MongoDB)   │
└────────────┘           └──────────────┘
```

**When to use:** Solo development, local experiments, testing tools.

> 📖 See [Quick Start](#-quick-start) below.

---

### 🟡 Proxy Mode — OAuth 2.1 Authentication

Adds Keycloak as an OAuth 2.1 Authorization Server and a reverse proxy
that validates Bearer tokens before forwarding to the MCP Server.
Implements the **Delegated Authorization** pattern.

```
┌────────────┐  Bearer  ┌──────────┐           ┌──────────────┐
│   Client   │──token──>│  Proxy   │──────────>│  MCP Server  │
│   (Agent)  │          │  (RS)    │ (no auth) │  (MongoDB)   │
└────────────┘          └────┬─────┘           └──────────────┘
                             │ JWKS
                        ┌────┴─────┐
                        │ Keycloak │
                        │  (AS)    │
                        └──────────┘
```

**When to use:** Shared environments, multiple users, audit requirements.

> 📖 See [`iac/auth-proxy/`](iac/auth-proxy/) for the proxy implementation.

---

### 🔴 Gateway Mode — RBAC (Role-Based Tool Filtering)

The most secure mode. Extends Proxy Mode by inspecting MCP messages and
filtering tools based on the user's Keycloak realm role. Different users
see and can execute different sets of tools.

```
┌────────────┐  Bearer  ┌──────────────┐           ┌──────────────┐
│   Client   │──token──>│ RBAC Gateway │──────────>│  MCP Server  │
│   (Agent)  │          │ :4040        │ (no auth) │  (MongoDB)   │
└────────────┘          └──────┬───────┘           └──────────────┘
                               │ JWKS + roles
                          ┌────┴─────┐
                          │ Keycloak │
                          │  (AS)    │
                          └──────────┘
```

| Role              | Mode  | Access Level                                  |
|-------------------|:-----:|-----------------------------------------------|
| 🔑 `mcp-admin`    | allow | Full access — all tools (RW)                  |
| 📊 `mcp-analyst`  | allow | 14 specific tools (RO)                        |
| 👁️ `mcp-viewer`   | allow | 5 specific tools (RW)                         |
| 👤 `mcp-guest`    | deny  | All except `atlas` category (RO)              |

**When to use:** Production, teams with different access levels, compliance.

> 📖 See [**doc/gateway.md**](doc/gateway.md) for the full guide: architecture,
> step-by-step setup, Keycloak curl examples, token inspection, and RBAC
> configuration.

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A MongoDB connection string (Atlas or local)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your MongoDB connection string:

```env
MDB_MCP_CONNECTION_STRING=mongodb+srv://user:password@cluster.mongodb.net
```

### 3. Start the MCP Server

```bash
npm run mcp:wrapper:start
```

```
========================================
  MongoDB MCP Server
========================================
  Status   : running
  URL      : http://127.0.0.1:8008
  Endpoint : http://127.0.0.1:8008/mcp
========================================
```

### 4. Verify with the test client

```bash
npm run mcp:client:start
```

All 7 diagnostic checks should pass (connect, ping, list tools, call tool,
list resources, read resource, shutdown).

---

## 📁 Project Structure

```
mongodb-mcp/
├── src/
│   ├── wrapper/                 # 🟢 MCP Server launcher
│   │   ├── index.js             #    Entry point
│   │   └── McpServerLauncher.js #    Process manager (env, spawn, shutdown)
│   ├── gateway/                 # 🔴 RBAC Gateway (OOP, SOLID/GRASP)
│   │   ├── index.js             #    Entry point — config + startup
│   │   ├── GatewayServer.js     #    Controller — HTTP server orchestration
│   │   ├── TokenVerifier.js     #    JWT/JWKS token verification
│   │   ├── RoleResolver.js      #    Role resolution + tool permissions
│   │   ├── McpInterceptor.js    #    MCP message filtering/blocking
│   │   └── ProxyHandler.js      #    HTTP reverse proxy to upstream
│   └── client/index.js          # 🧪 MCP test client (direct & auth modes)
├── cfg/
│   └── roles.json               # 🔧 Role-to-tools mapping config
├── iac/
│   ├── keycloak/
│   │   └── realm-export.json    # 🔐 Keycloak realm (roles, users, scopes)
├── doc/
│   └── gateway.md               # 📖 Full RBAC gateway guide
├── docker-compose.yml           # 🐳 Keycloak + MCP Server + Gateway
├── .env                         # ⚙️  Environment configuration
└── .vscode/mcp.json             # 🆚 VS Code Copilot MCP config
```

---

## 🧪 Test Client

The built-in test client implements the full
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
and supports both direct and authenticated modes:

```bash
# 🟢 Direct — no authentication
npm run mcp:client:start

# 🔴 Via Gateway — with Keycloak token (uses .env defaults)
npm run mcp:client:gateway

# 🔴 Via Gateway — override user from the command line
npm run mcp:client:gateway -- --user mcp-admin --pass admin123
```

The client runs a diagnostic suite: initialize, ping, list tools, call a
tool, list resources, read a resource, and graceful shutdown.

---

## 🆚 VS Code Copilot Integration

The `.vscode/mcp.json` file provides two server entries:

| Server             | URL                              | Auth   |
|--------------------|----------------------------------|--------|
| `mongodb`          | `http://127.0.0.1:8008/mcp`     | None   |
| `mongodb-gateway`  | `http://127.0.0.1:4040/mcp`     | Bearer |

For `mongodb-gateway`, VS Code will prompt you to paste a Keycloak access token.
Obtain one first (replace user/password as needed):

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

Copy the token and paste it when VS Code prompts.
See [doc/gateway.md](doc/gateway.md) for more details and all available users.

---

## 🐳 Docker Compose

Run the complete stack with a single command:

```bash
npm run mcp:docker:start
```

This starts three services:

| Service        | Port   | Description                              |
|----------------|--------|------------------------------------------|
| `keycloak`     | `:8080`| 🔐 OAuth 2.1 Authorization Server       |
| `mongodb-mcp`  | `:8008`| 🍃 MongoDB MCP Server                   |
| `mcp-gateway`  | `:4040`| 🛡️ RBAC Gateway (validates JWT + roles) |

Stop everything:

```bash
npm run mcp:docker:stop
```

---

## 📜 npm Scripts

| Script                        | Mode  | Description                                    |
|-------------------------------|:-----:|------------------------------------------------|
| `npm run mcp:wrapper:start`   | 🟢    | Start the MCP Server locally                   |
| `npm run mcp:client:start`    | 🟢    | Run diagnostics — direct (no auth)             |
| `npm run mcp:gateway:start`   | 🔴    | Start the RBAC Gateway locally                 |
| `npm run mcp:client:gateway`  | 🔴    | Run diagnostics — via gateway (with auth)      |
| `npm run mcp:client:auth`     | 🟡    | Run diagnostics — via proxy (with auth)        |
| `npm run mcp:docker:start`    | 🐳    | Start all Docker services                      |
| `npm run mcp:docker:stop`     | 🐳    | Stop all Docker services                       |

---

## 📖 Documentation

| Document                              | Description                                          |
|---------------------------------------|------------------------------------------------------|
| [**doc/gateway.md**](doc/gateway.md)  | 🔴 RBAC Gateway, full guide with Keycloak examples  |
| [**doc/gateway.md**](doc/remote.md)   | 🔴 Securing Remote MongoDB MCP Servers: An RBAC Gateway Architecture  |

---

## 📚 References

- [MongoDB MCP Server: Overview & Use Cases](https://www.mongodb.com/docs/mcp-server/overview/#use-cases)
- [MongoDB MCP Server: Get Started (Self-Managed)](https://www.mongodb.com/docs/mcp-server/get-started/?client=augment&deployment-type=self)
- [MongoDB MCP Server: Security Best Practices](https://www.mongodb.com/docs/mcp-server/security-best-practices/)
- [MongoDB MCP Server: Tools Reference](https://www.mongodb.com/docs/mcp-server/tools/)
- [MCP Specification: Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Specification: Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP Authorization Tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
- [LM Studio: Using MCP via API](https://lmstudio.ai/docs/developer/core/mcp)

---

## 📄 License

ISC
