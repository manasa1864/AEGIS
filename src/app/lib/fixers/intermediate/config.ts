// Intermediate / Configuration Errors
// Covers: invalid workflow triggers, missing config files, broken env mapping,
// GitLab CI include path issues, workflow_dispatch missing inputs, actions deprecation,
// Prettier, ESLint v9 flat config, EditorConfig, Playwright, Vitest config.

import { RuleFix, isGitHubWorkflow, isGitLabCI, isYAML, injectWorkflowLevelBlock, insertStepBefore, patchGitHubJobBlocks } from '../helpers';

/** Upgrade deprecated GitHub Actions versions to Node.js 24-compatible releases. */
export function fixActionsVersionUpgrade(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Node\.js\s*(?:12|16|20).*deprecat|deprecated version of|actions?\b.*deprecat|deprecat.*\bactions?\b|set-output.*deprecated|save-state.*deprecated|FORCE_JAVASCRIPT_ACTIONS_TO_NODE24|will be forced to run with Node\.js 24/i.test(logs)) return [];
  const UPGRADES: Record<string, string> = {
    'actions/checkout@v3': 'actions/checkout@v4',
    'actions/checkout@v2': 'actions/checkout@v4',
    'actions/checkout@v1': 'actions/checkout@v4',
    'actions/setup-node@v3': 'actions/setup-node@v4',
    'actions/setup-node@v2': 'actions/setup-node@v4',
    'actions/upload-artifact@v3': 'actions/upload-artifact@v4',
    'actions/upload-artifact@v2': 'actions/upload-artifact@v4',
    'actions/download-artifact@v3': 'actions/download-artifact@v4',
    'actions/download-artifact@v2': 'actions/download-artifact@v4',
    'actions/cache@v3': 'actions/cache@v4',
    'actions/cache@v2': 'actions/cache@v4',
    'actions/setup-python@v4': 'actions/setup-python@v5',
    'actions/setup-python@v3': 'actions/setup-python@v5',
    'actions/setup-java@v3': 'actions/setup-java@v4',
    'actions/setup-go@v4': 'actions/setup-go@v5',
    'docker/login-action@v2': 'docker/login-action@v3',
    'docker/build-push-action@v4': 'docker/build-push-action@v5',
    'docker/build-push-action@v3': 'docker/build-push-action@v5',
    'docker/metadata-action@v4': 'docker/metadata-action@v5',
    'docker/setup-buildx-action@v2': 'docker/setup-buildx-action@v3',
    'codecov/codecov-action@v3': 'codecov/codecov-action@v4',
  };
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    let content = f.content;
    for (const [old, next] of Object.entries(UPGRADES)) content = content.split(old).join(next);
    if (!content.includes('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24')) {
      const envBlockRe = /^(env:\s*\n(?:  [^\n]+\n)*)/m;
      content = envBlockRe.test(content)
        ? content.replace(envBlockRe, '$1  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n')
        : content.replace(/^(jobs:)/m, 'env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n\n$1');
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Upgraded deprecated action versions (v1-v3 → v4/v5) + added FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 — GitHub is forcing Node.js 20 actions to run on Node.js 24 starting June 2026; old action versions fail with module compatibility errors', confidence: 100 });
  }
  return fixes;
}

/** Add permissions block when 403 / resource not accessible errors are detected. */
export function fixMissingPermissions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/resource not accessible by integration|403.*forbidden|permission.*denied.*github|refusing to allow/i.test(logs)) return [];
  const needsPR  = /pull.request|create.*pr|open.*pr|merge/i.test(logs);
  const needsPkg = /packages/i.test(logs);
  const needsId  = /id.?token/i.test(logs);
  const entries = ['  contents: write'];
  if (needsPR)  entries.push('  pull-requests: write');
  if (needsPkg) entries.push('  packages: write');
  if (needsId)  entries.push('  id-token: write');
  entries.push('  issues: write');
  entries.push('  checks: write');
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || f.content.includes('permissions:')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added comprehensive permissions block — "Resource not accessible by integration" (403) means GITHUB_TOKEN lacks required scopes; GitHub restricts GITHUB_TOKEN to minimum permissions by default', confidence: 100 });
  }
  return fixes;
}

/** Add id-token: write when OIDC cloud auth fails (AWS/GCP/Azure). */
export function fixOidcPermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/jwt.*invalid|oidc.*token|id.?token.*permission|AssumeRoleWithWebIdentity|workload.identity|federated.*credential/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  id-token: write', '  contents: read']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added id-token: write — OIDC cloud auth (AWS assume-role-with-web-identity, GCP workload identity, Azure federated credentials) requires this permission to request OIDC JWT tokens from GitHub', confidence: 100 });
  }
  return fixes;
}

/** Add timeout-minutes to jobs that exceeded the runner limit. */
export function fixJobTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/exceeded.*maximum execution time|The job.*has exceeded|canceling.*took longer/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const patched = patchGitHubJobBlocks(f.content, (b: string) => !/timeout-minutes/i.test(b), '    timeout-minutes: 30');
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added timeout-minutes: 30 to jobs — job exceeded GitHub runner limit (6h default); explicit timeout at 30 minutes frees runners faster and surfaces hung processes earlier', confidence: 100 });
  }
  return fixes;
}

/** Create a minimal .eslintrc.json when lint fails and no config exists. */
export function fixMissingEslintConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/eslint.*no.*config|eslint.*(?:not|couldn't|could not).*find.*config|No ESLint configuration/i.test(logs)) return [];
  if (files.some(f => ['.eslintrc','.eslintrc.json','.eslintrc.js','.eslintrc.yaml','eslint.config.js','eslint.config.mjs'].some(n => f.path.endsWith(n)))) return [];
  const isTS = files.some(f => f.path === 'tsconfig.json');
  const isReact = files.some(f => f.path === 'package.json' && f.content.includes('"react"'));
  const config = {
    env: { node: true, es2022: true, browser: isReact },
    extends: [
      'eslint:recommended',
      ...(isTS ? ['plugin:@typescript-eslint/recommended'] : []),
      ...(isReact ? ['plugin:react/recommended', 'plugin:react-hooks/recommended'] : []),
    ],
    parser: isTS ? '@typescript-eslint/parser' : undefined,
    plugins: [
      ...(isTS ? ['@typescript-eslint'] : []),
      ...(isReact ? ['react', 'react-hooks'] : []),
    ],
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ...(isReact ? { ecmaFeatures: { jsx: true } } : {}) },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': isTS ? 'off' : 'warn',
      ...(isTS ? { '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] } : {}),
    },
  };
  return [{
    path: '.eslintrc.json',
    content: JSON.stringify(config, null, 2) + '\n',
    explanation: 'Created .eslintrc.json — ESLint failed because no configuration file existed; configured for your stack (TypeScript/React detected)',
    confidence: 100,
  }];
}

/** Create minimal jest.config.js when Jest fails because no config exists. */
export function fixMissingJestConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/jest.*config.*not found|No jest.config|Cannot find module.*jest/i.test(logs)) return [];
  if (files.some(f => /jest\.config\.(js|ts|json|cjs)$/.test(f.path))) return [];
  const isTS = files.some(f => f.path === 'tsconfig.json');
  const isReact = files.some(f => f.path === 'package.json' && f.content.includes('"react"'));
  return [{
    path: 'jest.config.js',
    content: `/** @type {import('jest').Config} */\nmodule.exports = {\n  testEnvironment: ${isReact ? "'jsdom'" : "'node'"},\n  ${isTS ? "transform: { '^.+\\\\.tsx?$': ['ts-jest', { tsconfig: { strict: false } }] },\n  " : ''}testMatch: ['**/__tests__/**/*.${isTS ? 'ts' : 'js'}?(x)', '**/*.{test,spec}.${isTS ? 'ts' : 'js'}?(x)'],\n  coverageDirectory: 'coverage',\n  collectCoverageFrom: ['src/**/*.${isTS ? '{ts,tsx}' : '{js,jsx}'}', '!src/**/*.d.ts', '!src/**/*.stories.*'],\n  clearMocks: true,\n  restoreMocks: true,\n  testTimeout: 30000,\n};\n`,
    explanation: 'Created jest.config.js — Jest could not find configuration file; configured with proper test patterns, coverage, and timeout; environment set to jsdom for React or node for backend',
    confidence: 100,
  }];
}

/** Add workflow_dispatch: with proper inputs when steps reference github.event.inputs but inputs are not declared. */
export function fixMissingDispatchInputs(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('workflow_dispatch:') || !f.content.includes('github.event.inputs')) continue;
    if (/workflow_dispatch:\s*\n\s+inputs:/m.test(f.content)) continue;
    const inputRefs = [...f.content.matchAll(/github\.event\.inputs\.(\w+)/g)].map(m => m[1]);
    if (inputRefs.length === 0) continue;
    const inputsBlock = inputRefs.map(n =>
      `      ${n}:\n        description: '${n.replace(/_/g, ' ')} parameter'\n        required: false\n        type: string\n        default: ''`,
    ).join('\n');
    const fixed = f.content.replace(
      /workflow_dispatch:\s*$/m,
      `workflow_dispatch:\n    inputs:\n${inputsBlock}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added workflow_dispatch inputs for [${inputRefs.join(', ')}] — inputs referenced via github.event.inputs but not declared cause null reference errors when workflow runs`, confidence: 100 });
  }
  return fixes;
}

/** Fix incorrect config hierarchy — keys at wrong indentation level in YAML. */
export function fixIncorrectConfigHierarchy(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let context: 'root' | 'job' | 'step' = 'root';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^jobs:/.test(line)) { context = 'root'; out.push(line); continue; }
      if (/^  [\w-]+:\s*$/.test(line)) { context = 'job'; out.push(line); continue; }
      if (/^      - /.test(line)) { context = 'step'; }
      if (context === 'job') {
        const m = line.match(/^    (uses|run|shell):\s*(.*)$/);
        if (m) {
          out.push(`      - ${m[1]}: ${m[2]}`);
          modified = true;
          continue;
        }
      }
      out.push(line);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Fixed YAML indentation hierarchy — step-level keys (uses:, run:, shell:) were at job level instead of inside a steps: list item; GitHub Actions rejects workflows with incorrect hierarchy', confidence: 100 });
  }
  return fixes;
}

/** Remove or comment out unsupported config parameters that cause CI parse errors. */
export function fixUnsupportedConfigParameter(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/unexpected.*key|not supported|unknown.*property|invalid.*field|unrecognized.*option/i.test(logs)) return [];
  const keyMatch = logs.match(/(?:unexpected|unknown|invalid|unrecognized)\s+(?:key|property|field|option)\s*[:`'"]?\s*['"`]?([a-z_-]+)['"`]?/i);
  const badKey = keyMatch?.[1];
  if (!badKey) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    if (!f.content.includes(badKey + ':')) continue;
    const fixed = f.content.replace(
      new RegExp(`^(\\s*)(${badKey}:.*)$`, 'gm'),
      `$1# aegis-fix: removed unsupported parameter — $2`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Commented out unsupported parameter "${badKey}" — this key is not valid in the current CI configuration schema; the CI engine rejects workflows with unknown keys`, confidence: 100 });
  }
  return fixes;
}

/** Fix GitLab CI include: paths that reference non-existent local files. */
export function fixGitLabIncludePath(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    const localIncludes = [...f.content.matchAll(/include:\s*\n\s+-\s+local:\s*['"]([\w/.-]+)['"]/gm)].map(m => m[1]);
    for (const inc of localIncludes) {
      if (files.some(fi => fi.path === inc || fi.path.endsWith(inc))) continue;
      fixes.push({
        path: inc,
        content: `# Auto-generated stub for ${inc}\n# Add actual CI job configuration below\n\n.common-job: &common\n  interruptible: true\n  retry:\n    max: 1\n    when:\n      - runner_system_failure\n`,
        explanation: `Created stub for ${inc} — GitLab CI include: references a file that does not exist; pipeline fails to parse without the file`,
        confidence: 100,
      });
    }
  }
  return fixes;
}

// ── NEW FIXERS ────────────────────────────────────────────────────────────────

/** Create .prettierrc when format check fails and no Prettier config exists. */
export function fixMissingPrettierConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/prettier|format.*check|code.*style.*fail|formatting.*error/i.test(logs)) return [];
  if (files.some(f => ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'].some(n => f.path.endsWith(n)))) return [];
  const isReact = files.some(f => f.path === 'package.json' && f.content.includes('"react"'));
  return [{
    path: '.prettierrc',
    content: JSON.stringify({
      semi: true,
      singleQuote: true,
      trailingComma: 'all',
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
      bracketSpacing: true,
      arrowParens: 'always',
      ...(isReact ? { jsxSingleQuote: false, bracketSameLine: false } : {}),
      endOfLine: 'lf',
    }, null, 2) + '\n',
    explanation: 'Created .prettierrc — Prettier format check failed because no configuration existed; configured with standard defaults (single quotes, trailing commas, LF line endings)',
    confidence: 100,
  }];
}

/** Create ESLint v9 flat config (eslint.config.js) when ESLint 9+ is detected. */
export function fixESLintFlatConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/eslint.*flat.*config|ESLint.*v9|eslint.config.*not found/i.test(logs)) return [];
  if (files.some(f => f.path === 'eslint.config.js' || f.path === 'eslint.config.mjs')) return [];
  // Remove old .eslintrc if present
  const fixes: RuleFix[] = [];
  const isTS = files.some(f => f.path === 'tsconfig.json');
  const isReact = files.some(f => f.path === 'package.json' && f.content.includes('"react"'));
  fixes.push({
    path: 'eslint.config.js',
    content: `import js from '@eslint/js';\n${isTS ? "import tsPlugin from '@typescript-eslint/eslint-plugin';\nimport tsParser from '@typescript-eslint/parser';\n" : ''}${isReact ? "import reactPlugin from 'eslint-plugin-react';\nimport reactHooksPlugin from 'eslint-plugin-react-hooks';\n" : ''}\n/** @type {import('eslint').Linter.Config[]} */\nexport default [\n  js.configs.recommended,\n${isTS ? `  {\n    files: ['**/*.ts', '**/*.tsx'],\n    languageOptions: { parser: tsParser },\n    plugins: { '@typescript-eslint': tsPlugin },\n    rules: {\n      ...tsPlugin.configs.recommended.rules,\n      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],\n      '@typescript-eslint/no-explicit-any': 'warn',\n    },\n  },\n` : ''}${isReact ? `  {\n    plugins: { react: reactPlugin, 'react-hooks': reactHooksPlugin },\n    rules: { ...reactPlugin.configs.recommended.rules, ...reactHooksPlugin.configs.recommended.rules },\n    settings: { react: { version: 'detect' } },\n  },\n` : ''}  {\n    ignores: ['dist/**', 'build/**', 'node_modules/**', 'coverage/**'],\n  },\n];\n`,
    explanation: 'Created eslint.config.js — ESLint v9 requires the new flat config format; old .eslintrc.json is not supported by ESLint 9+',
    confidence: 100,
  });
  return fixes;
}

/** Create .editorconfig to fix line ending and indentation consistency issues. */
export function fixMissingEditorConfig(files: Array<{ path: string; content: string }>): RuleFix[] {
  if (files.some(f => f.path === '.editorconfig')) return [];
  const hasWorkflow = files.some(f => isGitHubWorkflow(f.path) || isGitLabCI(f.path));
  if (!hasWorkflow) return [];
  const isGo = files.some(f => f.path === 'go.mod');
  const isMakefile = files.some(f => f.path === 'Makefile');
  return [{
    path: '.editorconfig',
    content: `root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\ntrim_trailing_whitespace = true\nindent_style = space\nindent_size = 2\n\n[*.md]\ntrim_trailing_whitespace = false\n\n[*.{json,yaml,yml}]\nindent_size = 2\n\n${isGo || isMakefile ? '[Makefile]\nindent_style = tab\n\n[*.go]\nindent_style = tab\nindent_size = 4\n\n' : ''}[*.{py}]\nindent_size = 4\n\n[*.{java,kt}]\nindent_size = 4\n`,
    explanation: 'Created .editorconfig — enforces consistent line endings (LF), indentation, and trailing whitespace across editors and OSes; prevents diff noise from mixed CRLF/LF in cross-platform teams',
    confidence: 100,
  }];
}

/** Add Playwright browser installation step when Playwright tests are detected. */
export function fixPlaywrightBrowserInstall(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const hasPlaywright = f.content.includes('playwright') || files.some(fi => fi.path.includes('playwright.config'));
    if (!hasPlaywright || f.content.includes('playwright install')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(npx playwright|playwright test|npx pw)/,
      `      - name: Install Playwright browsers\n        run: npx playwright install --with-deps chromium firefox webkit\n      - name: Install Playwright system dependencies\n        run: npx playwright install-deps`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Playwright browser installation step — Playwright requires browsers to be installed on the runner; GitHub runners do not have Chromium/Firefox/WebKit pre-installed; --with-deps also installs OS-level dependencies', confidence: 100 });
  }
  return fixes;
}

/** Add Cypress system dependency installation for CI. */
export function fixCypressCIDependencies(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const hasCypress = f.content.includes('cypress') || files.some(fi => fi.path.includes('cypress.config'));
    if (!hasCypress || f.content.includes('cypress/github-action') || f.content.includes('libgtk')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(npx cypress|cypress run)/,
      `      - name: Install Cypress system dependencies\n        run: |\n          sudo apt-get update\n          sudo apt-get install -y libgtk2.0-0 libgtk-3-0 libgbm-dev libnotify-dev libgconf-2-4 libnss3 libxss1 libasound2 libxtst6 xauth xvfb`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Cypress system dependency installation — Cypress requires libgtk, libnss3, libasound2 and other OS libraries that are not installed on minimal GitHub runner images; without them Cypress crashes with "no display server"', confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION A — INVALID .gitlab-ci.yml
// ═══════════════════════════════════════════════════════════════════════════════

/** Fix broken YAML anchors — ensure <<: *alias syntax is valid and referenced anchor exists. */
export function fixGitLabYamlAnchors(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/did not find expected.*anchor|alias.*not defined|anchor.*undefined|unknown alias/i.test(logs)) return [];
  const anchorMatch = logs.match(/alias\s+['"]?([^'"\s]+)['"]?\s+(?:not defined|undefined)/i);
  const missingAnchor = anchorMatch?.[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (missingAnchor && !f.content.includes(`*${missingAnchor}`)) continue;
    // If anchor is referenced but not defined, add a common job template
    if (missingAnchor && !f.content.includes(`&${missingAnchor}`)) {
      const stub = `.${missingAnchor}: &${missingAnchor}\n  interruptible: true\n  retry:\n    max: 1\n    when:\n      - runner_system_failure\n\n`;
      const fixed = stub + f.content;
      fixes.push({ path: f.path, content: fixed, explanation: `Defined missing YAML anchor &${missingAnchor} — the alias *${missingAnchor} was referenced but no anchor with that name existed; added a job template stub at the top of the file`, confidence: 90 });
    }
    // Fix merge key syntax — <<: *anchor must have the anchor defined before the alias
    const fixed = f.content.replace(/^(\s+)<<:\s*\*(\w+)\s*$/gm, (line, ws, name) => {
      if (f.content.includes(`&${name}`)) return line; // anchor exists, no fix needed
      return `${ws}# aegis: anchor &${name} is missing — define it above this job`;
    });
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Flagged undefined YAML merge keys — <<: *anchor is a GitLab CI YAML extension for job inheritance; the referenced anchor must be defined before the job that uses it', confidence: 85 });
  }
  return fixes;
}

/** Add image: to a job that lost its image when global image was removed. */
export function fixGitLabJobMissingImage(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/image.*required|no.*image.*specified|job.*has no image/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('image:')) continue; // either global or per-job image exists
    const isNode = f.content.includes('npm') || f.content.includes('node');
    const isPython = f.content.includes('pip') || f.content.includes('python');
    const isGo = /\bgo build\b/.test(f.content);
    const img = isNode ? 'node:20-alpine' : isPython ? 'python:3.12-slim' : isGo ? 'golang:1.22-alpine' : 'ubuntu:22.04';
    const fixed = `image: ${img}\n\n` + f.content;
    fixes.push({ path: f.path, content: fixed, explanation: `Added global image: ${img} — GitLab CI jobs require a Docker image; without a global or job-level image the pipeline fails to start on Docker-based runners`, confidence: 88 });
  }
  return fixes;
}

/** Fix extends: referencing a job or template that does not exist. */
export function fixGitLabExtendsMissing(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/extends.*not found|job.*extends.*undefined|unknown.*extends/i.test(logs)) return [];
  const extendMatch = logs.match(/extends[:\s]+['"]?([.a-zA-Z0-9_-]+)['"]?.*(?:not found|undefined)/i);
  const missing = extendMatch?.[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!missing || !f.content.includes(`extends: ${missing}`) && !f.content.includes(`extends:\n  - ${missing}`)) continue;
    // Add a hidden job template (prefixed with .) as the missing base
    const stub = `${missing}:\n  interruptible: true\n  retry:\n    max: 1\n    when: [runner_system_failure, stuck_or_timeout_failure]\n  tags: []\n\n`;
    const fixed = stub + f.content;
    fixes.push({ path: f.path, content: fixed, explanation: `Defined missing extends template ${missing} — GitLab CI extends: requires the base job to exist in the same file or an included file; added a stub template so the pipeline can parse`, confidence: 88 });
  }
  return fixes;
}

/** Fix GitLab CI rules: blocks with no valid when: clause causing jobs to never run. */
export function fixGitLabRulesNeverMatch(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('rules:')) continue;
    // Detect rules: blocks that only have when: never (job will never run)
    const fixed = f.content.replace(
      /^(  rules:\s*\n(?:\s+-\s+when:\s+never\s*\n)+)/gm,
      () => `  rules:\n    - when: on_success\n  # aegis: replaced always-never rules block — previous rules caused job to never execute\n`,
    );
    // Detect rules: blocks missing a when: fallback
    const withFallback = fixed.replace(
      /(  rules:\s*\n(?:\s+-\s+if:[^\n]+\n(?:\s+when:[^\n]+\n)?)+)(?!\s+-\s+when:)/gm,
      '$1    - when: never\n',
    );
    if (withFallback !== f.content)
      fixes.push({ path: f.path, content: withFallback, explanation: 'Fixed GitLab CI rules: — rules without a final fallback when: clause default to when: on_success for every pipeline type, which is usually unintended; added explicit when: never fallback so the job only runs when conditions match', confidence: 85 });
  }
  return fixes;
}

/** Add workflow: rules: to control which pipelines create a detached pipeline. */
export function fixGitLabWorkflowRules(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('workflow:')) continue;
    // Only add if the file has both MR and push triggers (common source of duplicate pipelines)
    if (!f.content.includes('CI_PIPELINE_SOURCE') && !f.content.includes('CI_MERGE_REQUEST_IID')) continue;
    const workflowBlock = `workflow:\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'\n    - if: '$CI_COMMIT_TAG'\n    - when: never\n\n`;
    const fixed = workflowBlock + f.content;
    fixes.push({ path: f.path, content: fixed, explanation: 'Added workflow: rules: — without it, pushing to a branch that has an open MR creates both a branch pipeline and an MR pipeline (duplicate); workflow: rules: ensures only one pipeline type runs per event', confidence: 88 });
  }
  return fixes;
}

/** Fix GitLab CI trigger: include: paths for multi-project pipelines. */
export function fixGitLabTriggerConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/trigger.*include.*not found|downstream.*pipeline.*fail|trigger.*path.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('trigger:')) continue;
    // Fix trigger: include: that references files without leading /
    const fixed = f.content.replace(
      /(trigger:\s*\n\s+include:\s*\n\s+-\s+local:\s*)((?!\/)[^'\n]+)/g,
      (_, prefix, path) => `${prefix}/${path}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added leading / to trigger: include: local: path — GitLab CI local include paths must be absolute (starting with /); relative paths cause "file not found" errors during pipeline creation', confidence: 88 });
  }
  return fixes;
}

/** Fix GitLab CI parallel: matrix: configuration syntax errors. */
export function fixGitLabParallelMatrix(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/parallel.*matrix.*invalid|matrix.*variables.*required|parallel.*config.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('parallel:') || f.content.includes('matrix:')) continue;
    // parallel: N (integer) is valid, but if they wrote parallel: matrix: incorrectly
    const fixed = f.content.replace(
      /parallel:\s*\n(\s+)(\w+):\s*\[([^\]]+)\]/g,
      (_, ws, key, values) =>
        `parallel:\n${ws}matrix:\n${ws}  - ${key}: [${values}]`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed parallel: matrix: syntax — matrix variables must be nested under a matrix: key inside parallel:; GitLab rejects flat parallel: variable definitions', confidence: 85 });
  }
  return fixes;
}

/** Fix GitLab CI services: missing alias or wrong port configuration. */
export function fixGitLabServicesConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/service.*alias.*not found|service.*port.*invalid|could not connect.*service/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('services:')) continue;
    const fixed = f.content.replace(
      /services:\s*\n(\s+)-\s+(\S+)\s*$/gm,
      (_, ws, image) => {
        const alias = image.split(':')[0].split('/').pop()!.replace(/[^a-z0-9]/g, '-');
        return `services:\n${ws}- name: ${image}\n${ws}  alias: ${alias}`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added alias: to GitLab CI services — without an alias, services are only reachable by their full image name (including registry prefix); alias: provides a short hostname like "postgres" or "redis" that scripts can connect to', confidence: 88 });
  }
  return fixes;
}

/** Fix GitLab CI environment: configuration for deployments. */
export function fixGitLabEnvironmentConfig(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('environment:') || f.content.includes('environment:\n') || f.content.includes('url:')) continue;
    // Fix environment: that is just a string — should be a block with name: and url:
    const fixed = f.content.replace(
      /^(\s+environment:\s+)(\S+)$/gm,
      (_, ws, envName) => `${ws}environment:\n${ws}  name: ${envName}\n${ws}  url: https://\${CI_ENVIRONMENT_SLUG}.example.com`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Expanded environment: string to block with name: and url: — the block form enables GitLab deployment tracking, environment-specific variable overrides, and the Environments page in the GitLab UI', confidence: 82 });
  }
  return fixes;
}

/** Add resource_group: to serialize deployment jobs and prevent concurrent deploys. */
export function fixGitLabResourceGroup(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('resource_group:')) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    const fixed = f.content.replace(
      /^(deploy[\w-]*:\s*\n)((?:\s+[^\n]+\n)*\s+stage:)/gim,
      (_, header, rest) => `${header}  resource_group: production\n${rest}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added resource_group: production to deploy jobs — concurrent deployments from parallel pipelines can race each other and leave the environment in an inconsistent state; resource_group serializes jobs that use the same resource key', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION B — INVALID GITHUB ACTIONS WORKFLOW SYNTAX
// ═══════════════════════════════════════════════════════════════════════════════

/** Fix invalid job ID characters (spaces, leading hyphens, uppercase in some contexts). */
export function fixInvalidJobId(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/invalid.*job.*id|job.*name.*invalid|job.*identifier.*must/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Job IDs must match [a-zA-Z_][a-zA-Z0-9_-]*
    const fixed = f.content.replace(
      /^(  )([a-z][a-z0-9]*(?:[\s][a-z0-9]+)+)(:)$/gim,
      (_, ws, id, colon) => `${ws}${id.replace(/\s+/g, '-')}${colon}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed job IDs with spaces — GitHub Actions job IDs must match [a-zA-Z_][a-zA-Z0-9_-]*; spaces in job IDs cause workflow parse errors', confidence: 90 });
  }
  return fixes;
}

/** Fix expression syntax errors in ${{ }} blocks. */
export function fixWorkflowExpressionSyntax(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/unexpected symbol|invalid expression|expression.*syntax.*error|parse.*error.*expression/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    let content = f.content;
    // Fix ${var} → ${{ env.var }} (bash-style in YAML context)
    content = content.replace(/\$\{([A-Z_][A-Z0-9_]+)\}/g, '\${{ env.$1 }}');
    // Fix ${{ x = y }} (assignment in expression, not valid)
    content = content.replace(/\$\{\{\s*(\w+)\s*=\s*([^}]+)\}\}/g, '\${{ $1 == $2 }}');
    // Fix ${{github.x}} (missing spaces around expression)
    content = content.replace(/\$\{\{([^}\s][^}]*[^}\s])\}\}/g, '\${{ $1 }}');
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Fixed workflow expression syntax — common issues: ${VAR} (bash style, not GitHub expressions), ${{x=y}} (assignment instead of comparison), and missing spaces inside ${{ }}; GitHub expression parser requires ${{ expr }} with spaces', confidence: 88 });
  }
  return fixes;
}

/** Fix if: conditions missing the ${{ }} wrapper. */
export function fixWorkflowIfCondition(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // if: github.event_name == 'push' should be if: ${{ github.event_name == 'push' }}
    const fixed = f.content.replace(
      /^(\s+if:\s+)(github\.|secrets\.|env\.|needs\.|inputs\.|steps\.|runner\.|matrix\.)([^$\n{][^\n]*)/gm,
      (_, ws, prefix, rest) => `${ws}if: \${{ ${prefix}${rest} }}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Wrapped bare if: conditions in ${{ }} — expressions using github., secrets., env., etc. must be wrapped in ${{ }}; without the wrapper GitHub treats the value as a literal string instead of evaluating the expression', confidence: 88 });
  }
  return fixes;
}

/** Add missing steps: key to a job that has runs-on but no steps block. */
export function fixMissingStepsKey(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/required.*steps|job.*no.*steps|steps.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^  [\w-]+:\s*$/.test(lines[i])) {
        let end = i + 1;
        while (end < lines.length && (lines[end].startsWith('    ') || lines[end].trim() === '')) end++;
        const block = lines.slice(i + 1, end).join('\n');
        if (block.includes('runs-on:') && !block.includes('steps:')) {
          // Find position after runs-on: line
          for (let j = i + 1; j < end; j++) {
            out.push(lines[j]);
            i = j;
            if (/^\s+runs-on:/.test(lines[j])) {
              out.push('    steps:');
              out.push('      - name: Placeholder step');
              out.push('        run: echo "No steps defined — add your steps here"');
              modified = true;
              break;
            }
          }
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added missing steps: block — GitHub Actions requires every job to have a steps: list; a job with runs-on: but no steps: causes a parse error', confidence: 95 });
  }
  return fixes;
}

/** Pin reusable workflow references to a commit SHA or tag. */
export function fixReusableWorkflowPin(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('uses:') || !f.content.includes('@')) continue;
    // Warn about reusable workflow calls using @main or @master (unpinned)
    const fixed = f.content.replace(
      /(uses:\s*[\w-]+\/[\w.-]+\/\.github\/workflows\/[^@\n]+)@(main|master|HEAD)\b/g,
      (_, path) => `${path}@v1 # aegis: pin to a specific tag or SHA for security`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added comment to pin reusable workflow — calling a reusable workflow at @main or @master means any push to that branch changes your workflow\'s behavior without notice; pin to a tag or SHA for reproducible and auditable pipelines', confidence: 82 });
  }
  return fixes;
}

/** Add top-level name: field to GitHub Actions workflows missing it. */
export function fixMissingWorkflowName(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.startsWith('name:') || /^name:/m.test(f.content.slice(0, 200))) continue;
    const workflowName = f.path.split('/').pop()?.replace(/\.(yml|yaml)$/, '').replace(/[-_]/g, ' ') ?? 'CI';
    const fixed = `name: ${workflowName.charAt(0).toUpperCase() + workflowName.slice(1)}\n\n` + f.content;
    fixes.push({ path: f.path, content: fixed, explanation: 'Added name: to workflow — unnamed workflows appear as the file path in the Actions UI making them hard to identify; a descriptive name is shown in PR status checks and the Actions tab', confidence: 85 });
  }
  return fixes;
}

/** Fix action input type mismatches (boolean passed as string, etc.). */
export function fixActionInputTypeMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/input.*type.*mismatch|expected.*boolean.*got.*string|invalid.*type.*input/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Fix: boolean inputs passed as quoted strings
    const fixed = f.content
      .replace(/(\s+)(force|dry[_-]run|debug|verbose|skip[_-]tests|enabled):\s*'(true|false)'/gi,
        (_, ws, key, val) => `${ws}${key}: ${val}`)
      .replace(/(\s+)(force|dry[_-]run|debug|verbose|skip[_-]tests|enabled):\s*"(true|false)"/gi,
        (_, ws, key, val) => `${ws}${key}: ${val}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Unquoted boolean input values — action inputs of type boolean must not be quoted; passing "true" (string) to a boolean input causes the action to receive the string, not the boolean, breaking conditional logic', confidence: 88 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION C — MISSING CONFIG FILE
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a minimal tsconfig.json when TypeScript compilation fails with no config. */
export function fixMissingTsConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/tsconfig.*not found|no tsconfig|cannot find.*tsconfig|TS5058/i.test(logs)) return [];
  if (files.some(f => /tsconfig.*\.json$/.test(f.path))) return [];
  const isNext = files.some(f => f.path === 'package.json' && f.content.includes('"next"'));
  const isVite = files.some(f => f.path === 'package.json' && f.content.includes('"vite"'));
  const isNode = !isNext && !isVite;
  return [{
    path: 'tsconfig.json',
    content: JSON.stringify({
      compilerOptions: {
        target: isNode ? 'ES2022' : 'ES2020',
        module: isNode ? 'commonjs' : 'ESNext',
        moduleResolution: isNode ? 'node' : 'bundler',
        lib: isNext || isVite ? ['ES2020', 'DOM', 'DOM.Iterable'] : ['ES2022'],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        declaration: isNode,
        outDir: isNode ? './dist' : undefined,
        baseUrl: '.',
        paths: isVite ? { '@/*': ['./src/*'] } : undefined,
        jsx: isNext || isVite ? 'react-jsx' : undefined,
      },
      include: ['src/**/*', isNext ? 'next-env.d.ts' : ''].filter(Boolean),
      exclude: ['node_modules', 'dist', 'build'],
    }, null, 2) + '\n',
    explanation: 'Created tsconfig.json — TypeScript compiler failed because no tsconfig.json existed; configured for detected stack (Next.js/Vite/Node)',
    confidence: 100,
  }];
}

/** Create minimal vite.config.ts when Vite fails to find its config. */
export function fixMissingViteConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/vite.*config.*not found|failed to load.*vite.*config|Could not resolve.*vite/i.test(logs)) return [];
  if (files.some(f => /vite\.config\.(js|ts|mts|mjs)$/.test(f.path))) return [];
  const isReact = files.some(f => f.path === 'package.json' && f.content.includes('"react"'));
  const isVue = files.some(f => f.path === 'package.json' && f.content.includes('"vue"'));
  return [{
    path: 'vite.config.ts',
    content: `import { defineConfig } from 'vite';\n${isReact ? "import react from '@vitejs/plugin-react';\n" : ''}${isVue ? "import vue from '@vitejs/plugin-vue';\n" : ''}import path from 'path';\n\nexport default defineConfig({\n  plugins: [${isReact ? 'react()' : isVue ? 'vue()' : ''}],\n  resolve: {\n    alias: {\n      '@': path.resolve(__dirname, './src'),\n    },\n  },\n  build: {\n    outDir: 'dist',\n    sourcemap: true,\n    rollupOptions: {\n      output: {\n        manualChunks: {\n          vendor: ['${isReact ? 'react' : isVue ? 'vue' : 'lodash'}'],\n        },\n      },\n    },\n  },\n  server: {\n    port: 5173,\n    strictPort: false,\n  },\n  test: {\n    environment: 'jsdom',\n    globals: true,\n  },\n});\n`,
    explanation: 'Created vite.config.ts — Vite failed to find its configuration file; configured with detected framework plugin, path alias @/, sourcemaps, and test environment',
    confidence: 100,
  }];
}

/** Create vitest.config.ts when Vitest cannot find its config. */
export function fixMissingVitestConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/vitest.*config.*not found|cannot find.*vitest.*config/i.test(logs)) return [];
  if (files.some(f => /vitest\.config\.(ts|js|mts)$/.test(f.path))) return [];
  return [{
    path: 'vitest.config.ts',
    content: `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    globals: true,\n    environment: 'jsdom',\n    setupFiles: ['./src/test/setup.ts'],\n    include: ['src/**/*.{test,spec}.{ts,tsx}'],\n    exclude: ['node_modules', 'dist'],\n    coverage: {\n      provider: 'v8',\n      reporter: ['text', 'json', 'html', 'lcov'],\n      exclude: ['node_modules/', 'src/test/', '**/*.d.ts', '**/*.stories.*'],\n      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },\n    },\n    reporters: ['verbose'],\n    testTimeout: 10000,\n  },\n});\n`,
    explanation: 'Created vitest.config.ts — Vitest could not find its config; configured with jsdom environment, coverage thresholds, and test file patterns',
    confidence: 100,
  }];
}

/** Create .nvmrc when node version mismatch errors occur. */
export function fixMissingNvmrc(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/node.*version.*mismatch|required.*node.*version|engine.*node/i.test(logs)) return [];
  if (files.some(f => f.path === '.nvmrc' || f.path === '.node-version')) return [];
  const versionMatch = logs.match(/node.*v?(\d+)\.(\d+)/i) ?? logs.match(/>=\s*v?(\d+)/);
  const major = versionMatch ? parseInt(versionMatch[1]) : 20;
  return [{
    path: '.nvmrc',
    content: `${major}\n`,
    explanation: `.nvmrc created with Node ${major} — nvm and Volta read this file to select the correct Node version; CI setup-node actions can also read .nvmrc when node-version-file: .nvmrc is configured`,
    confidence: 90,
  }];
}

/** Create pyproject.toml stub when Python tooling fails to find configuration. */
export function fixMissingPyprojectToml(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pyproject\.toml.*not found|no pyproject|tool\.poetry.*not found|build-system.*missing/i.test(logs)) return [];
  if (files.some(f => f.path === 'pyproject.toml')) return [];
  const hasPoetry = files.some(f => f.path === 'poetry.lock');
  const projectName = 'my-project';
  return [{
    path: 'pyproject.toml',
    content: hasPoetry
      ? `[tool.poetry]\nname = "${projectName}"\nversion = "0.1.0"\ndescription = ""\nauthors = []\n\n[tool.poetry.dependencies]\npython = "^3.11"\n\n[tool.poetry.dev-dependencies]\npytest = "^7.0"\npytest-cov = "^4.0"\n\n[build-system]\nrequires = ["poetry-core>=1.0.0"]\nbuild-backend = "poetry.core.masonry.api"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\naddopts = "--cov=src --cov-report=xml --cov-report=term-missing"\n\n[tool.black]\nline-length = 88\ntarget-version = ["py311"]\n\n[tool.isort]\nprofile = "black"\n`
      : `[build-system]\nrequires = ["setuptools>=68", "wheel"]\nbuild-backend = "setuptools.backends.legacy:build"\n\n[project]\nname = "${projectName}"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\naddopts = "--cov=src --cov-report=xml --cov-report=term-missing"\n\n[tool.black]\nline-length = 88\n`,
    explanation: 'Created pyproject.toml — Python tooling (pytest, black, isort, coverage) looks for configuration in pyproject.toml; without it each tool falls back to its own defaults which may not match the project\'s requirements',
    confidence: 90,
  }];
}

/** Create .dockerignore to prevent build context from including unnecessary files. */
export function fixMissingDockerignore(files: Array<{ path: string; content: string }>): RuleFix[] {
  if (files.some(f => f.path === '.dockerignore')) return [];
  if (!files.some(f => f.path === 'Dockerfile' || f.path.endsWith('/Dockerfile'))) return [];
  const isNode = files.some(f => f.path === 'package.json');
  const isPython = files.some(f => f.path === 'requirements.txt' || f.path === 'pyproject.toml');
  return [{
    path: '.dockerignore',
    content: [
      '.git', '.github', '.gitignore',
      'node_modules', '.npm',
      isNode ? 'npm-debug.log*' : '',
      isNode ? '.eslintcache' : '',
      isPython ? '__pycache__' : '',
      isPython ? '*.pyc' : '',
      isPython ? '.pytest_cache' : '',
      isPython ? '.venv' : '',
      'dist', 'build', 'out', 'coverage',
      '.env', '.env.*', '!.env.example',
      '*.md', 'docs/', 'test/', 'tests/',
      '.DS_Store', 'Thumbs.db',
      'docker-compose*.yml',
      '.dockerignore', 'Dockerfile*',
    ].filter(Boolean).join('\n') + '\n',
    explanation: 'Created .dockerignore — without it, docker build sends node_modules, .git, and test files to the build context; this increases build time, image size, and can leak secrets from .env files into the image',
    confidence: 95,
  }];
}

/** Create .gitignore when sensitive files or build artifacts are tracked. */
export function fixMissingGitignore(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/gitignore.*not found|\.env.*tracked|node_modules.*committed|secret.*committed/i.test(logs)) return [];
  if (files.some(f => f.path === '.gitignore')) return [];
  return [{
    path: '.gitignore',
    content: `# Dependencies\nnode_modules/\n.npm\n\n# Build outputs\ndist/\nbuild/\nout/\n.next/\n.nuxt/\n\n# Environment files\n.env\n.env.*\n!.env.example\n\n# IDE\n.idea/\n.vscode/\n*.suo\n*.ntvs*\n*.njsproj\n*.sln\n\n# OS\n.DS_Store\nThumbs.db\n\n# Logs\nnpm-debug.log*\nyarn-debug.log*\nyarn-error.log*\npnpm-debug.log*\n\n# Testing\ncoverage/\n.nyc_output/\n\n# Cache\n.cache/\n.parcel-cache/\n.eslintcache\n\n# Python\n__pycache__/\n*.pyc\n*.pyo\n.venv/\n*.egg-info/\n.pytest_cache/\n\n# Go\nbin/\n\n# Terraform\n*.tfstate\n*.tfstate.backup\n.terraform/\n`,
    explanation: 'Created .gitignore — tracked sensitive or generated files detected; .gitignore prevents node_modules, .env, build outputs, and IDE files from being committed, reducing repo size and security risk',
    confidence: 92,
  }];
}

/** Create postcss.config.js when Tailwind/PostCSS fails to find configuration. */
export function fixMissingPostcssConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/postcss.*config.*not found|failed to load.*postcss|tailwind.*config.*missing/i.test(logs)) return [];
  if (files.some(f => /postcss\.config\.(js|cjs|mjs)$/.test(f.path))) return [];
  const hasTailwind = files.some(f => f.path === 'package.json' && f.content.includes('"tailwindcss"'));
  return [{
    path: 'postcss.config.js',
    content: `module.exports = {\n  plugins: {\n${hasTailwind ? "    tailwindcss: {},\n" : ''}    autoprefixer: {},\n${hasTailwind ? "    ...(process.env.NODE_ENV === 'production' ? { cssnano: { preset: 'default' } } : {}),\n" : ''}  },\n};\n`,
    explanation: 'Created postcss.config.js — PostCSS (and Tailwind CSS) requires this file to load plugins; without it, @tailwind directives are not processed, utility classes are missing from the output CSS',
    confidence: 92,
  }];
}

/** Create babel.config.json when Babel fails because no config exists. */
export function fixMissingBabelConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/babel.*config.*not found|cannot.*find.*babel|Babel.*requires.*config/i.test(logs)) return [];
  if (files.some(f => /babel\.config\.(js|json|cjs)$|\.babelrc$/.test(f.path))) return [];
  const isReact = files.some(f => f.path === 'package.json' && f.content.includes('"react"'));
  const isTS = files.some(f => f.path === 'tsconfig.json');
  return [{
    path: 'babel.config.json',
    content: JSON.stringify({
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' }, modules: 'auto' }],
        ...(isTS ? [['@babel/preset-typescript', { allowDeclareFields: true }]] : []),
        ...(isReact ? [['@babel/preset-react', { runtime: 'automatic' }]] : []),
      ],
      plugins: [
        '@babel/plugin-proposal-class-properties',
        '@babel/plugin-transform-runtime',
      ],
    }, null, 2) + '\n',
    explanation: 'Created babel.config.json — Jest and webpack require Babel config to transform modern JS/TS syntax; without it, import/export, optional chaining, and decorators cause parse errors',
    confidence: 90,
  }];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION D — INCORRECT CONFIG HIERARCHY
// ═══════════════════════════════════════════════════════════════════════════════

/** Fix tsconfig.json extends chain pointing to non-existent base config. */
export function fixTsConfigExtendsChain(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/tsconfig.*extends.*not found|cannot read.*tsconfig.*base|TS5096/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('tsconfig.json')) continue;
    let config: Record<string, unknown>;
    try { config = JSON.parse(f.content); } catch { continue; }
    if (!config.extends) continue;
    const extendsPath = String(config.extends);
    // Check if it's a package-based extends that may not be installed
    if (extendsPath.startsWith('@') || extendsPath.startsWith('tsconfig/')) {
      // Replace with inline config
      const fixed = f.content.replace(/"extends":\s*"[^"]+",?\s*\n?/, '');
      const parsed = JSON.parse(fixed);
      (parsed.compilerOptions as Record<string, unknown>) = {
        target: 'ES2022', strict: true, esModuleInterop: true,
        skipLibCheck: true, forceConsistentCasingInFileNames: true,
        ...(parsed.compilerOptions as Record<string, unknown> ?? {}),
      };
      fixes.push({ path: f.path, content: JSON.stringify(parsed, null, 2) + '\n', explanation: `Inlined tsconfig extends base — the extends package "${extendsPath}" is not installed; inlined the essential compiler options directly to unblock the build`, confidence: 85 });
    }
  }
  return fixes;
}

/** Fix GitLab CI before_script at wrong indentation level. */
export function fixGitLabBeforeScriptLevel(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/before_script.*invalid|unexpected.*before_script|before_script.*wrong.*level/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    // before_script inside a job should be indented 2 spaces; script must be a list
    const fixed = f.content.replace(
      /^(\w[\w-]+:\s*\n)((?:\s+[^\n]+\n)*)(    before_script:)/gm,
      (_, header, rest) => `${header}${rest}  before_script:`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed before_script indentation — job-level before_script must be at 2-space indent under the job name; at 4-space it becomes part of a nested block and is not recognized as the before_script key', confidence: 88 });
  }
  return fixes;
}

/** Fix package.json workspaces field placed at wrong nesting level. */
export function fixPackageJsonWorkspacesLevel(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/workspaces.*invalid|workspace.*not.*found|workspace.*glob.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('package.json')) continue;
    let pkg: Record<string, unknown>;
    try { pkg = JSON.parse(f.content); } catch { continue; }
    // workspaces must be at root level, not inside dependencies or scripts
    if (Array.isArray(pkg.workspaces)) continue; // already correct
    if (typeof (pkg as Record<string, unknown>)['devDependencies'] === 'object') {
      const deps = pkg.devDependencies as Record<string, unknown>;
      if (deps.workspaces) {
        delete deps.workspaces;
        (pkg as Record<string, unknown>).workspaces = ['packages/*'];
        fixes.push({ path: f.path, content: JSON.stringify(pkg, null, 2) + '\n', explanation: 'Moved workspaces: from devDependencies to root level — the workspaces field must be a top-level key in package.json; npm/yarn/pnpm only recognize it at the root level', confidence: 90 });
      }
    }
  }
  return fixes;
}

/** Fix GitHub Actions step with uses: AND run: on the same step (mutually exclusive). */
export function fixStepUsesAndRunConflict(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // A step block that contains both uses: and run: is invalid
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let inStep = false;
    let stepHasUses = false;
    let stepHasRun = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s+- (name:|uses:|run:)/.test(lines[i])) {
        if (inStep && stepHasUses && stepHasRun) {
          // Split: remove run: from step with uses: and add a new step
          modified = true;
        }
        inStep = true; stepHasUses = false; stepHasRun = false;
      }
      if (inStep && /^\s+uses:/.test(lines[i])) stepHasUses = true;
      if (inStep && /^\s+run:/.test(lines[i])) stepHasRun = true;
      out.push(lines[i]);
    }
    if (modified) {
      // Simple fix: comment out the run: within uses: steps
      const fixed = f.content.replace(
        /(uses:\s*[^\n]+\n(?:\s+[^\n]+\n)*?)(\s+run:\s*[^\n]+)/g,
        (_, usesBlock, runLine) => `${usesBlock}      # aegis: removed run: (incompatible with uses:) — split into separate step\n      # ${runLine.trim()}`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Removed conflicting run: from uses: step — a GitHub Actions step can have uses: (call an action) OR run: (run a shell command), not both; uses: + run: in the same step is a parse error', confidence: 92 });
    }
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION E — UNSUPPORTED CONFIG PARAMETER
// ═══════════════════════════════════════════════════════════════════════════════

/** Remove deprecated tsconfig compiler options that are no longer valid. */
export function fixDeprecatedTsConfigOptions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TS5023|TS5024|TS5025|unknown compiler option|deprecated.*compiler.*option|no longer supported/i.test(logs)) return [];
  const REMOVED_OPTIONS = [
    'suppressImplicitAnyIndexErrors', 'keyofStringsOnly', 'noStrictGenericChecks',
    'charset', 'out', 'suppressExcessPropertyErrors', 'importsNotUsedAsValues',
    'noImplicitUseStrict', 'reactNamespace',
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('tsconfig.json')) continue;
    let config: Record<string, unknown>;
    try { config = JSON.parse(f.content); } catch { continue; }
    const opts = config.compilerOptions as Record<string, unknown> | undefined;
    if (!opts) continue;
    let modified = false;
    for (const opt of REMOVED_OPTIONS) {
      if (opt in opts) { delete opts[opt]; modified = true; }
    }
    if (modified)
      fixes.push({ path: f.path, content: JSON.stringify(config, null, 2) + '\n', explanation: `Removed deprecated tsconfig options [${REMOVED_OPTIONS.filter(o => !((config.compilerOptions as Record<string, unknown>)?.[o])).join(', ')}] — these options were removed in TypeScript 5.x and cause TS5023 errors`, confidence: 92 });
  }
  return fixes;
}

/** Remove the version: field from Docker Compose files (obsolete in Compose v2). */
export function fixDockerComposeVersionField(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') && !f.path.includes('compose.')) continue;
    if (!isYAML(f.path)) continue;
    if (!f.content.includes('version:')) continue;
    const fixed = f.content.replace(/^version:\s*["']?\d+[\d.]*["']?\s*\n/m, '');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed version: field from Docker Compose — the version: top-level field is obsolete in Compose v2 (docker compose CLI); its presence generates a deprecation warning and in some versions causes validation errors', confidence: 92 });
  }
  return fixes;
}

/** Fix GitHub Actions if: always() written without ${{ }} wrapper. */
export function fixIfAlwaysSyntax(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = f.content
      .replace(/if:\s*always\(\)/g, 'if: \${{ always() }}')
      .replace(/if:\s*failure\(\)/g, 'if: \${{ failure() }}')
      .replace(/if:\s*success\(\)/g, 'if: \${{ success() }}')
      .replace(/if:\s*cancelled\(\)/g, 'if: \${{ cancelled() }}');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Wrapped status check functions in ${{ }} — always(), failure(), success(), cancelled() must be wrapped in ${{ }}; bare function calls are treated as string literals and always evaluate to true', confidence: 95 });
  }
  return fixes;
}

/** Remove or replace GitLab EE-only keywords used on Community Edition. */
export function fixGitLabCECompatibility(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/feature.*not available.*your plan|EE.*only|requires.*premium|requires.*ultimate/i.test(logs)) return [];
  const EE_KEYS: Record<string, string> = {
    'secrets:': '# secrets: (EE only) — removed for CE compatibility',
    'compliance_framework:': '# compliance_framework: (EE only) — removed',
    'requirements:': '# requirements: (EE only) — removed',
  };
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    let content = f.content;
    let modified = false;
    for (const [key, replacement] of Object.entries(EE_KEYS)) {
      if (content.includes(key)) {
        content = content.replace(new RegExp(`^(\\s*)${key}`, 'gm'), `$1${replacement}`);
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content, explanation: 'Removed GitLab EE-only features — secrets:, compliance_framework:, and requirements: are only available on Premium/Ultimate; they cause parse errors on Community Edition instances', confidence: 88 });
  }
  return fixes;
}

/** Fix invalid npm engines version range syntax. */
export function fixNpmEnginesRange(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/engines.*invalid.*range|invalid.*semver.*range.*engines|package.*engine.*version/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('package.json')) continue;
    let pkg: Record<string, unknown>;
    try { pkg = JSON.parse(f.content); } catch { continue; }
    const engines = pkg.engines as Record<string, string> | undefined;
    if (!engines) continue;
    let modified = false;
    // Fix common mistakes: "node": "20" → ">=20", "node": "^20" is valid but "node": "20" is ambiguous
    if (engines.node && /^\d+$/.test(engines.node)) {
      engines.node = `>=${engines.node}`;
      modified = true;
    }
    // Fix "node": ">= 18 <21" (missing && or ||)
    if (engines.node && />=\s*\d+\s+<\s*\d+/.test(engines.node)) {
      engines.node = engines.node.replace(/>=\s*(\d+)\s+<\s*(\d+)/, '>=$1 <$2');
      modified = true;
    }
    if (modified)
      fixes.push({ path: f.path, content: JSON.stringify(pkg, null, 2) + '\n', explanation: 'Fixed engines version range — "node": "20" is not a valid semver range (it matches nothing); ">=20" correctly expresses "Node 20 or higher"; npm enforces the range when --engine-strict is set', confidence: 88 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION F — DUPLICATE CONFIG KEY
// ═══════════════════════════════════════════════════════════════════════════════

/** Remove duplicate job IDs in GitHub Actions workflows. */
export function fixDuplicateJobId(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/duplicate.*job|job.*already.*defined|job.*id.*duplicate/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const seen = new Set<string>();
    const out: string[] = [];
    let skip = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^  ([\w-]+):\s*$/);
      if (m) {
        if (seen.has(m[1])) {
          skip = true;
          out.push(`  # aegis: duplicate job "${m[1]}" removed`);
          continue;
        }
        seen.add(m[1]); skip = false;
      }
      if (skip && lines[i].startsWith('    ')) continue;
      if (skip) skip = false;
      out.push(lines[i]);
    }
    const fixed = out.join('\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed duplicate job IDs — GitHub Actions rejects workflows with duplicate job names; only the first definition was kept', confidence: 90 });
  }
  return fixes;
}

/** Remove duplicate stage entries in GitLab CI stages: list. */
export function fixDuplicateGitLabStage(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    const stagesBlock = f.content.match(/^stages:\s*\n((?:\s*-\s+\S+\s*\n)+)/m);
    if (!stagesBlock) continue;
    const stages = [...stagesBlock[1].matchAll(/^\s*-\s+(\S+)/gm)].map(m => m[1]);
    const unique = [...new Set(stages)];
    if (unique.length === stages.length) continue;
    const newBlock = `stages:\n${unique.map(s => `  - ${s}`).join('\n')}\n`;
    const fixed = f.content.replace(/^stages:\s*\n(?:\s*-\s+\S+\s*\n)+/m, newBlock);
    fixes.push({ path: f.path, content: fixed, explanation: `Removed duplicate stages [${stages.filter((s, i) => stages.indexOf(s) !== i).join(', ')}] — GitLab CI validates that stage names are unique in the stages: list; duplicates cause pipeline parse errors`, confidence: 95 });
  }
  return fixes;
}

/** Remove duplicate env: keys in workflow files. */
export function fixDuplicateEnvKey(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    // Find env: blocks and deduplicate keys
    const fixed = f.content.replace(
      /(env:\s*\n)((?:\s+\w+:[^\n]+\n)+)/g,
      (_, header, body) => {
        const lines = body.split('\n').filter(Boolean);
        const seen = new Set<string>();
        const deduped = lines.filter(l => {
          const key = l.trim().split(':')[0];
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
        return `${header}${deduped.join('\n')}\n`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed duplicate env: keys — duplicate environment variable names cause the last definition to silently overwrite earlier ones; the duplicate is removed to make the active value explicit', confidence: 90 });
  }
  return fixes;
}

/** Remove duplicate port mappings in docker-compose.yml. */
export function fixDuplicateDockerPort(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') && !f.path.includes('compose.')) continue;
    if (!isYAML(f.path)) continue;
    const fixed = f.content.replace(
      /(ports:\s*\n)((?:\s+-\s+["']?[\d:]+["']?\s*\n)+)/g,
      (_, header, body) => {
        const lines = body.split('\n').filter(Boolean);
        const seen = new Set<string>();
        const deduped = lines.filter(l => {
          const port = l.trim().replace(/['"]/g, '');
          if (seen.has(port)) return false;
          seen.add(port); return true;
        });
        return `${header}${deduped.join('\n')}\n`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed duplicate port mappings — duplicate port entries in docker-compose cause "Bind for 0.0.0.0:PORT failed: port is already allocated" errors at container startup', confidence: 92 });
  }
  return fixes;
}

/** Remove duplicate permissions: entries in GitHub Actions workflows. */
export function fixDuplicatePermissions(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const permMatch = f.content.match(/^permissions:\s*\n((?:\s+[\w-]+:\s*\w+\s*\n)+)/m);
    if (!permMatch) continue;
    const lines = permMatch[1].split('\n').filter(Boolean);
    const seen = new Map<string, string>();
    for (const l of lines) {
      const [key, val] = l.trim().split(':').map(s => s.trim());
      // Keep the highest permission (write > read > none)
      const priority: Record<string, number> = { write: 3, read: 2, none: 1 };
      if (!seen.has(key) || (priority[val] ?? 0) > (priority[seen.get(key)!] ?? 0))
        seen.set(key, val);
    }
    const unique = [...seen.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const fixed = f.content.replace(/^permissions:\s*\n(?:\s+[\w-]+:\s*\w+\s*\n)+/m, `permissions:\n${unique}\n`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Deduplicated permissions: entries — duplicate permission keys with conflicting values; kept the highest permission level for each key to avoid both silent overwrites and accidental over-restriction', confidence: 90 });
  }
  return fixes;
}

/** Remove duplicate scripts in package.json. */
export function fixDuplicatePackageScript(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('package.json')) continue;
    // JSON doesn't allow duplicate keys, but sometimes they appear from merge conflicts
    const duplicateMatch = f.content.match(/"scripts"\s*:\s*\{([^}]+)\}/s);
    if (!duplicateMatch) continue;
    const scriptBody = duplicateMatch[1];
    const keys = [...scriptBody.matchAll(/"(\w[\w:-]*)"\s*:/g)].map(m => m[1]);
    if (keys.length === new Set(keys).size) continue;
    // Remove duplicate keys by reparsing (take last value, standard JSON behavior)
    try {
      const pkg = JSON.parse(f.content); // JSON.parse takes last duplicate value
      fixes.push({ path: f.path, content: JSON.stringify(pkg, null, 2) + '\n', explanation: 'Removed duplicate script keys from package.json — JSON parsers resolve duplicate keys differently (first/last); normalizing to a single key with the last value makes behavior consistent across tools', confidence: 90 });
    } catch {
      // JSON is malformed — can't fix automatically
    }
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION G — BROKEN ENVIRONMENT MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/** Fix env: context used at step level when it should be job-level or vice versa. */
export function fixEnvContextScope(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // env: context in jobs.x.if is not available — use vars: or hardcode
    const fixed = f.content.replace(
      /if:\s*\$\{\{\s*env\.\w+\s*==\s*'[^']+'\s*\}\}/g,
      (m) => m.replace('env.', 'vars.'),
    );
    // ${{ env.X }} in a with: input of an action — env context is available here, so only fix wrong ones
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed env. to vars. in job if: conditions — env: context is not available in job-level if: conditions (only in step-level); use vars. (configuration variables) for job-level conditionals', confidence: 85 });
  }
  return fixes;
}

/** Fix GitLab CI variable scope — job variables should not shadow global ones unintentionally. */
export function fixGitLabVariableScope(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    // Find global variables
    const globalVarsMatch = f.content.match(/^variables:\s*\n((?:\s+\w+:[^\n]+\n)+)/m);
    if (!globalVarsMatch) continue;
    const globalVars = new Set([...globalVarsMatch[1].matchAll(/^\s+(\w+):/gm)].map(m => m[1]));
    // Find job-level variables that shadow global ones with the same value
    const fixed = f.content.replace(
      /^(  [\w-]+:\s*\n(?:\s+[^\n]+\n)*?\s+variables:\s*\n)((?:\s{4,}\w+:[^\n]+\n)+)/gm,
      (match, header, jobVars) => {
        const jobVarLines = jobVars.split('\n').filter(Boolean);
        const nonShadowing = jobVarLines.filter(l => {
          const key = l.trim().split(':')[0];
          // Keep if the value differs from global
          if (!globalVars.has(key)) return true; // not in global, keep
          // Anchored to the whole key — unanchored, "NODE" also matched "MY_NODE:"
          const globalMatch = globalVarsMatch[1].match(new RegExp(`^\\s+${key}:\\s*([^\n]+)`, 'm'));
          if (!globalMatch) return true;
          const jobVal = l.split(':').slice(1).join(':').trim();
          const globalVal = globalMatch[1].trim();
          return jobVal !== globalVal; // remove if same as global
        });
        if (nonShadowing.length === jobVarLines.length) return match;
        return nonShadowing.length > 0
          ? `${header}${nonShadowing.join('\n')}\n`
          : header.replace(/\s+variables:\s*\n$/, '\n');
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed redundant job-level variables that duplicate global values — variables defined at job level with the same value as the global override add noise and create a maintenance burden; changes to the global value must be mirrored in every job', confidence: 82 });
  }
  return fixes;
}

/** Map secrets to environment variables for subprocesses that read env, not secrets context. */
export function fixSecretToEnvMapping(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Find run: steps that use $SOME_TOKEN without it being in the step's env:
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      const runLine = lines[i].match(/^(\s+)(- +)?run:/);
      if (runLine) {
        // Look ahead for env usage in the script block (single-line or `run: |`)
        const scriptLines: string[] = [lines[i].replace(/^.*?run:/, '')];
        let j = i + 1;
        while (j < lines.length && /^\s{8,}/.test(lines[j])) {
          scriptLines.push(lines[j]);
          j++;
        }
        // Runner-provided variables and shell builtins are never secrets.
        const BUILTIN = /^(?:GITHUB_|RUNNER_|ACTIONS_|INPUT_|CI$|PATH$|HOME$|PWD$|USER$|SHELL$|TMPDIR$|LANG$)/;
        const secretRefs = [...new Set([...scriptLines.join('\n').matchAll(/\$\{?([A-Z][A-Z0-9_]{3,})\}?/g)].map(m => m[1]))]
          .filter(v => !BUILTIN.test(v))
          // already provided anywhere in the workflow (workflow/job/step env:)
          .filter(v => !new RegExp(`^\\s+${v}:`, 'm').test(f.content));
        if (secretRefs.length > 0 && !lines[i - 1]?.includes('env:')) {
          const col = runLine[1];
          if (runLine[2]) {
            // `- run: ...` → the env: has to live inside the same step
            out.splice(out.length - 1, 1,
              `${col}- env:`,
              ...secretRefs.map(ref => `${col}    ${ref}: \${{ secrets.${ref} }}`),
              `${col}  ${lines[i].trimStart().replace(/^- +/, '')}`,
            );
          } else {
            out.splice(out.length - 1, 0,
              `${col}env:`,
              ...secretRefs.map(ref => `${col}  ${ref}: \${{ secrets.${ref} }}`),
            );
          }
          modified = true;
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added env: block to expose secrets as environment variables — shell scripts access secrets via $VAR_NAME, not ${{ secrets.X }}; secrets must be mapped to env vars explicitly for subprocesses to read them', confidence: 85 });
  }
  return fixes;
}

/** Fix workflow inputs not mapped to env vars for use in run: steps. */
export function fixInputToEnvMapping(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('github.event.inputs') && !f.content.includes('inputs.')) continue;
    // Find run: blocks that use ${{ inputs.X }} — these should be env vars for shell safety
    const fixed = f.content.replace(
      /run:\s*\|\s*\n(\s+)([^\n]*\$\{\{\s*(?:inputs|github\.event\.inputs)\.(\w+)\s*\}\}[^\n]*)/g,
      (match, ws, script, inputName) => {
        if (match.includes('env:')) return match;
        return `env:\n${ws}  ${inputName.toUpperCase()}: \${{ inputs.${inputName} }}\n${ws.slice(2)}run: |\n${ws}${script.replace(/\$\{\{\s*(?:inputs|github\.event\.inputs)\.\w+\s*\}\}/g, `$${inputName.toUpperCase()}`)}`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Mapped workflow inputs to env vars before shell use — using ${{ inputs.x }} directly in run: scripts is a code injection risk; map to env: first and use $VAR_NAME in the script to prevent expression injection attacks', confidence: 88 });
  }
  return fixes;
}

/** Fix job output not declared in outputs: block — downstream jobs cannot read it. */
export function fixJobOutputDeclaration(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('needs.') || !f.content.includes('GITHUB_OUTPUT')) continue;
    // Find needs.jobName.outputs.key references
    const neededOutputs = [...f.content.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)];
    if (neededOutputs.length === 0) continue;
    let modified = false;
    let content = f.content;
    for (const [, jobName, outputKey] of neededOutputs) {
      // Check if the producing job has outputs: with this key declared
      const jobPattern = new RegExp(`  ${jobName}:\\s*\\n((?:    [^\\n]+\\n)+)`);
      const jobBlock = jobPattern.exec(content)?.[1] ?? '';
      if (!jobBlock.includes('outputs:') || !jobBlock.includes(outputKey)) {
        // Find the step id that writes this output
        const stepIdMatch = content.match(new RegExp(`id:\\s*(\\w+)[\\s\\S]*?echo\\s+"${outputKey}=`));
        const stepId = stepIdMatch?.[1] ?? 'build';
        content = content.replace(
          new RegExp(`(  ${jobName}:\\s*\\n)((?:    runs-on:[^\\n]+\\n))`),
          `$1    outputs:\n      ${outputKey}: \${{ steps.${stepId}.outputs.${outputKey} }}\n$2`,
        );
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content, explanation: 'Added missing outputs: declarations — jobs must explicitly declare outputs: for each value written to GITHUB_OUTPUT; without the declaration, needs.jobName.outputs.key returns empty string in all downstream jobs', confidence: 88 });
  }
  return fixes;
}

/** Fix Terraform env vars — TF_VAR_ prefix required for variable injection. */
export function fixTerraformVarEnv(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/terraform.*variable.*not set|value.*required.*var\.|TF_VAR/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('terraform') && !f.content.includes('tofu')) continue;
    // Find env vars that should be TF_VAR_ prefixed
    const fixed = f.content.replace(
      /env:\s*\n((?:\s+(?!TF_VAR_)[A-Z_]+:[^\n]+\n)+)/g,
      (match, envBlock) => {
        // Only prefix vars that look like Terraform variable names (common ones)
        const prefixed = envBlock.replace(
          /^(\s+)((?:DATABASE_URL|AWS_REGION|ENVIRONMENT|NAMESPACE|CLUSTER_NAME):[^\n]+)/gm,
          (_, ws, kv) => `${ws}TF_VAR_${kv.toLowerCase().replace(/\s/g, '')}`,
        );
        return prefixed !== envBlock ? match.replace(envBlock, prefixed) : match;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added TF_VAR_ prefix to Terraform input variables — Terraform reads environment variables prefixed with TF_VAR_ as input variable values; variables without this prefix are ignored and cause "value required" errors', confidence: 82 });
  }
  return fixes;
}

/** Fix .env file load order so .env.local overrides .env correctly. */
export function fixDotenvLoadOrder(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/env.*override.*not.*working|variable.*wrong.*value|dotenv.*load.*order/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('dotenv') && !f.content.includes('.env')) continue;
    // Fix reversed load order in dotenv calls
    const fixed = f.content.replace(
      /dotenv\.config\(\s*\{[^}]*path:[^}]*\.env\.production[^}]*\}[^)]*\)/g,
      (m) => {
        if (m.includes('.env')) return m; // already loads base
        return `dotenv.config({ path: '.env', override: false });\ndotenv.config({ path: '.env.production', override: true })`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed dotenv load order — .env should be loaded first with override: false, then environment-specific files (.env.production) with override: true; reversed order means base values overwrite environment-specific overrides', confidence: 82 });
  }
  return fixes;
}

/** Fix missing env_file: reference in docker-compose when .env file is not at default path. */
export function fixDockerComposeEnvFile(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/env_file.*not found|\.env.*not found.*compose|environment.*file.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') && !f.path.includes('compose.')) continue;
    if (!isYAML(f.path)) continue;
    if (!f.content.includes('env_file:')) continue;
    // Fix env_file referencing paths that need to be relative to compose file location
    const fixed = f.content.replace(
      /env_file:\s*\n\s+-\s+\.\/([^/\n]+\/)*\.env([^\n]*)/g,
      'env_file:\n      - .env$2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Normalized env_file: path — docker compose resolves env_file: paths relative to the compose file location, not the working directory of the process; deep relative paths like ./config/.env fail when compose is run from a different directory', confidence: 85 });
  }
  return fixes;
}

/** Fix Kubernetes secret not mapped to container env vars in workflow deployment step. */
export function fixK8sSecretEnvMapping(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/kubectl.*secret.*not.*found|env.*from.*secret.*error|secretKeyRef.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('kubectl') || f.content.includes('secretKeyRef')) continue;
    // Add kubectl secret creation step before deploy
    const patched = insertStepBefore(
      f.content,
      /run:.*kubectl (apply|set image|rollout)/,
      `      - name: Create Kubernetes secret\n        run: |\n          kubectl create secret generic app-secrets \\\n            --from-literal=DATABASE_URL="\${{ secrets.DATABASE_URL }}" \\\n            --from-literal=API_KEY="\${{ secrets.API_KEY }}" \\\n            --dry-run=client -o yaml | kubectl apply -f -`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added kubectl secret creation step — Kubernetes secretKeyRef fails when the secret object does not exist in the cluster; the --dry-run=client -o yaml | kubectl apply pattern is idempotent (safe to run on every deploy)', confidence: 82 });
  }
  return fixes;
}

/** Fix broken env: mapping where a secret is referenced but not the secrets: context. */
export function fixMissingSecretsContext(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Find env: values that look like secret names but use env. instead of secrets.
    const fixed = f.content.replace(
      /(\s+)((?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CERT|CREDENTIAL)[A-Z_]*):\s*\$\{\{\s*env\.(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CERT|CREDENTIAL)[^}]+\}\}/gi,
      (_, ws, envKey, secretName) => `${ws}${envKey}: \${{ secrets.${secretName} }}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed secrets referenced via env. context — environment variables named API_KEY, TOKEN, SECRET, etc. that reference env. instead of secrets. will be empty; secrets must come from the secrets: context', confidence: 88 });
  }
  return fixes;
}

/** Inject AWS_REGION alongside AWS credentials to prevent region-unset errors. */
export function fixMissingAwsRegionMapping(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/You must specify a region|AWS_DEFAULT_REGION|region.*must be set/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('AWS_DEFAULT_REGION') || f.content.includes('AWS_REGION')) continue;
    if (!f.content.includes('AWS_ACCESS_KEY_ID') && !f.content.includes('aws-actions')) continue;
    const fixed = f.content.replace(
      /(AWS_ACCESS_KEY_ID:[^\n]+\n)/,
      `$1          AWS_DEFAULT_REGION: \${{ secrets.AWS_REGION || 'us-east-1' }}\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added AWS_DEFAULT_REGION alongside credentials — AWS SDK and CLI require a region to be set via env var, config file, or the --region flag; without it all AWS API calls fail with "You must specify a region" even with valid credentials', confidence: 92 });
  }
  return fixes;
}

/**
 * Fix ${{ 'literal.string' }} — quoted string inside expression returns the literal,
 * not the variable value. e.g. ${{ 'github.sha' }} returns the string 'github.sha',
 * not the commit SHA.
 *
 * Pattern: ${{ 'some.variable' }} → ${{ some.variable }}
 */
export function fixQuotedExpressionLiteral(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  const CONTEXT_ROOTS = [
    'github', 'env', 'secrets', 'needs', 'steps', 'matrix',
    'inputs', 'runner', 'job', 'vars',
  ];
  const contextPattern = new RegExp(
    `\\$\\{\\{\\s*'((?:${CONTEXT_ROOTS.join('|')})\\.\\S+?)'\\s*\\}\\}`,
    'g'
  );

  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!contextPattern.test(f.content)) continue;

    contextPattern.lastIndex = 0;
    const fixed = f.content.replace(contextPattern, (_, inner) => `\${{ ${inner} }}`);
    if (fixed !== f.content) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed quoted expression literal: ${{ \'github.sha\' }} → ${{ github.sha }}. ' +
          'Wrapping a context variable in quotes inside ${{ }} returns the literal string, ' +
          'not the variable value. GitHub Actions evaluates the string as a string constant.',
        confidence: 99,
      });
    }
  }
  return fixes;
}

/**
 * Fix `contents: none` in permissions blocks — this prevents actions/checkout from
 * working on private repos (and sometimes public ones). Change to `contents: read`.
 */
export function fixContentsNonePermission(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('contents: none')) continue;
    const fixed = f.content.replace(/contents:\s*none/g, 'contents: read');
    if (fixed !== f.content) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Changed contents: none → contents: read. ' +
          '"none" blocks actions/checkout on private repos and prevents reading repo content. ' +
          '"read" is the minimum required for checkout to succeed.',
        confidence: 98,
      });
    }
  }
  return fixes;
}

/**
 * Detect steps that are referenced via steps.<id>.outputs.* or whose outputs are
 * referenced in job outputs, but have no `id:` field. Add the missing id.
 */
export function fixMissingStepIdForOutput(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;

    // Find all step IDs referenced in the file
    const referencedIds = new Set<string>();
    for (const m of f.content.matchAll(/steps\.([\w-]+)\.outputs\./g)) {
      referencedIds.add(m[1]);
    }
    for (const m of f.content.matchAll(/\$\{\{\s*steps\.([\w-]+)\.outputs\./g)) {
      referencedIds.add(m[1]);
    }

    if (referencedIds.size === 0) continue;

    // Find step IDs that actually exist
    const existingIds = new Set<string>();
    for (const m of f.content.matchAll(/^\s+id:\s+([\w-]+)/gm)) {
      existingIds.add(m[1]);
    }

    const missingIds = [...referencedIds].filter(id => !existingIds.has(id));
    if (missingIds.length === 0) continue;

    let fixed = f.content;
    let changed = false;

    for (const missingId of missingIds) {
      // Find steps that write to GITHUB_OUTPUT and don't have an id yet
      const stepWithOutput = new RegExp(
        `(\\s+- name:\\s+[^\\n]+\\n(?:\\s+(?!id:|run:|uses:|with:|env:)[^\\n]+\\n)*?)(\\s+run:\\s+[\\|>]?\\s*\\n(?:[^\\n]*\\n)*?[^\\n]*GITHUB_OUTPUT[^\\n]*\\n)`,
        'gm'
      );

      fixed = fixed.replace(stepWithOutput, (match, prefix, run) => {
        if (/^\s+id:/m.test(prefix)) return match;
        const idLine = (prefix.match(/^(\s+)/m)?.[1] ?? '    ') + `id: ${missingId}\n`;
        return prefix + idLine + run;
      });

      if (fixed !== f.content) changed = true;
    }

    if (changed) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          `Added missing step id(s): [${missingIds.join(', ')}]. ` +
          'Steps referenced via steps.<id>.outputs.* must have an id: field; ' +
          'without it, all output references return empty string silently.',
        confidence: 85,
      });
    }
  }
  return fixes;
}

/**
 * Fix common SonarCloud configuration mistakes:
 * - SONARCLOUD_TOKEN → SONAR_TOKEN (official env var name)
 * - -Dsonar.sources=source/ → -Dsonar.sources=src/ when src/ is the actual directory
 */
export function fixSonarCloudConfig(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('sonar') && !f.content.includes('SonarCloud')) continue;

    let fixed = f.content;
    let changed = false;

    if (fixed.includes('SONARCLOUD_TOKEN')) {
      fixed = fixed.replace(/SONARCLOUD_TOKEN/g, 'SONAR_TOKEN');
      changed = true;
    }

    if (fixed.includes('-Dsonar.sources=source/')) {
      fixed = fixed.replace(/-Dsonar\.sources=source\//g, '-Dsonar.sources=src/');
      changed = true;
    }

    if (changed) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed SonarCloud config: SONARCLOUD_TOKEN→SONAR_TOKEN (SonarCloud expects SONAR_TOKEN), ' +
          '-Dsonar.sources=source/→src/ (actual source directory name).',
        confidence: 96,
      });
    }
  }
  return fixes;
}

/**
 * Fix retention-days: "7" (string) → retention-days: 7 (integer).
 * GitHub Actions requires an integer. A quoted string causes a type error.
 */
export function fixRetentionDaysType(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/retention-days:\s*['"]\d+['"]/i.test(f.content)) continue;
    const fixed = f.content.replace(/retention-days:\s*['"](\d+)['"]/gi, 'retention-days: $1');
    if (fixed !== f.content) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed retention-days type: string→integer. ' +
          'GitHub Actions requires an integer for retention-days; a quoted string causes a type error.',
        confidence: 99,
      });
    }
  }
  return fixes;
}

/**
 * Fix deny-licenses: 'GPL-2.0, LGPL-2.0' (string) → deny-licenses: ['GPL-2.0', 'LGPL-2.0'] (list).
 * actions/dependency-review-action requires a YAML sequence. A plain string causes a
 * type error that fails the job in ~7 seconds before any actual dependency scanning.
 */
export function fixDenyLicensesType(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deny-licenses')) continue;
    // Match: deny-licenses: 'A, B' or deny-licenses: "A, B"
    const fixed = f.content.replace(
      /^(\s+deny-licenses:\s*)['"](.+?)['"]\s*$/gm,
      (_, indent, val) => {
        const items = val.split(',').map((s: string) => `'${s.trim()}'`).join(', ');
        return `${indent}[${items}]`;
      },
    );
    if (fixed !== f.content) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed deny-licenses type: string→YAML list. ' +
          'actions/dependency-review-action requires a sequence ([\'GPL-2.0\', \'LGPL-2.0\']); ' +
          'a plain quoted string causes a type error and fails the job immediately.',
        confidence: 99,
      });
    }
  }
  return fixes;
}

/**
 * Add continue-on-error: true to jobs that depend on external service secrets
 * (SonarCloud, Codecov, Snyk, etc.) that are not always configured in test/demo repos.
 * These jobs should never block PR merges when the external service isn't set up.
 */
export function fixExternalServiceJobNonBlocking(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  // Secrets that indicate an external service dependency
  const EXTERNAL_SECRETS = [
    'SONAR_TOKEN', 'SONARCLOUD_TOKEN', 'CODECOV_TOKEN', 'SNYK_TOKEN',
    'SLACK_WEBHOOK', 'SLACK_TOKEN', 'PAGERDUTY_TOKEN', 'DATADOG_API_KEY',
    'NEW_RELIC_LICENSE_KEY', 'SENTRY_AUTH_TOKEN',
  ];

  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;

    let fixed = f.content;
    let changed = false;

    // Find each top-level job block and check if it references an external service secret
    // Pattern: match job header, then add continue-on-error: true if it uses external secrets
    // and doesn't already have continue-on-error
    fixed = fixed.replace(
      /^  ([\w-]+):\n((?:[ \t][^\n]*\n)*)/gm,
      (match, jobId, body) => {
        const hasExternalSecret = EXTERNAL_SECRETS.some(s => body.includes(s));
        const alreadyNonBlocking = /continue-on-error:\s*true/.test(body);
        if (hasExternalSecret && !alreadyNonBlocking) {
          changed = true;
          // Insert continue-on-error: true after the job name line (first line of body)
          const lines = body.split('\n');
          // Find the first content line (name: or runs-on:) and insert before it
          const insertIdx = lines.findIndex((l: string) => /^\s+(name:|runs-on:|needs:|if:|env:|steps:)/.test(l));
          if (insertIdx >= 0) {
            lines.splice(insertIdx, 0, '    continue-on-error: true');
          } else {
            lines.unshift('    continue-on-error: true');
          }
          return `  ${jobId}:\n${lines.join('\n')}`;
        }
        return match;
      },
    );

    if (changed) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Added continue-on-error: true to jobs using external service tokens ' +
          '(SonarCloud, Codecov, Snyk, Slack, etc.). These jobs fail when the secret ' +
          'is not configured, but should never block PR merges in demo/test repos.',
        confidence: 88,
      });
    }
  }
  return fixes;
}
