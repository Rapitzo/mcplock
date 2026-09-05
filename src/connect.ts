import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ServerSpec } from "./config.ts";
import type { ToolRecord } from "./hash.ts";

export interface ServerInfo {
  name: string;
  version: string;
}

export interface FetchResult {
  tools: ToolRecord[];
  serverInfo?: ServerInfo;
}

function buildTransport(spec: ServerSpec, verbose: boolean) {
  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error(`server "${spec.name}": stdio transport without command`);
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
      cwd: spec.cwd,
      stderr: verbose ? "inherit" : "ignore",
    });
  }
  if (!spec.url) throw new Error(`server "${spec.name}": ${spec.transport} transport without url`);
  const url = new URL(spec.url);
  const init = spec.headers ? { requestInit: { headers: spec.headers } } : undefined;
  return spec.transport === "sse" ? new SSEClientTransport(url, init) : new StreamableHTTPClientTransport(url, init);
}

/** Connect, list every tool (following pagination), disconnect. Throws on timeout or transport failure. */
export async function fetchTools(spec: ServerSpec, timeoutMs = 20_000, verbose = false): Promise<FetchResult> {
  const client = new Client({ name: "mcplock", version: "0.1.0" }, { capabilities: {} });
  const transport = buildTransport(spec, verbose);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`server "${spec.name}": timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const work = (async () => {
      await client.connect(transport);
      const tools: ToolRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema,
            outputSchema: (t as { outputSchema?: unknown }).outputSchema,
            annotations: t.annotations,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      const version = client.getServerVersion();
      const serverInfo = version ? { name: version.name, version: version.version } : undefined;
      return { tools, serverInfo };
    })();
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
