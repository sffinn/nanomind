import fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);

// =============================================================================
// Coding Agent Tools
//
// A self-contained toolset that lets the model read, edit, and explore the
// project, plus run shell commands. File operations are sandboxed to the
// workspace root to prevent the model from touching arbitrary paths.
// =============================================================================

interface ToolFunctionParameters {
  type: string;
  properties: Record<string, unknown>;
  required: string[];
}

interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: ToolFunctionParameters;
}

interface ToolDefinition {
  type: "function";
  function: ToolFunctionDefinition;
}

/** The workspace root all file operations are confined to. */
const WORKSPACE_ROOT = process.cwd();

/** Directories that are noisy/large and excluded from listing/search. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", ".next"]);

/** Max bytes returned by read_file before truncation. */
const MAX_READ_BYTES = 100_000;

/**
 * Resolves a workspace-relative path to an absolute path, refusing any path
 * that escapes the workspace root.
 */
function resolveSafe(requested: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, requested);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path '${requested}' is outside the workspace.`);
  }
  return resolved;
}

// =============================================================================
// Tool Definitions (API Schema)
// =============================================================================

const CODING_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the full contents of a text file in the workspace. Returns the file with 1-based line numbers prefixed to each line.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to the file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or completely overwrite an existing one with the given content. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to the file." },
          content: { type: "string", description: "The full content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact substring in a file with new text. `old_string` must appear EXACTLY once in the file. Use read_file first to get exact context.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to the file." },
          old_string: { type: "string", description: "Exact text to find (must be unique in the file)." },
          new_string: { type: "string", description: "Text to replace it with." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories recursively under a workspace path (default: the workspace root).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory to list. Defaults to '.'." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Search file contents for a case-insensitive substring across the workspace. Returns matching file paths with line numbers and the matching line.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The text to search for." },
          path: { type: "string", description: "Workspace-relative directory to search in. Defaults to '.'." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command from the workspace root and return its combined stdout/stderr. Use for builds, tests, git, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
];

// =============================================================================
// Tool Implementations
// =============================================================================

/** Reads a file and prefixes each line with its 1-based line number. */
async function toolReadFile(args: { path: string }): Promise<string> {
  const abs = resolveSafe(args.path);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) return `ERROR: '${args.path}' is a directory, not a file.`;

  let content = await fs.readFile(abs, "utf8");
  let truncated = false;
  if (content.length > MAX_READ_BYTES) {
    content = content.slice(0, MAX_READ_BYTES);
    truncated = true;
  }

  const numbered = content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(5, " ")}| ${line}`)
    .join("\n");

  return truncated ? `${numbered}\n... [truncated at ${MAX_READ_BYTES} bytes]` : numbered;
}

/** Writes (or overwrites) a file, creating parent directories as needed. */
async function toolWriteFile(args: { path: string; content: string }): Promise<string> {
  const abs = resolveSafe(args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content ?? "", "utf8");
  return `Wrote ${String(args.content ?? "").length} chars to ${args.path}.`;
}

/** Replaces a unique substring in a file. */
async function toolEditFile(args: { path: string; old_string: string; new_string: string }): Promise<string> {
  const abs = resolveSafe(args.path);
  const content = await fs.readFile(abs, "utf8");

  if (args.old_string === "") return "ERROR: old_string must not be empty.";

  const first = content.indexOf(args.old_string);
  if (first === -1) return `ERROR: old_string not found in ${args.path}.`;

  const last = content.lastIndexOf(args.old_string);
  if (first !== last) {
    return `ERROR: old_string appears multiple times in ${args.path}. Provide more surrounding context to make it unique.`;
  }

  const updated = content.slice(0, first) + args.new_string + content.slice(first + args.old_string.length);
  await fs.writeFile(abs, updated, "utf8");
  return `Edited ${args.path} (replaced 1 occurrence).`;
}

/** Recursively collects relative file paths under `dir`. */
async function walkDir(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(`${rel}/`);
      await walkDir(full, root, out);
    } else {
      out.push(rel);
    }
  }
}

/** Lists files recursively under a workspace directory. */
async function toolListFiles(args: { path?: string }): Promise<string> {
  const target = resolveSafe(args.path || ".");
  const results: string[] = [];
  await walkDir(target, WORKSPACE_ROOT, results);
  results.sort();
  return results.length > 0 ? results.join("\n") : "(no files found)";
}

/** Searches file contents for a case-insensitive substring. */
async function toolSearch(args: { query: string; path?: string }): Promise<string> {
  const query = (args.query ?? "").toLowerCase();
  if (!query) return "ERROR: query must not be empty.";

  const target = resolveSafe(args.path || ".");
  const files: string[] = [];
  await walkDir(target, WORKSPACE_ROOT, files);

  const matches: string[] = [];
  for (const rel of files) {
    if (rel.endsWith("/")) continue;
    const abs = path.join(WORKSPACE_ROOT, rel);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue; // skip binary / unreadable files
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query)) {
        matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (matches.length >= 100) return matches.join("\n") + "\n... [more matches truncated]";
      }
    }
  }
  return matches.length > 0 ? matches.join("\n") : `(no matches for "${args.query}")`;
}

/** Runs a shell command from the workspace root. */
async function toolRunCommand(args: { command: string }): Promise<string> {
  const command = args.command;
  if (!command || !command.trim()) return "ERROR: command must not be empty.";

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKSPACE_ROOT,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
    return out || "(command produced no output)";
  } catch (e: any) {
    const stdout = e?.stdout ? String(e.stdout) : "";
    const stderr = e?.stderr ? String(e.stderr) : "";
    const code = e?.code ?? "unknown";
    return `Command exited with code ${code}.\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
  }
}

/** Map tool names to their async handler functions. */
const CODING_TOOL_DISPATCH: Record<string, (args: any) => Promise<string>> = {
  read_file: toolReadFile,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  list_files: toolListFiles,
  search: toolSearch,
  run_command: toolRunCommand,
};

export { CODING_TOOLS, CODING_TOOL_DISPATCH, WORKSPACE_ROOT };
