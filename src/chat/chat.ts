import * as fs from "fs/promises";
import * as path from "path";
import axios, { AxiosInstance } from "axios";

// =============================================================================
// Configuration and Type Definitions
// =============================================================================

/** Represents a function definition sent to the LLM. */
type ToolFunctionDefinition = {
  name: string;
  description: string;
  parameters: any; // Using 'any' for schema simplicity
};

/** Represents the structure of an LLM tool call request body. */
type FunctionCall = {
  function: {
    name: string;
    description: string;
    parameters: any;
  };
};

/*
{
    type     => 'function',
    function => {
        name        => 'read_memory',
        description => 'Read the entire contents of the memory.md file. '
                     . 'Use this to recall facts, previous decisions, '
                     . 'user preferences, and conversation context.',
        parameters  => {
            type       => 'object',
            properties => {},
            required   => [],
        },
    },
},
{
    type     => 'function',
    function => {
        name        => 'write_memory',
        description => 'Overwrite memory.md with new content. '
                     . 'Use this to completely replace the memory store, '
                     . 'e.g. after a major reorganisation or summarisation.',
        parameters  => {
            type       => 'object',
            properties => {
                content => {
                    type        => 'string',
                    description => 'The full Markdown content to write to memory.md.',
                },
            },
            required => ['content'],
        },
    },
},

*/

type ToolParameters = {
  type: string;
};

type ToolFunction = {
  name: string;
  description: string;
  parameters: ToolParameters;
};

type ToolCall = {
  type: string;
  function: ToolFunction;
};

/** Represents a message in the conversation history. */
type MessageRole = "user" | "assistant" | "system" | "tool";

interface Message {
  role: MessageRole;
  content?: string;
  // For tool calls specifically
  tool_call_id?: string;
}

/** Defines the entire chat application configuration. */
const CONFIG = {
  lm_studio_base_url: process.env.LM_STUDIO_URL || "http://localhost:1234/v1",
  model: process.env.LM_STUDIO_MODEL || "local-model",
  memory_file: process.env.MEMORY_FILE || "memory.md",
  max_tokens: 4096,
  temperature: 0.7,
  http_timeout: 120,
  max_tool_rounds: 10, // safety ceiling for tool-call loops
};

// Resolve memory file to an absolute path
CONFIG.memory_file = path.resolve(CONFIG.memory_file);

// =============================================================================
// Helper Functions and Utilities
// =============================================================================

/** ANSI Colour helpers (mimicking perl's Term::ANSIColor) */
const Colors = {
  reset: "" as const,
  boldCyan: (text: string) => `\x1b[1;36m${text}\x1b[0m`,
  boldGreen: (text: string) => `\x1b[1;32m${text}\x1b[0m`,
  boldYellow: (text: string) => `\x1b[1;33m${text}\x1b[0m`,
  boldRed: (text: string) => `\x1b[1;31m${text}\x1b[0m`,
  brightBlack: (text: string) => `\x1b[90m${text}\x1b[0m`,
  boldWhite: (text: string) => `\x1b[1;37m${text}\x1b[0m`,
};

const c_user = (text: string) => Colors.boldCyan(text);
const c_ai = (text: string) => Colors.boldGreen(text);
const c_tool = (text: string) => Colors.boldYellow(text);
const c_error = (text: string) => Colors.boldRed(text);
const c_info = (text: string) => Colors.brightBlack(text);
const c_header = (text: string) => Colors.boldWhite(text);

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
// Tool Definitions (API Schema)
// =============================================================================

const TOOLS: { name: string; functionDef: FunctionCallDefinition }[] = [
  {
    name: "read_memory",
    functionDef: {
      type: "function",
      function: {
        name: "read_memory",
        description:
          "Read the entire contents of memory.md. Use this to recall facts, previous decisions, user preferences, and conversation context.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
  },
  {
    name: "write_memory",
    functionDef: {
      type: "function",
      function: {
        name: "write_memory",
        description:
          "Overwrite memory.md with new content. Use this to completely replace the memory store, e.g., after a major reorganisation or summarisation.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "The full Markdown content to write to memory.md." },
          },
          required: ["content"],
        },
      },
    },
  },
  {
    name: "append_memory",
    functionDef: {
      type: "function",
      function: {
        name: "append_memory",
        description:
          "Append new information to the end of memory.md without erasing what is already there. Prefer this over write_memory when you only need to add a small piece of new information.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "The Markdown text to append to memory.md." },
          },
          required: ["content"],
        },
      },
    },
  },
  {
    name: "clear_memory",
    functionDef: {
      type: "function",
      function: {
        name: "clear_memory",
        description:
          "Wipe memory.md completely and replace it with a minimal header. Use this when the stored context is no longer relevant and a fresh start is needed.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
  },
];

// =============================================================================
// Tool Implementations (File I/O)
// =============================================================================

/** Initializes the memory file if it doesn't exist. */
const initMemoryFile = async (path: string): Promise<void> => {
  try {
    await fs.access(path); // Check if file exists
    return;
  } catch (e) {
    // File does not exist, create it
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const content = `# Memory\n\n_Initialised: ${ts}\n`;
    await fs.writeFile(path, content, "utf8");
  }
};

/** Tool handler for reading memory. */
async function toolReadMemory(): Promise<string> {
  try {
    await initMemoryFile(CONFIG.memory_file);
    const content = await fs.readFile(CONFIG.memory_file, "utf8");
    return content || "(memory.md is empty)";
  } catch (error) {
    console.error(`[Tool Error] Failed to read memory:`, error);
    return "ERROR: Cannot read memory file.";
  }
}

/** Tool handler for writing/overwriting memory. */
async function toolWriteMemory(args: { content: string }): Promise<string> {
  const content = args?.content ?? "";
  try {
    await fs.writeFile(CONFIG.memory_file, content, "utf8");
    return `memory.md written successfully (${String(content).length} chars).`;
  } catch (error) {
    console.error(`[Tool Error] Failed to write memory:`, error);
    return "ERROR: Cannot write to memory file.";
  }
}

/** Tool handler for appending memory. */
async function toolAppendMemory(args: { content: string }): Promise<string> {
  const content = args?.content ?? "";
  try {
    await initMemoryFile(CONFIG.memory_file);
    // Append newline separator and then the content
    await fs.appendFile(CONFIG.memory_file, `\n${content}`, "utf8");
    return `Appended to memory.md (${String(content).length} chars added).`;
  } catch (error) {
    console.error(`[Tool Error] Failed to append memory:`, error);
    return "ERROR: Cannot append to memory file.";
  }
}

/** Tool handler for clearing memory. */
async function toolClearMemory(): Promise<string> {
  await initMemoryFile(CONFIG.memory_file); // Ensure initial structure exists
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const initialContent = `# Memory\n\n_Cleared and Re-initialised: ${ts}\n`;
  await fs.writeFile(CONFIG.memory_file, initialContent, "utf8");
  return "memory.md has been cleared.";
}

/** Map tool names to their corresponding async handler functions. */
const TOOL_DISPATCH = {
  read_memory: toolReadMemory,
  write_memory: toolWriteMemory,
  append_memory: toolAppendMemory,
  clear_memory: toolClearMemory,
};

// =============================================================================
// LLM Client (HTTP Communication)
// =============================================================================

/** HTTP client instance configured with timeouts. */
const axiosInstance = axios.create({
  baseURL: CONFIG.lm_studio_base_url,
  timeout: CONFIG.http_timeout * 1000, // Axios uses milliseconds
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
    console.log("payload | ", payload);
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

/** Executes all tool calls found in the model response and updates history. */
async function processToolCalls(messages: Message[], toolCalls: FunctionCall[]): Promise<void> {
  for (const tc of toolCalls) {
    const fnName = tc.function.name;
    const tcId = tc.id;

    // 1. Parse arguments JSON string
    let args: any = {};
    try {
      if (tc.function.arguments) {
        args = JSON.parse(tc.function.arguments);
      }
    } catch (e) {
      console.error(`Failed to parse tool arguments for ${fnName}:`, e);
    }

    console.log(`${c_tool("  [tool] ")}${fnName}(\`${argsPreview(args)}\`)`);

    let result: string;
    const handler = TOOL_DISPATCH[fnName];
    if (handler) {
      // 2. Execute tool and handle potential errors
      try {
        result = await handler(args); // Tool handlers are now async
      } catch (e) {
        result = `ERROR: Runtime exception during tool execution: ${e instanceof Error ? e.message : "Unknown error"}`;
      }
    } else {
      result = `ERROR: Unknown tool '${fnName}'`;
    }

    console.log(`${c_tool("  [tool] ")}→ ${c_info(truncate(result, 120))}`);

    // 3. Feed result back into the conversation history
    messages.push({
      role: "tool",
      tool_call_id: tcId,
      content: result,
    });
  }
}

// =============================================================================
// System Prompt Generation
// =============================================================================

/** Generates the system prompt based on current configuration. */
const buildSystemPrompt = (): string => {
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const file = CONFIG.memory_file;

  return `You are a helpful, knowledgeable assistant with access to a persistent memory system stored in a Markdown file called memory.md.

Current date/time : ${ts}
Memory file path  : ${file}

## Memory guidelines

- **At the start of every conversation**, call read_memory to load any stored context before answering the user.
- **After learning something worth remembering** (a user preference, a key fact, a decision, a task status), call append_memory to record it.
- **When the memory file grows stale or disorganised**, call write_memory to replace it with a clean, summarised version.
- **Only call clear_memory** when the user explicitly asks to reset their memory, or when you determine the stored context is entirely irrelevant.
- Keep memory entries concise, structured, and in Markdown.
- Always acknowledge to the user when you have read or updated their memory.

You should proactively manage memory to give the user a sense of continuity across sessions without being asked. Be transparent about what you store.`;
};

// =============================================================================
// Main Chat Loop (Async)
// =============================================================================

/** Processes the initial tool calls and fetches the final answer after setup. */
async function processInitialMemory(messages: Message[]): Promise<string | null> {
  console.log("\n[System] Attempting to load persistent memory...");
  console.log(messages);
  try {
    const initResp = await callLLM(messages);

    if (initResp.choices?.[0]?.message?.tool_calls) {
      const toolCalls: FunctionCall[] = initResp.choices[0].message.tool_calls;
      await processToolCalls(messages, toolCalls);

      // Second call to get the final answer after memory has been processed
      const followResp = await callLLM(messages);

      if (followResp.choices?.[0]?.message?.content) {
        const finalText = followResp.choices[0].message.content;
        messages.push({ role: "assistant", content: finalText });
        return `\n${c_ai("[Memory loaded] ")}${c_info(finalText)}\n`;
      }
    }
  } catch (e) {
    console.error(
      c_error(
        `Could not reach LM Studio for initialization: ${e instanceof Error ? e.message : "Unknown error"}`,
      ),
    );
    console.log(`${c_info("(Make sure LM Studio is running on ${CONFIG.lm_studio_base_url})")}`);
  }
  return null;
}

/** Main async chat loop using Node.js readline interface. */
async function runChat() {
  // Use a persistent array to hold the full history (state)
  let messages: Message[] = [{ role: "system", content: buildSystemPrompt() }];

  // console.log(`\n${c_header("=".repeat(60))}`);
  // console.log(`${c_header("  LLM Chat  ·  LM Studio  ·  Persistent Memory")}`);
  // console.log(`${c_header("=".repeat(60))}`);
  // console.log(`${c_info(`  Model      : ${CONFIG.model}`)}`);
  // console.log(`${c_info(`  LM Studio  : ${CONFIG.lm_studio_base_url}`)}`);
  // console.log(`${c_info(`  Memory file: ${CONFIG.memory_file}`)}`);
  // console.log(`${c_header("=".repeat(60))}`);
  // console.log(`${c_info("  Type 'exit' or 'quit' to end the session.")}`);
  // console.log(`${c_info("  Type 'memory' to print the current memory.md.")}`);
  // console.log(`${c_header("=".repeat(60))\n`);

  // Prime the model: ask it to read memory before the first user turn
  messages.push({ role: "user", content: "__INIT__: Please read your memory now so you are ready." });
  let initialMessageOutput = await processInitialMemory(messages);
  if (initialMessageOutput) {
    console.log(initialMessageOutput + "\n");
  }

  // Remove the synthetic init message from history
  messages = messages.filter((m) => !(m.role === "user" && m.content?.startsWith("__INIT__")));

  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  /**
   * The main loop handler function.
   */
  const chatLoop = async () => {
    // Prompt the user for input
    process.stdout.write(`${c_user("You: ")}${c_reset()}\n`);

    // Read a line, awaiting the input
    return new Promise<string>((resolve) =>
      readline.question("", (input: string) => {
        readline.close();
        resolve(input);
      }),
    );
  };

  /**
   * Processes a user turn using the agentic tool-call loop.
   */
  const runTurn = async (userInput: string): Promise<string | null> => {
    // Built-in commands
    if (/(exit|quit)/i.test(userInput)) {
      console.log(`\n${c_info("Goodbye! Your memory is saved in ${CONFIG.memory_file}")}\n`);
      return "EXIT";
    }
    if (/^memory$/i.test(userInput)) {
      try {
        const content = await toolReadMemory();
        console.log(`\n${c_info("── memory.md ──────────────────────────────")}`);
        console.log(content);
        console.log(`${c_info("───────────────────────────────────────────\n")}`);
        return "CONTINUE"; // Don't process turn history change
      } catch (e) {
        console.error(`[CLI Error] Could not read memory: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }

    // Add user message to history
    messages.push({ role: "user", content: userInput });
    let finalAnswer = "";

    const rounds = 0;
    let hasFinalAnswer = false;

    // Agentic Tool-call loop (The core logic)
    while (rounds < CONFIG.max_tool_rounds && !hasFinalAnswer) {
      try {
        console.log("\n[System] Calling LLM...");
        const resp = await callLLM(messages);

        const choice = resp.choices?.[0];
        if (!choice?.message) break;

        const msg = choice.message;
        const toolCalls: FunctionCall[] = msg.tool_calls || [];

        if (toolCalls.length > 0) {
          // Model wants to call tools — execute them and loop
          console.log("\n[System] Tool calls detected. Executing...");
          messages.push(msg); // Add the tool-request message
          await processToolCalls(messages, toolCalls);
          // Continue loop to let model respond after tool results
        } else {
          // No more tool calls — we have the final answer
          finalAnswer = msg.content || "";
          messages.push({ role: "assistant", content: finalAnswer });
          console.log(`\n${c_ai("Assistant: ")}${finalAnswer}\n`);
          hasFinalAnswer = true;
        }
      } catch (e) {
        console.error(c_error(`Error during LLM turn processing: ${(e as Error).message}`));
        break; // Break out of the agentic loop on fatal error
      }
    }
    return finalAnswer || null;
  };

  // Main execution flow loop
  let input: string | null = "";
  while (true) {
    try {
      input = await chatLoop();

      if (!input) continue;

      const result = await runTurn(input);

      if (result === "EXIT") {
        break;
      }
      if (result === "CONTINUE") {
        continue;
      }
    } catch (e) {
      console.error(c_error(`\nCritical Error in chat loop: ${(e as Error).message}`));
      break;
    }
  }

  readline.removeAllListeners(); // Cleanup resources
}

// =============================================================================
// Entry Point
// =============================================================================

/** Simple polyfill for missing functionality or consistent use of color codes */
const c_reset = () => Colors.reset;
runChat().catch((err) => {
  console.error(c_error("\nFATAL EXCEPTION: The chat session terminated due to a critical error."), err);
});
