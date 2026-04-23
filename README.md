# Temporal Workflow for Agent

A Temporal-based build pipeline that orchestrates building Vite+React+TypeScript applications using durable workflows with automatic error recovery.

## Quick Start

```bash
git clone https://github.com/zazikant/temporal-workflow-for-agent.git
cd temporal-workflow-for-agent
pnpm install
temporal.exe server start-dev   # (separate terminal)
pnpm start                     # triggers workflow automatically
# Then edit worker.ts line 24 with your app spec and run pnpm start again
```

## What it does

1. **Scaffold** - Creates a new Vite+React+TypeScript app from scratch
2. **Install** - Runs `pnpm install --force` with proper esbuild configuration
3. **TypeCheck** - Runs `tsc --noEmit`
4. **Lint** - Runs `eslint .`
5. **Build** - Runs `vite build`

If any step fails, the system automatically attempts to fix the issue and retry (up to 3 pipeline attempts).

## Prerequisites

1. **Temporal CLI** - Download from https://github.com/temporalio/cli/releases
   - Extract `temporal.exe` and add to PATH
   - Or keep in project folder

2. **Node.js 18+** and **pnpm**

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start Temporal dev server (separate terminal)
temporal.exe server start-dev
# Or: temporal.exe server start-dev --headless  # skip UI (~40MB RAM)

# 3. Start the worker (triggers workflow automatically)
pnpm start
```

## How it works

1. Worker starts → connects to Temporal server
2. Automatically starts `buildAppWorkflow` with the app spec
3. Workflow runs pipeline stages:
   - **scaffoldRepo** - Creates package.json, tsconfig.json, eslint.config.js, src files
   - **installDeps** - `pnpm install --force`
   - **typeCheck** - `tsc --noEmit`
   - **lint** - `eslint .`
   - **build** - `vite build` → output in `app-chat/dist/`

4. If any stage fails → workflow creates fix prompt → retries (up to 3 times)

## Changing the App Spec

Edit `worker.ts` line 24 to change the app specification:

```typescript
args: ["Vite + React + TypeScript chatbot app"]
```

Example specs:
- `"Vite + React + TypeScript todo app with localStorage"`
- `"Next.js + TypeScript dashboard app with dark mode"`
- `"React + TypeScript e-commerce storefront"`

## Architecture

```
├── worker.ts              # Worker setup + auto-starts workflow
├── wait-for-server.ts     # Connection helper with retry logic
├── activities.ts          # All 5 activities (scaffold, install, typeCheck, lint, build)
├── workflows/
│   └── build-app.ts       # The orchestration workflow with error recovery
└── temporal for typescript.md  # Complete spec with all learnings/failure fixes
```

## Troubleshooting

### Worker won't start
- Ensure Temporal server is running: `temporal.exe server start-dev`
- Check server is at localhost:7233

### Activity timeouts
- Activities have 10-minute timeouts (600000ms) - sufficient for most builds
- If install is slow, check network connection

### ESLint/TypeScript errors on retry
- The workflow auto-fixes these - just wait for retry
- If it keeps failing after 3 attempts, check the temporal for typescript.md failures section

## Full Specification

See `temporal for typescript.md` for complete documentation including:
- All 15+ failure learnings and fixes
- Exact package.json devDependencies needed
- tsconfig.json and eslint.config.js requirements
- Activity timeout configuration details