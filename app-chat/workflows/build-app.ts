import { proxyActivities } from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/workflow";

interface ErrorEntry {
  attempt: number;
  stage: "scaffold" | "scaffold-patch" | "typeCheck" | "lint" | "build";
  error: string;
  filesChanged?: string[];
  changeSummary?: string[];
  triggeredBy?: string;
}

const { scaffoldRepo, installDeps, typeCheck, lint, build } = proxyActivities({
  scheduleToCloseTimeout: 600000,
  startToCloseTimeout: 600000,
});

function compileScaffoldPrompt(
  spec: string,
  errorHistory: ErrorEntry[],
  attempt: number,
  resumeFrom: string
): string {
  if (errorHistory.length === 0) {
    return `You are scaffolding a new app from scratch.
Spec: ${spec}
Requirements:
- Vite + React + TypeScript
- Create eslint.config.js with sensible flat config defaults
- All files must compile cleanly with tsc --noEmit and eslint
Return: a list of every file you created and a one-line summary of what each does.`.trim();
  }

  const latest = errorHistory[errorHistory.length - 1];
  const previousFixes = errorHistory.slice(0, -1).map(e =>
    `  Attempt ${e.attempt} | ${e.stage}${e.triggeredBy ? ` (fixing ${e.triggeredBy})` : ""}:
     Files changed: ${(e.filesChanged || []).join(", ")}
     What changed: ${(e.changeSummary || []).join("; ")}`
  ).join("\n");

  return `You are making a surgical fix to an existing app.
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
- Return the exact list of files you changed and a one-line summary of what you changed in each.`.trim();
}

export async function buildAppWorkflow(spec: string): Promise<string> {
  let scaffoldAttempts = 0;
  let attempt = 0;
  let resumeFrom: "initial" | "typeCheck" | "lint" | "build" = "initial";
  let errorHistory: ErrorEntry[] = [];

  while (scaffoldAttempts < 2) {
    const compiledPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, resumeFrom);
    try {
      await scaffoldRepo(compiledPrompt);
      break;
    } catch (e) {
      scaffoldAttempts++;
      errorHistory.push({ attempt: 0, stage: "scaffold", error: String(e) });
      if (scaffoldAttempts >= 2) {
        throw ApplicationFailure.create({ message: JSON.stringify(errorHistory), type: "ScaffoldFailed" });
      }
    }
  }

  while (attempt < 3) {
    attempt++;
    await installDeps();

    if (resumeFrom === "initial" || resumeFrom === "typeCheck") {
      const typeCheckResult = await typeCheck();
      if (!typeCheckResult.ok) {
        errorHistory.push({ attempt, stage: "typeCheck", error: typeCheckResult.error || "Type check failed" });
        const patchPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, resumeFrom);
        try {
          await scaffoldRepo(patchPrompt);
        } catch (e) {
          errorHistory.push({ attempt, stage: "scaffold-patch", error: String(e), triggeredBy: "typeCheck" });
          resumeFrom = "typeCheck";
          continue;
        }
        resumeFrom = "typeCheck";
        continue;
      }
      resumeFrom = "lint";
    }

    if (resumeFrom === "lint") {
      const lintResult = await lint();
      if (!lintResult.ok) {
        errorHistory.push({ attempt, stage: "lint", error: lintResult.error || "Lint failed" });
        const patchPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, resumeFrom);
        try {
          await scaffoldRepo(patchPrompt);
        } catch (e) {
          errorHistory.push({ attempt, stage: "scaffold-patch", error: String(e), triggeredBy: "lint" });
          resumeFrom = "lint";
          continue;
        }
        resumeFrom = "lint";
        continue;
      }
      resumeFrom = "build";
    }

    if (resumeFrom === "build") {
      const buildResult = await build();
      if (!buildResult.ok) {
        errorHistory.push({ attempt, stage: "build", error: buildResult.error || "Build failed" });
        const patchPrompt = compileScaffoldPrompt(spec, errorHistory, attempt, resumeFrom);
        try {
          await scaffoldRepo(patchPrompt);
        } catch (e) {
          errorHistory.push({ attempt, stage: "scaffold-patch", error: String(e), triggeredBy: "build" });
          resumeFrom = "build";
          continue;
        }
        resumeFrom = "build";
        continue;
      }
      return buildResult.distPath || "dist";
    }
  }

  throw ApplicationFailure.create({ message: JSON.stringify(errorHistory), type: "PipelineFailed" });
}