import { mkdir } from "fs/promises";
import * as path from "path";
import { CONFIG } from "../shared/config";
import { callLLM, processToolCalls } from "../shared/lm-client";
import { TOOL_DISPATCH } from "../shared/tools";
import type { Message, ToolCall } from "../shared/types";

const PORT = Number(process.env.PORT) || 3000;
const WEB_DIR = path.dirname(Bun.fileURLToPath(import.meta.url));
const CLIENT_ENTRY = path.join(WEB_DIR, "client", "index.tsx");
const INDEX_HTML = path.join(WEB_DIR, "index.html");
const WIKI_DIR = path.join(process.cwd(), "wiki");

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

/** Ensures the wiki directory exists, creating it on first startup if needed. */
async function ensureWikiDir(): Promise<void> {
  await mkdir(WIKI_DIR, { recursive: true });
}

await ensureWikiDir();

let clientJs = await bundleClient();

/** System prompt for the web chat assistant. */
const SYSTEM_PROMPT =
  "You are nanomind, a helpful and concise assistant. Answer the user's questions " +
  "directly. You may use the available tools to read or update your persistent " +
  "memory and to inspect the workspace when it helps you respond.";

/**
 * Runs the agentic tool-call loop until the model produces a final answer,
 * mirroring the CLI chat behaviour. Returns the assistant's reply text.
 */
async function runConversation(messages: Message[]): Promise<string> {
  let rounds = 0;
  while (rounds < CONFIG.max_tool_rounds) {
    rounds++;
    const resp = await callLLM(messages);
    const choice = resp.choices?.[0];
    if (!choice?.message) break;

    const msg = choice.message;
    const toolCalls: ToolCall[] = msg.tool_calls || [];

    if (toolCalls.length > 0) {
      messages.push(msg);
      await processToolCalls(messages, toolCalls);
    } else {
      const finalAnswer = msg.content || "";
      messages.push({ role: "assistant", content: finalAnswer });
      return finalAnswer;
    }
  }
  return "(The assistant reached the tool-call limit without a final answer.)";
}

/** Handles POST /api/chat: accepts a message history, returns the reply. */
async function handleChat(req: Request): Promise<Response> {
  let body: { messages?: Message[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const history: Message[] = incoming.filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );

  if (history.length === 0) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

  try {
    const reply = await runConversation(messages);
    return Response.json({ reply });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[/api/chat] error:", message);
    return Response.json({ error: message }, { status: 502 });
  }
}

/**
 * Resolves a wiki-relative request path to an absolute path, guarding against
 * traversal outside the wiki directory. Returns null if the path escapes.
 */
function resolveWikiPath(requested: string): string | null {
  const resolved = path.resolve(WIKI_DIR, requested);
  const rel = path.relative(WIKI_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Handles GET /api/file?path=...: returns the contents of a single file. */
async function handleFile(url: URL): Promise<Response> {
  const requested = url.searchParams.get("path");
  if (!requested) {
    return Response.json({ error: "Missing 'path' query parameter." }, { status: 400 });
  }

  const resolved = resolveWikiPath(requested);
  if (!resolved) {
    return Response.json({ error: "Path is outside the wiki directory." }, { status: 403 });
  }

  try {
    const file = Bun.file(resolved);
    if (!(await file.exists())) {
      return Response.json({ error: "File not found." }, { status: 404 });
    }
    const content = await file.text();
    return Response.json({ path: requested, content });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[/api/file] error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** Handles PUT /api/file: writes new content to a wiki file. */
async function handleSaveFile(req: Request): Promise<Response> {
  let body: { path?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requested = body.path;
  if (!requested || typeof requested !== "string") {
    return Response.json({ error: "Missing 'path'." }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return Response.json({ error: "Missing 'content'." }, { status: 400 });
  }

  const resolved = resolveWikiPath(requested);
  if (!resolved) {
    return Response.json({ error: "Path is outside the wiki directory." }, { status: 403 });
  }

  try {
    const file = Bun.file(resolved);
    if (!(await file.exists())) {
      return Response.json({ error: "File not found." }, { status: 404 });
    }
    await Bun.write(resolved, body.content);
    return Response.json({ path: requested, saved: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[/api/file PUT] error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** Handles GET /api/files: returns the workspace file list. */
async function handleFiles(): Promise<Response> {
  try {
    const raw = await TOOL_DISPATCH.ls!({});
    const files = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("("));
    return Response.json({ files });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[/api/files] error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/chat" && req.method === "POST") {
      return handleChat(req);
    }

    if (url.pathname === "/api/files" && req.method === "GET") {
      return handleFiles();
    }

    if (url.pathname === "/api/file" && req.method === "GET") {
      return handleFile(url);
    }

    if (url.pathname === "/api/file" && req.method === "PUT") {
      return handleSaveFile(req);
    }

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
