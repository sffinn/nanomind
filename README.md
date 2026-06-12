# nanomind

A simple chat application that uses LM Studio to power a persistent memory system.

## Prerequisites

- **[Bun](https://bun.sh)** (v1.1+ recommended) — runtime, package manager, and bundler
- **LM Studio** running locally with a model loaded (required for chat to work)
- Optional: **TypeScript** (peer dependency, for IDE/type-checking only)

## Install

From the repo root:

```bash
bun install
```

This installs dependencies from `package.json`: `axios`, `react`, `react-dom`, and type packages.

## There Is No Separate "Build" Step

The project is designed to run TypeScript directly via Bun — no `dist/` folder, no `npm run build` script.

- `tsconfig.json` sets `"noEmit": true` — TypeScript is type-check only, not compilation
- `package.json` scripts only define `chat`, `web`, and `test` — no `build` script
- The web client is bundled in-memory at server startup via `Bun.build()`

## Run the CLI Chat

```bash
bun run chat
```

Runs `src/chat/chat.ts` directly — an interactive terminal chat with persistent memory and tool support.

## Run the Web App

```bash
bun run web
```

Runs `src/web/server.ts`, which:

1. Bundles the React client from `src/web/client/index.tsx` using `Bun.build()` at startup
2. Starts `Bun.serve` on port **3000** (override with `PORT` env var)
3. Serves the UI at http://localhost:3000 and the API at `POST /api/chat`

No pre-build is needed — just start the server. The client source lives in `src/web/client/` and the server in `src/web/server.ts`.

## Configuration

Set environment variables before running either entry point:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | LM Studio API base URL |
| `LM_STUDIO_MODEL` | `local-model` | Model name sent to the API |
| `MEMORY_FILE` | `memory.md` | Path to persistent memory file |
| `PORT` | `3000` | Web server port (web only) |

Example:

```bash
LM_STUDIO_URL=http://localhost:1234/v1 bun run web
```

## Type-Check Only (Optional)

To verify types without running the app:

```bash
bunx tsc --noEmit
```

This uses `tsconfig.json` and does not produce output files.

## Memory

The application uses a persistent memory file to store conversation context across sessions.

```bash
cat memory.md
```

## Quick Reference

| Goal | Command |
|------|---------|
| Install deps | `bun install` |
| CLI chat | `bun run chat` |
| Web chat UI | `bun run web` → open http://localhost:3000 |
| Type-check | `bunx tsc --noEmit` |

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.
