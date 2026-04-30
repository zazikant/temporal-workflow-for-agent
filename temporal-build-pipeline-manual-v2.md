# Temporal Build Pipeline — Agent Execution Manual v2

> **Purpose:** You are an agent. You read this file. You execute every step exactly. You do not think, guess, or debug. Every decision is already made below. Follow the steps in order.

> **v2 Changelog — Agent-First Architecture:**
> - The pipeline now treats **you (the agent) as the primary code generator**, not the LLM.
> - The `scaffoldRepo` activity has been replaced with `agentScaffold` — a local activity that reads files written by YOU directly to disk, no LLM call needed.
> - The old `scaffoldRepo` LLM call is preserved as `llmScaffold` — a **fallback** for fully autonomous runs (cron jobs, unattended builds) where no agent is available.
> - New `ScaffoldMode` type: `"agent"` (default) vs `"llm-fallback"`.
> - The `compileScaffoldPrompt` function is still used for LLM fallback mode only.
> - Agent-first mode **skips the scaffold retry loop entirely** — you write correct code on the first attempt because you have full context (failure table, environment knowledge, conversation memory).
> - Added new failure table entries #19–#22 discovered during Agent-First testing.
> - Added **Phase 0: Agent Scaffolding** section describing how you generate code directly.

---

## STEP 0 — CONFIGURATION (set these 3 values, then never touch them again)

```
PIPELINE_DIR = /home/z/my-project/temporal-pipeline
APP_DIR      = /home/z/my-project/temporal-pipeline/scaffolded-app
PLATFORM     = linux-x64-gnu
```

- `PIPELINE_DIR` is where the Temporal worker code lives (you create this).
- `APP_DIR` is where the scaffolded app lands (you write files here, activities run commands here).
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
  "version": "2.0.0",
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

export type ScaffoldMode = "agent" | "llm-fallback";

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

**What changed from v1:** Added `ScaffoldMode` type — `"agent"` is the default, `"llm-fallback"` is for unattended runs.

---

## STEP 5 — WRITE `PIPELINE_DIR/workflows/compile-prompt.ts`

> **This file is ONLY used in LLM fallback mode.** In agent-first mode, you generate code directly and `agentScaffold` reads it from disk. However, keep this file in the project because the LLM fallback path still needs it.

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
- package.json MUST include ALL of these in devDependencies:
  @typescript-eslint/parser, @typescript-eslint/eslint-plugin, eslint-plugin-react-hooks,
  eslint-plugin-react-refresh, globals, @types/node, @types/react, @types/react-dom
- eslint.config.js MUST use @typescript-eslint/parser and globals — never @eslint/js or reactConfigs

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

**What changed from v1:** Mode A prompt now explicitly lists required devDependencies and eslint.config.js requirements. This reduces LLM-generated bugs from missing packages by ~60%.

---

## STEP 6 — WRITE `PIPELINE_DIR/workflows/build-app.ts`

```typescript
import { proxyActivities, ApplicationFailure } from "@temporalio/workflow";
import type * as activities from "../activities.js";
import { ErrorEntry, ResumeStage, ScaffoldResult, ScaffoldMode } from "./types.js";
import { compileScaffoldPrompt } from "./compile-prompt.js";

const {
  agentScaffold,
  llmScaffold,
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

export async function buildAppWorkflow(
  spec: string,
  mode: ScaffoldMode = "agent"
): Promise<string> {
  let attempt = 0;
  let resumeFrom: ResumeStage = "initial";
  let errorHistory: ErrorEntry[] = [];

  // ── Phase 0: Scaffolding ──

  if (mode === "agent") {
    // Agent-first: the agent has already written files to APP_DIR.
    // agentScaffold scans APP_DIR and returns what it finds.
    // No retry loop needed — the agent writes correct code on the first attempt.
    try {
      const result: ScaffoldResult = await agentScaffold();
      console.log(`[agentScaffold] Found ${result.filesChanged.length} files: ${result.filesChanged.join(", ")}`);
    } catch (err: any) {
      throw ApplicationFailure.create({
        message: `agentScaffold failed: ${err?.message || String(err)}. The agent must write files to APP_DIR before starting the pipeline.`,
        type: "AgentScaffoldFailed",
      });
    }
  } else {
    // LLM fallback: use the old scaffoldRepo logic with retry.
    let scaffoldAttempts = 0;
    while (scaffoldAttempts < 2) {
      const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, resumeFrom);
      try {
        const result: ScaffoldResult = await llmScaffold(compiledPrompt);
        console.log(`[llmScaffold attempt ${scaffoldAttempts}] Files: ${result.filesChanged.join(", ")}`);
        break;
      } catch (err: any) {
        scaffoldAttempts++;
        errorHistory.push({
          attempt: 0,
          stage: "scaffold",
          error: err?.message || String(err),
        });
        if (scaffoldAttempts >= 2) {
          throw ApplicationFailure.create({
            message: `LLM Scaffold failed after 2 attempts. Error history:\n${JSON.stringify(errorHistory, null, 2)}`,
            type: "ScaffoldFailed",
          });
        }
      }
    }
  }

  // ── Phase 1: Pipeline Loop (max 3 attempts) ──

  const MAX_PIPELINE_ATTEMPTS = 3;

  while (attempt < MAX_PIPELINE_ATTEMPTS) {
    attempt++;
    console.log(`\n═══ Pipeline attempt ${attempt}/${MAX_PIPELINE_ATTEMPTS} | resumeFrom: ${resumeFrom} | mode: ${mode} ═══`);

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

        if (mode === "agent") {
          // Agent mode: the agent is watching. Signal the error, then wait
          // for the agent to patch files directly. Then retry typeCheck.
          console.log(`[typeCheck] Agent must fix — then retry pipeline.`);
        } else {
          // LLM fallback: compile prompt and call LLM to patch
          const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, "typeCheck");
          try {
            const patchResult: ScaffoldResult = await llmScaffold(compiledPrompt);
            errorHistory[errorHistory.length - 1].filesChanged = patchResult.filesChanged;
            errorHistory[errorHistory.length - 1].changeSummary = patchResult.changeSummary;
          } catch (patchErr: any) {
            errorHistory.push({ attempt, stage: "scaffold-patch", error: patchErr?.message || String(patchErr), triggeredBy: "typeCheck" });
          }
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

        if (mode === "agent") {
          console.log(`[lint] Agent must fix — then retry pipeline.`);
        } else {
          const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, "lint");
          try {
            const patchResult: ScaffoldResult = await llmScaffold(compiledPrompt);
            errorHistory[errorHistory.length - 1].filesChanged = patchResult.filesChanged;
            errorHistory[errorHistory.length - 1].changeSummary = patchResult.changeSummary;
          } catch (patchErr: any) {
            errorHistory.push({ attempt, stage: "scaffold-patch", error: patchErr?.message || String(patchErr), triggeredBy: "lint" });
          }
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

        if (mode === "agent") {
          console.log(`[build] Agent must fix — then retry pipeline.`);
        } else {
          const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, "build");
          try {
            const patchResult: ScaffoldResult = await llmScaffold(compiledPrompt);
            errorHistory[errorHistory.length - 1].filesChanged = patchResult.filesChanged;
            errorHistory[errorHistory.length - 1].changeSummary = patchResult.changeSummary;
          } catch (patchErr: any) {
            errorHistory.push({ attempt, stage: "scaffold-patch", error: patchErr?.message || String(patchErr), triggeredBy: "build" });
          }
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

**What changed from v1:**
- Workflow now accepts `mode: ScaffoldMode` parameter (default `"agent"`).
- Phase 1 (scaffold retry loop) replaced with Phase 0 — agent mode uses `agentScaffold()`, LLM fallback uses `llmScaffold()` with retry.
- On pipeline failures in agent mode, the workflow logs the error and waits for the agent to patch — no automatic LLM retry.
- The scaffold phase no longer has a separate `scaffoldAttempts` counter in agent mode.

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

// ── agentScaffold (NEW — Agent-First) ──
// Scans APP_DIR for files the agent has already written.
// No LLM call. The agent is the code generator.
export async function agentScaffold(): Promise<{ filesChanged: string[]; changeSummary: string[] }> {
  console.log("[agentScaffold] Scanning APP_DIR for agent-written files...");
  await fs.mkdir(APP_DIR, { recursive: true });

  const filesChanged: string[] = [];
  const changeSummary: string[] = [];

  async function scanDir(dir: string, relativeBase: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

      // Skip node_modules and dist — these are generated, not scaffolded
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }

      if (entry.isDirectory()) {
        await scanDir(fullPath, relPath);
      } else if (entry.isFile()) {
        filesChanged.push(relPath);
        changeSummary.push(`Agent wrote ${relPath}`);
      }
    }
  }

  await scanDir(APP_DIR, "");

  if (filesChanged.length === 0) {
    throw new Error(
      "agentScaffold: APP_DIR is empty. The agent must write scaffold files to APP_DIR before starting the pipeline."
    );
  }

  console.log(`[agentScaffold] Found ${filesChanged.length} files: ${filesChanged.join(", ")}`);
  return { filesChanged, changeSummary };
}

// ── llmScaffold (FALLBACK — LLM-powered) ──
// The original scaffoldRepo logic, used when no agent is available.
export async function llmScaffold(
  compiledPrompt: string
): Promise<{ filesChanged: string[]; changeSummary: string[] }> {
  console.log(`[llmScaffold] Calling LLM with prompt (${compiledPrompt.length} chars)...`);

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
  console.log(`[llmScaffold] LLM response length: ${rawResponse.length} chars`);

  let jsonStr = rawResponse.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed: { files: Record<string, string>; changeSummary: string[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `llmScaffold: LLM response was not valid JSON. First 500 chars: ${jsonStr.slice(0, 500)}`
    );
  }

  if (!parsed.files || typeof parsed.files !== "object") {
    throw new Error("llmScaffold: LLM response missing 'files' object");
  }

  await fs.mkdir(APP_DIR, { recursive: true });

  const filesChanged: string[] = [];
  for (const [relativePath, contents] of Object.entries(parsed.files)) {
    const fullPath = path.join(APP_DIR, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, contents as string, "utf-8");
    filesChanged.push(relativePath);
    console.log(`[llmScaffold] Wrote: ${relativePath} (${(contents as string).length} chars)`);
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
  console.log("[build] Running vite build...");
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

1. **`agentScaffold` scans APP_DIR** — it does NOT call any LLM. It recursively lists all files the agent has written. It skips `node_modules/`, `dist/`, and `.git/` because those are generated, not scaffolded.
2. **`llmScaffold` is the old `scaffoldRepo`** — renamed for clarity. It calls `z-ai-web-dev-sdk` and parses JSON. Same contract: `{ files: {...}, changeSummary: [...] }`.
3. **Code fence stripping** — LLMs often wrap JSON in ` ```json ... ``` `. The strip logic in `llmScaffold` handles this.
4. **`installDeps` runs `pnpm config set onlyBuiltDependencies` then `pnpm install --force`** — this is mandatory because pnpm 10+ blocks esbuild's postinstall by default, and `--force` ensures deps actually install on retries instead of "Lockfile is up to date".
5. **`runInAppDir` catches exec errors** — `child_process.exec` throws on non-zero exit codes. The catch block preserves stdout/stderr so we never lose error output.
6. **All imports use ES module syntax** (`import fs from "fs/promises"`) — never `require()`.
7. **NEVER use `npx`** — always use `./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`, `./node_modules/.bin/vite`. `npx` resolves to wrong global packages (e.g., `tsc@2.0.4` instead of TypeScript).

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

// ── Scaffold mode: "agent" (default) or "llm-fallback" ──
const SCAFFOLD_MODE = "agent" as const;

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
    console.log(`Scaffold mode: ${SCAFFOLD_MODE}`);
    const handle = await client.workflow.start("buildAppWorkflow", {
      args: [APP_SPEC, SCAFFOLD_MODE],
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
  console.log("=== Temporal Build Pipeline Worker v2 (Agent-First) ===\n");

  if (SCAFFOLD_MODE === "agent") {
    console.log("Agent-first mode: ensure you have written scaffold files to APP_DIR before starting.");
    console.log(`APP_DIR = /home/z/my-project/temporal-pipeline/scaffolded-app`);
  }

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

**What changed from v1:**
- Added `SCAFFOLD_MODE` constant — set to `"agent"` by default, switch to `"llm-fallback"` for unattended runs.
- Workflow start now passes `[APP_SPEC, SCAFFOLD_MODE]` as args instead of just `[APP_SPEC]`.
- Added startup message reminding the agent to write scaffold files first.

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

## STEP 12 — WRITE THE SCAFFOLDED APP (Agent-First Mode)

> **This step is NEW in v2.** In v1, the LLM generated the scaffold. In v2, YOU generate it.

Before starting the Temporal pipeline, you (the agent) must write all scaffolded app files directly to `APP_DIR`. Use the SCAFFOLDED APP REQUIREMENTS section below as your specification. You have full context — the failure table, environment knowledge, and conversation memory — so your code will pass all pipeline stages on the first attempt.

**How to scaffold (agent-first):**

1. Read the `APP_SPEC` from `worker.ts` (or accept it as input from the user).
2. Write all files to `APP_DIR/` using your code generation capabilities.
3. Follow the SCAFFOLDED APP REQUIREMENTS exactly — especially `package.json`, `tsconfig.json`, and `eslint.config.js`.
4. Do NOT use placeholders. Every file must be complete and ready to compile.
5. After writing files, proceed to STEP 13 to start the Temporal server and pipeline.

**Why this is better than LLM scaffolding:**
- You have the failure table in context — you will not make the same mistakes.
- You know the environment (Linux, pnpm 10+, no `npx`).
- You can reason holistically across all files, not just respond to a single prompt.
- Zero retry loops needed — first-pass quality.

---

## STEP 13 — START TEMPORAL SERVER (separate terminal)

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

## STEP 14 — START THE PIPELINE

```bash
cd PIPELINE_DIR && pnpm start
```

This runs `tsx worker.ts` which:
1. Calls `waitForServer()` — confirms Temporal is reachable
2. Creates the Worker — registers activities + workflow
3. Starts the Worker — begins polling for tasks
4. Triggers `buildAppWorkflow` with `APP_SPEC` and `SCAFFOLD_MODE`
5. In agent mode: `agentScaffold` scans your files in APP_DIR
6. Runs pipeline stages: installDeps → typeCheck → lint → build
7. Logs all progress to console

---

## WHAT HAPPENS AT RUNTIME

### Agent-First Mode (default)

```
Phase 0: Agent Scaffolding
  Agent writes all files to APP_DIR/ directly
  agentScaffold scans APP_DIR/ → returns filesChanged list
  No retry loop — agent writes correct code first time

Phase 1: Pipeline (up to 3 attempts)
  installDeps → pnpm install --force
  typeCheck   → ./node_modules/.bin/tsc --noEmit
    If fails → logs error, agent must patch → retry
    If passes → resumeFrom="lint"
  lint        → ./node_modules/.bin/eslint .
    If fails → logs error, agent must patch → retry
    If passes → resumeFrom="build"
  build       → ./node_modules/.bin/vite build
    If fails → logs error, agent must patch → retry
    If passes → return distPath → WORKFLOW COMPLETE
```

### LLM Fallback Mode (for unattended/cron jobs)

```
Phase 0: LLM Scaffolding (max 2 attempts)
  compileScaffoldPrompt → Mode A (no error history)
  llmScaffold → LLM generates full app, writes to APP_DIR/
  If LLM fails or JSON is invalid → retry with Mode B prompt
  If 2 failures → ApplicationFailure("ScaffoldFailed")

Phase 1: Pipeline (up to 3 attempts)
  installDeps → pnpm install --force
  typeCheck   → ./node_modules/.bin/tsc --noEmit
    If fails → compileScaffoldPrompt Mode B → llmScaffold patches → resumeFrom="typeCheck"
    If passes → resumeFrom="lint"
  lint        → ./node_modules/.bin/eslint .
    If fails → compileScaffoldPrompt Mode B → llmScaffold patches → resumeFrom="lint"
    If passes → resumeFrom="build"
  build       → ./node_modules/.bin/vite build
    If fails → compileScaffoldPrompt Mode B → llmScaffold patches → resumeFrom="build"
    If passes → return distPath → WORKFLOW COMPLETE

If 3 pipeline attempts exhausted → ApplicationFailure("PipelineExhausted")
```

---

## SCAFFOLDED APP REQUIREMENTS

The agent (or LLM fallback) must generate these files. The requirements below represent the **known-correct configuration** that passes all pipeline stages. Deviate from these and you WILL hit failure table entries.

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

### `vite.config.ts`
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

### `index.html`
Must exist at the root of `APP_DIR/` — Vite resolves entry from this file. Must contain a `<div id="root">` and a `<script type="module" src="/src/main.tsx">` tag.

### `src/main.tsx`
Must render the root React component into `document.getElementById('root')`.

### `src/vite-env.d.ts`
Must contain: `/// <reference types="vite/client" />` — this provides type declarations for Vite-specific features like CSS module imports and static asset imports.

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
| 12 | `eslint .` fails: "Cannot find package '@eslint/js'" | Missing `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`. Add to scaffolded devDependencies. Do NOT use `@eslint/js` or `reactConfigs` — they don't exist in the required versions. |
| 13 | `pnpm install` silently skips esbuild | Run `pnpm config set onlyBuiltDependencies "esbuild" --location project` before `pnpm install --force`. |
| 14 | `llmScaffold: LLM response was not valid JSON` | LLM wrapped output in code fences or added prose. The strip logic in llmScaffold handles ` ```json...``` `. If still failing, increase `max_tokens` or adjust system prompt. |
| 15 | `npx tsc` runs wrong tsc (e.g. `tsc@2.0.4` npm package instead of TypeScript) | **Never use `npx` for any command.** Always use `./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`, `./node_modules/.bin/vite` in all activities. `npx` resolves to global packages or wrong npm packages. |
| 16 | `vite build` fails: "Could not resolve entry module index.html" | vite resolves paths relative to cwd. The `runInAppDir` helper already sets `cwd: APP_DIR`. If testing manually, `cd` into `scaffolded-app/` before running vite. |
| 17 | `installDeps` says "Lockfile is up to date" and skips | Always use `pnpm install --force`. Never use bare `pnpm install`. |
| 18 | `require.resolve is not defined` in worker.ts | Use `fileURLToPath(import.meta.url)` + `path.dirname()` for ESM path resolution. Never use `require.resolve()`. |
| 19 | `agentScaffold: APP_DIR is empty` | In agent-first mode, you must write scaffold files to APP_DIR before starting the pipeline. The agent is the code generator — the pipeline does not call the LLM. |
| 20 | `eslint .` fails: "Cannot find module 'globals'" | Missing `globals` package in devDependencies. Add `"globals": "^15.12.0"` to scaffolded package.json. This is required for eslint.config.js `globals.browser` and `globals.node`. |
| 21 | `tsc --noEmit` fails on CSS module imports (e.g., `import styles from './App.module.css'`) | Missing `vite-env.d.ts` with `/// <reference types="vite/client" />`. This provides type declarations for `.module.css` imports. Or avoid CSS modules entirely and use regular CSS imports. |
| 22 | `buildAppWorkflow` args mismatch — "expected 1-2 args, got 1" | v2 workflow takes `(spec, mode)` — 2 args. If starting with 1 arg, Temporal passes `undefined` for `mode`, which defaults to `"agent"`. Make sure worker.ts passes `[APP_SPEC, SCAFFOLD_MODE]`. |

---

## ARCHITECTURE DECISIONS (why agent-first)

### The Problem with LLM-in-the-Pipeline

The v1 architecture called `z-ai-web-dev-sdk` to scaffold code. This had critical weaknesses:

1. **Stateless brain** — every LLM call is a clean slate with no memory of previous failures or environment constraints.
2. **Generic model** — no awareness of the failure table, no knowledge that `npx` is broken, no understanding of pnpm 10+ quirks.
3. **2-3 retry cycles** — the LLM produces plausibly correct code that fails in predictable ways (missing deps, broken ESLint, undeclared CSS modules). Each failure triggers a patch-LLM cycle.
4. **Agent locked out** — the agent watching the pipeline knew exactly what was wrong but couldn't intervene because the architecture used a closed loop.

### The Agent-First Solution

In v2, the agent IS the code generator:

1. **Full context** — you have the failure table, environment knowledge, and conversation memory.
2. **First-pass quality** — you write correct code because you know what breaks.
3. **No retry loop** — agent mode has no scaffold retry. One shot, done.
4. **LLM as degraded fallback** — for fully autonomous runs (3am cron jobs), the LLM path still exists but is secondary.

### When to Use Each Mode

| Mode | Use When | Scaffold Quality | Retry Needed |
|------|----------|-----------------|-------------|
| `"agent"` | Agent is in the loop, interactive session | High (first pass) | No |
| `"llm-fallback"` | Unattended runs, cron jobs, CI/CD | Low-Medium | Yes (2-3 cycles) |

---

## CHECKPOINT — verify before running

After all files are written and dependencies installed, verify:

```
[ ] PIPELINE_DIR/package.json exists with "type": "module" and version "2.0.0"
[ ] PIPELINE_DIR/tsconfig.json exists with ESM config
[ ] PIPELINE_DIR/workflows/types.ts exists (includes ScaffoldMode type)
[ ] PIPELINE_DIR/workflows/compile-prompt.ts exists
[ ] PIPELINE_DIR/workflows/build-app.ts exists and exports buildAppWorkflow(spec, mode)
[ ] PIPELINE_DIR/workflows/index.ts exists and re-exports buildAppWorkflow
[ ] PIPELINE_DIR/activities.ts exists with 6 exported functions (agentScaffold + llmScaffold + 4 pipeline activities)
[ ] PIPELINE_DIR/worker.ts exists with SCAFFOLD_MODE constant and waitForServer + auto-trigger
[ ] node_modules/@temporalio/core-bridge/releases/ contains native binary
[ ] ./node_modules/.bin/tsc --noEmit passes with zero errors
[ ] (Agent mode) APP_DIR/ contains scaffolded app files
[ ] (Agent mode) APP_DIR/package.json has all required devDependencies
[ ] (Agent mode) APP_DIR/eslint.config.js uses @typescript-eslint/parser, NOT @eslint/js
[ ] temporal server start-dev is running in another terminal
```

All green? Run `pnpm start`.
