# Securing Remote MongoDB MCP Servers: An RBAC Gateway Architecture

## Abstract

The Model Context Protocol (MCP) enables AI agents to interact with external
tools and data sources through a standardized interface. The MongoDB MCP Server
exposes powerful database operations, queries, aggregations, schema inspection,
Atlas management as callable tools for LLM clients. However, the MCP Server
itself provides **no built-in authentication or authorization** for inbound
connections. When deployed as a remote HTTP service (Streamable HTTP transport),
it becomes an open endpoint that any client can reach.

This article examines the security gap in remote MCP deployments, classifies the
architectural patterns available to close it, and presents a concrete
implementation: an **RBAC Gateway** that enforces role-based access control
using Keycloak JWT tokens and the MCP Server's native per-request override
mechanism.

---

## 1. The Problem: MCP Servers Have No Inbound Auth

The MongoDB MCP Server is designed as a **backend service** with statically
configured access to MongoDB. It connects to databases using a connection string
or Atlas API credentials set at startup. The MCP specification defines the
protocol between client and server but delegates security to the transport layer:

> "The MCP Server does not authenticate or authorize inbound requests. You must
> protect it with a proxy or gateway that does."
> - [MongoDB MCP Security Best Practices](https://www.mongodb.com/docs/mcp-server/security-best-practices/)

In **stdio mode** (the default), this is not a problem, the server runs as a
child process of the client, inheriting its permissions. But in **HTTP mode**,
the server becomes a network-accessible service. Without protection, any client
that can reach the endpoint can:

- List all available tools
- Execute any tool (including writes, deletes, and Atlas admin operations)
- Access whatever databases the server's connection string permits

This is the fundamental security gap that must be addressed for any shared or
production deployment.

---

## 2. Architectural Patterns for Securing Remote MCP

There are four main patterns for securing a remote MCP Server, each adding
layers of protection:

### 2.1 Pattern A: Network Isolation Only

```
┌────────────┐           ┌──────────────┐
│   Client   │──────────>│  MCP Server  │
│   (Agent)  │  :8008    │  (localhost) │
└────────────┘           └──────────────┘
```

The MCP Server binds to `127.0.0.1` and is only accessible from the local
machine or through SSH tunnels. No authentication is performed.

- **Pros:** Zero complexity, zero latency overhead.
- **Cons:** No user differentiation, no audit trail, no remote access.
- **Use case:** Local development, single-user experiments.

### 2.2 Pattern B: Authentication Proxy (OAuth 2.1)

```
┌────────────┐  Bearer  ┌──────────┐           ┌──────────────┐
│   Client   │──token──>│  Proxy   │──────────>│  MCP Server  │
│   (Agent)  │          │  (RS)    │ (no auth) │  (localhost) │
└────────────┘          └────┬─────┘           └──────────────┘
                             │ JWKS
                        ┌────┴─────┐
                        │ Keycloak │
                        │  (AS)    │
                        └──────────┘
```

A reverse proxy validates OAuth 2.1 Bearer tokens before forwarding requests.
The MCP Server never sees or validates tokens. This implements the **Delegated
Authorization** pattern recommended by MongoDB.

- **Pros:** Standard OAuth 2.1 flow, centralized identity management, audit.
- **Cons:** All authenticated users have identical access, no role differentiation.
- **Use case:** Shared environments where all users need the same tool set.

### 2.3 Pattern C: Multiple MCP Instances per Role

```
                        ┌──────────┐     ┌──────────────────────┐
                   ┌───>│  Proxy A │────>│ MCP (readOnly=true)  │
┌────────────┐     │    └──────────┘     └──────────────────────┘
│   Client   │─────┤
│   (Agent)  │     │    ┌──────────┐     ┌──────────────────────┐
└────────────┘     └───>│  Proxy B │────>│ MCP (readOnly=false) │
                        └──────────┘     └──────────────────────┘
```

Different MCP Server instances run with different configurations (`readOnly`,
`disabledTools`, connection strings with different DB privileges). A router or
set of proxies directs each user to the appropriate instance based on their
role.

- **Pros:** Strong isolation, each instance has its own configuration and DB credentials.
- **Cons:** Operational complexity multiplied by the number of roles; resource waste;
configuration drift between instances; routing logic must be maintained.
- **Use case:** High-security environments where complete isolation between roles is required.

### 2.4 Pattern D: RBAC Gateway with Per-Request Overrides

```
┌────────────┐  Bearer  ┌──────────────┐           ┌──────────────┐
│   Client   │──token──>│ RBAC Gateway │──────────>│  MCP Server  │
│   (Agent)  │          │ :4040        │ (no auth) │  :8008       │
└────────────┘          └──────┬───────┘           └──────────────┘
                               │ JWKS + roles
                          ┌────┴─────┐
                          │ Keycloak │
                          │  (AS)    │
                          └──────────┘
```

A single MCP Server instance starts with the **most permissive base
configuration**. An MCP-aware gateway sits in front, validates tokens, resolves
roles, and enforces access control at two layers:

1. **Gateway layer:** Intercepts MCP JSON-RPC messages to filter `tools/list`
   responses and block unauthorized `tools/call` requests.
2. **MCP Server layer:** Injects per-request configuration overrides via HTTP
   headers (`x-mongodb-mcp-read-only`, `x-mongodb-mcp-disabled-tools`) that the
   MCP Server enforces natively. Overrides can only **restrict**, never widen
   access.

- **Pros:** Single MCP instance, minimal infrastructure, fine-grained RBAC,
defense-in-depth enforcement, configuration-driven (no code changes for new roles).
- **Cons:** Gateway adds latency for intercepted messages (tools/list, tools/call);
requires the MCP Server to support `allowRequestOverrides`.
- **Use case:** Production deployments with multiple user roles and compliance requirements.

---

## 3. Comparison Matrix

| Criterion                   | A: Network | B: Auth Proxy | C: Multi-Instance | D: RBAC Gateway |
|-----------------------------|:----------:|:-------------:|:-----------------:|:---------------:|
| Authentication              |     -      |      JWT      |       JWT         |      JWT        |
| Per-user authorization      |     -      |       -       |    Per-instance   |   Per-request   |
| Tool-level filtering        |     -      |       -       |    Per-instance   |   Per-request   |
| readOnly enforcement        |   Global   |    Global     |    Per-instance   |   Per-request   |
| Number of MCP instances     |     1      |       1       |    N (per role)   |       1         |
| Infrastructure complexity   |    Low     |    Medium     |      High         |     Medium      |
| Configuration-driven roles  |     -      |       -       |        -          |      Yes        |
| Defense in depth            |     -      |       -       |       Yes         |      Yes        |
| Latency overhead            |    None    |    Minimal    |     Minimal       |    Minimal*     |

\* Only `tools/list` (response interception) and denied `tools/call` (blocked)
add measurable latency. All other messages are transparently proxied.

---

## 4. The Implemented Solution: Pattern D — RBAC Gateway

### 4.1 Design Philosophy

The gateway follows a set of deliberate design constraints:

- **OOP with GRASP patterns:** Each class is an Information Expert for its
  domain; the controller orchestrates without absorbing domain logic.
- **SOLID principles:** Single Responsibility per class, Open/Closed via
  configuration, Dependency Inversion via constructor injection.
- **Separation of Concerns:** Authentication, authorization, MCP protocol
  awareness, and HTTP proxying are isolated in separate classes.
- **Dependency Injection:** The controller (`GatewayServer`) accepts optional
  pre-built instances for all collaborators. This enables testing, extension,
  and alternative implementations without modifying the controller.
- **Lazy Loading:** `RoleResolver` separates construction (synchronous, cheap)
  from data loading (asynchronous, I/O). The `load()` method can be overridden
  to fetch roles from a database or API instead of a file.
- **Configuration over code:** Adding or modifying roles requires editing a
  JSON file and restarting the gateway. No code changes needed.

### 4.2 Class Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GatewayServer                               │
│                        (Controller)                                 │
│                                                                     │
│  Orchestrates the request lifecycle:                                │
│  CORS → Auth → Role Resolution → MCP Interception → Proxy           │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  TokenVerifier   │  │ RoleResolver │  │    McpInterceptor      │ │
│  │                  │  │              │  │                        │ │
│  │ - JWKS fetch     │  │ - load()     │  │ - filterToolsList()    │ │
│  │ - JWT verify     │  │ - resolve()  │  │ - checkToolCall()      │ │
│  │ - scope check    │  │ - isAllowed()│  │ - buildAccessDenied()  │ │
│  │ - extractBearer()│  │ - roles      │  │                        │ │
│  └──────────────────┘  └──────────────┘  └────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                       ProxyHandler                           │   │
│  │                                                              │   │
│  │ - buildForwardHeaders()    → x-mongodb-mcp-* injection       │   │
│  │ - forward()                → transparent proxy               │   │
│  │ - forwardAndIntercept()    → buffered response interception  │   │
│  │ - sendError()              → JSON error responses            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.3 Two Enforcement Modes

The role configuration supports two mutually exclusive modes for tool access
control, each optimized for different use cases:

#### Allow Mode (Gateway-Enforced)

Roles define an explicit list of permitted tools. The gateway actively intercepts
MCP messages:

- **`tools/list`:** The gateway forwards the request to the MCP Server,
  receives the full tool list, and strips any tools not in the allow list before
  returning the response to the client. The client never sees unauthorized tools.
- **`tools/call`:** Before forwarding, the gateway checks if the requested tool
  is in the allow list. If not, it returns a JSON-RPC error (`-32001: Access
  denied`) without contacting the MCP Server.

```json
{
  "mcp-viewer": {
    "tools": {
      "allow": ["find", "count", "list-collections", "collection-schema", "collection-indexes"]
    }
  }
}
```

This mode provides **fine-grained, tool-level control** at the gateway layer.
The special value `["*"]` allows all tools (transparent proxy behavior).

#### Deny Mode (MCP Server-Enforced)

Roles define categories to disable. The gateway injects the categories as the
`x-mongodb-mcp-disabled-tools` HTTP header and proxies transparently:

```json
{
  "mcp-analyst": {
    "tools": {
      "deny": ["mongodb"],
      "readOnly": true
    }
  }
}
```

The MCP Server reads the header and natively filters tools by category. Valid
categories include `mongodb`, `atlas`, `create`, `update`, `delete`, and
individual tool names.

This mode leverages the MCP Server's **built-in category system**, avoiding
the need to maintain a mapping of tools to categories in the gateway.

#### Why Two Modes?

| Aspect                | Allow Mode            | Deny Mode                |
|-----------------------|-----------------------|--------------------------|
| Granularity           | Individual tools      | Categories               |
| Enforcement point     | Gateway               | MCP Server               |
| Configuration effort  | List every tool       | List categories to block |
| Maintenance           | Update on new tools   | Automatic for categories |
| Visibility            | Client sees only allowed | Client sees all minus denied |

Both modes can optionally set `readOnly: true`, which is forwarded as the
`x-mongodb-mcp-read-only` header. The MCP Server's override mechanism ensures
this can only **activate** read-only mode (`false` → `true`), never deactivate it.

### 4.4 Defense in Depth: The Override Mechanism

The MongoDB MCP Server supports per-request configuration overrides when started
with `MDB_MCP_ALLOW_REQUEST_OVERRIDES=true`. The gateway exploits this to
enforce RBAC at two independent layers:

```
                  Gateway Layer                    MCP Server Layer
                  ─────────────                    ────────────────
Allow mode:  ┌─ tools/list filtering ─────┐
             ├─ tools/call blocking ──────┤
             │                            │
Deny mode:   │  (transparent proxy)       ├─── x-mongodb-mcp-disabled-tools
             │                            │
Both modes:  │                            ├─── x-mongodb-mcp-read-only
             └────────────────────────────┘
```

The MCP Server's override rules guarantee safety:

| Config key       | Header                          | Override behavior                              |
|------------------|---------------------------------|------------------------------------------------|
| `readOnly`       | `x-mongodb-mcp-read-only`      | **One-way**: can only set `false` → `true`     |
| `disabledTools`  | `x-mongodb-mcp-disabled-tools`  | **Merge**: adds to base list, never removes    |

Even if the gateway is compromised or misconfigured, the MCP Server will never
grant more access than its base configuration allows. The overrides are
**additive restrictions only**.

### 4.5 Request Lifecycle

A complete request flows through the following stages:

```
1. Client → POST /mcp (Authorization: Bearer <JWT>)
           │
2. CORS    │  OPTIONS → 204 (preflight)
           │  All responses get CORS headers
           │
3. Auth    ├─ TokenVerifier.extractBearer() → raw token
           ├─ TokenVerifier.verify()        → JWT payload
           │    ├─ JWKS signature verification
           │    ├─ Issuer check (Keycloak realm URL)
           │    ├─ Audience check (mcp-server)
           │    └─ Scope check (mcp:access)
           │
4. RBAC    ├─ RoleResolver.resolve(realmRoles) → { role, tools }
           │    └─ Precedence-ordered role matching
           │
5. MCP     ├─ [Allow + tools/call] → McpInterceptor.checkToolCall()
Intercept  │    └─ Denied? → JSON-RPC error -32001 (no upstream contact)
           │
6. Headers ├─ ProxyHandler.buildForwardHeaders()
           │    ├─ Strip: Authorization, Host
           │    ├─ Inject: x-authenticated-user, x-authenticated-username, x-authenticated-role
           │    ├─ Inject: x-mongodb-mcp-read-only (if readOnly)
           │    └─ Inject: x-mongodb-mcp-disabled-tools (if deny mode)
           │
7. Proxy   ├─ [Allow + tools/list] → forwardAndIntercept()
           │    └─ McpInterceptor.filterToolsList() → filtered response
           │
           └─ [Everything else] → forward() → transparent pipe
```

### 4.6 Role Configuration Schema

Roles are defined in a single JSON file (`cfg/roles.json`):

```json
{
  "roles": {
    "mcp-admin": {
      "description": "Full access to all MCP tools",
      "tools": { "allow": ["*"], "readOnly": false }
    },
    "mcp-analyst": {
      "description": "Read, query, analysis, and export access",
      "tools": {
        "allow": ["find", "count", "aggregate", "explain", "list-databases",
                  "list-collections", "collection-schema", "collection-indexes",
                  "collection-storage-size", "db-stats", "export", "mongodb-logs",
                  "search-knowledge", "list-knowledge-sources"],
        "readOnly": true
      }
    },
    "mcp-demo": {
      "description": "All except mongodb category",
      "tools": { "deny": ["mongodb"], "readOnly": true }
    },
    "mcp-viewer": {
      "description": "Basic read-only browsing",
      "tools": {
        "allow": ["find", "count", "list-collections", "collection-schema",
                  "collection-indexes"]
      }
    },
    "mcp-guest": {
      "description": "All except atlas category",
      "tools": { "deny": ["atlas"], "readOnly": true }
    }
  },
  "defaultRole": null,
  "rolePrecedence": ["mcp-admin", "mcp-analyst", "mcp-viewer"]
}
```

Key design decisions:

- **`allow` and `deny` are mutually exclusive:** A role uses one or the other.
  `allow` means "only these tools"; `deny` means "everything except these
  categories".
- **`readOnly` is optional:** When omitted, defaults to `false` (read-write).
  When set to `true`, the MCP Server disables all create/update/delete operations.
- **`rolePrecedence`:** When a user has multiple realm roles, the first match
  in this ordered list wins.
- **`defaultRole`:** Fallback when no role matches. Set to `null` for
  deny-by-default (recommended).

---

## 5. Authentication: OAuth 2.1 with Keycloak

The gateway implements the **Resource Server** role in the OAuth 2.1 framework:

```
┌──────────┐    1. Auth request     ┌──────────┐
│  Client  │───────────────────────>│ Keycloak │
│  (Agent) │<───────────────────────│  (AS)    │
│          │    2. Access token     └──────────┘
│          │
│          │    3. MCP request       ┌──────────┐          ┌───────────┐
│          │    + Bearer token ─────>│ Gateway  │─────────>│ MCP Server│
│          │<────────────────────────│  (RS)    │<─────────│           │
└──────────┘    4. MCP response      └────┬─────┘          └───────────┘
                                          │
                                     JWKS │ (public keys)
                                          │
                                     ┌────┴─────┐
                                     │ Keycloak │
                                     └──────────┘
```

Token verification is performed entirely offline using JWKS (JSON Web Key Set):

- **No token introspection calls:** The gateway fetches Keycloak's public keys
  once and caches them. Token verification is a local cryptographic operation.
- **Three-claim validation:** Issuer (`iss`), audience (`aud: mcp-server`),
  and scope (`mcp:access`) are all verified.
- **Role extraction:** The standard Keycloak claim `realm_access.roles` is
  used to resolve the user's RBAC role.

The gateway also serves **OAuth Protected Resource Metadata** (RFC 9728) at
`/.well-known/oauth-protected-resource`, enabling clients that support
auto-discovery to find the authorization server automatically.

---

## 6. Security Properties

The architecture provides the following security guarantees:

| Property                     | Mechanism                                              |
|------------------------------|--------------------------------------------------------|
| **No token leakage**         | Gateway strips `Authorization` header before proxying  |
| **No shared secrets**        | JWKS verification uses public keys fetched from Keycloak |
| **Deny by default**          | Users without a recognized role receive zero tools      |
| **Tool-level enforcement**   | Both listing (`tools/list`) and execution (`tools/call`) are gated |
| **Category-level enforcement** | MCP Server natively enforces `disabledTools` categories |
| **Read-only enforcement**    | One-way override: can only activate, never deactivate   |
| **Additive restrictions**    | Per-request overrides can only make things stricter      |
| **Audit trail**              | Every request logs user, role, method, and authorization decision |
| **Separation of credentials** | MCP Server holds DB credentials; Gateway holds IdP config; neither has both |

---

## 7. Advantages

1. **Single MCP instance:** No need to run N instances for N roles. One server
   with the most permissive base, narrowed per-request.

2. **Configuration-driven:** New roles are added by editing a JSON file and
   restarting the gateway. No code changes required.

3. **Defense in depth:** Two independent enforcement layers. Even if one fails,
   the other limits damage.

4. **Standard protocols:** OAuth 2.1, JWT, JWKS, JSON-RPC, HTTP. No
   proprietary mechanisms.

5. **Minimal latency:** Only `tools/list` (response filtering) and denied
   `tools/call` (early rejection) add processing. Everything else is a
   transparent pipe.

6. **MCP Server compatibility:** Uses the MCP Server's documented
   `allowRequestOverrides` mechanism. No patches, no forks, no undocumented
   behavior.

7. **Extensible:** Dependency Injection makes it straightforward to swap
   components: different IdP (replace `TokenVerifier`), different role source
   (extend `RoleResolver`), different upstream (configure `ProxyHandler`).

---

## 8. Limitations and Trade-offs

1. **No per-tool deny at gateway level:** Deny mode delegates to MCP Server
   categories. If you need to deny a specific tool (not a whole category), use
   allow mode instead.

2. **Static role assignment:** Roles are resolved from JWT claims at request
   time. Changing a user's role requires re-issuing the token (or waiting for
   expiration).

3. **No session affinity:** The gateway is stateless. It does not track MCP
   sessions. If the MCP Server requires session continuity (e.g., SSE
   transport), the gateway must forward `Mcp-Session-Id` headers faithfully
   (which it does).

4. **Single upstream:** The current implementation proxies to one MCP Server.
   Multi-upstream routing (Pattern C hybrid) would require extending
   `ProxyHandler`.

5. **Restart required:** Role configuration changes require a gateway restart.
   Hot-reloading could be added by overriding `RoleResolver.load()` with a
   file-watcher or polling mechanism.

---

## 9. Possible Improvements

### 9.1 Short-term

- **Hot-reload roles:** Watch `cfg/roles.json` for changes and reload without
  restart, using `fs.watch()` or a polling interval.
- **Rate limiting:** Add per-user or per-role rate limits to prevent abuse.
- **Metrics endpoint:** Expose Prometheus-compatible metrics (requests per role,
  denied calls, latency histograms).

### 9.2 Medium-term

- **Role source from database:** Override `RoleResolver.load()` to fetch roles
  from MongoDB or another data store, enabling dynamic role management through
  an admin UI.
- **Hybrid allow+deny:** Support roles that combine allow-list filtering at the
  gateway with category-level deny at the MCP Server for maximum flexibility.
- **Multi-upstream routing:** Route different roles to different MCP Server
  instances (combining Patterns C and D) for environments that need DB-level
  credential isolation.
- **WebSocket/SSE transport:** Extend `ProxyHandler` to support persistent
  connections for real-time MCP interactions.

### 9.3 Long-term

- **Policy engine integration:** Replace the JSON file with an OPA (Open
  Policy Agent) or Cedar policy engine for complex, attribute-based access
  control (ABAC).
- **MCP specification alignment:** As the MCP specification matures and
  potentially adds native RBAC primitives, adapt the gateway to leverage them
  while maintaining backward compatibility.
- **Audit log integration:** Stream authorization decisions to a centralized
  audit system (ELK, Splunk, MongoDB time-series).

---

## 10. Conclusion

The MongoDB MCP Server is a powerful tool for connecting AI agents to databases,
but its lack of built-in inbound authentication creates a significant security
gap when deployed as a remote HTTP service. The RBAC Gateway pattern presented
here closes that gap with minimal infrastructure overhead:

- **One MCP Server instance** serves all roles
- **One gateway** enforces authentication, authorization, and audit
- **One JSON file** defines the entire role model
- **Two enforcement layers** provide defense in depth

The key insight is leveraging the MCP Server's native `allowRequestOverrides`
mechanism to push restrictions per-request via HTTP headers. This avoids the
operational complexity of running multiple MCP instances while maintaining strong
security boundaries between roles.

For organizations deploying MongoDB MCP Servers in shared or production
environments, this architecture provides a practical, standards-based path from
"open endpoint" to "enterprise-ready RBAC" without modifying the MCP Server
itself.

---

## References

1. [MongoDB MCP Server: Overview](https://www.mongodb.com/docs/mcp-server/overview/)
2. [MongoDB MCP Server: Configuration Options](https://www.mongodb.com/docs/mcp-server/configuration/options/)
3. [MongoDB MCP Server: Security Best Practices](https://www.mongodb.com/docs/mcp-server/security-best-practices/)
4. [MongoDB MCP Server: Standalone Service (HTTP)](https://www.mongodb.com/docs/mcp-server/configuration/standalone-service/)
5. [MongoDB MCP Server: Enable or Disable Features](https://www.mongodb.com/docs/mcp-server/configuration/enable-or-disable-features/)
6. [MCP Specification: Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
7. [MCP Authorization Tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
8. [OAuth 2.1 Draft (IETF)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
9. [RFC 9728: OAuth Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
