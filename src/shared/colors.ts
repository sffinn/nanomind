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

export { Colors, c_user, c_ai, c_tool, c_error, c_info, c_header };
