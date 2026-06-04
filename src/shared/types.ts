/** A tool invocation returned by the model (OpenAI-compatible). */
interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/** Represents a message in the conversation history. */
type MessageRole = "user" | "assistant" | "system" | "tool";

interface Message {
  role: MessageRole;
  content?: string;
  // For tool calls specifically
  tool_call_id?: string;
}

export type { ToolCall, Message, MessageRole };
