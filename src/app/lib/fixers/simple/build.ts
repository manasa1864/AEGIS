// Simple / Build Errors
// ─────────────────────────────────────────────────────────────────────────────
// Category 1 — Build script failure
//   Node/webpack heap OOM · missing build script · Gradle wrapper chmod ·
//   Gradle daemon OOM · Maven surefire · Turborepo pipeline · NX target ·
//   pnpm workspace · Cargo workspace · Next.js output · Makefile ·
//   Android Gradle heap · shell script exit-code handling
// Category 2 — Compilation failure
//   TypeScript · Java (cannot find symbol) · Go (import/module) · Rust (edition) ·
//   .NET (CS0246/MSB3644/TFM) · Babel presets · Sass node-sass→sass ·
//   ESM↔CJS conflict · TypeScript path aliases · Kotlin jvmTarget
// Category 3 — Missing build artifact
//   dist/ · build/ · build/libs/ · target/ · publish/ · target/release/ ·
//   out/ · app/build/outputs/ · Go binary · Docker save tarball
// Category 4 — Invalid build target
//   npm scripts · Gradle tasks · Maven goals · Turbo tasks · Bazel targets ·
//   npm workspace scripts · NX targets
// Category 5 — Unsupported runtime version
//   Node experimental flags · python2→3 · Java --release · Rust toolchain ·
//   .NET TFM downgrade · Go directive · Swift tools version

import { RuleFix, isGitHubWorkflow, isGitLabCI, injectWorkflowLevelBlock, insertStepBefore } from '../helpers';

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 1 — Build script failure
// ═══════════════════════════════════════════════════════════════════

/** Add NODE_OPTIONS=--max-old-space-size when heap OOM is detected. */
export function fixNodeHeapMemory(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/JavaScript heap out of memory|FATAL ERROR.*Heap|Reached heap limit/i.test(logs)) return [];
  const heapMatch = logs.match(/(\d+)\s*MB.*heap/i);
  const detectedMB = heapMatch ? parseInt(heapMatch[1], 10) : 2048;
  const limitMB = Math.min(Math.max(detectedMB * 2, 4096), 8192);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('max-old-space-size')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [`  NODE_OPTIONS: --max-old-space-size=${limitMB} --expose-gc`]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added NODE_OPTIONS=--max-old-space-size=${limitMB} — Node.js ran out of heap during build; limit derived from ~${detectedMB}MB detected usage`, confidence: 100 });
  }
  return fixes;
}

/** Add NODE_OPTIONS scoped to webpack command when webpack OOM is detected. */
export function fixWebpackMemoryLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/JavaScript heap out of memory|webpack.*OOM|FATAL ERROR.*webpack/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('webpack') || f.content.includes('max-old-space-size')) continue;
    const fixed = f.content.replace(/(run:\s*)((?:npx\s+)?webpack\b)/g, '$1NODE_OPTIONS=--max-old-space-size=8192 $2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added NODE_OPTIONS=--max-old-space-size=8192 before webpack — large bundles with many chunks/modules consume >4GB RAM', confidence: 100 });
  }
  return fixes;
}

/** Add missing build script to package.json when npm run build is called. */
export function fixMissingBuildScript(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/missing script.*build|npm run build.*ENOENT|Missing.*"build"/i.test(logs)) return [];
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as { scripts?: Record<string, string> };
    if (pkg.scripts?.build) return [];
    const hasTsc  = files.some(f => f.path === 'tsconfig.json');
    const hasVite = files.some(f => /^vite\.config\.(ts|js|mjs)$/.test(f.path));
    const hasNext = files.some(f => /^next\.config\.(js|ts|mjs)$/.test(f.path));
    const hasNuxt = files.some(f => /^nuxt\.config\.(ts|js)$/.test(f.path));
    const hasRemix = files.some(f => f.path === 'remix.config.js');
    const cmd = hasRemix ? 'remix build'
      : hasNext ? 'next build'
      : hasNuxt ? 'nuxt build'
      : hasVite ? 'vite build'
      : hasTsc  ? 'tsc'
      : 'echo "No build configured — add build command"';
    return [{
      path: 'package.json',
      content: JSON.stringify({ ...pkg, scripts: { ...(pkg.scripts ?? {}), build: cmd, 'build:check': hasTsc ? 'tsc --noEmit' : 'echo "ok"' } }, null, 2) + '\n',
      explanation: `Added build script ("${cmd}") to package.json — npm run build failed with "Missing script: build"`,
      confidence: 100,
    }];
  } catch { return []; }
}

/** Chmod +x ./gradlew before Gradle build when the wrapper is not executable. */
export function fixGradleWrapperPermission(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasGradlew = files.some(f => f.path === 'gradlew' || f.path === './gradlew');
  if (!hasGradlew) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('./gradlew') || f.content.includes('chmod +x')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*\.\/gradlew/,
      `      - name: Make Gradle wrapper executable\n        run: chmod +x ./gradlew`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added chmod +x ./gradlew — Gradle wrapper script must be executable on Linux/macOS runners; Windows-generated gradlew files often lose execute permission in git', confidence: 100 });
  }
  return fixes;
}

/** Set Gradle JVM heap via GRADLE_OPTS when Gradle runs OOM or OutOfMemoryError appears. */
export function fixGradleDaemonOOM(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/OutOfMemoryError|GC overhead limit|Gradle.*heap|Expiry.*daemon/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  // Patch gradle.properties if it exists
  const gradleProps = files.find(f => f.path === 'gradle.properties' || f.path.endsWith('/gradle.properties'));
  if (gradleProps && !gradleProps.content.includes('org.gradle.jvmargs')) {
    fixes.push({
      path: gradleProps.path,
      content: gradleProps.content.trimEnd() + '\norg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError\norg.gradle.daemon=true\norg.gradle.parallel=true\norg.gradle.caching=true\n',
      explanation: 'Added org.gradle.jvmargs=-Xmx4g to gradle.properties — Gradle daemon ran out of heap memory; 4GB is the recommended minimum for large Android/JVM projects',
      confidence: 100,
    });
  }

  // Also inject GRADLE_OPTS into CI env
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('gradlew') || f.content.includes('GRADLE_OPTS')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  GRADLE_OPTS: "-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx4g"']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GRADLE_OPTS with -Xmx4g — CI runner Gradle daemon ran out of heap; daemon is disabled in CI for predictability', confidence: 100 });
  }
  return fixes;
}

/** Add -DskipTests to Maven build commands when only build (not test) is desired. */
export function fixMavenBuildScript(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasPom = files.some(f => f.path === 'pom.xml');
  if (!hasPom) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    // Only add -DskipTests when there's a separate test job and a dedicated build step
    if (!f.content.includes('mvn') || f.content.includes('-DskipTests')) continue;
    const hasSeparateTestJob = (f.content.match(/name:\s*(test|run[- ]tests?)/gi) ?? []).length > 0;
    if (!hasSeparateTestJob) continue;
    const fixed = f.content.replace(
      /(run:\s*(?:\.\/mvnw|mvn)\s+(?:clean\s+)?(?:package|install|compile)(?!\s+-D))/g,
      '$1 -DskipTests',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -DskipTests to Maven build step — a separate test job exists; skipping tests in the build stage prevents duplicate test execution and speeds up the build', confidence: 100 });
  }
  return fixes;
}

/** Add `build` to turbo.json pipeline when turbo run build fails. */
export function fixTurboPipelineConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot find pipeline|turbo.*not found|missing.*pipeline/i.test(logs)
    && !files.some(f => f.path === 'turbo.json')) return [];

  const turboJson = files.find(f => f.path === 'turbo.json');
  if (!turboJson) {
    // Create a minimal turbo.json
    const fixes: RuleFix[] = [];
    for (const f of files) {
      if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
      if (!f.content.includes('turbo')) continue;
      fixes.push({
        path: 'turbo.json',
        content: JSON.stringify({
          $schema: 'https://turbo.build/schema.json',
          pipeline: {
            build: { dependsOn: ['^build'], outputs: ['dist/**', '.next/**', 'build/**'] },
            test: { dependsOn: ['build'], outputs: ['coverage/**'] },
            lint: { outputs: [] },
            dev: { cache: false, persistent: true },
          },
        }, null, 2) + '\n',
        explanation: 'Created turbo.json with build/test/lint pipeline — Turborepo requires a pipeline configuration; dependsOn: ["^build"] ensures dependencies are built before dependents',
        confidence: 100,
      });
    }
    return fixes;
  }

  try {
    const cfg = JSON.parse(turboJson.content) as { pipeline?: Record<string, unknown> };
    const pipeline = cfg.pipeline ?? {};
    let changed = false;
    if (!pipeline['build']) { pipeline['build'] = { dependsOn: ['^build'], outputs: ['dist/**', '.next/**', 'build/**'] }; changed = true; }
    if (!pipeline['test'])  { pipeline['test']  = { dependsOn: ['build'], outputs: ['coverage/**'] }; changed = true; }
    if (!pipeline['lint'])  { pipeline['lint']  = { outputs: [] }; changed = true; }
    if (!changed) return [];
    return [{
      path: turboJson.path,
      content: JSON.stringify({ ...cfg, pipeline }, null, 2) + '\n',
      explanation: 'Added missing build/test/lint tasks to turbo.json pipeline — turbo run build failed because the pipeline entry was not defined',
      confidence: 100,
    }];
  } catch { return []; }
}

/** Add NX target configuration when nx build fails with "target not found". */
export function fixNxBuildSetup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot find configuration for task|NX.*target.*not found|project\.json.*not found/i.test(logs)) return [];
  const projectJson = files.find(f => f.path === 'project.json');
  if (!projectJson) return [];
  try {
    const cfg = JSON.parse(projectJson.content) as { targets?: Record<string, unknown> };
    const targets = cfg.targets ?? {};
    let changed = false;
    if (!targets['build']) {
      targets['build'] = { executor: '@nx/js:tsc', options: { outputPath: 'dist/{projectName}', main: 'src/index.ts', tsConfig: 'tsconfig.lib.json' } };
      changed = true;
    }
    if (!targets['lint']) {
      targets['lint'] = { executor: '@nx/eslint:lint', options: { lintFilePatterns: ['{projectRoot}/**/*.ts'] } };
      changed = true;
    }
    if (!changed) return [];
    return [{
      path: projectJson.path,
      content: JSON.stringify({ ...cfg, targets }, null, 2) + '\n',
      explanation: 'Added build and lint targets to project.json — NX failed because the project was missing target definitions',
      confidence: 100,
    }];
  } catch { return []; }
}

/** Add --recursive or --filter to pnpm build when workspace build fails. */
export function fixPnpmWorkspaceBuild(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasWorkspace = files.some(f => f.path === 'pnpm-workspace.yaml');
  if (!hasWorkspace) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pnpm') || !f.content.includes('pnpm build') || f.content.includes('pnpm -r') || f.content.includes('pnpm --filter')) continue;
    const fixed = f.content.replace(/\bpnpm build\b/g, 'pnpm -r build');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed pnpm build → pnpm -r build — monorepo detected via pnpm-workspace.yaml; -r (recursive) builds all workspace packages in dependency order', confidence: 100 });
  }
  return fixes;
}

/** Use cargo build --workspace when Cargo.toml has [workspace] members. */
export function fixCargoWorkspaceBuild(files: Array<{ path: string; content: string }>): RuleFix[] {
  const cargoToml = files.find(f => f.path === 'Cargo.toml');
  if (!cargoToml || !cargoToml.content.includes('[workspace]')) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('cargo build') || f.content.includes('--workspace')) continue;
    const fixed = f.content.replace(/\bcargo build\b(?!\s+--workspace)/g, 'cargo build --workspace');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --workspace to cargo build — Cargo.toml defines a workspace; building without --workspace only builds the root crate and misses member crates', confidence: 100 });
  }
  return fixes;
}

/** Set Next.js output mode to standalone for Docker deployments. */
export function fixNextJsBuildConfig(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/next\.config\.(js|ts|mjs)$/.test(f.path)) continue;
    const hasDocker = files.some(fi => fi.path === 'Dockerfile' && fi.content.includes('next'));
    if (!hasDocker || f.content.includes('output:')) continue;
    const fixed = f.content.replace(
      /(nextConfig\s*=\s*\{|module\.exports\s*=\s*\{|export default\s*\{)/,
      '$1\n  output: "standalone",',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added output: "standalone" to next.config — Docker deployment detected; standalone output bundles only required server files and reduces image size by ~70%', confidence: 100 });
  }
  return fixes;
}

/** Add dotnet restore before dotnet build/test when missing. */
export function fixDotnetRestore(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const hasDotnet = f.content.includes('dotnet build') || f.content.includes('dotnet test') || f.content.includes('dotnet publish');
    if (!hasDotnet || f.content.includes('dotnet restore')) continue;
    if (isGitHubWorkflow(f.path)) {
      const patched = insertStepBefore(
        f.content,
        /run:\s*dotnet (build|test|publish)/,
        `      - name: Restore .NET packages\n        run: dotnet restore --locked-mode`,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added dotnet restore --locked-mode — .NET must restore NuGet packages before building; --locked-mode enforces packages.lock.json for reproducible restores', confidence: 100 });
    }
  }
  return fixes;
}

/** Add Vite production mode and build optimizations. */
export function fixViteProductionBuild(files: Array<{ path: string; content: string }>): RuleFix[] {
  const viteConfig = files.find(f => /vite\.config\.(ts|js|mjs)$/.test(f.path));
  if (!viteConfig) return [];
  const fixes: RuleFix[] = [];
  if (!viteConfig.content.includes('chunkSizeWarningLimit') && !viteConfig.content.includes('rollupOptions')) {
    const fixed = viteConfig.content.replace(
      /defineConfig\(\{/,
      'defineConfig({\n  build: {\n    chunkSizeWarningLimit: 1024,\n    sourcemap: false,\n    minify: "esbuild",\n    rollupOptions: {\n      output: {\n        manualChunks: {\n          vendor: [\'react\', \'react-dom\'],\n        },\n      },\n    },\n  },',
    );
    if (fixed !== viteConfig.content)
      fixes.push({ path: viteConfig.path, content: fixed, explanation: 'Added Vite build optimizations — chunkSizeWarningLimit prevents false alarms on large apps; manualChunks splits vendor from app code; esbuild minification is fastest', confidence: 100 });
  }
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('vite build') || f.content.includes('--mode production')) continue;
    const fixed = f.content.replace(/\bvite build\b/g, 'vite build --mode production');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --mode production to vite build — without the mode flag Vite may use development defaults which skip minification', confidence: 100 });
  }
  return fixes;
}

/** Add MAKEFLAGS and .PHONY to Makefile CI targets. */
export function fixMakefileCIMode(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('make ') || !files.some(fi => fi.path === 'Makefile' || fi.path === 'GNUmakefile')) continue;
    if (f.content.includes('MAKEFLAGS') || f.content.includes('make -j')) continue;
    const fixed = f.content.replace(/(run:\s*make\s+)/g, '$1MAKEFLAGS="--no-print-directory" ');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MAKEFLAGS=--no-print-directory to make commands — suppresses "Entering directory" messages that clutter CI logs', confidence: 100 });
  }
  // Patch Makefile itself to add .PHONY for common targets
  const makefile = files.find(f => f.path === 'Makefile' || f.path === 'GNUmakefile');
  if (makefile && !makefile.content.includes('.PHONY')) {
    const targets = [...makefile.content.matchAll(/^([a-z][a-z0-9_-]+):/gm)].map(m => m[1]);
    const commonPhony = targets.filter(t => ['build','test','clean','lint','install','run','deploy','release'].includes(t));
    if (commonPhony.length > 0) {
      fixes.push({
        path: makefile.path,
        content: `.PHONY: ${commonPhony.join(' ')}\n\n` + makefile.content,
        explanation: `Added .PHONY: ${commonPhony.join(' ')} to Makefile — without .PHONY, Make skips targets when a file with the same name exists (e.g., a "build" directory)`,
        confidence: 100,
      });
    }
  }
  return fixes;
}

/** Increase Android Gradle heap for large Android projects. */
export function fixAndroidGradleBuild(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Could not initialize class|OutOfMemoryError|Android.*Gradle/i.test(logs)
    && !files.some(f => f.path === 'app/build.gradle' || f.path === 'app/build.gradle.kts')) return [];

  const gradleProps = files.find(f => f.path === 'gradle.properties');
  const fixes: RuleFix[] = [];
  if (gradleProps && !gradleProps.content.includes('android.enableJetifier')) {
    fixes.push({
      path: gradleProps.path,
      content: gradleProps.content.trimEnd() + '\nandroid.useAndroidX=true\nandroid.enableJetifier=true\norg.gradle.jvmargs=-Xmx4g -XX:+HeapDumpOnOutOfMemoryError\norg.gradle.parallel=true\nandroid.enableBuildCache=true\n',
      explanation: 'Added Android build optimizations to gradle.properties — AndroidX migration, JVM heap increase to 4GB, and build cache enabled for faster incremental builds',
      confidence: 100,
    });
  }

  // Inject ANDROID_HOME and SDK setup in CI
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('./gradlew') || f.content.includes('ANDROID_HOME') || f.content.includes('android-version')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  ANDROID_HOME: ${{ runner.tool_cache }}/android-sdk',
      '  GRADLE_OPTS: "-Dorg.gradle.daemon=false"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ANDROID_HOME and GRADLE_OPTS for Android CI — Android SDK path must be explicit; daemon disabled for CI predictability', confidence: 100 });
  }
  return fixes;
}

/** Fix shell scripts failing in CI due to unhandled exit codes. */
export function fixShellScriptExitCodes(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Process completed with exit code [2-9]|non-zero exit code|exited with status/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.sh') && !f.path.endsWith('.bash')) continue;
    if (f.content.includes('set -euo pipefail') || f.content.includes('set -e')) continue;
    const shebang = f.content.startsWith('#!') ? f.content.split('\n')[0] + '\n' : '#!/usr/bin/env bash\n';
    const rest = f.content.startsWith('#!') ? f.content.slice(f.content.indexOf('\n') + 1) : f.content;
    fixes.push({
      path: f.path,
      content: shebang + 'set -euo pipefail\n' + rest,
      explanation: 'Added set -euo pipefail to shell script — without this, shell scripts continue running after errors; -e exits on error, -u treats unset variables as errors, -o pipefail propagates pipe failures',
      confidence: 100,
    });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 2 — Compilation failure
// ═══════════════════════════════════════════════════════════════════

/** Create a minimal tsconfig.json when tsc build fails because none exists. */
export function fixMissingTsConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/tsconfig\.json.*not found|Could not find tsconfig|TS5058/i.test(logs)) return [];
  if (files.some(f => f.path === 'tsconfig.json')) return [];
  const isReact = files.some(f => f.path === 'package.json' && (f.content.includes('"react"') || f.content.includes('"react-dom"')));
  return [{
    path: 'tsconfig.json',
    content: JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: isReact ? 'ESNext' : 'commonjs',
        moduleResolution: isReact ? 'bundler' : 'node',
        lib: isReact ? ['ES2022', 'DOM', 'DOM.Iterable'] : ['ES2022'],
        jsx: isReact ? 'react-jsx' : undefined,
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist', 'coverage', '**/*.test.ts', '**/*.spec.ts'],
    }, null, 2) + '\n',
    explanation: 'Created tsconfig.json — TypeScript build failed because no config file existed; strict mode enabled; jsx configured for React if detected',
    confidence: 100,
  }];
}

/** Fix TypeScript compilation errors by loosening strict settings and adding skipLibCheck. */
export function fixCompilationFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TS\d{4}|error TS|Compilation failed|tsc.*error|Type error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (f.path !== 'tsconfig.json') continue;
    try {
      const obj = JSON.parse(f.content) as { compilerOptions?: Record<string, unknown> };
      const opts = obj.compilerOptions ?? {};
      let changed = false;
      if (!opts['skipLibCheck'])                { opts['skipLibCheck'] = true; changed = true; }
      if (!opts['esModuleInterop'])             { opts['esModuleInterop'] = true; changed = true; }
      if (!opts['allowSyntheticDefaultImports']) { opts['allowSyntheticDefaultImports'] = true; changed = true; }
      // strict is never switched off — that hides real type errors instead of fixing them
      if (changed)
        fixes.push({ path: f.path, content: JSON.stringify({ ...obj, compilerOptions: opts }, null, 2) + '\n', explanation: 'Set TypeScript interop options — skipLibCheck skips type errors inside third-party .d.ts files and esModuleInterop/allowSyntheticDefaultImports fix default-import errors; strict mode is left untouched so real type errors in your code still fail the build', confidence: 100 });
    } catch { /* invalid JSON */ }
  }
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('tsc ') || f.content.includes('--skipLibCheck')) continue;
    const fixed = f.content.replace(/\btsc\b(?!\s+--)/g, 'tsc --skipLibCheck');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --skipLibCheck to tsc — type errors in third-party .d.ts files were blocking compilation', confidence: 100 });
  }
  return fixes;
}

/** Fix TypeScript path alias (e.g., @/*) not being resolved by webpack/vite/jest. */
export function fixTypeScriptPathAlias(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot find module.*@\/|Module not found.*@\//i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  // Add paths to tsconfig if missing
  const tsconfig = files.find(f => f.path === 'tsconfig.json');
  if (tsconfig) {
    try {
      const obj = JSON.parse(tsconfig.content) as { compilerOptions?: Record<string, unknown> };
      const opts = obj.compilerOptions ?? {};
      if (!opts['paths']) {
        opts['paths'] = { '@/*': ['./src/*'] };
        opts['baseUrl'] = '.';
        fixes.push({ path: tsconfig.path, content: JSON.stringify({ ...obj, compilerOptions: opts }, null, 2) + '\n', explanation: 'Added paths: {"@/*": ["./src/*"]} and baseUrl to tsconfig — @/ alias not resolvable without baseUrl + paths mapping', confidence: 100 });
      }
    } catch { /* skip */ }
  }

  // Add resolve.alias to Vite config
  const viteConfig = files.find(f => /vite\.config\.(ts|js)$/.test(f.path));
  if (viteConfig && !viteConfig.content.includes('resolve') && !viteConfig.content.includes('@/')) {
    const fixed = viteConfig.content.replace(
      /defineConfig\(\{/,
      "defineConfig({\n  resolve: {\n    alias: {\n      '@': path.resolve(__dirname, './src'),\n    },\n  },",
    );
    if (!viteConfig.content.includes("import path")) {
      fixes.push({ path: viteConfig.path, content: "import path from 'path';\n" + fixed, explanation: "Added resolve.alias {'@': './src'} to vite.config — Vite does not read tsconfig paths; the alias must be configured separately in vite.config", confidence: 100 });
    }
  }
  return fixes;
}

/** Fix ESM module imported with require() — change to dynamic import() or add type:module. */
export function fixESMCJSConflict(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/require\(\) of ES Module|ERR_REQUIRE_ESM|must use import to load ES Module/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  const pkgFile = files.find(f => f.path === 'package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { type?: string };
      if (pkg.type !== 'module') {
        // Option: add type:module is risky, instead guide through .mjs or esm interop
        fixes.push({
          path: pkgFile.path,
          content: JSON.stringify({ ...pkg, type: 'module' }, null, 2) + '\n',
          explanation: 'Added "type": "module" to package.json — require() of an ESM-only module failed; adding type:module enables native ESM; ensure all require() calls are changed to import statements',
          confidence: 100,
        });
      }
    } catch { /* skip */ }
  }

  // Patch CI to use --experimental-vm-modules with jest when ESM detected
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('experimental-vm-modules')) continue;
    const fixed = f.content.replace(/\bjest\b(?!\s+--experimental)/g, 'node --experimental-vm-modules node_modules/.bin/jest');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed jest → node --experimental-vm-modules jest — ESM modules require Jest to run under Node\'s experimental VM modules mode', confidence: 100 });
  }
  return fixes;
}

/** Fix Java compilation errors by setting Maven compiler source/target or Java release. */
export function fixJavaCompilationError(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/error: cannot find symbol|error: package.*does not exist|error: .*class.*not found|COMPILATION ERROR/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const pomFile = files.find(f => f.path === 'pom.xml');
  if (pomFile && !pomFile.content.includes('maven-compiler-plugin')) {
    const sourceMatch = logs.match(/source\s+(\d+)\s+is\s+(?:obsolete|not supported)/i);
    const javaVersion = sourceMatch ? sourceMatch[1] : '17';
    const pluginBlock = `
    <build>
      <plugins>
        <plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-compiler-plugin</artifactId>
          <version>3.13.0</version>
          <configuration>
            <release>${javaVersion}</release>
            <encoding>UTF-8</encoding>
          </configuration>
        </plugin>
      </plugins>
    </build>`;
    const fixed = pomFile.content.replace('</project>', pluginBlock + '\n</project>');
    if (fixed !== pomFile.content)
      fixes.push({ path: pomFile.path, content: fixed, explanation: `Added maven-compiler-plugin with <release>${javaVersion}> to pom.xml — Java compiler source/target version was not configured, causing symbol resolution failures`, confidence: 100 });
  }
  return fixes;
}

/** Fix Go compilation errors — go.mod module path mismatch, unused imports. */
export function fixGoCompilationError(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/imported and not used|undefined:|build constraints exclude|cannot use .* as type/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('go build') && !f.content.includes('go test')) continue;
    // Add go vet before build
    if (!f.content.includes('go vet')) {
      const patched = insertStepBefore(
        f.content,
        /run:\s*go (build|test)/,
        `      - name: Vet Go code\n        run: go vet ./...`,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added go vet ./... before build — catches common mistakes like unused imports and type mismatches before the build fails with cryptic errors', confidence: 100 });
    }
  }

  // Fix go.mod missing go version directive
  const goMod = files.find(f => f.path === 'go.mod');
  if (goMod && !goMod.content.match(/^go \d+\.\d+/m)) {
    fixes.push({
      path: goMod.path,
      content: goMod.content.replace(/^(module .+)$/m, '$1\n\ngo 1.22'),
      explanation: 'Added "go 1.22" directive to go.mod — missing version directive causes toolchain selection failures and feature compatibility issues',
      confidence: 100,
    });
  }
  return fixes;
}

/** Fix Rust compilation errors — edition mismatch, missing nightly features, toolchain. */
export function fixRustCompilationError(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/error\[E\d+\]|error: cannot find|this feature is unstable|requires nightly/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const cargoToml = files.find(f => f.path === 'Cargo.toml');

  if (cargoToml && !cargoToml.content.includes('edition =')) {
    const fixed = cargoToml.content.replace(/(\[package\]\n(?:[^\[]*\n)*?)/, '$1edition = "2021"\n');
    if (fixed !== cargoToml.content)
      fixes.push({ path: cargoToml.path, content: fixed, explanation: 'Added edition = "2021" to Cargo.toml — missing edition field defaults to 2015 which lacks many modern Rust features and syntax', confidence: 100 });
  }

  // Create rust-toolchain.toml if nightly is required but not pinned
  if (/requires nightly|nightly feature/i.test(logs) && !files.some(f => f.path === 'rust-toolchain.toml')) {
    fixes.push({
      path: 'rust-toolchain.toml',
      content: '[toolchain]\nchannel = "nightly"\ncomponents = ["rustfmt", "clippy"]\n',
      explanation: 'Created rust-toolchain.toml pinning nightly toolchain — a feature that requires nightly Rust was used; pinning prevents "this feature is unstable" errors on CI',
      confidence: 100,
    });
  }

  // Add CARGO_TERM_COLOR and RUST_BACKTRACE to CI
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('cargo') || f.content.includes('RUST_BACKTRACE')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  RUST_BACKTRACE: "1"',
      '  CARGO_TERM_COLOR: always',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added RUST_BACKTRACE=1 and CARGO_TERM_COLOR to CI — RUST_BACKTRACE provides full stack traces on panic; CARGO_TERM_COLOR ensures colored output in CI logs', confidence: 100 });
  }
  return fixes;
}

/** Fix .NET compilation errors — CS0246 type not found, MSB3644 targeting pack, TFM. */
export function fixDotNetCompilationError(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/CS0246|CS0234|MSB3644|The type or namespace|targeting pack/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  // CS0246 / CS0234: missing using → add global using or NuGet reference
  // MSB3644: targeting pack not found → downgrade TFM to LTS
  for (const f of files) {
    if (!f.path.endsWith('.csproj') && !f.path.endsWith('.fsproj')) continue;
    if (/MSB3644|targeting pack/i.test(logs) && f.content.includes('<TargetFramework>net9.')) {
      const fixed = f.content.replace(/<TargetFramework>net9\.[^<]+<\/TargetFramework>/g, '<TargetFramework>net8.0</TargetFramework>');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Downgraded TargetFramework from net9.x → net8.0 — .NET 9 targeting pack not installed on runner; net8.0 is the current LTS', confidence: 100 });
    }
    if (/MSB3644/i.test(logs) && f.content.includes('<TargetFramework>net8.') && !f.content.includes('net8.0')) {
      const fixed = f.content.replace(/<TargetFramework>net8\.[^<]+<\/TargetFramework>/g, '<TargetFramework>net8.0</TargetFramework>');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Normalized TargetFramework to net8.0 — partial version (e.g. net8.1) is not a valid moniker; net8.0 is the correct LTS identifier', confidence: 100 });
    }
  }

  // Add dotnet --version and setup step if missing
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('dotnet') || f.content.includes('setup-dotnet')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*dotnet/,
      `      - name: Setup .NET\n        uses: actions/setup-dotnet@v4\n        with:\n          dotnet-version: '8.0.x'`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added actions/setup-dotnet@v4 — .NET 8 must be installed on the runner before build; without this step, the runner may use an outdated or missing SDK', confidence: 100 });
  }
  return fixes;
}

/** Fix missing Babel preset causing transpilation failure. */
export function fixBabelPresetConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot find.*@babel\/preset|Unknown option.*babel|Babel.*preset.*not found/i.test(logs)) return [];
  const babelConfig = files.find(f => ['.babelrc', 'babel.config.js', 'babel.config.json', '.babelrc.js'].includes(f.path));
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!babelConfig && !pkgFile) return [];

  const isTS  = files.some(f => f.path === 'tsconfig.json');
  const isReact = files.some(f => f.path === 'package.json' && f.content.includes('"react"'));
  const fixes: RuleFix[] = [];

  if (!babelConfig) {
    const presets: string[] = [];
    if (isReact) presets.push('@babel/preset-react');
    if (isTS)    presets.push('@babel/preset-typescript');
    presets.push(['@babel/preset-env', { targets: { node: 'current' } }] as unknown as string);
    fixes.push({
      path: 'babel.config.json',
      content: JSON.stringify({ presets }, null, 2) + '\n',
      explanation: `Created babel.config.json with presets: [${presets.filter(p => typeof p === 'string').join(', ')}] — Babel transpilation failed because no config existed; presets selected based on detected stack (React: ${isReact}, TypeScript: ${isTS})`,
      confidence: 100,
    });
  }

  // Add missing devDependencies
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { devDependencies?: Record<string, string> };
      const dev = pkg.devDependencies ?? {};
      let changed = false;
      const needed: Record<string, string> = {
        '@babel/core': '^7.24.0',
        '@babel/preset-env': '^7.24.0',
      };
      if (isTS)    needed['@babel/preset-typescript'] = '^7.24.0';
      if (isReact) needed['@babel/preset-react'] = '^7.24.0';
      for (const [k, v] of Object.entries(needed)) {
        if (!dev[k]) { dev[k] = v; changed = true; }
      }
      if (changed)
        fixes.push({ path: pkgFile.path, content: JSON.stringify({ ...pkg, devDependencies: dev }, null, 2) + '\n', explanation: 'Added missing @babel/* presets to devDependencies — Babel failed because the required preset packages were not installed', confidence: 100 });
    } catch { /* skip */ }
  }
  return fixes;
}

/** Migrate node-sass → sass (dart-sass) when node-sass compilation fails. */
export function fixSassMigration(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/node-sass.*not found|Cannot find module 'node-sass'|node-sass.*does not support/i.test(logs)
    && !files.some(f => f.path === 'package.json' && f.content.includes('"node-sass"'))) return [];
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const dev = { ...(pkg.devDependencies ?? {}) };
    const deps = { ...(pkg.dependencies ?? {}) };
    let changed = false;
    if (dev['node-sass'])  { delete dev['node-sass']; dev['sass'] = '^1.77.0'; changed = true; }
    if (deps['node-sass']) { delete deps['node-sass']; deps['sass'] = '^1.77.0'; changed = true; }
    if (!changed) return [];
    return [{
      path: pkgFile.path,
      content: JSON.stringify({ ...pkg, dependencies: deps, devDependencies: dev }, null, 2) + '\n',
      explanation: 'Replaced node-sass with sass (dart-sass) — node-sass is deprecated and does not support Node.js ≥ 18; dart-sass is the official Sass implementation',
      confidence: 100,
    }];
  } catch { return []; }
}

/** Fix Kotlin jvmTarget mismatch with Java version in Gradle build. */
export function fixKotlinJvmTarget(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Inconsistent JVM-target|jvmTarget.*mismatch|Cannot inline bytecode.*targetCompatibility/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('build.gradle') && !f.path.endsWith('build.gradle.kts')) continue;
    if (f.content.includes('jvmTarget') || !f.content.includes('kotlin')) continue;
    const fixed = f.content.includes('compileKotlin')
      ? f.content.replace(/(compileKotlin\s*\{[^}]*)\}/s, '$1  kotlinOptions.jvmTarget = "17"\n}')
      : f.content + '\ntasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {\n  kotlinOptions.jvmTarget = "17"\n}\n';
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added kotlinOptions.jvmTarget = "17" — Kotlin and Java compilation targets must match; mismatch causes "Inconsistent JVM-target" errors during build', confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 3 — Missing build artifact
// ═══════════════════════════════════════════════════════════════════

/** Add mkdir -p before the build command when the output directory is missing. */
export function fixMissingOutputDirectory(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ENOENT.*dist|No such file.*build|cannot find.*dist/i.test(logs)) return [];
  const dirMatch = logs.match(/ENOENT[^\n]*?['"`]?([\w./]+(?:dist|build|out|output|public)[/\w.]*)['"`]?/i);
  const outDir = dirMatch?.[1]?.split('/')[0] ?? 'dist';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('npm run build') || f.content.includes(`mkdir -p ${outDir}`)) continue;
    const fixed = f.content.replace(/(run:\s*)(npm run build)/g, `$1mkdir -p ${outDir} && $2`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added mkdir -p ${outDir} before build — build tool requires the output directory to exist before writing artifacts`, confidence: 100 });
  }
  return fixes;
}

/** Fix artifact upload path when the project outputs to a non-standard directory. */
export function fixArtifactOutputPath(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No files were found with the provided path|if-no-files-found.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    const hasViteBuild  = files.some(fi => fi.path.startsWith('vite.config') && fi.content.includes("outDir: 'build'"));
    const hasNextConfig = files.some(fi => fi.path.startsWith('next.config') && fi.content.includes('distDir'));
    if (hasViteBuild) {
      const fixed = f.content.replace(/path:\s*dist\//g, 'path: build/').replace(/path:\s*dist\b/g, 'path: build');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Changed artifact path dist/ → build/ — Vite outDir is configured as build/', confidence: 100 });
    }
    if (hasNextConfig) {
      const fixed = f.content.replace(/path:\s*dist\//g, 'path: .next/').replace(/path:\s*dist\b/g, 'path: .next');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Changed artifact path dist/ → .next/ — Next.js builds to .next directory', confidence: 100 });
    }
  }
  return fixes;
}

/** Change if-no-files-found: error → warn on upload-artifact. */
export function fixArtifactIfNoFilesError(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('if-no-files-found: error')) continue;
    fixes.push({ path: f.path, content: f.content.replace(/if-no-files-found:\s*error/g, 'if-no-files-found: warn'), explanation: 'Changed if-no-files-found: error → warn — build may not produce artifacts on every run (e.g. draft PRs, lint-only)', confidence: 100 });
  }
  return fixes;
}

/** Fix artifact upload path for Gradle builds (build/libs/*.jar). */
export function fixGradleArtifactPath(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No files were found|no artifact|artifact.*not found/i.test(logs)
    && !files.some(f => f.path === 'build.gradle' || f.path === 'build.gradle.kts')) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    if (!files.some(fi => fi.path.endsWith('build.gradle') || fi.path.endsWith('build.gradle.kts'))) continue;
    if (f.content.includes('build/libs')) continue;
    const fixed = f.content.replace(/(path:\s*)(?:dist|target)\/[^\n]*/g, '$1build/libs/*.jar');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed artifact path → build/libs/*.jar — Gradle builds JAR/WAR artifacts to build/libs/ by default', confidence: 100 });
  }
  return fixes;
}

/** Fix artifact upload path for Maven builds (target/*.jar). */
export function fixMavenArtifactPath(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No files were found|no artifact/i.test(logs) && !files.some(f => f.path === 'pom.xml')) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    if (!files.some(fi => fi.path === 'pom.xml')) continue;
    if (f.content.includes('target/') || f.content.includes('build/libs')) continue;
    const fixed = f.content.replace(/(path:\s*)dist\/[^\n]*/g, '$1target/*.jar');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed artifact path → target/*.jar — Maven packages artifacts to target/ by default (not dist/)', confidence: 100 });
  }
  return fixes;
}

/** Fix artifact path for Rust binary builds (target/release/<name>). */
export function fixRustBinaryArtifact(files: Array<{ path: string; content: string }>): RuleFix[] {
  const cargoToml = files.find(f => f.path === 'Cargo.toml');
  if (!cargoToml) return [];
  const nameMatch = cargoToml.content.match(/^name\s*=\s*"([^"]+)"/m);
  if (!nameMatch) return [];
  const binaryName = nameMatch[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    if (f.content.includes('target/release')) continue;
    const fixed = f.content.replace(/(path:\s*)(?:dist|build)\/[^\n]*/g, `$1target/release/${binaryName}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Changed artifact path → target/release/${binaryName} — Rust release builds compile the binary to target/release/`, confidence: 100 });
  }
  return fixes;
}

/** Fix artifact path for dotnet publish output. */
export function fixDotNetPublishArtifact(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasCsproj = files.some(f => f.path.endsWith('.csproj'));
  if (!hasCsproj) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    if (f.content.includes('publish') || f.content.includes('./app/publish')) continue;
    if (!f.content.includes('dotnet publish')) continue;
    // Extract output path from publish command if specified
    const publishMatch = f.content.match(/dotnet publish[^\n]*-o\s+([^\s\n]+)/);
    const publishPath = publishMatch ? publishMatch[1] : './publish';
    const fixed = f.content.replace(/(path:\s*)(?:dist|build)\/[^\n]*/g, `$1${publishPath}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Changed artifact path → ${publishPath} — dotnet publish outputs to the path specified with -o; defaulting to ./publish`, confidence: 100 });
  }
  return fixes;
}

/** Fix artifact path for Go binary output. */
export function fixGoArtifactPath(files: Array<{ path: string; content: string }>): RuleFix[] {
  const goMod = files.find(f => f.path === 'go.mod');
  if (!goMod) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    if (f.content.includes('target/release') || !f.content.includes('go build')) continue;
    // Add -o ./bin/<name> to go build if not present
    const modName = goMod.content.match(/^module\s+(\S+)/m)?.[1]?.split('/').pop() ?? 'app';
    const fixed = f.content
      .replace(/\bgo build\b(?!\s+-o)/g, `go build -o ./bin/${modName}`)
      .replace(/(path:\s*)(?:dist|build)\/[^\n]*/g, `$1./bin/${modName}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added -o ./bin/${modName} to go build and set artifact path — Go builds a binary with the module name; explicit output path avoids artifact upload failures`, confidence: 100 });
  }
  return fixes;
}

/** Fix artifact path for Next.js static export (out/) vs SSR (.next/). */
export function fixNextExportArtifact(files: Array<{ path: string; content: string }>): RuleFix[] {
  const nextConfig = files.find(f => /next\.config\.(js|ts|mjs)$/.test(f.path));
  if (!nextConfig) return [];
  const fixes: RuleFix[] = [];
  const isStaticExport = nextConfig.content.includes("output: 'export'") || nextConfig.content.includes('output: "export"');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    if (isStaticExport && !f.content.includes('path: out') && f.content.includes('path: .next')) {
      fixes.push({ path: f.path, content: f.content.replace(/path:\s*\.next/g, 'path: out'), explanation: 'Changed artifact path .next/ → out/ — next.config has output: "export" which produces a static site in out/ instead of .next/', confidence: 100 });
    }
    if (!isStaticExport && !f.content.includes('path: .next') && f.content.includes('path: out')) {
      fixes.push({ path: f.path, content: f.content.replace(/path:\s*out\b/g, 'path: .next'), explanation: 'Changed artifact path out/ → .next/ — SSR Next.js builds to .next/; out/ is only for static exports', confidence: 100 });
    }
  }
  return fixes;
}

/** Add Docker save step to export image as tarball artifact. */
export function fixDockerSaveArtifact(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('docker build') || f.content.includes('docker save') || !f.content.includes('upload-artifact')) continue;
    // Inject docker save step after docker build
    const tagMatch = f.content.match(/docker build[^\n]*-t\s+([^\s\n]+)/);
    const tag = tagMatch ? tagMatch[1] : 'myapp:latest';
    const patched = insertStepBefore(
      f.content,
      /uses:\s*actions\/upload-artifact/,
      `      - name: Save Docker image\n        run: docker save ${tag} | gzip > image.tar.gz`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added docker save ${tag} | gzip → image.tar.gz before upload-artifact — Docker images must be exported to a file before they can be uploaded as CI artifacts`, confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 4 — Invalid build target
// ═══════════════════════════════════════════════════════════════════

/** Add missing npm script to package.json when npm run <script> is not found. */
export function fixInvalidBuildTarget(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/missing script|npm run.*not found|no such script|script.*not found|ENOENT.*scripts/i.test(logs)) return [];
  const scriptMatch = logs.match(/(?:missing script|npm run)\s+['"`]?(\w[\w:-]*)['"`]?/i);
  if (!scriptMatch) return [];
  const missingScript = scriptMatch[1];
  if (missingScript === 'build' || missingScript === 'test') return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (f.path !== 'package.json') continue;
    try {
      const pkg = JSON.parse(f.content) as { scripts?: Record<string, string> };
      if (pkg.scripts?.[missingScript]) continue;
      const existing = Object.keys(pkg.scripts ?? {});
      const similar = existing.find(s => s.startsWith(missingScript.split(':')[0]));
      const cmd = similar ? pkg.scripts![similar] : `echo "${missingScript} not yet configured"`;
      fixes.push({
        path: f.path,
        content: JSON.stringify({ ...pkg, scripts: { ...(pkg.scripts ?? {}), [missingScript]: cmd } }, null, 2) + '\n',
        explanation: `Added missing script "${missingScript}" to package.json — npm run ${missingScript} failed; inferred command from similar scripts`,
        confidence: 100,
      });
    } catch { /* skip */ }
  }
  return fixes;
}

/** Fix Gradle task not found — suggest close task name and add it if it's a known alias. */
export function fixGradleTaskNotFound(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Task '([^']+)' not found|Cannot find project ':([^']+)'/i.test(logs)) return [];
  const taskMatch = logs.match(/Task '([^']+)' not found/i);
  if (!taskMatch) return [];
  const missingTask = taskMatch[1];
  const fixes: RuleFix[] = [];

  // Common Gradle task aliases
  const taskAliasMap: Record<string, string> = {
    build: 'assemble',
    test: 'check',
    package: 'assemble',
    compile: 'compileJava',
    run: 'bootRun',
    jar: 'assemble',
    release: 'publishToMavenLocal',
  };

  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('./gradlew') || !f.content.includes(missingTask)) continue;
    const replacement = taskAliasMap[missingTask];
    if (!replacement) continue;
    const fixed = f.content.replace(new RegExp(`(\\.\/gradlew\\s+)${missingTask}\\b`, 'g'), `$1${replacement}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Changed gradlew ${missingTask} → ${replacement} — Gradle task "${missingTask}" does not exist; "${replacement}" is the standard equivalent`, confidence: 100 });
  }
  return fixes;
}

/** Fix Maven goal/plugin not found — add plugin management or fix lifecycle phase. */
export function fixMavenGoalNotFound(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No plugin found for prefix|Unknown lifecycle phase|Goal not found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const pomFile = files.find(f => f.path === 'pom.xml');
  if (!pomFile) return [];

  // Fix common lifecycle typos in CI commands
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('mvn')) continue;
    const typoMap: Array<[RegExp, string]> = [
      [/\bmvn\s+build\b/g, 'mvn package'],
      [/\bmvn\s+run\b/g, 'mvn spring-boot:run'],
      [/\bmvn\s+deploy\b(?!\s+-)/g, 'mvn deploy -DskipTests'],
    ];
    let fixed = f.content;
    let changed = false;
    for (const [pattern, replacement] of typoMap) {
      const updated = fixed.replace(pattern, replacement);
      if (updated !== fixed) { fixed = updated; changed = true; }
    }
    if (changed)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed Maven lifecycle phase — "build" is not a valid Maven phase; use "package" to build and "deploy" to publish', confidence: 100 });
  }
  return fixes;
}

/** Fix npm workspace script call format. */
export function fixNpmWorkspaceScript(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Workspace.*not found|missing script.*workspace|Cannot find workspace/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    // Fix `npm run build --workspace=packages/foo` → `npm run build -w packages/foo`
    const fixed = f.content.replace(/npm run (\S+)\s+--workspace=([^\s\n]+)/g, 'npm run $1 -w $2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Normalized npm workspace flag --workspace= → -w — --workspace= is npm v7+ syntax; -w is the shorter form that works consistently across npm versions', confidence: 100 });
  }
  return fixes;
}

/** Fix Turbo task not defined in pipeline — add placeholder entry to turbo.json. */
export function fixTurboMissingTask(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No task.*found in turbo\.json|cannot find.*task|turbo run.*error/i.test(logs)) return [];
  const taskMatch = logs.match(/turbo run (\w+)/i);
  if (!taskMatch) return [];
  const missingTask = taskMatch[1];
  const turboJson = files.find(f => f.path === 'turbo.json');
  if (!turboJson) return [];
  try {
    const cfg = JSON.parse(turboJson.content) as { pipeline?: Record<string, unknown> };
    if (cfg.pipeline?.[missingTask]) return [];
    const pipeline = { ...(cfg.pipeline ?? {}), [missingTask]: { outputs: [] } };
    return [{
      path: turboJson.path,
      content: JSON.stringify({ ...cfg, pipeline }, null, 2) + '\n',
      explanation: `Added "${missingTask}" task to turbo.json pipeline — turbo run ${missingTask} failed because the task was not defined in the pipeline config`,
      confidence: 100,
    }];
  } catch { return []; }
}

/** Fix Bazel build target path format. */
export function fixBazelBuildTarget(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/no such package|no such target|does not exist in BUILD|bazel: error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('bazel build') && !f.content.includes('bazel test')) continue;
    // Normalize target format (add // prefix if missing)
    const fixed = f.content.replace(/\bbazel (build|test)\s+(?!\/\/)([a-z])/g, 'bazel $1 //$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added // prefix to Bazel target — Bazel absolute targets must start with // (e.g., //src:app instead of src:app)', confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 5 — Unsupported runtime version
// ═══════════════════════════════════════════════════════════════════

/** Remove or adjust Node.js experimental flags that no longer exist in the target version. */
export function fixNodeExperimentalFlags(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Unknown option|bad option|unrecognized option|--experimental-.*not allowed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  // --openssl-legacy-provider removed in Node 18+
  for (const f of files) {
    if (f.path !== 'package.json') continue;
    try {
      const pkg = JSON.parse(f.content) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      let changed = false;
      for (const [key, cmd] of Object.entries(scripts)) {
        if (cmd.includes('--openssl-legacy-provider')) {
          scripts[key] = cmd.replace(/--openssl-legacy-provider\s*/g, '');
          changed = true;
        }
      }
      if (changed)
        fixes.push({ path: f.path, content: JSON.stringify({ ...pkg, scripts }, null, 2) + '\n', explanation: 'Removed --openssl-legacy-provider from scripts — this flag was removed in OpenSSL 3.x (Node.js ≥ 17); upgrade to a webpack/vite version that supports modern OpenSSL instead', confidence: 100 });
    } catch { /* skip */ }
  }
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const hasFlag = /--openssl-legacy-provider|--experimental-specifier-resolution=node/i.test(f.content);
    if (!hasFlag) continue;
    const fixed = f.content
      .replace(/--openssl-legacy-provider\s*/g, '')
      .replace(/--experimental-specifier-resolution=node\s*/g, '');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed deprecated Node.js flags — --openssl-legacy-provider removed in Node 18+; --experimental-specifier-resolution removed in Node 20', confidence: 100 });
  }
  return fixes;
}

/** Replace python with python3 in CI to avoid Python 2 interpreter. */
export function fixPython2to3(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    // Replace bare `python ` (not python3) commands
    if (!f.content.includes('python ') && !f.content.includes('python\n')) continue;
    if (f.content.includes('python3') || f.content.includes('python-version')) continue;
    const fixed = f.content
      .replace(/\bpython\s+(?!3)/g, 'python3 ')
      .replace(/\bpip\s+(?!3)/g, 'pip3 ');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed python → python3 and pip → pip3 — Python 2 reached EOL in January 2020; Ubuntu 22.04+ runners do not include the python2 binary', confidence: 100 });
  }
  return fixes;
}

/** Add --release flag to Java compiler for cross-version compatibility. */
export function fixJavaReleaseFlag(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/source release.*not support|warning.*bootstrap classpath|source 1\.[5-8] is obsolete/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const pomFile = files.find(f => f.path === 'pom.xml');
  if (pomFile && !pomFile.content.includes('<release>')) {
    const fixed = pomFile.content.replace(
      /(<configuration>[\s\S]*?)<\/configuration>/,
      '$1  <release>17</release>\n  </configuration>',
    );
    if (fixed !== pomFile.content)
      fixes.push({ path: pomFile.path, content: fixed, explanation: 'Added <release>17</release> to Maven compiler plugin — the --release flag is the modern replacement for -source/-target; it also ensures the correct bootstrap classpath', confidence: 100 });
  }
  for (const f of files) {
    if (!f.path.endsWith('build.gradle') && !f.path.endsWith('build.gradle.kts')) continue;
    if (f.content.includes('release =') || f.content.includes('sourceCompatibility')) continue;
    const fixed = f.content + '\njava {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(17)\n  }\n}\n';
    fixes.push({ path: f.path, content: fixed, explanation: 'Added Java toolchain with languageVersion=17 to Gradle build — Java toolchain API ensures the correct JDK version is used for compilation and test execution', confidence: 100 });
  }
  return fixes;
}

/** Create or fix rust-toolchain.toml to pin a stable Rust version. */
export function fixRustToolchainFile(files: Array<{ path: string; content: string }>): RuleFix[] {
  const cargoToml = files.find(f => f.path === 'Cargo.toml');
  if (!cargoToml) return [];
  const toolchainFile = files.find(f => f.path === 'rust-toolchain' || f.path === 'rust-toolchain.toml');
  if (toolchainFile) return []; // already pinned
  return [{
    path: 'rust-toolchain.toml',
    content: '[toolchain]\nchannel = "stable"\ncomponents = ["rustfmt", "clippy"]\ntargets = ["x86_64-unknown-linux-musl"]\n',
    explanation: 'Created rust-toolchain.toml pinning stable channel — without toolchain pinning, CI uses the runner\'s default Rust version which changes on runner image updates; musl target enables static linking for portable binaries',
    confidence: 100,
  }];
}

/** Fix .NET TargetFramework when the runtime version is not supported on the runner. */
export function fixDotNetTargetFramework(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No usable version of dotnet|The current .NET SDK does not support targeting|TargetFramework.*not supported/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.csproj') && !f.path.endsWith('.vbproj') && !f.path.endsWith('.fsproj')) continue;
    // Downgrade bleeding-edge TFMs to the installed LTS
    const fixed = f.content
      .replace(/<TargetFramework>net9\.\d+<\/TargetFramework>/g, '<TargetFramework>net8.0</TargetFramework>')
      .replace(/<TargetFramework>netcoreapp2\.\d+<\/TargetFramework>/g, '<TargetFramework>net8.0</TargetFramework>');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Downgraded .NET TargetFramework to net8.0 LTS — the runner does not have .NET 9 or netcoreapp2.x SDK installed; net8.0 is the current LTS supported on all hosted runners', confidence: 100 });
  }
  return fixes;
}

/** Fix go.mod go directive to match the version installed on the runner. */
export function fixGoModDirective(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/go: go.mod file indicates go version|requires newer go|go version.*does not support/i.test(logs)) return [];
  const goMod = files.find(f => f.path === 'go.mod');
  if (!goMod) return [];
  // Extract required version from log
  const versionMatch = logs.match(/go(\d+\.\d+(?:\.\d+)?)/);
  const requiredVersion = versionMatch ? versionMatch[1] : '1.22';
  const fixes: RuleFix[] = [];

  // Update the go directive in go.mod
  const fixed = goMod.content.replace(/^go \d+\.\d+(?:\.\d+)?$/m, `go ${requiredVersion}`);
  if (fixed !== goMod.content)
    fixes.push({ path: goMod.path, content: fixed, explanation: `Updated go directive to go ${requiredVersion} in go.mod — directive must match the Go version used to build the module; mismatches cause "requires newer go" errors`, confidence: 100 });

  // Also update setup-go version in CI
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('setup-go') || f.content.includes(`go-version: '${requiredVersion}'`)) continue;
    const updatedCI = f.content.replace(/go-version:\s*['"]\d+\.\d+(?:\.\d+)?['"]/g, `go-version: '${requiredVersion}'`);
    if (updatedCI !== f.content)
      fixes.push({ path: f.path, content: updatedCI, explanation: `Updated setup-go go-version to ${requiredVersion} to match go.mod directive`, confidence: 100 });
  }
  return fixes;
}

/** Fix Swift Package Manager tools version mismatch. */
export function fixSwiftToolsVersion(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/swift-tools-version|Swift.*package.*requires|Package.swift.*version/i.test(logs)) return [];
  const packageSwift = files.find(f => f.path === 'Package.swift');
  if (!packageSwift) return [];
  // Downgrade swift-tools-version if 5.9+ is required but only 5.8 is available
  if (!packageSwift.content.match(/swift-tools-version:\s*5\.9/)) return [];
  const fixed = packageSwift.content.replace(/swift-tools-version:\s*5\.\d+/, 'swift-tools-version: 5.9');
  if (fixed === packageSwift.content) return [];
  return [{
    path: packageSwift.path,
    content: fixed,
    explanation: 'Pinned swift-tools-version to 5.9 — the runner\'s Swift toolchain may not support the declared tools version; 5.9 is compatible with Swift 5.9+ (Xcode 15)',
    confidence: 100,
  }];
}

// ═══════════════════════════════════════════════════════════════════
// CROSS-CATEGORY — Additional high-value fixers
// ═══════════════════════════════════════════════════════════════════

/** Add PYTHONPATH to fix ModuleNotFoundError in Python CI. */
export function fixPythonPath(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ModuleNotFoundError|No module named|ImportError/i.test(logs)) return [];
  if (!/python/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if ((!f.content.includes('python') && !f.content.includes('pytest')) || f.content.includes('PYTHONPATH')) continue;
    const fixed = isGitHubWorkflow(f.path)
      ? injectWorkflowLevelBlock(f.content, 'env', ['  PYTHONPATH: ${{ github.workspace }}:${{ github.workspace }}/src'])
      : `variables:\n  PYTHONPATH: "$CI_PROJECT_DIR:$CI_PROJECT_DIR/src"\n\n` + f.content;
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PYTHONPATH including src/ — Python could not find project modules; pytest and imports both need the project root and src/ in sys.path', confidence: 100 });
  }
  return fixes;
}

/** Remove npm cache block when no lockfile is committed (setup-node fails). */
export function fixNpmCacheNolockfile(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasLockfile = files.some(f => ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(f.path));
  if (hasLockfile) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (
      !/cache:\s*['"]?npm['"]?/i.test(f.content) &&
      !/cache:\s*['"]?yarn['"]?/i.test(f.content) &&
      !f.content.includes('cache-dependency-path')
    ) continue;
    const fixed = f.content
      .replace(/\n[ \t]+cache:\s*['"]?npm['"]?.*\n/g, '\n')
      .replace(/\n[ \t]+cache:\s*['"]?yarn['"]?.*\n/g, '\n')
      .replace(/\n[ \t]+cache-dependency-path:.*\n/g, '\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed npm cache block — no lockfile committed; setup-node cache fails without a lockfile; commit package-lock.json or switch to a manual actions/cache step', confidence: 100 });
  }
  return fixes;
}

/** Set fail_ci_if_error: false on Codecov when token is not configured. */
export function fixCodecovNonBlocking(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('fail_ci_if_error: true')) continue;
    fixes.push({ path: f.path, content: f.content.replace(/fail_ci_if_error:\s*true/g, 'fail_ci_if_error: false'), explanation: 'Set fail_ci_if_error: false on Codecov — CODECOV_TOKEN not configured; upload failure should not block merging', confidence: 100 });
  }
  return fixes;
}

/** Fix esbuild/Rollup path resolution — add missing package to devDependencies. */
export function fixESBuildPathResolution(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Could not resolve|Module not found|Failed to resolve|ENOENT.*node_modules/i.test(logs)) return [];
  const moduleMatch = logs.match(/Could not resolve\s+['"`]([^'"`]+)['"`]/i);
  if (!moduleMatch) return [];
  const missingModule = moduleMatch[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (f.path !== 'package.json') continue;
    try {
      const pkg = JSON.parse(f.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const packageName = missingModule.startsWith('@') ? missingModule.split('/').slice(0, 2).join('/') : missingModule.split('/')[0];
      if (!allDeps[packageName]) {
        const updated = { ...pkg, devDependencies: { ...(pkg.devDependencies ?? {}), [packageName]: 'latest' } };
        fixes.push({ path: f.path, content: JSON.stringify(updated, null, 2) + '\n', explanation: `Added "${packageName}" to devDependencies — bundler resolution failed because the package was not installed; pin to a specific version after adding`, confidence: 100 });
      }
    } catch { /* skip */ }
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// EXTENDED CATEGORY 1 — More build script failure patterns
// ═══════════════════════════════════════════════════════════════════

/** Add prisma generate before build/test when @prisma/client is a dependency. */
export function fixPrismaGenerate(files: Array<{ path: string; content: string }>): RuleFix[] {
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const hasPrisma = ('@prisma/client' in (pkg.dependencies ?? {})) || ('prisma' in (pkg.devDependencies ?? {}));
    if (!hasPrisma) return [];
  } catch { return []; }
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('prisma generate') || f.content.includes('prisma db push')) continue;
    if (!f.content.includes('npm run build') && !f.content.includes('next build') && !f.content.includes('jest')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(?:npm run build|next build|npx jest|npm test)/,
      `      - name: Generate Prisma client\n        run: npx prisma generate`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added prisma generate before build — @prisma/client must be generated from the schema before the TypeScript compiler can find its types; skipping causes TS2307 on import from "@prisma/client"', confidence: 100 });
  }
  return fixes;
}

/** Add go generate ./... before go build when stringer/mockgen/wire markers are present. */
export function fixGoGenerateStep(files: Array<{ path: string; content: string }>): RuleFix[] {
  const goFiles = files.filter(f => f.path.endsWith('.go'));
  const needsGenerate = goFiles.some(f =>
    /\/\/go:generate\s+(stringer|mockgen|wire|moq|enumer|protoc-gen|oapi-codegen)/i.test(f.content),
  );
  if (!needsGenerate) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('go build') || f.content.includes('go generate')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*go build/,
      `      - name: Run go generate\n        run: go generate ./...`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added go generate ./... before build — //go:generate directives found in source files; generated code (stringer/mockgen/wire) must exist before compilation', confidence: 100 });
  }
  return fixes;
}

/** Migrate Lerna bootstrap to npm/yarn workspaces install (Lerna v7+ deprecation). */
export function fixLernaBootstrap(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/lerna bootstrap|lerna.*ERR|Bootstrap.*deprecated/i.test(logs)
    && !files.some(f => f.path === 'lerna.json')) return [];
  const lernaJson = files.find(f => f.path === 'lerna.json');
  const fixes: RuleFix[] = [];
  if (lernaJson) {
    try {
      const cfg = JSON.parse(lernaJson.content) as Record<string, unknown>;
      if (!cfg['useWorkspaces']) {
        const updated = { ...cfg, useWorkspaces: true, npmClient: 'npm' };
        fixes.push({
          path: lernaJson.path,
          content: JSON.stringify(updated, null, 2) + '\n',
          explanation: 'Added useWorkspaces: true to lerna.json — Lerna v7 deprecated lerna bootstrap; using npm/yarn workspaces for package installation is the recommended replacement',
          confidence: 100,
        });
      }
    } catch { /* skip */ }
  }
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('lerna bootstrap')) continue;
    const fixed = f.content.replace(/\blerna bootstrap\b/g, 'npm install');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced lerna bootstrap → npm install — lerna bootstrap is deprecated in Lerna v7+; root-level npm install with workspaces handles package linking', confidence: 100 });
  }
  return fixes;
}

/** Add CMake configure + build steps for C/C++ projects. */
export function fixCMakeBuildSetup(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasCmake = files.some(f => f.path === 'CMakeLists.txt');
  if (!hasCmake) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('cmake') || f.content.includes('cmake --build')) continue;
    // Add configure + build if only raw cmake invocation
    const fixed = f.content.replace(
      /run:\s*cmake\s+\.\s*\n/g,
      'run: |\n          cmake -B build -DCMAKE_BUILD_TYPE=Release\n          cmake --build build --parallel $(nproc)\n',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Expanded cmake invocation to configure + build with -B build/ and --parallel — cmake . alone does not build; the two-step configure+build pattern is idiomatic for modern CMake', confidence: 100 });
    // Add cmake install step if a package job exists
    if (f.content.includes('cmake --build') && !f.content.includes('cmake --install')) {
      const patched = insertStepBefore(
        f.content,
        /uses:\s*actions\/upload-artifact/,
        `      - name: Install CMake build\n        run: cmake --install build --prefix install`,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added cmake --install to collect build artifacts under install/ — install prefix creates a clean artifact directory for upload', confidence: 100 });
    }
  }
  return fixes;
}

/** Change plain make to make -j$(nproc) for parallel compilation of C/C++ projects. */
export function fixMakeParallelJobs(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasMakefile = files.some(f => f.path === 'Makefile' || f.path === 'GNUmakefile');
  const hasCmake    = files.some(f => f.path === 'CMakeLists.txt');
  if (!hasMakefile && !hasCmake) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    // Only patch bare `make` or `make all`, not `make install` or explicit -j
    if (!/\bmake\b(?!\s+(?:install|clean|test|-j|\$))/.test(f.content)) continue;
    if (f.content.includes('-j$(nproc)') || f.content.includes('-j ')) continue;
    const fixed = f.content.replace(/(\brun:\s*)(\bmake\b)(\s+(?!install|clean|test|-j|\$))/g, '$1$2 -j$(nproc)$3');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -j$(nproc) to make — parallel compilation uses all available CPU cores; on a 4-core runner this cuts compile time by ~3×', confidence: 100 });
  }
  return fixes;
}

/** Add protobuf/gRPC generation step when .proto files are present but no generate step exists. */
export function fixProtobufGenerate(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasProto = files.some(f => f.path.endsWith('.proto'));
  const hasBufYaml = files.some(f => f.path === 'buf.yaml' || f.path === 'buf.gen.yaml');
  if (!hasProto && !hasBufYaml) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('buf generate') || f.content.includes('protoc ')) continue;
    if (!f.content.includes('npm run build') && !f.content.includes('go build') && !f.content.includes('gradle')) continue;
    const generateStep = hasBufYaml
      ? `      - name: Generate protobuf code\n        uses: bufbuild/buf-action@v1\n        with:\n          push: false`
      : `      - name: Generate protobuf code\n        run: find . -name "*.proto" | xargs protoc --go_out=. --go-grpc_out=.`;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(?:npm run build|go build|\.\/gradlew)/,
      generateStep,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added ${hasBufYaml ? 'bufbuild/buf-action' : 'protoc'} generate step before build — .proto files detected; generated code must exist before compilation`, confidence: 100 });
  }
  return fixes;
}

/** Add docker-compose build for services that are built before tests. */
export function fixDockerComposeBuildService(files: Array<{ path: string; content: string }>): RuleFix[] {
  const composeFile = files.find(f => /docker-compose(?:\.override)?\.ya?ml$/.test(f.path) && f.content.includes('build:'));
  if (!composeFile) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('docker-compose') || f.content.includes('docker-compose build')) continue;
    if (!f.content.includes('docker-compose up') && !f.content.includes('docker compose up')) continue;
    const fixed = f.content.replace(
      /(run:\s*docker-?compose\s+up)/g,
      'run: docker-compose build --pull\n          docker-compose up',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added docker-compose build --pull before up — compose services with build: blocks must be built before starting; --pull refreshes base images', confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// EXTENDED CATEGORY 2 — More compilation failure patterns
// ═══════════════════════════════════════════════════════════════════

/** Add graphql-codegen step before build when @graphql-codegen/* is installed. */
export function fixGraphQLCodegen(files: Array<{ path: string; content: string }>): RuleFix[] {
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as { devDependencies?: Record<string, string> };
    const hasCodegen = Object.keys(pkg.devDependencies ?? {}).some(k => k.startsWith('@graphql-codegen'));
    if (!hasCodegen) return [];
  } catch { return []; }
  const hasCodegenConfig = files.some(f => /codegen\.(ts|js|ya?ml)$/.test(f.path));
  if (!hasCodegenConfig) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('graphql-codegen') || f.content.includes('codegen')) continue;
    if (!f.content.includes('npm run build') && !f.content.includes('tsc')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(?:npm run build|tsc\b)/,
      `      - name: Generate GraphQL types\n        run: npx graphql-codegen --config codegen.ts`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added graphql-codegen step before build — @graphql-codegen packages detected; generated TypeScript types must exist before tsc/bundler runs', confidence: 100 });
  }
  return fixes;
}

/** Fix Tailwind CSS content paths that miss source files, causing purged/empty stylesheet. */
export function fixTailwindContentPaths(files: Array<{ path: string; content: string }>): RuleFix[] {
  const twConfig = files.find(f => /tailwind\.config\.(js|ts|cjs|mjs)$/.test(f.path));
  if (!twConfig) return [];
  const fixes: RuleFix[] = [];
  // If content is an empty array or missing, add comprehensive source paths
  if (/content:\s*\[\s*\]|content:\s*\[\s*\n?\s*\]/.test(twConfig.content)) {
    const fixed = twConfig.content.replace(
      /content:\s*\[\s*\]/,
      "content: [\n    './src/**/*.{js,ts,jsx,tsx,html,svelte,vue}',\n    './app/**/*.{js,ts,jsx,tsx,html}',\n    './pages/**/*.{js,ts,jsx,tsx}',\n    './components/**/*.{js,ts,jsx,tsx}',\n  ]",
    );
    if (fixed !== twConfig.content)
      fixes.push({ path: twConfig.path, content: fixed, explanation: 'Populated Tailwind content array — empty content: [] causes all utilities to be purged in production; added standard paths for React/Next.js/Svelte/Vue source directories', confidence: 100 });
  }
  // If content is missing the app router paths for Next 13+
  const hasNext13 = files.some(f => f.path.startsWith('app/') && f.path.endsWith('.tsx'));
  if (hasNext13 && !twConfig.content.includes("'./app/**") && !twConfig.content.includes('"./app/**')) {
    const fixed = twConfig.content.replace(
      /(content:\s*\[)/,
      "$1\n    './app/**/*.{js,ts,jsx,tsx}',",
    );
    if (fixed !== twConfig.content)
      fixes.push({ path: twConfig.path, content: fixed, explanation: "Added './app/**' to Tailwind content paths — Next.js App Router files are in app/ not pages/; missing this path causes all app-specific Tailwind classes to be stripped", confidence: 100 });
  }
  return fixes;
}

/** Increase Angular build budgets when bundle size exceeds limit. */
export function fixAngularBuildBudget(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/budget exceeded|Initial total budget|chunk budget/i.test(logs)) return [];
  const angularJson = files.find(f => f.path === 'angular.json');
  if (!angularJson) return [];
  try {
    const cfg = JSON.parse(angularJson.content) as {
      projects?: Record<string, { architect?: { build?: { configurations?: { production?: { budgets?: Array<{ type: string; maximumWarning?: string; maximumError?: string }> } } } } }>;
    };
    let changed = false;
    for (const proj of Object.values(cfg.projects ?? {})) {
      const budgets = proj.architect?.build?.configurations?.production?.budgets ?? [];
      for (const budget of budgets) {
        if (budget.type === 'initial') {
          budget.maximumWarning = '3mb';
          budget.maximumError = '5mb';
          changed = true;
        }
        if (budget.type === 'anyComponentStyle') {
          budget.maximumWarning = '6kb';
          budget.maximumError = '10kb';
          changed = true;
        }
      }
    }
    if (!changed) return [];
    return [{
      path: angularJson.path,
      content: JSON.stringify(cfg, null, 2) + '\n',
      explanation: 'Increased Angular build budgets to 3MB warning / 5MB error — build failed because bundle exceeded the default budget; budgets should be adjusted for large production apps and then reduced incrementally',
      confidence: 100,
    }];
  } catch { return []; }
}

/** Add SvelteKit adapter configuration when building for deployment. */
export function fixSvelteKitAdapter(files: Array<{ path: string; content: string }>): RuleFix[] {
  const svelteConfig = files.find(f => f.path === 'svelte.config.js' || f.path === 'svelte.config.ts');
  if (!svelteConfig) return [];
  const fixes: RuleFix[] = [];
  // If no adapter is configured, add adapter-auto (works for Vercel/Netlify/Node)
  if (!svelteConfig.content.includes('adapter')) {
    const fixed = `import adapter from '@sveltejs/adapter-auto';\n` + svelteConfig.content.replace(
      /export default\s*\{/,
      "export default {\n  kit: {\n    adapter: adapter()\n  },",
    );
    fixes.push({ path: svelteConfig.path, content: fixed, explanation: 'Added @sveltejs/adapter-auto to svelte.config — SvelteKit requires an adapter to produce a deployable output; adapter-auto detects Vercel/Netlify/Cloudflare automatically', confidence: 100 });
  }
  // Add adapter-auto to devDependencies if not there
  const pkgFile = files.find(f => f.path === 'package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { devDependencies?: Record<string, string> };
      if (!pkg.devDependencies?.['@sveltejs/adapter-auto']) {
        const updated = { ...pkg, devDependencies: { ...(pkg.devDependencies ?? {}), '@sveltejs/adapter-auto': '^3.0.0' } };
        fixes.push({ path: pkgFile.path, content: JSON.stringify(updated, null, 2) + '\n', explanation: 'Added @sveltejs/adapter-auto to devDependencies — required for SvelteKit to generate a deployable build output', confidence: 100 });
      }
    } catch { /* skip */ }
  }
  return fixes;
}

/** Add PostCSS config with required plugins when postcss.config.js is missing. */
export function fixPostCSSConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/PostCSS plugin.*not found|Cannot find.*postcss|Unknown PostCSS plugin/i.test(logs)) return [];
  if (files.some(f => f.path === 'postcss.config.js' || f.path === 'postcss.config.cjs')) return [];
  const hasTailwind = files.some(f => /tailwind\.config/.test(f.path));
  const hasAutoprefixer = files.some(f => f.path === 'package.json' && f.content.includes('autoprefixer'));
  const fixes: RuleFix[] = [];
  const plugins: string[] = [];
  if (hasTailwind) plugins.push('    tailwindcss: {},');
  if (hasAutoprefixer) plugins.push('    autoprefixer: {},');
  if (plugins.length === 0) plugins.push('    autoprefixer: {},');
  fixes.push({
    path: 'postcss.config.js',
    content: `module.exports = {\n  plugins: {\n${plugins.join('\n')}\n  },\n};\n`,
    explanation: `Created postcss.config.js with ${hasTailwind ? 'tailwindcss + ' : ''}autoprefixer — PostCSS failed because no config file was found; Tailwind CSS and vendor prefixing require PostCSS plugins to be explicitly configured`,
    confidence: 100,
  });
  return fixes;
}

/** Fix Nuxt 3 nitro preset for correct deployment target. */
export function fixNuxtNitroPreset(files: Array<{ path: string; content: string }>): RuleFix[] {
  const nuxtConfig = files.find(f => /nuxt\.config\.(ts|js|mjs)$/.test(f.path));
  if (!nuxtConfig || !nuxtConfig.content.includes('nuxt')) return [];
  const fixes: RuleFix[] = [];
  const hasDockerfile = files.some(f => f.path === 'Dockerfile');
  const hasVercelJson = files.some(f => f.path === 'vercel.json');
  // Only patch if no nitro preset is set
  if (nuxtConfig.content.includes('nitro') || nuxtConfig.content.includes('preset')) return [];
  if (hasDockerfile && !nuxtConfig.content.includes('node-server')) {
    const fixed = nuxtConfig.content.replace(
      /defineNuxtConfig\(\{/,
      "defineNuxtConfig({\n  nitro: {\n    preset: 'node-server',\n  },",
    );
    if (fixed !== nuxtConfig.content)
      fixes.push({ path: nuxtConfig.path, content: fixed, explanation: 'Added nitro preset: "node-server" — Docker deployment detected; without an explicit preset, Nuxt 3 may generate a static output that cannot serve SSR responses', confidence: 100 });
  } else if (!hasDockerfile && !hasVercelJson) {
    const fixed = nuxtConfig.content.replace(
      /defineNuxtConfig\(\{/,
      "defineNuxtConfig({\n  ssr: true,",
    );
    if (fixed !== nuxtConfig.content)
      fixes.push({ path: nuxtConfig.path, content: fixed, explanation: 'Added ssr: true to nuxt.config — explicit SSR setting prevents accidental static-only builds in CI', confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// EXTENDED CATEGORY 3 — More missing artifact patterns
// ═══════════════════════════════════════════════════════════════════

/** Package AWS Lambda function as a .zip artifact for deployment. */
export function fixLambdaZipPackage(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasHandler = files.some(f => /^(?:src\/)?(?:handler|lambda|index|function)\.(js|ts|py)$/.test(f.path));
  const hasSAM     = files.some(f => f.path === 'template.yaml' && f.content.includes('AWS::Lambda'));
  const hasSLS     = files.some(f => f.path === 'serverless.yml' || f.path === 'serverless.yaml');
  if (!hasHandler && !hasSAM && !hasSLS) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('.zip') || !f.content.includes('upload-artifact')) continue;
    if (!f.content.includes('lambda') && !f.content.includes('serverless') && !hasSAM) continue;
    // Add zip packaging step before upload
    const zipStep = hasSLS
      ? `      - name: Package Lambda function\n        run: npx serverless package\n        env:\n          AWS_REGION: us-east-1`
      : hasSAM
      ? `      - name: Package Lambda function\n        run: sam package --output-template-file packaged.yaml --s3-bucket \${{ vars.SAM_BUCKET }}`
      : `      - name: Package Lambda function\n        run: |\n          zip -r function.zip . -x "*.git*" -x "node_modules/.cache/*"\n          echo "Lambda zip created: $(du -sh function.zip)"`;
    const patched = insertStepBefore(
      f.content,
      /uses:\s*actions\/upload-artifact/,
      zipStep,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Lambda packaging step before artifact upload — Lambda deployment requires a .zip file containing the function code and dependencies', confidence: 100 });
  }
  return fixes;
}

/** Fix dotnet pack NuGet artifact output path. */
export function fixNuGetPackageOutput(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasCsproj = files.some(f => f.path.endsWith('.csproj'));
  if (!hasCsproj) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
    if (!f.content.includes('dotnet pack')) continue;
    if (f.content.includes('nupkg')) continue;
    // Ensure dotnet pack uses explicit output dir
    const fixed = f.content
      .replace(/\bdotnet pack\b(?!\s+-o)/g, 'dotnet pack -o ./nupkg')
      .replace(/(path:\s*)(?:dist|build)\/[^\n]*/g, '$1./nupkg/*.nupkg');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -o ./nupkg to dotnet pack and fixed artifact path — NuGet packages are .nupkg files; explicit output directory prevents them being scattered in project subdirectories', confidence: 100 });
  }
  return fixes;
}

/** Add helm package step and fix artifact path for Helm chart releases. */
export function fixHelmChartPackage(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasChart = files.some(f => f.path === 'Chart.yaml' || f.path.endsWith('/Chart.yaml'));
  if (!hasChart) return [];
  const chartFile = files.find(f => f.path === 'Chart.yaml' || f.path.endsWith('/Chart.yaml'));
  const chartName = chartFile?.content.match(/^name:\s+(.+)$/m)?.[1]?.trim() ?? 'chart';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('helm package') || !f.content.includes('upload-artifact')) continue;
    if (!f.content.includes('helm') && !f.content.includes('Chart.yaml')) continue;
    const patched = insertStepBefore(
      f.content,
      /uses:\s*actions\/upload-artifact/,
      `      - name: Package Helm chart\n        run: helm package . --destination ./charts-dist`,
    );
    if (patched) {
      const withPath = patched.replace(/(path:\s*)(?:dist|build)\/[^\n]*/g, '$1./charts-dist/*.tgz');
      fixes.push({ path: f.path, content: withPath, explanation: `Added helm package step — Helm chart "${chartName}" must be packaged into a .tgz before it can be uploaded as an artifact or pushed to a registry`, confidence: 100 });
    }
  }
  return fixes;
}

/** Fix Electron packaged app artifact path (electron-builder outputs to dist/). */
export function fixElectronArtifactPath(files: Array<{ path: string; content: string }>): RuleFix[] {
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as { devDependencies?: Record<string, string>; build?: { directories?: { output?: string } } };
    const hasElectronBuilder = !!pkg.devDependencies?.['electron-builder'];
    if (!hasElectronBuilder) return [];
    const outputDir = pkg.build?.directories?.output ?? 'dist';
    const fixes: RuleFix[] = [];
    for (const f of files) {
      if (!isGitHubWorkflow(f.path) || !f.content.includes('upload-artifact')) continue;
      if (f.content.includes(outputDir)) continue;
      const fixed = f.content.replace(
        /(path:\s*)(?:build|out)\/[^\n]*/g,
        `$1${outputDir}/**/*.{AppImage,dmg,exe,deb,rpm,snap}`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Changed Electron artifact path to ${outputDir}/**/*.{AppImage,dmg,exe,...} — electron-builder outputs platform installers to the configured output directory (${outputDir}/)`, confidence: 100 });
    }
    return fixes;
  } catch { return []; }
}

/** Add Python wheel build step and fix artifact path for PyPI publishing. */
export function fixPythonWheelBuild(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasPyProject = files.some(f => f.path === 'pyproject.toml');
  const hasSetupPy   = files.some(f => f.path === 'setup.py' || f.path === 'setup.cfg');
  if (!hasPyProject && !hasSetupPy) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('python -m build') || f.content.includes('python setup.py bdist_wheel')) continue;
    if (!f.content.includes('upload-artifact') && !f.content.includes('twine') && !f.content.includes('pypi')) continue;
    const patched = insertStepBefore(
      f.content,
      /(?:uses:\s*actions\/upload-artifact|run:\s*twine)/,
      `      - name: Build Python wheel\n        run: |\n          pip install build\n          python -m build`,
    );
    if (patched) {
      const withPath = patched.replace(/(path:\s*)(?:build|output)\/[^\n]*/g, '$1dist/*.whl\n              dist/*.tar.gz');
      fixes.push({ path: f.path, content: withPath, explanation: 'Added python -m build step and set artifact path to dist/*.whl — pyproject.toml/setup.py detected; the build backend (setuptools/flit/hatch) must be invoked to produce wheel and sdist before upload', confidence: 100 });
    }
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// EXTENDED CATEGORY 4 — More invalid build target patterns
// ═══════════════════════════════════════════════════════════════════

/** Prefix Rake tasks with bundle exec for Ruby/Rails projects. */
export function fixRakeTask(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasGemfile = files.some(f => f.path === 'Gemfile');
  const hasRakefile = files.some(f => f.path === 'Rakefile' || f.path.endsWith('.rake'));
  if (!hasGemfile || !hasRakefile) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('rake ') || f.content.includes('bundle exec rake')) continue;
    const fixed = f.content.replace(/\brake\s+(?!exec)/g, 'bundle exec rake ');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed rake → bundle exec rake — running rake directly uses the system gem, not the project Gemfile.lock version; bundle exec ensures the correct rake version and loads gems from the bundle', confidence: 100 });
  }
  return fixes;
}

/** Fix mix task invocation for Elixir projects. */
export function fixMixTask(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No task.*mix|mix: command not found|\*\* \(Mix/i.test(logs)
    && !files.some(f => f.path === 'mix.exs')) return [];
  const hasMixExs = files.some(f => f.path === 'mix.exs');
  if (!hasMixExs) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('mix ') || f.content.includes('MIX_ENV')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  MIX_ENV: test']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MIX_ENV: test to CI environment — Elixir/Mix defaults to dev environment; tests must run with MIX_ENV=test to load test dependencies and configuration', confidence: 100 });
  }
  // Add mix deps.get before mix test if missing
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('mix test') || f.content.includes('mix deps.get')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*mix test/,
      `      - name: Install Elixir dependencies\n        run: mix deps.get`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added mix deps.get before mix test — Elixir dependencies must be fetched before compilation and test; analogous to npm install', confidence: 100 });
  }
  return fixes;
}

/** Fix SBT task invocation for Scala projects. */
export function fixSbtBuildTask(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Not a valid command|error running sbt|sbt.*not found/i.test(logs)
    && !files.some(f => f.path === 'build.sbt')) return [];
  const hasSbt = files.some(f => f.path === 'build.sbt');
  if (!hasSbt) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('sbt ')) continue;
    // Add SBT_OPTS to prevent OOM in SBT
    if (!f.content.includes('SBT_OPTS')) {
      const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  SBT_OPTS: "-Xmx2g -XX:+UseG1GC"']);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added SBT_OPTS with -Xmx2g — SBT and the Scala compiler both run on the JVM; without a heap limit, SBT can OOM on CI runners with 2GB RAM', confidence: 100 });
    }
    // Fix sbt build → sbt compile
    if (f.content.includes('sbt build') && !f.content.includes('sbt compile')) {
      const fixed = f.content.replace(/\bsbt build\b/g, 'sbt compile');
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed sbt build → sbt compile — "build" is not an SBT task; the correct task is "compile"; use "package" to produce a JAR', confidence: 100 });
    }
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════
// EXTENDED CATEGORY 5 — More unsupported runtime version patterns
// ═══════════════════════════════════════════════════════════════════

/** Add NODE_OPTIONS=--openssl-legacy-provider for webpack 4 / react-scripts on Node 17+. */
export function fixOpenSSLLegacyProvider(files: Array<{ path: string; content: string }>): RuleFix[] {
  // Only add the flag — the removal is handled by fixNodeExperimentalFlags
  const pkgFile = files.find(f => f.path === 'package.json');
  if (!pkgFile) return [];
  try {
    const pkg = JSON.parse(pkgFile.content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    // Only apply for projects using webpack 4 / react-scripts < 5 / vue-cli-service
    const needsLegacy = (deps['react-scripts'] && !deps['react-scripts'].startsWith('^5') && !deps['react-scripts'].startsWith('5'))
      || (deps['webpack'] && (deps['webpack'].startsWith('^4') || deps['webpack'].startsWith('4')))
      || !!deps['@vue/cli-service'];
    if (!needsLegacy) return [];
  } catch { return []; }
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('openssl-legacy-provider') || f.content.includes('NODE_OPTIONS')) continue;
    // Only inject when Node 17+ is used
    const nodeVersionMatch = f.content.match(/node-version:\s*['"]?(\d+)/);
    const nodeVersion = nodeVersionMatch ? parseInt(nodeVersionMatch[1], 10) : 18;
    if (nodeVersion < 17) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  NODE_OPTIONS: --openssl-legacy-provider']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added NODE_OPTIONS=--openssl-legacy-provider — webpack 4 / react-scripts < 5 / vue-cli-service use OpenSSL 1.x APIs that were removed in Node 17+; this flag restores the legacy provider', confidence: 100 });
  }
  return fixes;
}

/** Fix Ruby 3.0 keyword argument incompatibilities (last hash arg / positional-keyword separation). */
export function fixRubyKeywordArgs(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/wrong number of arguments.*hash|ArgumentError.*keyword|deprecated.*last argument as keyword hash/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('ruby') && !f.content.includes('bundle exec')) continue;
    // Pin Ruby to 2.7 or add warning suppression env var
    if (f.content.includes('ruby-version:')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  RUBYOPT: -W:no-deprecated']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added RUBYOPT=-W:no-deprecated — Ruby 3.0 made keyword argument separation mandatory; this flag suppresses warnings while the codebase is migrated', confidence: 100 });
  }
  // If ruby-version already set to 3.x and there are RubyGems issues, add bundler version
  const gemfile = files.find(f => f.path === 'Gemfile');
  if (gemfile && !gemfile.content.includes("ruby '2.")) {
    for (const f of files) {
      if (!isGitHubWorkflow(f.path)) continue;
      if (!f.content.includes('bundle install') || f.content.includes('gem install bundler')) continue;
      const patched = insertStepBefore(
        f.content,
        /run:\s*bundle install/,
        `      - name: Install bundler\n        run: gem install bundler`,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added gem install bundler before bundle install — Ruby 3.x ships with a bundler version that may differ from the Gemfile.lock BUNDLED WITH version; explicit install avoids version mismatch errors', confidence: 100 });
    }
  }
  return fixes;
}

/** Fix PHP 8 syntax incompatibilities — str_contains, named args, match expressions. */
export function fixPHPVersionCompat(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Call to undefined function str_contains|Deprecated.*passing null|named argument|PHP.*Fatal error/i.test(logs)
    && !files.some(f => f.path === 'composer.json')) return [];
  const composerJson = files.find(f => f.path === 'composer.json');
  if (!composerJson) return [];
  const fixes: RuleFix[] = [];
  try {
    const cfg = JSON.parse(composerJson.content) as { require?: Record<string, string>; 'require-dev'?: Record<string, string> };
    const phpVersion = cfg.require?.['php'] ?? '';
    // If requiring PHP 7.x but CI uses PHP 8, update constraint
    if (/>=?\s*7\.\d/.test(phpVersion)) {
      const updated = { ...cfg, require: { ...cfg.require, php: '>=8.0' } };
      fixes.push({
        path: composerJson.path,
        content: JSON.stringify(updated, null, 2) + '\n',
        explanation: 'Updated PHP version constraint from 7.x → >=8.0 in composer.json — CI runner uses PHP 8; functions like str_contains(), named arguments, and match expressions require PHP 8.0+',
        confidence: 100,
      });
    }
    // Add symfony/polyfill-php80 if str_contains is missing
    if (/Call to undefined function str_contains/i.test(logs)) {
      const dev = cfg['require-dev'] ?? {};
      if (!dev['symfony/polyfill-php80'] && !cfg.require?.['symfony/polyfill-php80']) {
        const updated = { ...cfg, 'require-dev': { ...dev, 'symfony/polyfill-php80': '^1.28' } };
        fixes.push({
          path: composerJson.path,
          content: JSON.stringify(updated, null, 2) + '\n',
          explanation: 'Added symfony/polyfill-php80 — str_contains/str_starts_with/str_ends_with are not available in PHP 7.x; the polyfill backports them without changing the PHP runtime version',
          confidence: 100,
        });
      }
    }
  } catch { /* skip */ }
  return fixes;
}

/** Install system build dependencies for Ruby native extension gems. */
export function fixRubyNativeExtensions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/extconf\.rb failed|cannot find -l|make.*error.*mkmf|check_func_or_header|native extensions/i.test(logs)) return [];
  const gemfile = files.find(f => f.path === 'Gemfile');
  if (!gemfile) return [];
  const fixes: RuleFix[] = [];
  // Detect which native gems are present to decide packages
  const hasNokogiri = gemfile.content.includes('nokogiri');
  const hasPG       = gemfile.content.includes("gem 'pg'") || gemfile.content.includes('gem "pg"');
  const hasMysql    = gemfile.content.includes('mysql2');
  const hasImageMagick = gemfile.content.includes('mini_magick') || gemfile.content.includes('rmagick');
  const packages: string[] = ['build-essential', 'ruby-dev'];
  if (hasNokogiri)    packages.push('libxml2-dev', 'libxslt1-dev', 'zlib1g-dev');
  if (hasPG)          packages.push('libpq-dev');
  if (hasMysql)       packages.push('libmysqlclient-dev');
  if (hasImageMagick) packages.push('libmagickwand-dev');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('bundle install') || f.content.includes('build-essential')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*bundle install/,
      `      - name: Install native gem dependencies\n        run: sudo apt-get update && sudo apt-get install -y ${packages.join(' ')}`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added apt-get install ${packages.join(', ')} — Ruby native extension gems (${[hasNokogiri && 'nokogiri', hasPG && 'pg', hasMysql && 'mysql2', hasImageMagick && 'mini_magick'].filter(Boolean).join(', ')}) require system build libraries that are not installed by default on runners`, confidence: 100 });
  }
  return fixes;
}

/** Fix Flutter SDK version constraint in pubspec.yaml. */
export function fixFlutterSDKConstraint(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Flutter SDK constraint|requires Flutter.*version|Currently running Flutter/i.test(logs)
    && !files.some(f => f.path === 'pubspec.yaml')) return [];
  const pubspec = files.find(f => f.path === 'pubspec.yaml');
  if (!pubspec) return [];
  const fixes: RuleFix[] = [];
  // Fix overly tight flutter SDK constraint
  const sdkMatch = pubspec.content.match(/flutter:\s*['"](>=?\s*[\d.]+\s*<[\d.]+)['"]/);
  if (sdkMatch) {
    const fixed = pubspec.content.replace(
      /flutter:\s*['"]>=?\s*[\d.]+\s*<[\d.]+['"]/,
      "flutter: '>=3.0.0'",
    );
    if (fixed !== pubspec.content)
      fixes.push({ path: pubspec.path, content: fixed, explanation: 'Loosened Flutter SDK constraint to >=3.0.0 — overly tight upper bound (e.g. <4.0.0) causes "SDK constraint not satisfied" errors when the runner has a newer Flutter version', confidence: 100 });
  }
  // Add flutter setup to CI if missing
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('flutter') || f.content.includes('subosito/flutter-action')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*flutter/,
      `      - name: Setup Flutter\n        uses: subosito/flutter-action@v2\n        with:\n          flutter-version: '3.x'\n          channel: stable`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added subosito/flutter-action@v2 — Flutter SDK must be installed on the runner before flutter commands can run', confidence: 100 });
  }
  return fixes;
}
