# nanomind

A simple chat application that uses LM Studio to power a persistent memory system.

## Usage

```bash
bun run src/chat/chat.ts
```

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
