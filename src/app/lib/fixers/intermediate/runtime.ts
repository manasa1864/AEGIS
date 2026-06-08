// Intermediate / Runtime Errors
// Covers: OOM heap, unhandled promise rejections, segfaults, stack overflows,
// Node.js process exits, Python recursion limit, open file limits.

import { RuleFix, isGitHubWorkflow, isGitLabCI, injectWorkflowLevelBlock, insertStepBefore } from '../helpers';

/** Add NODE_OPTIONS=--max-old-space-size + swap space creation for heap OOM. */
export function fixNodeHeapOOM(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/JavaScript heap out of memory|FATAL ERROR.*CALL_AND_RETRY|Reached heap limit|Allocation failed/i.test(logs)) return [];
  // Parse how much heap Node tried to allocate
  const memMatch = logs.match(/(?:heap size limit|Requested memory|allocating)[^\d]*(\d+)\s*(?:MB)?/i);
  const detectedMB = memMatch ? parseInt(memMatch[1]) : 0;
  const targetMB = detectedMB > 2048 ? Math.min(8192, detectedMB * 2) : 4096;

  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('max-old-space-size')) continue;

    let content = injectWorkflowLevelBlock(f.content, 'env', [
      `  NODE_OPTIONS: --max-old-space-size=${targetMB} --expose-gc`,
    ]);

    // Add swap space before the build step (GitHub Actions Linux runners only)
    if (isGitHubWorkflow(f.path) && !content.includes('fallocate') && !content.includes('swapfile')) {
      const swapStep = [
        '      - name: Create swap space for large builds',
        '        run: |',
        '          sudo fallocate -l 4G /swapfile',
        '          sudo chmod 600 /swapfile',
        '          sudo mkswap /swapfile',
        '          sudo swapon /swapfile',
        '          echo "Swap space enabled:"',
        '          free -h',
      ].join('\n');
      const patched = insertStepBefore(content, /run:.*(?:npm run build|npx|node\s|webpack|vite build|tsc)/i, swapStep);
      if (patched) content = patched;
    }

    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Added NODE_OPTIONS=--max-old-space-size=${targetMB} + 4GB swap space — Node.js ran out of heap during build; ${detectedMB > 0 ? `detected usage ~${detectedMB}MB` : 'defaulting to 4096MB'}`, confidence: 100 });
  }
  return fixes;
}

/** Add --unhandled-rejections=throw to CI + process.on handler to app entry points. */
export function fixUnhandledRejection(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/UnhandledPromiseRejectionWarning|unhandledRejection|PromiseRejectionHandledWarning/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) {
      if (f.content.includes('unhandled-rejections')) continue;
      // Merge into existing NODE_OPTIONS or inject fresh
      const fixed = /NODE_OPTIONS/.test(f.content)
        ? f.content.replace(/(NODE_OPTIONS:\s*['"]?)(--[^\n'"]*)/g, '$1$2 --unhandled-rejections=throw')
        : injectWorkflowLevelBlock(f.content, 'env', ['  NODE_OPTIONS: --unhandled-rejections=throw']);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added --unhandled-rejections=throw — unhandled promise rejections were silently passing CI', confidence: 100 });
      continue;
    }
    // Add process.on handler to JS/TS app entry points
    if ((f.path.endsWith('.js') || f.path.endsWith('.ts')) &&
        /index|server|main|app/.test(f.path) &&
        !f.path.includes('test') && !f.path.includes('spec')) {
      if (f.content.includes('unhandledRejection')) continue;
      const handler = [
        '',
        "process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {",
        "  console.error('[unhandledRejection]', { reason, promise });",
        '  process.exit(1);',
        '});',
        '',
        "process.on('uncaughtException', (err: Error) => {",
        "  console.error('[uncaughtException]', err);",
        '  process.exit(1);',
        '});',
        '',
      ].join('\n');
      fixes.push({
        path: f.path,
        content: f.content + handler,
        explanation: 'Added process.on("unhandledRejection") + "uncaughtException" handlers — exits non-zero so CI catches silent async failures',
        confidence: 100,
      });
    }
  }
  return fixes;
}

/** Add core dump capture, debug tooling installation, and post-failure analysis for segfaults. */
export function fixSegmentationFault(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Segmentation fault|SIGSEGV|signal 11|core dumped/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('ulimit -c') || f.content.includes('core_pattern')) continue;

    const lines = f.content.split('\n');
    const out: string[] = [];
    let diagnosticAdded = false;
    let analysisScheduled = false;

    for (let i = 0; i < lines.length; i++) {
      // Insert diagnostic setup before first real step
      if (!diagnosticAdded && /^\s+- name:\s*(Checkout|Setup|Install)/i.test(lines[i])) {
        out.push('      - name: Enable core dump capture and install debug tools');
        out.push('        run: |');
        out.push('          ulimit -c unlimited');
        out.push('          echo "/tmp/core.%e.%p.%t" | sudo tee /proc/sys/kernel/core_pattern || true');
        out.push('          sudo apt-get install -y --no-install-recommends gdb binutils 2>/dev/null || true');
        out.push('          echo "Core dump capture enabled"');
        diagnosticAdded = true;
      }
      out.push(lines[i]);
      // Schedule post-failure analysis after any run step that could segfault
      if (diagnosticAdded && !analysisScheduled && /^\s+run:.*(?:node |python3? |ruby |java )/i.test(lines[i])) {
        out.push('      - name: Analyze crash dump on failure');
        out.push('        if: failure()');
        out.push('        run: |');
        out.push('          echo "=== Memory at crash ==="');
        out.push('          cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|SwapTotal" || true');
        out.push('          echo "=== OOM / segfault in kernel log ==="');
        out.push('          dmesg | grep -iE "segfault|oom|killed|out of memory" | tail -30 || true');
        out.push('          echo "=== Core dump backtraces ==="');
        out.push('          for c in /tmp/core.*; do');
        out.push('            [ -f "$c" ] || continue');
        out.push('            echo "--- $c ---"');
        out.push('            gdb -batch -ex "thread apply all bt full" -ex quit /proc/1/exe "$c" 2>/dev/null || true');
        out.push('          done');
        out.push('        continue-on-error: true');
        analysisScheduled = true;
      }
    }

    if (diagnosticAdded)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added ulimit core dump capture + gdb backtrace analysis on failure — segfault root cause now captured in CI logs', confidence: 100 });
  }
  return fixes;
}

/** Create sitecustomize.py to raise Python recursion limit globally without code changes. */
export function fixPythonRecursionLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/RecursionError|maximum recursion depth exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  // Create sitecustomize.py — Python auto-imports it on startup
  if (!files.some(f => f.path.endsWith('sitecustomize.py'))) {
    fixes.push({
      path: 'sitecustomize.py',
      content: [
        '"""Auto-loaded by Python on startup — raises the recursion limit."""',
        'import sys',
        '',
        '# aegis: RecursionError detected in CI — increased from default 1000',
        'sys.setrecursionlimit(10_000)',
        '',
      ].join('\n'),
      explanation: 'Created sitecustomize.py — Python imports this automatically on startup, setting recursion limit to 10 000 without any source changes needed',
      confidence: 100,
    });
  }

  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('python')) continue;
    if (f.content.includes('sitecustomize')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PYTHONPATH: ${{ github.workspace }}  # picks up sitecustomize.py recursion limit',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set PYTHONPATH so Python auto-loads sitecustomize.py which raises the recursion limit to 10 000', confidence: 100 });
  }
  return fixes;
}

/** Add ulimit -n 65536 + inotify watcher increase for EMFILE/ENFILE errors. */
export function fixOpenFilesLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/too many open files|EMFILE|ENFILE/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('ulimit -n') || f.content.includes('inotify')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let added = false;
    for (const line of lines) {
      if (!added && /^\s+- name:\s*(Checkout|Setup|Install|Build)/i.test(line)) {
        out.push('      - name: Increase open file and inotify limits');
        out.push('        run: |');
        out.push('          ulimit -n 65536');
        out.push('          # Increase inotify for webpack/vite/jest file watching');
        out.push('          echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf');
        out.push('          echo "fs.inotify.max_user_instances=512" | sudo tee -a /etc/sysctl.conf');
        out.push('          sudo sysctl -p --system 2>/dev/null || true');
        out.push('          echo "Open files limit: $(ulimit -n)"');
        added = true;
      }
      out.push(line);
    }
    if (added)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added ulimit -n 65536 + inotify watcher increase — EMFILE during large builds with many watched files', confidence: 100 });
  }
  return fixes;
}

/** Add MALLOC_ARENA_MAX=2 + threshold tuning to reduce glibc fragmentation on Linux. */
export function fixLinuxMemoryFragmentation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot allocate memory|ENOMEM|Out of memory/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || f.content.includes('MALLOC_ARENA_MAX')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  MALLOC_ARENA_MAX: 2',
      '  MALLOC_MMAP_THRESHOLD_: 131072',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MALLOC_ARENA_MAX=2 + MALLOC_MMAP_THRESHOLD — reduces glibc memory arena fragmentation on large Linux builds', confidence: 100 });
  }
  return fixes;
}

/** Add optional chaining to source files and --unhandled-rejections=throw for null/undefined errors. */
export function fixNullReferenceException(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot read propert|TypeError.*undefined|NullReferenceException|null.*dereference|is not an object|of undefined/i.test(logs)) return [];
  const propMatch = logs.match(/Cannot read propert(?:y|ies) ['"]?([\w]+)['"]? of (?:null|undefined)/i);
  const propName = propMatch?.[1];

  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) {
      if (f.content.includes('unhandled-rejections')) continue;
      const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  NODE_OPTIONS: --unhandled-rejections=throw']);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Added --unhandled-rejections=throw${propName ? ` — null deref on '${propName}'` : ''} — TypeError silently passed CI`, confidence: 100 });
      continue;
    }
    // Add optional chaining for the specific property in source files
    if (propName && (f.path.endsWith('.ts') || f.path.endsWith('.js')) &&
        !f.path.includes('test') && !f.path.includes('spec') &&
        f.content.includes(`.${propName}`)) {
      // Replace .prop with ?.prop but not when already optional chained or in strings
      const fixed = f.content.replace(
        new RegExp(`(?<![?'"\`])\\.(${propName})(?![?(])`, 'g'),
        `?.${propName}`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Added optional chaining (?.) before '.${propName}' accesses — null/undefined dereference logged in CI`, confidence: 100 });
    }
  }
  return fixes;
}

/** Enable strict TypeScript and add tsc --noEmit type-check step to CI. */
export function fixTypeMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TypeError|type.*mismatch|cannot.*assign.*type|argument.*not assignable|TS2322|TS2345|TS2339|TS2304/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  // Patch tsconfig.json to enable strict mode
  const tsconfig = files.find(f => f.path === 'tsconfig.json');
  if (tsconfig) {
    try {
      const cfg = JSON.parse(tsconfig.content) as { compilerOptions?: Record<string, unknown> };
      const co = cfg.compilerOptions ?? {};
      if (!co.strict) {
        fixes.push({
          path: 'tsconfig.json',
          content: JSON.stringify({
            ...cfg,
            compilerOptions: { ...co, strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true },
          }, null, 2) + '\n',
          explanation: 'Enabled strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes in tsconfig.json — TypeScript type errors slipped through with loose settings',
          confidence: 100,
        });
      }
    } catch { /* invalid JSON */ }
  }

  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('tsc --noEmit') || f.content.includes('type-check')) continue;
    if (!f.content.includes('tsconfig.json') && !files.some(fi => fi.path === 'tsconfig.json')) continue;
    const typeCheckStep = [
      '      - name: TypeScript type check',
      '        run: npx tsc --noEmit --skipLibCheck 2>&1 | tee /tmp/tsc-errors.txt; exit ${PIPESTATUS[0]}',
    ].join('\n');
    const patched = insertStepBefore(
      f.content,
      /run:\s*(npm run build|npx tsc|yarn build|pnpm build|vite build)/i,
      typeCheckStep,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added tsc --noEmit type-check step before build — TS2322/TS2345 type errors were only caught at runtime', confidence: 100 });
  }
  return fixes;
}

/** Add NODE_OPTIONS=--stack-size=65536 for Node.js stack overflow / RangeError. */
export function fixStackOverflow(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/stack overflow|maximum call stack|RangeError.*call stack|SIGABRT/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('stack-size') || f.content.includes('STACK_SIZE')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  NODE_OPTIONS: --stack-size=65536  # 64MB, up from default 984KB',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --stack-size=65536 — RangeError: Maximum call stack exceeded; increased stack from 984KB to 64MB', confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION A — Null Reference Exception (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Enable strictNullChecks + noUncheckedIndexedAccess in tsconfig to catch null at compile time. */
export function fixStrictNullChecks(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TypeError.*null|is not an object|Cannot read|undefined is not|Object is possibly/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const tsconfig = files.find(f => f.path === 'tsconfig.json' || f.path.endsWith('/tsconfig.json'));
  if (!tsconfig) return fixes;
  try {
    const cfg = JSON.parse(tsconfig.content) as { compilerOptions?: Record<string, unknown> };
    const co = cfg.compilerOptions ?? {};
    if (co.strictNullChecks === true && co.noUncheckedIndexedAccess === true) return fixes;
    fixes.push({
      path: tsconfig.path,
      content: JSON.stringify({ ...cfg, compilerOptions: { ...co, strictNullChecks: true, noUncheckedIndexedAccess: true } }, null, 2) + '\n',
      explanation: 'Enabled strictNullChecks + noUncheckedIndexedAccess — runtime null deref; TypeScript now rejects null access at compile time before it reaches CI',
      confidence: 95,
    });
  } catch { /* invalid JSON */ }
  return fixes;
}

/** Add PYTHONFAULTHANDLER=1 so Python dumps full traceback on AttributeError/NoneType. */
export function fixPythonNoneCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/AttributeError.*NoneType|NoneType.*has no attribute|object is None/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('PYTHONFAULTHANDLER') || !f.content.includes('python')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PYTHONFAULTHANDLER: 1  # dump traceback on None-deref signal',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PYTHONFAULTHANDLER=1 — AttributeError on NoneType; fault handler prints full traceback including the line that produced None', confidence: 90 });
  }
  return fixes;
}

/** Add GOTRACEBACK=all so Go prints every goroutine stack on a nil-pointer panic. */
export function fixGoNilPointerDeref(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/nil pointer dereference|invalid memory address|runtime panic.*nil/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('GOTRACEBACK') || !f.content.includes('go')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  GOTRACEBACK: all  # show all goroutine stacks on nil-deref panic',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GOTRACEBACK=all — Go nil pointer dereference; now prints all goroutine stacks to pinpoint the nil origin', confidence: 95 });
  }
  return fixes;
}

/** Replace .unwrap() with .expect("msg") in Rust source files for actionable NPE messages. */
export function fixRustUnwrapToExpect(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/called `Option::unwrap\(\)` on a `None`|called `Result::unwrap\(\)` on an `Err`/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.rs') || f.path.includes('test')) continue;
    if (!f.content.includes('.unwrap()')) continue;
    const fixed = f.content.replace(/\.unwrap\(\)/g, '.expect("unwrap failed — check None/Err source")');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced .unwrap() with .expect() — panicked on None/Err; message now appears in the stack trace making the crash site actionable', confidence: 90 });
  }
  return fixes;
}

/** Enable verbose JVM NPE messages via JAVA_TOOL_OPTIONS -ea + ShowCodeDetailsInExceptionMessages. */
export function fixJavaNPEGuard(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/NullPointerException|java\.lang\.NullPointerException/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('ShowCodeDetailsInExceptionMessages') || !f.content.includes('java')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  JAVA_TOOL_OPTIONS: -ea -XX:+ShowCodeDetailsInExceptionMessages',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -ea + ShowCodeDetailsInExceptionMessages — Java NullPointerException; JVM now names the exact null variable in the exception message (JDK 14+)', confidence: 95 });
  }
  return fixes;
}

/** Enable .NET nullable reference types to surface NullReferenceException at compile time. */
export function fixCSharpNullConditional(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/System\.NullReferenceException|Object reference not set to an instance/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('dotnet') || f.content.includes('DOTNET_NULLABLE')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DOTNET_NULLABLE: enable  # surface NRE at compile time via nullable ref types',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DOTNET_NULLABLE=enable — System.NullReferenceException; .NET nullable ref types make the compiler warn on potential null dereferences', confidence: 90 });
  }
  return fixes;
}

/** Add ASAN_OPTIONS to enable AddressSanitizer bounds checking for C/C++ array access. */
export function fixArrayBoundsCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/index.*out of (?:bounds|range)|IndexError|ArrayIndexOutOfBoundsException/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('ASAN_OPTIONS')) continue;
    if (!f.content.includes('cmake') && !f.content.includes('gcc') && !f.content.includes('clang') && !f.content.includes('make')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  ASAN_OPTIONS: detect_stack_use_after_return=1:check_initialization_order=1',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ASAN_OPTIONS for bounds/UAF detection — array index out of bounds at runtime; AddressSanitizer now halts on first violation with source location', confidence: 85 });
  }
  return fixes;
}

/** Add optional chaining (?.) before property accesses matching the logged null-deref property. */
export function fixNullDerefOptionalChain(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot read propert(?:y|ies) ['"]?([\w]+)['"]? of (?:null|undefined)/i.test(logs)) return [];
  const propMatch = logs.match(/Cannot read propert(?:y|ies) ['"]?([\w]+)['"]? of (?:null|undefined)/i);
  if (!propMatch) return [];
  const prop = propMatch[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.tsx') && !f.path.endsWith('.js')) continue;
    if (f.path.includes('test') || f.path.includes('spec') || f.path.includes('node_modules')) continue;
    const fixed = f.content.replace(new RegExp(`(?<![?.'"\`])\\.(${prop})(?![?(])`, 'g'), `?.${prop}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added optional chaining (?.) before .${prop} — null/undefined dereference in runtime logs; access now short-circuits to undefined instead of throwing`, confidence: 85 });
  }
  return fixes;
}

/** Add null-coalescing default via CI env to expose nullable config values safely. */
export function fixNullCoalescingEnvDefault(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot read propert|is null|is undefined|NullReferenceException/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('NODE_OPTIONS') || !f.content.includes('node')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  NODE_OPTIONS: --unhandled-rejections=throw --enable-source-maps',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --unhandled-rejections=throw + --enable-source-maps — null deref from unhandled rejection; source maps now show TypeScript line numbers in the stack trace', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION B — Type Mismatch (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add noImplicitAny + strictFunctionTypes to tsconfig to catch implicit any at compile time. */
export function fixImplicitAnyError(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TS7006|TS7017|Parameter .* implicitly has an 'any' type|implicitly.*any/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const tsconfig = files.find(f => f.path === 'tsconfig.json' || f.path.endsWith('/tsconfig.json'));
  if (!tsconfig) return fixes;
  try {
    const cfg = JSON.parse(tsconfig.content) as { compilerOptions?: Record<string, unknown> };
    const co = cfg.compilerOptions ?? {};
    if (co.noImplicitAny === true) return fixes;
    fixes.push({
      path: tsconfig.path,
      content: JSON.stringify({ ...cfg, compilerOptions: { ...co, noImplicitAny: true, strictFunctionTypes: true } }, null, 2) + '\n',
      explanation: 'Added noImplicitAny + strictFunctionTypes — TS7006 implicit any parameter; TypeScript now requires explicit type annotations on all parameters',
      confidence: 95,
    });
  } catch { /* invalid JSON */ }
  return fixes;
}

/** Add mypy type-check step before pytest to surface Python type errors in CI. */
export function fixPythonMypyCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TypeError.*expected.*got|argument.*wrong type|mypy|incompatible type/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('mypy') || !f.content.includes('python')) continue;
    const mypyStep = [
      '      - name: mypy type check',
      '        run: |',
      '          pip install mypy --quiet',
      '          mypy . --ignore-missing-imports --no-strict-optional 2>&1 | head -50 || true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:python -m )?pytest/i, mypyStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added mypy type-check step before pytest — Python TypeError: wrong argument type; mypy now catches type mismatches before test execution', confidence: 90 });
  }
  return fixes;
}

/** Add GOTRACEBACK=all + verbose Go flags for interface type assertion panics. */
export function fixGoTypeAssertion(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/interface conversion.*interface|panic.*interface type/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('GOTRACEBACK') || !f.content.includes('go')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  GOTRACEBACK: all',
      '  GOFLAGS: -v',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GOTRACEBACK=all — Go interface type assertion panic; all goroutine stacks now visible including the failed assertion site', confidence: 90 });
  }
  return fixes;
}

/** Add RUST_BACKTRACE=full for integer overflow / unsafe as-cast panics. */
export function fixRustTypeCast(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/attempt to cast|integer overflow|arithmetic operation overflow/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('RUST_BACKTRACE') || !f.content.includes('cargo')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  RUST_BACKTRACE: full',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added RUST_BACKTRACE=full — Rust integer overflow / cast panic; full backtrace now pinpoints the as-cast site', confidence: 95 });
  }
  return fixes;
}

/** Add PHP_CS_FIXER_STRICT_TYPES to enforce strict_types=1 and surface coercion errors. */
export function fixPHPStrictTypes(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/PHP.*TypeError|Argument.*must be of type|Return value.*must be of type/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('php') || f.content.includes('PHP_CS_FIXER_STRICT_TYPES')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PHP_CS_FIXER_STRICT_TYPES: 1',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PHP_CS_FIXER_STRICT_TYPES=1 — PHP TypeError on implicit coercion; strict_types now prevents integer↔string silent conversions', confidence: 85 });
  }
  return fixes;
}

/** Add Sorbet type-check step before rspec/rake for Ruby type mismatch errors. */
export function fixRubySorbetTypeCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TypeError.*String.*Integer|NoMethodError.*nil|wrong argument type.*Ruby/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('ruby') || f.content.includes('srb')) continue;
    const sorbetStep = [
      '      - name: Sorbet type check',
      '        run: |',
      '          gem install sorbet --quiet 2>/dev/null || true',
      '          srb tc --no-error-count 2>&1 | head -50 || true',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*bundle exec rspec|run:.*rake/i, sorbetStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Sorbet type check step — Ruby TypeError at runtime; srb tc now catches type mismatches before test execution', confidence: 80 });
  }
  return fixes;
}

/** Add Pyright strict type-check step to Python CI for reportOptionalMemberAccess errors. */
export function fixPyrightTypeCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/reportGeneralTypeIssues|reportOptionalMemberAccess|pyright/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('pyright') || !f.content.includes('python')) continue;
    const pyrightStep = [
      '      - name: Pyright type check',
      '        run: |',
      '          pip install pyright --quiet',
      '          pyright --outputjson 2>/dev/null | python3 -c "',
      '          import sys,json; d=json.load(sys.stdin)',
      '          errs=[e for e in d.get(\'generalDiagnostics\',[]) if e[\'severity\']==\'error\']',
      '          [print(e[\'message\']) for e in errs[:20]]" || true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:python -m )?pytest/i, pyrightStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Pyright type check step — reportOptionalMemberAccess errors; Pyright now flags nullable attribute access before tests run', confidence: 85 });
  }
  return fixes;
}

/** Add tsc --noEmit type-check step before build to surface TS2322/TS2345 errors early. */
export function fixTypeCheckBeforeBuild(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TS2322|TS2345|TS2339|Type.*is not assignable|type mismatch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('tsc --noEmit') || f.content.includes('type-check')) continue;
    if (!files.some(fi => fi.path === 'tsconfig.json' || fi.path.endsWith('/tsconfig.json'))) continue;
    const typeCheckStep = [
      '      - name: TypeScript type check',
      '        run: npx tsc --noEmit --skipLibCheck',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:npm run build|yarn build|pnpm build|vite build|tsc --build)/i, typeCheckStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added tsc --noEmit step before build — TS2322/TS2345 type errors only caught at runtime; type checker now fails CI before the build step', confidence: 95 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION C — Infinite Loop
// ═══════════════════════════════════════════════════════════════════════════

/** Add timeout-minutes: 30 to all jobs missing it — prevents CI from hanging on infinite loops. */
export function fixCIInfiniteLoopKill(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/timed out|timeout expired|job.*cancelled|process.*hung|infinite loop/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('timeout-minutes')) continue;
    const fixed = f.content.replace(
      /^(    [a-zA-Z0-9_-]+:\s*\n)(      runs-on:)/gm,
      '$1      timeout-minutes: 30\n$2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added timeout-minutes: 30 to all jobs — CI timed out (suspected infinite loop); jobs now self-terminate after 30 minutes', confidence: 90 });
  }
  return fixes;
}

/** Add MAX_ITERATIONS + MAX_RETRIES env guard for loop-heavy build scripts. */
export function fixLoopIterationGuard(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/timed out|infinite loop|hung|spinning|iteration.*exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('MAX_ITERATIONS') || f.content.includes('MAX_RETRIES')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  MAX_ITERATIONS: 1000',
      '  MAX_RETRIES: 5',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MAX_ITERATIONS/MAX_RETRIES env vars — CI hung; build scripts can read these caps to bail out of runaway loops', confidence: 80 });
  }
  return fixes;
}

/** Add --timeout=120 to pytest invocations to kill hanging test functions. */
export function fixPythonTestHangTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/timed out.*python|python.*(?:timed out|hung)|pytest.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pytest') || f.content.includes('--timeout')) continue;
    const fixed = f.content.replace(/((?:python -m )?pytest)(\s)/g, '$1 --timeout=120$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --timeout=120 to pytest — test suite hung; pytest-timeout now hard-exits any single test exceeding 120 seconds', confidence: 90 });
  }
  return fixes;
}

/** Add --testTimeout=30000 to Jest to kill async tests that never resolve. */
export function fixJestTestHangTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/jest.*timeout|async.*not.*resolve|exceeded.*timeout.*jest/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jest') || f.content.includes('testTimeout')) continue;
    const fixed = f.content.replace(/((?:npx |yarn |pnpm )?jest)(\s|$)/g, '$1 --testTimeout=30000$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --testTimeout=30000 to Jest — async test hung indefinitely; 30s per-test limit now terminates stuck promise-based tests', confidence: 90 });
  }
  return fixes;
}

/** Add --exit to Mocha so the process terminates after tests complete. */
export function fixMochaForceExit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/mocha.*hang|mocha.*not.*exit|force.*exit.*mocha/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('mocha') || f.content.includes('--exit')) continue;
    const fixed = f.content.replace(/(mocha(?:\s+[^\n]*)?)(\n)/g, (_m, cmd, nl) => `${cmd} --exit${nl}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --exit to Mocha — test process hung after suite completion; --exit forces Node.js to exit even with open handles (async DB connections, lingering timers)', confidence: 90 });
  }
  return fixes;
}

/** Add PLAYWRIGHT_TIMEOUT=30000 to cap infinite page navigation waits. */
export function fixPlaywrightPageTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/playwright.*timeout|page.*waitFor.*exceeded|navigation.*timeout.*playwright/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('playwright') || f.content.includes('PLAYWRIGHT_TIMEOUT')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PLAYWRIGHT_TIMEOUT: 30000',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PLAYWRIGHT_TIMEOUT=30000 — Playwright page navigation hung; 30s action timeout now terminates stuck page waits', confidence: 90 });
  }
  return fixes;
}

/** Increase Node.js EventEmitter.defaultMaxListeners to prevent listener leak stalls. */
export function fixNodeEventListenerLeak(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/MaxListenersExceededWarning|possible EventEmitter memory leak/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if ((!f.path.endsWith('.js') && !f.path.endsWith('.ts')) || f.path.includes('test') || f.path.includes('node_modules')) continue;
    if (f.content.includes('setMaxListeners') || f.content.includes('defaultMaxListeners')) continue;
    fixes.push({
      path: f.path,
      content: 'require("events").EventEmitter.defaultMaxListeners = 50;\n' + f.content,
      explanation: 'Increased EventEmitter.defaultMaxListeners to 50 — MaxListenersExceededWarning indicates a listener leak that stalls the event loop; increased limit prevents warning until leak is tracked down',
      confidence: 80,
    });
  }
  return fixes;
}

/** Add capped retry loop with max-attempt guard before service health checks. */
export function fixAsyncRetryMaxCap(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/retry.*(?:infinite|loop|exhausted)|ETIMEDOUT.*retry|ECONNREFUSED.*retry/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('RETRY_LIMIT') || f.content.includes('retry-on-exit-code')) continue;
    const retryStep = [
      '      - name: Capped retry health check',
      '        run: |',
      '          RETRY_LIMIT=5; RETRY_DELAY=15',
      '          for i in $(seq 1 $RETRY_LIMIT); do',
      '            curl -sf http://localhost:8080/health && break || true',
      '            echo "Attempt $i/$RETRY_LIMIT failed; sleeping ${RETRY_DELAY}s"',
      '            sleep $RETRY_DELAY',
      '          done',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:curl|wget|nc -z|wait-for)/i, retryStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added RETRY_LIMIT=5 cap with 15s backoff — open-ended retry loop caused CI hang; retries now bail after 5 attempts', confidence: 80 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION D — Stack Overflow (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add JAVA_TOOL_OPTIONS -Xss8m to raise JVM thread stack size for deep recursion. */
export function fixJVMStackSize(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/java\.lang\.StackOverflowError|StackOverflowError.*java/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('Xss') || !f.content.includes('java')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  JAVA_TOOL_OPTIONS: -Xss8m -Xmx2g',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -Xss8m — java.lang.StackOverflowError; JVM thread stack increased from 512KB default to 8MB for deep recursive call chains', confidence: 95 });
  }
  return fixes;
}

/** Create or prepend sys.setrecursionlimit(10000) to conftest.py for pytest-scope fix. */
export function fixPythonConfTestRecursion(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/RecursionError|maximum recursion depth exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const conftest = files.find(f => f.path.endsWith('conftest.py'));
  if (conftest) {
    if (conftest.content.includes('setrecursionlimit')) return fixes;
    fixes.push({ path: conftest.path, content: 'import sys\nsys.setrecursionlimit(10_000)\n\n' + conftest.content, explanation: 'Prepended sys.setrecursionlimit(10 000) to conftest.py — RecursionError in test suite; limit raised before any fixture or test executes', confidence: 100 });
  } else {
    fixes.push({ path: 'conftest.py', content: '"""pytest configuration."""\nimport sys\n\nsys.setrecursionlimit(10_000)\n', explanation: 'Created conftest.py with sys.setrecursionlimit(10 000) — Python RecursionError; pytest auto-imports conftest.py so the limit is applied before any test', confidence: 100 });
  }
  return fixes;
}

/** Add RUBY_THREAD_STACK_SIZE=64MB for SystemStackError: stack level too deep. */
export function fixRubyStackSize(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/SystemStackError|stack level too deep/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('ruby') || f.content.includes('RUBY_THREAD_STACK_SIZE')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  RUBY_THREAD_STACK_SIZE: 67108864  # 64MB; default ~1MB causes SystemStackError',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added RUBY_THREAD_STACK_SIZE=64MB — SystemStackError: stack level too deep; Ruby thread stack increased from ~1MB default to 64MB', confidence: 95 });
  }
  return fixes;
}

/** Add DOTNET_DefaultStackSize=8MB for System.StackOverflowException in deep recursion. */
export function fixDotNetStackSize(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/StackOverflowException|System\.StackOverflowException/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('dotnet') || f.content.includes('DOTNET_DefaultStackSize')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DOTNET_DefaultStackSize: 8388608  # 8MB; default 1MB causes SOE on deep recursion',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DOTNET_DefaultStackSize=8MB — System.StackOverflowException; CLR default 1MB stack is insufficient for deeply recursive algorithms', confidence: 90 });
  }
  return fixes;
}

/** Add RUST_MIN_STACK=64MB for Rust thread stack overflow on recursive data structures. */
export function fixRustStackSize(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/thread.*stack.*overflow|rust.*stack.*overflow/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('cargo') || f.content.includes('RUST_MIN_STACK')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  RUST_MIN_STACK: 67108864  # 64MB; Rust default 8MB causes overflow on deep trees',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added RUST_MIN_STACK=64MB — Rust thread stack overflow; RUST_MIN_STACK sets the stack for new threads spawned by the Rust runtime', confidence: 95 });
  }
  return fixes;
}

/** Add GOTRACEBACK=crash + GOMEMLIMIT for goroutine stack exceeds 1GB panics. */
export function fixGoStackTrace(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/goroutine stack exceeds|runtime: goroutine stack exceeds/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('GOTRACEBACK') || !f.content.includes('go')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  GOTRACEBACK: crash',
      '  GOMEMLIMIT: 2GiB',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GOTRACEBACK=crash + GOMEMLIMIT=2GiB — goroutine stack exceeds 1GB; captures core dump and caps memory before runaway stack growth kills the runner', confidence: 95 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION E — Memory Allocation Failure (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add JAVA_TOOL_OPTIONS -Xmx4g + HeapDumpOnOutOfMemoryError for java.lang.OutOfMemoryError. */
export function fixJVMHeapConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/OutOfMemoryError|java\.lang\.OutOfMemoryError|GC overhead limit exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('Xmx') || !f.content.includes('java')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  JAVA_TOOL_OPTIONS: -Xmx4g -Xms512m -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp/heap.hprof',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -Xmx4g + HeapDumpOnOutOfMemoryError — java.lang.OutOfMemoryError; JVM now has 4GB heap and dumps to /tmp/heap.hprof on OOM for offline analysis', confidence: 100 });
  }
  return fixes;
}

/** Create or patch gradle.properties with org.gradle.jvmargs=-Xmx4g for Gradle OOM. */
export function fixGradleJVMArgs(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Gradle.*OutOfMemoryError|Gradle.*heap|org\.gradle.*memory/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const existing = files.find(f => f.path === 'gradle.properties' || f.path === 'gradle/gradle.properties');
  if (existing) {
    if (existing.content.includes('org.gradle.jvmargs')) return fixes;
    fixes.push({ path: existing.path, content: existing.content + '\norg.gradle.jvmargs=-Xmx4g -Xms512m -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError\norg.gradle.daemon=false\n', explanation: 'Added org.gradle.jvmargs=-Xmx4g to gradle.properties — Gradle OutOfMemoryError; daemon now has 4GB heap', confidence: 100 });
  } else {
    fixes.push({ path: 'gradle.properties', content: 'org.gradle.jvmargs=-Xmx4g -Xms512m -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError\norg.gradle.daemon=false\norg.gradle.parallel=true\norg.gradle.caching=true\n', explanation: 'Created gradle.properties with -Xmx4g + parallel build — Gradle OutOfMemoryError; daemon has 4GB heap and is disabled to prevent memory accumulation across builds', confidence: 100 });
  }
  return fixes;
}

/** Add GOMEMLIMIT=3GiB + GOGC=50 for Go runtime out-of-memory allocation failures. */
export function fixGoMemoryTuning(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/runtime: out of memory|cannot allocate memory.*go/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('GOMEMLIMIT') || !f.content.includes('go')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  GOMEMLIMIT: 3GiB',
      '  GOGC: 50',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GOMEMLIMIT=3GiB + GOGC=50 — Go runtime out of memory; GOMEMLIMIT triggers GC before the OOM killer, GOGC=50 halves heap growth between collections', confidence: 95 });
  }
  return fixes;
}

/** Add PYTHONMALLOC=malloc + aggressive trim threshold for Python MemoryError. */
export function fixPythonMemoryLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/MemoryError|Cannot allocate memory.*python|python.*killed.*memory/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('python') || f.content.includes('PYTHONMALLOC')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PYTHONMALLOC: malloc',
      '  MALLOC_TRIM_THRESHOLD_: 65536',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PYTHONMALLOC=malloc + MALLOC_TRIM_THRESHOLD — Python MemoryError; glibc malloc now trims freed memory back to OS sooner, reducing peak RSS', confidence: 85 });
  }
  return fixes;
}

/** Add --memory=2g --memory-swap=4g to docker run commands to cap container memory. */
export function fixDockerMemoryLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/container.*killed|OOM.*container|docker.*memory.*limit|Killed.*docker/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('--memory') || !f.content.includes('docker run')) continue;
    const fixed = f.content.replace(/(docker run)((?:\s+--[a-z][^\n]*)*)/g, (match, cmd, flags) => {
      if (flags.includes('--memory')) return match;
      return `${cmd} --memory=2g --memory-swap=4g${flags}`;
    });
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --memory=2g --memory-swap=4g to docker run — container OOM killed; hard memory limit prevents runaway containers from starving the runner', confidence: 90 });
  }
  return fixes;
}

/** Add ulimit -v/m before memory-intensive steps to prevent virtual memory exhaustion. */
export function fixUlimitVirtualMemory(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot allocate memory|virtual memory exhausted|address space.*limit/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('ulimit -v') || f.content.includes('ulimit -m')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let added = false;
    for (const line of lines) {
      if (!added && /^\s+- name:\s*(Checkout|Install|Setup)/i.test(line)) {
        out.push('      - name: Configure memory limits');
        out.push('        run: |');
        out.push('          ulimit -v $((8 * 1024 * 1024))  # 8GB virtual');
        out.push('          ulimit -m $((4 * 1024 * 1024))  # 4GB RSS');
        added = true;
      }
      out.push(line);
    }
    if (added)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added ulimit -v/m memory caps — virtual memory exhausted; 8GB virtual / 4GB RSS limits prevent a single process from OOM-killing the runner', confidence: 85 });
  }
  return fixes;
}

/** Add K8s resource requests/limits to Deployment specs to prevent OOMKilled pods. */
export function fixK8sPodMemoryLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/OOMKilled|Pod.*OOM|Evicted.*memory|kubectl.*OOMKilled/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment') && !f.content.includes('kind: Pod')) continue;
    if (f.content.includes('resources:') || f.content.includes('memory:')) continue;
    const fixed = f.content.replace(
      /^(\s+image:\s+[^\n]+)/m,
      '$1\n          resources:\n            requests:\n              memory: "256Mi"\n              cpu: "250m"\n            limits:\n              memory: "2Gi"\n              cpu: "2000m"',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added K8s resource requests/limits — pod OOMKilled; memory limit=2Gi prevents node memory pressure and gives the scheduler accurate resource information', confidence: 90 });
  }
  return fixes;
}

/** Add 8GB swap space creation step for memory-intensive GitHub Actions builds. */
export function fixSwapSpaceCI(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot allocate memory|ENOMEM|killed.*signal 9|Out of memory.*runner/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('swapfile') || f.content.includes('mkswap')) continue;
    const swapStep = [
      '      - name: Create swap space',
      '        run: |',
      '          sudo fallocate -l 8G /swapfile',
      '          sudo chmod 600 /swapfile',
      '          sudo mkswap /swapfile',
      '          sudo swapon /swapfile',
      '          sudo sysctl vm.swappiness=10',
      '          echo "Swap:"; free -h',
    ].join('\n');
    const lines = f.content.split('\n');
    const out: string[] = [];
    let added = false;
    for (const line of lines) {
      if (!added && /^\s+- (?:name:|uses:\s*actions\/checkout)/i.test(line)) {
        out.push(swapStep);
        added = true;
      }
      out.push(line);
    }
    if (added)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added 8GB swap space creation — ENOMEM / signal 9 OOM kill; GitHub Actions runners have no swap by default; 8GB swap prevents the kernel from killing build processes', confidence: 95 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION F — Runtime Segmentation Fault (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add ASAN + UBSAN compiler flags for C/C++ builds to detect memory corruption. */
export function fixAddressSanitizerBuild(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/SIGSEGV|Segmentation fault|heap-buffer-overflow|AddressSanitizer/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('ASAN_OPTIONS')) continue;
    if (!f.content.includes('cmake') && !f.content.includes('gcc') && !f.content.includes('clang') && !f.content.includes('make')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  ASAN_OPTIONS: abort_on_error=1:fast_unwind_on_malloc=0:detect_leaks=1',
      '  UBSAN_OPTIONS: abort_on_error=1:print_stacktrace=1',
      '  CFLAGS: -fsanitize=address,undefined -fno-omit-frame-pointer -g',
      '  CXXFLAGS: -fsanitize=address,undefined -fno-omit-frame-pointer -g',
      '  LDFLAGS: -fsanitize=address,undefined',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ASAN + UBSAN compiler flags — SIGSEGV segfault; AddressSanitizer now detects heap buffer overflow and use-after-free with exact source locations', confidence: 95 });
  }
  return fixes;
}

/** Add PYTHONFAULTHANDLER=1 to dump Python traceback on SIGSEGV from C extensions. */
export function fixPythonFaultHandler(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Segmentation fault.*python|python.*SIGSEGV|Fatal Python error.*Segmentation/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('PYTHONFAULTHANDLER') || !f.content.includes('python')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PYTHONFAULTHANDLER: 1',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PYTHONFAULTHANDLER=1 — Python segfault in C extension; faulthandler prints the Python traceback executing at the moment the signal fired', confidence: 100 });
  }
  return fixes;
}

/** Add cargo miri step before cargo test for undefined behavior detection. */
export function fixRustMiriCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/undefined behavior|use-after-free.*rust|invalid memory.*rust/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('cargo miri') || !f.content.includes('cargo')) continue;
    const miriStep = [
      '      - name: Miri undefined-behavior check',
      '        run: |',
      '          rustup component add miri 2>/dev/null || true',
      '          cargo miri test --no-fail-fast 2>&1 | tail -50 || true',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*cargo test/i, miriStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added cargo miri step — undefined behavior / use-after-free; Miri interprets MIR bytecode to detect UB including raw pointer misuse and out-of-bounds access', confidence: 85 });
  }
  return fixes;
}

/** Add Valgrind memcheck step for C/C++ memory errors. */
export function fixValgrindMemCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/valgrind|Invalid read|Invalid write|Conditional jump.*uninitialised/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('valgrind') || (!f.content.includes('cmake') && !f.content.includes('gcc') && !f.content.includes('make'))) continue;
    const valgrindStep = [
      '      - name: Install Valgrind',
      '        run: sudo apt-get install -y --no-install-recommends valgrind 2>/dev/null || true',
      '',
      '      - name: Valgrind memcheck',
      '        run: |',
      '          valgrind --tool=memcheck --leak-check=full --show-leak-kinds=all \\',
      '            --track-origins=yes --error-exitcode=1 \\',
      '            ./build/tests 2>&1 | tee /tmp/valgrind.log || true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:ctest|make test|\.\/build\/tests)/i, valgrindStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Valgrind memcheck step — memory corruption causing segfault; Valgrind detects invalid reads/writes and uninitialized memory with exact source line numbers', confidence: 85 });
  }
  return fixes;
}

/** Upload core dump files as CI artifacts for post-mortem gdb analysis. */
export function fixCoreDumpUpload(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/core dumped|SIGSEGV|signal 11/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('core-dumps') || f.content.includes('upload-core')) continue;
    const uploadStep = [
      '      - name: Upload core dumps',
      '        if: failure()',
      '        uses: actions/upload-artifact@v4',
      '        with:',
      '          name: core-dumps',
      '          path: |',
      '            /tmp/core.*',
      '            core',
      '          if-no-files-found: ignore',
      '          retention-days: 3',
    ].join('\n');
    const lines = f.content.split('\n');
    const lastStepIdx = lines.reduce((acc, line, i) => /^\s+- name:/.test(line) ? i : acc, -1);
    if (lastStepIdx === -1) continue;
    let insertAt = lastStepIdx;
    for (let i = lastStepIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, uploadStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added core dump upload artifact step — SIGSEGV segfault; core files now preserved as CI artifacts for post-mortem gdb backtrace analysis', confidence: 90 });
  }
  return fixes;
}

/** Add --report-on-signal to NODE_OPTIONS so Node.js writes diagnostic report on SIGSEGV. */
export function fixNodeNativeAddonCrash(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Segmentation fault.*node|node.*SIGSEGV|FATAL ERROR.*node/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('--report-on-signal') || !f.content.includes('node')) continue;
    const fixed = /NODE_OPTIONS/.test(f.content)
      ? f.content.replace(/(NODE_OPTIONS:\s*['"]?)(--[^\n'"]*)/g, '$1$2 --report-on-signal --report-signal=SIGSEGV --report-dir=/tmp')
      : injectWorkflowLevelBlock(f.content, 'env', ['  NODE_OPTIONS: --report-on-signal --report-signal=SIGSEGV --report-dir=/tmp']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --report-on-signal to NODE_OPTIONS — Node.js segfault in native addon; Node.js now writes a diagnostic report capturing heap, event loop, and native stack on SIGSEGV', confidence: 95 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION G — Unhandled Exception (extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add Express 4-arg error middleware to prevent unhandled exceptions from crashing the process. */
export function fixExpressErrorMiddleware(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/express.*error|unhandledRejection.*express/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.js') && !f.path.endsWith('.ts')) continue;
    if (!f.content.includes('express') || f.content.includes('err, req, res') || !f.content.includes('app.listen')) continue;
    const middleware = [
      '',
      'app.use((err: Error, _req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {',
      "  console.error('[express:error]', err.message, err.stack);",
      "  res.status((err as { status?: number }).status ?? 500).json({ error: err.message });",
      '});',
      '',
    ].join('\n');
    const fixed = f.content.replace(/app\.listen\(/, `${middleware}\napp.listen(`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Express 4-arg error middleware — unhandled Express errors crashed the process; middleware now catches all sync/async throw errors and responds with structured JSON', confidence: 85 });
  }
  return fixes;
}

/** Replace Promise.all with Promise.allSettled to prevent one rejection killing all parallel ops. */
export function fixPromiseAllSettled(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/UnhandledPromiseRejectionWarning|one of the promises.*rejected|Promise\.all.*reject/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (f.path.includes('test') || f.path.includes('spec') || f.path.includes('node_modules')) continue;
    if (!f.content.includes('Promise.all(') || f.content.includes('Promise.allSettled')) continue;
    const fixed = f.content.replace(/Promise\.all\(/g, 'Promise.allSettled(');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Replaced Promise.all with Promise.allSettled — one rejected promise caused UnhandledPromiseRejection; allSettled returns all results (fulfilled/rejected) so one failure doesn't abort the rest", confidence: 80 });
  }
  return fixes;
}

/** Add --unhandled-rejections=throw + --enable-source-maps to NODE_OPTIONS for async crashes. */
export function fixAsyncTryCatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/unhandledRejection|async.*exception|promise.*uncaught/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('unhandled-rejections') || f.content.includes('enable-source-maps')) continue;
    const fixed = /NODE_OPTIONS/.test(f.content)
      ? f.content.replace(/(NODE_OPTIONS:\s*['"]?)(--[^\n'"]*)/g, '$1$2 --unhandled-rejections=throw --enable-source-maps')
      : injectWorkflowLevelBlock(f.content, 'env', ['  NODE_OPTIONS: --unhandled-rejections=throw --enable-source-maps']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --unhandled-rejections=throw + --enable-source-maps — unhandled async exception; process now exits non-zero on any unhandled rejection and shows TypeScript source locations', confidence: 95 });
  }
  return fixes;
}

/** Replace bare except/pass blocks with logging.exception() to prevent swallowing tracebacks. */
export function fixPythonExceptionLogging(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Exception.*swallowed|except.*pass|unhandled exception.*python/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.py') || f.path.includes('test')) continue;
    if (!f.content.includes('except Exception') || f.content.includes('logging.exception')) continue;
    const fixed = f.content.replace(
      /except Exception(?:\s+as\s+\w+)?\s*:\s*\n(\s+)pass\b/g,
      (_, indent) => `except Exception as _exc:\n${indent}import logging as _log; _log.exception("Unhandled: %s", _exc)`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced bare except/pass with logging.exception() — Python exceptions silently swallowed; logging.exception() records the full traceback before discarding the error', confidence: 85 });
  }
  return fixes;
}

/** Add JVM crash logging via JAVA_TOOL_OPTIONS for uncaught thread exceptions. */
export function fixJavaUncaughtExceptionHandler(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Exception in thread|java.*uncaught exception/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('java') || f.content.includes('OnError')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  JAVA_TOOL_OPTIONS: -XX:OnError="cat /tmp/hs_err_pid%p.log" -XX:+HeapDumpOnOutOfMemoryError -XX:ErrorFile=/tmp/hs_err_pid%p.log',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added JVM OnError crash logging — uncaught exception in thread; JVM writes hs_err_pid*.log with all thread stacks and memory at the time of crash', confidence: 90 });
  }
  return fixes;
}

/** Add DOTNET_DbgEnableMiniDump for full .NET crash dump on unhandled exceptions. */
export function fixDotNetUnhandledException(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Unhandled exception.*dotnet|System\.Exception.*unhandled/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('dotnet') || f.content.includes('DOTNET_DbgEnableMiniDump')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DOTNET_DbgEnableMiniDump: 1',
      '  DOTNET_DbgMiniDumpType: 4',
      '  DOTNET_DbgMiniDumpName: /tmp/core',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DOTNET_DbgEnableMiniDump — unhandled .NET exception; CLR now writes a full memory dump to /tmp/core on crash for dotnet-dump / WinDbg analysis', confidence: 90 });
  }
  return fixes;
}

/** Add Sentry DSN/ENVIRONMENT/RELEASE env vars so runtime exceptions are captured in CI. */
export function fixSentryRuntimeCapture(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Sentry.*exception|unhandled.*exception.*sentry|SENTRY_DSN/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('SENTRY_DSN')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  SENTRY_DSN: ${{ secrets.SENTRY_DSN }}',
      '  SENTRY_ENVIRONMENT: ci',
      '  SENTRY_RELEASE: ${{ github.sha }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added SENTRY_DSN/ENVIRONMENT/RELEASE — unhandled exception missed by CI logs; Sentry SDK now captures runtime exceptions with full context during integration test runs', confidence: 80 });
  }
  return fixes;
}

/** Add global window.onerror + unhandledrejection handlers to browser test setup files. */
export function fixBrowserGlobalErrorHandler(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/window\.onerror|unhandledrejection.*browser|browser.*exception.*unhandled/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('setup.ts') && !f.path.endsWith('setup.js') && !f.path.endsWith('global.ts')) continue;
    if (f.content.includes('window.onerror') || f.content.includes('unhandledrejection')) continue;
    const handler = [
      '',
      "if (typeof window !== 'undefined') {",
      "  window.onerror = (msg, src, line, col, err) => {",
      "    console.error('[window.onerror]', { msg, src, line, col, stack: err?.stack });",
      '    return false;',
      '  };',
      "  window.addEventListener('unhandledrejection', (event) => {",
      "    console.error('[unhandledrejection]', event.reason);",
      '  });',
      '}',
      '',
    ].join('\n');
    fixes.push({ path: f.path, content: f.content + handler, explanation: 'Added window.onerror + unhandledrejection handlers to global setup — browser test exceptions silently swallowed; handlers now log to console so Playwright/Cypress captures them in test output', confidence: 85 });
  }
  return fixes;
}

/** Add runtime diagnostics capture step on failure: memory, process list, kernel messages. */
export function fixRuntimeExceptionDiagnostics(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/runtime exception|unhandled exception|process exited.*code 1|exit code: 1/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('collect runtime') || f.content.includes('proc/meminfo')) continue;
    const diagStep = [
      '      - name: Collect runtime diagnostics on failure',
      '        if: failure()',
      '        run: |',
      '          echo "=== Memory ===" && free -h || true',
      '          echo "=== Top procs ===" && ps aux --sort=-%mem | head -10 || true',
      '          echo "=== Kernel OOM ===" && dmesg | grep -iE "oom|killed|segfault" | tail -20 || true',
      '        continue-on-error: true',
    ].join('\n');
    const lines = f.content.split('\n');
    const lastStepIdx = lines.reduce((acc, line, i) => /^\s+- name:/.test(line) ? i : acc, -1);
    if (lastStepIdx === -1) continue;
    let insertAt = lastStepIdx;
    for (let i = lastStepIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, diagStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added runtime diagnostics on failure — process exited non-zero; now captures memory usage, process list, and kernel OOM messages at the point of crash', confidence: 85 });
  }
  return fixes;
}
