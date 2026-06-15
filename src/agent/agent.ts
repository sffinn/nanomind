import { CONFIG } from "../shared/config";
import { callLLM, processToolCalls } from "../shared/lm-client";
import { CODING_TOOLS, CODING_TOOL_DISPATCH, WORKSPACE_ROOT } from "../shared/coding-tools";
import type { Message, ToolCall } from "../shared/types";
import { Colors, c_user, c_ai, c_error, c_info, c_header } from "../shared/colors";

// =============================================================================
// System Prompt
// =============================================================================

/** Builds the coding agent's system prompt. */
const buildSystemPrompt = (): string => {
  return `You are nanomind-code, an autonomous CLI coding agent operating inside the user's project.

Workspace root: ${WORKSPACE_ROOT}

## How you work

- You have tools to read, write, and edit files, list and search the codebase, and run shell commands.
- Before changing a file, read it (or search for context) so your edits are precise.
- Prefer edit_file for surgical changes; use write_file to create new files or do full rewrites.
- When using edit_file, the old_string must match the file EXACTLY and be unique. Include enough surrounding context.
- After making changes, verify them when reasonable (e.g. run the build, tests, or the relevant command).
- Keep going until the user's request is fully resolved. Use tools instead of guessing.
- When you are done, give the user a short, clear summary of what you changed and why.
- All file paths are relative to the workspace root. You cannot access files outside it.

Be concise and practical. Do not narrate every tool call; just do the work.`;
};

// =============================================================================
// Agent Loop
// =============================================================================

/** Runs the agentic tool-call loop for one user request. */
async function runTurn(messages: Message[], userInput: string): Promise<void> {
  messages.push({ role: "user", content: userInput });

  let rounds = 0;
  while (rounds < CONFIG.max_tool_rounds) {
    rounds++;
    let resp: any;
    try {
      resp = await callLLM(messages, CODING_TOOLS);
    } catch (e) {
      console.error(c_error(`\nLLM error: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const choice = resp.choices?.[0];
    if (!choice?.message) {
      console.error(c_error("\nNo response from model."));
      return;
    }

    const msg = choice.message;
    const toolCalls: ToolCall[] = msg.tool_calls || [];

    if (toolCalls.length > 0) {
      // Surface any interim reasoning the model emitted alongside tool calls.
      if (msg.content && msg.content.trim()) {
        console.log(`\n${c_ai("nanomind:")} ${msg.content.trim()}`);
      }
      messages.push(msg);
      await processToolCalls(messages, toolCalls, CODING_TOOL_DISPATCH);
      continue;
    }

    // No tool calls -> final answer for this turn.
    const finalAnswer = msg.content || "(no content)";
    messages.push({ role: "assistant", content: finalAnswer });
    console.log(`\n${c_ai("nanomind:")} ${finalAnswer}\n`);
    return;
  }

  console.log(c_info(`\n[Reached tool-call limit of ${CONFIG.max_tool_rounds} rounds.]\n`));
}

/** Main interactive loop. */
async function runAgent() {
  const messages: Message[] = [{ role: "system", content: buildSystemPrompt() }];

  console.log(`\n${c_header("=".repeat(64))}`);
  console.log(`${c_header("  nanomind-code  ·  CLI Coding Agent  ·  LM Studio")}`);
  console.log(`${c_info(`  Model     : ${CONFIG.model}`)}`);
  console.log(`${c_info(`  Endpoint  : ${CONFIG.lm_studio_base_url}`)}`);
  console.log(`${c_info(`  Workspace : ${WORKSPACE_ROOT}`)}`);
  console.log(`${c_header("=".repeat(64))}`);
  console.log(`${c_info("  Describe a coding task. Type 'exit' or 'quit' to leave.")}`);
  console.log(`${c_header("=".repeat(64))}\n`);

  while (true) {
    const input = prompt(`${c_user("you:")}${Colors.reset}`);
    if (input === null) break;

    const trimmed = input.trim();
    if (!trimmed) continue;
    if (/^(exit|quit)$/i.test(trimmed)) {
      console.log(`\n${c_info("Goodbye!")}\n`);
      break;
    }

    try {
      await runTurn(messages, trimmed);
    } catch (e) {
      console.error(c_error(`\nUnexpected error: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

runAgent().catch((err) => {
  console.error(c_error("\nFATAL: coding agent terminated."), err);
});
