import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";

const execAsync = promisify(exec);

const APP_DIR = "D:\\test\\app-chat";

export async function scaffoldRepo(compiledPrompt: string): Promise<{
  filesChanged: string[];
  changeSummary: string[];
}> {
  console.log("[scaffoldRepo] Running scaffold with prompt:", compiledPrompt.substring(0, 100) + "...");

  const files: string[] = [];
  const summary: string[] = [];

  const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})`;
  await writeFile(`${APP_DIR}\\vite.config.ts`, viteConfig);
  files.push("vite.config.ts");
  summary.push("Vite config with React plugin");

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;
  await writeFile(`${APP_DIR}\\index.html`, indexHtml);
  files.push("index.html");
  summary.push("HTML entry point");

  await execAsync(`mkdir /s /q ${APP_DIR}\\src`, { cwd: APP_DIR }).catch(() => {});

  const mainTsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)`;
  await writeFile(`${APP_DIR}\\src\\main.tsx`, mainTsx);
  files.push("src/main.tsx");
  summary.push("React entry point");

  const appTsx = `export default function App() {
  return <div>Hello World</div>
}`;
  await writeFile(`${APP_DIR}\\src\\App.tsx`, appTsx);
  files.push("src/App.tsx");
  summary.push("Main App component");

const packageJson = `{
  "name": "app-chat",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "tsx worker.ts",
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview"
  },
  "dependencies": {
    "@temporalio/client": "^1.0.0",
    "@temporalio/workflow": "^1.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@temporalio/activity": "^1.0.0",
    "@temporalio/core-bridge": "^1.0.0",
    "@temporalio/worker": "^1.0.0",
    "@swc/core-win32-x64-msvc": "^1.0.0",
    "@esbuild/win32-x64": "^0.25.0",
    "@typescript-eslint/eslint-plugin": "^8.59.0",
    "@typescript-eslint/parser": "^8.59.0",
    "@vitejs/plugin-react": "^4.0.0",
    "eslint": "^9.0.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "eslint-plugin-react-refresh": "^0.4.14",
    "globals": "^15.12.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vite": "^6.0.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}`;
  await writeFile(`${APP_DIR}\\package.json`, packageJson);
  files.push("package.json");
  summary.push("Package config with all deps");

  const eslintConfig = `import tsparser from '@typescript-eslint/parser'
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
]`;
  await writeFile(`${APP_DIR}\\eslint.config.js`, eslintConfig);
  files.push("eslint.config.js");
  summary.push("ESLint flat config");

  return { filesChanged: files, changeSummary: summary };
}

export async function installDeps(): Promise<void> {
  console.log("[installDeps] Running pnpm install...");
  try {
    await execAsync("pnpm install --force", { cwd: APP_DIR });
    console.log("[installDeps] Done");
  } catch (e: any) {
    console.log("[installDeps] Error:", e.message);
  }
}

export async function typeCheck(): Promise<{ ok: boolean; error?: string }> {
  console.log("[typeCheck] Running tsc --noEmit...");
  try {
    await execAsync("npx tsc --noEmit", { cwd: APP_DIR });
    console.log("[typeCheck] OK");
    return { ok: true };
  } catch (e: any) {
    console.log("[typeCheck] Error:", e.message);
    return { ok: false, error: e.message };
  }
}

export async function lint(): Promise<{ ok: boolean; error?: string }> {
  console.log("[lint] Running eslint .");
  try {
    await execAsync("npx eslint .", { cwd: APP_DIR });
    console.log("[lint] OK");
    return { ok: true };
  } catch (e: any) {
    console.log("[lint] Error:", e.message);
    return { ok: false, error: e.message };
  }
}

export async function build(): Promise<{ ok: boolean; error?: string; distPath?: string }> {
  console.log("[build] Running vite build...");
  try {
    await execAsync("npx vite build", { cwd: APP_DIR });
    console.log("[build] OK");
    return { ok: true, distPath: `${APP_DIR}\\dist` };
  } catch (e: any) {
    console.log("[build] Error:", e.message);
    return { ok: false, error: e.message };
  }
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}