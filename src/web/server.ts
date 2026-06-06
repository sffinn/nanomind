import * as path from "path";

const PORT = Number(process.env.PORT) || 3000;
const WEB_DIR = path.dirname(Bun.fileURLToPath(import.meta.url));
const CLIENT_ENTRY = path.join(WEB_DIR, "client", "index.tsx");
const INDEX_HTML = path.join(WEB_DIR, "index.html");

/**
 * Bundles the React client into a single browser-ready JS module.
 *
 * We bundle in-memory at startup (rather than shipping a build step) so that
 * `bun run web` is a single command with no artifacts left on disk.
 */
async function bundleClient(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [CLIENT_ENTRY],
    target: "browser",
    minify: false,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new AggregateError(result.logs, "Client bundle failed");
  }

  return await result.outputs[0]!.text();
}

let clientJs = await bundleClient();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/index.js") {
      return new Response(clientJs, {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(INDEX_HTML));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`nanomind web running at http://localhost:${server.port}`);
