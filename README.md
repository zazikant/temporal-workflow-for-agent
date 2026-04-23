# Temporal Workflow for Agent

A Temporal-based build pipeline that orchestrates building Vite+React+TypeScript applications using durable workflows with automatic error recovery.

## What it does

1. **Scaffold** - Creates a new Vite+React+TypeScript app from scratch
2. **Install** - Runs `pnpm install` with proper esbuild configuration
3. **TypeCheck** - Runs `tsc --noEmit`
4. **Lint** - Runs `eslint .`
5. **Build** - Runs `vite build`

If any step fails, the system automatically attempts to fix the issue and retry (up to 3 pipeline attempts).

## Setup

```bash
# Install dependencies
pnpm install

# Start Temporal dev server (in separate terminal)
temporal.exe server start-dev

# Start the worker (triggers workflow automatically)
pnpm start
```

## Changing the app spec

Edit `worker.ts` line 23 to change the app specification:
```typescript
args: ["Vite + React + TypeScript chatbot app"]
```

Or make it configurable by modifying the workflow input.

## Architecture

- `worker.ts` - Worker setup + auto-starts workflow
- `wait-for-server.ts` - Connection helper with retry
- `workflows/build-app.ts` - The orchestration workflow
- `activities.ts` - All build activities (scaffold, install, typeCheck, lint, build)