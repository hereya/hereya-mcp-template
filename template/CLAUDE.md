# mcp-server

MCP (Model Context Protocol) server deployed as an AWS Lambda behind API Gateway HTTP API v2 with OAuth2 authentication via hereya.

## Deployment

To deploy to the staging workspace:

`npm install`

Commit everything and push. nothing should be unstaged or unpushed or uncommitted.

```bash
npm run build
hereya deploy -w {{deployWorkspace}}
```

This builds the project and runs `hereya deploy` targeting the `{{deployWorkspace}}` workspace.

After each successful deployment, tell the user to add the MCP server as a connector in Claude Desktop using the URL `https://<customDomain>/mcp` (use the actual `customDomain` value from `hereyaconfig/hereyavars/aws--mcp-lambda.yaml`) and then connect (oauth through hereya account). The user is probably not technical, so no technical mumbo jumbo. If this is an update to an existing deployment, tell them to disconnect and reconnect the connector.


## Quick commands

```bash
npm run build        # Bundle handler with esbuild
npm run typecheck    # TypeScript type checking (no emit)
npm run inspect      # Launch MCP Inspector
```

## Architecture

### Request flow

```
Client → API Gateway → Lambda Authorizer (JWT/RS256) → Lambda Handler → MCP SDK → Tool
                            ↓ (reject)
                     401 Unauthorized
```

The handler is **auth-agnostic** — it never checks authentication. The Lambda authorizer handles all auth; only authenticated requests reach the handler. The handler extracts `userId`, `orgId`, `orgRole` from the authorizer context and passes them as `authInfo` to MCP tools.

## Source files

```
src/
├── handler.ts       # Lambda entry point — creates MCP server + transport, extracts authInfo
├── server.ts        # MCP server factory — creates McpServer, registers tools and prompts
├── secrets.ts       # Resolves SECRET_KEYS env vars from AWS Secrets Manager
├── dev-server.ts    # Local dev server with OAuth gateway simulation
└── tools/
    └── index.ts     # Tool registration hub — add your tools here
└── prompts/
    └── index.ts     # Prompt registration hub — add your prompts here
```

## Adding a new tool

1. Create `src/tools/my-tool.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMyTool(server: McpServer) {
  server.registerTool(
    "my-tool",
    {
      title: "My Tool",
      description: "What this tool does",
      inputSchema: {
        param: z.string().describe("Parameter description"),
      },
    },
    async ({ param }, { authInfo }) => {
      const userId =
        (authInfo?.extra as Record<string, unknown>)?.userId ?? "anonymous";
      return {
        content: [{ type: "text", text: `Result: ${param}` }],
      };
    },
  );
}
```

2. Register in `src/tools/index.ts`:

```typescript
import { registerMyTool } from "./my-tool.js";
// ... in registerTools():
registerMyTool(server);
```

## Auth context in tools

Tools receive auth info via the second parameter's `authInfo.extra`:

```typescript
async ({ input }, { authInfo }) => {
  const extra = authInfo?.extra as Record<string, unknown>;
  const userId = extra?.userId; // User's ID
  const orgId = extra?.orgId; // Organization ID
  const orgRole = extra?.orgRole; // Role in org (e.g., "OWNER")
};
```

## Build

esbuild bundles `src/handler.ts` into a single CommonJS file at `dist/handler.js` targeting Node 22. All dependencies (including AWS SDK) are bundled — no Lambda layers needed.

## Infrastructure

Uses [hereya](https://hereya.dev) with the `aws/mcp-lambda` infrastructure package. Config in `hereya.yaml`.

**Infrastructure (aws/mcp-lambda) manages:**

- Lambda function (handler) + Lambda authorizer (JWT/RS256)
- API Gateway HTTP API v2 with routes: `POST /mcp` (auth required), `GET /.well-known/oauth-protected-resource` (public)
- Custom domain via Route53 + ACM
- Secrets Manager integration

**Deployment config:**

- `hereyaconfig/hereyavars/aws--mcp-lambda.yaml` — staging-specific settings (domain, OAuth URL, org ID)

## Environment variables

| Variable           | Description                                                   | Where set                 |
| ------------------ | ------------------------------------------------------------- | ------------------------- |
| `OAUTH_SERVER_URL` | OAuth server base URL                                         | hereya env / hereyaconfig |
| `BOUND_ORG_ID`     | Organization ID for access control                            | hereya env / hereyaconfig |
| `SECRET_KEYS`      | Comma-separated env var names to resolve from Secrets Manager | hereya env                |

## Key technical details

- MCP transport: `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true` (no SSE)
- Lambda creates a new MCP server + transport per request (stateless)
- API Gateway HTTP API v2 cannot customize the 401 response from the authorizer (no custom headers/body). MCP clients discover OAuth via well-known URLs as fallback.
