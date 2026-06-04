import axios from "axios";
import { CONFIG } from "./config";
import { TOOLS } from "./tools";
import { TOOL_DISPATCH } from "./tools";
import type { Message, ToolCall } from "./types";
import { c_tool, c_info } from "./colors";

/** Truncates a string and replaces newlines with spaces. */
const truncate = (str: string, max: number): string => {
  let s = String(str).replace(/\n/g, " ");
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
};

/** Helper for displaying function arguments neatly. */
const argsPreview = (args: any): string => {
  if (!args || (typeof args === "object" && Object.keys(args).length === 0)) {
    return "";
  }

  const pairs: string[] = [];
  // Sort keys alphabetically, mimicking Perl behavior
  Object.keys(args)
    .sort()
    .forEach((k) => {
      let v = String(args[k]);
      pairs.push(`${k}=${truncate(v, 40)}`);
    });
  return pairs.join(", ");
};

// =============================================================================
// LLM Client (HTTP Communication)
// =============================================================================

/** HTTP client instance configured with timeouts. */
const axiosInstance = axios.create({
  baseURL: CONFIG.lm_studio_base_url,
  timeout: CONFIG.http_timeout * 10000, // Axios uses milliseconds
});

/** Calls the LLM endpoint and returns parsed data. */
async function callLLM(messages: Message[]): Promise<any> {
  const payload = {
    model: CONFIG.model,
    messages: messages,
    tools: TOOLS, // Send all available tools
    tool_choice: "auto",
    max_tokens: CONFIG.max_tokens,
    temperature: CONFIG.temperature,
    stream: false, // Use synchronous call structure
  };

  try {
    // console.log("payload | ", payload);
    const response = await axiosInstance.post("/chat/completions", payload, {
      headers: { "Content-Type": "application/json" },
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status || "N/A";
      const message = error.response?.data?.message;
      throw new Error(`LM Studio HTTP ${status}: ${message}`);
    }
    console.error("Unknown API error:", error);
    throw new Error("Could not connect to LM Studio.");
  }
}

/** Parses the JSON arguments string from a model tool call. */
function parseToolCallArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Executes all tool calls found in the model response and updates history. */
async function processToolCalls(messages: Message[], toolCalls: ToolCall[]): Promise<void> {
  for (const tc of toolCalls) {
    const fnName = tc.function.name;
    const tcId = tc.id;
    const args = parseToolCallArgs(tc.function.arguments);

    console.log(`${c_tool("  [tool] ")}${fnName}(\`${argsPreview(args)}\`)`);

    let result: string;
    const handler = TOOL_DISPATCH[fnName];
    if (handler) {
      try {
        result = await handler(args);
      } catch (e) {
        result = `ERROR: Runtime exception during tool execution: ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    } else {
      result = `ERROR: Unknown tool '${fnName}'`;
    }

    console.log(`${c_tool("  [tool] ")}→ ${c_info(truncate(result, 120))}`);

    messages.push({
      role: "tool",
      tool_call_id: tcId,
      content: result,
    });
  }
}

export { callLLM, processToolCalls };
