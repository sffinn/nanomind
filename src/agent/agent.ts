import fs from "fs/promises";
import * as path from "path";
import { CONFIG } from "../shared/config";
import { callLLM, processToolCalls } from "../shared/lm-client";
import { CODING_TOOLS, CODING_TOOL_DISPATCH, WORKSPACE_ROOT } from "../shared/coding-tools";
import type { Message, ToolCall } from "../shared/types";
import { c_ai, c_error, c_info, c_header } from "../shared/colors";

// =============================================================================
// nanomind-code: an autonomous CLI coding agent.
//
// Instead of an interactive REPL, the agent follows a structured development
// process driven by two files in the workspace root:
//   - plan.md  : the user's goal (read once at startup)
//   - tasks.md : the working task list (a markdown checklist the agent
//                maintains across sessions; "- [ ]" = pending, "- [x]" = done)
//
// Each loop iteration: (re)plan tasks -> develop the most important task ->
// commit to git -> mark the task done. The loop exits when no pending tasks
// remain (goal accomplished) or a safety iteration ceiling is hit.
// =============================================================================

const PLAN_FILE = path.join(WORKSPACE_ROOT, "plan.md");
const TASKS_FILE = path.join(WORKSPACE_ROOT, "tasks.md");
const MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS) || 25;

/** Matches a pending checklist item: "- [ ] ...". */
const PENDING_TASK_RE = /^[ \t]*-[ \t]*\[ \]/gm;

const PLAN_TEMPLATE = `# Project Goal

<!--
  Describe what you want nanomind-code to build or accomplish.
  Be as specific as you can: the desired end state, constraints, and any
  acceptance criteria. Replace this comment with your goal, then re-run
  \`bun run agent\`.
-->
`;

// =============================================================================
// File helpers (orchestrator-controlled flow, independent of the model)
// =============================================================================

/** Reads a file, returning null if it does not exist. */
async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Reads the goal from plan.md. If plan.md is missing it scaffolds a template
 * and returns null so the caller can ask the user to fill it in.
 */
async function readGoal(): Promise<string | null> {
  const existing = await readFileSafe(PLAN_FILE);
  if (existing === null) {
    await fs.writeFile(PLAN_FILE, PLAN_TEMPLATE, "utf8");
    return null;
  }
  // Strip HTML comments and headings to detect whether a real goal was written.
  const meaningful = existing
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#.*$/gm, "")
    .trim();
  return meaningful.length > 0 ? existing.trim() : null;
}

/** Ensures tasks.md exists, returning its current contents. */
async function ensureTasksFile(): Promise<string> {
  const existing = await readFileSafe(TASKS_FILE);
  if (existing !== null) return existing;
  const initial = "# Tasks\n\n_No tasks yet. The agent will populate this list._\n";
  await fs.writeFile(TASKS_FILE, initial, "utf8");
  return initial;
}

/** Counts pending ("- [ ]") tasks in tasks.md. */
async function countPendingTasks(): Promise<number> {
  const content = (await readFileSafe(TASKS_FILE)) || "";
  const matches = content.match(PENDING_TASK_RE);
  return matches ? matches.length : 0;
}

// =============================================================================
// Prompts
// =============================================================================

/** Builds the agent's system prompt, embedding the goal. */
const buildSystemPrompt = (goal: string): string =>
  `You are nanomind-code, an autonomous CLI coding agent that follows a structured development process.

Workspace root: ${WORKSPACE_ROOT}

## The goal (from plan.md)
${goal}

## Your tools
read_file, write_file, edit_file, list_files, search, run_command. All paths are workspace-relative; you cannot access files outside the workspace.

## tasks.md contract
- tasks.md is a markdown checklist tracking the work needed to reach the goal.
- Pending task: "- [ ] short actionable description". Completed task: "- [x] description".
- Order tasks with the MOST IMPORTANT first.
- The development loop ends when tasks.md contains no "- [ ]" (pending) items.

## Working rules
- Read relevant files (and search) before editing so your changes are precise.
- Make focused changes; prefer edit_file for surgical edits and write_file for new files.
- Verify your work with run_command (build/tests/etc.) when reasonable.
- Work on ONE task at a time. Be concise; do not narrate every tool call.`;

const PHASE_PLAN_TASKS = `PHASE: PLAN TASKS.
You have the existing tasks.md (saved tasks from previous sessions). Now review the goal and the current state of the codebase (use list_files / read_file / search as needed), then CREATE ANY NEW TASKS still needed to accomplish the goal and add them to tasks.md:
- Add a new "- [ ]" item for every piece of work that is required but not already listed.
- Do NOT remove or duplicate existing pending tasks, and keep completed work marked "- [x]".
- Order tasks with the most important first.
- If the goal is already fully accomplished and no new tasks are needed, ensure NO "- [ ]" items remain.
Use edit_file or write_file to save tasks.md. When done, state how many pending tasks remain.`;

const PHASE_DEVELOP = `PHASE: DEVELOP.
Pick the single MOST IMPORTANT pending ("- [ ]") task in tasks.md. First state which task you picked. Then fully implement it using your tools — read/search for context, make the edits, and verify it works when reasonable. Do not start any other task.`;

const PHASE_COMMIT = `PHASE: COMMIT.
Commit the changes you just made using run_command:
- Stage everything with "git add -A".
- Create a commit with a concise, descriptive message summarizing the task you completed (use: git commit -m "...").
If there is nothing to commit, say so and do not force a commit.`;

const PHASE_UPDATE_TASKS = `PHASE: UPDATE TASKS.
Update tasks.md to mark the task you just completed: change its "- [ ]" to "- [x]" (or remove the line). Leave all other tasks unchanged. Use edit_file or write_file.`;

// =============================================================================
// Phase runner
// =============================================================================

/**
 * Runs one phase: appends the instruction, then drives the agentic tool-call
 * loop until the model returns a final (tool-free) message. The shared message
 * history carries context across phases and iterations.
 */
async function runPhase(messages: Message[], label: string, instruction: string): Promise<void> {
  console.log(`\n${c_header(`── ${label} ${"─".repeat(Math.max(0, 56 - label.length))}`)}`);
  messages.push({ role: "user", content: instruction });

  let rounds = 0;
  while (rounds < CONFIG.max_tool_rounds) {
    rounds++;
    let resp: any;
    try {
      resp = await callLLM(messages, CODING_TOOLS);
    } catch (e) {
      console.error(c_error(`LLM error: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const choice = resp.choices?.[0];
    if (!choice?.message) {
      console.error(c_error("No response from model."));
      return;
    }

    const msg = choice.message;
    const toolCalls: ToolCall[] = msg.tool_calls || [];

    if (toolCalls.length > 0) {
      if (msg.content && msg.content.trim()) {
        console.log(`${c_ai("nanomind:")} ${msg.content.trim()}`);
      }
      messages.push(msg);
      await processToolCalls(messages, toolCalls, CODING_TOOL_DISPATCH);
      continue;
    }

    const finalAnswer = msg.content || "(no content)";
    messages.push({ role: "assistant", content: finalAnswer });
    console.log(`${c_ai("nanomind:")} ${finalAnswer}`);
    return;
  }

  console.log(c_info(`[Phase '${label}' hit the ${CONFIG.max_tool_rounds}-round tool limit.]`));
}

// =============================================================================
// Main
// =============================================================================

async function runAgent() {
  console.log(`\n${c_header("=".repeat(64))}`);
  console.log(`${c_header("  nanomind-code  ·  Autonomous Coding Agent  ·  LM Studio")}`);
  console.log(`${c_info(`  Model     : ${CONFIG.model}`)}`);
  console.log(`${c_info(`  Endpoint  : ${CONFIG.lm_studio_base_url}`)}`);
  console.log(`${c_info(`  Workspace : ${WORKSPACE_ROOT}`)}`);
  console.log(`${c_header("=".repeat(64))}\n`);

  const goal = await readGoal();
  if (!goal) {
    console.log(c_error("No goal found in plan.md."));
    console.log(c_info(`A template has been created at ${PLAN_FILE}.`));
    console.log(c_info("Describe your goal in plan.md, then re-run: bun run agent\n"));
    return;
  }

  const existingTasks = await ensureTasksFile();
  console.log(`${c_info("Goal loaded from plan.md:")}\n${goal}\n`);
  const startPending = await countPendingTasks();
  console.log(c_info(`Loaded tasks.md (${startPending} pending task(s) from previous sessions).\n`));

  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt(goal) },
    {
      role: "user",
      content: `Here is the current tasks.md (saved tasks from previous sessions):\n\n${existingTasks}`,
    },
  ];

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n${c_header("#".repeat(64))}`);
    console.log(`${c_header(`  Iteration ${iter} / ${MAX_ITERATIONS}`)}`);
    console.log(`${c_header("#".repeat(64))}`);

    // 1. Plan: prompt the model to create any new tasks needed for the goal.
    await runPhase(messages, "PLAN TASKS", PHASE_PLAN_TASKS);

    // Exit condition: no pending tasks means the goal is accomplished.
    const pending = await countPendingTasks();
    console.log(c_info(`\n[${pending} pending task(s) remaining in tasks.md]`));
    if (pending === 0) {
      console.log(`\n${c_ai("Goal accomplished — no pending tasks remain. Exiting loop.")}\n`);
      return;
    }

    // 2. Develop the single most important task.
    await runPhase(messages, "DEVELOP", PHASE_DEVELOP);

    // 3. Commit the changes to git.
    await runPhase(messages, "COMMIT", PHASE_COMMIT);

    // 4. Mark the completed task done in tasks.md.
    await runPhase(messages, "UPDATE TASKS", PHASE_UPDATE_TASKS);
  }

  console.log(
    c_info(
      `\n[Reached the ${MAX_ITERATIONS}-iteration ceiling without completing the goal. ` +
        `Review tasks.md and re-run to continue.]\n`,
    ),
  );
}

runAgent().catch((err) => {
  console.error(c_error("\nFATAL: coding agent terminated."), err);
});
