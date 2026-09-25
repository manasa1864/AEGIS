// Simple / Environment Variable Errors
// Covers: missing env vars, undefined secrets/tokens, incorrect env values,
// wrong .env configuration, variable scope issues — GitHub Actions and GitLab CI.

import { RuleFix, isGitHubWorkflow, isGitLabCI, injectWorkflowLevelBlock, extractSecretRefs, declareJobOutputs } from '../helpers';

// ── CATEGORY 1: MISSING ENVIRONMENT VARIABLE ─────────────────────────────────

/** Create .env.example when workflow references .env but no example file exists. */
export function fixCreateDotEnvExample(files: Array<{ path: string; content: string }>): RuleFix[] {
  const needsEnv = files.some(f => (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) &&
    (f.content.includes('.env') || f.content.includes('dotenv')));
  if (!needsEnv) return [];
  if (files.some(f => f.path === '.env.example' || f.path === '.env.sample')) return [];

  const allSecrets = new Set<string>();
  for (const f of files) for (const s of extractSecretRefs(f.content)) allSecrets.add(s);

  const lines = [
    '# Copy this file to .env and fill in the values',
    '# NEVER commit the actual .env file with real secrets',
    '# Optional vars are commented out',
    '',
  ];
  for (const s of allSecrets) lines.push(`${s}=`);
  if (!allSecrets.has('NODE_ENV'))      lines.push('NODE_ENV=development');
  if (!allSecrets.has('PORT'))          lines.push('PORT=3000');
  if (!allSecrets.has('LOG_LEVEL'))     lines.push('LOG_LEVEL=info');
  if (!allSecrets.has('DATABASE_URL'))  lines.push('# DATABASE_URL=postgres://user:password@localhost:5432/dbname');
  if (!allSecrets.has('REDIS_URL'))     lines.push('# REDIS_URL=redis://localhost:6379');
  if (!allSecrets.has('API_BASE_URL'))  lines.push('# API_BASE_URL=http://localhost:3000/api');

  return [{
    path: '.env.example',
    content: lines.join('\n') + '\n',
    explanation: 'Created .env.example — workflow references .env but no example file existed; example serves as documentation for required variables',
    confidence: 100,
  }];
}

/** Add NODE_ENV=test and CI=true when test/build commands run without them. */
export function fixMissingNodeEnv(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  const TEST_CMD = /npm\s+(run\s+)?(test|build)|pnpm\s+(run\s+)?(test|build)|yarn\s+(test|build)|bun\s+(test|run\s+(test|build))|vitest|jest|mocha|playwright|cypress/m;
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const hasNodeEnv = f.content.includes('NODE_ENV');
    const hasCI = /CI:\s*['"]?true/m.test(f.content);
    if (hasNodeEnv && hasCI) continue;
    if (!TEST_CMD.test(f.content)) continue;
    const entries: string[] = [];
    if (!hasNodeEnv) entries.push('  NODE_ENV: test');
    if (!hasCI)      entries.push("  CI: 'true'");
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added NODE_ENV=test and CI=true — webpack/babel/jest/vite toggle behavior on NODE_ENV; CI=true disables interactive prompts so tests do not hang', confidence: 100 });
  }
  return fixes;
}

/** Add CI=true specifically for test runners that check it (jest, vitest, mocha, playwright). */
export function fixMissingCIEnvFlag(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (/CI:\s*['"]?true/m.test(f.content)) continue;
    if (!/npm test|jest|vitest|mocha|playwright|cypress/m.test(f.content)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ["  CI: 'true'"]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added CI: 'true' — Jest/CRA/Vite/Playwright use this flag to disable interactive prompts; without it tests may hang waiting for input", confidence: 100 });
  }
  return fixes;
}

/** Add a safe default for non-sensitive env vars reported as missing in logs. */
export function fixEnvVarWithDefault(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/env.*not.*set|undefined.*env|required.*env.*variable|process\.env\.\w+.*undefined|Missing.*env/i.test(logs)) return [];
  const extractors = [
    /(?:env|variable)\s+[`'"]?([A-Z_][A-Z0-9_]*)[`'"]?\s+(?:not set|is undefined|required|not found)/i,
    /process\.env\.([A-Z_][A-Z0-9_]*)\s+is\s+undefined/i,
    /Missing\s+(?:required\s+)?env(?:ironment)?\s+(?:variable\s+)?[`'"]?([A-Z_][A-Z0-9_]*)[`'"]/i,
  ];
  let varName: string | null = null;
  for (const p of extractors) { const m = logs.match(p); if (m) { varName = m[1]; break; } }
  if (!varName) return [];
  if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE|AUTH/i.test(varName)) return [];
  const DEFAULTS: Record<string, string> = {
    PORT: '3000', HOST: 'localhost', NODE_ENV: 'test', LOG_LEVEL: 'info',
    TIMEOUT: '30000', RETRY_COUNT: '3', MAX_RETRIES: '3',
    BASE_URL: 'http://localhost:3000', API_URL: 'http://localhost:3000/api',
    API_BASE_URL: 'http://localhost:3000/api', APP_URL: 'http://localhost:3000',
    DB_PORT: '5432', DB_HOST: 'localhost', DB_NAME: 'testdb',
    DB_USER: 'testuser', DB_DATABASE: 'testdb',
    REDIS_PORT: '6379', REDIS_HOST: 'localhost',
    MONGO_HOST: 'localhost', MONGO_PORT: '27017',
    ELASTICSEARCH_URL: 'http://localhost:9200',
    APP_ENV: 'test', ENVIRONMENT: 'test', STAGE: 'test',
    POOL_SIZE: '5', WORKERS: '2', CONCURRENCY: '4',
    CACHE_TTL: '300', SESSION_TTL: '3600',
    MAX_CONNECTIONS: '10', CONNECTION_TIMEOUT: '5000',
    UPLOAD_LIMIT: '10mb', BODY_LIMIT: '1mb',
    CORS_ORIGIN: 'http://localhost:3000',
    SMTP_HOST: 'localhost', SMTP_PORT: '1025',
    AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1',
    TZ: 'UTC', LANG: 'en_US.UTF-8',
  };
  const val = DEFAULTS[varName] ?? `placeholder-${varName.toLowerCase().replace(/_/g, '-')}`;
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes(varName!)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [`  ${varName}: '${val}'`]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added default ${varName}='${val}' — env var was missing; app/test framework crashed because it expected the variable to exist`, confidence: 100 });
  }
  return fixes;
}

/** Add global variables block to GitLab CI when variables are reported undefined. */
export function fixGitLabMissingVariables(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/env.*not.*set|variable.*not.*defined|CI_.*undefined|undefined.*variable/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('variables:')) {
      const needsGitDepth = !f.content.includes('GIT_DEPTH');
      const needsFastZip  = !f.content.includes('FF_USE_FASTZIP');
      if (!needsGitDepth && !needsFastZip) continue;
      let content = f.content;
      if (needsGitDepth) content = content.replace(/^(variables:\s*\n)/m, "$1  GIT_DEPTH: '10'\n");
      if (needsFastZip)  content = content.replace(/^(variables:\s*\n)/m, "$1  FF_USE_FASTZIP: 'true'\n");
      if (content !== f.content)
        fixes.push({ path: f.path, content, explanation: 'Added missing GitLab CI variables — GIT_DEPTH reduces clone time; FF_USE_FASTZIP speeds up artifact compression', confidence: 100 });
      continue;
    }
    fixes.push({
      path: f.path,
      content: `variables:\n  GIT_DEPTH: '10'\n  NODE_ENV: test\n  FF_USE_FASTZIP: 'true'\n  ARTIFACT_COMPRESSION_LEVEL: fast\n  GIT_CLEAN_FLAGS: -ffdx\n  DOCKER_DRIVER: overlay2\n  DOCKER_TLS_CERTDIR: ''\n\n` + f.content,
      explanation: 'Added global variables block to GitLab CI — undefined variables were crashing jobs; also added FF_USE_FASTZIP for faster artifact compression and GIT_DEPTH for faster clones',
      confidence: 100,
    });
  }
  return fixes;
}

/** Add AWS_DEFAULT_REGION when AWS CLI/SDK is used but no region env var is set. */
export function fixMissingAwsRegion(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!/aws\s+|aws-actions\/|configure-aws-credentials|boto3|awscli/i.test(f.content)) continue;
    if (/AWS_DEFAULT_REGION|AWS_REGION/m.test(f.content)) continue;
    if (isGitHubWorkflow(f.path)) {
      const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  AWS_DEFAULT_REGION: us-east-1']);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: "Added AWS_DEFAULT_REGION=us-east-1 — AWS CLI and SDK require a region; without it commands fail with 'You must specify a region'; update to your target region", confidence: 100 });
    } else {
      const base = f.content.includes('variables:')
        ? f.content.replace(/^(variables:\s*\n)/m, '$1  AWS_DEFAULT_REGION: us-east-1\n')
        : `variables:\n  AWS_DEFAULT_REGION: us-east-1\n\n` + f.content;
      if (base !== f.content)
        fixes.push({ path: f.path, content: base, explanation: "Added AWS_DEFAULT_REGION=us-east-1 — AWS CLI requires a region", confidence: 100 });
    }
  }
  return fixes;
}

/** Add PYTHONUNBUFFERED, PYTHONDONTWRITEBYTECODE, PYTHONPATH for Python workflows. */
export function fixPythonEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/python|pip|pytest|poetry|uv\s+run|pdm\s+run/i.test(f.content)) continue;
    const hasPythonUnbuf    = f.content.includes('PYTHONUNBUFFERED');
    const hasPythonNoWrite  = f.content.includes('PYTHONDONTWRITEBYTECODE');
    if (hasPythonUnbuf && hasPythonNoWrite) continue;
    const entries: string[] = [];
    if (!hasPythonUnbuf)   entries.push("  PYTHONUNBUFFERED: '1'");
    if (!hasPythonNoWrite) entries.push("  PYTHONDONTWRITEBYTECODE: '1'");
    if (!f.content.includes('PYTHONPATH')) entries.push('  PYTHONPATH: ${{ github.workspace }}');
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Python CI env vars — PYTHONUNBUFFERED=1 flushes print/logging immediately; PYTHONDONTWRITEBYTECODE=1 prevents .pyc clutter; PYTHONPATH ensures imports resolve from workspace root', confidence: 100 });
  }
  return fixes;
}

/** Add MAVEN_OPTS / GRADLE_OPTS for Java workflows. */
export function fixJavaEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/mvn|maven|gradle|gradlew|actions\/setup-java/i.test(f.content)) continue;
    if (/JAVA_OPTS|MAVEN_OPTS|GRADLE_OPTS/m.test(f.content)) continue;
    const isMaven  = /mvn|maven/i.test(f.content);
    const isGradle = /gradle|gradlew/i.test(f.content);
    const entries: string[] = [];
    if (isMaven)  entries.push("  MAVEN_OPTS: '-Xmx1024m -Dfile.encoding=UTF-8'");
    if (isGradle) entries.push("  GRADLE_OPTS: '-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx2048m'");
    if (!isMaven && !isGradle) entries.push("  JAVA_OPTS: '-Xmx1024m -Dfile.encoding=UTF-8'");
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added JVM options — CI runners have limited memory; MAVEN_OPTS/GRADLE_OPTS set heap size and file encoding; Gradle daemon disabled to avoid persistent background processes', confidence: 100 });
  }
  return fixes;
}

/** Add GOFLAGS, CGO_ENABLED, GOPROXY for Go workflows. */
export function fixGoEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/\bgo\s+(build|test|run|get|mod|install)\b|actions\/setup-go|golangci-lint/i.test(f.content)) continue;
    if (/GOFLAGS|CGO_ENABLED|GOPROXY/m.test(f.content)) continue;
    const entries = [
      "  GOFLAGS: '-mod=mod'",
      "  CGO_ENABLED: '0'",
      '  GOPROXY: https://proxy.golang.org,direct',
    ];
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Go CI env vars — CGO_ENABLED=0 produces static binaries with no runtime deps; GOPROXY speeds module downloads; GOFLAGS=-mod=mod allows automatic go.mod updates', confidence: 100 });
  }
  return fixes;
}

/** Add CARGO_TERM_COLOR, RUST_BACKTRACE, CARGO_INCREMENTAL for Rust workflows. */
export function fixCargoEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/cargo\s+(build|test|run|check|clippy|fmt)|actions-rs\//i.test(f.content)) continue;
    if (/CARGO_TERM_COLOR|RUST_BACKTRACE|CARGO_INCREMENTAL/m.test(f.content)) continue;
    const entries = [
      '  CARGO_TERM_COLOR: always',
      '  RUST_BACKTRACE: 1',
      "  CARGO_INCREMENTAL: '0'",
    ];
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Rust CI env vars — CARGO_TERM_COLOR=always preserves colored output; RUST_BACKTRACE=1 shows full backtraces on panics; CARGO_INCREMENTAL=0 is faster for clean CI builds', confidence: 100 });
  }
  return fixes;
}

/** Detect ${{ env.VAR }} references that have no corresponding env: declaration. */
export function fixUndeclaredEnvVarReference(files: Array<{ path: string; content: string }>): RuleFix[] {
  const BUILTIN = new Set([
    'CI','GITHUB_ACTIONS','GITHUB_ACTOR','GITHUB_API_URL','GITHUB_BASE_REF','GITHUB_ENV',
    'GITHUB_EVENT_NAME','GITHUB_EVENT_PATH','GITHUB_GRAPHQL_URL','GITHUB_HEAD_REF',
    'GITHUB_JOB','GITHUB_OUTPUT','GITHUB_PATH','GITHUB_REF','GITHUB_REF_NAME',
    'GITHUB_REF_PROTECTED','GITHUB_REF_TYPE','GITHUB_REPOSITORY','GITHUB_REPOSITORY_OWNER',
    'GITHUB_RETENTION_DAYS','GITHUB_RUN_ATTEMPT','GITHUB_RUN_ID','GITHUB_RUN_NUMBER',
    'GITHUB_SERVER_URL','GITHUB_SHA','GITHUB_STATE','GITHUB_STEP_SUMMARY','GITHUB_TOKEN',
    'GITHUB_WORKFLOW','GITHUB_WORKSPACE','RUNNER_ARCH','RUNNER_NAME','RUNNER_OS',
    'RUNNER_TEMP','RUNNER_TOOL_CACHE',
  ]);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const declaredVars = new Set([...f.content.matchAll(/^\s{2,6}(\w+):\s*\S/gm)].map(m => m[1]));
    const referenced = [...f.content.matchAll(/\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g)].map(m => m[1]);
    const undeclared = [...new Set(referenced)].filter(v => !declaredVars.has(v) && !BUILTIN.has(v));
    if (undeclared.length === 0) continue;
    const toAdd = undeclared.filter(v => !/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(v));
    if (toAdd.length === 0) continue;
    const entries = toAdd.map(v => `  ${v}: ''  # aegis: set this variable`);
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added placeholder declarations for undeclared env vars [${toAdd.join(', ')}] — \${{ env.VAR }} with no env: declaration resolves to empty string silently breaking scripts`, confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 2: UNDEFINED SECRET / TOKEN ─────────────────────────────────────

/** Add continue-on-error to steps using a secret reported missing in logs. */
export function fixOptionalSecretSteps(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/secret.*not.*found|Required.*secret.*missing|could not find secret|secret.*undefined|unresolved.*secret/i.test(logs)) return [];
  const extractors = [
    /secrets?\s+[`'"]?([A-Z_][A-Z0-9_]*)[`'"]?/i,
    /[`'"]([A-Z_][A-Z0-9_]{2,})[`'"].*(?:not found|undefined|missing)/i,
    /(?:secret|token|key)\s+([A-Z_][A-Z0-9_]*)\s+(?:is|was)?\s*(?:not|un)/i,
  ];
  let missing: string | null = null;
  for (const p of extractors) { const m = logs.match(p); if (m) { missing = m[1]; break; } }
  if (!missing) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes(missing!)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (lines[i].includes(missing!) && !lines[i].trim().startsWith('#')) {
        const indent = (lines[i].match(/^(\s*)/) ?? ['', '      '])[1];
        if (i + 1 < lines.length && !lines[i + 1].includes('continue-on-error')) {
          out.push(`${indent}continue-on-error: true  # aegis: ${missing} may not be set in this repo`);
          modified = true;
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: `Added continue-on-error near ${missing} usage — secret not configured; step will skip gracefully rather than failing the entire workflow`, confidence: 100 });
  }
  return fixes;
}

/** Replace hardcoded secrets/tokens in YAML with secret references. */
export function fixHardcodedSecretInYaml(files: Array<{ path: string; content: string }>): RuleFix[] {
  const SECRET_PATTERNS: Array<[RegExp, string]> = [
    // GitHub
    [/:\s*ghp_[A-Za-z0-9]{36,}/g,                ': ${{ secrets.GITHUB_PAT }}'],
    [/:\s*github_pat_[A-Za-z0-9_]{80,}/g,         ': ${{ secrets.GITHUB_PAT }}'],
    [/:\s*ghs_[A-Za-z0-9]{36,}/g,                 ': ${{ secrets.GITHUB_TOKEN }}'],
    // Slack
    [/:\s*xox[bpaors]-[0-9A-Za-z-]{10,}/g,        ': ${{ secrets.SLACK_TOKEN }}'],
    // OpenAI
    [/:\s*sk-[A-Za-z0-9]{32,}/g,                  ': ${{ secrets.OPENAI_API_KEY }}'],
    // Google
    [/:\s*AIza[A-Za-z0-9_-]{35}/g,                ': ${{ secrets.GOOGLE_API_KEY }}'],
    // AWS
    [/:\s*AKIA[A-Z0-9]{16}/g,                     ': ${{ secrets.AWS_ACCESS_KEY_ID }}'],
    // Stripe
    [/:\s*sk_live_[A-Za-z0-9]{24,}/g,             ': ${{ secrets.STRIPE_SECRET_KEY }}'],
    [/:\s*sk_test_[A-Za-z0-9]{24,}/g,             ': ${{ secrets.STRIPE_TEST_KEY }}'],
    [/:\s*rk_live_[A-Za-z0-9]{24,}/g,             ': ${{ secrets.STRIPE_RESTRICTED_KEY }}'],
    [/:\s*pk_live_[A-Za-z0-9]{24,}/g,             ': ${{ secrets.STRIPE_PUBLISHABLE_KEY }}'],
    // Twilio
    [/:\s*AC[a-f0-9]{32}/g,                        ': ${{ secrets.TWILIO_ACCOUNT_SID }}'],
    [/:\s*SK[a-f0-9]{32}/g,                        ': ${{ secrets.TWILIO_API_KEY }}'],
    // SendGrid
    [/:\s*SG\.[A-Za-z0-9._-]{60,}/g,              ': ${{ secrets.SENDGRID_API_KEY }}'],
    // NPM
    [/:\s*npm_[A-Za-z0-9]{36,}/g,                 ': ${{ secrets.NPM_TOKEN }}'],
    // Cloudflare
    [/:\s*v1\.0\/[A-Za-z0-9+/]{43}=/g,            ': ${{ secrets.CLOUDFLARE_API_TOKEN }}'],
    // Datadog
    [/:\s*[a-f0-9]{32}(?:\s|$)/gm,                ': ${{ secrets.DATADOG_API_KEY }}'],
    // Passwords / generic keys (conservative — only obvious plain values)
    [/password:\s*(?!['"]?\$)[A-Za-z0-9!@#$%^&*]{8,}(?:\s|$)/gm, 'password: ${{ secrets.DB_PASSWORD }}'],
    [/api_key:\s*(?!['"]?\$)[A-Za-z0-9_-]{20,}(?:\s|$)/gm,       'api_key: ${{ secrets.API_KEY }}'],
    [/auth_token:\s*(?!['"]?\$)[A-Za-z0-9_-]{20,}(?:\s|$)/gm,    'auth_token: ${{ secrets.AUTH_TOKEN }}'],
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    let content = f.content;
    let changed = false;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        pattern.lastIndex = 0;
        content = content.replace(pattern, replacement);
        changed = true;
      }
    }
    if (changed)
      fixes.push({ path: f.path, content, explanation: 'Replaced hardcoded secrets with secret references — hardcoded tokens are exposed in git history, logs, and to all repo contributors; store them in Settings > Secrets', confidence: 100 });
  }
  return fixes;
}

/** Add permissions block when jobs call GitHub APIs that require write access. */
export function fixMissingGitHubTokenPermissions(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('permissions:')) continue;
    const needsWrite  = /gh pr create|gh issue create|git push|create.*release|upload.*release|codecov/i.test(f.content);
    const needsPR     = /pull.request|pr.*label|pr.*comment/i.test(f.content);
    const needsPkg    = /packages.*write|ghcr\.io/i.test(f.content);
    const needsPages  = /github\.io|gh-pages|peaceiris\/actions-gh-pages/i.test(f.content);
    const needsChecks = /check.*run|status.*context/i.test(f.content);
    if (!needsWrite && !needsPR && !needsPkg && !needsPages && !needsChecks) continue;
    const permLines = ['  contents: write'];
    if (needsPR)     permLines.push('  pull-requests: write');
    if (needsPkg)    permLines.push('  packages: write');
    if (needsPages)  permLines.push('  pages: write', '  id-token: write');
    if (needsChecks) permLines.push('  checks: write', '  statuses: write');
    permLines.push('  issues: write');
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', permLines);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added permissions block — GITHUB_TOKEN is read-only by default; git push, PR creation, package publishing, and GitHub Pages require explicit write permissions', confidence: 100 });
  }
  return fixes;
}

/** Add NPM_TOKEN when npm publish is detected but no token is configured. */
export function fixMissingNpmPublishToken(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/npm publish|npm.*--access/m.test(f.content)) continue;
    if (/NPM_TOKEN|NODE_AUTH_TOKEN/m.test(f.content)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (!modified && /npm publish/.test(lines[i])) {
        const indent = (lines[i].match(/^(\s+)/) ?? ['', '        '])[1];
        out.splice(out.length - 1, 0,
          `${indent.slice(0, -2)}env:`,
          `${indent}NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`,
        );
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added NODE_AUTH_TOKEN for npm publish — publishing to npm requires authentication; create an npm automation token and store it as the NPM_TOKEN repository secret', confidence: 100 });
  }
  return fixes;
}

/** Add Docker registry login step when docker push is detected without authentication. */
export function fixMissingDockerRegistrySecrets(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/docker\s+push|docker\/build-push-action/m.test(f.content)) continue;
    if (/docker\s+login|docker\/login-action|DOCKER_USERNAME|REGISTRY_USER/m.test(f.content)) continue;
    const isGHCR = /ghcr\.io/m.test(f.content);
    const isECR  = /\.dkr\.ecr\.|ecr.*aws|aws.*ecr/m.test(f.content);
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      if (!modified && /docker\s+push|docker\/build-push-action/.test(lines[i])) {
        const rawIndent = (lines[i].match(/^(\s+)/) ?? ['', '      '])[1];
        const stepBase  = rawIndent.length >= 6 ? rawIndent.slice(0, rawIndent.length - 2) : rawIndent;
        if (isGHCR) {
          out.push(`${stepBase}- name: Log in to GHCR`);
          out.push(`${stepBase}  uses: docker/login-action@v3`);
          out.push(`${stepBase}  with:`);
          out.push(`${stepBase}    registry: ghcr.io`);
          out.push(`${stepBase}    username: \${{ github.actor }}`);
          out.push(`${stepBase}    password: \${{ secrets.GITHUB_TOKEN }}`);
        } else if (isECR) {
          out.push(`${stepBase}- name: Configure AWS credentials for ECR`);
          out.push(`${stepBase}  uses: aws-actions/configure-aws-credentials@v4`);
          out.push(`${stepBase}  with:`);
          out.push(`${stepBase}    aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}`);
          out.push(`${stepBase}    aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}`);
          out.push(`${stepBase}    aws-region: us-east-1`);
        } else {
          out.push(`${stepBase}- name: Log in to Docker Hub`);
          out.push(`${stepBase}  uses: docker/login-action@v3`);
          out.push(`${stepBase}  with:`);
          out.push(`${stepBase}    username: \${{ secrets.DOCKER_USERNAME }}`);
          out.push(`${stepBase}    password: \${{ secrets.DOCKER_PASSWORD }}`);
        }
        modified = true;
      }
      out.push(lines[i]);
    }
    if (modified) {
      const reg = isGHCR ? 'GHCR' : isECR ? 'ECR' : 'Docker Hub';
      fixes.push({ path: f.path, content: out.join('\n'), explanation: `Added ${reg} login step before docker push — unauthenticated push always fails with 'unauthorized: authentication required'`, confidence: 100 });
    }
  }
  return fixes;
}

/** Fix GitLab CI variables that should be masked/protected. */
export function fixGitLabVariableMasking(files: Array<{ path: string; content: string }>): RuleFix[] {
  const SENSITIVE = /password|token|secret|key|credential|api_key|auth|passwd|private/i;
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let inVars = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^variables:\s*$/.test(line)) { inVars = true; out.push(line); continue; }
      if (inVars && /^\S/.test(line))   inVars = false;
      if (inVars && SENSITIVE.test(line) && !line.trim().startsWith('#')) {
        const m = line.match(/^\s+(\w+):\s*(.+)$/);
        if (m && !m[2].includes('$') && !m[2].includes('{{')) {
          out.push(`  # aegis: move ${m[1]} to GitLab CI/CD Settings > Variables (protected + masked)`);
          out.push(`  ${m[1]}: $${m[1]}`);
          modified = true;
          continue;
        }
      }
      out.push(line);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Replaced plaintext sensitive variables — credentials in .gitlab-ci.yml are visible to all contributors; store them in Settings > CI/CD > Variables as protected+masked', confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 3: INCORRECT ENVIRONMENT VARIABLE VALUE ─────────────────────────

/** Fix deprecated ::set-output → echo "name=value" >> $GITHUB_OUTPUT */
export function fixDeprecatedSetOutput(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('::set-output')) continue;
    const content = f.content
      .replace(/echo\s+"::set-output\s+name=([^:]+)::([^"]+)"/g, 'echo "$1=$2" >> $GITHUB_OUTPUT')
      .replace(/echo\s+'::set-output\s+name=([^:]+)::([^']+)'/g, "echo '$1=$2' >> \$GITHUB_OUTPUT")
      .replace(/echo\s+::set-output\s+name=(\w+)::(\S+)/g, 'echo "$1=$2" >> $GITHUB_OUTPUT');
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Replaced deprecated ::set-output with $GITHUB_OUTPUT — deprecated in runner v2.285.0 (Oct 2022) and disabled in v2.298.2+; workflows using it fail on all current GitHub-hosted runners', confidence: 100 });
  }
  return fixes;
}

/** Fix deprecated ::set-env → echo "name=value" >> $GITHUB_ENV */
export function fixDeprecatedSetEnv(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('::set-env')) continue;
    const content = f.content
      .replace(/echo\s+"::set-env\s+name=([^:]+)::([^"]+)"/g, 'echo "$1=$2" >> $GITHUB_ENV')
      .replace(/echo\s+'::set-env\s+name=([^:]+)::([^']+)'/g, "echo '$1=$2' >> \$GITHUB_ENV")
      .replace(/echo\s+::set-env\s+name=(\w+)::(\S+)/g, 'echo "$1=$2" >> $GITHUB_ENV');
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Replaced deprecated ::set-env with $GITHUB_ENV — ::set-env was removed due to CVE-2022-24765 (security vulnerability); environment file approach is the secure replacement', confidence: 100 });
  }
  return fixes;
}

/** Fix deprecated ::save-state → echo "key=value" >> $GITHUB_STATE */
export function fixDeprecatedSaveState(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('::save-state')) continue;
    const content = f.content.replace(/echo "::save-state name=([^:]+)::([^"]+)"/g, 'echo "$1=$2" >> $GITHUB_STATE');
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Replaced deprecated ::save-state with $GITHUB_STATE file write — deprecated alongside ::set-output in runner v2.285.0+', confidence: 100 });
  }
  return fixes;
}

/** Fix NODE_ENV=production in workflows that run tests — tests need NODE_ENV=test. */
export function fixIncorrectNodeEnvValue(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/npm test|jest|vitest|mocha|pytest|rspec|cargo test/m.test(f.content)) continue;
    if (!/NODE_ENV:\s*['"]?production/m.test(f.content)) continue;
    const content = f.content
      .replace(/NODE_ENV:\s*production/g, 'NODE_ENV: test')
      .replace(/NODE_ENV:\s*'production'/g, "NODE_ENV: 'test'")
      .replace(/NODE_ENV:\s*"production"/g, "NODE_ENV: 'test'");
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Changed NODE_ENV from production to test — running tests with NODE_ENV=production disables source maps and development-only assertions; test frameworks expect NODE_ENV=test', confidence: 100 });
  }
  return fixes;
}

/** Add TF_CLI_ARGS, TF_IN_AUTOMATION, TF_INPUT for Terraform/OpenTofu workflows. */
export function fixTerraformEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!/terraform|tofu|opentofu/i.test(f.content)) continue;
    if (/TF_CLI_ARGS|TF_IN_AUTOMATION/m.test(f.content)) continue;
    if (isGitHubWorkflow(f.path)) {
      const fixed = injectWorkflowLevelBlock(f.content, 'env', [
        '  TF_CLI_ARGS: -no-color',
        '  TF_IN_AUTOMATION: true',
        '  TF_INPUT: false',
        '  TF_PLUGIN_CACHE_DIR: ${{ github.workspace }}/.terraform-plugin-cache',
      ]);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added Terraform CI env vars — TF_IN_AUTOMATION disables prompts; TF_INPUT=false prevents interactive input; TF_CLI_ARGS=-no-color produces clean logs; plugin cache reduces provider download time', confidence: 100 });
    } else {
      const fixed = f.content.replace(
        /^(variables:\s*\n)/m,
        '$1  TF_CLI_ARGS: -no-color\n  TF_IN_AUTOMATION: "true"\n  TF_INPUT: "false"\n',
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added Terraform CI env vars — TF_IN_AUTOMATION disables prompts; TF_INPUT=false prevents interactive input', confidence: 100 });
    }
  }
  return fixes;
}

/** Add --build-arg flags to docker build when Dockerfile ARGs are undeclared. */
export function fixDockerBuildArgEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('docker build') && !f.content.includes('docker/build-push-action')) continue;
    const dockerfile = files.find(fi => fi.path === 'Dockerfile' || fi.path.endsWith('/Dockerfile'));
    if (!dockerfile) continue;
    const buildArgs = [...dockerfile.content.matchAll(/^ARG\s+(\w+)/gm)].map(m => m[1]);
    if (buildArgs.length === 0) continue;
    const skip = new Set(['NODE_ENV','BUILDKIT_INLINE_CACHE','BUILD_DATE','VCS_REF','VERSION','REVISION','CREATED']);
    const missing = buildArgs.filter(a => !f.content.includes(`--build-arg ${a}`) && !f.content.includes('build-args:') && !skip.has(a));
    if (missing.length === 0) continue;
    const flags = missing.map(a => `--build-arg ${a}=\${{ env.${a} || '' }}`).join(' \\\n            ');
    const content = f.content.replace(/(docker\s+build\s+)/g, `$1${flags} \\\n            `);
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Added --build-arg for [${missing.join(', ')}] — Dockerfile ARG values default to empty if not supplied at build time which silently breaks the image`, confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 4: WRONG .ENV CONFIGURATION ─────────────────────────────────────

/** Add .env* to .gitignore when a workflow references .env or a .env file exists. */
export function fixDotEnvInGitignore(files: Array<{ path: string; content: string }>): RuleFix[] {
  const workflowRefsDotEnv = files.some(f =>
    (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) &&
    (f.content.includes('.env') || f.content.includes('dotenv')),
  );
  const hasDotEnvFile = files.some(f => f.path === '.env' || f.path.endsWith('/.env'));
  if (!workflowRefsDotEnv && !hasDotEnvFile) return [];

  const gitignore = files.find(f => f.path === '.gitignore');
  const existing  = gitignore?.content ?? '';
  if (/^\.env/m.test(existing)) return [];

  const block = [
    '',
    '# Environment files — NEVER commit real secrets',
    '.env',
    '.env.local',
    '.env.*.local',
    '.env.development.local',
    '.env.test.local',
    '.env.production.local',
  ].join('\n');

  if (gitignore) {
    return [{
      path: '.gitignore',
      content: existing + block + '\n',
      explanation: 'Added .env* to .gitignore — committing .env files exposes secrets in git history; .env.example (committed) + .env (gitignored) is the correct pattern',
      confidence: 100,
    }];
  }
  return [{
    path: '.gitignore',
    content: `# Generated by Aegis\nnode_modules/\ndist/\nbuild/\n.cache/\n*.log\n${block}\n`,
    explanation: 'Created .gitignore with .env* exclusions — workflow references .env which must never be committed with real secrets',
    confidence: 100,
  }];
}

// ── CATEGORY 5: VARIABLE SCOPE ISSUES ────────────────────────────────────────

/** Move env vars declared identically in multiple jobs to workflow-level env block. */
export function fixPromoteRepeatedEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const jobEnvRe = /^    env:\n((?:      [^\n]+\n)+)/gm;
    const blocks: string[][] = [];
    let m: RegExpExecArray | null;
    while ((m = jobEnvRe.exec(f.content)) !== null) {
      blocks.push([...m[1].matchAll(/^\s+([\w_]+):\s*(.+)/gm)].map(e => `${e[1]}:${e[2].trim()}`));
    }
    if (blocks.length < 2) continue;
    const repeated = blocks[0].filter(e => blocks.every(b => b.includes(e)));
    if (repeated.length === 0) continue;
    let content = f.content;
    for (const entry of repeated) {
      const [k, v] = entry.split(':');
      content = injectWorkflowLevelBlock(content, 'env', [`  ${k}: ${v}`]);
      content = content.replace(new RegExp(`^      ${k}:[^\n]+\n`, 'gm'), '');
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Promoted ${repeated.length} repeated env var(s) to workflow level — repeated per-job vars are fragile and easy to forget to update`, confidence: 100 });
  }
  return fixes;
}

/** Promote job-level env vars that are referenced in multiple jobs to workflow level. */
export function fixVariableScopeIssue(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const jobEnvVars = new Map<string, string>();
    let inJobEnv = false;
    for (const line of lines) {
      if (/^  \w[\w-]+:\s*$/.test(line)) inJobEnv = false;
      if (/^    env:\s*$/.test(line)) { inJobEnv = true; continue; }
      if (inJobEnv && /^      (\w+):\s*(.+)$/.test(line)) {
        const mm = line.match(/^      (\w+):\s*(.+)$/);
        if (mm) jobEnvVars.set(mm[1], mm[2]);
      }
      if (inJobEnv && !/^      /.test(line)) inJobEnv = false;
    }
    if (jobEnvVars.size === 0) continue;
    const crossJob = [...jobEnvVars.keys()].some(v =>
      (f.content.match(new RegExp(`\\$${v}|env\\.${v}`, 'g')) ?? []).length > 1,
    );
    if (!crossJob) continue;
    const entries: string[] = [];
    for (const [k, v] of jobEnvVars) {
      if (!f.content.match(new RegExp(`^env:\\n(?:  [^\\n]+\\n)*  ${k}:`, 'm')))
        entries.push(`  ${k}: ${v}`);
    }
    if (entries.length === 0) continue;
    const content = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Promoted ${entries.length} env var(s) to workflow level — job-level env: vars are NOT visible to other jobs; they must be at workflow level or passed as job outputs`, confidence: 100 });
  }
  return fixes;
}

/** Flag ${{ steps.ID.outputs.VAR }} references to step IDs that don't exist. */
export function fixStepOutputScopeError(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const stepIds = new Set([...f.content.matchAll(/^\s+id:\s+(\S+)/gm)].map(m => m[1]));
    if (stepIds.size === 0) continue;
    const refs = [...f.content.matchAll(/\$\{\{\s*steps\.([\w-]+)\./g)].map(m => m[1]);
    const bad  = [...new Set(refs)].filter(id => !stepIds.has(id));
    if (bad.length === 0) continue;
    // Annotate on a separate comment line above each reference — never split
    // the ${{ steps.x... }} expression itself, which broke it at runtime.
    const lines = f.content.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      const missing = bad.find(id => new RegExp(`\\$\\{\\{\\s*steps\\.${id}\\.`).test(line));
      if (missing) out.push(`${line.match(/^\s*/)![0]}# aegis: step id '${missing}' not found — add 'id: ${missing}' to the producing step`);
      out.push(line);
    }
    const content = out.join('\n');
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Flagged references to undeclared step IDs [${bad.join(', ')}] — steps.ID.outputs.VAR returns empty string when the step has no matching id:`, confidence: 100 });
  }
  return fixes;
}

/** Add outputs: declaration when echo >> $GITHUB_OUTPUT is used but no job outputs block exists. */
export function fixMissingJobOutputsDeclaration(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('>> $GITHUB_OUTPUT') && !f.content.includes('>>$GITHUB_OUTPUT')) continue;
    if (/^\s{4}outputs:/m.test(f.content)) continue;
    const declared = declareJobOutputs(f.content);
    if (declared)
      fixes.push({ path: f.path, content: declared.content, explanation: `Added outputs: block for [${declared.names.join(', ')}] — values written to GITHUB_OUTPUT are only accessible to other jobs when declared in the job's outputs: section`, confidence: 100 });
  }
  return fixes;
}

/** Add workflow_dispatch trigger when github.event.inputs is used without it. */
export function fixEventInputScope(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('github.event.inputs') && !/\$\{\{\s*inputs\./m.test(f.content)) continue;
    if (/workflow_dispatch|workflow_call/m.test(f.content)) continue;
    const inputNames = [
      ...[...f.content.matchAll(/github\.event\.inputs\.(\w+)/g)].map(m => m[1]),
      ...[...f.content.matchAll(/\$\{\{\s*inputs\.(\w+)/g)].map(m => m[1]),
    ];
    const unique = [...new Set(inputNames)];
    if (unique.length === 0) continue;
    const inputsBlock = unique.map(name =>
      `        ${name}:\n          description: '${name}'\n          required: false\n          default: ''`,
    ).join('\n');
    // Insert workflow_dispatch before the first non-on-colon trigger
    const content = f.content.replace(
      /^(on:\s*\n)((?:  \w[\s\S]*?)(?=\njobs:|\n\w))/m,
      `$1$2  workflow_dispatch:\n    inputs:\n${inputsBlock}\n`,
    );
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Added workflow_dispatch trigger with inputs [${unique.join(', ')}] — github.event.inputs / inputs context is only populated for workflow_dispatch and workflow_call events; it returns empty string for all other triggers`, confidence: 100 });
  }
  return fixes;
}

// ── CROSS-CUTTING ─────────────────────────────────────────────────────────────

/** Add ACTIONS_RUNNER_DEBUG / ACTIONS_STEP_DEBUG guidance when verbose logs are needed. */
export function fixAddDebugFlags(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/debug.*mode|verbose.*output|ACTIONS_RUNNER_DEBUG|--verbose|--debug/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (/ACTIONS_RUNNER_DEBUG|ACTIONS_STEP_DEBUG/m.test(f.content)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let added = false;
    for (const line of lines) {
      out.push(line);
      if (!added && /^on:/.test(line)) {
        out.push('# aegis: To enable debug logging, add repository secrets:');
        out.push('#   ACTIONS_RUNNER_DEBUG=true  (runner-level debug)');
        out.push('#   ACTIONS_STEP_DEBUG=true    (step-level debug)');
        added = true;
      }
    }
    if (added)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added debug flag instructions — ACTIONS_RUNNER_DEBUG and ACTIONS_STEP_DEBUG must be set as repository secrets (not env vars) to enable verbose logging', confidence: 100 });
  }
  return fixes;
}

// ── ADDITIONAL LANGUAGE / PLATFORM ENV VARS ───────────────────────────────────

/** Add DOTNET_SKIP_FIRST_TIME_EXPERIENCE and DOTNET_CLI_TELEMETRY_OPTOUT for .NET workflows. */
export function fixDotNetEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/dotnet|\.csproj|actions\/setup-dotnet|nuget|msbuild/i.test(f.content)) continue;
    if (/DOTNET_SKIP_FIRST_TIME_EXPERIENCE|DOTNET_CLI_TELEMETRY_OPTOUT/m.test(f.content)) continue;
    const entries = [
      "  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1'",
      "  DOTNET_CLI_TELEMETRY_OPTOUT: '1'",
      '  NUGET_PACKAGES: ${{ github.workspace }}/.nuget/packages',
      "  DOTNET_NOLOGO: 'true'",
    ];
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added .NET CI env vars — DOTNET_SKIP_FIRST_TIME_EXPERIENCE and DOTNET_NOLOGO eliminate welcome banners that clutter logs; DOTNET_CLI_TELEMETRY_OPTOUT prevents telemetry traffic; NUGET_PACKAGES path enables cache hits', confidence: 100 });
  }
  return fixes;
}

/** Add RAILS_ENV, BUNDLE_WITHOUT, BUNDLE_DEPLOYMENT for Ruby/Rails workflows. */
export function fixRubyEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/ruby|bundler|rails|rspec|rake|gem\s|actions\/setup-ruby/i.test(f.content)) continue;
    if (/RAILS_ENV|BUNDLE_WITHOUT|BUNDLE_DEPLOYMENT|RUBY_/m.test(f.content)) continue;
    const isRails = /rails|rake/i.test(f.content);
    const entries: string[] = [
      "  BUNDLE_DEPLOYMENT: 'true'",
      '  BUNDLE_WITHOUT: development',
      "  BUNDLE_JOBS: '4'",
      "  BUNDLE_RETRY: '3'",
    ];
    if (isRails) {
      entries.unshift('  RAILS_ENV: test');
      entries.push('  DISABLE_SPRING: 1');
    }
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Ruby/Rails CI env vars — BUNDLE_DEPLOYMENT=true enforces lockfile; BUNDLE_WITHOUT=development skips dev gems; RAILS_ENV=test activates test database config; DISABLE_SPRING prevents Spring preloader conflicts in CI', confidence: 100 });
  }
  return fixes;
}

/** Add COMPOSER_NO_INTERACTION, APP_ENV=testing for PHP/Laravel/Symfony workflows. */
export function fixPhpEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/php|composer|phpunit|laravel|symfony|artisan/i.test(f.content)) continue;
    if (/COMPOSER_NO_INTERACTION|APP_ENV|PHP_CS_FIXER/m.test(f.content)) continue;
    const isLaravel = /laravel|artisan/i.test(f.content);
    const entries: string[] = [
      "  COMPOSER_NO_INTERACTION: '1'",
      "  COMPOSER_PROCESS_TIMEOUT: '600'",
      "  COMPOSER_MEMORY_LIMIT: '-1'",
    ];
    if (isLaravel) {
      entries.push('  APP_ENV: testing');
      entries.push('  APP_KEY: base64:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=');
      entries.push("  DB_CONNECTION: sqlite");
      entries.push("  DB_DATABASE: ':memory:'");
    } else {
      entries.push('  APP_ENV: test');
    }
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PHP/Composer CI env vars — COMPOSER_NO_INTERACTION=1 prevents prompts; COMPOSER_MEMORY_LIMIT=-1 avoids memory cap; Laravel test env uses in-memory SQLite to avoid requiring a real database service', confidence: 100 });
  }
  return fixes;
}

/** Add CLOUDSDK_CORE_DISABLE_PROMPTS for Google Cloud workflows. */
export function fixGoogleCloudEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!/gcloud|gsutil|firebase|google-github-actions\/|GCP|GOOGLE_CLOUD|bigquery/i.test(f.content)) continue;
    if (/CLOUDSDK_CORE_DISABLE_PROMPTS|GOOGLE_PROJECT|GCLOUD_PROJECT/m.test(f.content)) continue;
    if (isGitHubWorkflow(f.path)) {
      const fixed = injectWorkflowLevelBlock(f.content, 'env', [
        "  CLOUDSDK_CORE_DISABLE_PROMPTS: '1'",
        "  CLOUDSDK_PYTHON_SITEPACKAGES: '1'",
      ]);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added GCP CI env vars — CLOUDSDK_CORE_DISABLE_PROMPTS=1 prevents gcloud from hanging on interactive prompts; CLOUDSDK_PYTHON_SITEPACKAGES avoids gcloud SDK Python path issues', confidence: 100 });
    } else {
      const fixed = f.content.includes('variables:')
        ? f.content.replace(/^(variables:\s*\n)/m, "$1  CLOUDSDK_CORE_DISABLE_PROMPTS: '1'\n")
        : `variables:\n  CLOUDSDK_CORE_DISABLE_PROMPTS: '1'\n\n` + f.content;
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: "Added CLOUDSDK_CORE_DISABLE_PROMPTS=1 — prevents gcloud from hanging on prompts in CI", confidence: 100 });
    }
  }
  return fixes;
}

/** Add AZURE_CORE_NO_COLOR, suppress Azure CLI output noise for Azure workflows. */
export function fixAzureEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/azure\/|az\s+login|az\s+|Azure\/webapps-deploy|AzureWebApp/i.test(f.content)) continue;
    if (/AZURE_CORE_NO_COLOR|AZURE_CORE_ONLY_SHOW_ERRORS/m.test(f.content)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      "  AZURE_CORE_NO_COLOR: 'true'",
      "  AZURE_CORE_ONLY_SHOW_ERRORS: 'true'",
      "  AZURE_CORE_OUTPUT: none",
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Azure CLI CI env vars — AZURE_CORE_NO_COLOR removes ANSI escape codes from CI logs; AZURE_CORE_ONLY_SHOW_ERRORS suppresses verbose progress output; AZURE_CORE_OUTPUT=none silences non-error az command output', confidence: 100 });
  }
  return fixes;
}

/** Add Vercel deployment env vars when Vercel actions/CLI detected but credentials missing. */
export function fixVercelDeployEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/vercel|amondnet\/vercel-action|BetaHuhn\/deploy-to-vercel-action/i.test(f.content)) continue;
    if (/VERCEL_TOKEN|VERCEL_ORG_ID|VERCEL_PROJECT_ID/m.test(f.content)) continue;
    // Add secret references as env vars
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}',
      '  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}',
      '  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Vercel deployment secrets — VERCEL_TOKEN authenticates the CLI; VERCEL_ORG_ID and VERCEL_PROJECT_ID identify the project; create these in vercel.com > Settings > Tokens and store as repository secrets', confidence: 100 });
  }
  return fixes;
}

/** Add SENTRY_AUTH_TOKEN when Sentry release tracking is detected. */
export function fixSentryEnvVars(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/sentry|getsentry\/action-release|sentry-cli|@sentry\//i.test(f.content)) continue;
    if (/SENTRY_AUTH_TOKEN|SENTRY_DSN/m.test(f.content)) continue;
    const hasSentryOrg  = /SENTRY_ORG/m.test(f.content);
    const hasSentryProj = /SENTRY_PROJECT/m.test(f.content);
    const entries = ['  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}'];
    if (!hasSentryOrg)  entries.push('  SENTRY_ORG: your-org-slug');
    if (!hasSentryProj) entries.push('  SENTRY_PROJECT: your-project-slug');
    const fixed = injectWorkflowLevelBlock(f.content, 'env', entries);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Sentry env vars — SENTRY_AUTH_TOKEN is required by sentry-cli and getsentry/action-release; create an internal integration token at sentry.io > Settings > Auth Tokens and store as SENTRY_AUTH_TOKEN secret', confidence: 100 });
  }
  return fixes;
}

// ── REUSABLE WORKFLOW / CROSS-STEP SCOPE ──────────────────────────────────────

/** Add secrets: inherit to workflow_call jobs that reference secrets. */
export function fixSecretsInheritance(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Caller workflow: uses a reusable workflow
    if (!f.content.includes('uses:') || !/uses:\s+\.?\//m.test(f.content)) continue;
    if (f.content.includes('secrets:')) continue;
    // Only add if the caller's job block uses secrets context
    if (!f.content.includes('secrets.')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      // After the `uses:` line inside a job, inject secrets: inherit
      if (!modified && /^\s{6}uses:\s+/.test(lines[i])) {
        const indent = (lines[i].match(/^(\s+)/) ?? ['', '      '])[1];
        out.push(`${indent.slice(0, -2)}secrets: inherit`);
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: "Added secrets: inherit to reusable workflow call — without this, secrets are not passed to the called workflow and ${{ secrets.* }} expressions resolve to empty string inside it", confidence: 100 });
  }
  return fixes;
}

/** Fix `export VAR=value` in a run step — exports don't persist across steps; use $GITHUB_ENV. */
export function fixExportVarCrossStep(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Find run blocks with bare `export VAR=value` not followed by >> $GITHUB_ENV
    const exportRe = /^(\s+)run:\s*\|?\n((?:\1  [^\n]+\n)*)/gm;
    let m: RegExpExecArray | null;
    let content = f.content;
    let modified = false;
    const seen = new Set<string>();
    while ((m = exportRe.exec(f.content)) !== null) {
      const block = m[2];
      const exports = [...block.matchAll(/export\s+([A-Z_][A-Z0-9_]*)=([^\n]+)/gm)];
      for (const exp of exports) {
        const varName = exp[1];
        const varVal  = exp[2].trim();
        if (seen.has(varName)) continue;
        // Only fix if var is referenced in a later step
        const laterIdx = f.content.indexOf(m[0]) + m[0].length;
        const rest = f.content.slice(laterIdx);
        if (!rest.includes(`\$${varName}`) && !rest.includes(`env.${varName}`)) continue;
        // Check if $GITHUB_ENV write already exists for this var
        if (block.includes(`${varName}=`) && block.includes('GITHUB_ENV')) continue;
        seen.add(varName);
        // Append the GITHUB_ENV write after the export line
        content = content.replace(
          new RegExp(`(export\\s+${varName}=${varVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'g'),
          `$1\n        echo "${varName}=${varVal}" >> $GITHUB_ENV`,
        );
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content, explanation: 'Added GITHUB_ENV writes after export statements — `export VAR=value` only affects the current shell process and is invisible to subsequent steps; writing to $GITHUB_ENV makes the variable available to all later steps in the job', confidence: 100 });
  }
  return fixes;
}

/** Replace ${{ env.SENSITIVE }} with ${{ secrets.SENSITIVE }} when the var name looks like a secret. */
export function fixMissingSecretsContextUsage(files: Array<{ path: string; content: string }>): RuleFix[] {
  const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE|AUTH|CERT|API_KEY|ACCESS/i;
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    // Find ${{ env.VARNAME }} where VARNAME looks like a secret
    const refs = [...f.content.matchAll(/\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g)];
    const toReplace = [...new Set(refs.map(m => m[1]))].filter(v => SECRET_NAME.test(v));
    if (toReplace.length === 0) continue;
    let content = f.content;
    for (const varName of toReplace) {
      // Only replace if it's not explicitly declared in an env: block (i.e., actually a secret)
      const isDeclared = new RegExp(`^\\s{2,6}${varName}:`, 'm').test(f.content);
      if (isDeclared) continue;
      content = content.replace(
        new RegExp(`\\$\\{\\{\\s*env\\.${varName}\\s*\\}\\}`, 'g'),
        `\${{ secrets.${varName} }}`,
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Changed env.SENSITIVE → secrets.SENSITIVE for [${toReplace.join(', ')}] — env context is readable in logs and PR comments; secrets context is redacted; sensitive values must always be accessed via secrets.*`, confidence: 100 });
  }
  return fixes;
}
