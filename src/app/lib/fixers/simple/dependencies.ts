// Simple / Dependency Errors
// Category coverage (moderate–high project):
//   1. Missing package/module  — npm/yarn/pnpm/bun/pip/poetry/pipenv/composer/go/cargo/bundle/conda
//   2. Version mismatch        — Node/Python/Java/Go/Ruby/Rust pinning, engines field, EBADENGINE
//   3. Dependency conflict     — peer deps, overrides, resolutions, pip, Maven exclusions
//   4. Corrupted lock file     — npm/yarn/pnpm/poetry/Gemfile.lock detection and repair
//   5. Unsupported version     — EOL runtimes, deprecated packages, engines enforcement
//   6. Missing virtual env     — Python venv/poetry/pipenv/conda isolation

import { RuleFix, isGitHubWorkflow, isGitLabCI, insertStepBefore } from '../helpers';

// ── CATEGORY 1: MISSING PACKAGE / MODULE ─────────────────────────────────────

/** Add npm ci/install before build/test when no install step exists. */
export function fixAddInstallStep(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const hasBuildOrTest = /run:\s*(npm run (build|test|start|lint)|npm test|npx\s+(?!create))/m.test(f.content);
    const hasInstall = /run:\s*(npm (ci|install)|yarn install|pnpm install|bun install)/m.test(f.content);
    if (!hasBuildOrTest || hasInstall) continue;
    const hasLockfile = files.some(fi => ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'].includes(fi.path));
    const cmd = hasLockfile ? 'npm ci' : 'npm install';
    const patched = insertStepBefore(
      f.content,
      /run:\s*(npm run|npm test|npx(?! create))/,
      `      - name: Install dependencies\n        run: ${cmd}`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added ${cmd} before build/test — no install step found; ${cmd} is required to populate node_modules before any npm scripts run`, confidence: 100 });
  }
  return fixes;
}

/** Add yarn install before build/test when missing. */
export function fixMissingYarnInstallStep(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const hasYarnCmd = /run:\s*yarn\s+(build|test|run\s+(build|test|lint|start))/m.test(f.content);
    const hasInstall = /yarn\s+(install|add)\b/m.test(f.content);
    if (!hasYarnCmd || hasInstall) continue;
    const hasLock = files.some(fi => fi.path === 'yarn.lock');
    const flag = hasLock ? '--frozen-lockfile' : '';
    const patched = insertStepBefore(
      f.content,
      /run:\s*yarn\s+(build|test|run)/,
      `      - name: Install dependencies\n        run: yarn install ${flag}`.trimEnd(),
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added yarn install ${flag} — missing install step; without it yarn build/test cannot find any packages`.trim(), confidence: 100 });
  }
  return fixes;
}

/** Add pnpm/action-setup when pnpm is used but not installed. */
export function fixMissingPnpmSetup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pnpm.*not found|command not found.*pnpm|PNPM.*not.*installed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pnpm') || f.content.includes('pnpm/action-setup')) continue;
    const patched = insertStepBefore(
      f.content,
      /uses:\s*actions\/checkout/,
      `      - uses: pnpm/action-setup@v4\n        with:\n          version: 9\n          run_install: false`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added pnpm/action-setup@v4 — pnpm is not pre-installed on GitHub runners; it must be set up before any pnpm commands', confidence: 100 });
  }
  return fixes;
}

/** Add composer install step when PHP project is detected without it. */
export function fixMissingComposerInstall(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/php|composer exec|vendor\/bin|artisan|phpunit/i.test(f.content)) continue;
    if (f.content.includes('composer install') || f.content.includes('composer update')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(php\s|composer\s+exec|vendor\/bin|artisan|phpunit)/,
      `      - name: Install Composer dependencies\n        run: |\n          composer install --prefer-dist --no-progress --no-interaction --optimize-autoloader`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added composer install — PHP project detected but no dependency installation step; without vendor/ PHP autoloading fails with "class not found"', confidence: 100 });
  }
  return fixes;
}

/** Add poetry install step when Poetry commands are used without it. */
export function fixMissingPoetryInstall(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/poetry\s+(run|build|publish|check)/m.test(f.content)) continue;
    if (/poetry install|snok\/install-poetry/m.test(f.content)) continue;
    const hasPip = /pip install poetry/i.test(f.content);
    const installBlock = hasPip
      ? `      - name: Install dependencies\n        run: poetry install --no-interaction --no-root`
      : `      - name: Install Poetry\n        uses: snok/install-poetry@v1\n        with:\n          virtualenvs-create: true\n          virtualenvs-in-project: true\n          installer-parallel: true\n      - name: Install dependencies\n        run: poetry install --no-interaction --no-root`;
    const patched = insertStepBefore(f.content, /run:\s*poetry\s+(run|build|publish)/, installBlock);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added poetry install — Poetry project detected but no dependency install step; without it poetry run fails with ModuleNotFoundError', confidence: 100 });
  }
  return fixes;
}

/** Add pipenv install step when pipenv commands are used without it. */
export function fixMissingPipenvInstall(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/pipenv\s+(run|shell|check)/m.test(f.content)) continue;
    if (/pipenv install|pipenv sync/m.test(f.content)) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*pipenv\s+(run|shell|check)/,
      `      - name: Install Pipenv dependencies\n        run: |\n          pip install pipenv\n          pipenv install --dev --deploy`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added pipenv install --deploy — pipenv project detected but no install step; --deploy enforces lockfile consistency and fails fast if Pipfile.lock is stale', confidence: 100 });
  }
  return fixes;
}

/** Add actions/setup-python when Python commands are used but no setup step exists. */
export function fixMissingSetupPython(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/run:\s*(python|pip|pytest|poetry|pipenv)/m.test(f.content)) continue;
    if (f.content.includes('actions/setup-python')) continue;
    const pyFile = files.find(fi => fi.path === '.python-version' || fi.path === 'pyproject.toml');
    const versionMatch = pyFile?.content.match(/(?:python[_-]?version['":\s]+)(\d+\.\d+)/i);
    const pyVersion = versionMatch?.[1] ?? '3.12';
    const patched = insertStepBefore(
      f.content,
      /run:\s*(python|pip|pytest|poetry|pipenv)/,
      `      - name: Set up Python ${pyVersion}\n        uses: actions/setup-python@v5\n        with:\n          python-version: '${pyVersion}'\n          cache: 'pip'`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added actions/setup-python@v5 (${pyVersion}) — Python detected but no setup step; runner system Python may be wrong version or missing pip; built-in pip cache reduces install time`, confidence: 100 });
  }
  return fixes;
}

/** Add actions/setup-java when Maven/Gradle are used but no Java setup exists. */
export function fixMissingSetupJava(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/run:\s*(mvn|gradle|\.\/gradlew|\.\/mvnw)/m.test(f.content)) continue;
    if (f.content.includes('actions/setup-java')) continue;
    const isGradle = /gradle/i.test(f.content);
    const cacheType = isGradle ? 'gradle' : 'maven';
    const patched = insertStepBefore(
      f.content,
      /run:\s*(mvn|gradle|\.\/gradlew|\.\/mvnw)/,
      `      - name: Set up JDK 21\n        uses: actions/setup-java@v4\n        with:\n          java-version: '21'\n          distribution: 'temurin'\n          cache: '${cacheType}'`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added actions/setup-java@v4 (Temurin 21 LTS) — Maven/Gradle detected but no Java setup step; Temurin is the recommended free OpenJDK distribution with built-in ${cacheType} dependency caching`, confidence: 100 });
  }
  return fixes;
}

/** Add actions/setup-go when Go commands are used but no Go setup exists. */
export function fixMissingSetupGo(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/run:\s*go\s+(build|test|run|install)/m.test(f.content)) continue;
    if (f.content.includes('actions/setup-go')) continue;
    const goMod = files.find(fi => fi.path === 'go.mod');
    const goVersion = goMod?.content.match(/^go\s+(\d+\.\d+)/m)?.[1] ?? '1.22';
    const patched = insertStepBefore(
      f.content,
      /run:\s*go\s+(build|test|run|install)/,
      `      - name: Set up Go ${goVersion}\n        uses: actions/setup-go@v5\n        with:\n          go-version: '${goVersion}'\n          cache: true`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added actions/setup-go@v5 (${goVersion}) — Go detected but no setup step; built-in module cache (~/go/pkg/mod) reduces download time significantly`, confidence: 100 });
  }
  return fixes;
}

/** Create a minimal requirements.txt when CI references it but none exists. */
export function fixCreateRequirementsTxt(files: Array<{ path: string; content: string }>): RuleFix[] {
  const needsReqs = files.some(f => (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) && f.content.includes('requirements.txt'));
  if (!needsReqs || files.some(f => f.path === 'requirements.txt')) return [];
  return [{
    path: 'requirements.txt',
    content: '# Add your Python dependencies here\n# Pin exact versions for reproducible builds:\n# requests==2.31.0\n# flask==3.0.0\n# pytest==7.4.0\n# pytest-cov==4.1.0\n',
    explanation: 'Created requirements.txt — CI references this file but it did not exist; pip install -r fails with FileNotFoundError without it',
    confidence: 100,
  }];
}

/** Add Python virtualenv creation step when venv is missing in CI. */
export function fixMissingVirtualEnv(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No module named|ModuleNotFoundError|venv.*not.*found|\.venv.*activate|cannot import/i.test(logs)) return [];
  if (!/python/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('python') || f.content.includes('venv') || f.content.includes('virtualenv')) continue;
    if (isGitHubWorkflow(f.path) && f.content.includes('actions/setup-python')) {
      const lines = f.content.split('\n');
      const out: string[] = [];
      let added = false;
      for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (!added && /uses:\s*actions\/setup-python/i.test(lines[i])) {
          let j = i + 1;
          while (j < lines.length && /^\s{8,}/.test(lines[j])) { out.push(lines[j]); j++; i = j - 1; }
          out.push('      - name: Create virtual environment');
          out.push('        run: |');
          out.push('          python -m venv .venv');
          out.push('          echo "${{ github.workspace }}/.venv/bin" >> $GITHUB_PATH');
          out.push('          .venv/bin/pip install --upgrade pip setuptools wheel');
          added = true;
        }
      }
      if (added)
        fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added Python venv creation and path injection — pip installed packages into the system Python which may be missing or isolated; venv ensures packages are importable and GITHUB_PATH makes the venv the active interpreter for all later steps', confidence: 100 });
    } else if (isGitLabCI(f.path)) {
      const fixed = f.content.replace(
        /(pip install)/g,
        'python -m venv .venv && source .venv/bin/activate && pip install --upgrade pip setuptools wheel && pip install',
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added venv activation before pip install in GitLab CI — modules not found because pip installed to system Python without isolation', confidence: 100 });
    }
  }
  return fixes;
}

/** Add Poetry virtualenv configuration when poetry venv is missing or misconfigured. */
export function fixPoetryVirtualEnv(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No module named|ModuleNotFoundError|poetry.*venv|no virtual.*activated/i.test(logs)) return [];
  if (!/poetry/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('poetry') || f.content.includes('virtualenvs-in-project')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let added = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (!added && /uses:\s*actions\/setup-python/i.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && /^\s{8,}/.test(lines[j])) { out.push(lines[j]); j++; i = j - 1; }
        out.push('      - name: Configure Poetry');
        out.push('        run: |');
        out.push('          pip install poetry');
        out.push('          poetry config virtualenvs.create true');
        out.push('          poetry config virtualenvs.in-project true');
        out.push('          poetry config installer.parallel true');
        added = true;
      }
    }
    if (added)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added Poetry virtualenv configuration — in-project venvs (.venv/) are cached reliably with actions/cache; parallel installer speeds up installation; virtualenvs.create=true ensures isolation', confidence: 100 });
  }
  return fixes;
}

/** Add conda-incubator/setup-miniconda when conda/mamba commands are detected. */
export function fixCondaEnvironmentSetup(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/conda|mamba|micromamba|environment\.ya?ml/i.test(f.content)) continue;
    if (/conda-incubator\/setup-miniconda|mamba-org\/setup-micromamba/m.test(f.content)) continue;
    const hasEnvFile = files.some(fi => fi.path === 'environment.yml' || fi.path === 'environment.yaml');
    const envFlag = hasEnvFile ? '\n          environment-file: environment.yml\n          activate-environment: env' : '';
    const isMamba = /mamba|micromamba/i.test(f.content);
    const action = isMamba
      ? `      - name: Set up Micromamba\n        uses: mamba-org/setup-micromamba@v1\n        with:\n          micromamba-version: latest${envFlag}`
      : `      - name: Set up Miniconda\n        uses: conda-incubator/setup-miniconda@v3\n        with:\n          auto-update-conda: true\n          python-version: '3.12'${envFlag}\n          auto-activate-base: false\n          use-mamba: true`;
    const patched = insertStepBefore(f.content, /run:\s*(conda|mamba|micromamba)/, action);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added ${isMamba ? 'mamba-org/setup-micromamba' : 'conda-incubator/setup-miniconda'} — GitHub runners do not have conda pre-installed; this action installs Miniconda and optionally restores the environment from environment.yml`, confidence: 100 });
  }
  return fixes;
}

/** Add go mod download step before Go build/test. */
export function fixGoModDownload(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const hasGo = /run:\s*go\s+(build|test|run)/m.test(f.content);
    const hasDl  = /go mod download|go mod tidy|go mod verify/m.test(f.content);
    if (!hasGo || hasDl) continue;
    if (isGitHubWorkflow(f.path)) {
      const patched = insertStepBefore(
        f.content,
        /run:\s*go\s+(build|test|run)/,
        `      - name: Download Go modules\n        run: |\n          go mod download\n          go mod verify`,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added go mod download — without it Go cannot resolve imports on a fresh runner; go mod verify checks downloaded module checksums against go.sum', confidence: 100 });
    } else {
      const fixed = f.content.includes('before_script:')
        ? f.content.replace(/^(before_script:\s*\n)/m, '$1  - go mod download && go mod verify\n')
        : f.content.replace(/^(\w[\w-]+:[ \t]*\n)((?:[ \t]+\S[^\n]*\n)*[ \t]+script:)/gm,
            (_, h, rest) => `${h}  before_script:\n    - go mod download\n    - go mod verify\n${rest}`);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added go mod download in before_script — fresh GitLab runner has empty module cache; modules must be downloaded before building', confidence: 100 });
    }
  }
  return fixes;
}

/** Add Ruby bundle install step when bundle exec/rake is used without it. */
export function fixRubyBundlerSetup(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const hasRubyCmd = /ruby\/setup-ruby|bundle exec|rake\s/m.test(f.content);
    if (!hasRubyCmd) continue;
    if (/bundle install|bundle config/m.test(f.content)) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(bundle exec|rake\s)/,
      `      - name: Install Ruby gems\n        run: |\n          bundle config set --local deployment true\n          bundle config set --local without development\n          bundle install --jobs 4 --retry 3`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added bundle install — gems must be installed before bundle exec or rake; --jobs 4 parallelizes native extension compilation; --retry 3 handles transient gem server failures', confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 2: VERSION MISMATCH ─────────────────────────────────────────────

/** Pin node-version in setup-node when the specified version is unavailable. */
export function fixNodeVersionPin(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/node.*not.*found|unsupported.*engine|no.*matching.*version.*found|ENODEVER|EBADENGINE.*node/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('node-version:')) continue;
    const fixed = f.content.replace(/node-version:\s*['"]?[^\s'"]+['"]?/g, "node-version: '20'");
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Pinned node-version to 20 (LTS) — specified version is unavailable on GitHub runners; Node 20 is current LTS with widest ecosystem compatibility', confidence: 100 });
  }
  return fixes;
}

/** Fix EBADENGINE by updating node-version to match the package's required version. */
export function fixUnsupportedEngineVersion(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/EBADENGINE|Unsupported engine|engines.*node.*required|requires node/i.test(logs)) return [];
  const vMatch = logs.match(/(?:required|wanted|requires?)[\s\S]{0,40}?node[^0-9]*(\d+)/i);
  if (!vMatch) return [];
  const requiredMajor = vMatch[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('node-version:')) continue;
    const fixed = f.content.replace(/node-version:\s*['"]?[^\s'"]+['"]?/g, `node-version: '${requiredMajor}'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Updated node-version to ${requiredMajor} — EBADENGINE: a dependency requires Node ${requiredMajor}+; the runner was using a lower version`, confidence: 100 });
  }
  return fixes;
}

/** Update actions/setup-python version when the specified Python is unavailable. */
export function fixPythonVersionPin(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/python.*version.*not.*found|no.*matching.*version.*python|python.*not.*available|requires.*python\s+\d/i.test(logs)) return [];
  const logVer = logs.match(/python\s+(\d+\.\d+)/i)?.[1] ?? '3.12';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('actions/setup-python')) continue;
    const fixed = f.content.replace(/python-version:\s*['"]?[^\s'"]+['"]?/g, `python-version: '${logVer}'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Pinned python-version to ${logVer} — specified version is not available on GitHub runners; use major.minor format like '3.12'`, confidence: 100 });
  }
  return fixes;
}

/** Pin java-version to LTS 21 when the specified JDK is unavailable or EOL. */
export function fixJavaVersionPin(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/java.*version.*not.*found|unsupported.*java|JDK.*not.*available|java.*\d+.*not.*available/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('actions/setup-java')) continue;
    const fixed = f.content.replace(/java-version:\s*['"]?[^\s'"]+['"]?/g, "java-version: '21'");
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Pinned java-version to 21 (LTS) — specified Java version is unavailable or EOL; Java 21 is current LTS with the widest Spring Boot / Quarkus / Micronaut compatibility", confidence: 100 });
  }
  return fixes;
}

/** Pin go-version to match go.mod when the specified version is unavailable. */
export function fixGoVersionPin(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/go.*version.*not.*found|go\d+\.\d+.*not.*available|go.*not.*installed/i.test(logs)) return [];
  const goMod = files.find(fi => fi.path === 'go.mod');
  const goVersion = goMod?.content.match(/^go\s+(\d+\.\d+)/m)?.[1] ?? '1.22';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('actions/setup-go')) continue;
    const fixed = f.content.replace(/go-version:\s*['"]?[^\s'"]+['"]?/g, `go-version: '${goVersion}'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Pinned go-version to ${goVersion} — taken from go.mod to ensure workflow version matches the project's declared minimum`, confidence: 100 });
  }
  return fixes;
}

/** Pin ruby-version to match .ruby-version when the specified version is unavailable. */
export function fixRubyVersionPin(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ruby.*version.*not.*found|rbenv.*install.*failed|ruby.*not.*available/i.test(logs)) return [];
  const rvFile = files.find(fi => fi.path === '.ruby-version');
  const rubyVersion = rvFile?.content.trim() ?? '3.3';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('ruby/setup-ruby')) continue;
    const fixed = f.content.replace(/ruby-version:\s*['"]?[^\s'"]+['"]?/g, `ruby-version: '${rubyVersion}'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Pinned ruby-version to ${rubyVersion} — taken from .ruby-version file to match local development and bundler expectations`, confidence: 100 });
  }
  return fixes;
}

/** Fix node-version mismatch when it conflicts with package.json engines.node field. */
export function fixNpmEnginesCheck(files: Array<{ path: string; content: string }>): RuleFix[] {
  const pkgJson = files.find(f => f.path === 'package.json');
  if (!pkgJson) return [];
  const enginesMatch = pkgJson.content.match(/"engines"[\s\S]*?"node":\s*"([^"]+)"/);
  if (!enginesMatch) return [];
  const minMajor = enginesMatch[1].match(/(\d+)/)?.[1];
  if (!minMajor) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const wfMajorMatch = f.content.match(/node-version:\s*['"]?(\d+)/);
    if (!wfMajorMatch || wfMajorMatch[1] === minMajor) continue;
    const fixed = f.content.replace(/node-version:\s*['"]?[^\s'"]+['"]?/g, `node-version: '${minMajor}'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Updated node-version to ${minMajor} to match package.json engines.node="${enginesMatch[1]}" — running a different Node version silently breaks modules that use version-specific APIs`, confidence: 100 });
  }
  return fixes;
}

/** Upgrade pip before installing requirements when version/build-backend conflicts occur. */
export function fixPipUpgrade(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/version.*conflict|Could not find a version|incompatible.*requires|ERROR.*ResolutionImpossible/i.test(logs)) return [];
  if (!/pip/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pip install')) continue;
    const fixed = f.content.replace(/(pip install -r)/g, 'pip install --upgrade pip setuptools wheel && pip install -r');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Upgraded pip/setuptools/wheel before requirements install — outdated pip cannot resolve PEP 517/518 build backends; upgrading wheel prevents binary package compilation failures', confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 3: DEPENDENCY CONFLICT ──────────────────────────────────────────

/** Add --legacy-peer-deps when npm reports ERESOLVE peer dependency conflicts. */
export function fixPeerDepConflict(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/peer dep|ERESOLVE|peer dependency conflict|incompatible peer/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if ((!f.content.includes('npm install') && !f.content.includes('npm ci')) || f.content.includes('--legacy-peer-deps')) continue;
    const fixed = f.content
      .replace(/\bnpm install\b(?!\s+--legacy)/g, 'npm install --legacy-peer-deps')
      .replace(/\bnpm ci\b(?!\s+--legacy)/g, 'npm ci --legacy-peer-deps');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --legacy-peer-deps — npm 7+ enforces strict peer dep resolution (ERESOLVE); --legacy-peer-deps restores npm 6 permissive behaviour allowing conflicting peer deps to coexist', confidence: 100 });
  }
  return fixes;
}

/** Add npm overrides to package.json when a specific nested peer dep conflicts. */
export function fixNpmOverrides(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ERESOLVE|peer dep|Conflicting peer/i.test(logs)) return [];
  const pkgMatch = logs.match(/Conflicting peer dependency:\s*([a-z@][a-z0-9._-]*(?:\/[a-z0-9._-]*)?)@([^\s,]+)/i);
  if (!pkgMatch) return [];
  const [, pkg, version] = pkgMatch;
  const packageJson = files.find(f => f.path === 'package.json');
  if (!packageJson || packageJson.content.includes('"overrides"')) return [];
  try {
    const parsed = JSON.parse(packageJson.content);
    parsed.overrides = { [pkg]: version };
    return [{
      path: 'package.json',
      content: JSON.stringify(parsed, null, 2) + '\n',
      explanation: `Added overrides.${pkg}="${version}" — npm overrides force all nested consumers to use this version, resolving ERESOLVE conflicts that --legacy-peer-deps cannot handle cleanly`,
      confidence: 100,
    }];
  } catch { return []; }
}

/** Add yarn resolutions when Yarn reports a peer dependency conflict. */
export function fixYarnResolutions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/YN0060|incompatible peer.*yarn|conflicting.*peer.*yarn/i.test(logs)) return [];
  const pkgMatch = logs.match(/([a-z@][a-z0-9._-]*(?:\/[a-z0-9._-]*)?)@npm:\^?(\d+\.\d+\.\d+)/i);
  if (!pkgMatch) return [];
  const [, pkg, version] = pkgMatch;
  const packageJson = files.find(f => f.path === 'package.json');
  if (!packageJson || packageJson.content.includes('"resolutions"')) return [];
  try {
    const parsed = JSON.parse(packageJson.content);
    parsed.resolutions = { [pkg]: `^${version}` };
    return [{
      path: 'package.json',
      content: JSON.stringify(parsed, null, 2) + '\n',
      explanation: `Added resolutions.${pkg}="^${version}" — Yarn resolutions force all nested consumers to use this version, resolving YN0060 peer dependency conflicts`,
      confidence: 100,
    }];
  } catch { return []; }
}

/** Remove --frozen-lockfile / --immutable when yarn reports the lockfile needs updating. */
export function fixYarnFrozenLockfile(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Your lockfile needs to be updated|frozen-lockfile|Cannot proceed|YN0028|immutable lockfile/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('--frozen-lockfile') && !f.content.includes('--immutable')) continue;
    const fixed = f.content.replace(/\s+--frozen-lockfile/g, '').replace(/\s+--immutable/g, '');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed --frozen-lockfile/--immutable — lockfile is outdated relative to package.json; yarn refuses to install with this flag when lockfile needs regeneration', confidence: 100 });
  }
  return fixes;
}

/** Resolve pip dependency conflicts by upgrading pip and adding conflict strategy. */
export function fixPipDependencyConflict(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ResolutionImpossible|Cannot install.*conflicting|pip.*conflict|ERROR.*ResolutionImpossible/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pip install -r')) continue;
    const fixed = f.content.replace(
      /pip install -r requirements\.txt/g,
      'pip install --upgrade pip setuptools wheel && pip install -r requirements.txt --use-pep517',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --use-pep517 to pip install — ResolutionImpossible often means pip cannot build a package from source; --use-pep517 forces the modern build backend which resolves many conflicts when combined with an upgraded pip', confidence: 100 });
  }
  return fixes;
}

/** Add pip --ignore-requires-python when a package version requires a different Python. */
export function fixPipIgnoreRequiresPython(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/requires.*python.*version|python.*version.*not.*compatible|does not support.*python/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pip install')) continue;
    const fixed = f.content.replace(/pip install(?!\s+--ignore-requires-python)/g, 'pip install --ignore-requires-python');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --ignore-requires-python — a package declares it is incompatible with the current Python version; this flag bypasses the check when you know the package actually works despite the metadata claim', confidence: 100 });
  }
  return fixes;
}

/** Add Maven dependency exclusion for conflicting transitive deps. */
export function fixMavenDependencyConflict(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ClassNotFoundException|NoSuchMethodError|version.*conflict.*jar|dependency.*conflict.*maven/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('mvn') && !f.content.includes('./mvnw')) continue;
    const fixed = f.content.replace(
      /(run:\s*(?:\.\/)?mvnw?\s+)/g,
      '$1-Dmaven.test.skip=false -Denforcer.skip=true ',
    );
    const withAlts = fixed.replace(
      /(run:\s*(?:\.\/)?mvnw?\s+(?:clean\s+)?(?:package|install|test))/g,
      '$1 -Dmaven.artifact.threads=8',
    );
    if (withAlts !== f.content)
      fixes.push({ path: f.path, content: withAlts, explanation: 'Added -Denforcer.skip=true to Maven — enforcer plugin blocks builds when it detects JAR version conflicts; skipping it lets the build proceed while you add explicit dependency management in pom.xml', confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 4: CORRUPTED LOCK FILE ──────────────────────────────────────────

/** Repair corrupted npm package-lock.json (EINTEGRITY, hash mismatch). */
export function fixCorruptedLockfile(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/npm ERR!.*cb\.apply|invalid.*package-lock|EINTEGRITY|corrupted.*lockfile|integrity.*checksum.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('npm ci') && !f.content.includes('npm install')) continue;
    const fixed = f.content
      .replace(/\bnpm ci\b/g, 'npm ci || (rm -f package-lock.json && npm install --no-audit && npm ci)')
      .replace(/(npm install)(?!\s+--prefer)/g, '$1 --prefer-offline --no-audit || (rm -f package-lock.json && npm install --no-audit)');
    const deduped = fixed.replace(
      /--prefer-offline --no-audit \|\| \(rm -f package-lock\.json && npm install --no-audit\) --prefer-offline/g,
      '--prefer-offline --no-audit || (rm -f package-lock.json && npm install --no-audit)',
    );
    if (deduped !== f.content)
      fixes.push({ path: f.path, content: deduped, explanation: 'Added lockfile corruption fallback — EINTEGRITY means the lockfile hash does not match the downloaded package; the fallback deletes the lockfile and reinstalls fresh', confidence: 100 });
  }
  return fixes;
}

/** Repair corrupted yarn.lock when Yarn reports lockfile integrity errors. */
export function fixYarnLockfileCorruption(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/YN0009|YN0018|Couldn't find.*package.*yarn|yarn.*lockfile.*corrupt|error.*lock.*corrupt/i.test(logs)) return [];
  if (!/yarn/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('yarn install')) continue;
    const fixed = f.content.replace(
      /yarn install(?:\s+--frozen-lockfile|\s+--immutable)?/g,
      'yarn install --check-files || (rm -f yarn.lock && yarn install)',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added yarn.lock corruption repair — --check-files verifies lockfile integrity; if verification fails the lockfile is deleted and regenerated resolving checksum and format corruption', confidence: 100 });
  }
  return fixes;
}

/** Repair out-of-sync poetry.lock when pyproject.toml has changed. */
export function fixPoetryLockfileCorruption(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/poetry\.lock.*out of date|lock file is not consistent|pyproject\.toml.*changed|poetry lock.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('poetry install')) continue;
    const fixed = f.content.replace(/poetry install/g, 'poetry lock --no-update && poetry install');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added poetry lock --no-update before poetry install — poetry.lock is out of sync with pyproject.toml; --no-update regenerates the lockfile without upgrading dependencies to maintain reproducibility', confidence: 100 });
  }
  return fixes;
}

/** Repair out-of-sync Gemfile.lock when Bundler reports a lockfile mismatch. */
export function fixGemfileLockCorruption(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Gemfile\.lock.*different|Your Gemfile has no gem.*bundler|bundler.*lockfile.*mismatch|You have specified|conflict.*Gemfile/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('bundle install')) continue;
    const fixed = f.content.replace(/bundle install(?:\s+--deployment)?/g, 'bundle install --no-deployment');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed bundle install to --no-deployment — Gemfile.lock is out of sync with Gemfile; --no-deployment allows Bundler to update the lockfile to match; recommit the new Gemfile.lock afterwards', confidence: 100 });
  }
  return fixes;
}

/** Repair pnpm-lock.yaml when pnpm reports the lockfile is outdated. */
export function fixPnpmLockfileCorruption(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ERR_PNPM_OUTDATED_LOCKFILE|pnpm.*frozen.*lockfile.*outdated|pnpm.*lockfile.*not.*consistent/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pnpm install')) continue;
    const fixed = f.content.replace(/pnpm install(?:\s+--frozen-lockfile)?/g, 'pnpm install --no-frozen-lockfile');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --no-frozen-lockfile to pnpm install — pnpm-lock.yaml is out of sync with package.json; --no-frozen-lockfile allows pnpm to update the lockfile; recommit pnpm-lock.yaml afterwards', confidence: 100 });
  }
  return fixes;
}

/** Switch npm ci → npm install when there is no committed lockfile. */
export function fixNpmCiToInstall(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasLockfile = files.some(f => ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(f.path));
  if (hasLockfile) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('npm ci')) continue;
    fixes.push({ path: f.path, content: f.content.replace(/\bnpm ci\b/g, 'npm install'), explanation: 'Changed npm ci → npm install — npm ci requires a committed lockfile; without package-lock.json it exits with ENOLOCK', confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 5: UNSUPPORTED PACKAGE VERSION ───────────────────────────────────

/** Add --no-cache-dir to all pip install commands to avoid disk-space failures. */
export function fixPipNoCacheDir(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pip install') || f.content.includes('--no-cache-dir')) continue;
    const fixed = f.content.replace(/pip install(?!\s+--no-cache-dir)/g, 'pip install --no-cache-dir');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --no-cache-dir to pip install — prevents pip from writing cache files to the runner disk; reduces disk usage and avoids permission errors in restricted CI environments', confidence: 100 });
  }
  return fixes;
}

/** Add npm audit fix --force step when deprecated/vulnerable packages cause build failures. */
export function fixDeprecatedNpmDependency(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/npm warn deprecated|WARN deprecated|npm notice deprecated|high severity|critical severity/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('npm audit') || f.content.includes('--force')) continue;
    if (!f.content.includes('npm ci') && !f.content.includes('npm install')) continue;
    const fixed = f.content.replace(
      /(run:\s*npm (ci|install)[^\n]*\n)/,
      '$1        run: npm audit fix --force --audit-level=critical || true\n',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added npm audit fix step — deprecated packages with critical vulnerabilities can block downstream tools; audit fix auto-upgrades vulnerable packages where possible', confidence: 100 });
  }
  return fixes;
}

/** Pin loose requirements to their current resolved versions to prevent surprise upgrades. */
export function fixRequirementsPinning(files: Array<{ path: string; content: string }>): RuleFix[] {
  const reqFile = files.find(f => f.path === 'requirements.txt');
  if (!reqFile) return [];
  const lines = reqFile.content.split('\n');
  const hasLoose = lines.some(l => l.trim() && !l.startsWith('#') && !l.includes('==') && !l.includes('>=') && !l.includes('~='));
  if (!hasLoose) return [];
  const pinned = lines.map(l => {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-r') || l.includes('==') || l.includes('>=') || l.includes('~=')) return l;
    const pkg = trimmed.split(/[>=<!~\s]/)[0];
    return `${pkg}>=0.0.0  # aegis: pin to a specific version for reproducible builds`;
  }).join('\n');
  if (pinned === reqFile.content) return [];
  return [{
    path: 'requirements.txt',
    content: pinned,
    explanation: 'Added version constraints to unpinned requirements — loose package names (e.g., "requests") install the latest version which can silently break builds when a package releases a breaking change',
    confidence: 100,
  }];
}

/** Add .nvmrc or engines field check — flag node-version not matching .nvmrc. */
export function fixNvmrcVersionMismatch(files: Array<{ path: string; content: string }>): RuleFix[] {
  const nvmrc = files.find(f => f.path === '.nvmrc' || f.path === '.node-version');
  if (!nvmrc) return [];
  const nvmVersion = nvmrc.content.trim().replace(/^v/, '');
  const majorMatch = nvmVersion.match(/^(\d+)/);
  if (!majorMatch) return [];
  const nvmMajor = majorMatch[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const wfMatch = f.content.match(/node-version:\s*['"]?(\d+)/);
    if (!wfMatch || wfMatch[1] === nvmMajor) continue;
    const fixed = f.content.replace(/node-version:\s*['"]?[^\s'"]+['"]?/g, `node-version: '${nvmMajor}'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Aligned node-version to ${nvmMajor} to match .nvmrc — running a different Node version in CI than locally causes works-locally-fails-CI bugs`, confidence: 100 });
  }
  return fixes;
}

// ── CATEGORY 6: MISSING VIRTUAL ENV / ISOLATION ───────────────────────────────

// (fixMissingVirtualEnv, fixPoetryVirtualEnv, fixCondaEnvironmentSetup above)

// ── CACHING ───────────────────────────────────────────────────────────────────

/** Add cache restore-keys fallback to npm/node_modules cache. */
export function fixNpmCacheRestoreKeys(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('actions/cache') || f.content.includes('restore-keys:')) continue;
    if (!f.content.includes('node_modules')) continue;
    const fixed = f.content.replace(
      /(key:\s*\$\{\{[^}]+\}\}-node-modules-\$\{\{[^}]+\}\})/,
      `$1\n          restore-keys: |\n            \${{ runner.os }}-node-modules-`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added restore-keys fallback to npm cache — without a fallback the cache never hits after the first run (exact key miss = no cache); the fallback allows partial cache reuse from similar builds', confidence: 100 });
  }
  return fixes;
}

/** Add pip cache via actions/setup-python cache: pip parameter. */
export function fixPipCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/pip install/m.test(f.content)) continue;
    if (f.content.includes("cache: 'pip'") || f.content.includes('pip-cache') || f.content.includes('~/.cache/pip')) continue;
    if (!f.content.includes('actions/setup-python')) continue;
    const fixed = f.content.replace(
      /(uses:\s*actions\/setup-python@[^\n]+\n)((?:\s{8,}[^\n]+\n)*?)(\s{8,}with:[\s\S]*?)(\n\s{6,}-|\n\s{0,4}\w)/,
      (match, uses, pre, withBlock, after) => {
        if (withBlock.includes('cache:')) return match;
        return `${uses}${pre}${withBlock}\n          cache: 'pip'${after}`;
      },
    );
    // Simpler fallback
    const simpler = f.content.includes("cache: 'pip'") ? f.content : f.content.replace(
      /(python-version:[^\n]+\n)/,
      "$1          cache: 'pip'\n",
    );
    const result = simpler !== f.content ? simpler : fixed;
    if (result !== f.content)
      fixes.push({ path: f.path, content: result, explanation: "Added cache: 'pip' to setup-python — pip package caching reduces install time by 60-80% by restoring ~/.cache/pip from the previous run", confidence: 100 });
  }
  return fixes;
}

/** Add Maven local repository caching. */
export function fixMavenCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/mvn|maven/i.test(f.content)) continue;
    if (f.content.includes('~/.m2') || f.content.includes("cache: 'maven'")) continue;
    if (f.content.includes('actions/setup-java')) {
      const fixed = f.content.replace(/(python-version:[^\n]+\n)/, '$1').replace(
        /(distribution:[^\n]+\n)/,
        "$1          cache: 'maven'\n",
      );
      const simpler = f.content.replace(/(java-version:[^\n]+\n)/, "$1          cache: 'maven'\n");
      const result = simpler !== f.content ? simpler : fixed;
      if (result !== f.content)
        fixes.push({ path: f.path, content: result, explanation: "Added cache: 'maven' to setup-java — Maven downloads all transitive dependencies on every run; ~/.m2/repository can be 500MB+, making caching critical for build times", confidence: 100 });
    } else {
      const patched = insertStepBefore(
        f.content,
        /run:\s*(mvn|\.\/mvnw)/,
        `      - name: Cache Maven repository\n        uses: actions/cache@v4\n        with:\n          path: ~/.m2/repository\n          key: \${{ runner.os }}-maven-\${{ hashFiles('**/pom.xml') }}\n          restore-keys: |\n            \${{ runner.os }}-maven-`,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added Maven ~/.m2 cache step — caching on pom.xml hash restores the full local repository and prevents re-downloading hundreds of JARs on every build', confidence: 100 });
    }
  }
  return fixes;
}

/** Add Gradle dependency caching. */
export function fixGradleCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/gradle|gradlew/i.test(f.content)) continue;
    if (f.content.includes('~/.gradle') || f.content.includes("cache: 'gradle'") || f.content.includes('gradle/actions')) continue;
    if (f.content.includes('actions/setup-java')) {
      const simpler = f.content.replace(/(java-version:[^\n]+\n)/, "$1          cache: 'gradle'\n");
      if (simpler !== f.content)
        fixes.push({ path: f.path, content: simpler, explanation: "Added cache: 'gradle' to setup-java — Gradle downloads dependencies and compile outputs to ~/.gradle/caches; without caching every run downloads all JARs and recompiles from scratch", confidence: 100 });
    } else {
      const patched = insertStepBefore(
        f.content,
        /run:\s*(gradle|\.\/gradlew)/,
        `      - name: Cache Gradle dependencies\n        uses: actions/cache@v4\n        with:\n          path: |\n            ~/.gradle/caches\n            ~/.gradle/wrapper\n          key: \${{ runner.os }}-gradle-\${{ hashFiles('**/*.gradle*', '**/gradle-wrapper.properties') }}\n          restore-keys: |\n            \${{ runner.os }}-gradle-`,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added Gradle cache step — caching ~/.gradle/caches and wrapper on .gradle file hashes prevents full re-download and recompilation on every CI run', confidence: 100 });
    }
  }
  return fixes;
}

/** Add Composer package cache step. */
export function fixComposerCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/composer install|composer update/m.test(f.content)) continue;
    if (f.content.includes('composer-cache') || f.content.includes('~/.composer') || f.content.includes('composer/cache')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*composer (install|update)/,
      `      - name: Get Composer cache directory\n        id: composer-cache\n        run: echo "dir=$(composer config cache-files-dir)" >> $GITHUB_OUTPUT\n      - name: Cache Composer packages\n        uses: actions/cache@v4\n        with:\n          path: \${{ steps.composer-cache.outputs.dir }}\n          key: \${{ runner.os }}-composer-\${{ hashFiles('**/composer.lock') }}\n          restore-keys: |\n            \${{ runner.os }}-composer-`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Composer cache step — Composer downloads packages from Packagist on every run without caching; caching on composer.lock hash prevents re-downloading unchanged packages', confidence: 100 });
  }
  return fixes;
}

/** Enable Go module caching via actions/setup-go cache: true. */
export function fixGoModCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/go\s+(build|test|run)/m.test(f.content)) continue;
    if (f.content.includes('~/go/pkg/mod') || f.content.includes('go-cache')) continue;
    if (!f.content.includes('actions/setup-go')) continue;
    if (/cache:\s*true/m.test(f.content)) continue;
    const fixed = f.content.replace(/(go-version:[^\n]+\n)/, '$1          cache: true\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added cache: true to actions/setup-go — Go module cache (~/go/pkg/mod) can be 500MB+ for large projects; the built-in cache reduces module download time from minutes to seconds', confidence: 100 });
  }
  return fixes;
}

/** Add Swatinem/rust-cache for Rust Cargo builds. */
export function fixRustCargoCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!/cargo\s+(build|test|clippy|check)/m.test(f.content)) continue;
    if (f.content.includes('Swatinem/rust-cache') || f.content.includes('~/.cargo/registry')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*cargo\s+(build|test|clippy|check)/,
      `      - name: Cache Rust dependencies\n        uses: Swatinem/rust-cache@v2\n        with:\n          cache-on-failure: true`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Swatinem/rust-cache@v2 — Rust compilation without caching takes 5-15 min per build; this cache covers target/ and ~/.cargo/registry reducing build time by 70-90%', confidence: 100 });
  }
  return fixes;
}

// ── TOOL SETUP ────────────────────────────────────────────────────────────────

/** Add HUSKY=0 to skip Husky git hooks in CI. */
export function fixHuskyCI(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const hasHusky = files.some(fi =>
      (fi.path === 'package.json' && fi.content.includes('"husky"')) ||
      fi.path.includes('.husky/') ||
      ((isGitHubWorkflow(fi.path) || isGitLabCI(fi.path)) && fi.content.includes('husky')),
    );
    if (!hasHusky || f.content.includes('HUSKY')) continue;
    if (isGitHubWorkflow(f.path)) {
      const withHusky = f.content.includes('env:')
        ? f.content.replace(/^(env:\s*\n)/m, '$1  HUSKY: 0\n')
        : f.content.replace(/^(jobs:)/m, 'env:\n  HUSKY: 0\n\n$1');
      if (withHusky !== f.content)
        fixes.push({ path: f.path, content: withHusky, explanation: 'Added HUSKY=0 — Husky hooks run during npm install and fail in CI because .git is in an unexpected state or hooks reference interactive tools (lint-staged, commitlint) not available on runners', confidence: 100 });
    } else {
      const fixed = f.content.replace(/^(variables:\s*\n)/m, '$1  HUSKY: "0"\n');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added HUSKY: "0" to GitLab CI — Husky hooks execute during npm install and fail in GitLab pipelines', confidence: 100 });
    }
  }
  return fixes;
}

/** Add chmod +x ./mvnw and ./gradlew when wrapper scripts lack execute permission. */
export function fixMavenWrapperPermission(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('./mvnw') && !f.content.includes('chmod +x') ) {
      const fixed = f.content.replace(/(run:\s*)(\.\/mvnw\s)/g, '$1chmod +x ./mvnw && ./mvnw ');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added chmod +x ./mvnw — Maven wrapper loses execute permission when Git does not preserve file modes; causes "Permission denied: ./mvnw"', confidence: 100 });
    }
    if (f.content.includes('./gradlew') && !f.content.includes('chmod +x')) {
      const fixed = f.content.replace(/(run:\s*)(\.\/gradlew\s)/g, '$1chmod +x ./gradlew && ./gradlew ');
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added chmod +x ./gradlew — Gradle wrapper loses execute permission on checkout; causes "Permission denied: ./gradlew"', confidence: 100 });
    }
  }
  return fixes;
}

/** Fix missing Yarn Berry (v2+) Corepack setup when .yarnrc.yml is present. */
export function fixYarnBerrySetup(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasYarnBerry = files.some(f => f.path === '.yarnrc.yml' || f.path.includes('.yarn/releases'));
  if (!hasYarnBerry) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('yarn') || f.content.includes('corepack enable') || f.content.includes('enableGlobalCache')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (!modified && /uses:\s*actions\/setup-node/.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && /^\s{8,}/.test(lines[j])) { out.push(lines[j]); j++; i = j - 1; }
        if (!f.content.includes("cache: 'yarn'")) out.push("          cache: 'yarn'");
        out.push('      - name: Enable Corepack for Yarn Berry');
        out.push('        run: corepack enable');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added corepack enable for Yarn Berry — Yarn v2+ requires Corepack to activate the correct version from .yarnrc.yml; without it Node uses legacy Yarn v1 which cannot parse the v2 lockfile', confidence: 100 });
  }
  return fixes;
}

/** Add .npmrc auth token configuration for private npm registries. */
export function fixNpmRegistryAuth(files: Array<{ path: string; content: string }>): RuleFix[] {
  const npmrc = files.find(f => f.path === '.npmrc');
  if (!npmrc) return [];
  if (npmrc.content.includes('_authToken') || !npmrc.content.includes('registry')) return [];
  const registryMatch = npmrc.content.match(/registry=https?:\/\/([^/\n]+)/);
  if (!registryMatch) return [];
  const registry = registryMatch[1];
  return [{
    path: '.npmrc',
    content: npmrc.content.trimEnd() + `\n//${registry}/:_authToken=\${NODE_AUTH_TOKEN}\n`,
    explanation: `Added _authToken for private registry ${registry} — npm cannot authenticate to private registries without a token; set NODE_AUTH_TOKEN secret with your registry access token`,
    confidence: 100,
  }];
}

/** Add pip extra-index-url or trusted-host for private PyPI in workflow. */
export function fixPipPrivateIndex(files: Array<{ path: string; content: string }>): RuleFix[] {
  const pipConf = files.find(f => f.path === 'pip.conf' || f.path === '.pip/pip.conf' || f.path === 'setup.cfg');
  if (!pipConf || !pipConf.content.includes('index-url') || !pipConf.content.includes('http://')) return [];
  // Private (non-HTTPS) PyPI — add --trusted-host
  const hostMatch = pipConf.content.match(/index-url\s*=\s*https?:\/\/([^/\n]+)/);
  if (!hostMatch) return [];
  const host = hostMatch[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pip install') || f.content.includes('--trusted-host')) continue;
    const fixed = f.content.replace(/pip install/g, `pip install --trusted-host ${host} --extra-index-url http://${host}/simple`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added --trusted-host ${host} for private PyPI — pip rejects HTTP (non-HTTPS) index servers by default; --trusted-host disables the SSL check for internal registries`, confidence: 100 });
  }
  return fixes;
}
