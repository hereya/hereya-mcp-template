import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerTools(server: McpServer) {
  // TODO: Register your tools here
  // Example:
  // import { registerMyTool } from "./my-tool.js";
  // registerMyTool(server);

  // MCP App UI resource
  const appHtmlPath = path.join(__dirname, "app.html");
  server.resource("app-ui", "ui://app/app.html", {
    description: "MCP App UI",
    mimeType: "text/html",
  }, async () => {
    const html = fs.readFileSync(appHtmlPath, "utf-8");
    return { contents: [{ uri: "ui://app/app.html", mimeType: "text/html", text: html }] };
  });
}
