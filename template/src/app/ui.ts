import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

const app = new App({
  name: "mcp-app",
  onHostContext(ctx: McpUiHostContext) {
    applyDocumentTheme(ctx.theme ?? "light");
    applyHostFonts(ctx);
    applyHostStyleVariables(ctx);
  },
});

const root = document.getElementById("app")!;
root.innerHTML = `
  <div style="padding: 1rem; font-family: var(--host-font-family, system-ui, sans-serif);">
    <h1 style="margin: 0 0 0.5rem;">MCP App</h1>
    <p style="color: var(--host-text-secondary, #666);">
      Edit <code>src/app/ui.ts</code> to build your MCP App UI.
    </p>
  </div>
`;

app.ready();
