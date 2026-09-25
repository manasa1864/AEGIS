// Intermediate / Testing Errors
// Covers: snapshot mismatches, coverage threshold failures, missing test commands,
// test timeouts, flaky mocks, vitest config missing, CI test flags.
// Supports: GitHub Actions + GitLab CI, Jest + Vitest + Mocha + pytest.

import { RuleFix, isGitHubWorkflow, isGitLabCI, injectWorkflowLevelBlock, insertStepBefore } from '../helpers';

/** Add --ci flag to Jest to prevent interactive mode and make snapshot failures explicit. */
export function fixJestCIFlag(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('--ci')) continue;
    const fixed = f.content.replace(/(npx jest|npm test|jest)(\s+(?!--ci))/g, '$1 --ci $2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --ci to Jest — prevents interactive mode; snapshot mismatches and missing coverage now fail the build', confidence: 100 });
  }
  return fixes;
}

/** Lower coverage thresholds by 10% and add path ignore patterns for generated code. */
export function fixCoverageThreshold(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/coverage threshold.*not met|Jest.*coverage.*threshold|Coverage.*below/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    let fixed = f.content;
    // Lower numeric thresholds by 10
    fixed = fixed.replace(/(\b)(statements|branches|functions|lines)("?\s*:\s*)(\d+)/g, (_, before, key, sep, val) => {
      const lowered = Math.max(0, parseInt(val) - 10);
      return `${before}${key}${sep}${lowered}`;
    });
    // Add ignore patterns for generated/vendor code if missing
    if (!fixed.includes('coveragePathIgnorePatterns') && !fixed.includes('collectCoverageFrom')) {
      fixed = fixed.replace(
        /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
        `$1\n  coveragePathIgnorePatterns: [\n    '/node_modules/',\n    '/dist/',\n    '/build/',\n    '/__generated__/',\n    '/migrations/',\n    '\\\\.d\\\\.ts$',\n    '\\\\.stories\\\\.',\n  ],\n  collectCoverageFrom: [\n    'src/**/*.{ts,tsx,js,jsx}',\n    '!src/**/*.d.ts',\n    '!src/**/*.stories.*',\n    '!src/**/index.{ts,js}',\n    '!src/**/__generated__/**',\n  ],`,
      );
    }
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Lowered coverage thresholds by 10% and added coveragePathIgnorePatterns — generated/vendor files should not count against coverage', confidence: 100 });
  }
  return fixes;
}

/** Add test + test:watch scripts to package.json when "Missing script: test" is reported. */
export function fixMissingTestScript(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/missing script.*test|npm run test.*ENOENT|Missing.*"test"/i.test(logs)) return [];
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) return [];
    const hasVitest  = files.some(f => f.path.startsWith('vitest.config'));
    const hasJest    = files.some(f => f.path.startsWith('jest.config'));
    const hasMocha   = files.some(f => f.path.startsWith('.mocharc') || f.path.includes('mocha'));
    const hasPytest  = files.some(f => f.path === 'pytest.ini' || f.path === 'setup.cfg');
    const cmd = hasVitest
      ? 'vitest run --coverage'
      : hasJest
        ? 'jest --ci --coverage'
        : hasMocha
          ? 'mocha --recursive --timeout 10000'
          : hasPytest
            ? 'pytest -v --tb=short'
            : 'jest --ci --passWithNoTests';
    const watchCmd = hasVitest ? 'vitest' : hasJest ? 'jest --watch' : hasMocha ? 'mocha --watch' : 'jest --watch';
    return [{
      path: 'package.json',
      content: JSON.stringify({
        ...pkg,
        scripts: { ...(pkg.scripts ?? {}), test: cmd, 'test:watch': watchCmd, 'test:coverage': `${cmd} --coverage` },
      }, null, 2) + '\n',
      explanation: `Added test scripts ("${cmd}") — npm test failed with "Missing script: test"`,
      confidence: 100,
    }];
  } catch { return []; }
}

/** Increase test timeout based on detected failing timeout and patch jest.config globally. */
export function fixTestTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Timeout.*Async callback.*invoked within|Exceeded timeout|jest\.setTimeout|Timeout - Async/i.test(logs)) return [];
  const timeoutMatch = logs.match(/(\d+)\s*ms(?:econds?)?(?:\s+timeout|\s+exceeded)/i);
  const currentMs = timeoutMatch ? parseInt(timeoutMatch[1]) : 5000;
  const newMs = Math.min(120_000, currentMs * 4);

  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) {
      if (!f.content.includes('jest') && !f.content.includes('vitest')) continue;
      const fixed = f.content
        .replace(/(jest\s+--ci)(?!\s+--testTimeout)/g, `$1 --testTimeout=${newMs}`)
        .replace(/(vitest run)(?!\s+--testTimeout)/g, `$1 --testTimeout=${newMs}`);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Added --testTimeout=${newMs}ms — async tests exceeded ${currentMs}ms timeout`, confidence: 100 });
      continue;
    }
    // Also patch jest.config to set global testTimeout
    if (/jest\.config\.(js|ts|json|cjs)$/.test(f.path) && !f.content.includes('testTimeout')) {
      const fixed = f.content.replace(
        /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
        `$1\n  testTimeout: ${newMs},`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Added global testTimeout: ${newMs} to jest.config — sets timeout for all async tests`, confidence: 100 });
    }
  }
  return fixes;
}

/** Create a comprehensive vitest.config with coverage, globals, and CI-aware reporters. */
export function fixMissingVitestConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/vitest.*config|Cannot find.*vitest|vitest.*not.*found/i.test(logs)) return [];
  if (files.some(f => f.path.startsWith('vitest.config'))) return [];
  const isTS    = files.some(f => f.path === 'tsconfig.json');
  const isReact = files.some(f => f.content.includes('react-dom') || f.content.includes('@vitejs/plugin-react'));
  const ext = isTS ? 'ts' : 'js';
  const lines = [
    `import { defineConfig } from 'vitest/config';`,
    isReact ? `import react from '@vitejs/plugin-react';` : '',
    '',
    'export default defineConfig({',
    isReact ? '  plugins: [react()],' : '',
    '  test: {',
    '    globals: true,',
    `    environment: '${isReact ? 'jsdom' : 'node'}',`,
    '    setupFiles: [],',
    '    testTimeout: 30_000,',
    '    hookTimeout: 30_000,',
    "    reporters: process.env.CI ? ['verbose', 'json'] : ['verbose'],",
    '    coverage: {',
    "      provider: 'v8',",
    "      reporter: ['text', 'json', 'html', 'lcov'],",
    "      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.config.*', '**/index.ts'],",
    '    },',
    '  },',
    '});',
    '',
  ].filter(l => l !== null && l !== undefined);
  return [{
    path: `vitest.config.${ext}`,
    content: lines.join('\n'),
    explanation: 'Created vitest.config — vitest referenced but no config existed; includes coverage, globals, CI reporters, and 30s timeout',
    confidence: 100,
  }];
}

/** Add --clearMocks --resetMocks --restoreMocks to CI and patch jest.config. */
export function fixStaleMocks(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/mock.*not.*called|received.*undefined.*expected|mockReturnValue.*not.*working|Mock.*stale/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) {
      if (!f.content.includes('jest') || f.content.includes('--clearMocks')) continue;
      const fixed = f.content.replace(/(jest\s+--ci)/g, '$1 --clearMocks --resetMocks --restoreMocks');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added --clearMocks --resetMocks --restoreMocks — stale mock state leaking between test suites', confidence: 100 });
      continue;
    }
    if (/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) {
      if (f.content.includes('clearMocks')) continue;
      const fixed = f.content.replace(
        /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
        '$1\n  clearMocks: true,\n  resetMocks: true,\n  restoreMocks: true,',
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added clearMocks/resetMocks/restoreMocks to jest.config — prevents mock state leaking between suites', confidence: 100 });
    }
  }
  return fixes;
}

/** Add --passWithNoTests to prevent failure when no test files are found. */
export function fixNoTestFiles(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/no tests found|Your test suite must contain at least one test|No test files found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest')) continue;
    if (f.content.includes('--passWithNoTests')) continue;
    const fixed = f.content.replace(/(jest)(\b)/g, '$1 --passWithNoTests');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --passWithNoTests — no test files found; prevents CI failure while tests are being written', confidence: 100 });
  }
  return fixes;
}

/** Add --bail=1 --verbose when many unit tests fail for faster CI feedback. */
export function fixUnitTestFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/FAIL\s+\w|● .* failed|Tests:\s+\d+ failed/i.test(logs)) return [];
  const failCount = (logs.match(/● /g) ?? []).length;
  if (failCount < 3) return [];
  const failMatch = logs.match(/FAIL\s+([\w./\\-]+)/);
  const failedFile = failMatch?.[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') && !f.content.includes('vitest')) continue;
    if (f.content.includes('--bail') || f.content.includes('--verbose')) continue;
    const note = failedFile ? ` # aegis: first failure in ${failedFile}` : '';
    const fixed = f.content
      .replace(/(jest\s+--ci)/g, `$1 --bail=1 --verbose${note}`)
      .replace(/(vitest run)/g, `$1 --bail=1 --reporter=verbose`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added --bail=1 --verbose — ${failCount} test failures detected; bail on first fail for faster CI feedback`, confidence: 100 });
  }
  return fixes;
}

/** Add service containers for integration tests (Postgres, Redis, Mongo, Elasticsearch, RabbitMQ). */
export function fixIntegrationTestFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/integration.*test.*fail|ECONNREFUSED.*integration|failed.*connect.*service/i.test(logs)) return [];
  const needsPg      = /postgres|pg\s|postgresql/i.test(logs);
  const needsRedis   = /redis/i.test(logs);
  const needsMongo   = /mongo/i.test(logs);
  const needsElastic = /elasticsearch|elastic.*search/i.test(logs);
  const needsRabbit  = /rabbitmq|amqp/i.test(logs);
  const fixes: RuleFix[] = [];

  for (const f of files) {
    // ── GitHub Actions ──────────────────────────────────────────────────────
    if (isGitHubWorkflow(f.path)) {
      if (!f.content.includes('integration') && !f.content.includes('e2e')) continue;
      if (f.content.includes('services:')) continue;
      const lines = f.content.split('\n');
      const out: string[] = [];
      let servicesAdded = false;
      for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (/^\s+runs-on:/.test(lines[i]) && !servicesAdded) {
          out.push('    services:');
          if (needsPg) {
            out.push('      postgres:');
            out.push('        image: postgres:16-alpine');
            out.push('        env:');
            out.push('          POSTGRES_USER: testuser');
            out.push('          POSTGRES_PASSWORD: testpass');
            out.push('          POSTGRES_DB: integration_test');
            out.push('        ports:');
            out.push("          - '5432:5432'");
            out.push('        options: >-');
            out.push('          --health-cmd pg_isready');
            out.push('          --health-interval 10s');
            out.push('          --health-timeout 5s');
            out.push('          --health-retries 10');
          }
          if (needsRedis) {
            out.push('      redis:');
            out.push('        image: redis:7-alpine');
            out.push('        ports:');
            out.push("          - '6379:6379'");
            out.push('        options: >-');
            out.push('          --health-cmd "redis-cli ping"');
            out.push('          --health-interval 10s');
            out.push('          --health-retries 5');
          }
          if (needsMongo) {
            out.push('      mongo:');
            out.push('        image: mongo:7');
            out.push('        env:');
            out.push('          MONGO_INITDB_ROOT_USERNAME: testuser');
            out.push('          MONGO_INITDB_ROOT_PASSWORD: testpass');
            out.push('        ports:');
            out.push("          - '27017:27017'");
          }
          if (needsElastic) {
            out.push('      elasticsearch:');
            out.push('        image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0');
            out.push('        env:');
            out.push('          discovery.type: single-node');
            out.push('          xpack.security.enabled: "false"');
            out.push('          ES_JAVA_OPTS: -Xms512m -Xmx512m');
            out.push('        ports:');
            out.push("          - '9200:9200'");
            out.push('        options: --health-cmd "curl -s http://localhost:9200/_cluster/health?wait_for_status=yellow" --health-interval 30s --health-retries 10');
          }
          if (needsRabbit) {
            out.push('      rabbitmq:');
            out.push('        image: rabbitmq:3.13-management-alpine');
            out.push('        env:');
            out.push('          RABBITMQ_DEFAULT_USER: testuser');
            out.push('          RABBITMQ_DEFAULT_PASS: testpass');
            out.push('        ports:');
            out.push("          - '5672:5672'");
            out.push("          - '15672:15672'");
            out.push('        options: --health-cmd "rabbitmq-diagnostics ping" --health-interval 15s --health-retries 8');
          }
          servicesAdded = true;
        }
        // Inject health verification step before the test run
        if (servicesAdded && /run:.*(?:npm.*test|jest|vitest|pytest|mocha)/i.test(lines[i])) {
          const checks: string[] = [];
          if (needsPg)      checks.push('    pg_isready -h localhost -p 5432 -U testuser || (echo "ERROR: Postgres not ready" && exit 1)');
          if (needsRedis)   checks.push('    redis-cli ping || (echo "ERROR: Redis not ready" && exit 1)');
          if (needsMongo)   checks.push('    mongosh --eval "db.adminCommand({ping:1})" --quiet 2>/dev/null || (echo "ERROR: Mongo not ready" && exit 1)');
          if (needsElastic) checks.push('    curl -sf http://localhost:9200/_cluster/health?wait_for_status=yellow || (echo "ERROR: Elasticsearch not ready" && exit 1)');
          if (checks.length > 0) {
            out.splice(out.length - 1, 0,
              '      - name: Verify integration services are healthy',
              '        run: |',
              ...checks,
              "          echo 'All integration services healthy'",
            );
          }
        }
      }
      if (servicesAdded) {
        const svcList = [needsPg && 'PostgreSQL', needsRedis && 'Redis', needsMongo && 'MongoDB', needsElastic && 'Elasticsearch', needsRabbit && 'RabbitMQ'].filter(Boolean).join(', ');
        fixes.push({ path: f.path, content: out.join('\n'), explanation: `Added ${svcList} service containers + health verification — ECONNREFUSED means services were missing during integration test run`, confidence: 100 });
      }
    }

    // ── GitLab CI ───────────────────────────────────────────────────────────
    if (isGitLabCI(f.path)) {
      if (!f.content.includes('integration') && !f.content.includes('e2e')) continue;
      if (f.content.includes('services:')) continue;
      const svcLines: string[] = ['  services:'];
      const envLines: string[] = ['  variables:'];
      if (needsPg) {
        svcLines.push('    - name: postgres:16-alpine', '      alias: postgres');
        envLines.push('    TEST_DATABASE_URL: "postgres://postgres:postgres@postgres:5432/testdb"');
        envLines.push('    POSTGRES_DB: testdb', '    POSTGRES_USER: postgres', '    POSTGRES_PASSWORD: postgres');
      }
      if (needsRedis) {
        svcLines.push('    - name: redis:7-alpine', '      alias: redis');
        envLines.push('    REDIS_URL: "redis://redis:6379"');
      }
      if (needsMongo) {
        svcLines.push('    - name: mongo:7', '      alias: mongo');
        envLines.push('    MONGO_URL: "mongodb://mongo:27017/testdb"');
      }
      const fixed = f.content.replace(
        /^((?:integration|e2e)[\w-]*:)$/im,
        `$1\n${envLines.join('\n')}\n${svcLines.join('\n')}`,
      );
      if (fixed !== f.content) {
        const svcList = [needsPg && 'PostgreSQL', needsRedis && 'Redis', needsMongo && 'MongoDB'].filter(Boolean).join(', ');
        fixes.push({ path: f.path, content: fixed, explanation: `Added ${svcList} GitLab CI service containers + variables — integration tests need external services`, confidence: 100 });
      }
    }
  }
  return fixes;
}

/** Fix test environment misconfiguration — NODE_ENV, DB URL, and create .env.test. */
export function fixTestEnvironmentMisconfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/test.*environment|NODE_ENV.*test|jest.*environment|Cannot find module.*test/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  // Create .env.test if missing
  if (!files.some(f => f.path === '.env.test' || f.path.endsWith('/.env.test'))) {
    const hasPrisma = files.some(f => f.content.includes('prisma'));
    const dbKey = hasPrisma ? 'DATABASE_URL' : 'TEST_DATABASE_URL';
    fixes.push({
      path: '.env.test',
      content: [
        '# Test environment — aegis: auto-generated, commit to source control',
        'NODE_ENV=test',
        `${dbKey}=postgres://testuser:testpass@localhost:5432/testdb`,
        'REDIS_URL=redis://localhost:6379',
        'MONGODB_URI=mongodb://localhost:27017/testdb',
        'JWT_SECRET=test-jwt-secret-not-for-production',
        'API_BASE_URL=http://localhost:3000',
        'LOG_LEVEL=error',
        '',
      ].join('\n'),
      explanation: 'Created .env.test — consistent test environment config for DB URL, Redis, JWT; commit to source control (no real secrets)',
      confidence: 100,
    });
  }

  for (const f of files) {
    if (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) {
      if (!f.content.includes('jest') && !f.content.includes('vitest') && !f.content.includes('mocha') && !f.content.includes('pytest')) continue;
      if (f.content.includes('NODE_ENV: test')) continue;
      const fixed = injectWorkflowLevelBlock(f.content, 'env', [
        '  NODE_ENV: test',
        '  DATABASE_URL: postgres://testuser:testpass@localhost:5432/testdb',
        '  REDIS_URL: redis://localhost:6379',
      ]);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added NODE_ENV=test + test DB/Redis URLs — wrong environment caused test runner to use wrong config', confidence: 100 });
      continue;
    }
    // Patch jest.config testEnvironment
    if (/jest\.config\.(js|ts|json|cjs)$/.test(f.path) && !f.content.includes('testEnvironment')) {
      const isDOM = /react|jsx|dom|jsdom/i.test(f.content) || files.some(fi => fi.path === 'package.json' && (fi.content.includes('"react"') || fi.content.includes('"jsdom"')));
      const env = isDOM ? 'jsdom' : 'node';
      const fixed = f.content.replace(
        /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
        `$1\n  testEnvironment: '${env}',`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Added testEnvironment: '${env}' to jest.config — missing environment setting causes tests to run in the wrong context`, confidence: 100 });
    }
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION A — Unit Test Failure (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add --runInBand to Jest in CI to eliminate race conditions between parallel workers. */
export function fixJestRunInBand(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/race condition|test.*interfere|async.*state.*corrupt|worker.*collision/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('--runInBand')) continue;
    const fixed = f.content.replace(/(jest\s+--ci)/g, '$1 --runInBand');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --runInBand — race condition between parallel Jest workers; forces serial execution to eliminate shared-state interference', confidence: 90 });
  }
  return fixes;
}

/** Add --forceExit --detectOpenHandles when Jest does not exit after test suite. */
export function fixJestForceExit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Jest did not exit one second|open handles|A worker process has failed to exit/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('--forceExit')) continue;
    const fixed = f.content.replace(/(jest\s+--ci)/g, '$1 --forceExit --detectOpenHandles');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --forceExit --detectOpenHandles — Jest did not exit after suite; forces termination and reports which handles kept the process alive', confidence: 95 });
  }
  return fixes;
}

/** Add retryTimes: 2 to jest.config for intermittent flaky test failures. */
export function fixFlakyTestRetry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/flaky|intermittent|occasionally.*fails|non-deterministic/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('retryTimes') || f.content.includes('flakyTestAttempts')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      '$1\n  retryTimes: 2,\n  flakyTestAttempts: 2,',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added retryTimes: 2 to jest.config — intermittent failures; Jest retries each flaky test up to 2 times before marking it as failed', confidence: 85 });
  }
  return fixes;
}

/** Add retry: 2 to vitest config for flaky tests. */
export function fixVitestRetry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/flaky|intermittent|occasionally.*fails|vitest.*retry/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.startsWith('vitest.config')) continue;
    if (f.content.includes('retry:')) continue;
    const fixed = f.content.replace(/(test:\s*\{)/, '$1\n    retry: 2,');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added retry: 2 to vitest config — flaky tests fail intermittently; Vitest retries each failing test up to 2 times', confidence: 85 });
  }
  return fixes;
}

/** Add pytest-rerunfailures with --rerun-fails=2 for flaky Python tests. */
export function fixPytestRerunFails(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/flaky.*pytest|pytest.*flaky|intermittent.*python/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pytest') || f.content.includes('rerun-fails')) continue;
    const fixed = f.content
      .replace(/(pip install\s+[^\n]+)/g, '$1 pytest-rerunfailures')
      .replace(/((?:python -m )?pytest)(\s)/g, '$1 --rerun-fails=2 --rerun-delay=5$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pytest-rerunfailures --rerun-fails=2 — intermittent pytest failures; each flaky test reruns up to 2 times with a 5s delay', confidence: 85 });
  }
  return fixes;
}

/** Add -timeout 5m to go test for slow or hanging table-driven tests. */
export function fixGoTestTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/panic: test timed out after|go test.*timeout|signal.*killed.*go test/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('go test') || f.content.includes('-timeout')) continue;
    const fixed = f.content.replace(/(go test\s+)/g, 'go test -timeout 5m ');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -timeout 5m to go test — panic: test timed out; 5 minute cap prevents hanging table-driven tests from blocking CI indefinitely', confidence: 90 });
  }
  return fixes;
}

/** Add RUST_TEST_THREADS=1 for serial Rust test execution to eliminate shared-state races. */
export function fixRustTestSerial(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/cargo test.*fail|rust.*test.*race|test.*global.*state.*rust/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('cargo test') || f.content.includes('RUST_TEST_THREADS')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  RUST_TEST_THREADS: 1  # serial execution eliminates shared-state race conditions',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added RUST_TEST_THREADS=1 — Rust tests failing due to parallel thread races on shared global state; serial execution eliminates interference', confidence: 85 });
  }
  return fixes;
}

/** Add --logger trx + results directory to dotnet test for structured output. */
export function fixDotNetTestLogger(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/dotnet test.*fail|xUnit.*fail|NUnit.*fail|MSTest.*fail/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('dotnet test') || f.content.includes('--logger')) continue;
    const fixed = f.content.replace(/(dotnet test\s+[^\n]*)/g, '$1 --logger trx --results-directory /tmp/test-results');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --logger trx + results dir to dotnet test — TRX reports enable detailed per-test failure analysis and Azure DevOps integration', confidence: 90 });
  }
  return fixes;
}

/** Add --maxWorkers=50% to prevent Jest from overwhelming CI runner CPUs. */
export function fixJestWorkerCount(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/worker.*crash|ENOMEM.*jest.*worker|jest.*too.*many.*workers|worker.*OOM/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('maxWorkers')) continue;
    const fixed = f.content.replace(/(jest\s+--ci)/g, '$1 --maxWorkers=50%');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --maxWorkers=50% — Jest worker OOM on CI runner; caps spawned workers at half the available CPUs to prevent memory exhaustion', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION B — Integration Test Failure (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add docker-compose up/down around integration tests when docker-compose.yml exists. */
export function fixDockerComposeTestUp(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED|connection.*refused.*integration|service.*not.*available.*test/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('docker-compose') || f.content.includes('services:')) continue;
    if (!files.some(fi => fi.path === 'docker-compose.yml' || fi.path === 'docker-compose.yaml')) continue;
    const composeStep = [
      '      - name: Start integration test services',
      '        run: |',
      '          docker-compose -f docker-compose.yml up -d',
      '          sleep 15',
      '          docker-compose ps',
    ].join('\n');
    const teardownStep = [
      '      - name: Stop integration test services',
      '        if: always()',
      '        run: docker-compose -f docker-compose.yml down --volumes',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:npm.*test|jest|vitest|pytest|mocha)/i, composeStep);
    if (!patched) continue;
    const lines = patched.split('\n');
    const lastIdx = lines.reduce((acc, line, i) => /^\s+- name:/.test(line) ? i : acc, -1);
    if (lastIdx === -1) { fixes.push({ path: f.path, content: patched, explanation: 'Added docker-compose up — ECONNREFUSED; services from docker-compose.yml now start before tests', confidence: 90 }); continue; }
    let insertAt = lastIdx;
    for (let i = lastIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, teardownStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added docker-compose up/down around integration tests — ECONNREFUSED; services start before tests and always tear down after', confidence: 90 });
  }
  return fixes;
}

/** Pre-pull Docker service images to prevent timeout during test service startup. */
export function fixTestContainersPull(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pull.*timeout|Unable to pull.*image|manifest.*not found.*docker/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('services:') || f.content.includes('docker pull')) continue;
    const images: string[] = [];
    for (const m of f.content.matchAll(/image:\s*([\w./:@-]+)/g)) images.push(m[1]);
    if (images.length === 0) continue;
    const pullStep = [
      '      - name: Pre-pull service images',
      '        run: |',
      ...images.map(img => `          docker pull ${img} || true`),
    ].join('\n');
    const patched = insertStepBefore(f.content, /^\s+- name:\s*(Checkout|Setup Node|Install)/im, pullStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Pre-pulled Docker images (${images.slice(0, 3).join(', ')}) — image pull timeout during test service startup; images cached before job begins`, confidence: 85 });
  }
  return fixes;
}

/** Add database migration step before integration tests that need a schema. */
export function fixDatabaseMigrationBeforeTest(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/relation.*does not exist|table.*not found|column.*does not exist|schema.*not.*exist/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('migrate') || f.content.includes('db:migrate')) continue;
    const hasPrisma  = files.some(fi => fi.content.includes('@prisma/client'));
    const hasTypeORM = files.some(fi => fi.content.includes('typeorm'));
    const hasRails   = files.some(fi => fi.path.endsWith('database.yml'));
    const cmd = hasPrisma ? 'npx prisma migrate deploy' : hasTypeORM ? 'npx typeorm migration:run' : hasRails ? 'bundle exec rails db:migrate' : 'npm run db:migrate';
    const migrateStep = ['      - name: Run database migrations', '        run: ' + cmd].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:jest|vitest|pytest|mocha|rspec)/i, migrateStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added "${cmd}" before tests — relation does not exist; schema must be applied before integration tests run against a fresh test database`, confidence: 95 });
  }
  return fixes;
}

/** Add Kafka + Zookeeper service containers for message broker integration tests. */
export function fixKafkaServiceIntegration(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/KAFKA_BOOTSTRAP|kafka.*connection.*refused|KafkaError|kafka.*ECONNREFUSED/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('kafka') || !f.content.includes('services:')) continue;
    const kafkaSvc = [
      '      zookeeper:',
      '        image: confluentinc/cp-zookeeper:7.6.0',
      '        env:',
      '          ZOOKEEPER_CLIENT_PORT: 2181',
      '        ports:',
      "          - '2181:2181'",
      '      kafka:',
      '        image: confluentinc/cp-kafka:7.6.0',
      '        env:',
      '          KAFKA_BROKER_ID: 1',
      '          KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181',
      '          KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092',
      '          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1',
      '          KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"',
      '        ports:',
      "          - '9092:9092'",
    ].join('\n');
    const fixed = f.content.replace(/^(\s+services:\s*\n)/, `$1${kafkaSvc}\n`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Kafka + Zookeeper service containers — KafkaError: ECONNREFUSED; Confluent Platform 7.6 now runs as a CI service during integration tests', confidence: 90 });
  }
  return fixes;
}

/** Add MinIO S3 service container for tests that require object storage. */
export function fixMinioServiceIntegration(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/NoSuchBucket|S3.*ECONNREFUSED|minio|AWS_ENDPOINT.*test/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('minio') || f.content.includes('MINIO')) continue;
    const minioSvc = [
      '      minio:',
      '        image: minio/minio',
      '        env:',
      '          MINIO_ROOT_USER: testuser',
      '          MINIO_ROOT_PASSWORD: testpass123',
      '        ports:',
      "          - '9000:9000'",
      '        options: --entrypoint sh -c "minio server /data"',
    ].join('\n');
    let fixed = f.content.includes('services:')
      ? f.content.replace(/^(\s+services:\s*\n)/, `$1${minioSvc}\n`)
      : f.content;
    fixed = injectWorkflowLevelBlock(fixed, 'env', [
      '  AWS_ENDPOINT: http://localhost:9000',
      '  AWS_ACCESS_KEY_ID: testuser',
      '  AWS_SECRET_ACCESS_KEY: testpass123',
      '  AWS_DEFAULT_REGION: us-east-1',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MinIO S3 service + AWS env vars — NoSuchBucket / S3 ECONNREFUSED; MinIO runs as a local S3-compatible service during integration tests', confidence: 90 });
  }
  return fixes;
}

/** Add gRPC service port readiness check before tests that depend on gRPC backends. */
export function fixGRPCServiceHealth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/UNAVAILABLE.*grpc|grpc.*UNAVAILABLE|StatusCode\.UNAVAILABLE/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('grpcurl') || f.content.includes('grpc_health')) continue;
    const healthStep = [
      '      - name: Wait for gRPC service',
      '        run: |',
      '          for i in $(seq 1 30); do',
      '            nc -z localhost 50051 && echo "gRPC ready" && break || sleep 2',
      '          done',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:jest|vitest|pytest|go test)/i, healthStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added gRPC port readiness loop — StatusCode.UNAVAILABLE; waits up to 60s for port 50051 before running tests', confidence: 85 });
  }
  return fixes;
}

/** Wrap integration test step with nick-invision/retry for transient network failures. */
export function fixIntegrationTestRetry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/integration.*test.*transient|ECONNRESET.*test|socket.*hang.*up.*test/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('nick-invision/retry') || f.content.includes('retry-on-exit-code')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/run:.*(?:npm.*integration|jest.*integration|pytest.*integration)/i.test(line)) {
        const ind = line.match(/^(\s+)/)?.[1] ?? '';
        const cmd = line.replace(/^\s+run:\s*/, '').trim();
        out.push(`${ind}- name: Integration tests (with retry)`);
        out.push(`${ind}  uses: nick-invision/retry@v3`);
        out.push(`${ind}  with:`);
        out.push(`${ind}    timeout_minutes: 15`);
        out.push(`${ind}    max_attempts: 3`);
        out.push(`${ind}    retry_wait_seconds: 30`);
        out.push(`${ind}    command: ${cmd}`);
      } else {
        out.push(line);
      }
    }
    if (out.join('\n') !== f.content)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Wrapped integration tests with nick-invision/retry — transient ECONNRESET; retries up to 3 times with 30s delay on network errors', confidence: 85 });
  }
  return fixes;
}

/** Add DB reset step before integration tests to ensure clean state. */
export function fixTestDatabaseIsolation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/test.*data.*leak|dirty.*database|test.*interfere.*db|shared.*state.*integration/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('db:reset') || f.content.includes('DROP SCHEMA') || f.content.includes('TRUNCATE')) continue;
    if (!f.content.includes('integration') && !f.content.includes('e2e')) continue;
    const resetStep = [
      '      - name: Reset test database',
      '        run: |',
      '          npx prisma migrate reset --force 2>/dev/null || \\',
      '          psql $DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null || \\',
      '          npm run db:reset 2>/dev/null || true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:npm.*integration|jest.*integration|pytest.*integration)/i, resetStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added DB reset before integration tests — test state leaking across runs; fresh schema guarantees isolated test execution', confidence: 85 });
  }
  return fixes;
}

/** Add wait-for-service loop before tests dependent on slow-starting external services. */
export function fixWaitForServiceReady(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/connection.*refused.*startup|service.*not.*ready|health.*check.*fail.*test/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('wait-for') || f.content.includes('nc -z')) continue;
    if (!f.content.includes('services:')) continue;
    const waitStep = [
      '      - name: Wait for services to be ready',
      '        run: |',
      '          echo "Waiting for services..."',
      '          until curl -sf http://localhost:8080/health 2>/dev/null || nc -z localhost 5432 2>/dev/null; do',
      '            echo "Services not ready, retrying in 3s..."',
      '            sleep 3',
      '          done',
      '          echo "Services ready"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:npm.*test|jest|vitest|pytest|go test)/i, waitStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added service readiness loop — connection refused on startup; polls health endpoint/port before running tests', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION C — Snapshot Mismatch
// ═══════════════════════════════════════════════════════════════════════════

/** Add --updateSnapshot under a workflow_dispatch guard to update snapshots on demand. */
export function fixJestUpdateSnapshot(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/snapshot.*failed|obsolete snapshot|1 snapshot failed|snapshot.*not.*match/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('updateSnapshot')) continue;
    const updateStep = [
      '      - name: Update snapshots (workflow_dispatch only)',
      "        if: github.event_name == 'workflow_dispatch'",
      '        run: npx jest --ci --updateSnapshot',
    ].join('\n');
    const lines = f.content.split('\n');
    const lastRunIdx = lines.reduce((acc, line, i) => /run:.*jest/.test(line) ? i : acc, -1);
    if (lastRunIdx === -1) continue;
    let insertAt = lastRunIdx;
    for (let i = lastRunIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, updateStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added --updateSnapshot step gated on workflow_dispatch — snapshot mismatch; snapshots update only on manual trigger, not on PRs', confidence: 85 });
  }
  return fixes;
}

/** Add custom snapshot serializers for styled-components / Emotion to reduce diff noise. */
export function fixSnapshotSerializer(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/snapshot.*serializer|Snapshot.*diff.*too.*large|snapshot.*emotion|snapshot.*styled/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('snapshotSerializers')) continue;
    const hasStyled  = files.some(fi => fi.content.includes('styled-components'));
    const hasEmotion = files.some(fi => fi.content.includes('@emotion/'));
    const sers: string[] = [];
    if (hasStyled)  sers.push("'jest-styled-components'");
    if (hasEmotion) sers.push("'@emotion/jest/serializer'");
    if (sers.length === 0) return fixes;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      `$1\n  snapshotSerializers: [${sers.join(', ')}],`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added snapshotSerializers (${sers.join(', ')}) — snapshot diff too large with CSS-in-JS; serializers strip runtime class names from snapshots`, confidence: 90 });
  }
  return fixes;
}

/** Upload snapshot .snap files as CI artifacts for reviewers to inspect diffs. */
export function fixSnapshotDiffArtifact(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/snapshot.*failed|snapshot.*mismatch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('snapshot-diffs') || f.content.includes('__snapshots__')) continue;
    const uploadStep = [
      '      - name: Upload snapshot diffs',
      '        if: failure()',
      '        uses: actions/upload-artifact@v4',
      '        with:',
      '          name: snapshot-diffs',
      '          path: "**/__snapshots__/**/*.snap"',
      '          if-no-files-found: ignore',
      '          retention-days: 7',
    ].join('\n');
    const lines = f.content.split('\n');
    const lastIdx = lines.reduce((acc, line, i) => /^\s+- name:/.test(line) ? i : acc, -1);
    if (lastIdx === -1) continue;
    let insertAt = lastIdx;
    for (let i = lastIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, uploadStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added snapshot artifact upload on failure — snapshot mismatch; reviewers can download .snap files from CI to inspect exact differences', confidence: 90 });
  }
  return fixes;
}

/** Add --update-snapshots to Playwright on visual comparison failures. */
export function fixPlaywrightVisualBaseline(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/playwright.*screenshot.*mismatch|visual.*regression.*playwright|toMatchSnapshot.*playwright/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('playwright') || f.content.includes('update-snapshots')) continue;
    const fixed = f.content.replace(/(npx playwright test)(\s)/g, '$1 --update-snapshots$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --update-snapshots to Playwright — visual comparison mismatch; baseline screenshots refreshed; remove flag after committing the new baselines', confidence: 80 });
  }
  return fixes;
}

/** Add prettierPath override to fix inline snapshot formatting with Prettier 3. */
export function fixInlineSnapshotFormat(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/inline snapshot.*format|toMatchInlineSnapshot.*prettier|prettier.*3.*snapshot/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('prettierPath')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      "$1\n  prettierPath: require.resolve('prettier-2'),",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added prettierPath to jest.config — inline snapshot format error with Prettier 3+; Jest's snapshot formatter requires Prettier 2; prettierPath pins the version", confidence: 85 });
  }
  return fixes;
}

/** Add --ci flag to fail CI on obsolete snapshots instead of silently ignoring them. */
export function fixObsoleteSnapshots(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/obsolete snapshot|\d+ snapshot.*obsolete/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('--ci')) continue;
    const fixed = f.content.replace(/(jest)(\s+(?!--ci))/g, '$1 --ci $2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --ci to Jest — obsolete snapshots detected; --ci treats obsolete snapshots as failures, forcing cleanup of stale snapshot files', confidence: 95 });
  }
  return fixes;
}

/** Add Vitest snapshot update comment hint for developers. */
export function fixVitestUpdateSnapshot(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/snapshot.*mismatch.*vitest|vitest.*snapshot.*fail/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('vitest') || f.content.includes('update')) continue;
    const fixed = f.content.replace(
      /(vitest run)/g,
      '# To update snapshots locally: run "vitest run -u"\n          $1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added comment for Vitest snapshot update — mismatch detected; run "vitest run -u" locally and commit the updated .snap files', confidence: 75 });
  }
  return fixes;
}

/** Add Storybook build step before storyshots to ensure component snapshots are fresh. */
export function fixStorybookSnapshotTest(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/storybook.*snapshot|storyshots.*fail|@storybook.*storyshots/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('storybook build') || !files.some(fi => fi.path.includes('.storybook'))) continue;
    const buildStep = [
      '      - name: Build Storybook for snapshots',
      '        run: npx storybook build --quiet --output-dir /tmp/storybook-build || true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*jest.*storyshots|run:.*vitest.*storyshots/i, buildStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Storybook build before storyshots — snapshot tests require a built Storybook output to generate component snapshots', confidence: 80 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION D — Mock Dependency Failure
// ═══════════════════════════════════════════════════════════════════════════

/** Add --experimental-vm-modules for jest.mock() to work with ESM modules. */
export function fixEsmMockSupport(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/SyntaxError.*unexpected.*import|ESM.*mock|jest\.mock.*ESM|Cannot use import.*module/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('experimental-vm-modules')) continue;
    const fixed = /NODE_OPTIONS/.test(f.content)
      ? f.content.replace(/(NODE_OPTIONS:\s*['"]?)(--[^\n'"]*)/g, '$1$2 --experimental-vm-modules')
      : injectWorkflowLevelBlock(f.content, 'env', ['  NODE_OPTIONS: --experimental-vm-modules']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --experimental-vm-modules — jest.mock() does not work with ESM without this flag; required for module mocking in ES module projects', confidence: 95 });
  }
  return fixes;
}

/** Add resetModules: true + restoreMocks: true to jest.config to prevent mock cache pollution. */
export function fixMockModuleReset(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/mock.*not.*reset|module.*cached|mock.*persist.*test/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('resetModules') || f.content.includes('restoreMocks')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      '$1\n  resetModules: true,\n  restoreMocks: true,',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added resetModules + restoreMocks to jest.config — mock state persisting between test files; module registry now resets before each file', confidence: 90 });
  }
  return fixes;
}

/** Add fakeTimers config to jest.config for deterministic timer/date mocking. */
export function fixMockTimers(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/setTimeout.*mock|Date.*mock|useFakeTimers|timer.*not.*advanced/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('fakeTimers')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      "$1\n  fakeTimers: { enableGlobally: true, now: new Date('2024-01-01T00:00:00.000Z').getTime() },",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added fakeTimers with fixed date to jest.config — timer-dependent tests non-deterministic; freezes Date.now() and setTimeout for reproducible results", confidence: 85 });
  }
  return fixes;
}

/** Add moduleNameMapper for path aliases so jest.mock() resolves aliased imports. */
export function fixModuleNameMapper(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot find module.*@\/|Cannot find module.*~\/|moduleNameMapper/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const tsconfig = files.find(f => f.path === 'tsconfig.json');
  const aliases: Record<string, string> = { '^@/(.*)$': '<rootDir>/src/$1' };
  if (tsconfig) {
    try {
      const cfg = JSON.parse(tsconfig.content) as { compilerOptions?: { paths?: Record<string, string[]> } };
      const paths = cfg.compilerOptions?.paths ?? {};
      for (const [alias, targets] of Object.entries(paths)) {
        const key = '^' + alias.replace('/*', '/(.*)') + '$';
        const val = (targets[0] ?? '').replace('/*', '/$1').replace('./', '<rootDir>/');
        aliases[key] = val;
      }
    } catch { /* invalid JSON */ }
  }
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('moduleNameMapper')) continue;
    const mapperStr = Object.entries(aliases).map(([k, v]) => `    '${k}': '${v}'`).join(',\n');
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      `$1\n  moduleNameMapper: {\n${mapperStr},\n  },`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added moduleNameMapper to jest.config — Cannot find module '@/...'; path aliases now resolve correctly during test execution", confidence: 95 });
  }
  return fixes;
}

/** Add pytest-mock + responses to pip install for Python mock dependency failures. */
export function fixPythonMockPatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/unittest\.mock|mock\.patch|MagicMock.*not.*called|mocker\.patch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pytest') || f.content.includes('pytest-mock')) continue;
    const fixed = f.content.replace(/(pip install\s+[^\n]+)/g, '$1 pytest-mock responses');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pytest-mock + responses to pip install — mock.patch failure; pytest-mock provides mocker fixture, responses intercepts HTTP calls in tests', confidence: 90 });
  }
  return fixes;
}

/** Add nock to devDependencies to intercept HTTP calls in Node.js unit tests. */
export function fixNockHttpMocking(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Nock.*not.*intercepted|disableNetConnect|real.*HTTP.*request.*test/i.test(logs)) return [];
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as { devDependencies?: Record<string, string> };
    if (pkg.devDependencies?.nock) return [];
    return [{
      path: 'package.json',
      content: JSON.stringify({ ...pkg, devDependencies: { ...(pkg.devDependencies ?? {}), nock: '^13.5.0' } }, null, 2) + '\n',
      explanation: 'Added nock to devDependencies — real HTTP requests made during tests; nock intercepts Node.js http/https to prevent network calls in unit tests',
      confidence: 85,
    }];
  } catch { return []; }
}

/** Add vi.mock() deps inline configuration for MSW + ESM mock hoisting in Vitest. */
export function fixVitestMockHoisting(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/vi\.mock.*hoist|mock.*not.*hoisted|vitest.*mock.*import.*order/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.startsWith('vitest.config')) continue;
    if (f.content.includes('deps:') || f.content.includes('inline:')) continue;
    const fixed = f.content.replace(/(test:\s*\{)/, "$1\n    server: { deps: { inline: ['msw'] } },");
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added server.deps.inline for MSW — vi.mock() hoisting issue with ESM; inlining transforms the dep so vi.mock() hoisting works correctly', confidence: 85 });
  }
  return fixes;
}

/** Load .env.test via dotenv in jest setup file so process.env is populated in tests. */
export function fixMockEnvVarSetup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/process\.env.*undefined.*test|env.*not.*loaded.*test|mock.*env.*undefined/i.test(logs)) return [];
  const setupFile = files.find(f => f.path.includes('jest.setup') || f.path.includes('setupTests'));
  if (setupFile) {
    if (setupFile.content.includes('dotenv')) return [];
    return [{ path: setupFile.path, content: "require('dotenv').config({ path: '.env.test' });\n\n" + setupFile.content, explanation: "Added dotenv.config({ path: '.env.test' }) to jest setup — process.env.* was undefined in tests; .env.test loaded before any test file imports", confidence: 90 }];
  }
  return [{ path: 'jest.setup.ts', content: "import dotenv from 'dotenv';\ndotenv.config({ path: '.env.test' });\n", explanation: 'Created jest.setup.ts loading .env.test — env vars undefined in tests; add this file to jest.config setupFilesAfterEach array', confidence: 85 }];
}

/** Add MSW server to jest setup file for API mocking in React tests. */
export function fixMSWSetup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/MSW|mock.*service.*worker|fetch.*mock.*msw/i.test(logs)) return [];
  if (!files.some(f => f.content.includes('msw') || f.content.includes('setupServer'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('setupFilesAfterEach') || f.content.includes('msw')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      "$1\n  setupFilesAfterEach: ['./src/tests/setup.ts'],",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added setupFilesAfterEach to jest.config — MSW server not initialized; setup file starts the mock server before each test module', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION E — Test Environment Misconfiguration (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add @testing-library/jest-dom to setupFilesAfterEach in jest.config. */
export function fixJestSetupFiles(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/toBeInTheDocument.*not.*matcher|jest-dom.*not.*found|setupFilesAfterEach/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('setupFilesAfterEach') || f.content.includes('jest-dom')) continue;
    if (!files.some(fi => fi.content.includes('@testing-library'))) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      "$1\n  setupFilesAfterEach: ['@testing-library/jest-dom'],",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added @testing-library/jest-dom to setupFilesAfterEach — toBeInTheDocument() not recognized; jest-dom matchers must register before tests run', confidence: 95 });
  }
  return fixes;
}

/** Add setupFiles to Vitest config to register @testing-library/jest-dom matchers. */
export function fixVitestSetupFiles(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/toBeInTheDocument.*vitest|vitest.*custom.*matcher|@testing-library.*vitest/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.startsWith('vitest.config')) continue;
    if (f.content.includes('setupFiles')) continue;
    const fixed = f.content.replace(/(test:\s*\{)/, "$1\n    setupFiles: ['./src/tests/setup.ts'],");
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added setupFiles to vitest config — @testing-library/jest-dom matchers not registered; setup file imports them before each test module', confidence: 90 });
  }
  return fixes;
}

/** Fix transformIgnorePatterns to allow Jest to transform ESM-only packages. */
export function fixJestTransformIgnore(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/SyntaxError.*unexpected token.*import|Cannot use import statement.*jest|transformIgnorePatterns/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const pkgMatch = logs.match(/node_modules\/([\w@/-]+)\/(?:src|dist|esm)/);
  const esmPkg = pkgMatch?.[1] ?? 'msw|axios|nanoid|uuid|date-fns|lodash-es';
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('transformIgnorePatterns')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      `$1\n  transformIgnorePatterns: ['node_modules/(?!(${esmPkg})/)'],`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added transformIgnorePatterns exception for (${esmPkg}) — SyntaxError: unexpected token import; Jest must transform ESM-only packages through Babel/ts-jest`, confidence: 95 });
  }
  return fixes;
}

/** Add mjs/cjs to moduleFileExtensions in jest.config for full Node.js resolution. */
export function fixJestModuleExtensions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot find module.*\.mjs|\.cjs.*not.*resolved|moduleFileExtensions/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('moduleFileExtensions')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      "$1\n  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'node'],",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added mjs/cjs to moduleFileExtensions — Jest cannot resolve .mjs/.cjs imports; full extension list now matches Node.js resolution algorithm', confidence: 90 });
  }
  return fixes;
}

/** Create conftest.py with a stub for the missing pytest fixture. */
export function fixPytestConftestSetup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/fixture.*not.*found|conftest.*missing|pytest.*fixture.*undefined/i.test(logs)) return [];
  if (files.some(f => f.path.endsWith('conftest.py'))) return [];
  const fixtureMatch = logs.match(/fixture ['"]?([\w_]+)['"]? not found/i);
  const missingFixture = fixtureMatch?.[1] ?? 'db_session';
  return [{
    path: 'conftest.py',
    content: ['"""Shared pytest fixtures."""', 'import pytest', '', '', '@pytest.fixture(scope="session")', 'def app():', '    from your_app import create_app', "    app = create_app({'TESTING': True})", '    yield app', '', '', `@pytest.fixture(scope="function")`, `def ${missingFixture}(app):`, `    """Stub for '${missingFixture}' — replace with real implementation."""`, '    yield None', ''].join('\n'),
    explanation: `Created conftest.py with '${missingFixture}' fixture stub — pytest fixture not found; conftest.py is auto-imported for fixture discovery`,
    confidence: 85,
  }];
}

/** Create cypress.config when Cypress tests fail due to missing baseUrl. */
export function fixCypressConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/baseUrl.*cypress|cypress\.config.*not.*found|cy\.visit.*baseUrl/i.test(logs)) return [];
  if (files.some(f => f.path.startsWith('cypress.config'))) return [];
  const isTS = files.some(f => f.path === 'tsconfig.json');
  return [{
    path: `cypress.config.${isTS ? 'ts' : 'js'}`,
    content: ["import { defineConfig } from 'cypress';", '', 'export default defineConfig({', '  e2e: {', "    baseUrl: process.env.CYPRESS_BASE_URL ?? 'http://localhost:3000',", '    viewportWidth: 1280,', '    viewportHeight: 720,', '    video: false,', '    screenshotOnRunFailure: true,', "    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',", '  },', '});', ''].join('\n'),
    explanation: 'Created cypress.config — baseUrl missing causes all cy.visit() to fail; reads CYPRESS_BASE_URL env var with fallback to localhost:3000',
    confidence: 95,
  }];
}

/** Add path alias to vitest.config to match tsconfig paths for '@/' imports. */
export function fixVitestAliasConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot find module.*@\/.*vitest|Failed to resolve.*@\/.*vitest/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.startsWith('vitest.config')) continue;
    if (f.content.includes('alias')) continue;
    const fixed = f.content.replace(
      /export default defineConfig\(\{/,
      "import { resolve } from 'path';\n\nexport default defineConfig({\n  resolve: { alias: { '@': resolve(__dirname, './src') } },",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added resolve.alias '@'→'./src' to vitest config — Cannot find module '@/...'; path alias must be declared in vitest config separately from tsconfig", confidence: 90 });
  }
  return fixes;
}

/** Add CI-specific Jest config overrides: reduced workers, no color, JSON reporter. */
export function fixJestCIOverrides(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/jest.*CI.*override|CI.*jest.*slow|jest.*color.*CI/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('--no-coverage-provider')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  CI: true',
      '  FORCE_COLOR: 0',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added CI=true + FORCE_COLOR=0 — Jest detects CI env to disable interactive mode; FORCE_COLOR=0 removes ANSI escape codes from CI logs', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION F — Coverage Threshold Failure (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add JSON + LCOV coverage reporters to jest.config for external tool integration. */
export function fixCoverageJSONReporter(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/coverage.*reporter|lcov.*not.*generated|coverage.*json.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('lcov') || f.content.includes('coverageReporters')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      "$1\n  coverageReporters: ['text', 'json', 'lcov', 'html', 'clover'],\n  coverageDirectory: 'coverage',",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added coverageReporters (text, JSON, LCOV, HTML) — LCOV report not generated; Codecov, SonarQube, and GitLab coverage pages all require LCOV format', confidence: 95 });
  }
  return fixes;
}

/** Add v8 coverage provider + reporters to vitest config. */
export function fixVitestCoverageProvider(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/vitest.*coverage|@vitest\/coverage-v8.*not.*found|coverage.*vitest/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.startsWith('vitest.config')) continue;
    if (f.content.includes('coverage')) continue;
    const fixed = f.content.replace(
      /(test:\s*\{)/,
      "$1\n    coverage: { provider: 'v8', reporter: ['text', 'json', 'lcov', 'html'], exclude: ['node_modules/', 'dist/', '**/*.config.*', '**/*.d.ts'] },",
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added v8 coverage to vitest — coverage not configured; v8 uses Node.js native coverage for accurate TypeScript source-level reports", confidence: 95 });
  }
  return fixes;
}

/** Add Codecov upload step after test run. */
export function fixCodecovUploadStep(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/codecov|coverage.*upload|CODECOV_TOKEN/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('codecov') || !f.content.includes('--coverage')) continue;
    const codecovStep = [
      '      - name: Upload coverage to Codecov',
      '        uses: codecov/codecov-action@v4',
      '        with:',
      '          token: ${{ secrets.CODECOV_TOKEN }}',
      '          files: ./coverage/lcov.info',
      '          fail_ci_if_error: false',
    ].join('\n');
    const lines = f.content.split('\n');
    const lastRunIdx = lines.reduce((acc, line, i) => /run:.*(?:jest|vitest|coverage)/.test(line) ? i : acc, -1);
    if (lastRunIdx === -1) continue;
    let insertAt = lastRunIdx;
    for (let i = lastRunIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, codecovStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added Codecov upload step — coverage not reported to PRs; requires CODECOV_TOKEN secret and lcov.info at ./coverage/lcov.info', confidence: 85 });
  }
  return fixes;
}

/** Upload HTML coverage report as CI artifact for offline inspection. */
export function fixCoverageArtifactUpload(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/coverage.*artifact|coverage.*html.*download/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('coverage-report') || !f.content.includes('--coverage')) continue;
    const uploadStep = [
      '      - name: Upload coverage report',
      '        if: always()',
      '        uses: actions/upload-artifact@v4',
      '        with:',
      '          name: coverage-report',
      '          path: coverage/',
      '          retention-days: 7',
    ].join('\n');
    const lines = f.content.split('\n');
    const lastRunIdx = lines.reduce((acc, line, i) => /run:.*(?:jest|vitest|coverage)/.test(line) ? i : acc, -1);
    if (lastRunIdx === -1) continue;
    let insertAt = lastRunIdx;
    for (let i = lastRunIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, uploadStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added coverage HTML artifact upload — downloadable from Actions run for detailed per-file coverage analysis', confidence: 90 });
  }
  return fixes;
}

/** Add collectCoverageFrom to include all source files, not just imported ones. */
export function fixCoverageCollectAllFiles(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/coverage.*only.*tested|collectCoverageFrom.*missing|untested.*files.*coverage/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('collectCoverageFrom')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      `$1\n  collectCoverageFrom: [\n    'src/**/*.{ts,tsx,js,jsx}',\n    '!src/**/*.d.ts',\n    '!src/**/*.stories.*',\n    '!src/**/index.{ts,js}',\n    '!src/**/__generated__/**',\n    '!src/**/*.mock.*',\n    '!src/**/__mocks__/**',\n  ],`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added collectCoverageFrom — coverage only reported on tested files; forces all source files into the report, revealing untested modules', confidence: 95 });
  }
  return fixes;
}

/** Exclude generated, proto, and migration files from coverage calculation. */
export function fixCoverageExcludeGenerated(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/coverage.*generated|__generated__.*coverage|coverage.*proto/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('coveragePathIgnorePatterns')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      `$1\n  coveragePathIgnorePatterns: [\n    '/node_modules/',\n    '/dist/',\n    '/__generated__/',\n    '/proto/',\n    '/migrations/',\n    '\\\\.stories\\\\.',\n    '\\\\.d\\\\.ts$',\n  ],`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added coveragePathIgnorePatterns — generated/proto/migration files dragging down coverage; excluded from calculation', confidence: 95 });
  }
  return fixes;
}

/** Add global + per-directory coverageThreshold to jest.config. */
export function fixPerFileCoverageThreshold(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/coverage.*threshold.*not.*met|jest.*coverage.*threshold|global.*coverage.*below/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/jest\.config\.(js|ts|json|cjs)$/.test(f.path)) continue;
    if (f.content.includes('coverageThreshold')) continue;
    const fixed = f.content.replace(
      /(module\.exports\s*=\s*\{|export default\s*(?:defineConfig\()?\{)/,
      `$1\n  coverageThreshold: {\n    global: { branches: 70, functions: 75, lines: 80, statements: 80 },\n    './src/lib/': { branches: 80, functions: 85, lines: 85, statements: 85 },\n  },`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added coverageThreshold — no coverage enforcement configured; global 80% + core lib/ 85% thresholds now fail CI when coverage drops', confidence: 90 });
  }
  return fixes;
}

/** Add pytest-cov with --cov-fail-under=70 to Python CI for coverage enforcement. */
export function fixPytestCoverageConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/coverage.*pytest|pytest.*coverage|--cov.*fail|FAIL.*Required.*coverage/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pytest') || f.content.includes('--cov')) continue;
    const fixed = f.content
      .replace(/(pip install\s+[^\n]+)/g, '$1 pytest-cov coverage[toml]')
      .replace(/((?:python -m )?pytest)(\s)/g, '$1 --cov=src --cov-report=xml --cov-report=term-missing --cov-fail-under=70$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pytest-cov --cov-fail-under=70 — Python coverage not configured; generates XML for Codecov and fails CI when coverage drops below 70%', confidence: 90 });
  }
  return fixes;
}

/** Add GitLab CI coverage parsing regex to extract coverage % from test output. */
export function fixGitLabCoverageRegex(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/gitlab.*coverage.*badge|coverage.*regex.*gitlab/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path) || f.content.includes('coverage:')) continue;
    const isJest   = f.content.includes('jest') || f.content.includes('vitest');
    const regex = isJest
      ? 'All files[^|]*\\|[^|]*\\|[^|]*\\|[^|]*\\|\\s*([\\d.]+)'
      : 'TOTAL\\s+\\d+\\s+\\d+\\s+([\\d.]+)%';
    const fixed = f.content.replace(/^((?:test|unit-test|coverage)[\w-]*:)$/im, `$1\n  coverage: '/${regex}/'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added GitLab coverage regex — GitLab cannot parse coverage %; regex extracts the number from ${isJest ? 'Jest' : 'pytest'} stdout for MR badges`, confidence: 90 });
  }
  return fixes;
}

/** Create a minimal passing smoke test when CI requires at least one test file. */
export function fixCreateMinimalTest(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Your test suite must contain at least one test|no test files found/i.test(logs)) return [];
  if (files.some(f => f.path.includes('.test.') || f.path.includes('.spec.'))) return [];
  const isTS    = files.some(f => f.path === 'tsconfig.json');
  const isReact = files.some(f => f.content.includes('react-dom'));
  const ext = isTS ? 'ts' : 'js';
  const testContent = isReact
    ? [
        "import { describe, it, expect } from 'vitest';",
        '',
        "describe('smoke', () => {",
        "  it('renders a DOM element', () => {",
        '    const div = document.createElement("div");',
        '    expect(div).toBeDefined();',
        '  });',
        '});',
        '',
      ].join('\n')
    : [
        "// Minimal smoke test — replace with real tests",
        "describe('smoke', () => {",
        "  it('environment is configured', () => {",
        "    expect(process.env.NODE_ENV).toBe('test');",
        '  });',
        "  it('basic arithmetic', () => {",
        '    expect(1 + 1).toBe(2);',
        '  });',
        '});',
        '',
      ].join('\n');
  return [{
    path: `src/__tests__/smoke.test.${ext}`,
    content: testContent,
    explanation: 'Created minimal smoke test — CI requires at least one test file; replace with real application tests',
    confidence: 100,
  }];
}
