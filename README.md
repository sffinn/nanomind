# nanomind

A simple chat application that uses LM Studio to power a persistent memory system.

## Usage

```bash
bun run chat
```

## Web app

A small React app served by Bun's built-in HTTP server. The client is bundled
in-memory at startup, so there's no separate build step or output directory.

```bash
bun run web
```

Then open http://localhost:3000. Set `PORT` to use a different port. The client
source lives in `src/web/client/` and the server in `src/web/server.ts`.

## Configuration

The application is configured via environment variables.

```bash
LM_STUDIO_URL=http://localhost:1234/v1
LM_STUDIO_MODEL=local-model
MEMORY_FILE=memory.md
```

## Memory

The application uses a persistent memory file to store the conversation history.

```bash
cat memory.md
```

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.
