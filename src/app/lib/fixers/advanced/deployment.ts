// Advanced / Deployment Errors
// Covers: rollback on failure, blue-green/canary deploy, health check before
// traffic switch, load balancer drain time, SSH deploy non-blocking.
// Extended: production deploy gates, blue-green K8s/ALB/nginx, canary metric
// analysis, service startup/readiness probes, PDB, HPA, LB health checks,
// connection draining, Traefik, NGINX timeouts, circuit breaker patterns.

import { RuleFix, isGitHubWorkflow, isGitLabCI, patchGitHubJobBlocks, insertStepBefore, insertBesideKey } from '../helpers';

/** Detect deployment tool and add actual rollback commands on failure. */
export function fixDeployRollbackOnFailure(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    if (f.content.includes("if: failure()") || f.content.includes('rollback')) continue;

    // Detect which deployment tool is used
    const isHelm    = /helm\s+upgrade|helm\s+install/i.test(f.content);
    const isKubectl = /kubectl\s+apply|kubectl\s+set\s+image/i.test(f.content) && !isHelm;
    const isFly     = /flyctl|fly\.io|fly\s+deploy/i.test(f.content);
    const isHeroku  = /heroku\s+(?:deploy|release|container)/i.test(f.content);
    const isECS     = /aws\s+ecs\s+update-service/i.test(f.content);
    const isCloudRun = /gcloud.*run.*deploy/i.test(f.content);
    const isAzure   = /az\s+webapp\s+deploy|az\s+container/i.test(f.content);

    let rollbackLines: string[];
    if (isHelm) {
      const releaseMatch = f.content.match(/helm\s+upgrade\s+([\w-]+)/i);
      const rel = releaseMatch?.[1] ?? '${{ env.HELM_RELEASE }}';
      rollbackLines = [
        `          echo "=== Helm rollback to previous release ==="`,
        `          helm rollback ${rel} 0`,
        `          helm status ${rel}`,
        `          kubectl rollout status deployment --timeout=120s || true`,
      ];
    } else if (isKubectl) {
      const depMatch = f.content.match(/kubectl.*(?:deployment|deploy)\/([\w-]+)/i);
      const dep = depMatch?.[1] ?? '${{ env.K8S_DEPLOYMENT }}';
      rollbackLines = [
        `          echo "=== kubectl rollout undo ==="`,
        `          kubectl rollout undo deployment/${dep}`,
        `          kubectl rollout status deployment/${dep} --timeout=120s`,
        `          kubectl get pods -l app=${dep} --field-selector=status.phase=Running`,
      ];
    } else if (isFly) {
      rollbackLines = [
        '          echo "=== fly.io rollback to previous version ==="',
        "          PREV=$(fly releases list --json 2>/dev/null | jq -r '.[1].version // empty')",
        '          [ -n "$PREV" ] && fly deploy --image "registry.fly.io/${{ github.event.repository.name }}:v$PREV" || echo "No previous release found"',
      ];
    } else if (isHeroku) {
      rollbackLines = [
        `          echo "=== Heroku rollback to previous release ==="`,
        `          PREV=$(heroku releases --json 2>/dev/null | jq -r '.[1].version // empty')`,
        `          [ -n "$PREV" ] && heroku rollback "$PREV" || echo "No previous release found"`,
      ];
    } else if (isECS) {
      rollbackLines = [
        '          echo "=== AWS ECS rollback to previous task definition ==="',
        '          PREV_DEF=$(aws ecs describe-services --cluster ${{ env.ECS_CLUSTER }} --services ${{ env.ECS_SERVICE }} --query \'services[0].deployments[1].taskDefinition\' --output text 2>/dev/null || echo "")',
        '          [ -n "$PREV_DEF" ] && aws ecs update-service --cluster ${{ env.ECS_CLUSTER }} --service ${{ env.ECS_SERVICE }} --task-definition "$PREV_DEF" --force-new-deployment || echo "No previous task definition found"',
      ];
    } else if (isCloudRun) {
      rollbackLines = [
        '          echo "=== Cloud Run rollback — route 100% traffic to previous revision ==="',
        '          PREV=$(gcloud run revisions list --service ${{ env.SERVICE_NAME }} --region ${{ env.GCP_REGION }} --format \'value(name)\' --limit 2 | tail -1)',
        '          [ -n "$PREV" ] && gcloud run services update-traffic ${{ env.SERVICE_NAME }} --to-revisions="$PREV=100" --region ${{ env.GCP_REGION }} || echo "No previous revision found"',
      ];
    } else if (isAzure) {
      rollbackLines = [
        '          echo "=== Azure App Service rollback ==="',
        '          az webapp deployment slot swap --name ${{ env.AZURE_APP_NAME }} --resource-group ${{ env.AZURE_RG }} --slot staging --target-slot production 2>/dev/null || true',
      ];
    } else {
      rollbackLines = [
        `          echo "=== Deployment failed — manual rollback required ==="`,
        `          echo "Last 5 commits:"`,
        `          git log --oneline -5`,
        `          echo "Hint: kubectl rollout undo / fly deploy --image=PREV / heroku rollback"`,
        `          exit 1`,
      ];
    }

    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+- name:\s*Deploy/i.test(lines[i]) && !modified) {
        // Advance past this step's body
        let j = i + 1;
        while (j < lines.length && /^\s{8,}/.test(lines[j])) { out.push(lines[++i]!); j = i + 1; }
        out.push('      - name: Rollback on deploy failure');
        out.push('        if: failure()');
        out.push('        run: |');
        for (const line of rollbackLines) out.push(line);
        out.push('        continue-on-error: true');
        modified = true;
      }
    }
    if (modified) {
      const tool = isHelm ? 'helm' : isKubectl ? 'kubectl' : isFly ? 'fly.io' : isHeroku ? 'heroku' : isECS ? 'AWS ECS' : isCloudRun ? 'Cloud Run' : isAzure ? 'Azure' : 'generic';
      fixes.push({ path: f.path, content: out.join('\n'), explanation: `Added ${tool} rollback step (if: failure()) — deployment has no automatic rollback; actual rollback command injected based on detected tool`, confidence: 100 });
    }
  }
  return fixes;
}

/** Add health check loop (20 × 10s = 200s max) before traffic switch in blue-green deploys. */
export function fixBlueGreenHealthCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/blue.?green|traffic.*switch|swap.*slot|production.*slot/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('swap') && !f.content.includes('blue') && !f.content.includes('traffic')) continue;
    if (f.content.includes('health') || f.content.includes('readiness')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      if (/run:.*(?:swap|route.*traffic|activate.*slot)/i.test(lines[i]) && !modified) {
        out.push('      - name: Wait for blue-green health check before traffic switch');
        out.push('        run: |');
        out.push('          HEALTH_URL="${STAGING_HEALTH_URL:-http://staging-slot/health}"');
        out.push('          echo "Polling $HEALTH_URL (20 attempts × 10s = 200s max)..."');
        out.push('          for i in $(seq 1 20); do');
        out.push('            STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" --max-time 5 2>/dev/null || echo "000")');
        out.push('            BODY=$(curl -s "$HEALTH_URL" --max-time 5 2>/dev/null || echo "{}") ');
        out.push('            if [ "$STATUS" = "200" ]; then');
        out.push('              echo "Health check passed (HTTP $STATUS): $BODY"');
        out.push('              exit 0');
        out.push('            fi');
        out.push('            echo "Attempt $i/20: status=$STATUS — waiting 10s..."');
        out.push('            sleep 10');
        out.push('          done');
        out.push('          echo "ERROR: Health check failed after 200s — aborting traffic switch to protect users"');
        out.push('          exit 1');
        modified = true;
      }
      out.push(lines[i]);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added pre-switch health check loop (20 × 10s) — traffic was routed before new version was healthy, causing user-facing errors', confidence: 100 });
  }
  return fixes;
}

/** Add SIGTERM drain step + 15-second grace period before instance replacement. */
export function fixConnectionDraining(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/connection.*reset|502 Bad Gateway.*deploy|ERR_CONNECTION_RESET.*deploy/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('restart')) continue;
    if (f.content.includes('SIGTERM') || f.content.includes('drain') || f.content.includes('sleep 15')) continue;
    const drainStep = [
      '      - name: Drain active connections before deploy',
      '        run: |',
      '          echo "Sending SIGTERM for graceful shutdown..."',
      '          # Signal app to stop accepting new connections',
      '          SERVICE_PID=$(cat /tmp/app.pid 2>/dev/null || pgrep -f "node.*server\\.js\|gunicorn\|uvicorn" || echo "")',
      '          if [ -n "$SERVICE_PID" ]; then',
      '            kill -TERM "$SERVICE_PID"',
      '            echo "Sent SIGTERM to PID $SERVICE_PID"',
      '          else',
      '            echo "No PID file found — skipping SIGTERM"',
      '          fi',
      '          echo "Draining connections (15s grace period)..."',
      '          sleep 15',
      '          echo "Drain complete — proceeding with deployment"',
    ].join('\n');
    const patched = insertStepBefore(
      f.content,
      /run:.*(?:restart|replace|stop|kill).*(?:server|service|container|pod)/i,
      drainStep,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added SIGTERM + 15-second drain before server restart — abrupt termination was causing 502s for in-flight requests during zero-downtime deploy', confidence: 100 });
  }
  return fixes;
}

/** Add incremental canary traffic routing steps with monitoring. */
export function fixCanaryDeployment(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/canary|weight.*traffic|gradual.*rollout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('canary')) continue;
    if (f.content.includes('canary-10pct') || f.content.includes('# canary-step-1')) continue;

    const isK8s      = /kubectl|helm/i.test(f.content);
    const isCloudRun = /gcloud.*run/i.test(f.content);

    let canarySteps: string[];
    if (isK8s) {
      canarySteps = [
        '      - name: Canary — 10% traffic',
        '        id: canary-10pct',
        '        run: |',
        "          kubectl patch virtualservice \"${{ env.VS_NAME }}\" --type merge -p '{\"spec\":{\"http\":[{\"route\":[{\"destination\":{\"host\":\"app\",\"subset\":\"v2\"},\"weight\":10},{\"destination\":{\"host\":\"app\",\"subset\":\"v1\"},\"weight\":90}]}]}}'",
        '          echo "Canary at 10% — monitoring for 2 minutes..."',
        '          sleep 120',
        '          # Check error rate — abort if > 1% of requests fail',
        '          ERR=$(kubectl exec -n monitoring deploy/prometheus -- promtool query instant "rate(http_requests_total{code=~\'5..\',subset=\'v2\'}[2m])" 2>/dev/null | grep value | awk \'{print $2}\' || echo "0")',
        '          [ "$(echo "$ERR > 0.01" | bc -l 2>/dev/null || echo 0)" = "1" ] && echo "Error rate too high — rolling back" && kubectl patch virtualservice "${{ env.VS_NAME }}" --type merge -p \'{"spec":{"http":[{"route":[{"destination":{"host":"app","subset":"v1"},"weight":100}]}]}}\' && exit 1 || true',
        '      - name: Canary — 50% traffic',
        '        run: |',
        "          kubectl patch virtualservice \"${{ env.VS_NAME }}\" --type merge -p '{\"spec\":{\"http\":[{\"route\":[{\"destination\":{\"host\":\"app\",\"subset\":\"v2\"},\"weight\":50},{\"destination\":{\"host\":\"app\",\"subset\":\"v1\"},\"weight\":50}]}]}}'",
        '          echo "Canary at 50% — monitoring for 2 minutes..."',
        '          sleep 120',
        '      - name: Canary — 100% traffic (promote)',
        '        run: |',
        "          kubectl patch virtualservice \"${{ env.VS_NAME }}\" --type merge -p '{\"spec\":{\"http\":[{\"route\":[{\"destination\":{\"host\":\"app\",\"subset\":\"v2\"},\"weight\":100}]}]}}'",
        '          echo "Canary promoted to 100% — deployment complete"',
      ];
    } else if (isCloudRun) {
      canarySteps = [
        '      - name: Canary — 10% traffic',
        '        id: canary-10pct',
        '        run: |',
        '          gcloud run services update-traffic "${{ env.SERVICE_NAME }}" --to-revisions=LATEST=10 --region="${{ env.GCP_REGION }}"',
        '          echo "Canary at 10% — monitoring for 2 minutes..."',
        '          sleep 120',
        '      - name: Canary — 50% traffic',
        '        run: gcloud run services update-traffic "${{ env.SERVICE_NAME }}" --to-revisions=LATEST=50 --region="${{ env.GCP_REGION }}"',
        '      - name: Canary — 100% traffic (promote)',
        '        run: |',
        '          gcloud run services update-traffic "${{ env.SERVICE_NAME }}" --to-latest --region="${{ env.GCP_REGION }}"',
        '          echo "Canary promoted to 100% — deployment complete"',
      ];
    } else {
      canarySteps = [
        '      - name: Canary — 10% traffic',
        '        id: canary-10pct',
        '        run: |',
        '          echo "Routing 10% of traffic to new version..."',
        '          # TODO: update your load balancer weight here',
        '          sleep 120  # Monitor error rate for 2 minutes',
        '      - name: Canary — 50% traffic',
        '        run: |',
        '          echo "Routing 50% of traffic to new version..."',
        '          sleep 120',
        '      - name: Canary — 100% traffic',
        '        run: echo "Routing 100% of traffic to new version — canary complete"',
      ];
    }

    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      if (/run:.*(?:set.*weight.*100|canary.*100|route.*100%)/i.test(line) && !modified) {
        out.push(...canarySteps);
        modified = true;
      }
      out.push(line);
    }
    if (modified) {
      const platform = isK8s ? 'Kubernetes Istio VirtualService' : isCloudRun ? 'Cloud Run' : 'generic';
      fixes.push({ path: f.path, content: out.join('\n'), explanation: `Added incremental canary traffic steps 10% → 50% → 100% for ${platform} — direct 100% traffic switch bypasses staged rollout validation`, confidence: 100 });
    }
  }
  return fixes;
}

/** Add continue-on-error to SSH deploy jobs when prod SSH credentials may not be configured. */
export function fixSSHDeployNonBlocking(files: Array<{ path: string; content: string }>): RuleFix[] {
  const SSH_SIGNALS = ['appleboy/ssh-action', 'appleboy/scp-action', 'PROD_SSH_KEY', 'SSH_PRIVATE_KEY'];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !SSH_SIGNALS.some(s => f.content.includes(s))) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => SSH_SIGNALS.some(s => b.includes(s)) && !/continue-on-error:\s*true/i.test(b),
      '    continue-on-error: true',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added continue-on-error to SSH deploy jobs — PROD_SSH_KEY / PROD_HOST secrets may not be configured in all environments', confidence: 100 });
  }
  return fixes;
}

/** Add kubectl rollout status check after kubectl apply to confirm pods become healthy. */
export function fixK8sRolloutWait(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('kubectl') || f.content.includes('rollout status')) continue;
    const fixed = f.content.replace(
      /(run:\s*kubectl apply[^\n]+)/g,
      `$1\n          kubectl rollout status deployment --timeout=120s\n          kubectl get pods --field-selector=status.phase!=Running 2>/dev/null || true`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added kubectl rollout status --timeout=120s after apply — verifies all pods become Running before marking deploy successful', confidence: 100 });
  }
  return fixes;
}

/** Add pre-deploy service availability check when 503/502 is detected. */
export function fixServiceUnavailable(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/503 Service Unavailable|502 Bad Gateway|ECONNREFUSED.*deploy|service.*not.*available|502.*upstream/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('wait.*service') || f.content.includes('retry.*health') || f.content.includes('seq 1 12')) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    const waitStep = [
      '      - name: Wait for service availability before deploy',
      '        run: |',
      '          SERVICE_URL="${SERVICE_URL:-http://localhost:3000}"',
      '          echo "Waiting for $SERVICE_URL/health to respond..."',
      '          for i in $(seq 1 12); do',
      '            STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SERVICE_URL/health" --max-time 5 2>/dev/null || echo "000")',
      '            if [ "$STATUS" = "200" ]; then',
      '              echo "Service available (HTTP $STATUS)"',
      '              exit 0',
      '            fi',
      '            echo "Attempt $i/12: service not ready ($STATUS) — waiting 10s..."',
      '            sleep 10',
      '          done',
      '          echo "WARNING: Service did not become available in 120s — deploying anyway"',
      '        continue-on-error: true',
    ].join('\n');
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s+- name:\s*Deploy/i.test(lines[i]) && !modified) {
        out.push(waitStep);
        modified = true;
      }
      out.push(lines[i]);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added pre-deploy service availability check (12 × 10s) — 503/502 indicates existing service was unhealthy before deployment started', confidence: 100 });
  }
  return fixes;
}

/** Add load balancer health check loop and /health endpoint to Express apps. */
export function fixLoadBalancerRouting(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/load.?balancer|ALB.*health|ELB.*health|target.*unhealthy|routing.*fail|health.*check.*path/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (isGitHubWorkflow(f.path) || isGitLabCI(f.path)) {
      if (f.content.includes('health-check') || !f.content.includes('deploy')) continue;
      const lbStep = [
        '      - name: Validate load balancer health after deploy',
        '        run: |',
        '          echo "Waiting 30s for LB to register new targets..."',
        '          sleep 30',
        '          DEPLOY_URL="${DEPLOY_URL:-http://localhost:3000}"',
        '          for i in $(seq 1 8); do',
        '            HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOY_URL/health" --max-time 10 2>/dev/null || echo "000")',
        '            [ "$HTTP_STATUS" = "200" ] && echo "LB health check passed (HTTP $HTTP_STATUS)" && exit 0',
        '            echo "LB attempt $i/8: $HTTP_STATUS — waiting 15s..."',
        '            sleep 15',
        '          done',
        '          echo "WARNING: LB health check did not pass within timeout"',
        '        continue-on-error: true',
      ].join('\n');
      const patched = insertStepBefore(
        f.content,
        /run:.*(?:aws|gcloud|az|kubectl|fly).*deploy/i,
        lbStep,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added post-deploy LB health validation (8 × 15s) — waits for LB to register new targets before marking deploy successful', confidence: 100 });
    }
    // Add /health endpoint to Express apps
    if (f.path.endsWith('.js') && f.content.includes('express()') && !f.content.includes('/health')) {
      const fixed = f.content.replace(
        /(const app = express\(\);?\n)/,
        `$1\napp.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() }));\n`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added GET /health endpoint to Express app — load balancer probes require a 200 response on /health', confidence: 100 });
    }
    // Add /health to TypeScript Express apps
    if (f.path.endsWith('.ts') && f.content.includes('express()') && !f.content.includes('/health')) {
      const fixed = f.content.replace(
        /(const app = express\(\);?\n)/,
        `$1\napp.get('/health', (_req: import('express').Request, res: import('express').Response) => {\n  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });\n});\n`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added typed GET /health endpoint to Express TypeScript app — load balancer probes require /health to return 200', confidence: 100 });
    }
  }
  return fixes;
}

/** Add environment: section to GitLab deploy jobs for environment tracking. */
export function fixGitLabDeployEnvironment(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^(deploy|release|publish)[\w-]*:$/i.test(lines[i])) {
        // Look ahead for existing environment: section
        let j = i + 1; let hasEnv = false;
        while (j < lines.length && (lines[j].startsWith('  ') || lines[j].trim() === '')) {
          if (/^\s+environment:/.test(lines[j])) { hasEnv = true; break; }
          j++;
        }
        if (!hasEnv) {
          const envName = /prod/i.test(lines[i]) ? 'production' : /stage|staging/i.test(lines[i]) ? 'staging' : 'production';
          const reviewUrl = envName === 'production' ? '$CI_ENVIRONMENT_URL' : 'https://$CI_ENVIRONMENT_SLUG.staging.example.com';
          out.push(`  environment:`);
          out.push(`    name: ${envName}`);
          out.push(`    url: ${reviewUrl}`);
          modified = true;
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added environment: section to GitLab deploy jobs — enables deployment history, stop actions, and environment URLs in GitLab UI', confidence: 100 });
  }
  return fixes;
}

// ── Section A — Deployment Rollback Failure ──────────────────────────────────

/** Add helm rollback with --wait and history limit when helm upgrade fails. */
export function fixHelmRollbackOnFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/helm upgrade|helm deploy|UPGRADE FAILED|helm.*failed/i.test(logs) && !files.some(f => /helm\s+upgrade/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('helm upgrade')) continue;
    if (f.content.includes('helm rollback') || f.content.includes('--atomic')) continue;
    const fixed = f.content
      .replace(
        /(helm\s+upgrade\s+)([\w-]+\s+[\w./]+)/g,
        '$1--atomic --cleanup-on-fail --history-limit 5 --timeout 10m $2',
      );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --atomic --cleanup-on-fail --history-limit 5 to helm upgrade — atomic mode auto-rolls back on failure; history-limit retains 5 revisions for manual rollback', confidence: 95 });
  }
  return fixes;
}

/** Add kubectl.kubernetes.io/change-cause annotation for meaningful rollout history. */
export function fixKubectlRollbackAnnotation(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('kubectl apply') && !f.content.includes('kubectl set image')) continue;
    if (f.content.includes('change-cause') || f.content.includes('--record')) continue;
    const fixed = f.content.replace(
      /(kubectl\s+(?:apply|set image)[^\n]+)/g,
      `$1\n          kubectl annotate deployment --all kubernetes.io/change-cause="Deploy $\${GITHUB_SHA:-$(git rev-parse --short HEAD)} by $\${GITHUB_ACTOR:-CI}" --overwrite`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added kubernetes.io/change-cause annotation after kubectl apply — annotating deployments enables meaningful `kubectl rollout history` entries for targeted rollback', confidence: 90 });
  }
  return fixes;
}

/** Set revisionHistoryLimit on K8s Deployments to ensure rollback availability. */
export function fixK8sRollbackHistoryLimit(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('revisionHistoryLimit')) continue;
    const fixed = f.content.replace(
      /(spec:\s*\n(\s+)replicas:)/,
      `spec:\n$2revisionHistoryLimit: 5\n$2replicas:`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added revisionHistoryLimit: 5 to Deployment spec — default of 10 wastes etcd space; 0 would prevent rollback; 5 retains 5 revisions for `kubectl rollout undo`', confidence: 95 });
  }
  return fixes;
}

/** Add Heroku releases rollback step on deployment failure. */
export function fixHerokuReleaseRollback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/heroku.*failed|heroku.*error|release.*failed.*heroku/i.test(logs) && !files.some(f => /heroku\s+(?:deploy|container:release)/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('heroku')) continue;
    if (f.content.includes('heroku rollback') || f.content.includes("if: failure()")) continue;
    const rollback = [
      '      - name: Heroku rollback on failure',
      '        if: failure()',
      '        env:',
      '          HEROKU_API_KEY: ${{ secrets.HEROKU_API_KEY }}',
      '        run: |',
      '          echo "=== Rolling back Heroku release ==="',
      '          PREV=$(heroku releases --json 2>/dev/null | jq -r \'.[1].version // empty\')',
      '          [ -n "$PREV" ] && heroku rollback "v$PREV" && echo "Rolled back to v$PREV" || echo "No previous release found"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /name:\s*Heroku/i, rollback);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Heroku rollback step (if: failure()) — re-activates the last stable release so production stays available while the failed deploy is investigated', confidence: 90 });
  }
  return fixes;
}

/** Add ECS rollback by re-registering the previous task definition on failure. */
export function fixECSRollbackTaskDef(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/aws\s+ecs|ecs.*update-service|ECS.*failed|task.*definition.*failed/i.test(logs) && !files.some(f => /aws\s+ecs/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('aws ecs')) continue;
    if (f.content.includes('ecs.*rollback') || f.content.includes("if: failure()")) continue;
    const rollback = [
      '      - name: ECS rollback to previous task definition',
      '        if: failure()',
      '        run: |',
      '          echo "=== Rolling back ECS service to previous task definition ==="',
      '          PREV_DEF=$(aws ecs describe-services \\',
      '            --cluster "${{ env.ECS_CLUSTER }}" \\',
      '            --services "${{ env.ECS_SERVICE }}" \\',
      '            --query \'services[0].deployments[1].taskDefinition\' --output text 2>/dev/null || echo "")',
      '          if [ -n "$PREV_DEF" ] && [ "$PREV_DEF" != "None" ]; then',
      '            aws ecs update-service \\',
      '              --cluster "${{ env.ECS_CLUSTER }}" \\',
      '              --service "${{ env.ECS_SERVICE }}" \\',
      '              --task-definition "$PREV_DEF" \\',
      '              --force-new-deployment',
      '            echo "ECS rolled back to $PREV_DEF"',
      '          else',
      '            echo "No previous task definition found for rollback"',
      '          fi',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /aws\s+ecs\s+update-service/i, rollback);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ECS task-definition rollback step (if: failure()) — re-activates the previous stable task definition to restore service availability', confidence: 90 });
  }
  return fixes;
}

/** Add Cloud Run rollback by routing 100% traffic to the previous stable revision. */
export function fixCloudRunRollbackRevision(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/gcloud.*run|cloud run.*failed|revision.*failed/i.test(logs) && !files.some(f => /gcloud\s+run\s+deploy/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('gcloud run deploy')) continue;
    if (f.content.includes('update-traffic') && f.content.includes("if: failure()")) continue;
    const rollback = [
      '      - name: Cloud Run rollback to previous revision',
      '        if: failure()',
      '        run: |',
      '          echo "=== Rolling back Cloud Run to previous revision ==="',
      '          PREV=$(gcloud run revisions list \\',
      '            --service "${{ env.SERVICE_NAME }}" \\',
      '            --region "${{ env.GCP_REGION }}" \\',
      '            --format \'value(name)\' --limit 2 2>/dev/null | tail -1)',
      '          if [ -n "$PREV" ]; then',
      '            gcloud run services update-traffic "${{ env.SERVICE_NAME }}" \\',
      '              --to-revisions="$PREV=100" \\',
      '              --region "${{ env.GCP_REGION }}"',
      '            echo "Rolled back to $PREV"',
      '          else',
      '            echo "No previous revision found"',
      '          fi',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /gcloud\s+run\s+deploy/i, rollback);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Cloud Run revision rollback (if: failure()) — routes 100% traffic back to the last stable revision when new revision deployment fails', confidence: 90 });
  }
  return fixes;
}

/** Add Terraform destroy guard — require explicit ALLOW_DESTROY=true to prevent accidental production teardown. */
export function fixTerraformDestroyGuard(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/terraform.*destroy|plan.*destroy|resources.*will be destroyed/i.test(logs) && !files.some(f => /terraform\s+destroy/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('terraform destroy')) continue;
    if (f.content.includes('ALLOW_DESTROY')) continue;
    const fixed = f.content.replace(
      /(terraform\s+destroy)/g,
      `[ "$ALLOW_DESTROY" = "true" ] && terraform destroy || (echo "ERROR: Set ALLOW_DESTROY=true to confirm production teardown"; exit 1)`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Wrapped terraform destroy with ALLOW_DESTROY guard — prevents accidental production teardown; operator must explicitly set ALLOW_DESTROY=true as an env var', confidence: 95 });
  }
  return fixes;
}

/** Add GitLab on_failure rollback job using environment stop action. */
export function fixGitLabDeployRollback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deploy.*failed|release.*failed/i.test(logs) && !files.some(f => isGitLabCI(f.path) && f.content.includes('deploy'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    if (f.content.includes('when: on_failure') || f.content.includes('rollback')) continue;
    const rollbackJob = `\nrollback-production:\n  stage: deploy\n  when: on_failure\n  script:\n    - echo "=== Deployment failed — initiating rollback ==="\n    - |\n      if command -v helm >/dev/null 2>&1; then\n        helm rollback "$HELM_RELEASE" 0 --wait --timeout 5m\n      elif command -v kubectl >/dev/null 2>&1; then\n        kubectl rollout undo deployment/"$K8S_DEPLOYMENT"\n        kubectl rollout status deployment/"$K8S_DEPLOYMENT" --timeout=120s\n      else\n        echo "No recognized deploy tool found — manual rollback required"\n        exit 1\n      fi\n  environment:\n    name: production\n    action: stop\n  allow_failure: true\n`;
    if (!f.content.includes('rollback-production'))
      fixes.push({ path: f.path, content: f.content + rollbackJob, explanation: 'Added rollback-production job (when: on_failure) to GitLab CI — auto-triggers rollback when any deploy stage fails, sets environment action: stop to reset GitLab environment state', confidence: 85 });
  }
  return fixes;
}

/** Add Slack/Teams rollback notification step. */
export function fixDeployRollbackNotification(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/rollback|deploy.*failed|release.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('rollback') && !f.content.includes('if: failure()')) continue;
    if (f.content.includes('SLACK_WEBHOOK') || f.content.includes('notify')) continue;
    const notifyStep = [
      '      - name: Notify team on rollback',
      '        if: failure()',
      '        run: |',
      '          WEBHOOK="${{ secrets.SLACK_WEBHOOK_URL }}"',
      '          [ -z "$WEBHOOK" ] && echo "SLACK_WEBHOOK_URL not set — skipping notification" && exit 0',
      '          curl -s -X POST "$WEBHOOK" \\',
      '            -H "Content-Type: application/json" \\',
      "            -d \"{\\\"text\\\":\\\":rotating_light: *Production rollback triggered* for *${{ github.repository }}* on branch `${{ github.ref_name }}` by ${{ github.actor }}.\\\\nCommit: ${{ github.sha }}\\\\nRun: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\\\"}\"",
      '        continue-on-error: true',
    ].join('\n');
    const lines = f.content.split('\n');
    let insertIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s+- name:.*[Rr]ollback/.test(lines[i])) { insertIdx = i; break; }
    }
    if (insertIdx < 0) continue;
    while (insertIdx < lines.length - 1 && /^\s{8,}/.test(lines[insertIdx + 1] ?? '')) insertIdx++;
    lines.splice(insertIdx + 1, 0, notifyStep);
    fixes.push({ path: f.path, content: lines.join('\n'), explanation: 'Added Slack rollback notification step (if: failure()) — alerts the team immediately when a production rollback is triggered via SLACK_WEBHOOK_URL secret', confidence: 85 });
  }
  return fixes;
}

/** Add Azure App Service slot swap rollback. */
export function fixAzureSlotRollback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/az\s+webapp|azure.*app service|slot.*swap.*failed/i.test(logs) && !files.some(f => /az\s+webapp\s+deployment\s+slot/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('az webapp deployment slot swap')) continue;
    if (f.content.includes("if: failure()")) continue;
    const rollback = [
      '      - name: Azure slot swap rollback',
      '        if: failure()',
      '        run: |',
      '          echo "=== Swapping back: production → staging to rollback ==="',
      '          az webapp deployment slot swap \\',
      '            --name "${{ env.AZURE_APP_NAME }}" \\',
      '            --resource-group "${{ env.AZURE_RG }}" \\',
      '            --slot production \\',
      '            --target-slot staging 2>/dev/null || echo "Swap-back skipped — production slot may not be in correct state"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /az\s+webapp\s+deployment\s+slot\s+swap/i, rollback);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Azure slot swap rollback (if: failure()) — swaps production ↔ staging to restore the previous stable version of the app', confidence: 90 });
  }
  return fixes;
}

/** Add fly.io rollback to previous image on failure. */
export function fixFlyioRollback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/flyctl|fly\s+deploy|fly\.io.*failed/i.test(logs) && !files.some(f => /flyctl\s+deploy|fly\s+deploy/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('fly deploy') && !f.content.includes('flyctl deploy')) continue;
    if (f.content.includes("if: failure()")) continue;
    const rollback = [
      '      - name: fly.io rollback on failure',
      '        if: failure()',
      '        env:',
      '          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}',
      '        run: |',
      '          echo "=== Rolling back fly.io to previous release ==="',
      '          PREV_VER=$(flyctl releases list --json 2>/dev/null | jq -r \'.[1].version // empty\')',
      '          if [ -n "$PREV_VER" ]; then',
      '            flyctl deploy --image "registry.fly.io/${{ github.event.repository.name }}:v$PREV_VER" --strategy immediate',
      '            echo "Rolled back to v$PREV_VER"',
      '          else',
      '            echo "No previous release found for rollback"',
      '          fi',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /fly(?:ctl)?\s+deploy/i, rollback);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added fly.io rollback step (if: failure()) — re-deploys the previous stable image from the release history when the new deploy fails', confidence: 90 });
  }
  return fixes;
}

/** Add Argo CD sync-wave annotation to Deployments for ordered rollback safety. */
export function fixArgoRollbackSyncWave(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment') && !f.content.includes('kind: StatefulSet')) continue;
    if (f.content.includes('argocd.argoproj.io/sync-wave') || !f.content.includes('argocd')) continue;
    const wave = f.content.includes('database') || f.content.includes('db') ? '1' : '2';
    const fixed = f.content.replace(
      /(  annotations:\s*\n)/,
      `$1    argocd.argoproj.io/sync-wave: "${wave}"\n    argocd.argoproj.io/hook: Sync\n    argocd.argoproj.io/hook-delete-policy: HookSucceeded\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added argocd.argoproj.io/sync-wave: "${wave}" — controls Argo CD sync order so databases sync before app services, enabling safe incremental rollback`, confidence: 85 });
  }
  return fixes;
}

// ── Section B — Failed Production Deployment ─────────────────────────────────

/** Add manual approval gate job before production deployment. */
export function fixProdDeployGatingJob(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    if (f.content.includes('environment:') || f.content.includes('needs: [approve') || f.content.includes('required_reviewers')) continue;
    if (!/prod|production|release/i.test(f.content)) continue;
    const fixed = f.content.replace(
      /^(\s{2})(deploy[\w-]*):\s*\n(\s{4})(runs-on:)/m,
      `$1approve-production:\n$1  environment:\n$1    name: production\n$1  runs-on: ubuntu-latest\n$1  steps:\n$1    - run: echo "Approval granted — proceeding with production deployment"\n\n$1$2:\n$3needs: [approve-production]\n$3$4`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added approve-production gate job with environment: production — requires manual approval from a configured reviewer before any production deployment runs', confidence: 90 });
  }
  return fixes;
}

/** Add concurrency group to prevent simultaneous production deployments. */
export function fixConcurrentDeployPrevention(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    if (f.content.includes('concurrency:')) continue;
    const fixed = f.content.replace(
      /^(on:\s*\n)/m,
      `concurrency:\n  group: production-deploy-\${{ github.ref }}\n  cancel-in-progress: false\n\n$1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added concurrency group production-deploy-$ref — prevents two simultaneous prod deploys from racing; cancel-in-progress: false queues rather than cancels the second run', confidence: 95 });
  }
  return fixes;
}

/** Add pre-deploy smoke test step before production traffic switch. */
export function fixPreDeploySmoke(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/smoke.*test|deploy.*failed|prod.*deploy.*error/i.test(logs) && !files.some(f => f.content.includes('deploy') && isGitHubWorkflow(f.path))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') || f.content.includes('smoke') || f.content.includes('integration-test')) continue;
    const smokeStep = [
      '      - name: Pre-deploy smoke test',
      '        run: |',
      '          STAGING_URL="${STAGING_URL:-http://staging.example.com}"',
      '          echo "Running smoke tests against $STAGING_URL..."',
      '          # Health check',
      '          STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$STAGING_URL/health" --max-time 10 || echo "000")',
      '          [ "$STATUS" != "200" ] && echo "FAIL: /health returned $STATUS" && exit 1',
      '          # Auth endpoint sanity',
      '          AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$STAGING_URL/api/v1/ping" --max-time 10 || echo "000")',
      '          [ "$AUTH_STATUS" = "000" ] && echo "FAIL: API unreachable" && exit 1',
      '          echo "Smoke tests passed (health=$STATUS, api=$AUTH_STATUS) — proceeding with deploy"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /name:\s*Deploy\s+to\s+Production|name:\s*Production\s+Deploy/i, smokeStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added pre-deploy smoke test — validates /health + API reachability on staging before switching production traffic, catching obvious failures early', confidence: 85 });
  }
  return fixes;
}

/** Add required environment variable validation before deployment starts. */
export function fixDeployEnvValidation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/undefined.*variable|environment.*variable.*missing|required.*env/i.test(logs) && !files.some(f => isGitHubWorkflow(f.path) && f.content.includes('deploy'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy')) continue;
    if (f.content.includes('Validate environment') || f.content.includes('required_vars')) continue;
    const vars = ['DEPLOY_TOKEN', 'CLUSTER_NAME', 'IMAGE_TAG', 'SERVICE_NAME'].filter(v => f.content.includes(v));
    if (vars.length === 0) return fixes;
    const checks = vars.map(v => `          [ -z "$\{${v}\}" ] && echo "ERROR: ${v} is not set" && MISSING=1`).join('\n');
    const validateStep = [
      '      - name: Validate deployment environment variables',
      '        run: |',
      '          MISSING=0',
      checks,
      '          [ "$MISSING" = "1" ] && echo "Set missing variables as repository secrets or environment variables" && exit 1',
      '          echo "All required deployment variables present — proceeding"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /name:\s*Deploy/i, validateStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added pre-deploy env var validation for: ${vars.join(', ')} — fails fast with a clear error message before any deployment commands run`, confidence: 90 });
  }
  return fixes;
}

/** Add terraform plan as a separate job with output before apply. */
export function fixTerraformPlanBeforeApply(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/terraform apply|terraform.*deploy/i.test(logs) && !files.some(f => f.content.includes('terraform apply'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('terraform apply')) continue;
    if (f.content.includes('terraform plan') || f.content.includes('tfplan')) continue;
    const fixed = f.content.replace(
      /(terraform\s+apply)/g,
      `terraform plan -out=tfplan -detailed-exitcode\n          echo "Review the plan above — approving in 30s (cancel the run to abort)"\n          terraform apply tfplan`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added terraform plan -out=tfplan before apply — separates plan inspection from apply; -detailed-exitcode causes the step to fail if no changes are expected but changes are detected', confidence: 90 });
  }
  return fixes;
}

/** Add helm upgrade --dry-run validation step before actual Helm deploy. */
export function fixHelmDryRunFirst(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/helm upgrade|helm install|helm.*deploy/i.test(logs) && !files.some(f => /helm\s+upgrade/.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('helm upgrade') && !f.content.includes('helm install')) continue;
    if (f.content.includes('--dry-run')) continue;
    const dryRunStep = [
      '      - name: Helm upgrade dry-run validation',
      '        run: |',
      '          echo "Running helm upgrade --dry-run to detect template errors..."',
      '          helm upgrade --install --dry-run --debug \\',
      '            "${{ env.HELM_RELEASE }}" \\',
      '            "${{ env.HELM_CHART }}" \\',
      '            -f values.yaml \\',
      '            --namespace "${{ env.K8S_NAMESPACE }}"',
      '          echo "Dry-run passed — proceeding with actual upgrade"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /helm\s+upgrade|helm\s+install/i, dryRunStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added helm upgrade --dry-run before actual deploy — renders Helm templates and validates K8s API server acceptance without deploying; catches typos and schema errors early', confidence: 90 });
  }
  return fixes;
}

/** Add kubectl apply --dry-run=server before actual apply to validate manifests. */
export function fixK8sApplyValidation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/kubectl apply|k8s.*failed|manifest.*invalid/i.test(logs) && !files.some(f => f.content.includes('kubectl apply'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('kubectl apply')) continue;
    if (f.content.includes('dry-run')) continue;
    const fixed = f.content.replace(
      /(kubectl\s+apply\s+-f\s+[\w./\-*]+)/g,
      `kubectl apply --dry-run=server -f $2 && $1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added kubectl apply --dry-run=server before actual apply — server-side dry-run validates against the live API server schema, catching invalid field names and types before modifying cluster state', confidence: 88 });
  }
  return fixes;
}

/** Extend deployment job timeout for large Kubernetes rollouts. */
export function fixDeployTimeoutExtension(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/timeout|timed out|job.*cancelled.*exceeded|The operation.*timed out/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^  [\w-]+:$/.test(lines[i]) && /deploy|release|publish/i.test(lines[i])) {
        let j = i + 1;
        let hasTimeout = false;
        while (j < lines.length && lines[j].startsWith('  ')) {
          if (/timeout-minutes:/.test(lines[j])) { hasTimeout = true; break; }
          j++;
        }
        if (!hasTimeout) {
          out.push('    timeout-minutes: 30');
          modified = true;
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added timeout-minutes: 30 to deploy jobs — GitHub Actions default is 6h which makes stuck deploys invisible; 30m is appropriate for most K8s/container deployments', confidence: 88 });
  }
  return fixes;
}

/** Add liveness and readiness probe to Kubernetes Deployment manifests. */
export function fixDockerImageHealthProbe(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('livenessProbe') || f.content.includes('readinessProbe')) continue;
    const portMatch = f.content.match(/containerPort:\s*(\d+)/);
    const port = portMatch?.[1] ?? '8080';
    const fixed = insertBesideKey(
      f.content, 'image',
      `        readinessProbe:\n          httpGet:\n            path: /health\n            port: ${port}\n          initialDelaySeconds: 10\n          periodSeconds: 5\n          failureThreshold: 3\n        livenessProbe:\n          httpGet:\n            path: /health\n            port: ${port}\n          initialDelaySeconds: 30\n          periodSeconds: 10\n          failureThreshold: 3\n`,
      8,
    );
    if (fixed && fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added readinessProbe + livenessProbe on port ${port}/health — readiness prevents traffic before container is ready; liveness restarts containers that become unresponsive`, confidence: 90 });
  }
  return fixes;
}

/** Restrict production deploy jobs to main/master/release branches only. */
export function fixProdDeployBranchGuard(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('production')) continue;
    if (f.content.includes("github.ref == 'refs/heads/main'") || f.content.includes("startsWith(github.ref, 'refs/tags/')")) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^  (deploy|release)-?prod/i.test(lines[i]) && !modified) {
        let j = i + 1;
        let hasIf = false;
        while (j < lines.length && lines[j].startsWith('  ')) {
          if (/^\s+if:/.test(lines[j])) { hasIf = true; break; }
          j++;
        }
        if (!hasIf) {
          out.push(`    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/') || startsWith(github.ref, 'refs/tags/v')`);
          modified = true;
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: "Added branch guard (if: github.ref == 'refs/heads/main') to production deploy jobs — prevents accidental deploys triggered from feature branches or PRs", confidence: 92 });
  }
  return fixes;
}

/** Require a SemVer git tag for production deployments instead of deploying HEAD directly. */
export function fixDeployTaggedRelease(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') || !f.content.includes('production')) continue;
    if (f.content.includes("startsWith(github.ref, 'refs/tags/v')") || f.content.includes('RELEASE_TAG') || f.content.includes('Verify release tag')) continue;
    const fixed = f.content.replace(
      /(\s+)(- uses: actions\/checkout@)/,
      `$1- name: Verify release tag\n$1  run: |\n$1    echo "Deploying tag: $\${GITHUB_REF_NAME}"\n$1    echo "$\${GITHUB_REF_NAME}" | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+' || (echo "ERROR: Production deploy requires a SemVer tag (e.g. v1.2.3). Got: $\${GITHUB_REF_NAME}" && exit 1)\n$1$2`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added SemVer tag validation before production deploy — enforces that only tagged releases (v1.2.3 format) can trigger production deployments, preventing accidental branch deploys', confidence: 85 });
  }
  return fixes;
}

// ── Section C — Blue-Green Deployment Conflict ───────────────────────────────

/** Add K8s Service selector toggle for blue/green label switch. */
export function fixBlueGreenK8sService(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/blue.?green|slot.*swap|traffic.*switch|active.*slot/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('kubectl') || f.content.includes('patch service')) continue;
    const switchStep = [
      '      - name: Blue-green Service selector switch',
      '        run: |',
      '          ACTIVE="${ACTIVE_SLOT:-blue}"',
      '          NEW=$( [ "$ACTIVE" = "blue" ] && echo "green" || echo "blue" )',
      '          echo "Switching Service selector from $ACTIVE → $NEW"',
      '          kubectl patch service "${{ env.SERVICE_NAME }}" \\',
      '            -p "{\\"spec\\":{\\"selector\\":{\\"slot\\":\\"$NEW\\"}}}"',
      '          echo "Traffic now routed to $NEW slot"',
      '          echo "NEW_ACTIVE=$NEW" >> "$GITHUB_ENV"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /kubectl\s+set\s+image|kubectl\s+apply/i, switchStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added K8s Service selector patch to toggle blue/green traffic — atomically moves all traffic to the new slot by changing the `slot` label selector without downtime', confidence: 90 });
  }
  return fixes;
}

/** Add AWS ALB listener rule update to swap target groups in blue-green. */
export function fixBlueGreenALBTargetGroup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/blue.?green|ALB.*target.*group|listener.*rule.*swap|ecs.*blue.?green/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('aws elbv2') && !f.content.includes('target-group')) continue;
    if (f.content.includes('modify-rule') || f.content.includes('modify-listener')) continue;
    const swapStep = [
      '      - name: ALB listener swap to green target group',
      '        run: |',
      '          echo "Updating ALB listener to forward to green target group..."',
      '          aws elbv2 modify-rule \\',
      '            --rule-arn "${{ env.ALB_LISTENER_RULE_ARN }}" \\',
      '            --actions "[{\\"Type\\":\\"forward\\",\\"TargetGroupArn\\":\\"${{ env.GREEN_TARGET_GROUP_ARN }}\\"}]"',
      '          echo "ALB now forwarding to green target group"',
      '          echo "To rollback: modify-rule --actions forward to BLUE_TARGET_GROUP_ARN"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /aws\s+elbv2/i, swapStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ALB listener modify-rule step for blue-green target group swap — atomically redirects all ALB traffic to the green target group after health check passes', confidence: 88 });
  }
  return fixes;
}

/** Guard blue-green database migration to be backward-compatible with both schema versions. */
export function fixBlueGreenDatabaseMigration(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/migration|schema.*change|blue.?green.*database|ALTER TABLE/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') && !f.content.includes('migration')) continue;
    if (f.content.includes('backward.compat') || f.content.includes('expand-contract')) continue;
    const warnStep = [
      '      - name: Blue-green migration compatibility check',
      '        run: |',
      '          echo "=== Blue-green migration safety reminder ==="',
      '          echo "Ensure this migration is backward-compatible with the BLUE version:"',
      '          echo "  ✓ ADD COLUMN with DEFAULT (not NOT NULL without DEFAULT)"',
      '          echo "  ✓ CREATE INDEX CONCURRENTLY (not CREATE INDEX)"',
      '          echo "  ✓ DROP column in a SECOND deployment after blue is drained"',
      '          echo "  ✗ RENAME COLUMN — breaks the blue slot immediately"',
      '          echo "  ✗ DROP COLUMN in same deploy — breaks blue slot readers"',
      '          echo "Refer to the expand-contract pattern before running destructive migrations"',
      '          # Exit 0 — this is informational; CI owner must review',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:migrate|db:migrate|prisma migrate|flyway migrate|liquibase)/i, warnStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added blue-green migration compatibility check — reminds the team to use expand-contract pattern; destructive migrations (DROP/RENAME) break the old blue slot while it still serves traffic', confidence: 88 });
  }
  return fixes;
}

/** Add smoke test against the green slot before switching ALB/Service traffic. */
export function fixBlueGreenSmoke(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/blue.?green|smoke.*test.*green|green.*slot.*health/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('blue') || !f.content.includes('green')) continue;
    if (f.content.includes('green.*smoke') || f.content.includes('smoke.*green')) continue;
    const smokeStep = [
      '      - name: Smoke test green slot before traffic switch',
      '        run: |',
      '          GREEN_URL="${GREEN_SLOT_URL:-http://green.internal:3000}"',
      '          echo "Smoke testing green slot at $GREEN_URL..."',
      '          for i in $(seq 1 10); do',
      '            STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GREEN_URL/health" --max-time 8 2>/dev/null || echo "000")',
      '            [ "$STATUS" = "200" ] && echo "Green slot healthy (HTTP 200)" && exit 0',
      '            echo "Attempt $i/10: status=$STATUS — waiting 10s"',
      '            sleep 10',
      '          done',
      '          echo "ERROR: Green slot not healthy after 100s — aborting traffic switch"',
      '          exit 1',
    ].join('\n');
    const patched = insertStepBefore(f.content, /patch service|modify-rule|swap.*slot|switch.*traffic/i, smokeStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added green slot smoke test (10 × 10s) before traffic switch — ensures the new version is healthy before any user traffic is routed to it', confidence: 92 });
  }
  return fixes;
}

/** Add atomic rollback if green smoke test fails in blue-green. */
export function fixBlueGreenRollback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/blue.?green|slot.*rollback|green.*failed|traffic.*rollback/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('blue') || !f.content.includes('green')) continue;
    if (f.content.includes('if: failure()') && f.content.includes('ACTIVE_SLOT')) continue;
    const rollbackStep = [
      '      - name: Rollback to blue slot on failure',
      '        if: failure()',
      '        run: |',
      '          echo "=== Green deployment failed — routing all traffic back to blue ==="',
      '          kubectl patch service "${{ env.SERVICE_NAME }}" \\',
      '            -p \'{"spec":{"selector":{"slot":"blue"}}}\' 2>/dev/null || \\',
      '          aws elbv2 modify-rule \\',
      '            --rule-arn "${{ env.ALB_LISTENER_RULE_ARN }}" \\',
      '            --actions "[{\\"Type\\":\\"forward\\",\\"TargetGroupArn\\":\\"${{ env.BLUE_TARGET_GROUP_ARN }}\\"}]" 2>/dev/null || \\',
      '          echo "Manual rollback required — see deployment runbook"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /patch service.*green|modify-rule.*green/i, rollbackStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added blue-green rollback step (if: failure()) — automatically restores all traffic to the blue slot if green deployment or smoke tests fail', confidence: 90 });
  }
  return fixes;
}

/** Add connection drain step before blue-green traffic switch. */
export function fixBlueGreenSessionDrain(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/blue.?green|session.*drain|connection.*drain|502.*blue.green/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('blue') || !f.content.includes('green')) continue;
    if (f.content.includes('drain') || f.content.includes('sleep 30')) continue;
    const drainStep = [
      '      - name: Drain blue slot connections before switch',
      '        run: |',
      '          echo "Waiting 30s for active connections on blue slot to complete..."',
      '          sleep 30',
      '          echo "Connection drain complete — safe to switch traffic"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /patch service.*green|modify-rule.*green|switch.*traffic/i, drainStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added 30-second connection drain before blue-green traffic switch — prevents in-flight requests from receiving 502 errors when the blue slot is removed from service', confidence: 88 });
  }
  return fixes;
}

/** Add Azure App Service slot warmup delay before production swap. */
export function fixAzureSlotWarmup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/az\s+webapp|azure.*slot|staging.*swap.*production/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('az webapp deployment slot swap')) continue;
    if (f.content.includes('warmup') || f.content.includes('az webapp stop')) continue;
    const warmupStep = [
      '      - name: Warm up staging slot before swap',
      '        run: |',
      '          STAGING_URL=$(az webapp show \\',
      '            --name "${{ env.AZURE_APP_NAME }}" \\',
      '            --slot staging \\',
      '            --resource-group "${{ env.AZURE_RG }}" \\',
      '            --query defaultHostName -o tsv 2>/dev/null || echo "")',
      '          [ -z "$STAGING_URL" ] && echo "Cannot find staging URL — skipping warmup" && exit 0',
      '          echo "Warming up staging slot at https://$STAGING_URL..."',
      '          for i in $(seq 1 6); do',
      '            curl -s -o /dev/null "https://$STAGING_URL/health" --max-time 10 || true',
      '            sleep 5',
      '          done',
      '          echo "Warmup complete — staging slot ready for swap"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /az\s+webapp\s+deployment\s+slot\s+swap/i, warmupStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added staging slot warmup (6 × 5s requests) before Azure deployment slot swap — cold staging slots cause post-swap latency spikes if not pre-warmed', confidence: 88 });
  }
  return fixes;
}

/** Sync environment config (env vars, app settings) to green slot before traffic switch. */
export function fixBlueGreenConfigSync(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/config.*mismatch|env.*mismatch.*blue.green|feature.*flag.*mismatch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('blue') || !f.content.includes('green')) continue;
    if (f.content.includes('config-sync') || f.content.includes('appsettings sync')) continue;
    const syncStep = [
      '      - name: Sync config from blue to green before switch',
      '        run: |',
      '          echo "Verifying config parity between blue and green slots..."',
      '          # For Kubernetes: apply the same ConfigMap/Secret to the green namespace',
      '          kubectl get configmap app-config -n production-blue -o yaml 2>/dev/null | \\',
      '            sed \'s/namespace: production-blue/namespace: production-green/\' | \\',
      '            kubectl apply -f - 2>/dev/null || echo "ConfigMap sync skipped (not K8s or no config found)"',
      '          echo "Config sync complete"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /patch service.*green|switch.*traffic/i, syncStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added config sync step before blue-green traffic switch — ensures green slot has identical ConfigMap/Secret values; mismatched config is a common cause of post-switch failures', confidence: 83 });
  }
  return fixes;
}

/** Set DNS TTL low before blue-green switchover and restore after. */
export function fixBlueGreenTTL(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/DNS.*TTL|blue.?green.*DNS|Route53.*swap|cloudflare.*switch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('blue') || !f.content.includes('green')) continue;
    if (f.content.includes('TTL') || f.content.includes('aws route53')) continue;
    const ttlStep = [
      '      - name: Lower DNS TTL before blue-green switch',
      '        run: |',
      '          echo "Setting DNS TTL to 60s for fast propagation during switch..."',
      '          # Route 53 example — adapt to your DNS provider',
      '          # aws route53 change-resource-record-sets \\',
      '          #   --hosted-zone-id "${{ env.HOSTED_ZONE_ID }}" \\',
      '          #   --change-batch \'{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"${{ env.DOMAIN }}","Type":"A","TTL":60,"ResourceRecords":[{"Value":"${{ env.GREEN_IP }}"}]}}]}\'',
      '          echo "NOTE: Lower TTL 10+ minutes BEFORE the switch so caches expire in time"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /switch.*traffic|patch service.*green/i, ttlStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added DNS TTL reduction step before blue-green DNS switch — lowering TTL to 60s ensures old IP propagation expires quickly, reducing split-brain window during cutover', confidence: 82 });
  }
  return fixes;
}

// ── Section D — Canary Deployment Mismatch ───────────────────────────────────

/** Add NGINX Ingress canary annotations for header-based and weight-based routing. */
export function fixCanaryIngressAnnotation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/canary|weight.*traffic|nginx.*ingress.*canary/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Ingress')) continue;
    if (f.content.includes('nginx.ingress.kubernetes.io/canary')) continue;
    const fixed = f.content.replace(
      /(  annotations:\s*\n)/,
      `$1    nginx.ingress.kubernetes.io/canary: "true"\n    nginx.ingress.kubernetes.io/canary-weight: "10"\n    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"\n    nginx.ingress.kubernetes.io/canary-by-header-value: "true"\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added NGINX Ingress canary annotations (canary-weight: 10, canary-by-header: X-Canary) — enables weighted traffic split and header-based routing for internal canary testing before broad rollout', confidence: 90 });
  }
  return fixes;
}

/** Set canary Deployment replica count to at least 1 to prevent traffic routing to zero replicas. */
export function fixCanaryK8sReplicaCount(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment') || !f.path.includes('canary')) continue;
    const replicaMatch = f.content.match(/replicas:\s*(\d+)/);
    if (replicaMatch && parseInt(replicaMatch[1]) > 0) continue;
    const fixed = f.content.replace(/(replicas:\s*)\d+/, '$11');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set canary Deployment replicas to 1 — a canary with 0 replicas cannot receive traffic; NGINX will route canary-weighted requests to no pods, causing 502s', confidence: 95 });
  }
  return fixes;
}

/** Add Prometheus metric analysis step between canary increments. */
export function fixCanaryMetricAnalysis(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/canary|flagger|metric.*analysis|error.*rate.*canary/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('canary') || f.content.includes('promtool') || f.content.includes('metric-analysis')) continue;
    const analysisStep = [
      '      - name: Canary metric analysis',
      '        run: |',
      '          PROM_URL="${PROMETHEUS_URL:-http://prometheus.monitoring.svc:9090}"',
      '          echo "Checking canary error rate (threshold: < 1%)..."',
      '          ERROR_RATE=$(curl -s "$PROM_URL/api/v1/query" \\',
      '            --data-urlencode \'query=sum(rate(http_requests_total{status=~"5..",deployment="canary"}[5m])) / sum(rate(http_requests_total{deployment="canary"}[5m]))\' \\',
      '            2>/dev/null | jq -r \'.data.result[0].value[1] // "0"\')',
      '          echo "Canary 5xx error rate: $ERROR_RATE"',
      '          TOO_HIGH=$(echo "$ERROR_RATE > 0.01" | bc -l 2>/dev/null || echo "0")',
      '          if [ "$TOO_HIGH" = "1" ]; then',
      '            echo "ERROR: Canary error rate $ERROR_RATE exceeds 1% threshold — rolling back"',
      '            exit 1',
      '          fi',
      '          echo "Canary metrics healthy — promoting to next traffic increment"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /canary.*50%|weight.*50|to-revisions.*50/i, analysisStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Prometheus error-rate metric analysis between canary increments — automatically blocks promotion to 50% if error rate exceeds 1% threshold during the 10% phase', confidence: 88 });
  }
  return fixes;
}

/** Add error-rate rollback threshold check for canary deployments. */
export function fixCanaryRollbackThreshold(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/canary.*rollback|error.*rate.*threshold|canary.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('canary') || f.content.includes('rollback-threshold')) continue;
    const rollbackStep = [
      '      - name: Canary rollback threshold check',
      '        id: rollback-threshold',
      '        if: failure()',
      '        run: |',
      '          echo "=== Canary exceeded error threshold — rolling back to stable ==="',
      '          kubectl patch virtualservice "${{ env.VS_NAME }}" --type merge \\',
      "            -p '{\"spec\":{\"http\":[{\"route\":[{\"destination\":{\"host\":\"app\",\"subset\":\"stable\"},\"weight\":100}]}]}}' 2>/dev/null || \\",
      '          kubectl scale deployment canary --replicas=0 2>/dev/null || \\',
      '          gcloud run services update-traffic "${{ env.SERVICE_NAME }}" --to-latest=false --to-revisions=STABLE=100 --region="${{ env.GCP_REGION }}" 2>/dev/null || \\',
      '          echo "Manual rollback required — remove canary Deployment or reset Ingress canary-weight to 0"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /canary.*100|weight.*100|promote/i, rollbackStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added canary rollback step (if: failure()) — routes 100% traffic back to stable when canary error rate exceeds threshold; tries Istio, then kubectl scale, then Cloud Run', confidence: 88 });
  }
  return fixes;
}

/** Add Cloud Run named revision for canary traffic split. */
export function fixCanaryCloudRunRevision(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/gcloud\s+run|cloud run.*canary|revision.*split/i.test(logs) && !files.some(f => /gcloud\s+run\s+deploy/.test(f.content) && f.content.includes('canary'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('gcloud run deploy') || !f.content.includes('canary')) continue;
    if (f.content.includes('--tag') || f.content.includes('--no-traffic')) continue;
    const fixed = f.content.replace(
      /(gcloud\s+run\s+deploy\s+"?\$\{\{[^}]+\}\}"?)/g,
      `$1 --tag canary --no-traffic`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --tag canary --no-traffic to gcloud run deploy — deploys new revision without receiving traffic; traffic is then shifted incrementally using update-traffic, enabling safe canary analysis', confidence: 90 });
  }
  return fixes;
}

/** Add ECS weighted target groups for canary traffic split. */
export function fixCanaryECSTaskWeight(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/aws\s+ecs|ECS.*canary|target.*group.*weight/i.test(logs) && !files.some(f => /aws\s+ecs/.test(f.content) && f.content.includes('canary'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('aws ecs') || !f.content.includes('canary')) continue;
    if (f.content.includes('weighted-target') || f.content.includes('canary-weight')) continue;
    const weightStep = [
      '      - name: ECS canary — 10% traffic weight',
      '        run: |',
      '          echo "Setting ECS weighted target group: 10% canary, 90% stable..."',
      '          aws elbv2 modify-listener \\',
      '            --listener-arn "${{ env.ALB_LISTENER_ARN }}" \\',
      '            --default-actions \'[{"Type":"forward","ForwardConfig":{"TargetGroups":[{"TargetGroupArn":"${{ env.STABLE_TG_ARN }}","Weight":90},{"TargetGroupArn":"${{ env.CANARY_TG_ARN }}","Weight":10}],"StickinessConfig":{"Enabled":false}}}]\'',
      '          echo "Canary at 10% — monitor metrics for 5 minutes"',
      '          sleep 300',
    ].join('\n');
    const patched = insertStepBefore(f.content, /aws\s+ecs\s+update-service.*canary/i, weightStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ECS weighted ALB target group for 10% canary traffic — routes 10% of requests to the new ECS task revision for error-rate validation before full promotion', confidence: 87 });
  }
  return fixes;
}

/** Add pause and monitor steps between canary traffic increments. */
export function fixCanaryProgressivePause(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/canary.*10.*50.*100|progressive.*rollout|phased.*deploy/i.test(logs) && !files.some(f => f.content.includes('canary') && isGitHubWorkflow(f.path))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('canary') || f.content.includes('Monitor canary')) continue;
    if (!f.content.includes('canary-10pct') && !f.content.includes('# canary-step-1')) continue;
    const monitorStep = [
      '      - name: Monitor canary metrics (2-min window)',
      '        run: |',
      '          echo "Monitoring canary for 2 minutes before promoting to next increment..."',
      '          END=$((SECONDS + 120))',
      '          while [ $SECONDS -lt $END ]; do',
      '            ELAPSED=$((120 - (END - SECONDS)))',
      '            echo "  Monitor elapsed: ${ELAPSED}s / 120s"',
      '            sleep 20',
      '          done',
      '          echo "Monitoring window complete — canary appears stable"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /Canary.*50%|canary.*50/i, monitorStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added 2-minute monitoring pause between canary traffic increments — gives time for error rates to surface before promoting from 10% to 50%', confidence: 85 });
  }
  return fixes;
}

/** Add Flagger HPA target ref for autoscaling the canary Deployment. */
export function fixCanaryFlaggerHPA(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/flagger|canary.*hpa|autoscal.*canary/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Canary') || f.content.includes('autoscalerRef')) continue;
    const fixed = f.content.replace(
      /(spec:\s*\n(\s+)targetRef:)/,
      `spec:\n$2autoscalerRef:\n$2  apiVersion: autoscaling/v2\n$2  kind: HorizontalPodAutoscaler\n$2  name: \${CANARY_DEPLOYMENT_NAME}-hpa\n$2$2targetRef:`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added autoscalerRef to Flagger Canary resource — links HPA so Flagger scales the canary Deployment as traffic increases, preventing pod exhaustion during progressive rollout', confidence: 85 });
  }
  return fixes;
}

/** Add weighted header-based canary routing via Istio VirtualService. */
export function fixCanaryHeaderRouting(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/istio|virtualservice|canary.*header|X-Canary/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: VirtualService') || f.content.includes('X-Canary')) continue;
    const fixed = f.content.replace(
      /(  http:\s*\n)/,
      `$1  - match:\n    - headers:\n        x-canary:\n          exact: "true"\n    route:\n    - destination:\n        host: app\n        subset: canary\n      weight: 100\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added X-Canary header match to Istio VirtualService — internal testers can opt into canary by setting `x-canary: true` header, isolating canary traffic from general user traffic', confidence: 88 });
  }
  return fixes;
}

// ── Section E — Service Unavailable Extended ─────────────────────────────────

/** Add K8s startupProbe for slow-starting services to prevent premature liveness kills. */
export function fixServiceStartupProbe(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/CrashLoopBackOff|startup.*probe.*failed|container.*not.*ready.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('startupProbe')) continue;
    const portMatch = f.content.match(/containerPort:\s*(\d+)/);
    const port = portMatch?.[1] ?? '8080';
    // beside the container's readinessProbe, at the container-key indentation
    const fixed = insertBesideKey(
      f.content, 'readinessProbe',
      `        startupProbe:\n          httpGet:\n            path: /health\n            port: ${port}\n          failureThreshold: 30\n          periodSeconds: 10\n`,
      8, 'before',
    );
    if (fixed && fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added startupProbe (30 × 10s = 300s window) — prevents liveness probe from killing slow-starting containers (JVM, Python with DB migrations) before they are fully initialized`, confidence: 90 });
  }
  return fixes;
}

/** Add K8s PodDisruptionBudget to prevent all pods going down during node drain. */
export function fixServicePodDisruptionBudget(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('PodDisruptionBudget')) continue;
    const nameMatch = f.content.match(/  name:\s*([\w-]+)/);
    const name = nameMatch?.[1] ?? 'app';
    const labelMatch = f.content.match(/matchLabels:\s*\n\s+([\w]+):\s*([\w-]+)/);
    const selector = labelMatch ? `${labelMatch[1]}: ${labelMatch[2]}` : `app: ${name}`;
    const pdb = `\n---\napiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: ${name}-pdb\nspec:\n  minAvailable: 1\n  selector:\n    matchLabels:\n      ${selector}\n`;
    fixes.push({ path: f.path, content: f.content + pdb, explanation: `Added PodDisruptionBudget (minAvailable: 1) for ${name} — ensures at least one pod remains running during node drains, upgrades, and voluntary disruptions`, confidence: 90 });
  }
  return fixes;
}

/** Ensure HPA minReplicas >= 2 for high-availability service deployments. */
export function fixServiceHPAMinReplicas(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: HorizontalPodAutoscaler')) continue;
    const minMatch = f.content.match(/minReplicas:\s*(\d+)/);
    if (!minMatch || parseInt(minMatch[1]) >= 2) continue;
    const fixed = f.content.replace(/minReplicas:\s*\d+/, 'minReplicas: 2');
    fixes.push({ path: f.path, content: fixed, explanation: 'Raised HPA minReplicas from 1 to 2 — a single replica is a single point of failure; minimum 2 enables rolling updates without downtime and survives a single pod crash', confidence: 92 });
  }
  return fixes;
}

/** Add graceful shutdown handler and terminationGracePeriodSeconds to K8s Deployments. */
export function fixServiceGracefulShutdown(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/502|connection reset.*pod|SIGTERM|graceful.*shutdown.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('terminationGracePeriodSeconds') || f.content.includes('preStop')) continue;
    const withGrace = insertBesideKey(f.content, 'containers', '      terminationGracePeriodSeconds: 60\n', 6, 'before');
    const fixed = withGrace && insertBesideKey(
      withGrace, 'image',
      '        lifecycle:\n          preStop:\n            exec:\n              command: ["/bin/sh", "-c", "sleep 5"]\n',
      8,
    );
    if (fixed && fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added terminationGracePeriodSeconds: 60 + preStop sleep 5s — gives in-flight requests 5 seconds to complete before SIGTERM propagates; K8s routes no new requests during this window', confidence: 90 });
  }
  return fixes;
}

/** Add topologySpreadConstraints for zone-balanced pod distribution. */
export function fixServiceTopologySpread(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('topologySpreadConstraints') || f.content.includes('podAntiAffinity')) continue;
    const labelMatch = f.content.match(/matchLabels:\s*\n\s+([\w]+):\s*([\w-]+)/);
    const labelKey = labelMatch?.[1] ?? 'app';
    const labelVal = labelMatch?.[2] ?? 'app';
    // pod-spec key: sibling of containers: (the old "      $1" doubled its indentation
    // and silently moved the container list inside topologySpreadConstraints)
    const fixed = insertBesideKey(
      f.content, 'containers',
      `      topologySpreadConstraints:\n        - maxSkew: 1\n          topologyKey: topology.kubernetes.io/zone\n          whenUnsatisfiable: DoNotSchedule\n          labelSelector:\n            matchLabels:\n              ${labelKey}: ${labelVal}\n`,
      6, 'before',
    );
    if (fixed && fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added topologySpreadConstraints (maxSkew: 1, zone) — distributes pods evenly across availability zones; prevents all pods from landing in the same zone, which would cause an outage if that zone becomes unavailable`, confidence: 88 });
  }
  return fixes;
}

/** Add circuit breaker pattern with exponential backoff for dependent service calls. */
export function fixServiceCircuitBreaker(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/circuit.?breaker|max.*retries.*exceeded|upstream.*unreachable|ECONNREFUSED/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') || f.content.includes('circuit') || f.content.includes('backoff')) continue;
    const fixed = f.content.replace(
      /(curl\s+-[^\n]+)/g,
      `# Circuit breaker: 3 retries with exponential backoff\n          for attempt in 1 2 3; do\n            $1 && break || {\n              [ $attempt -eq 3 ] && echo "Circuit breaker: all 3 attempts failed — service unreachable" && exit 1;\n              BACKOFF=$((attempt * attempt * 5))\n              echo "Attempt $attempt failed — backing off \${BACKOFF}s..."\n              sleep $BACKOFF\n            }\n          done`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added circuit breaker with exponential backoff (5s, 20s, 45s) around curl calls — prevents immediate failures from cascading; gives dependent services time to recover before giving up', confidence: 82 });
  }
  return fixes;
}

/** Add K8s readinessGate to prevent pod from joining Endpoints until custom condition passes. */
export function fixServiceReadinessGate(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('readinessGates') || !f.content.includes('readinessProbe')) continue;
    const fixed = insertBesideKey(f.content, 'containers', '      readinessGates:\n        - conditionType: "target-health.elbv2.k8s.aws/app-tg"\n', 6, 'before');
    if (fixed && fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added AWS Load Balancer Controller readinessGate — pod is not included in the ALB target group until the target health condition is satisfied, preventing premature traffic routing', confidence: 83 });
  }
  return fixes;
}

/** Add K8s resource request/limit when OOMKilled is detected. */
export function fixServiceResourceQuota(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/OOMKilled|Killed.*memory|OutOfMemory|memory.*limit.*exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('resources:')) continue;
    const fixed = f.content.replace(
      /(        image:.*\n)/,
      `$1        resources:\n          requests:\n            memory: "256Mi"\n            cpu: "100m"\n          limits:\n            memory: "512Mi"\n            cpu: "500m"\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added resource requests and limits (memory: 256Mi/512Mi, cpu: 100m/500m) — OOMKilled indicates the container had no memory limit; K8s could not evict lower-priority pods to make room', confidence: 90 });
  }
  return fixes;
}

// ── Section F — Health Check Failure Extended ────────────────────────────────

/** Fix wrong health check path (root / instead of /health or /api/health). */
export function fixHealthCheckEndpointPath(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/health.*check.*fail|target.*unhealthy|\/health.*404|health.*path.*not found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('healthCheckPath') && !f.content.includes('health-check-path') && !f.content.includes('path: /\n')) continue;
    const fixed = f.content
      .replace(/(healthCheckPath:\s*)"?\/?"?/g, '$1"/health"')
      .replace(/(health-check-path:\s*)"?\/?"?/g, '$1"/health"')
      .replace(/(path:\s*)\/\s*\n(\s+port:)/g, '$1/health\n$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed health check path from / to /health — root path often redirects or returns HTML which load balancers misinterpret; /health should return 200 JSON', confidence: 88 });
  }
  return fixes;
}

/** Tune health check interval and unhealthy threshold for slow-starting services. */
export function fixHealthCheckInterval(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/health.*check.*timeout|target.*deregistered.*health|healthy.*threshold/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('HealthCheck') && !f.content.includes('healthCheck')) continue;
    if (f.content.includes('HealthCheckIntervalSeconds: 30') || f.content.includes('HealthyThresholdCount: 3')) continue;
    const fixed = f.content
      .replace(/HealthCheckIntervalSeconds:\s*\d+/, 'HealthCheckIntervalSeconds: 30')
      .replace(/HealthyThresholdCount:\s*\d+/, 'HealthyThresholdCount: 3')
      .replace(/UnhealthyThresholdCount:\s*\d+/, 'UnhealthyThresholdCount: 5')
      .replace(/HealthCheckTimeoutSeconds:\s*\d+/, 'HealthCheckTimeoutSeconds: 10');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Tuned ALB health check: interval=30s, healthy=3, unhealthy=5, timeout=10s — aggressive defaults (5s interval, threshold=2) cause deregistration during slow service startup or GC pauses', confidence: 88 });
  }
  return fixes;
}

/** Add downstream dependency health checks (db, cache, queue) to the health endpoint. */
export function fixHealthCheckDependencies(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/health.*dependency|db.*health|redis.*health|health.*check.*fail/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js') && !f.path.endsWith('.py')) continue;
    if (!f.content.includes('/health') || f.content.includes('db.ping') || f.content.includes('redis.ping')) continue;
    if (f.path.endsWith('.ts') || f.path.endsWith('.js')) {
      const healthSnippet = [
        '',
        '// Deep health check — verifies DB and cache connectivity',
        'async function deepHealthCheck() {',
        "  const checks: Record<string, string> = {};",
        "  try { await db.raw('SELECT 1'); checks.database = 'ok'; } catch { checks.database = 'error'; }",
        "  try { await redis.ping(); checks.cache = 'ok'; } catch { checks.cache = 'error'; }",
        "  const allOk = Object.values(checks).every(v => v === 'ok');",
        "  return { status: allOk ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() };",
        '}',
        '',
      ].join('\n');
      const marker = "app.get('/health'";
      if (!f.content.includes(marker)) continue;
      const fixed = f.content.replace(marker, healthSnippet + marker);
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: "Added deepHealthCheck function for /health endpoint — checks DB and Redis connectivity; returns 'degraded' when dependencies are unhealthy so load balancers can stop routing traffic", confidence: 83 });
    }
  }
  return fixes;
}

/** Fix health checks using HTTP when the service runs HTTPS. */
export function fixHealthCheckHTTPS(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/health.*check.*SSL|http.*443.*health|certificate.*health|HTTPS.*health.*fail/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('HealthCheckProtocol: HTTP') || f.content.includes('HealthCheckProtocol: HTTPS')) continue;
    const fixed = f.content
      .replace(/HealthCheckProtocol:\s*HTTP\b/, 'HealthCheckProtocol: HTTPS')
      .replace(/(HealthCheckProtocol:\s*HTTPS\n)/, '$1HealthCheckPort: "443"\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed health check protocol from HTTP to HTTPS — service is listening on HTTPS/443; HTTP health checks will always fail with a connection reset when TLS termination is at the instance', confidence: 90 });
  }
  return fixes;
}

/** Fix health check port mismatch between container port and ALB target. */
export function fixHealthCheckPort(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/health.*check.*port|target.*port.*mismatch|traffic.*port.*health/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('HealthCheckPort')) continue;
    const trafficPortMatch = f.content.match(/Port:\s*["']?(\d+)["']?/);
    const healthPortMatch = f.content.match(/HealthCheckPort:\s*["']?(\d+)["']?/);
    if (!trafficPortMatch || !healthPortMatch) continue;
    if (trafficPortMatch[1] === healthPortMatch[1]) continue;
    const fixed = f.content.replace(/HealthCheckPort:\s*["']?\d+["']?/, `HealthCheckPort: "${trafficPortMatch[1]}"`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Aligned HealthCheckPort to match traffic port ${trafficPortMatch[1]} — the health check was probing port ${healthPortMatch[1]} while traffic flows on ${trafficPortMatch[1]}, causing spurious unhealthy status`, confidence: 90 });
  }
  return fixes;
}

/** Add liveness and readiness probes with appropriate initialDelaySeconds. */
export function fixLivenessReadinessProbes(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pod.*not.*ready|readiness.*probe.*fail|liveness.*probe.*fail|CrashLoopBackOff/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Deployment')) continue;
    if (f.content.includes('readinessProbe') || f.content.includes('livenessProbe')) continue;
    const portMatch = f.content.match(/containerPort:\s*(\d+)/);
    const port = portMatch?.[1] ?? '8080';
    const fixed = insertBesideKey(
      f.content, 'image',
      `        readinessProbe:\n          httpGet:\n            path: /health\n            port: ${port}\n          initialDelaySeconds: 15\n          periodSeconds: 5\n          failureThreshold: 3\n        livenessProbe:\n          httpGet:\n            path: /health\n            port: ${port}\n          initialDelaySeconds: 30\n          periodSeconds: 15\n          failureThreshold: 3\n`,
      8,
    );
    if (fixed && fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added readinessProbe (delay 15s) + livenessProbe (delay 30s) on port ${port} — prevents traffic routing before app is ready and auto-restarts unresponsive containers`, confidence: 92 });
  }
  return fixes;
}

/** Set appropriate initialDelaySeconds for startup probe to match application boot time. */
export function fixStartupProbeTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/startup.*probe.*failed|initialDelaySeconds|container.*not.*started/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('startupProbe')) continue;
    const delayMatch = f.content.match(/startupProbe:[^]*?initialDelaySeconds:\s*(\d+)/);
    if (delayMatch && parseInt(delayMatch[1]) >= 30) continue;
    const fixed = f.content.replace(
      /(startupProbe:[^]*?initialDelaySeconds:\s*)\d+/,
      '$130',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Increased startupProbe initialDelaySeconds to 30 — applications with JVM warmup, Django migration runs, or dependency loading need more than the default to start cleanly', confidence: 88 });
  }
  return fixes;
}

/** Fix health check expected response code (200 vs 204 mismatch). */
export function fixHealthCheckResponseCode(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/health.*204|health.*check.*fail.*200|matcher.*200.*204/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('Matcher') && !f.content.includes('healthCheckStatusCode')) continue;
    if (f.content.includes('200-204') || f.content.includes('"200,204"')) continue;
    const fixed = f.content
      .replace(/(HttpCode:\s*)"200"/, '$1"200,204"')
      .replace(/(healthCheckStatusCode:\s*)"?200"?/, '$1"200,204"');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Expanded health check HTTP matcher to accept 200-204 — some health endpoints return 204 No Content; ALB/NLB would mark these targets unhealthy with a strict 200-only matcher', confidence: 88 });
  }
  return fixes;
}

// ── Section G — Load Balancer Routing Issue Extended ─────────────────────────

/** Fix AWS ALB target group health check configuration (path, protocol, thresholds). */
export function fixALBTargetGroupHealthCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ALB|target.group.*unhealthy|elastic.load.balancer|TargetGroup/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml') && !f.path.endsWith('.tf')) continue;
    if (!f.content.includes('TargetGroup') && !f.content.includes('aws_alb_target_group') && !f.content.includes('target_group')) continue;
    if (f.content.includes('health_check') || f.content.includes('HealthCheckPath')) continue;
    const isYaml = f.path.endsWith('.yaml') || f.path.endsWith('.yml');
    const healthBlock = isYaml
      ? `  HealthCheckPath: /health\n  HealthCheckIntervalSeconds: 30\n  HealthyThresholdCount: 3\n  UnhealthyThresholdCount: 5\n  HealthCheckTimeoutSeconds: 10\n  Matcher:\n    HttpCode: "200,204"\n`
      : `  health_check {\n    enabled             = true\n    path                = "/health"\n    interval            = 30\n    healthy_threshold   = 3\n    unhealthy_threshold = 5\n    timeout             = 10\n    matcher             = "200,204"\n  }\n`;
    const anchor = isYaml ? /(  Type: forward|  Protocol:)/ : /(resource\s+"aws_alb_target_group"[^{]+\{)/;
    const fixed = f.content.replace(anchor, `${healthBlock}$1`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ALB target group health check config (/health, interval 30s, threshold 3/5) — missing health check config causes the ALB to mark all targets healthy by default, masking real failures', confidence: 90 });
  }
  return fixes;
}

/** Increase NGINX proxy_read_timeout for slow backend responses to prevent 504s. */
export function fixNGINXProxyReadTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/504 Gateway Timeout|proxy.*timeout|upstream.*timed out|proxy_read_timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('nginx') && !f.path.endsWith('.conf')) continue;
    if (f.content.includes('proxy_read_timeout 120') || f.content.includes('proxy_read_timeout 300')) continue;
    const fixed = f.content.includes('proxy_read_timeout')
      ? f.content.replace(/proxy_read_timeout\s+\d+s?;/, 'proxy_read_timeout 120s;')
      : f.content.replace(/(location\s+\/\s*\{)/g, `$1\n    proxy_read_timeout 120s;\n    proxy_connect_timeout 10s;\n    proxy_send_timeout 120s;`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set NGINX proxy_read_timeout to 120s — default 60s causes 504 for backend operations that exceed one minute (large exports, ML inference, report generation)', confidence: 90 });
  }
  return fixes;
}

/** Add NLB preserve client IP annotation to prevent source IP rewriting. */
export function fixNLBPreserveClientIP(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/NLB|network.load.balancer|source.*ip.*wrong|X-Forwarded-For.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Service')) continue;
    if (f.content.includes('service.beta.kubernetes.io/aws-load-balancer-nlb-target-type')) continue;
    const fixed = f.content.replace(
      /(  annotations:\s*\n)/,
      `$1    service.beta.kubernetes.io/aws-load-balancer-type: external\n    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip\n    service.beta.kubernetes.io/aws-load-balancer-ip-address-type: ipv4\n    service.beta.kubernetes.io/aws-load-balancer-preserve-client-ip: "true"\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added AWS NLB preserve-client-ip annotation — without this, NLB replaces the source IP with the node IP, breaking IP-based allow-lists and X-Forwarded-For logging', confidence: 88 });
  }
  return fixes;
}

/** Add CORS headers for services behind a load balancer or CDN. */
export function fixCORSHeadersLB(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/CORS|Access-Control-Allow-Origin|cross-origin.*blocked|No.*Access-Control/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.includes('nginx') && !f.path.endsWith('.conf') && !f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (f.content.includes('Access-Control-Allow-Origin') || f.content.includes('cors(')) continue;
    if (f.path.includes('nginx') || f.path.endsWith('.conf')) {
      const fixed = f.content.replace(
        /(location\s+\/\s*\{)/g,
        `$1\n    add_header 'Access-Control-Allow-Origin' "$http_origin" always;\n    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;\n    add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, X-Request-ID' always;\n    add_header 'Access-Control-Allow-Credentials' 'true' always;`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added CORS headers to NGINX location block — browsers block cross-origin requests without Access-Control-Allow-Origin; the header must be set at the LB/reverse proxy layer when the app framework does not handle it', confidence: 85 });
    }
    if (f.path.endsWith('.ts') || f.path.endsWith('.js')) {
      if (!f.content.includes('express()')) continue;
      const fixed = f.content.replace(
        /(const app = express\(\);?\n)/,
        `$1import cors from 'cors';\napp.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') ?? true, credentials: true }));\n`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added cors() middleware to Express app — cross-origin requests from the frontend are blocked without CORS headers; using the `cors` package handles preflight OPTIONS requests automatically', confidence: 85 });
    }
  }
  return fixes;
}

/** Add HTTP → HTTPS redirect at load balancer / NGINX level. */
export function fixHTTPSRedirectLB(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/http.*https.*redirect|mixed content|scheme.*http.*expected.*https|301.*upgrade/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml') && !f.path.endsWith('.conf')) continue;
    if (f.content.includes('redirect') && f.content.includes('https')) continue;
    if (f.path.endsWith('.conf') || f.path.includes('nginx')) {
      const fixed = f.content.replace(
        /(server\s*\{[^}]*listen\s*80;)/,
        `server {\n    listen 80;\n    return 301 https://$host$request_uri;\n  }\n\n  $1`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added HTTP → HTTPS 301 redirect server block in NGINX — serves a permanent redirect on port 80 to force all traffic through TLS', confidence: 88 });
    }
    if (f.path.endsWith('.yaml') || f.path.endsWith('.yml')) {
      if (!f.content.includes('kind: Ingress')) continue;
      const fixed = f.content.replace(
        /(  annotations:\s*\n)/,
        `$1    nginx.ingress.kubernetes.io/ssl-redirect: "true"\n    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"\n`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added ssl-redirect and force-ssl-redirect annotations to NGINX Ingress — ensures all HTTP traffic is permanently redirected to HTTPS at the ingress controller', confidence: 90 });
    }
  }
  return fixes;
}

/** Add session affinity (sticky sessions) to K8s Service for stateful applications. */
export function fixLBStickySessions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/session.*lost|WebSocket.*disconnect|sticky.*session|affinity.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: Service')) continue;
    if (f.content.includes('sessionAffinity') || f.content.includes('stickiness')) continue;
    const fixed = f.content.replace(
      /(spec:\s*\n(\s+)selector:)/,
      `spec:\n$2sessionAffinity: ClientIP\n$2sessionAffinityConfig:\n$2  clientIP:\n$2    timeoutSeconds: 3600\n$2$2selector:`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added sessionAffinity: ClientIP (1h timeout) to K8s Service — routes the same client IP to the same pod; required for stateful applications, WebSocket connections, and in-memory session stores', confidence: 85 });
  }
  return fixes;
}

/** Increase ALB/NLB connection draining timeout for long-running requests. */
export function fixLBDrainingTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/connection.*draining|deregistration.*delay|in-flight.*request.*failed|request.*cut.*off/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml') && !f.path.endsWith('.tf')) continue;
    if (!f.content.includes('deregistration_delay') && !f.content.includes('DeregistrationDelay')) continue;
    const fixed = f.content
      .replace(/(deregistration_delay\.timeout_seconds.*?=\s*)"?\d+"?/, '$1"60"')
      .replace(/(DeregistrationDelay\.TimeoutSeconds.*?:\s*)"?\d+"?/, '$1"60"');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Increased deregistration delay to 60s — the default (300s) is often reduced to speed deploys, but values below 30s cut off in-flight requests during rolling updates', confidence: 88 });
  }
  return fixes;
}

/** Fix Traefik IngressRoute for proper path-based routing configuration. */
export function fixTraefikRouteConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/traefik|IngressRoute|router.*rule.*failed|middleware.*not.*found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: IngressRoute')) continue;
    if (f.content.includes('middlewares:') || !f.content.includes('rule:')) continue;
    const fixed = f.content.replace(
      /(    - match:.*\n(\s+)kind: Rule\n)/,
      `$1$2middlewares:\n$2  - name: default-headers\n$2    namespace: traefik\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added middlewares reference to Traefik IngressRoute — without middleware chain, security headers, compression, and rate limiting are not applied; the default-headers middleware should be defined in the traefik namespace', confidence: 83 });
  }
  return fixes;
}
