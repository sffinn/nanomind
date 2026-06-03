import * as path from "path";

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

export { CONFIG };