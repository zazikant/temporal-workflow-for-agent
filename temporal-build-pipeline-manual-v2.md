# Agent Scaffold Guide – Vite + React + TypeScript

**Goal** – Create a Vite + React + TS project that compiles with `tsc`, passes `eslint`, and builds with `vite` on the first try.

**Required directory layout (APP_DIR)**
- `package.json`
- `tsconfig.json`
- `eslint.config.js`
- `vite.config.ts`
- `index.html`
- `src/` → `main.tsx`, `App.tsx`, `vite-env.d.ts`

---

## File templates

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

**Important:** The `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` entry is required; without it pnpm 10+ blocks esbuild's post-install step, causing `vite build` to fail. Every devDependency above is non-negotiable — omitting any one causes a lint or typecheck failure.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Important:** `include` must be exactly `["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]`. Do not add `"types": ["node"]`, `"outDir"` or `"declaration"`.

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

**Important:** Use `@typescript-eslint/parser` and `globals`. Do not use `@eslint/js` or any non-existent `reactConfigs`. All four imports correspond to packages listed in `devDependencies`.

### `vite.config.ts`

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

### `index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Rule:** The file must contain `<div id="root"></div>` and a `<script type="module" src="/src/main.tsx"></script>` tag.

### `src/main.tsx`

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

### `src/App.tsx`

```typescript
function App() {
  return <div>Hello World</div>
}

export default App
```

*Feel free to modify the component's content to meet the user's requirements.*

### `src/vite-env.d.ts`

```typescript
/// <reference types="vite/client" />
```

**Rule:** This file is mandatory. Without it `tsc --noEmit` will fail on CSS module imports and Vite-specific type declarations.

---

## Verification pipeline – run inside `APP_DIR` in the order shown

```bash
# 1. Install dependencies
pnpm config set onlyBuiltDependencies 'esbuild' --location project 2>/dev/null
pnpm install --force

# 2. Type-check
./node_modules/.bin/tsc --noEmit

# 3. Lint
./node_modules/.bin/eslint .

# 4. Build
./node_modules/.bin/vite build
```

All steps must succeed; fix any errors and repeat from the failing stage.

---

## Non-negotiable rules (DO NOT BREAK)

1. Never use `npx`. Invoke binaries via `./node_modules/.bin/<command>`.
2. Never run plain `pnpm install`. Always use `pnpm install --force`.
3. Never use `require()`. The project is ESM; use `import`.
4. Never import `@eslint/js` or any `reactConfigs`. Use `@typescript-eslint/parser` + `globals`.
5. Never omit `vite-env.d.ts`.
6. Never broaden the `include` array in `tsconfig.json`.

---

## Quick-fix reference table

| # | Error | Remedy |
|---|-------|--------|
| 1 | `vite build` → "esbuild not found" | Add `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` to package.json. Run `pnpm config set onlyBuiltDependencies 'esbuild' --location project`. |
| 2 | `eslint .` → "Cannot find package eslint-plugin-react-hooks" | Add ALL eslint deps to devDependencies: `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`. |
| 3 | `tsc --noEmit` → "Cannot find type definition file for 'node'" | Remove `"types": ["node"]` from tsconfig.json, OR add `@types/node` to devDependencies. |
| 4 | `tsc --noEmit` → fails on unrelated imports | tsconfig.json `include` is too broad. Narrow to `["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]`. |
| 5 | `eslint .` → "Cannot find package '@eslint/js'" | Use `@typescript-eslint/parser` and `globals` instead. Do NOT use `@eslint/js`. |
| 6 | `pnpm install` → silently skips esbuild | Run `pnpm config set onlyBuiltDependencies "esbuild" --location project` before `pnpm install --force`. |
| 7 | `npx tsc` → runs wrong tsc (e.g. `tsc@2.0.4`) | Never use `npx`. Always use `./node_modules/.bin/tsc`. |
| 8 | `vite build` → "Could not resolve entry module index.html" | Run vite from inside `APP_DIR/`, or ensure `cwd` is set correctly. |
| 9 | `pnpm install` → "Lockfile is up to date" | Always `pnpm install --force`. Never bare `pnpm install`. |
| 10 | `eslint .` → "Cannot find module 'globals'" | Add `"globals": "^15.12.0"` to devDependencies. |
| 11 | `tsc --noEmit` → fails on CSS module imports | Missing `vite-env.d.ts` with `/// <reference types="vite/client" />`. |
| 12 | `ReferenceError: require is not defined` | Use `import` syntax. Project is ESM. |
| 13 | `tsc --noEmit` → "Cannot find module './App.module.css'" | Add `vite-env.d.ts`. Vite handles CSS imports at build time; TypeScript needs the declaration shim. |
| 14 | `eslint` → "Cannot find module '@typescript-eslint/parser'" | All eslint plugin packages must be in devDependencies AND import names must match package names exactly. |