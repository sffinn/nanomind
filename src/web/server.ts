import * as path from "path";
import { CONFIG } from "../shared/config";
import { callLLM, processToolCalls } from "../shared/lm-client";
import { TOOL_DISPATCH } from "../shared/tools";
import type { Message, ToolCall } from "../shared/types";

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
