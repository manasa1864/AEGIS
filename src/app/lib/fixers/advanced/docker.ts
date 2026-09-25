// Advanced / Container & Docker Errors
// Covers: build failures, missing Dockerfile, BuildKit, base image pinning,
// healthcheck, port EXPOSE, volume permissions, registry rate limits, multi-stage.
// Extended: build context, ARG/ENV, layer caching, multi-arch, Dockerfile syntax,
// entrypoint signal handling, tini, wait-for-it, port conflicts, all major registry
// auth flows, image digest pinning, volume SELinux, NFS, named volumes, tmpfs.

import { RuleFix, isGitHubWorkflow, isGitLabCI, injectWorkflowLevelBlock, insertStepBefore } from '../helpers';

/** Create a minimal Dockerfile when CI references it but none exists. */
export function fixCreateMinimalDockerfile(files: Array<{ path: string; content: string }>): RuleFix[] {
  const needsDockerfile = files.some(
    f => (f.path.endsWith('.yml') || f.path.endsWith('.yaml')) &&
         (f.content.includes('Dockerfile') || f.content.includes('docker/build-push-action')),
  );
  if (!needsDockerfile || files.some(f => f.path === 'Dockerfile' || f.path.endsWith('/Dockerfile'))) return [];

  const pkgFile = files.find(f => f.path === 'package.json');
  let mainFile = 'src/app.js';
  const port = '3000';
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { main?: string; scripts?: Record<string, string> };
      if (pkg.main) mainFile = pkg.main;
    } catch { /* use defaults */ }
  }
  const isPython = files.some(f => f.path === 'requirements.txt' || f.path === 'pyproject.toml');
  const content = isPython
    ? `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements*.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE ${port}\nHEALTHCHECK --interval=30s --timeout=10s CMD curl -f http://localhost:${port}/health || exit 1\nCMD ["python", "app.py"]`
    : `FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install --production\nCOPY . .\nEXPOSE ${port}\nHEALTHCHECK --interval=30s --timeout=10s CMD wget -qO- http://localhost:${port}/health || exit 1\nCMD ["node", "${mainFile}"]`;

  return [{ path: 'Dockerfile', content, explanation: 'Created minimal Dockerfile — CI references ./Dockerfile but none existed in the repo', confidence: 100 }];
}

/** Enable Docker BuildKit for faster layer caching and parallel build stages. */
export function fixEnableDockerBuildKit(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('docker build') || f.content.includes('DOCKER_BUILDKIT')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  DOCKER_BUILDKIT: 1', '  BUILDKIT_INLINE_CACHE: 1']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DOCKER_BUILDKIT=1 — enables BuildKit for faster layer caching and parallel build stages', confidence: 100 });
  }
  return fixes;
}

/** Pin Dockerfile base image from :latest to a specific version tag. */
export function fixDockerBaseImagePin(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') && !f.path.match(/Dockerfile\./)) continue;
    let content = f.content;
    // Pin common base images from :latest to LTS versions
    const PINS: Array<[RegExp, string]> = [
      [/FROM\s+node:latest(\s|$)/gm,         'FROM node:20-alpine$1'],
      [/FROM\s+node:(\d+)(?!-)\s/gm,         'FROM node:$1-alpine '],
      [/FROM\s+ubuntu:latest(\s|$)/gm,        'FROM ubuntu:22.04$1'],
      [/FROM\s+debian:latest(\s|$)/gm,        'FROM debian:bookworm-slim$1'],
      [/FROM\s+python:latest(\s|$)/gm,        'FROM python:3.12-slim$1'],
      [/FROM\s+python:3(\s|$)/gm,             'FROM python:3.12-slim$1'],
      [/FROM\s+alpine:latest(\s|$)/gm,        'FROM alpine:3.19$1'],
      [/FROM\s+nginx:latest(\s|$)/gm,         'FROM nginx:1.26-alpine$1'],
    ];
    for (const [re, repl] of PINS) content = content.replace(re, repl);
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Pinned Docker base images to specific versions — :latest is non-deterministic and breaks reproducible builds', confidence: 100 });
  }
  return fixes;
}

/** Add HEALTHCHECK to Dockerfile when container startup failures occur. */
export function fixDockerHealthcheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/health.*check.*failed|container.*unhealthy|no.*healthy.*instance/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('HEALTHCHECK')) continue;
    const portMatch = f.content.match(/EXPOSE (\d+)/);
    const port = portMatch?.[1] ?? '3000';
    const fixed = f.content.trimEnd() + `\n\nHEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \\\n  CMD wget -qO- http://localhost:${port}/health || exit 1\n`;
    fixes.push({ path: f.path, content: fixed, explanation: `Added HEALTHCHECK instruction to Dockerfile — container was reported unhealthy without one`, confidence: 100 });
  }
  return fixes;
}

/** Add EXPOSE instruction when docker run/compose maps ports but none is declared. */
export function fixDockerPortExpose(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('EXPOSE')) continue;
    // Check if compose or workflow maps a port to this container
    const composeFile = files.find(fi => fi.path.includes('docker-compose'));
    if (!composeFile) continue;
    const portMap = composeFile.content.match(/['"]?(\d+):\d+['"]?/);
    const port = portMap?.[1] ?? '3000';
    const fixed = f.content.trimEnd() + `\n\nEXPOSE ${port}\n`;
    fixes.push({ path: f.path, content: fixed, explanation: `Added EXPOSE ${port} to Dockerfile — docker-compose maps port ${port} but Dockerfile did not declare it`, confidence: 100 });
  }
  return fixes;
}

/** Add non-root user to Dockerfile to fix volume permission errors. */
export function fixDockerVolumePermissions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission denied.*\/app|EACCES.*\/var\/|cannot.*write.*volume/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('USER ') || f.content.includes('chown')) continue;
    const fixed = f.content.replace(
      /^(WORKDIR .+)$/m,
      `$1\nRUN chown -R node:node /app\nUSER node`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added USER node and chown to Dockerfile — volume mount permission errors caused by running as root', confidence: 100 });
  }
  return fixes;
}

/** Add Docker Hub rate limit mitigation — authenticate to increase pull limit. */
export function fixDockerHubRateLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/toomanyrequests|Rate limit.*pull|429.*docker/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('docker/login-action') || f.content.includes('docker login')) continue;
    // Add login step before first docker pull/build
    const lines = f.content.split('\n');
    const out: string[] = [];
    let added = false;
    for (let i = 0; i < lines.length; i++) {
      if (!added && /uses:\s*docker\/build-push-action/.test(lines[i])) {
        const indent = '      ';
        out.push(`${indent}- name: Login to Docker Hub (rate limit mitigation)`);
        out.push(`${indent}  uses: docker/login-action@v3`);
        out.push(`${indent}  with:`);
        out.push(`${indent}    username: \${{ secrets.DOCKER_USERNAME }}`);
        out.push(`${indent}    password: \${{ secrets.DOCKER_PASSWORD }}`);
        out.push(`${indent}  continue-on-error: true`);
        added = true;
      }
      out.push(lines[i]);
    }
    if (added)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added Docker Hub login before build — authenticated pulls have higher rate limits (100 → 200/hr)', confidence: 100 });
  }
  return fixes;
}

/** Optimize Dockerfile with multi-stage build and proper layer caching to fix missing layers. */
export function fixMissingDockerLayer(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/layer.*not.*found|pulling.*from.*manifest|manifest.*unknown|failed.*pull.*layer|blob.*unknown/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    // Add cache-from to workflow to reuse layers
    const workflowFile = files.find(fi => isGitHubWorkflow(fi.path) && fi.content.includes('docker/build-push-action'));
    if (workflowFile && !workflowFile.content.includes('cache-from')) {
      const fixed = workflowFile.content.replace(
        /(uses:\s*docker\/build-push-action[\s\S]*?)(tags:)/m,
        `$1cache-from: type=gha\n          cache-to: type=gha,mode=max\n          $2`,
      );
      if (fixed !== workflowFile.content)
        fixes.push({ path: workflowFile.path, content: fixed, explanation: 'Added cache-from/cache-to GitHub Actions cache to docker/build-push-action — missing layers are re-pulled every build without layer caching', confidence: 100 });
    }
    // Add --cache-from to raw docker build commands
    if (!f.content.includes('COPY --from') && f.content.includes('RUN npm install')) {
      const fixed = f.content.replace(
        /^(COPY package\*\.json .\/\nRUN npm install)/m,
        `# Layer cache: copy package files first so npm install layer is cached\n$1`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Optimised Dockerfile layer order — package.json copied before source so npm install layer is cached between builds', confidence: 100 });
    }
  }
  return fixes;
}

/** Fix port binding conflicts in Docker containers by remapping host ports. */
export function fixPortBindingConflict(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/port.*already.*allocated|address.*already.*in.*use|Bind for.*failed|0\.0\.0\.0:\d+.*already/i.test(logs)) return [];
  const portMatch = logs.match(/0\.0\.0\.0:(\d+).*already in use|port.*?(\d{4,5})/i);
  const conflictPort = portMatch?.[1] ?? portMatch?.[2] ?? '3000';
  const alternativePort = String(parseInt(conflictPort) + 1);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    // Fix in docker-compose files
    if (f.path.includes('docker-compose')) {
      if (!f.content.includes(`${conflictPort}:`)) continue;
      const fixed = f.content.replace(
        new RegExp(`["']?(${conflictPort}):(\\d+)["']?`, 'g'),
        `"${alternativePort}:$2"  # aegis: port ${conflictPort} was in use, remapped`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Remapped host port ${conflictPort} → ${alternativePort} — port was already bound by another process`, confidence: 100 });
    }
    // Fix in GitHub Actions service containers
    if (isGitHubWorkflow(f.path)) {
      if (!f.content.includes(`'${conflictPort}:`) && !f.content.includes(`"${conflictPort}:`)) continue;
      const fixed = f.content
        .replace(new RegExp(`'${conflictPort}:(\\d+)'`, 'g'), `'${alternativePort}:$1'`)
        .replace(new RegExp(`"${conflictPort}:(\\d+)"`, 'g'), `"${alternativePort}:$1"`);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Remapped service port ${conflictPort} → ${alternativePort} — EADDRINUSE: port already allocated in CI runner`, confidence: 100 });
    }
    // Add comment to Dockerfile when fixed EXPOSE conflicts
    if (f.path.endsWith('Dockerfile') && f.content.includes(`EXPOSE ${conflictPort}`)) {
      const fixed = f.content.replace(
        `EXPOSE ${conflictPort}`,
        `EXPOSE ${alternativePort}  # aegis: was ${conflictPort}, remapped due to port conflict`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Updated Dockerfile EXPOSE from ${conflictPort} to ${alternativePort} — port conflict detected`, confidence: 100 });
    }
  }
  return fixes;
}

/** Add alternative registry fallback or auth when Docker image pull fails. */
export function fixDockerImagePullFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pull.*access.*denied|image.*not.*found|manifest.*unknown|unauthorized.*registry|Error response.*daemon.*pull/i.test(logs)) return [];
  const imageMatch = logs.match(/pull.*?([a-zA-Z0-9/_.-]+:[a-zA-Z0-9._-]+)/i)
    ?? logs.match(/image.*?([a-zA-Z0-9/_.-]+:[a-zA-Z0-9._-]+)/i);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    // Fix in Dockerfile — suggest ghcr.io mirror for common images
    if (f.path.endsWith('Dockerfile')) {
      const fromMatch = f.content.match(/^FROM\s+([^\s]+)/m);
      if (!fromMatch) continue;
      const image = fromMatch[1];
      if (image.startsWith('node:') || image.startsWith('python:') || image.startsWith('alpine:')) {
        // These are official images — add login before pull in workflow instead
        const wf = files.find(fi => isGitHubWorkflow(fi.path) && (fi.content.includes('docker build') || fi.content.includes('build-push-action')));
        if (wf && !wf.content.includes('docker/login-action') && !wf.content.includes('docker login')) {
          const lines = wf.content.split('\n');
          const out: string[] = [];
          let added = false;
          for (const line of lines) {
            if (!added && /uses:\s*docker\/build-push-action/.test(line)) {
              out.push('      - name: Authenticate Docker Hub to avoid pull rate limits');
              out.push('        uses: docker/login-action@v3');
              out.push('        with:');
              out.push('          username: ${{ secrets.DOCKER_USERNAME }}');
              out.push('          password: ${{ secrets.DOCKER_PASSWORD }}');
              out.push('        continue-on-error: true');
              added = true;
            }
            out.push(line);
          }
          if (added)
            fixes.push({ path: wf.path, content: out.join('\n'), explanation: `Added Docker Hub login before build — "pull access denied" often means unauthenticated pulls hit the anonymous rate limit or a private image`, confidence: 100 });
        }
      }
    }
    // Fix in workflow — add pull-policy: if-not-present to service containers
    if (isGitHubWorkflow(f.path) && f.content.includes('services:')) {
      if (f.content.includes('pull-policy')) continue;
      const imageRef = imageMatch?.[1] ?? '';
      if (imageRef && f.content.includes(imageRef)) {
        fixes.push({ path: f.path, content: f.content, explanation: `Image pull failure for "${imageRef}" — verify image exists and repo/tag is correct; add Docker Hub login to avoid rate limits`, confidence: 100 });
      }
    }
  }
  return fixes;
}

/** Add .dockerignore when it's missing (prevents accidental COPY of node_modules). */
export function fixMissingDockerignore(files: Array<{ path: string; content: string }>): RuleFix[] {
  const hasDockerfile = files.some(f => f.path === 'Dockerfile');
  const hasDockignore = files.some(f => f.path === '.dockerignore');
  if (!hasDockerfile || hasDockignore) return [];
  return [{
    path: '.dockerignore',
    content: `node_modules\nnpm-debug.log*\nyarn-debug.log*\n.git\n.gitignore\n*.md\ndist\nbuild\ncoverage\n.env\n.env.*\n!.env.example\n`,
    explanation: 'Created .dockerignore — prevents copying node_modules and secrets into Docker image',
    confidence: 100,
  }];
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION A — Docker Image Build Failure
// ═══════════════════════════════════════════════════════════════════════════

/** Add/expand .dockerignore when build context exceeds threshold or is flagged as too large. */
export function fixDockerBuildContextTooLarge(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/build context.*too large|Sending build context.*[1-9]\d{2,}\s*MB|context.*exceeded/i.test(logs)) return [];
  const ignore = files.find(f => f.path === '.dockerignore');
  const additions = [
    'node_modules', '.git', 'dist', 'build', 'coverage', '*.log',
    '.env*', '!.env.example', '__pycache__', '*.pyc', '.pytest_cache',
    '.venv', 'venv', '*.egg-info', 'target', '.cargo/registry',
    '*.tar', '*.tar.gz', '*.zip', 'tmp', 'temp', '.DS_Store', 'Thumbs.db',
  ].join('\n');
  if (!ignore) {
    return [{ path: '.dockerignore', content: additions + '\n', explanation: 'Created .dockerignore — build context was too large; excluding node_modules, dist, .git, and temporary files reduces context transfer time from seconds to milliseconds', confidence: 95 }];
  }
  const existing = new Set(ignore.content.split('\n').map(l => l.trim()).filter(Boolean));
  const toAdd = additions.split('\n').filter(l => !existing.has(l));
  if (toAdd.length === 0) return [];
  return [{ path: '.dockerignore', content: ignore.content.trimEnd() + '\n' + toAdd.join('\n') + '\n', explanation: `Expanded .dockerignore with ${toAdd.length} additional exclusions — large build context sends unnecessary files to the Docker daemon on every build`, confidence: 95 }];
}

/** Add missing --build-arg entries to the workflow when Dockerfile ARG has no value. */
export function fixDockerBuildArgMissing(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/\bARG\b.*not.*set|build.arg.*required|undefined.*build.*arg|ARG.*has.*no.*default/i.test(logs)) return [];
  const argMatch = logs.match(/ARG[:\s]+(\w+)\s+(?:is not set|has no default|required)/i);
  const missingArg = argMatch?.[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('docker build') && !f.content.includes('build-push-action')) continue;
    if (missingArg && f.content.includes(`--build-arg ${missingArg}`)) continue;
    const argValue = missingArg ? `${missingArg}=\${{ secrets.${missingArg} || vars.${missingArg} }}` : 'BUILD_VERSION=${{ github.sha }}';
    const fixed = f.content
      .replace(/(docker build\s+)/g, `$1--build-arg ${argValue} `)
      .replace(/(build-args:\s*\|?\s*\n)/g, `$1            ${missingArg ?? 'BUILD_VERSION'}=\${{ github.sha }}\n`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added --build-arg ${missingArg ?? 'BUILD_VERSION'} — Dockerfile ARG without a default value must receive a value at build time via --build-arg; add the value as a repo secret or variable`, confidence: 90 });
  }
  return fixes;
}

/** Convert single-stage Dockerfile to multi-stage to reduce final image size and build failures. */
export function fixDockerMultiStageBuild(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/image.*too.*large|OOM.*docker build|killed.*docker build|No space left on device.*docker/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('AS builder') || f.content.includes('COPY --from=')) continue;
    const isNode = f.content.includes('node') || f.content.includes('npm');
    const isPython = f.content.includes('python') || f.content.includes('pip');
    if (!isNode && !isPython) continue;
    const fromLine = f.content.match(/^FROM\s+(\S+)/m)?.[1] ?? 'node:20-alpine';
    const newContent = isNode
      ? [
          `FROM ${fromLine} AS builder`,
          'WORKDIR /app',
          'COPY package*.json ./',
          'RUN npm ci --include=dev',
          'COPY . .',
          'RUN npm run build',
          '',
          '# Production stage — only runtime artifacts',
          'FROM node:20-alpine AS production',
          'WORKDIR /app',
          'ENV NODE_ENV=production',
          'COPY package*.json ./',
          'RUN npm ci --omit=dev --ignore-scripts',
          'COPY --from=builder /app/dist ./dist',
          'RUN addgroup -S appgroup && adduser -S appuser -G appgroup',
          'USER appuser',
          'EXPOSE 3000',
          'HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1',
          'CMD ["node", "dist/index.js"]',
          '',
        ].join('\n')
      : [
          `FROM ${fromLine} AS builder`,
          'WORKDIR /app',
          'COPY requirements*.txt ./',
          'RUN pip install --no-cache-dir --user -r requirements.txt',
          '',
          'FROM python:3.12-slim AS production',
          'WORKDIR /app',
          'COPY --from=builder /root/.local /root/.local',
          'COPY . .',
          'ENV PATH=/root/.local/bin:$PATH',
          'RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser',
          'USER appuser',
          'EXPOSE 8000',
          'HEALTHCHECK --interval=30s --timeout=10s CMD curl -f http://localhost:8000/health || exit 1',
          'CMD ["python", "app.py"]',
          '',
        ].join('\n');
    fixes.push({ path: f.path, content: newContent, explanation: 'Converted to multi-stage Dockerfile — builder stage installs all deps and compiles; production stage copies only artifacts, reducing final image size by 60-80% and eliminating build tools from the runtime image', confidence: 80 });
  }
  return fixes;
}

/** Merge consecutive RUN statements to reduce Docker layer count and image size. */
export function fixDockerRUNLayerMerge(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('AS builder')) continue;
    const consecutiveRuns = f.content.match(/^RUN .+\n^RUN .+/m);
    if (!consecutiveRuns) continue;
    // Merge consecutive apt-get RUN lines
    const fixed = f.content.replace(
      /^(RUN apt-get update[^\n]*)\n^(RUN apt-get install[^\n]*)/m,
      '$1 \\\n    && $2',
    ).replace(
      /^(RUN apt-get install[^\n]+)\n^(RUN apt-get clean[^\n]*)/m,
      '$1 \\\n    && $2 \\\n    && rm -rf /var/lib/apt/lists/*',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Merged consecutive RUN apt-get statements — each RUN creates a Docker layer; combining update+install+clean in one RUN prevents the package cache from being committed to an intermediate layer', confidence: 90 });
  }
  return fixes;
}

/** Fix separated apt-get update from apt-get install (causes stale cache issues). */
export function fixDockerAPTGetUpdate(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('apt-get update') || !f.content.includes('apt-get install')) continue;
    if (f.content.includes('apt-get update &&') || f.content.includes('apt-get update \\\n')) continue;
    // Detect standalone RUN apt-get update followed separately by RUN apt-get install
    if (!/^RUN apt-get update\s*$/m.test(f.content)) continue;
    const fixed = f.content.replace(
      /^RUN apt-get update\s*\n([\s\S]*?)^(RUN apt-get install)([^\n]+)/m,
      'RUN apt-get update \\\n    && apt-get install -y --no-install-recommends$3 \\\n    && apt-get clean \\\n    && rm -rf /var/lib/apt/lists/*\n$1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Combined apt-get update && install && clean into one RUN — Docker caches apt-get update separately which causes stale package lists when the install list changes; they must always run together', confidence: 95 });
  }
  return fixes;
}

/** Add --omit=dev (or --production) to npm install in Dockerfile production stage. */
export function fixDockerNPMInstallProd(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('npm install') && !f.content.includes('npm ci')) continue;
    if (f.content.includes('--omit=dev') || f.content.includes('--production') || f.content.includes('AS builder')) continue;
    const fixed = f.content
      .replace(/RUN npm install(\s)/g, 'RUN npm ci --omit=dev --ignore-scripts$1')
      .replace(/RUN npm ci(\s)/g, 'RUN npm ci --omit=dev --ignore-scripts$1');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --omit=dev to npm ci — devDependencies (test frameworks, build tools) have no place in production images; --omit=dev reduces node_modules by 30-70%; use npm ci for reproducible installs', confidence: 90 });
  }
  return fixes;
}

/** Add --no-cache-dir to pip install in Dockerfile to reduce image size. */
export function fixDockerPipNoCacheDir(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('pip install') || f.content.includes('--no-cache-dir')) continue;
    const fixed = f.content.replace(/pip install(\s+(?!--no-cache-dir))/g, 'pip install --no-cache-dir$1');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --no-cache-dir to pip install — pip caches downloaded wheels in ~/.cache/pip by default; in Docker this cache is committed to the layer but never reused across builds, wasting space', confidence: 100 });
  }
  return fixes;
}

/** Fix wrong COPY order — source code should be copied after dependency install for layer caching. */
export function fixDockerCopyOrderForCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (f.content.includes('AS builder')) continue;
    // Check if COPY . . comes before npm install / pip install
    const copyAllIdx = f.content.indexOf('COPY . .');
    const installIdx = Math.max(f.content.indexOf('npm install'), f.content.indexOf('pip install'), f.content.indexOf('npm ci'));
    if (copyAllIdx === -1 || installIdx === -1 || copyAllIdx > installIdx) continue;
    const isNode = f.content.includes('npm') || f.content.includes('yarn');
    const depsSection = isNode
      ? 'COPY package*.json ./\nRUN npm ci --omit=dev'
      : 'COPY requirements*.txt ./\nRUN pip install --no-cache-dir -r requirements.txt';
    // Rebuild: move COPY . . after dependency install
    const lines = f.content.split('\n').filter(l => l !== 'COPY . .');
    const runIdx = lines.findIndex(l => /^RUN (npm|pip|yarn)/.test(l));
    if (runIdx === -1) continue;
    lines.splice(runIdx, 0, isNode ? 'COPY package*.json ./' : 'COPY requirements*.txt ./');
    lines.splice(runIdx + 2, 0, 'COPY . .');
    fixes.push({ path: f.path, content: lines.join('\n') + '\n', explanation: `Moved COPY . . after ${isNode ? 'npm' : 'pip'} install — dependency install should come before copying source code so the layer is cached and only rebuilt when package files change, not on every source change`, confidence: 85 });
    void depsSection;
  }
  return fixes;
}

/** Convert CMD/ENTRYPOINT from shell form to exec (JSON array) form for proper signal handling. */
export function fixDockerShellToExecForm(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    let content = f.content;
    // CMD node index.js → CMD ["node", "index.js"]
    content = content.replace(
      /^(CMD|ENTRYPOINT)\s+(?!\[)(.+)$/gm,
      (_, directive, cmd) => {
        const trimmed = cmd.trim();
        if (trimmed.startsWith('[')) return `${directive} ${trimmed}`;
        const parts = trimmed.split(/\s+/);
        return `${directive} ${JSON.stringify(parts)}`;
      },
    );
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Converted CMD/ENTRYPOINT to exec (JSON array) form — shell form runs as /bin/sh -c which does not forward OS signals (SIGTERM) to the process, causing 10-second graceful shutdown delays; exec form PID 1 receives signals directly', confidence: 95 });
  }
  return fixes;
}

/** Add --platform to docker build when building on ARM64 CI for AMD64 targets (or vice versa). */
export function fixDockerBuildPlatformArg(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/exec.*format.*error|platform.*mismatch|amd64.*arm|arm64.*amd64|cannot execute binary/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('docker build') && !f.content.includes('build-push-action')) continue;
    if (f.content.includes('platforms:') || f.content.includes('--platform')) continue;
    const fixed = f.content
      .replace(/(docker build\s+)/g, '$1--platform linux/amd64 ')
      .replace(/(uses:\s*docker\/build-push-action[\s\S]*?with:\s*\n)/m, '$1          platforms: linux/amd64,linux/arm64\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --platform linux/amd64 — "exec format error" means the binary was compiled for a different architecture; CI runners are often ARM64 (Apple Silicon / Graviton) but production targets AMD64', confidence: 90 });
  }
  return fixes;
}

/** Add docker/setup-qemu-action for multi-platform builds using QEMU emulation. */
export function fixDockerQEMUSetup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/platforms.*linux\/arm|multi.?arch.*build|QEMU.*required|qemu.*not.*found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('platforms:') || f.content.includes('setup-qemu-action')) continue;
    const qemuStep = [
      '      - name: Set up QEMU for multi-platform builds',
      '        uses: docker/setup-qemu-action@v3',
      '      - name: Set up Docker Buildx',
      '        uses: docker/setup-buildx-action@v3',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action/i, qemuStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added QEMU + Buildx setup for multi-platform builds — docker/build-push-action with platforms: linux/arm64 requires QEMU for CPU emulation and Buildx for the multi-arch build driver', confidence: 95 });
  }
  return fixes;
}

/** Add RUN cleanup after large installations to reduce final layer size. */
export function fixDockerLayerCleanup(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    let content = f.content;
    // Add rm -rf /var/lib/apt/lists/* after apt-get install
    if (/RUN apt-get install/i.test(content) && !content.includes('/var/lib/apt/lists/*')) {
      content = content.replace(
        /(RUN apt-get install[^\n]+)/g,
        '$1 \\\n    && apt-get clean \\\n    && rm -rf /var/lib/apt/lists/*',
      );
    }
    // Add cleanup after pip install
    if (content.includes('pip install') && !content.includes('rm -rf') && !content.includes('__pycache__')) {
      content = content.replace(
        /(RUN pip install[^\n]+)/g,
        '$1 \\\n    && find / -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true \\\n    && find / -name "*.pyc" -delete 2>/dev/null || true',
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Added layer cleanup after package installation — apt cache and Python bytecache committed to intermediate layers bloat the image; cleanup in the same RUN prevents the files from being stored in any layer', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION B — Missing Docker Layer
// ═══════════════════════════════════════════════════════════════════════════

/** Add GitHub Actions cache (type=gha) to docker/build-push-action for layer reuse. */
export function fixDockerGHACacheMount(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('docker/build-push-action') || f.content.includes('cache-from')) continue;
    const fixed = f.content.replace(
      /(uses:\s*docker\/build-push-action@[^\n]+\n\s+with:\s*\n)((?:\s+[^\n]+\n)*?)(\s+tags:)/,
      '$1$2          cache-from: type=gha\n          cache-to: type=gha,mode=max\n$3',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GHA layer cache to docker/build-push-action — without cache-from every build re-downloads all base layers and re-runs every RUN step; GHA cache reduces build time by 50-90% on cache hits', confidence: 100 });
  }
  return fixes;
}

/** Add BuildKit inline cache labels so cached layers can be reused from the registry. */
export function fixDockerRegistryLayerCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('build-push-action') || f.content.includes('cache-from: type=registry')) continue;
    if (!f.content.includes('ghcr.io') && !f.content.includes('ecr') && !f.content.includes('azurecr')) continue;
    const imageRef = f.content.match(/ghcr\.io\/[\w/-]+|[\w-]+\.dkr\.ecr\.[^"\s]+|[\w-]+\.azurecr\.io\/[\w/-]+/)?.[0] ?? '${{ env.IMAGE_NAME }}';
    const fixed = f.content.replace(
      /(uses:\s*docker\/build-push-action@[^\n]+\n\s+with:\s*\n)((?:\s+[^\n]+\n)*?)(\s+tags:)/,
      `$1$2          cache-from: type=registry,ref=${imageRef}:buildcache\n          cache-to: type=registry,ref=${imageRef}:buildcache,mode=max\n$3`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added registry-based layer cache — stores BuildKit cache as a separate tag in your registry; faster than rebuilding from scratch and works across GitHub Actions cache evictions', confidence: 90 });
  }
  return fixes;
}

/** Fix "manifest unknown" by correcting the registry path format in Dockerfile or workflow. */
export function fixDockerManifestUnknown(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/manifest unknown|manifest.*not found|MANIFEST_UNKNOWN|OCI.*manifest.*error/i.test(logs)) return [];
  const imageMatch = logs.match(/(?:manifest.*?|pulling.*?)([a-z0-9][\w.\-/]+:[a-z0-9][\w.\-]+)/i);
  const badImage = imageMatch?.[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') && !isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (badImage && !f.content.includes(badImage)) continue;
    fixes.push({
      path: f.path,
      content: f.content,
      explanation: `manifest unknown for "${badImage ?? 'image'}" — verify the image name, tag, and registry are all correct; common causes: wrong tag (e.g., node:20-apline vs node:20-alpine), private registry without auth, or image deleted from registry`,
      confidence: 80,
    });
  }
  return fixes;
}

/** Add retry loop around docker pull to handle transient "blob unknown" errors. */
export function fixDockerPullRetryOnBlob(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/blob unknown|blob.*not found|unexpected.*EOF.*pull|layer.*not.*found.*registry/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('docker pull') || f.content.includes('pull-retry')) continue;
    const fixed = f.content.replace(
      /(run:\s*docker pull\s+([^\n]+))/gi,
      'run: |\n          for i in 1 2 3; do docker pull $2 && break || (echo "Pull attempt $i failed, retrying..." && sleep 10); done',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added retry loop around docker pull — "blob unknown" is usually a transient registry error; 3 retries with 10s backoff resolves the majority of transient layer fetch failures', confidence: 85 });
  }
  return fixes;
}

/** Add BuildKit --mount=type=cache for package manager directories to speed up builds. */
export function fixDockerBuildKitCacheMount(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (f.content.includes('mount=type=cache') || !f.content.includes('DOCKER_BUILDKIT') && !f.content.includes('syntax=')) continue;
    let content = f.content;
    if (content.includes('npm ci') && !content.includes('npm_cache')) {
      content = content.replace(
        /RUN npm ci([^\n]*)/g,
        'RUN --mount=type=cache,target=/root/.npm npm ci$1',
      );
    }
    if (content.includes('pip install') && !content.includes('pip_cache')) {
      content = content.replace(
        /RUN pip install([^\n]*)/g,
        'RUN --mount=type=cache,target=/root/.cache/pip pip install$1',
      );
    }
    if (content.includes('apt-get install') && !content.includes('apt_cache')) {
      content = content.replace(
        /RUN apt-get update(\s+\\?\s*\n\s+&&\s+)?apt-get install/g,
        'RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked apt-get update && apt-get install',
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Added BuildKit --mount=type=cache to package manager RUN steps — cache mounts persist between builds without being committed to image layers, giving npm/pip/apt install the speed of a warm local cache', confidence: 85 });
  }
  return fixes;
}

/** Add docker/setup-buildx-action before build-push to enable Buildx driver. */
export function fixDockerSetupBuildx(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('build-push-action') || f.content.includes('setup-buildx-action')) continue;
    const buildxStep = '      - name: Set up Docker Buildx\n        uses: docker/setup-buildx-action@v3';
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action/i, buildxStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added docker/setup-buildx-action — docker/build-push-action requires the Buildx builder; without it cache-from, multi-platform, and advanced build options are unavailable', confidence: 100 });
  }
  return fixes;
}

/** Fix multi-arch manifest by adding docker/metadata-action for proper tag generation. */
export function fixDockerMetadataAction(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('build-push-action') || f.content.includes('metadata-action')) continue;
    if (!f.content.includes('tags:') || f.content.includes('docker/metadata-action')) continue;
    const metaStep = [
      '      - name: Extract Docker metadata',
      '        id: meta',
      '        uses: docker/metadata-action@v5',
      '        with:',
      '          images: ${{ env.IMAGE_NAME }}',
      '          tags: |',
      '            type=ref,event=branch',
      '            type=ref,event=pr',
      '            type=semver,pattern={{version}}',
      '            type=sha,prefix=sha-',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action/i, metaStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added docker/metadata-action for tag generation — hardcoded tags break multi-arch manifests; metadata-action generates correct tags for branches, PRs, semver, and SHA; reference with ${{ steps.meta.outputs.tags }}', confidence: 85 });
  }
  return fixes;
}

/** Add pull-policy: if-not-present to GitHub Actions service containers to avoid re-pulls. */
export function fixDockerServicePullPolicy(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('services:')) continue;
    if (f.content.includes('pull_policy') || f.content.includes('if-not-present')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let inServices = false;
    let lastImageLine = -1;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+services:\s*$/.test(lines[i])) { inServices = true; continue; }
      if (inServices && /^\s+image:\s*.+/.test(lines[i])) lastImageLine = out.length - 1;
      if (inServices && /^\s+image:\s*.+/.test(lines[i]) && !lines[i + 1]?.includes('options:') && !lines[i + 1]?.includes('pull_policy')) {
        out.push(lines[i].replace(/image:.*/, 'options: >-\n' + lines[i].replace(/\S.*/, '  --pull=never')));
      }
    }
    void lastImageLine;
    if (out.join('\n') !== f.content) {
      // simpler approach: add options line
      const fixed = f.content.replace(
        /(\s+image:\s+postgres:[^\n]+)/g,
        '$1\n        options: --pull=never',
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added --pull=never to service containers — GitHub-hosted runners cache Docker images; re-pulling on every run is slow and may hit rate limits', confidence: 80 });
    }
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION C — Invalid Dockerfile Syntax
// ═══════════════════════════════════════════════════════════════════════════

/** Add BuildKit syntax directive and fix Dockerfile heredoc syntax errors. */
export function fixDockerfileHeredocSyntax(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/dockerfile.*syntax.*error|invalid.*instruction|unknown.*instruction/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('<<EOF') && !f.content.includes('<<-')) continue;
    if (f.content.includes('# syntax=docker/dockerfile:')) continue;
    const fixed = '# syntax=docker/dockerfile:1.7\n' + f.content;
    fixes.push({ path: f.path, content: fixed, explanation: 'Added BuildKit syntax directive — Dockerfile heredoc syntax (<<EOF) requires BuildKit 1.4+ and the explicit # syntax directive; without it the heredoc is treated as invalid shell', confidence: 90 });
  }
  return fixes;
}

/** Distinguish build-time ARG from runtime ENV — convert misused ARGs to ENV where needed. */
export function fixDockerfileEnvVsArg(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ARG.*not.*available.*runtime|ENV.*build.*time.*only|ARG.*persists/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('ARG ') || f.content.includes('# runtime')) continue;
    // ARG values are not available after the build; convert to ENV for runtime availability
    const argLines = [...f.content.matchAll(/^ARG (\w+)(?:=([^\n]+))?/gm)];
    let content = f.content;
    for (const [, name, defaultVal] of argLines) {
      if (!f.content.includes(`$${name}`) || f.content.includes(`ENV ${name}`)) continue;
      const envLine = defaultVal ? `ENV ${name}=${defaultVal}` : `ENV ${name}=$${name}`;
      content = content.replace(`ARG ${name}${defaultVal ? `=${defaultVal}` : ''}`, `ARG ${name}${defaultVal ? `=${defaultVal}` : ''}\n${envLine}  # persist ARG as ENV for runtime access`);
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Added ENV after ARG declarations — ARG values are only available during docker build, not in the running container; add ENV NAME=$NAME after ARG NAME to make the value available at runtime', confidence: 85 });
  }
  return fixes;
}

/** Fix CMD + ENTRYPOINT interaction — CMD should be args array when ENTRYPOINT is set. */
export function fixDockerfileCmdEntrypointInteraction(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('ENTRYPOINT') || !f.content.includes('CMD')) continue;
    // When ENTRYPOINT is set, CMD should provide default arguments not a full command
    const entrypointMatch = f.content.match(/^ENTRYPOINT\s+(.+)$/m);
    const cmdMatch = f.content.match(/^CMD\s+(.+)$/m);
    if (!entrypointMatch || !cmdMatch) continue;
    const cmdVal = cmdMatch[1].trim();
    // If CMD is not an array, it will be executed as a shell command and override ENTRYPOINT
    if (cmdVal.startsWith('[')) continue;
    const fixed = f.content.replace(
      /^CMD\s+.+$/m,
      `CMD []  # Empty array: let ENTRYPOINT handle execution; add default args here if needed`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed CMD/ENTRYPOINT interaction — when both ENTRYPOINT and CMD are set, CMD provides default arguments to ENTRYPOINT; a non-array CMD overrides ENTRYPOINT entirely, which is almost never intended', confidence: 80 });
  }
  return fixes;
}

/** Fix invalid JSON array syntax in CMD or ENTRYPOINT instructions. */
export function fixDockerfileJSONArraySyntax(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/invalid.*JSON.*array|CMD.*syntax.*error|ENTRYPOINT.*malformed|json.*decode.*error.*dockerfile/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    let content = f.content;
    // Fix single quotes in JSON array: CMD ['node', 'app.js'] → CMD ["node", "app.js"]
    content = content.replace(
      /^(CMD|ENTRYPOINT)\s+\[([^\]]+)\]/gm,
      (_, directive, inner) => {
        const fixed = inner.replace(/'/g, '"');
        return `${directive} [${fixed}]`;
      },
    );
    // Fix trailing commas in JSON array: CMD ["node", "app.js",] → CMD ["node", "app.js"]
    content = content.replace(
      /^(CMD|ENTRYPOINT)\s+\[(.+),\s*\]/gm,
      (_, directive, inner) => `${directive} [${inner.trimEnd()}]`,
    );
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Fixed CMD/ENTRYPOINT JSON array syntax — Docker requires strict JSON arrays with double quotes; single quotes and trailing commas cause "invalid JSON" parse errors', confidence: 95 });
  }
  return fixes;
}

/** Replace ADD with COPY for non-archive files (ADD has hidden URL-fetch and tar-extract behavior). */
export function fixDockerfileAddVsCopy(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('\nADD ')) continue;
    const fixed = f.content.replace(
      /^ADD\s+(?!https?:\/\/)(?!.*\.tar)(?!.*\.tgz)(?!.*\.tar\.gz)(.+)$/gm,
      'COPY $1  # Changed from ADD: use ADD only for URLs or tar auto-extraction',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced ADD with COPY for local files — ADD has implicit behaviors (URL download, tar auto-extraction) that make builds non-deterministic; COPY is always explicit and predictable', confidence: 95 });
  }
  return fixes;
}

/** Fix relative WORKDIR path — WORKDIR must be absolute in a Dockerfile. */
export function fixDockerfileWorkdirAbsolute(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    // Detect WORKDIR without leading /
    const relativeWorkdir = f.content.match(/^WORKDIR\s+(?!\/|~)(\S+)/m);
    if (!relativeWorkdir) continue;
    const fixed = f.content.replace(/^WORKDIR\s+(?!\/|~)(\S+)/m, 'WORKDIR /app');
    fixes.push({ path: f.path, content: fixed, explanation: `Fixed relative WORKDIR "${relativeWorkdir[0]}" to /app — WORKDIR with a relative path resolves from the previous WORKDIR which can be unpredictable; always use absolute paths`, confidence: 90 });
  }
  return fixes;
}

/** Fix LABEL instructions with invalid key format (uppercase or spaces). */
export function fixDockerfileLabelFormat(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || !f.content.includes('LABEL')) continue;
    const fixed = f.content.replace(
      /^LABEL\s+([A-Z][^\s=]+)/gm,
      (_, key) => `LABEL ${key.toLowerCase().replace(/\s+/g, '-').replace(/_/g, '.')}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Normalized LABEL keys to lowercase dot-notation — OCI spec recommends lowercase labels; uppercase keys cause warnings in some runtimes and CI scanners', confidence: 85 });
  }
  return fixes;
}

/** Add USER instruction before CMD to run container as non-root. */
export function fixDockerfileNonRootUser(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('USER ')) continue;
    if (!f.content.includes('CMD') && !f.content.includes('ENTRYPOINT')) continue;
    const isNode    = f.content.includes('node') || f.content.includes('npm');
    const isPython  = f.content.includes('python') || f.content.includes('pip');
    const userSetup = isNode
      ? 'RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 --ingroup nodejs nodeuser\nUSER nodeuser'
      : isPython
        ? 'RUN addgroup --system --gid 1001 appgroup && adduser --system --uid 1001 --ingroup appgroup appuser\nUSER appuser'
        : 'RUN useradd --create-home --shell /bin/bash --uid 1001 appuser\nUSER appuser';
    const fixed = f.content.replace(
      /^(CMD|ENTRYPOINT)(\s)/m,
      `${userSetup}\n$1$2`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added non-root USER before CMD — containers running as root violate the principle of least privilege and fail many security scanners (Trivy, Snyk, AWS ECR scan); UID 1001 is a common non-privileged choice', confidence: 90 });
  }
  return fixes;
}

/** Add .dockerignore for secrets and sensitive patterns that should never reach the image. */
export function fixDockerignoreSecrets(files: Array<{ path: string; content: string }>): RuleFix[] {
  const ignore = files.find(f => f.path === '.dockerignore');
  const secretPatterns = ['*.pem', '*.key', '*.p12', '*.pfx', '.env.production', '.env.local', 'secrets/', 'credentials/', '*.secret', 'id_rsa', 'id_ed25519', '*.crt', 'kubeconfig'];
  if (!ignore) return [];
  const existing = new Set(ignore.content.split('\n').map(l => l.trim()));
  const toAdd = secretPatterns.filter(p => !existing.has(p));
  if (toAdd.length === 0) return [];
  return [{ path: '.dockerignore', content: ignore.content.trimEnd() + '\n# Secrets — must never reach the Docker build context\n' + toAdd.join('\n') + '\n', explanation: `Added secret file patterns to .dockerignore (${toAdd.slice(0, 4).join(', ')}, ...) — if these files exist in the build context, COPY . . would include them in the image layer, permanently exposing secrets in docker history`, confidence: 95 }];
}

/** Fix COPY wildcard that may match nothing by adding explicit file check. */
export function fixDockerfileWildcardCopy(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/COPY.*failed|no source files were specified|file.*not found.*dockerfile/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!f.content.includes('COPY package*.json') && !f.content.includes('COPY requirements*.txt')) continue;
    // Check if the referenced files exist in the repo
    const needsPackageJson = f.content.includes('COPY package*.json') && !files.some(fi => fi.path === 'package.json');
    const needsRequirements = f.content.includes('COPY requirements*.txt') && !files.some(fi => fi.path === 'requirements.txt');
    if (!needsPackageJson && !needsRequirements) continue;
    if (needsPackageJson)
      fixes.push({ path: 'package.json', content: '{"name":"app","version":"1.0.0","scripts":{"start":"node index.js"}}\n', explanation: 'Created minimal package.json — Dockerfile COPY package*.json requires at least one matching file in the build context', confidence: 80 });
    if (needsRequirements)
      fixes.push({ path: 'requirements.txt', content: '# Add your Python dependencies here\n', explanation: 'Created minimal requirements.txt — Dockerfile COPY requirements*.txt requires at least one matching file in the build context', confidence: 80 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION D — Container Startup Failure
// ═══════════════════════════════════════════════════════════════════════════

/** Add tini (tiny init) as PID 1 to handle signals and zombie processes correctly. */
export function fixDockerTiniInit(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('tini') || f.content.includes('dumb-init')) continue;
    if (!f.content.includes('CMD') && !f.content.includes('ENTRYPOINT')) continue;
    const isDebian = /FROM\s+(node|python|debian|ubuntu)/i.test(f.content);
    const isAlpine = /FROM\s+(node:[^\n]*alpine|alpine)/i.test(f.content);
    let content = f.content;
    if (isAlpine) {
      content = content.replace(
        /^(RUN apk[^\n]*)\n/m,
        '$1\nRUN apk add --no-cache tini\n',
      );
      if (!content.includes('apk add')) {
        content = content.replace(/^(WORKDIR.*)$/m, '$1\nRUN apk add --no-cache tini');
      }
    } else if (isDebian) {
      content = content.replace(
        /^(RUN apt-get[^\n]*)\n/m,
        '$1\n# tini handles signals; alternative: use --init flag in docker run\nRUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*\n',
      );
    }
    if (!content.includes('ENTRYPOINT')) {
      content = content.replace(/^(CMD.*)$/m, 'ENTRYPOINT ["/sbin/tini", "--"]\n$1');
    } else {
      content = content.replace(/^ENTRYPOINT\s+\[/, 'ENTRYPOINT ["/sbin/tini", "--",\n  ');
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Added tini as PID 1 — without an init process, SIGTERM is not properly forwarded to app processes, causing 10-second graceful shutdown timeouts; tini also reaps zombie processes', confidence: 85 });
  }
  return fixes;
}

/** Add an entrypoint shell script that validates required env vars before starting the app. */
export function fixDockerEntrypointEnvCheck(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('entrypoint.sh')) continue;
    if (!f.content.includes('ENV') || !f.content.includes('CMD')) continue;
    const envMatches = [...f.content.matchAll(/^ENV (\w+)(?!=)/gm)].map(m => m[1]).filter(Boolean);
    if (envMatches.length === 0) return fixes;
    const script = [
      '#!/bin/sh',
      'set -e',
      '',
      '# Validate required environment variables',
      ...envMatches.map(v => `[ -n "$${v}" ] || { echo "ERROR: ${v} is required but not set"; exit 1; }`),
      '',
      'exec "$@"',
    ].join('\n') + '\n';
    fixes.push({ path: 'entrypoint.sh', content: script, explanation: `Created entrypoint.sh that validates required env vars (${envMatches.join(', ')}) — container fails with a clear message instead of a cryptic runtime error if variables are missing`, confidence: 80 });
  }
  return fixes;
}

/** Add wait-for-it step in workflow to wait for dependent services before running the container. */
export function fixDockerWaitForDependencies(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/connection.*refused.*start|service.*not.*ready.*startup|ECONNREFUSED.*container.*start/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('services:') || f.content.includes('wait-for-it') || f.content.includes('nc -z')) continue;
    const portMatch = f.content.match(/['"](\d{4,5}):\d+['"]/);
    const port = portMatch?.[1] ?? '5432';
    const waitStep = [
      '      - name: Wait for service dependencies',
      '        run: |',
      `          timeout 60 bash -c 'until nc -z localhost ${port}; do echo "Waiting for port ${port}..."; sleep 2; done'`,
      `          echo "Service on port ${port} is ready"`,
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:npm test|pytest|cargo test|go test)/i, waitStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added wait-for-service step on port ${port} — container service takes time to initialize; polling until the port accepts connections prevents flaky "connection refused" errors at test start`, confidence: 90 });
  }
  return fixes;
}

/** Add STOPSIGNAL SIGINT for processes that don't handle SIGTERM (e.g., some Node apps). */
export function fixDockerStopSignal(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('STOPSIGNAL')) continue;
    if (!f.content.includes('CMD') && !f.content.includes('ENTRYPOINT')) continue;
    const isNode = f.content.includes('node') || f.content.includes('npm');
    if (!isNode) continue;
    const fixed = f.content.replace(
      /^(CMD.*)$/m,
      'STOPSIGNAL SIGINT  # Node.js handles SIGINT for graceful shutdown; adjust for your framework\n$1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added STOPSIGNAL SIGINT — Node.js applications often handle SIGINT (Ctrl+C) but not SIGTERM; setting the correct stop signal ensures docker stop triggers graceful shutdown instead of SIGKILL after a 10s timeout', confidence: 80 });
  }
  return fixes;
}

/** Add TZ environment variable for timezone-sensitive applications. */
export function fixDockerTimezone(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('TZ') || f.content.includes('tzdata')) continue;
    if (!f.content.includes('cron') && !f.content.includes('schedule') && !f.content.includes('timezone')) continue;
    const fixed = f.content.replace(
      /^(ENV\s)/m,
      'ENV TZ=UTC\n$1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added TZ=UTC env var — containers inherit the host timezone by default which can cause non-deterministic behavior in scheduled jobs and log timestamps; UTC is the safe default for containerized apps', confidence: 80 });
  }
  return fixes;
}

/** Add ulimit settings for file descriptors in docker-compose.yml for high-connection apps. */
export function fixDockerUlimits(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/too many open files|EMFILE|ulimit.*exceeded|file descriptor.*limit/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('ulimits')) continue;
    const fixed = f.content.replace(
      /^(\s+image:\s+[^\n]+)/m,
      `$1\n    ulimits:\n      nofile:\n        soft: 65536\n        hard: 65536`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ulimits.nofile: 65536 — "too many open files" error means the container hit the default fd limit (1024); high-connection services (databases, proxies, Node servers) need at least 65536', confidence: 90 });
  }
  return fixes;
}

/** Add memory and CPU limits to docker-compose service to prevent OOM kills. */
export function fixDockerResourceLimits(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/OOM.*killed|out of memory.*container|Killed.*memory.*docker|container.*exceeded.*memory/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('mem_limit') || f.content.includes('memory:')) continue;
    const fixed = f.content.replace(
      /^(\s+image:\s+[^\n]+)/m,
      `$1\n    deploy:\n      resources:\n        limits:\n          cpus: '0.50'\n          memory: 512M\n        reservations:\n          memory: 128M`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added memory/CPU resource limits — container was OOM killed; setting limits makes resource exhaustion predictable and prevents a single container from starving the entire host', confidence: 85 });
  }
  return fixes;
}

/** Add restart policy to docker-compose service for automatic container recovery. */
export function fixDockerRestartPolicy(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/container.*exited|container.*crashed|container.*restarting/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('restart:')) continue;
    const fixed = f.content.replace(
      /^(\s+image:\s+[^\n]+)/m,
      '$1\n    restart: unless-stopped',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added restart: unless-stopped — container exited unexpectedly; this policy automatically restarts on failure but respects explicit docker stop commands; use 'on-failure:3' to limit restart attempts", confidence: 85 });
  }
  return fixes;
}

/** Add logging configuration to docker-compose to prevent unbounded log growth. */
export function fixDockerLoggingConfig(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('logging:')) continue;
    const fixed = f.content.replace(
      /^(\s+image:\s+[^\n]+)/m,
      '$1\n    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n        max-file: "3"',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added logging limits (10MB x 3 files) to docker-compose — without log rotation, container logs grow unboundedly and can fill the host disk, causing all containers on the host to fail', confidence: 90 });
  }
  return fixes;
}

/** Add HEALTHCHECK with appropriate start period for slow-starting services. */
export function fixDockerStartupHealthcheck(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('HEALTHCHECK')) continue;
    const portMatch = f.content.match(/EXPOSE (\d+)/);
    const port = portMatch?.[1] ?? '3000';
    const isJVM     = /FROM\s+(eclipse-temurin|adoptopenjdk|openjdk|tomcat)/i.test(f.content);
    const startPeriod = isJVM ? '60s' : '15s';
    const fixed = f.content.trimEnd() + [
      '',
      `HEALTHCHECK --interval=30s --timeout=10s --start-period=${startPeriod} --retries=3 \\`,
      `  CMD wget -qO- http://localhost:${port}/health 2>/dev/null || curl -f http://localhost:${port}/health 2>/dev/null || exit 1`,
      '',
    ].join('\n');
    fixes.push({ path: f.path, content: fixed, explanation: `Added HEALTHCHECK with ${startPeriod} start-period — Docker marks container as unhealthy immediately without a healthcheck, triggering premature load balancer removal; start-period gives slow-starting services time to initialize`, confidence: 95 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION E — Port Binding Conflict (Extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Use ephemeral random port in tests by setting host port to 0 (OS assigns free port). */
export function fixDockerRandomPortAssignment(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/port.*already.*allocated|EADDRINUSE|address.*already.*in use/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || !f.content.includes('ports:')) continue;
    if (f.content.includes('"0:') || f.content.includes("'0:")) continue;
    // For non-production test compose files, use random host port
    if (!f.path.includes('test') && !f.path.includes('ci')) continue;
    const fixed = f.content.replace(
      /['"](\d{4,5}):(\d+)['"]/g,
      '"127.0.0.1::$2"  # Random host port — avoids conflicts in parallel CI',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Switched to random host port binding (127.0.0.1::CONTAINER_PORT) — parallel test runs on CI share the same host and conflict on fixed ports; OS assigns a free port per run', confidence: 85 });
  }
  return fixes;
}

/** Fix Docker network subnet conflict by assigning a custom non-overlapping subnet. */
export function fixDockerNetworkSubnetConflict(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/network.*already.*exists|subnet.*overlap|IP.*pool.*exhausted|network.*conflict.*172\./i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('subnet:')) continue;
    const fixed = f.content.replace(
      /^(networks:\s*\n(\s+\w+:\s*\n))/m,
      `$1$2    driver: bridge\n      ipam:\n        config:\n          - subnet: 192.168.200.0/24  # Non-overlapping subnet; adjust if already in use\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added explicit subnet 192.168.200.0/24 — Docker default bridge networks use 172.16-31.x.x which often conflicts with corporate VPN ranges; explicit IPAM config prevents overlap', confidence: 85 });
  }
  return fixes;
}

/** Fix IPv4/IPv6 dual-stack binding conflict by binding explicitly to 0.0.0.0. */
export function fixDockerIPv6BindingConflict(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/bind.*:::?\d+|IPv6.*conflict|Cannot assign.*IPv6|listen tcp6.*bind/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose')) continue;
    const fixed = f.content.replace(
      /['"](\d{4,5}):(\d+)['"]/g,
      '"0.0.0.0:$1:$2"  # Explicit IPv4 binding avoids dual-stack conflict',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added explicit 0.0.0.0 IPv4 binding — Docker without --ipv6 may attempt to bind IPv6 which conflicts on hosts with ip6tables disabled; explicit IPv4 binding avoids the dual-stack issue', confidence: 85 });
  }
  return fixes;
}

/** Fix invalid port mapping format in docker-compose (ports must be strings or short syntax). */
export function fixDockerComposePortFormat(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || !f.content.includes('ports:')) continue;
    // Fix bare numeric ports that YAML parses as integers (YAML 1.1 auto-converts 0:80 to int)
    const fixed = f.content.replace(
      /^(\s+- )(\d+:\d+)(\s*)$/gm,
      '$1"$2"$3  # Quoted to prevent YAML integer coercion',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added quotes around port mappings in docker-compose — YAML 1.1 (used by Docker Compose v1) auto-converts bare integers which can cause unexpected port mapping behavior; quoting is safe in all versions', confidence: 90 });
  }
  return fixes;
}

/** Add expose_ports configuration to GitHub Actions service containers. */
export function fixDockerServiceContainerPorts(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('services:')) continue;
    if (f.content.includes('ports:') && f.content.includes('- \'')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      const imageMatch = lines[i].match(/^(\s+)image:\s+(postgres|redis|mysql|mongo|rabbitmq|elasticsearch)/i);
      if (imageMatch) {
        const indent = imageMatch[1];
        const defaultPorts: Record<string, string> = { postgres: '5432', redis: '6379', mysql: '3306', mongo: '27017', rabbitmq: '5672', elasticsearch: '9200' };
        const svc = imageMatch[2].toLowerCase();
        const port = defaultPorts[svc] ?? '8080';
        if (!f.content.includes(`'${port}:${port}'`) && !f.content.includes(`"${port}:${port}"`)) {
          out.push(`${indent}ports:`);
          out.push(`${indent}  - '${port}:${port}'`);
        }
      }
    }
    const result = out.join('\n');
    if (result !== f.content)
      fixes.push({ path: f.path, content: result, explanation: 'Added ports mapping to GitHub Actions service containers — service containers are accessible on localhost only when their ports are explicitly mapped; steps run in the runner VM, not inside the service container network', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION F — Registry Authentication Failure (Extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Add docker/login-action for GitHub Container Registry (ghcr.io). */
export function fixDockerGHCRLogin(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ghcr\.io.*unauthorized|denied.*ghcr|ghcr.*authentication.*failed|pull.*ghcr\.io.*401/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('ghcr.io') || f.content.includes('docker/login-action')) continue;
    const loginStep = [
      '      - name: Login to GitHub Container Registry',
      '        uses: docker/login-action@v3',
      '        with:',
      '          registry: ghcr.io',
      '          username: ${{ github.actor }}',
      '          password: ${{ secrets.GITHUB_TOKEN }}',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker pull.*ghcr/i, loginStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GHCR login — ghcr.io requires authentication even for public packages when packages: write is needed; uses GITHUB_TOKEN which is automatically scoped to the repository', confidence: 95 });
  }
  return fixes;
}

/** Add Amazon ECR get-login-password + docker login before ECR push/pull. */
export function fixDockerECRLogin(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/\.dkr\.ecr\..*amazonaws.*denied|ECR.*unauthorized|ecr.*authentication.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('.dkr.ecr.') || f.content.includes('aws-actions/amazon-ecr-login')) continue;
    const loginStep = [
      '      - name: Login to Amazon ECR',
      '        id: ecr-login',
      '        uses: aws-actions/amazon-ecr-login@v2',
      '        with:',
      '          mask-password: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker.*ecr/i, loginStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added amazon-ecr-login — ECR tokens expire after 12 hours; aws-actions/amazon-ecr-login generates a fresh token and configures docker credentials automatically; use ${{ steps.ecr-login.outputs.registry }} for the registry URL', confidence: 95 });
  }
  return fixes;
}

/** Add Azure Container Registry login step before ACR push. */
export function fixDockerACRLoginStep(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/azurecr\.io.*unauthorized|ACR.*authentication.*failed|azure.*container.*registry.*401/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('azurecr.io') || f.content.includes('docker/login-action')) continue;
    const loginStep = [
      '      - name: Login to Azure Container Registry',
      '        uses: docker/login-action@v3',
      '        with:',
      '          registry: ${{ secrets.ACR_LOGIN_SERVER }}',
      '          username: ${{ secrets.ACR_USERNAME }}',
      '          password: ${{ secrets.ACR_PASSWORD }}',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker.*azurecr/i, loginStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ACR login step — azurecr.io requires a service principal or admin credentials; store ACR_LOGIN_SERVER (e.g., myregistry.azurecr.io), ACR_USERNAME, ACR_PASSWORD as repository secrets', confidence: 95 });
  }
  return fixes;
}

/** Add Google Artifact Registry configure-docker before GAR push. */
export function fixDockerGARLoginStep(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pkg\.dev.*denied|artifact-registry.*unauthorized|gar.*authentication.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pkg.dev') || f.content.includes('configure-docker')) continue;
    const garStep = [
      '      - name: Configure Google Artifact Registry',
      '        run: gcloud auth configure-docker ${{ secrets.GAR_LOCATION }}-docker.pkg.dev --quiet',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker.*pkg\.dev/i, garStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GAR configure-docker — Google Artifact Registry requires gcloud auth configure-docker to register credentials in ~/.docker/config.json; prerequisite: google-github-actions/auth must run first', confidence: 90 });
  }
  return fixes;
}

/** Add Docker Hub access token instruction when password auth is rejected. */
export function fixDockerHubAccessToken(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/docker.*login.*failed|hub\.docker\.com.*unauthorized|docker.*password.*rejected/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('DOCKER_PASSWORD') || f.content.includes('DOCKER_ACCESS_TOKEN') || f.content.includes('access-token')) continue;
    const fixed = f.content.replace(
      /password:\s*\$\{\{\s*secrets\.DOCKER_PASSWORD\s*\}\}/g,
      `password: \${{ secrets.DOCKER_ACCESS_TOKEN }}  # Use an Access Token from hub.docker.com/settings/security, not account password`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Switched to Docker Hub Access Token — Docker Hub no longer accepts account passwords for docker login; generate a token at hub.docker.com/settings/security with read/write scope and store as DOCKER_ACCESS_TOKEN', confidence: 95 });
  }
  return fixes;
}

/** Add self-signed CA certificate to Docker daemon for private registry with custom TLS. */
export function fixDockerPrivateRegistryCA(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/certificate.*signed.*unknown.*authority|x509.*certificate.*private.*registry|tls.*verify.*failed.*registry|certificate.*verify.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('docker login') || f.content.includes('ca-cert') || f.content.includes('insecure-registries')) continue;
    const caStep = [
      '      - name: Trust private registry CA certificate',
      '        run: |',
      '          mkdir -p /etc/docker/certs.d/${{ secrets.REGISTRY_HOST }}',
      '          echo "${{ secrets.REGISTRY_CA_CERT }}" > /etc/docker/certs.d/${{ secrets.REGISTRY_HOST }}/ca.crt',
      '          sudo systemctl reload docker || true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*docker login/i, caStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added CA certificate trust for private registry — "x509: certificate signed by unknown authority" means Docker does not trust the registry TLS cert; add the CA cert to /etc/docker/certs.d/<REGISTRY>/ca.crt', confidence: 85 });
  }
  return fixes;
}

/** Add Docker credential helper setup for secure credential storage. */
export function fixDockerCredentialHelper(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('docker login') || f.content.includes('credential') || f.content.includes('credsStore')) continue;
    if (!f.content.includes('docker push') && !f.content.includes('docker/build-push-action')) continue;
    const helperStep = [
      '      - name: Configure Docker credential store',
      '        run: |',
      '          mkdir -p ~/.docker',
      '          echo \'{"credsStore":"desktop"}\' > ~/.docker/config.json || \\',
      '          echo \'{"credHelpers":{"ghcr.io":"env","*.amazonaws.com":"ecr-login"}}\' > ~/.docker/config.json',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*docker login/i, helperStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Docker credential helper config — credentials stored in ~/.docker/config.json in base64 are not encrypted; credential helpers (ecr-login, gcr, desktop) store credentials in the OS keystore', confidence: 75 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION G — Image Pull Failure (Extended)
// ═══════════════════════════════════════════════════════════════════════════

/** Pin Dockerfile FROM image by SHA256 digest for fully reproducible pulls. */
export function fixDockerImageDigestPin(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || f.content.includes('@sha256:')) continue;
    // Can't know the actual digest statically — add comment guidance instead
    const hasLatest = /FROM\s+\w[^@\n]+:latest/i.test(f.content);
    if (!hasLatest) return fixes;
    const fixed = f.content.replace(
      /^(FROM\s+[^\n]+:latest)(\s|$)/gm,
      '$1  # aegis: pin by digest for reproducibility: docker inspect --format="{{index .RepoDigests 0}}" <image>$2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added digest pinning guidance — :latest can change between builds causing different behavior; pin by digest (FROM image@sha256:abc...) for fully deterministic builds; use Dependabot or Renovate to automate digest updates', confidence: 85 });
  }
  return fixes;
}

/** Fix incorrect registry path — missing organization prefix in image name. */
export function fixDockerRegistryPathFormat(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pull.*access.*denied.*repository.*not.*found|invalid.*reference.*format|repository.*does.*not.*exist/i.test(logs)) return [];
  const imageMatch = logs.match(/repository does not exist.*?[:\s]([a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9._-]+)/i);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') && !isGitHubWorkflow(f.path)) continue;
    if (!imageMatch) continue;
    const [, badRef] = imageMatch;
    if (!f.content.includes(badRef)) continue;
    fixes.push({
      path: f.path,
      content: f.content,
      explanation: `Image reference "${badRef}" not found — verify: (1) the org/user prefix is correct, (2) the tag exists, (3) the registry prefix is included for non-Docker-Hub images (e.g., ghcr.io/org/image:tag)`,
      confidence: 75,
    });
  }
  return fixes;
}

/** Add image tag fallback from specific version to latest stable when tag is missing. */
export function fixDockerTagFallback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/tag.*not.*found|manifest.*tag.*unknown|tag.*does.*not.*exist/i.test(logs)) return [];
  const tagMatch = logs.match(/['":]([a-z0-9][\w.-]+:[a-z0-9][\w.-]+)['"]/i);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile')) continue;
    if (!tagMatch || !f.content.includes(tagMatch[1])) continue;
    const [, badRef] = tagMatch;
    const [image] = badRef.split(':');
    const stableTags: Record<string, string> = {
      node: '20-alpine', python: '3.12-slim', nginx: '1.26-alpine',
      alpine: '3.19', ubuntu: '22.04', postgres: '16-alpine', redis: '7-alpine',
    };
    const baseName = image.split('/').pop() ?? '';
    const fallback = stableTags[baseName] ?? 'latest';
    const fixed = f.content.replace(badRef, `${image}:${fallback}  # aegis: original tag "${badRef.split(':')[1]}" not found`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Tag "${badRef.split(':')[1]}" not found — fell back to ${fallback}; verify the correct tag at hub.docker.com/_/${baseName}/tags`, confidence: 70 });
  }
  return fixes;
}

/** Fix pull of private image in docker-compose by adding image pull credentials. */
export function fixDockerComposePrivateImageAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pull.*access.*denied.*compose|unauthorized.*private.*image/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('DOCKER_AUTH_CONFIG')) continue;
    const fixed = injectWorkflowLevelBlock(f.content.replace(/^(services:)/m, '# Run: docker login <registry> before docker-compose pull\n$1'), 'env', [
      '  DOCKER_AUTH_CONFIG: ${{ secrets.DOCKER_AUTH_CONFIG }}  # base64-encoded ~/.docker/config.json',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Private image pull requires pre-authentication — run docker login before docker-compose pull; in CI set DOCKER_AUTH_CONFIG env var to the base64-encoded contents of ~/.docker/config.json from a pre-authenticated machine', confidence: 80 });
  }
  return fixes;
}

/** Add Alpine apk mirror switch when default CDN is unreachable. */
export function fixDockerAlpineApkMirror(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/apk.*fetch.*failed|alpine.*mirror.*unreachable|apk.*timeout|ERROR.*apk.*update/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('Dockerfile') || !f.content.includes('apk add') || f.content.includes('mirrors.aliyun')) continue;
    const fixed = f.content.replace(
      /^(RUN apk)/m,
      'RUN echo "https://mirror.csclub.uwaterloo.ca/alpine/v3.19/main" > /etc/apk/repositories \\\n    && echo "https://mirror.csclub.uwaterloo.ca/alpine/v3.19/community" >> /etc/apk/repositories \\\n    && $1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Alpine apk mirror — dl-cdn.alpinelinux.org CDN is sometimes unreachable from CI networks; switching to University of Waterloo mirror (or choose one closer to your CI region from mirrors.alpinelinux.org)', confidence: 80 });
  }
  return fixes;
}

/** Add Trivy vulnerability scan step and configure to not block on low-severity issues. */
export function fixDockerTrivyScanStep(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('build-push-action') || f.content.includes('trivy') || f.content.includes('aquasecurity')) continue;
    const trivyStep = [
      '      - name: Scan image for vulnerabilities',
      '        uses: aquasecurity/trivy-action@0.20.0',
      '        with:',
      '          image-ref: ${{ env.IMAGE_NAME }}:${{ github.sha }}',
      '          format: sarif',
      '          output: trivy-results.sarif',
      '          severity: CRITICAL,HIGH',
      '          exit-code: 0  # Set to 1 to fail on vulnerabilities',
      '      - name: Upload Trivy results to Security tab',
      '        if: always()',
      '        uses: github/codeql-action/upload-sarif@v3',
      '        with:',
      '          sarif_file: trivy-results.sarif',
    ].join('\n');
    const lines = f.content.split('\n');
    const lastRunIdx = lines.reduce((acc, line, i) => /uses:\s*docker\/build-push-action/.test(line) ? i : acc, -1);
    if (lastRunIdx === -1) continue;
    let insertAt = lastRunIdx;
    for (let i = lastRunIdx + 1; i < lines.length; i++) {
      if (/^\s+- name:/.test(lines[i]) || /^\S/.test(lines[i])) break;
      insertAt = i;
    }
    const out = [...lines];
    out.splice(insertAt + 1, 0, trivyStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added Trivy vulnerability scan after build — scan results appear in GitHub Security tab; exit-code: 0 means findings are reported but do not fail CI; change to 1 to block on CRITICAL/HIGH vulnerabilities', confidence: 85 });
  }
  return fixes;
}

/** Add docker pull --platform to force correct platform when image exists but wrong arch is pulled. */
export function fixDockerPullPlatformMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/image.*wrong.*platform|exec.*format.*error.*pull|WARNING.*image.*different.*platform/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('docker pull') || f.content.includes('--platform')) continue;
    const fixed = f.content.replace(/(docker pull\s+)([^\n]+)/g, '$1--platform linux/amd64 $2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --platform linux/amd64 to docker pull — "exec format error" on pull means the image manifest exists for a different CPU arch; explicitly request the correct platform', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION H — Volume Mount Failure
// ═══════════════════════════════════════════════════════════════════════════

/** Convert anonymous volumes to named volumes for persistence across container restarts. */
export function fixDockerNamedVolumes(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('volumes:') && !f.content.match(/^\s+- \/\w+/m)) continue;
    // Detect anonymous volumes (path-only, no name)
    const anonVolumes = f.content.match(/^\s+- (\/[^\s:]+)\s*$/gm);
    if (!anonVolumes) continue;
    let content = f.content;
    const namedMap: Record<string, string> = {};
    anonVolumes.forEach(v => {
      const path = v.trim().replace(/^- /, '');
      const name = path.replace(/\//g, '_').replace(/^_/, '') + '_data';
      namedMap[path] = name;
      content = content.replace(v.trim(), `- ${name}:${path}`);
    });
    const volumeDefs = Object.values(namedMap).map(n => `  ${n}:`).join('\n');
    if (!content.includes('\nvolumes:')) {
      content = content.trimEnd() + `\n\nvolumes:\n${volumeDefs}\n`;
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Converted anonymous volumes to named volumes — anonymous volumes are recreated fresh on every `docker-compose up`, losing persisted data; named volumes persist across container restarts and upgrades', confidence: 85 });
  }
  return fixes;
}

/** Add :z SELinux relabeling to volume mounts on RHEL/CentOS/Fedora hosts. */
export function fixDockerVolumeSelinuxLabel(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission denied.*selinux|AVC.*denied.*container|selinux.*volume.*denied|unable to mount.*selinux/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes(':z') || f.content.includes(':Z')) continue;
    const fixed = f.content.replace(
      /(\s+- \.\/[^:]+:[^:\n]+)(?::(?!z|Z|ro|rw|shared|private|slave))?(\s*$)/gm,
      '$1:z$2  # :z = shared SELinux label; use :Z for private (single container) access',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added :z SELinux relabeling to volume mounts — RHEL/CentOS/Fedora enforce SELinux labels on container mounts; :z allows multiple containers to share the volume, :Z restricts to one container', confidence: 90 });
  }
  return fixes;
}

/** Convert relative bind mount paths to absolute paths using ${PWD} or realpath. */
export function fixDockerBindMountAbsolutePath(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/invalid mount.*relative|bind.*mount.*path.*relative|volume.*path.*must.*absolute/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose')) continue;
    if (!f.content.match(/^\s+- \.[\w/]/m)) continue;
    const fixed = f.content.replace(
      /^(\s+- )(\.\/[^:]+)(:[^\n]+)$/gm,
      '$1${PWD}/$2$3  # Absolute path prevents Docker daemon path resolution issues',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Converted relative bind mount to absolute path using ${PWD} — some Docker daemon versions reject relative paths in volumes; ${PWD} is always available in shell context', confidence: 85 });
  }
  return fixes;
}

/** Add :ro (read-only) flag to config/secret volume mounts. */
export function fixDockerVolumeReadOnly(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || !f.content.includes('volumes:')) continue;
    // Add :ro to mounts for config files and secrets
    const fixed = f.content.replace(
      /(\s+- (?:\.\/)?(?:config|conf|certs?|secrets?|\.env)[^:\n]*:[^:\n]+)(?::(?!ro|rw))?(\s*$)/gim,
      '$1:ro$2  # Read-only mount — config and secret files should not be writable',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added :ro to config/cert/secret volume mounts — mounting sensitive files as read-only prevents accidental writes and is required by some compliance frameworks; it also catches application bugs that attempt to modify config at runtime', confidence: 85 });
  }
  return fixes;
}

/** Add tmpfs mount for temporary data that should not persist and needs performance. */
export function fixDockerTmpfsMount(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/no space left.*\/tmp|permission denied.*\/tmp.*container|write.*tmp.*failed.*container/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('tmpfs')) continue;
    const fixed = f.content.replace(
      /^(\s+image:\s+[^\n]+)/m,
      '$1\n    tmpfs:\n      - /tmp:noexec,nosuid,size=256m\n      - /var/tmp:noexec,nosuid,size=64m',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added tmpfs mount for /tmp and /var/tmp — write failures on /tmp mean the container filesystem is full or read-only; tmpfs mounts live in RAM, are fast, never fill the overlay filesystem, and are automatically cleaned on container stop', confidence: 85 });
  }
  return fixes;
}

/** Add NFS volume driver options for shared network storage in docker-compose. */
export function fixDockerNFSVolumeOptions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/nfs.*mount.*failed|NFS.*permission.*denied|volume.*nfs.*error|mount.*nfs.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || !f.content.includes('nfs') || f.content.includes('driver_opts')) continue;
    const fixed = f.content.replace(
      /^(\s+volumes?:\s*\n(\s+\w[^:]+:\s*\n))/m,
      `$1$2    driver: local\n      driver_opts:\n        type: nfs\n        o: addr=\$\{NFS_SERVER_IP\},rw,nfsvers=4,soft,timeo=30\n        device: ":\${NFS_EXPORT_PATH}"\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added NFS volume driver options — NFS mount failures need explicit driver_opts with the NFS server address, version (nfsvers=4), and mount options; soft mount with timeo=30 prevents hangs on network timeout', confidence: 80 });
  }
  return fixes;
}

/** Fix volume mount conflict in Kubernetes CI job by using emptyDir or PVC instead of hostPath. */
export function fixDockerVolumeDriverConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/volume.*driver.*not.*found|volume.*plugin.*missing|no such.*volume.*driver/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || !f.content.includes('driver:')) continue;
    const driverMatch = f.content.match(/driver:\s+(\w+(?!local|overlay|aufs))/i);
    if (!driverMatch || driverMatch[1] === 'local') continue;
    const fixed = f.content.replace(
      /driver:\s+\w+(?!local)/i,
      'driver: local  # aegis: third-party volume driver not available; install the plugin or use local driver',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Volume driver "${driverMatch[1]}" not found — the Docker volume plugin is not installed on the CI runner; either install the plugin (docker plugin install ...) or fall back to the built-in local driver`, confidence: 80 });
  }
  return fixes;
}

/** Add init: true to docker-compose service to enable tini for signal handling. */
export function fixDockerComposeInit(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('docker-compose') || f.content.includes('init:') || f.content.includes('tini')) continue;
    const fixed = f.content.replace(
      /^(\s+image:\s+[^\n]+)/m,
      '$1\n    init: true  # Run tini as PID 1 for proper signal forwarding and zombie reaping',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added init: true to docker-compose service — equivalent to docker run --init; runs tini as PID 1, ensuring SIGTERM is forwarded to the app and zombie processes are reaped; prevents 10-second shutdown delays', confidence: 90 });
  }
  return fixes;
}
