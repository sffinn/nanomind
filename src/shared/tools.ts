import fs from "fs/promises";
import * as path from "path";
import { CONFIG } from "./config";

// =============================================================================
// Configuration and Type Definitions
// =============================================================================

interface ToolFunctionParameters {
  type: string;
  properties: any;
  required: string[];
}

/** Represents the structure of an LLM tool call request body. */
interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: ToolFunctionParameters;
}

interface ToolDefinition {
  type: string;
  function: ToolFunctionDefinition;
}

// =============================================================================
// Tool Definitions (API Schema)
// =============================================================================

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_memory",
      description:
        "Read the entire contents of memory.md. Use this to recall facts, previous decisions, user preferences, and conversation context.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
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
  {
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
  {
    type: "function",
    function: {
      name: "clear_memory",
      description:
        "Wipe memory.md completely and replace it with a minimal header. Use this when the stored context is no longer relevant and a fresh start is needed.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "ls",
      description: "Walk the workspace directory and returns all files.",
      parameters: { type: "object", properties: {}, required: [] },
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

/** Directories that are noisy/large and not useful to list. */
const LS_IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build"]);

/** Recursively collects relative file paths starting from `dir`. */
async function walkDir(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (LS_IGNORED_DIRS.has(entry.name)) continue;
      out.push(`${rel}/`);
      await walkDir(full, root, out);
    } else {
      out.push(rel);
    }
  }
}

/** Tool handler for listing the current directory and all sub-directories. */
async function toolLs(): Promise<string> {
  try {
    const root = `${process.cwd()}/wiki`;
    const results: string[] = [];
    await walkDir(root, root, results);
    results.sort();
    return results.length > 0 ? results.join("\n") : "(directory is empty)";
  } catch (error) {
    console.error(`[Tool Error] Failed to list directory:`, error);
    return "ERROR: Cannot list directory contents.";
  }
}

/** Map tool names to their corresponding async handler functions. */
const TOOL_DISPATCH: Record<string, (args: any) => Promise<string>> = {
  read_memory: toolReadMemory,
  write_memory: toolWriteMemory,
  append_memory: toolAppendMemory,
  clear_memory: toolClearMemory,
  ls: toolLs,
};

export { TOOLS, TOOL_DISPATCH };
