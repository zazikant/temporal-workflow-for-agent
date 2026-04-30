# Temporal Build Pipeline — Agent Execution Manual

> **Purpose:** You are an agent. You read this file. You execute every step exactly. You do not think, guess, or debug. Every decision is already made below. Follow the steps in order.

---

## STEP 0 — CONFIGURATION (set these 3 values, then never touch them again)

```
PIPELINE_DIR = /home/z/my-project/temporal-pipeline
APP_DIR      = /home/z/my-project/temporal-pipeline/scaffolded-app
PLATFORM     = linux-x64-gnu
```

- `PIPELINE_DIR` is where the Temporal worker code lives (you create this).
- `APP_DIR` is where the scaffolded app lands (the LLM writes files here, activities run commands here).
- `PLATFORM` determines which SWC/esbuild binary to install. On Windows use `win32-x64-msvc`.

> Do NOT reference `D:\xxx\` anywhere. Do NOT use Windows paths. All paths are absolute Linux paths starting with `/home/z/my-project/`.

---

## STEP 1 — CREATE DIRECTORY STRUCTURE

```
mkdir -p PIPELINE_DIR/workflows
```

Result:
```
PIPELINE_DIR/
├── workflows/
```

Nothing else exists yet. You create everything from scratch.

---

## STEP 2 — WRITE `PIPELINE_DIR/package.json`

```json
{
  "name": "temporal-build-pipeline",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "tsx worker.ts",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@temporalio/workflow": "^1.11.0",
    "@temporalio/activity": "^1.11.0",
    "@temporalio/worker": "^1.11.0",
    "@temporalio/client": "^1.11.0",
    "@temporalio/core-bridge": "^1.11.0",
    "@swc/core-linux-x64-gnu": "^1.11.0",
    "z-ai-web-dev-sdk": "latest"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

> **If PLATFORM is `win32-x64-msvc`**: replace `"@swc/core-linux-x64-gnu"` with `"@swc/core-win32-x64-msvc"`.

---

## STEP 3 — WRITE `PIPELINE_DIR/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": [
    "workflows/**/*.ts",
    "activities.ts",
    "worker.ts"
  ],
  "exclude": [
    "node_modules",
    "dist",
    "scaffolded-app"
  ]
}
```

> The `exclude` must include `"scaffolded-app"` so tsc never tries to compile the generated app.

---

## STEP 4 — WRITE `PIPELINE_DIR/workflows/types.ts`

```typescript
export interface ErrorEntry {
  attempt: number;
  stage: "scaffold" | "scaffold-patch" | "typeCheck" | "lint" | "build";
  error: string;
  filesChanged?: string[];
  changeSummary?: string[];
  triggeredBy?: string;
}

export type ResumeStage = "initial" | "typeCheck" | "lint" | "build";

export interface ScaffoldResult {
  filesChanged: string[];
  changeSummary: string[];
}

export interface CheckResult {
  ok: boolean;
  error?: string;
}

export interface BuildResult {
  ok: boolean;
  error?: string;
  distPath?: string;
}
```

---

## STEP 5 — WRITE `PIPELINE_DIR/workflows/compile-prompt.ts`

```typescript
import { ErrorEntry } from "./types.js";

export function compileScaffoldPrompt(
  spec: string,
  errorHistory: ErrorEntry[],
  attempt: number,
  resumeFrom: string
): string {
  // Mode A: initial scaffold
  if (errorHistory.length === 0) {
    return `
You are scaffolding a new app from scratch.

Spec: ${spec}

Requirements:
- Vite + React + TypeScript
- Create eslint.config.js with sensible flat config defaults
- All files must compile cleanly with tsc --noEmit and eslint
- The tsconfig.json must use include: ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
- The tsconfig.json must exclude: ["node_modules", "dist", "workflows", "activities.ts", "worker.ts"]
- Do NOT add "types": ["node"] to tsconfig.json unless @types/node is in devDependencies

Return a JSON object with exactly this shape:
{
  "files": {
    "relative/path/to/file.ts": "full file contents here",
    ...
  },
  "changeSummary": ["Created file.ts — one-line description", ...]
}

Every file must be complete and ready to write to disk. No placeholders.
    `.trim();
  }

  // Mode B: surgical patch
  const latest = errorHistory[errorHistory.length - 1];
  const previousFixes = errorHistory
    .slice(0, -1)
    .map(
      (e) =>
        `  Attempt ${e.attempt} | ${e.stage}${e.triggeredBy ? ` (fixing ${e.triggeredBy})` : ""}:
     Files changed: ${(e.filesChanged || []).join(", ")}
     What changed: ${(e.changeSummary || []).join("; ")}`
    )
    .join("\n");

  return `
You are making a surgical fix to an existing app.

Spec: ${spec}

Current error to fix (fix this and only this):
  Stage: ${latest.stage}${latest.triggeredBy ? ` (triggered by ${latest.triggeredBy})` : ""}
  Error: ${latest.error}

What was already tried — do NOT repeat these:
${previousFixes || "  Nothing tried yet."}

Rules:
- Fix only the file(s) causing the current error above.
- Do not touch unrelated files.
- Do not repeat a fix already listed above.
- Return a JSON object with exactly this shape:
{
  "files": {
    "relative/path/to/file.ts": "full file contents here"
  },
  "changeSummary": ["Modified file.ts — one-line description of what changed"]
}
  `.trim();
}
```

**Key design decisions (do not change):**
- Mode A has zero error history → full generation prompt.
- Mode B targets ONLY the latest error, lists previous fixes to avoid repetition.
- Both modes request JSON output with `files` and `changeSummary` keys. This is the contract between `compileScaffoldPrompt` and `scaffoldRepo`.

---

## STEP 6 — WRITE `PIPELINE_DIR/workflows/build-app.ts`

```typescript
import { proxyActivities, ApplicationFailure } from "@temporalio/workflow";
import type * as activities from "../activities.js";
import { ErrorEntry, ResumeStage, ScaffoldResult } from "./types.js";
import { compileScaffoldPrompt } from "./compile-prompt.js";

const {
  scaffoldRepo,
  installDeps,
  typeCheck,
  lint,
  build,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: 600000,
  scheduleToCloseTimeout: 600000,
  retry: {
    initialInterval: "5s",
    maximumInterval: "30s",
    maximumAttempts: 1,
  },
});

export async function buildAppWorkflow(spec: string): Promise<string> {
  let scaffoldAttempts = 0;
  let attempt = 0;
  let resumeFrom: ResumeStage = "initial";
  let errorHistory: ErrorEntry[] = [];

  // ── Phase 1: Initial Scaffold (max 2) ──

  while (scaffoldAttempts < 2) {
    const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, resumeFrom);
    try {
      const result: ScaffoldResult = await scaffoldRepo(compiledPrompt);
      console.log(`[Scaffold attempt ${scaffoldAttempts}] Files changed: ${result.filesChanged.join(", ")}`);
      console.log(`[Scaffold attempt ${scaffoldAttempts}] Change summary: ${result.changeSummary.join("; ")}`);
      break;
    } catch (err: any) {
      scaffoldAttempts++;
      errorHistory.push({
        attempt: 0,
        stage: "scaffold",
        error: err?.message || String(err),
      });
      console.log(`[Scaffold attempt ${scaffoldAttempts}] Error: ${(err?.message || String(err)).slice(0, 300)}`);
      if (scaffoldAttempts >= 2) {
        throw ApplicationFailure.create({
          message: `Scaffold failed after 2 attempts. Error history:\n${JSON.stringify(errorHistory, null, 2)}`,
          type: "ScaffoldFailed",
        });
      }
    }
  }

  // ── Phase 2: Pipeline Loop (max 3) ──

  const MAX_PIPELINE_ATTEMPTS = 3;

  while (attempt < MAX_PIPELINE_ATTEMPTS) {
    attempt++;
    console.log(`\n═══ Pipeline attempt ${attempt}/${MAX_PIPELINE_ATTEMPTS} | resumeFrom: ${resumeFrom} ═══`);

    // Install
    try {
      await installDeps();
      console.log("[installDeps] OK");
    } catch (err: any) {
      console.log(`[installDeps] Error: ${(err?.message || "").slice(0, 300)}`);
      if (attempt >= MAX_PIPELINE_ATTEMPTS) {
        throw ApplicationFailure.create({
          message: `Pipeline exhausted after ${MAX_PIPELINE_ATTEMPTS} attempts. Error history:\n${JSON.stringify(errorHistory, null, 2)}`,
          type: "PipelineExhausted",
        });
      }
      continue;
    }

    // TypeCheck
    if (resumeFrom === "initial" || resumeFrom === "typeCheck") {
      const tsResult = await typeCheck();
      if (!tsResult.ok) {
        console.log(`[typeCheck] Error: ${(tsResult.error || "").slice(0, 300)}`);
        errorHistory.push({ attempt, stage: "typeCheck", error: tsResult.error || "Unknown typeCheck error" });

        const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, "typeCheck");
        console.log(`[Attempt ${attempt} | typeCheck] Compiled prompt:\n${compiledPrompt}`);

        try {
          const patchResult: ScaffoldResult = await scaffoldRepo(compiledPrompt);
          errorHistory[errorHistory.length - 1].filesChanged = patchResult.filesChanged;
          errorHistory[errorHistory.length - 1].changeSummary = patchResult.changeSummary;
          console.log(`[Attempt ${attempt} | typeCheck] Files changed: ${patchResult.filesChanged.join(", ")}`);
          console.log(`[Attempt ${attempt} | typeCheck] Change summary: ${patchResult.changeSummary.join("; ")}`);
        } catch (patchErr: any) {
          errorHistory.push({ attempt, stage: "scaffold-patch", error: patchErr?.message || String(patchErr), triggeredBy: "typeCheck" });
        }

        resumeFrom = "typeCheck";
        if (attempt >= MAX_PIPELINE_ATTEMPTS) {
          throw ApplicationFailure.create({
            message: `Pipeline exhausted after ${MAX_PIPELINE_ATTEMPTS} attempts. Error history:\n${JSON.stringify(errorHistory, null, 2)}`,
            type: "PipelineExhausted",
          });
        }
        continue;
      }
      resumeFrom = "lint";
      console.log("[typeCheck] OK");
    }

    // Lint
    if (resumeFrom === "lint") {
      const lintResult = await lint();
      if (!lintResult.ok) {
        console.log(`[lint] Error: ${(lintResult.error || "").slice(0, 300)}`);
        errorHistory.push({ attempt, stage: "lint", error: lintResult.error || "Unknown lint error" });

        const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, "lint");
        console.log(`[Attempt ${attempt} | lint] Compiled prompt:\n${compiledPrompt}`);

        try {
          const patchResult: ScaffoldResult = await scaffoldRepo(compiledPrompt);
          errorHistory[errorHistory.length - 1].filesChanged = patchResult.filesChanged;
          errorHistory[errorHistory.length - 1].changeSummary = patchResult.changeSummary;
          console.log(`[Attempt ${attempt} | lint] Files changed: ${patchResult.filesChanged.join(", ")}`);
          console.log(`[Attempt ${attempt} | lint] Change summary: ${patchResult.changeSummary.join("; ")}`);
        } catch (patchErr: any) {
          errorHistory.push({ attempt, stage: "scaffold-patch", error: patchErr?.message || String(patchErr), triggeredBy: "lint" });
        }

        resumeFrom = "lint";
        if (attempt >= MAX_PIPELINE_ATTEMPTS) {
          throw ApplicationFailure.create({
            message: `Pipeline exhausted after ${MAX_PIPELINE_ATTEMPTS} attempts. Error history:\n${JSON.stringify(errorHistory, null, 2)}`,
            type: "PipelineExhausted",
          });
        }
        continue;
      }
      resumeFrom = "build";
      console.log("[lint] OK");
    }

    // Build
    if (resumeFrom === "build") {
      const buildResult = await build();
      if (!buildResult.ok) {
        console.log(`[build] Error: ${(buildResult.error || "").slice(0, 300)}`);
        errorHistory.push({ attempt, stage: "build", error: buildResult.error || "Unknown build error" });

        const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, "build");
        console.log(`[Attempt ${attempt} | build] Compiled prompt:\n${compiledPrompt}`);

        try {
          const patchResult: ScaffoldResult = await scaffoldRepo(compiledPrompt);
          errorHistory[errorHistory.length - 1].filesChanged = patchResult.filesChanged;
          errorHistory[errorHistory.length - 1].changeSummary = patchResult.changeSummary;
          console.log(`[Attempt ${attempt} | build] Files changed: ${patchResult.filesChanged.join(", ")}`);
          console.log(`[Attempt ${attempt} | build] Change summary: ${patchResult.changeSummary.join("; ")}`);
        } catch (patchErr: any) {
          errorHistory.push({ attempt, stage: "scaffold-patch", error: patchErr?.message || String(patchErr), triggeredBy: "build" });
        }

        resumeFrom = "build";
        if (attempt >= MAX_PIPELINE_ATTEMPTS) {
          throw ApplicationFailure.create({
            message: `Pipeline exhausted after ${MAX_PIPELINE_ATTEMPTS} attempts. Error history:\n${JSON.stringify(errorHistory, null, 2)}`,
            type: "PipelineExhausted",
          });
        }
        continue;
      }
      console.log(`[build] OK — dist at: ${buildResult.distPath}`);
      return buildResult.distPath || "dist";
    }
  }

  throw ApplicationFailure.create({
    message: `Pipeline exited unexpectedly. Error history:\n${JSON.stringify(errorHistory, null, 2)}`,
    type: "PipelineUnexpectedExit",
  });
}
```

**State machine rules (memorize these, do not deviate):**
| Event | resumeFrom becomes |
|---|---|
| typeCheck passes | `"lint"` |
| typeCheck fails (patch OK or patch fails) | `"typeCheck"` |
| lint passes | `"build"` |
| lint fails (patch OK or patch fails) | `"lint"` |
| build fails (patch OK or patch fails) | `"build"` |
| build passes | return distPath (workflow ends) |

`resumeFrom` NEVER goes backwards. It only stays the same or advances.

---

## STEP 7 — WRITE `PIPELINE_DIR/workflows/index.ts`

```typescript
export { buildAppWorkflow } from "./build-app.js";
```

> This barrel file is required. The Temporal worker scans the `workflows/` directory for exported workflow functions.

---

## STEP 8 — WRITE `PIPELINE_DIR/activities.ts`

```typescript
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";

const execAsync = promisify(exec);

// ── THE ONLY PATH CONSTANT ──
const APP_DIR = "/home/z/my-project/temporal-pipeline/scaffolded-app";

// ── Helper: run command in APP_DIR, capture full output ──
async function runInAppDir(command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execAsync(command, {
      cwd: APP_DIR,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 540000,
    });
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || String(err),
    };
  }
}

// ── scaffoldRepo ──
export async function scaffoldRepo(
  compiledPrompt: string
): Promise<{ filesChanged: string[]; changeSummary: string[] }> {
  console.log(`[scaffoldRepo] Calling LLM with prompt (${compiledPrompt.length} chars)...`);

  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "You are a code generation agent. You ALWAYS respond with valid JSON only. " +
          "No markdown, no code fences, no explanation outside the JSON. " +
          "The JSON must have keys: 'files' (object mapping relative file paths to full file contents) " +
          "and 'changeSummary' (array of one-line descriptions of what each file does/changes).",
      },
      { role: "user", content: compiledPrompt },
    ],
    temperature: 0.2,
    max_tokens: 16000,
  });

  const rawResponse = completion.choices[0]?.message?.content || "";
  console.log(`[scaffoldRepo] LLM response length: ${rawResponse.length} chars`);

  let jsonStr = rawResponse.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed: { files: Record<string, string>; changeSummary: string[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `scaffoldRepo: LLM response was not valid JSON. First 500 chars: ${jsonStr.slice(0, 500)}`
    );
  }

  if (!parsed.files || typeof parsed.files !== "object") {
    throw new Error("scaffoldRepo: LLM response missing 'files' object");
  }

  await fs.mkdir(APP_DIR, { recursive: true });

  const filesChanged: string[] = [];
  for (const [relativePath, contents] of Object.entries(parsed.files)) {
    const fullPath = path.join(APP_DIR, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, contents as string, "utf-8");
    filesChanged.push(relativePath);
    console.log(`[scaffoldRepo] Wrote: ${relativePath} (${(contents as string).length} chars)`);
  }

  const changeSummary = parsed.changeSummary || filesChanged.map((f) => `Created ${f}`);
  return { filesChanged, changeSummary };
}

// ── installDeps ──
export async function installDeps(): Promise<void> {
  console.log("[installDeps] Running pnpm install --force...");
  const { stdout, stderr } = await runInAppDir(
    "pnpm config set onlyBuiltDependencies 'esbuild' --location project 2>/dev/null; pnpm install --force"
  );
  const combined = stdout + stderr;
  if (combined.includes("ERR_PNPM") || combined.includes("ELIFECYCLE")) {
    throw new Error(`installDeps failed:\n${combined.slice(0, 2000)}`);
  }
  console.log("[installDeps] Done");
}

// ── typeCheck ──
export async function typeCheck(): Promise<{ ok: boolean; error?: string }> {
  console.log("[typeCheck] Running tsc --noEmit...");
  const { stdout, stderr } = await runInAppDir("./node_modules/.bin/tsc --noEmit");
  const combined = (stdout + stderr).trim();
  if (combined.length === 0) {
    console.log("[typeCheck] OK");
    return { ok: true };
  }
  if (combined.includes("error TS") || stderr.length > 0) {
    console.log(`[typeCheck] FAILED — ${combined.length} chars`);
    return { ok: false, error: combined };
  }
  console.log("[typeCheck] OK — warnings only");
  return { ok: true };
}

// ── lint ──
export async function lint(): Promise<{ ok: boolean; error?: string }> {
  console.log("[lint] Running eslint .");
  const { stdout, stderr } = await runInAppDir("./node_modules/.bin/eslint .");
  const combined = (stdout + stderr).trim();
  if (combined.length === 0) {
    console.log("[lint] OK");
    return { ok: true };
  }
  if (combined.includes("error") || combined.includes("warning")) {
    console.log(`[lint] FAILED — ${combined.length} chars`);
    return { ok: false, error: combined };
  }
  console.log("[lint] OK");
  return { ok: true };
}

// ── build ──
export async function build(): Promise<{ ok: boolean; error?: string; distPath?: string }> {
  console.log("[build] Running tsc -b && vite build...");
  const { stdout, stderr } = await runInAppDir("./node_modules/.bin/vite build");
  const combined = (stdout + stderr).trim();
  if (combined.includes("built in") || combined.includes("dist/")) {
    const distPath = path.join(APP_DIR, "dist");
    console.log(`[build] OK — dist at ${distPath}`);
    return { ok: true, distPath };
  }
  console.log(`[build] FAILED — ${combined.length} chars`);
  return { ok: false, error: combined };
}
```

**Critical implementation notes (do not change):**

1. **`scaffoldRepo` calls `z-ai-web-dev-sdk`** — the system prompt enforces JSON-only output. The `compileScaffoldPrompt` contract expects `{ files: {...}, changeSummary: [...] }`.
2. **Code fence stripping** — LLMs often wrap JSON in ` ```json ... ``` `. The strip logic handles this.
3. **`installDeps` runs `pnpm config set onlyBuiltDependencies` then `pnpm install --force`** — this is mandatory because pnpm 10+ blocks esbuild's postinstall by default, and `--force` ensures deps actually install on retries instead of "Lockfile is up to date".
4. **`runInAppDir` catches exec errors** — `child_process.exec` throws on non-zero exit codes. The catch block preserves stdout/stderr so we never lose error output.
5. **All imports use ES module syntax** (`import fs from "fs/promises"`) — never `require()`.

---

## STEP 9 — WRITE `PIPELINE_DIR/worker.ts`

```typescript
import { Worker, NativeConnection } from "@temporalio/worker";
import { Connection, Client } from "@temporalio/client";
import { fileURLToPath } from "url";
import path from "path";
import * as activities from "./activities.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── App spec: customize this for your app ──
const APP_SPEC = `
Vite + React + TypeScript chatbot application.
- Frontend: React 18 with hooks, TypeScript
- Styling: CSS modules
- Features: Chat input, message list, basic send/receive UI
- No backend needed — use mock responses
`.trim();

const TASK_QUEUE = "build-pipeline";
const WORKFLOW_ID = "build-app-workflow-001";

// ── Pre-flight: wait for Temporal server ──
async function waitForServer(maxRetries = 15, delayMs = 3000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const conn = await Connection.connect({ address: "localhost:7233" });
      await conn.workflowService.listNamespaces({});
      conn.close();
      console.log("Connected to Temporal server!");
      return;
    } catch {
      console.log(`Waiting for Temporal server... (attempt ${i + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Could not connect to Temporal server at localhost:7233");
}

// ── Auto-trigger workflow ──
async function triggerWorkflow(): Promise<void> {
  const client = new Client({
    connection: await Connection.connect({ address: "localhost:7233" }),
  });

  try {
    console.log(`\nTriggering buildAppWorkflow with spec:\n${APP_SPEC}\n`);
    const handle = await client.workflow.start("buildAppWorkflow", {
      args: [APP_SPEC],
      taskQueue: TASK_QUEUE,
      workflowId: WORKFLOW_ID,
    });
    console.log(`Workflow started — ID: ${handle.workflowId}`);
    const result = await handle.result();
    console.log(`\nWORKFLOW COMPLETE — dist path: ${result}`);
  } catch (err: any) {
    console.error(`\nWORKFLOW FAILED: ${err.message}`);
    if (err.details) {
      console.error("Details:", JSON.stringify(err.details, null, 2));
    }
  } finally {
    client.connection.close();
  }
}

// ── Main ──
async function main(): Promise<void> {
  console.log("=== Temporal Build Pipeline Worker ===\n");
  await waitForServer();

  const connection = await NativeConnection.connect({ address: "localhost:7233" });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: path.join(__dirname, "workflows"),
    activities,
  });

  console.log("Worker created — listening on task queue:", TASK_QUEUE);

  const workerPromise = worker.run();
  const triggerPromise = triggerWorkflow();
  await Promise.race([workerPromise, triggerPromise]);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

**Critical implementation notes (do not change):**

1. **ESM path resolution** — use `fileURLToPath(import.meta.url)` + `path.dirname()`, NOT `require.resolve()`. This project uses `"type": "module"`.
2. **`workflowsPath: path.join(__dirname, "workflows")`** — this must point to the `workflows/` directory that contains `index.ts`. The Temporal worker bundles all exported workflows from this directory.
3. **`client.workflow.start("buildAppWorkflow", {...})`** — use the STRING name, not the function reference. The string must exactly match the exported function name in `workflows/build-app.ts`.
4. **`waitForServer()` runs BEFORE `Worker.create()`** — the Temporal server prints "ready" before it's actually listening. Without the pre-flight check, `Worker.create()` throws `TransportError`.
5. **`Promise.race`** — the worker runs indefinitely, the trigger completes. This keeps the process alive.

---

## STEP 10 — INSTALL DEPENDENCIES

```bash
cd PIPELINE_DIR && pnpm install
```

If `pnpm` is not installed:
```bash
npm install -g pnpm
```

If pnpm warns about blocked build scripts (esbuild, @swc/core, protobufjs):
```bash
cd PIPELINE_DIR && pnpm approve-builds
```
Select all three when prompted. Then:
```bash
pnpm install --force
```

Verify native binary exists:
```bash
ls node_modules/@temporalio/core-bridge/releases/
```
Should contain a directory like `linux-x64-gnu` (or `x86_64-pc-windows-msvc` on Windows) with an `index.node` file.

---

## STEP 11 — VERIFY COMPILATION

```bash
cd PIPELINE_DIR && ./node_modules/.bin/tsc --noEmit
```

Must produce zero errors. If it produces errors, fix them before proceeding.

---

## STEP 12 — START TEMPORAL SERVER (separate terminal)

```bash
temporal server start-dev
```

If the `temporal` CLI is not installed:
```bash
# Linux
curl -sSf https://temporal.download/cli.sh | sh
# OR download from https://github.com/temporalio/cli/releases

# Windows: download temporal_cli_X.X.X_windows_amd64.zip from releases
```

Wait until you see `Temporal Server: localhost:7233` in the output. Then wait an additional 5-10 seconds (the gRPC endpoint is not ready immediately).

---

## STEP 13 — START THE PIPELINE

```bash
cd PIPELINE_DIR && pnpm start
```

This runs `tsx worker.ts` which:
1. Calls `waitForServer()` — confirms Temporal is reachable
2. Creates the Worker — registers activities + workflow
3. Starts the Worker — begins polling for tasks
4. Triggers `buildAppWorkflow` with `APP_SPEC`
5. Logs all progress to console

---

## WHAT HAPPENS AT RUNTIME

```
Phase 1: Scaffold
  compileScaffoldPrompt → Mode A (no error history)
  scaffoldRepo → LLM generates full app, writes to APP_DIR/
  If LLM fails or JSON is invalid → scaffoldAttempts++, retry with Mode B prompt
  If 2 failures → ApplicationFailure("ScaffoldFailed")

Phase 2: Pipeline (up to 3 attempts)
  installDeps → pnpm install --force
  typeCheck   → ./node_modules/.bin/tsc --noEmit
    If fails → compileScaffoldPrompt Mode B → scaffoldRepo patches → resumeFrom="typeCheck"
    If passes → resumeFrom="lint"
  lint        → ./node_modules/.bin/eslint .
    If fails → compileScaffoldPrompt Mode B → scaffoldRepo patches → resumeFrom="lint"
    If passes → resumeFrom="build"
  build       → ./node_modules/.bin/vite build
    If fails → compileScaffoldPrompt Mode B → scaffoldRepo patches → resumeFrom="build"
    If passes → return distPath → WORKFLOW COMPLETE

If 3 pipeline attempts exhausted → ApplicationFailure("PipelineExhausted")
```

---

## SCAFFOLDED APP REQUIREMENTS

The LLM must generate these files on the initial scaffold. The `compileScaffoldPrompt` Mode A prompt already specifies these requirements, but if the LLM fails, the patch loop will fix them. The correct scaffolded app must have:

### `package.json`
```json
{
  "name": "scaffolded-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "eslint-plugin-react-refresh": "^0.4.14",
    "globals": "^15.12.0",
    "typescript": "^5.0.0",
    "vite": "^6.0.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}
```

### `tsconfig.json`
- `include`: `["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]` — MUST be narrow, never `**/*.ts`
- `exclude`: `["node_modules", "dist", "workflows", "activities.ts", "worker.ts"]`
- Do NOT add `"types": ["node"]` (it's already covered by `@types/node` in devDependencies)

### `eslint.config.js`
```javascript
import tsparser from '@typescript-eslint/parser'
import tseslint from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: { 'react-refresh/only-export-components': 'warn' },
  },
]
```

---

## FAILURE LOOKUP TABLE

If you encounter any of these errors, apply the fix exactly:

| # | Error | Fix |
|---|-------|-----|
| 1 | `TransportError: Connection refused` | `waitForServer()` not running or server not started. Start `temporal server start-dev`. |
| 2 | `Worker.create()` throws `TransportError` after server is up | Missing `@temporalio/core-bridge`. Run `pnpm add @temporalio/core-bridge`. Check `node_modules/@temporalio/core-bridge/releases/` has native binary. |
| 3 | `vite build` fails: "esbuild not found" | pnpm 10+ blocks esbuild postinstall. Add `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` to scaffolded package.json. |
| 4 | `eslint .` fails: "Cannot find package eslint-plugin-react-hooks" | Initial scaffold's `eslint.config.js` imports plugins not in package.json. Include ALL ESLint deps in devDependencies from the start. |
| 5 | `defineWorkflow is not a function` or `WorkflowError is not defined` | These APIs don't exist. Use `export async function buildAppWorkflow(...)` and `ApplicationFailure.create()`. |
| 6 | `@swc/core` binding error | Missing platform SWC binary. Run `pnpm add @swc/core-linux-x64-gnu` (Linux) or `@swc/core-win32-x64-msvc` (Windows). |
| 7 | Workflow function not found by worker | Use string name: `client.workflow.start("buildAppWorkflow", {...})`. Match exported function name exactly. |
| 8 | Activity timeout: "Required either scheduleToCloseTimeout or startToCloseTimeout" | Use numeric milliseconds: `scheduleToCloseTimeout: 600000` NOT `"600s"`. |
| 9 | `ReferenceError: require is not defined` | Use `import` syntax everywhere. This project is ESM (`"type": "module"`). |
| 10 | `tsc --noEmit` fails: "Cannot find type definition file for 'node'" | Remove `"types": ["node"]` from scaffolded tsconfig.json, OR add `@types/node` to scaffolded devDependencies. |
| 11 | `tsc --noEmit` fails on `@temporalio/*` imports | Scaffolded tsconfig.json `include` is too broad. Narrow to `["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]`. |
| 12 | `eslint .` fails: "Cannot find package '@eslint/js'" | Missing `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`. Add to scaffolded devDependencies. |
| 13 | `pnpm install` silently skips esbuild | Run `pnpm config set onlyBuiltDependencies "esbuild" --location project` before `pnpm install --force`. |
| 14 | `scaffoldRepo: LLM response was not valid JSON` | LLM wrapped output in code fences or added prose. The strip logic in scaffoldRepo handles ` ```json...``` `. If still failing, increase `max_tokens` or adjust system prompt. |
| 15 | `npx tsc` runs wrong tsc (e.g. `tsc@2.0.4` npm package instead of TypeScript) | **Never use `npx` for any command.** Always use `./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`, `./node_modules/.bin/vite` in all activities. `npx` resolves to global packages or wrong npm packages. |
| 16 | `vite build` fails: "Could not resolve entry module index.html" | vite resolves paths relative to cwd. The `runInAppDir` helper already sets `cwd: APP_DIR`. If testing manually, `cd` into `scaffolded-app/` before running vite. |
| 17 | `installDeps` says "Lockfile is up to date" and skips | Always use `pnpm install --force`. Never use bare `pnpm install`. |
| 18 | `require.resolve is not defined` in worker.ts | Use `fileURLToPath(import.meta.url)` + `path.dirname()` for ESM path resolution. Never use `require.resolve()`. |

---

## CHECKPOINT — verify before running

After all files are written and dependencies installed, verify:

```
[ ] PIPELINE_DIR/package.json exists with "type": "module"
[ ] PIPELINE_DIR/tsconfig.json exists with ESM config
[ ] PIPELINE_DIR/workflows/types.ts exists
[ ] PIPELINE_DIR/workflows/compile-prompt.ts exists
[ ] PIPELINE_DIR/workflows/build-app.ts exists and exports buildAppWorkflow
[ ] PIPELINE_DIR/workflows/index.ts exists and re-exports buildAppWorkflow
[ ] PIPELINE_DIR/activities.ts exists with 5 exported functions
[ ] PIPELINE_DIR/worker.ts exists with waitForServer + auto-trigger
[ ] node_modules/@temporalio/core-bridge/releases/ contains native binary
[ ] ./node_modules/.bin/tsc --noEmit passes with zero errors
[ ] temporal server start-dev is running in another terminal
```

All green? Run `pnpm start`.
