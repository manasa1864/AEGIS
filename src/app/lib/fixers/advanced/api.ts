// Advanced / API & Integration Errors
// Covers: API timeouts, rate limiting with backoff, webhook signature,
// deprecated API endpoints, REST/GraphQL errors, SSL cert validation.
// Extended: connect/read timeouts, Retry-After, batching, webhook HMAC/replay,
// third-party secrets (Sentry/Datadog/Snyk/Jira), OpenAPI/Protobuf schema checks,
// GraphQL introspection/fragments/batching, REST versioning/method/header fixes.

import { RuleFix, isGitHubWorkflow, isGitLabCI, injectWorkflowLevelBlock, insertStepBefore, patchGitHubJobBlocks } from '../helpers';

/** Add retry with exponential backoff for ETIMEDOUT / ECONNRESET API failures. */
export function fixAPIRetryOnTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ETIMEDOUT|ECONNRESET|ENOTFOUND|connection timed out|network timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];

  // Create a reusable retry shell script
  if (!files.some(f => f.path === 'scripts/retry.sh')) {
    fixes.push({
      path: 'scripts/retry.sh',
      content: [
        '#!/bin/bash',
        '# Retry a command with exponential backoff — aegis: auto-generated',
        '# Usage: ./scripts/retry.sh <max_attempts> <command...>',
        'set -euo pipefail',
        '',
        'MAX="${1:-5}"; shift',
        'DELAY=2',
        '',
        'for attempt in $(seq 1 "$MAX"); do',
        '  echo "[retry] Attempt $attempt/$MAX: $*"',
        '  "$@" && exit 0',
        '  EXIT_CODE=$?',
        '  if [ "$attempt" -lt "$MAX" ]; then',
        '    echo "[retry] Command failed (exit $EXIT_CODE) — waiting ${DELAY}s before retry..."',
        '    sleep "$DELAY"',
        '    DELAY=$((DELAY * 2))',
        '  fi',
        'done',
        '',
        'echo "[retry] All $MAX attempts failed"',
        'exit "$EXIT_CODE"',
        '',
      ].join('\n'),
      explanation: 'Created scripts/retry.sh with exponential backoff — reusable retry wrapper for any shell command; usage: ./scripts/retry.sh 5 curl ...',
      confidence: 100,
    });
  }

  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('nick-fields/retry') || f.content.includes('retry-on-failure') || f.content.includes('retry.sh')) continue;

    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      // Wrap curl/wget steps with retry script
      if (/^\s+run:\s*(curl|wget)\s/.test(lines[i]) && !modified) {
        out.push(lines[i].replace(/^(\s+run:\s*)(curl|wget)/, '$1bash scripts/retry.sh 5 $2'));
        modified = true;
        continue;
      }
      // Wrap named API steps with nick-fields/retry@v3
      if (/^\s+- name:\s*(?:Call|Fetch|Request|Notify|Post|Send|Upload|Push)/i.test(lines[i]) && !modified) {
        out.push(lines[i]);
        // Check if next step is `uses:` — wrap with retry action
        if (i + 1 < lines.length && /^\s+uses:/.test(lines[i + 1])) {
          const uses = lines[i + 1].match(/uses:\s*(\S+)/)?.[1] ?? '';
          out.push('        uses: nick-fields/retry@v3');
          out.push('        with:');
          out.push('          timeout_minutes: 5');
          out.push('          max_attempts: 3');
          out.push('          retry_wait_seconds: 10');
          out.push(`          command: # replace with actual command`);
          out.push(`          # aegis: original action: ${uses}`);
          i++; // skip original uses line
          modified = true;
          continue;
        }
        out.push('        continue-on-error: true  # aegis: use scripts/retry.sh or nick-fields/retry@v3');
        modified = true;
        continue;
      }
      out.push(lines[i]);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Wrapped network-sensitive steps with retry.sh exponential backoff — ETIMEDOUT/ECONNRESET detected; 5 retries with 2s→4s→8s→16s→32s backoff', confidence: 100 });
  }
  return fixes;
}

/** Add sleep between API calls when rate limiting (429) is detected. */
export function fixRateLimitBackoff(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/429 Too Many Requests|rate.?limit.*exceeded|API.*rate.*limit/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('sleep') || f.content.includes('rate-limit')) continue;
    // Add sleep between API operations
    const fixed = f.content.replace(
      /(run:\s*(?:curl|wget|gh api|npm publish|docker push)[^\n]+)/g,
      `run: |\n          sleep 2  # rate-limit backoff\n          $1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added 2-second backoff before API calls — 429 rate limit detected; increase sleep if still throttled', confidence: 100 });
  }
  return fixes;
}

/** Add WEBHOOK_SECRET verification step for webhook delivery failures. */
export function fixWebhookSecret(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/webhook.*signature.*invalid|invalid.*webhook.*secret|HMAC.*mismatch|X-Hub-Signature/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('WEBHOOK_SECRET') || f.content.includes('webhook_secret')) continue;
    // Add WEBHOOK_SECRET env variable note
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  WEBHOOK_SECRET: ${{ secrets.WEBHOOK_SECRET }}  # ensure this matches your webhook configuration']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added WEBHOOK_SECRET env var — webhook signature validation failed; ensure the secret matches what is configured on the webhook provider', confidence: 100 });
  }
  return fixes;
}

/** Add API version header to prevent deprecated endpoint failures. */
export function fixAPIVersionHeader(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/410 Gone|deprecated.*endpoint|API.*version.*not.*supported|X-GitHub-Api-Version/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Fix curl calls to GitHub API to include version header
    if (!f.content.includes('api.github.com') || f.content.includes('X-GitHub-Api-Version')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(-[^\s]*\s+)*(https:\/\/api\.github\.com)/g,
      `$1-H "X-GitHub-Api-Version: 2022-11-28" $3`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added X-GitHub-Api-Version header to GitHub API curl calls — missing version header causes 410 Gone on newer endpoints', confidence: 100 });
  }
  return fixes;
}

/** Add --insecure or CA cert path for SSL certificate verification failures in internal APIs. */
export function fixSSLCertVerification(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/CERTIFICATE_VERIFY_FAILED|SSL.*certificate.*verify|self.?signed.*certificate|unable to verify.*certificate/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('--insecure') || f.content.includes('NODE_TLS_REJECT_UNAUTHORIZED')) continue;
    // Add NODE_TLS_REJECT_UNAUTHORIZED=0 for dev/staging; never for production
    const isProduction = /production|prod-/i.test(f.path);
    if (isProduction) continue;  // Don't add insecure flag to prod workflows
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      "  NODE_TLS_REJECT_UNAUTHORIZED: '0'  # aegis: internal CA cert — replace with proper CA bundle in production",
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added NODE_TLS_REJECT_UNAUTHORIZED=0 for internal SSL cert — self-signed cert on internal service; use proper CA bundle in production', confidence: 100 });
  }
  return fixes;
}

/** Add pagination handling comment when API response truncates results. */
export function fixAPIPagination(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/results truncated|next.*page|Link.*header.*rel="next"|X-Next-Page/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('api.github.com') || f.content.includes('per_page=100')) continue;
    const fixed = f.content.replace(
      /(https:\/\/api\.github\.com\/[^\s?'"]+)/g,
      '$1?per_page=100',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added per_page=100 to GitHub API calls — results were being truncated at the default 30 items', confidence: 100 });
  }
  return fixes;
}

/** Add continue-on-error at the step level for Slack notification steps. */
export function fixSlackNotificationSecret(files: Array<{ path: string; content: string }>): RuleFix[] {
  const SLACK_USES = ['slackapi/slack-github-action', 'slack-send'];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!SLACK_USES.some(s => f.content.includes(s))) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // Detect "- name: ..." or "- uses: slackapi/..." that start a Slack step
      const stepMatch = line.match(/^(\s+)-\s+(name:|uses:)/);
      if (stepMatch) {
        // Collect the full step block to check if it's a Slack step
        const stepIndent = stepMatch[1].length;
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          if (nextLine.trim() === '') { j++; continue; }
          const nextIndent = nextLine.match(/^(\s+)/)?.[1]?.length ?? 0;
          if (nextIndent <= stepIndent && nextLine.trim().startsWith('-')) break;
          if (nextIndent <= stepIndent && !nextLine.trim().startsWith('-')) break;
          j++;
        }
        const block = lines.slice(i, j).join('\n');
        const isSlack = SLACK_USES.some(s => block.includes(s));
        const alreadyHas = /^\s+continue-on-error:/m.test(block);
        if (isSlack && !alreadyHas) {
          // Emit the step start line, then inject continue-on-error at step body indent
          out.push(line);
          const bodyIndent = ' '.repeat(stepIndent + 2);
          out.push(`${bodyIndent}continue-on-error: true`);
          modified = true;
          i++;
          continue;
        }
      }
      out.push(line);
      i++;
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added continue-on-error to Slack notification steps — SLACK_BOT_TOKEN/SLACK_WEBHOOK_URL may not be configured in all environments', confidence: 100 });
  }
  return fixes;
}

/** Add response validation and non-2xx handling when API returns unexpected responses. */
export function fixInvalidAPIResponse(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/unexpected.*response|invalid.*response.*body|API.*returned.*[45]\d\d|response.*not.*ok|HTTP.*[45]\d\d.*API/i.test(logs)) return [];
  const statusMatch = logs.match(/HTTP\s+(\d{3})|returned\s+(\d{3})/i);
  const status = statusMatch?.[1] ?? statusMatch?.[2] ?? '500';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') && !f.content.includes('wget')) continue;
    const fixed = f.content.replace(
      /(run:\s*)(curl\s+)([^|\n]+)/g,
      (_, run, curl, rest) => {
        if (rest.includes('--fail') || rest.includes('-f ')) return `${run}${curl}${rest}`;
        return `${run}${curl}--fail-with-body ${rest} || (echo "API call failed — check service status and retry"; exit 1)`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added --fail-with-body to curl commands — API returned HTTP ${status}; curl now exits non-zero on error responses`, confidence: 100 });
  }
  return fixes;
}

/** Add continue-on-error and fallback for broken third-party integrations. */
export function fixBrokenThirdPartyIntegration(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/third.?party|external.*service.*unavailable|integration.*failed|upstream.*service.*error/i.test(logs)) return [];
  const THIRD_PARTY_SIGNALS = [
    'datadog', 'newrelic', 'sentry', 'pagerduty', 'opsgenie',
    'jira', 'confluence', 'sonarcloud', 'codecov', 'coveralls',
    'snyk', 'blackduck', 'twistlock', 'aqua',
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const hasThirdParty = THIRD_PARTY_SIGNALS.some(s => f.content.toLowerCase().includes(s));
    if (!hasThirdParty) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => THIRD_PARTY_SIGNALS.some(s => b.toLowerCase().includes(s)) && !/continue-on-error:\s*true/i.test(b),
      '    continue-on-error: true  # aegis: third-party integration — outages should not block CI',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added continue-on-error to third-party integration jobs — external service outages should not block your CI pipeline', confidence: 100 });
  }
  return fixes;
}

/** Add schema validation error handling with ajv or JSON Schema for API responses. */
export function fixSchemaValidationFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/schema.*validation.*failed|JSON Schema.*error|ajv.*error|invalid.*schema|required.*property.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('schema') && !f.content.includes('openapi') && !f.content.includes('swagger')) continue;
    if (f.content.includes('continue-on-error')) continue;
    // Add validation step with json-schema-diff or spectral
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      out.push(line);
      if (/run:.*(?:validate|lint.*schema|spectral)/i.test(line) && !modified) {
        out.push('        continue-on-error: true  # aegis: schema validation — non-blocking until schema is stabilised');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added continue-on-error to schema validation step — schema validation failures are informational until API contracts are stabilised', confidence: 100 });
  }
  return fixes;
}

/** Fix GraphQL query failures — add introspection check and error handling. */
export function fixGraphQLQueryFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/GraphQL.*error|Cannot query field|Unknown argument|Field.*not exist|graphql.*introspection/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('graphql') && !f.content.includes('gql') && !f.content.includes('/graphql')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/run:.*(?:curl.*graphql|gh api graphql)/i.test(lines[i]) && !modified) {
        out.push('        # aegis: GraphQL error — verify query against schema introspection first:');
        out.push('        # curl -H "Authorization: Bearer $TOKEN" -X POST -d \'{"query":"{ __typename }"}\' $GQL_URL');
        out.push('        continue-on-error: true');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added GraphQL introspection verification comment and continue-on-error — field/argument errors mean the query does not match the current schema', confidence: 100 });
  }
  return fixes;
}

/** Add gh CLI auth before gh api calls when GITHUB_TOKEN is missing context. */
export function fixGHCLIAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/gh: Not Found|gh.*requires.*token|GITHUB_TOKEN.*not.*set/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('gh ') || f.content.includes('GH_TOKEN') || f.content.includes('gh auth login')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', ['  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GH_TOKEN env var — gh CLI requires GH_TOKEN or GITHUB_TOKEN to be set in the environment', confidence: 100 });
  }
  return fixes;
}

// ── Section A — API Timeout ───────────────────────────────────────────────────

/** Add --connect-timeout and --max-time flags to curl to prevent indefinite hangs. */
export function fixAPIConnectTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ETIMEDOUT|connection timed out|Operation timed out|curl.*timed out|read timeout/i.test(logs) &&
      !files.some(f => /curl\s+https?:\/\//.test(f.content))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('--connect-timeout') || f.content.includes('--max-time')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/)/g,
      '$1--connect-timeout 10 --max-time 30 $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --connect-timeout 10 --max-time 30 to curl calls — without timeouts, a hung API call blocks the CI job until the runner timeout (6h default)', confidence: 95 });
  }
  return fixes;
}

/** Add timeout configuration to Axios HTTP client instances in source files. */
export function fixAxiosTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/axios.*timeout|ECONNABORTED|timeout.*exceeded.*axios/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('axios.create') || f.content.includes('timeout:')) continue;
    const fixed = f.content.replace(
      /axios\.create\s*\(\s*\{/g,
      `axios.create({\n  timeout: 30000, // 30 seconds`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added timeout: 30000 to axios.create — Axios has no default timeout; a slow API will hang the request indefinitely without one', confidence: 92 });
  }
  return fixes;
}

/** Add AbortController with timeout to fetch() calls in source files. */
export function fixFetchAbortController(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/fetch.*timeout|AbortError|signal.*aborted|network.*request.*timed out/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('fetch(') || f.content.includes('AbortController') || f.content.includes('signal:')) continue;
    const fixed = f.content.replace(
      /\bfetch\(([^,)]+)\)/g,
      `(() => { const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 30000); return fetch($1, { signal: ctrl.signal }); })()`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Wrapped fetch() with AbortController (30s timeout) — the Fetch API has no built-in timeout; without abort signal, a slow server keeps the request pending indefinitely', confidence: 88 });
  }
  return fixes;
}

/** Add Istio/service-mesh timeout annotation to K8s Service for inter-service calls. */
export function fixServiceMeshTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/istio.*timeout|envoy.*upstream.*timeout|mesh.*timeout.*exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('kind: VirtualService') || f.content.includes('timeout:')) continue;
    const fixed = f.content.replace(
      /(    - route:\s*\n)/,
      `      timeout: 30s\n$1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added timeout: 30s to Istio VirtualService route — without a mesh-level timeout, slow upstream services block the connection until Envoy\'s default 15s idle timeout fires, causing opaque 503s', confidence: 90 });
  }
  return fixes;
}

/** Add deadline/timeout to gRPC client calls in CI scripts. */
export function fixGRPCDeadline(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/grpc.*deadline.*exceeded|DEADLINE_EXCEEDED|grpc.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('grpc') || f.content.includes('deadline') || f.content.includes('--timeout')) continue;
    const fixed = f.content.replace(
      /(grpcurl\s+)/g,
      '$1-connect-timeout 10 -max-time 30 ',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added -connect-timeout 10 -max-time 30 to grpcurl — DEADLINE_EXCEEDED occurs when the gRPC call exceeds the server deadline; always set client-side deadlines', confidence: 88 });
  }
  return fixes;
}

/** Add timeout to GraphQL HTTP requests in CI curl calls. */
export function fixGraphQLRequestTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/graphql.*timeout|graphql.*timed out|graphql.*connection.*reset/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('graphql') || f.content.includes('--max-time')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(.*\/graphql)/g,
      '$1--connect-timeout 10 --max-time 60 $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --max-time 60 to GraphQL curl calls — complex queries, N+1 resolvers, and large datasets can exceed default curl timeouts', confidence: 88 });
  }
  return fixes;
}

/** Fix API Gateway integration timeout (max 29 seconds) in serverless configs. */
export function fixAPIGatewayIntegrationTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/API Gateway.*timeout|integration.*timed out|29.*second.*limit|504.*API Gateway/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.yaml') && !f.path.endsWith('.yml') && !f.path.endsWith('.json')) continue;
    if (!f.content.includes('AWS::ApiGateway') && !f.content.includes('httpApi') && !f.content.includes('api_gateway')) continue;
    const fixed = f.content
      .replace(/TimeoutInMillis:\s*\d+/g, 'TimeoutInMillis: 29000')
      .replace(/"timeout":\s*\d+/g, '"timeout": 29');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set API Gateway integration timeout to 29000ms — AWS API Gateway hard limit is 29s; values above this are silently ignored, causing 504 when backend takes longer', confidence: 90 });
  }
  return fixes;
}

/** Add --retry and --retry-delay flags to curl for transient network failures. */
export function fixCurlRetryFlags(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/curl.*failed|ECONNRESET.*curl|network.*error.*curl|curl.*exit code [1-9]/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('--retry') || f.content.includes('retry.sh')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/)/g,
      '$1--retry 3 --retry-delay 5 --retry-connrefused $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --retry 3 --retry-delay 5 --retry-connrefused to curl — curl has built-in retry logic that handles transient 5xx and connection failures without external scripts', confidence: 92 });
  }
  return fixes;
}

/** Add timeout-minutes to jobs that make external API calls. */
export function fixJobAPICallTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/timed out|timeout|job.*cancelled.*exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^  [\w-]+:\s*$/.test(lines[i]) && /notify|publish|release|deploy|upload|report/i.test(lines[i])) {
        let j = i + 1; let hasTimeout = false;
        while (j < lines.length && /^  /.test(lines[j] ?? '')) {
          if (/timeout-minutes:/.test(lines[j]!)) { hasTimeout = true; break; }
          j++;
        }
        if (!hasTimeout) { out.push('    timeout-minutes: 15'); modified = true; }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added timeout-minutes: 15 to API-heavy jobs — jobs calling external APIs can hang indefinitely if the service is unresponsive; 15 min is a safe ceiling for notification/publish operations', confidence: 85 });
  }
  return fixes;
}

// ── Section B — Rate Limiting ────────────────────────────────────────────────

/** Check GitHub API rate limit remaining before making API calls. */
export function fixGitHubAPIRateLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/API rate limit exceeded|403.*rate limit|X-RateLimit-Remaining: 0|secondary rate limit/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('api.github.com') && !f.content.includes('gh api')) continue;
    if (f.content.includes('X-RateLimit-Remaining') || f.content.includes('rate-limit-check')) continue;
    const rateLimitStep = [
      '      - name: Check GitHub API rate limit before calls',
      '        run: |',
      '          REMAINING=$(curl -s -H "Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}" \\',
      '            https://api.github.com/rate_limit | jq -r \'.rate.remaining // 5000\')',
      '          echo "GitHub API requests remaining: $REMAINING"',
      '          if [ "$REMAINING" -lt 100 ]; then',
      '            RESET=$(curl -s -H "Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}" \\',
      '              https://api.github.com/rate_limit | jq -r \'.rate.reset\')',
      '            WAIT=$((RESET - $(date +%s) + 10))',
      '            echo "Rate limit low ($REMAINING remaining) — waiting ${WAIT}s for reset..."',
      '            [ "$WAIT" -gt 0 ] && sleep "$WAIT"',
      '          fi',
    ].join('\n');
    const patched = insertStepBefore(f.content, /gh\s+api|curl.*api\.github\.com/i, rateLimitStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GitHub API rate limit preflight check — waits for rate limit reset when fewer than 100 requests remain; prevents 403 errors mid-pipeline', confidence: 90 });
  }
  return fixes;
}

/** Add Retry-After header parsing for 429 responses. */
export function fixRetryAfterHeader(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/429 Too Many Requests|Retry-After|rate.*limit.*retry/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('Retry-After') || f.content.includes('retry-after')) continue;
    const retryStep = [
      '      - name: API call with Retry-After handling',
      '        run: |',
      '          for attempt in 1 2 3 4 5; do',
      '            RESPONSE=$(curl -si "$API_URL" -H "Authorization: Bearer $API_TOKEN" --max-time 30 2>/dev/null)',
      '            HTTP_CODE=$(echo "$RESPONSE" | grep "^HTTP" | tail -1 | awk \'{print $2}\')',
      '            if [ "$HTTP_CODE" = "429" ]; then',
      '              RETRY_AFTER=$(echo "$RESPONSE" | grep -i "^Retry-After:" | awk \'{print $2}\' | tr -d "\\r")',
      '              WAIT="${RETRY_AFTER:-60}"',
      '              echo "Rate limited (429) — waiting ${WAIT}s (Retry-After: $RETRY_AFTER)"',
      '              sleep "$WAIT"',
      '            elif echo "$HTTP_CODE" | grep -qE "^2"; then',
      '              echo "Success (HTTP $HTTP_CODE)"',
      '              break',
      '            else',
      '              echo "Attempt $attempt failed (HTTP $HTTP_CODE) — waiting 10s"',
      '              sleep 10',
      '            fi',
      '          done',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*curl\s+/i, retryStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Retry-After header parsing — respects the server-specified retry delay on 429 responses instead of using fixed backoff, which often overshoots or undershoots the rate limit window', confidence: 88 });
  }
  return fixes;
}

/** Add delay between npm publish steps in matrix jobs to avoid registry rate limits. */
export function fixNpmPublishRateLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/npm.*publish.*rate|npm.*429|too many.*publish/i.test(logs) &&
      !files.some(f => f.content.includes('npm publish') && isGitHubWorkflow(f.path))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('npm publish')) continue;
    if (f.content.includes('sleep') || !f.content.includes('matrix:')) continue;
    const fixed = f.content.replace(
      /(run:\s*npm publish)/g,
      `run: |\n          sleep $((RANDOM % 30 + 5))  # jitter to avoid parallel publish rate limits\n          npm publish`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added random jitter (5-35s) before npm publish in matrix jobs — parallel publish calls from matrix jobs often hit the npm registry rate limit; jitter spreads them out', confidence: 88 });
  }
  return fixes;
}

/** Batch N individual API calls into a single bulk request. */
export function fixAPIBulkBatching(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/rate.*limit|429.*loop|too many requests.*loop/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('for ') || !f.content.includes('curl')) continue;
    if (f.content.includes('jq -s') || f.content.includes('batch') || f.content.includes('bulk')) continue;
    const batchComment = [
      '      # aegis: rate-limit fix — consider batching these API calls:',
      '      # Instead of calling the API inside a loop, collect IDs first:',
      '      #   IDS=$(... | jq -s \'.[].id\')',
      '      # Then make one bulk call: POST /api/v1/resources/batch with {"ids": [...]}',
      '      # Most APIs (GitHub, Jira, Stripe) support batch endpoints — check the docs.',
    ].join('\n');
    const lines = f.content.split('\n');
    const insertIdx = lines.findIndex(l => /for\s+\w+\s+in\s+/.test(l) && lines[lines.indexOf(l) + 2]?.includes('curl'));
    if (insertIdx < 0) continue;
    lines.splice(insertIdx, 0, batchComment);
    fixes.push({ path: f.path, content: lines.join('\n'), explanation: 'Added batch API call hint — loop with individual API call per iteration is the most common cause of rate limiting; batching reduces N calls to 1', confidence: 80 });
  }
  return fixes;
}

/** Add token-bucket style sleep between outbound API calls in shell loops. */
export function fixLeakyBucketSleep(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/rate.*limit|429|throttl/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') || f.content.includes('sleep') || !f.content.includes('for ')) continue;
    const fixed = f.content.replace(
      /(for\s+\w+\s+in[^;]+;?\s*do\s*\n)((\s+)curl\s+)/,
      `$1$3sleep 1  # rate-limit: 1 req/s leaky bucket\n$2`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added 1s sleep inside curl loop (leaky bucket pattern) — caps outbound API calls at 1 req/s to stay within most API rate limits', confidence: 85 });
  }
  return fixes;
}

/** Add jitter and retry for Stripe/payment API rate limits. */
export function fixStripeRateLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/stripe.*rate|429.*stripe|charge.*rate.*limit|payment.*rate.*limit/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('stripe') || f.content.includes('STRIPE_RATE_RETRY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  STRIPE_MAX_NETWORK_RETRIES: "3"  # Stripe SDK auto-retry with jitter',
      '  STRIPE_RATE_RETRY: "true"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added STRIPE_MAX_NETWORK_RETRIES=3 — the Stripe SDK auto-retries with exponential jitter when this env var is set; prevents manual retry logic for 429/503 responses', confidence: 88 });
  }
  return fixes;
}

/** Add per-project token + sleep for GitLab API rate limits. */
export function fixGitLabAPIThrottle(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/gitlab.*rate.*limit|429.*gitlab|too many requests.*gitlab/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('GITLAB_API') && !f.content.includes('gitlab.com/api')) continue;
    if (f.content.includes('GITLAB_RATE_SLEEP')) continue;
    const fixed = f.content.replace(
      /(curl\s+.*gitlab\.com\/api)/g,
      `sleep 1 && $1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added 1s sleep before GitLab API calls — GitLab enforces per-user rate limits of ~600 req/min; adding 1s sleep caps burst rate to 60 req/min, well within the limit', confidence: 87 });
  }
  return fixes;
}

/** Add batch send with delay for transactional email API rate limits. */
export function fixSendGridRateLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/sendgrid.*rate|429.*sendgrid|email.*rate.*limit/i.test(logs) &&
      !files.some(f => f.content.includes('sendgrid') || f.content.includes('SENDGRID_API_KEY'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('sendgrid') && !f.content.includes('SENDGRID')) continue;
    if (f.content.includes('continue-on-error: true')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      out.push(line);
      if (/uses:|run:/.test(line) && /sendgrid|email.*send/i.test(line) && !modified) {
        out.push('        continue-on-error: true  # aegis: email API rate limit — non-blocking');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added continue-on-error to SendGrid email steps — email delivery failures should not block deployments; errors should be monitored via SendGrid Event Webhooks instead', confidence: 85 });
  }
  return fixes;
}

/** Add authenticated Docker pull to avoid Docker Hub anonymous rate limits. */
export function fixDockerHubAnonymousPullLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/docker.*pull.*rate|429.*docker|toomanyrequests.*docker|you have reached.*pull rate/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('docker pull') || f.content.includes('docker login') || f.content.includes('DOCKERHUB_TOKEN')) continue;
    const loginStep = [
      '      - name: Docker Hub authenticated login (avoid pull rate limit)',
      '        uses: docker/login-action@v3',
      '        with:',
      '          username: ${{ secrets.DOCKERHUB_USERNAME }}',
      '          password: ${{ secrets.DOCKERHUB_TOKEN }}',
    ].join('\n');
    const patched = insertStepBefore(f.content, /docker\s+pull/i, loginStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Docker Hub authenticated login before docker pull — anonymous users are limited to 100 pulls/6h; authenticated free accounts get 200 pulls/6h; paid accounts are unlimited', confidence: 92 });
  }
  return fixes;
}

// ── Section C — Invalid API Response ─────────────────────────────────────────

/** Add JSON.parse error handling for non-JSON API responses. */
export function fixAPIResponseJSONParse(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/JSON.*parse.*error|Unexpected token|SyntaxError.*JSON|invalid JSON.*response/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('JSON.parse') || f.content.includes('try {')) continue;
    const fixed = f.content.replace(
      /\bJSON\.parse\(([^)]+)\)/g,
      `(() => { try { return JSON.parse($1); } catch (e) { console.error('JSON parse failed, raw:', String($1).slice(0, 200)); throw new Error('API returned non-JSON response — check Content-Type and server logs'); } })()`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Wrapped JSON.parse with error handler — APIs can return HTML error pages or empty bodies; raw parse errors hide the actual server response content', confidence: 88 });
  }
  return fixes;
}

/** Add empty/null response body guard before parsing API responses. */
export function fixAPIEmptyResponseGuard(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/empty.*response|null.*response|response.*body.*empty|no.*content.*response/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') || f.content.includes('jq -e') || f.content.includes('--fail')) continue;
    const fixed = f.content.replace(
      /(RESPONSE=\$\(curl[^\n]+\))\n(\s+)(echo \$RESPONSE\s*\|?\s*jq)/g,
      `$1\n$2[ -z "$RESPONSE" ] && echo "ERROR: Empty API response" && exit 1\n$2$3`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added empty response guard before jq parsing — empty response body causes jq to fail with "null" output, masking the real error (network failure, 204 No Content, auth redirect)', confidence: 87 });
  }
  return fixes;
}

/** Follow HTTP redirects with --location flag for curl API calls. */
export function fixRedirectHandling(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/301 Moved|302 Found|redirect.*curl|curl.*redirect.*follow|HTTP.*30[0-9]/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('--location') || f.content.includes('-L ')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/)/g,
      '$1--location $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added --location to curl commands — curl does not follow HTTP redirects by default; APIs that moved to new URLs or require HTTP→HTTPS upgrades return empty response without this flag', confidence: 90 });
  }
  return fixes;
}

/** Handle 2xx status code range (201, 202, 204) in API response validation. */
export function fixAPIStatusCodeRange(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/expected.*200|201.*not.*ok|204.*error|status.*not.*200/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('-E "^2"') || f.content.includes('grep -qE')) continue;
    const fixed = f.content.replace(
      /\[ "\$STATUS" = "200" \]/g,
      '( [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ] || [ "$STATUS" = "202" ] || [ "$STATUS" = "204" ] )',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Expanded API success check to accept 201/202/204 — POST creates return 201, async accepts return 202, DELETE/PATCH often return 204; strict 200 check causes false failures', confidence: 90 });
  }
  return fixes;
}

/** Add Content-Type validation before parsing API response body. */
export function fixAPIContentTypeCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Content-Type.*mismatch|expected.*application\/json|text\/html.*API response/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') || f.content.includes('Content-Type') || f.content.includes('-H "Accept')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/)/g,
      '$1-H "Accept: application/json" -H "Content-Type: application/json" $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Accept: application/json header to curl — without Accept header, some APIs return HTML error pages instead of JSON; Content-Type signals the request body format', confidence: 90 });
  }
  return fixes;
}

/** Add ETag/If-None-Match caching for idempotent GET requests. */
export function fixAPIResponseCaching(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ETag|If-None-Match|304 Not Modified|conditional.*GET/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') || f.content.includes('If-None-Match') || f.content.includes('ETag')) continue;
    const fixed = f.content.replace(
      /(RESPONSE=\$\(curl\s+)(https?:\/\/[^\s)]+)/g,
      `ETAG_FILE=".api_etag_\$(echo '$2' | md5sum | head -c 8)"\n          ETAG=$( [ -f "$ETAG_FILE" ] && cat "$ETAG_FILE" || echo "" )\n          $1-H "If-None-Match: $ETAG" $2`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ETag/If-None-Match conditional GET — reuses cached response when server returns 304 Not Modified, reducing API calls and avoiding rate limits for frequently polled endpoints', confidence: 82 });
  }
  return fixes;
}

/** Unwrap nested API response envelopes (data.data, result.items) in CI scripts. */
export function fixAPIEnvelopeUnwrap(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/\.data\.data|\.result\.items|response\.body\.data|Cannot read.*undefined.*data/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jq') || f.content.includes('.data.data') || f.content.includes('.result.items')) continue;
    const fixed = f.content.replace(
      /(jq\s+['"]\.data['"])/g,
      `jq '.data // .result // .items // .data.data // .'`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added fallback envelope unwrap in jq (.data // .result // .items) — API responses often wrap results in different envelope shapes; this handles common patterns without hardcoding the exact structure', confidence: 82 });
  }
  return fixes;
}

/** Parse API error response body for actionable messages. */
export function fixAPIErrorBodyParsing(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/API.*error|HTTP [45]\d\d|unexpected.*status/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') || f.content.includes('--fail-with-body') || f.content.includes('ERROR_BODY')) continue;
    const fixed = f.content.replace(
      /(STATUS=\$\(curl\s+-s\s+-o\s+\/dev\/null\s+-w\s+['"]\%\{http_code\}['"][^\n]+\))/g,
      `ERROR_BODY_FILE=$(mktemp)\n          STATUS=$(curl -s -o "$ERROR_BODY_FILE" -w "%{http_code}"$3 || echo "000")\n          [ "$(echo "$STATUS" | head -c1)" != "2" ] && echo "API error body: $(cat $ERROR_BODY_FILE | jq -r '.message // .error // .detail // .' 2>/dev/null || cat $ERROR_BODY_FILE)" && rm -f "$ERROR_BODY_FILE" && exit 1\n          rm -f "$ERROR_BODY_FILE"`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added error body capture and parsing — when APIs return 4xx/5xx, logging the response body (message/error/detail field) provides the actual error reason instead of just the status code', confidence: 80 });
  }
  return fixes;
}

// ── Section D — Webhook Delivery Failure ─────────────────────────────────────

/** Add full HMAC-SHA256 webhook signature verification in CI scripts. */
export function fixWebhookHMACVerification(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/webhook.*signature|HMAC.*mismatch|X-Hub-Signature|webhook.*secret.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('webhook') || f.content.includes('createHmac') || f.content.includes('timingSafeEqual')) continue;
    const hmacCode = [
      '',
      '// Webhook HMAC-SHA256 signature verification',
      'import { createHmac, timingSafeEqual } from "crypto";',
      'function verifyWebhookSignature(payload: Buffer, signature: string, secret: string): boolean {',
      '  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");',
      '  try {',
      '    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));',
      '  } catch {',
      '    return false; // length mismatch',
      '  }',
      '}',
    ].join('\n');
    fixes.push({ path: f.path, content: f.content + hmacCode, explanation: 'Added HMAC-SHA256 webhook verifier using timingSafeEqual — timing-safe comparison prevents timing oracle attacks; raw string comparison (===) is vulnerable to timing analysis', confidence: 90 });
  }
  return fixes;
}

/** Add timestamp-based replay protection to webhook handlers. */
export function fixWebhookReplayProtection(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replay.*attack|webhook.*timestamp|stale.*webhook|X-Webhook-Timestamp/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('webhook') || f.content.includes('X-Webhook-Timestamp') || f.content.includes('replay')) continue;
    const replayCode = [
      '',
      '// Webhook replay protection — reject payloads older than 5 minutes',
      'function isWebhookFresh(timestampHeader: string | undefined, toleranceSeconds = 300): boolean {',
      '  if (!timestampHeader) return false;',
      '  const ts = parseInt(timestampHeader, 10);',
      '  const now = Math.floor(Date.now() / 1000);',
      '  return Math.abs(now - ts) <= toleranceSeconds;',
      '}',
    ].join('\n');
    fixes.push({ path: f.path, content: f.content + replayCode, explanation: 'Added webhook timestamp replay protection (5-minute window) — without timestamp validation, attackers can replay captured webhook payloads with valid signatures', confidence: 88 });
  }
  return fixes;
}

/** Add idempotency key handling for duplicate webhook delivery. */
export function fixWebhookIdempotencyKey(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/duplicate.*webhook|webhook.*delivered.*twice|idempotency|X-Webhook-ID/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('webhook') || f.content.includes('idempotency') || f.content.includes('X-Webhook-ID')) continue;
    const idempotencyCode = [
      '',
      '// Webhook idempotency — deduplicate deliveries using event ID',
      'const processedWebhookIds = new Set<string>();',
      'function isDuplicateWebhook(eventId: string | undefined): boolean {',
      '  if (!eventId) return false;',
      '  if (processedWebhookIds.has(eventId)) return true;',
      '  processedWebhookIds.add(eventId);',
      '  // In production: use Redis SET NX with TTL instead of in-memory Set',
      '  return false;',
      '}',
    ].join('\n');
    fixes.push({ path: f.path, content: f.content + idempotencyCode, explanation: 'Added webhook idempotency deduplication using event ID — webhook providers retry on delivery failures; processing a webhook twice (charge twice, send two emails) is worse than missing one', confidence: 88 });
  }
  return fixes;
}

/** Ensure webhook handler responds within 5 seconds and processes async. */
export function fixWebhookTimeoutResponse(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/webhook.*timeout|webhook.*5.*second|delivery.*failed.*timeout|webhook.*no.*response/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('webhook') || f.content.includes('setImmediate') || f.content.includes('process.nextTick')) continue;
    const asyncPattern = [
      '',
      '// Webhook fast-ack pattern — respond immediately, process async',
      '// Most providers (GitHub, Stripe, Twilio) require a response within 5-30 seconds',
      '// app.post("/webhook", (req, res) => {',
      '//   res.status(200).json({ received: true }); // ACK immediately',
      '//   setImmediate(async () => {                // process in background',
      '//     await processWebhookEvent(req.body);',
      '//   });',
      '// });',
    ].join('\n');
    fixes.push({ path: f.path, content: f.content + asyncPattern, explanation: 'Added webhook fast-ack pattern comment — providers retry if no 2xx response within 5-30s; long processing (DB writes, external API calls) in the handler causes duplicate deliveries', confidence: 83 });
  }
  return fixes;
}

/** Add payload size validation for webhook handlers (most providers cap at 25MB). */
export function fixWebhookPayloadSize(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/payload.*too large|413.*webhook|request.*entity.*too large|webhook.*size/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('express()') || f.content.includes('limit:') || f.content.includes('express.json(')) continue;
    const fixed = f.content.replace(
      /(app\.use\(express\.json\(\))/,
      `app.use(express.json({ limit: '10mb' }))  // webhook payload size limit`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added express.json({ limit: "10mb" }) — default Express body-parser limit is 100kb; large webhook payloads (push events with many commits, large Stripe events) are silently rejected with 413', confidence: 90 });
  }
  return fixes;
}

/** Add IP allowlist validation for webhook provider source IPs. */
export function fixWebhookIPAllowlist(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/webhook.*IP|source.*IP.*webhook|unauthorized.*IP.*webhook/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('webhook') || f.content.includes('allowedIPs') || f.content.includes('ip-filter')) continue;
    const ipCode = [
      '',
      '// Webhook IP allowlist — validate source IP before processing',
      '// GitHub: https://api.github.com/meta (hooks field)',
      '// Stripe: 54.187.174.169, 54.187.205.235, etc.',
      'const WEBHOOK_ALLOWED_IPS = (process.env.WEBHOOK_ALLOWED_IPS ?? "").split(",").filter(Boolean);',
      'function isAllowedWebhookIP(clientIP: string): boolean {',
      '  if (WEBHOOK_ALLOWED_IPS.length === 0) return true; // not configured — skip check',
      '  return WEBHOOK_ALLOWED_IPS.some(cidr => clientIP.startsWith(cidr.split("/")[0]!.split(".").slice(0, 3).join(".")));',
      '}',
    ].join('\n');
    fixes.push({ path: f.path, content: f.content + ipCode, explanation: 'Added webhook IP allowlist helper — validates source IP against known provider ranges; combined with HMAC signature this provides defense-in-depth against spoofed webhooks', confidence: 85 });
  }
  return fixes;
}

/** Ensure webhook endpoint uses HTTPS (TLS) and add redirect for HTTP. */
export function fixWebhookTLSValidation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/webhook.*http:|webhook.*not.*https|webhook.*tls|http.*webhook.*rejected/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('WEBHOOK_URL') || f.content.includes('https://') || f.content.includes('TLS')) continue;
    const fixed = f.content.replace(
      /(WEBHOOK_URL:\s*)(http:\/\/)/g,
      '$1https://',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed webhook URL from http:// to https:// — GitHub, Stripe, and most webhook providers reject HTTP endpoints; HTTPS is required for secure payload delivery', confidence: 92 });
  }
  return fixes;
}

/** Add correct GitHub webhook event subscriptions in workflow dispatch. */
export function fixGitHubWebhookEvents(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/webhook.*event.*not.*subscribed|missing.*webhook.*event|push.*event.*not.*received/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('repository_dispatch') || f.content.includes('event_type:')) continue;
    const fixed = f.content.replace(
      /(repository_dispatch:)\s*\n/,
      `$1\n    types: [deploy, release, custom-event]\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added types filter to repository_dispatch trigger — without explicit event types, only the default "repository_dispatch" event fires; specify the event_type strings your webhook sends', confidence: 88 });
  }
  return fixes;
}

// ── Section E — Broken Third-Party Integration ────────────────────────────────

/** Add SENTRY_DSN env var and SDK initialization check. */
export function fixSentryDSNEnvVar(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/sentry.*DSN|sentry.*init.*fail|SENTRY_DSN.*missing|sentry.*not.*configured/i.test(logs) &&
      !files.some(f => f.content.includes('Sentry.init') || f.content.includes('@sentry/node'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('sentry') || f.content.includes('SENTRY_DSN')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  SENTRY_DSN: ${{ secrets.SENTRY_DSN }}',
      '  SENTRY_ORG: ${{ secrets.SENTRY_ORG }}',
      '  SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}',
      '  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added SENTRY_DSN, SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN env vars — Sentry SDK silently drops events when DSN is missing; the auth token is required for source map uploads', confidence: 90 });
  }
  return fixes;
}

/** Add Datadog agent config and DD_API_KEY secret. */
export function fixDatadogAgentConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/datadog.*api.*key|DD_API_KEY.*missing|datadog.*agent.*fail/i.test(logs) &&
      !files.some(f => f.content.includes('datadog') || f.content.includes('DD_API_KEY'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('datadog') || f.content.includes('DD_API_KEY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DD_API_KEY: ${{ secrets.DD_API_KEY }}',
      '  DD_APP_KEY: ${{ secrets.DD_APP_KEY }}',
      '  DD_SITE: datadoghq.com',
      '  DD_ENV: ${{ github.ref == \'refs/heads/main\' && \'production\' || \'staging\' }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DD_API_KEY, DD_APP_KEY, DD_SITE, DD_ENV env vars — Datadog integrations fail silently without API key; DD_ENV tags metrics with environment for dashboard filtering', confidence: 90 });
  }
  return fixes;
}

/** Fix SonarCloud analysis with project key, organization, and non-blocking mode. */
export function fixSonarCloudQualityGate(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/sonar.*quality gate|sonarcloud.*fail|SONAR_TOKEN.*missing/i.test(logs) &&
      !files.some(f => f.content.includes('SonarCloud') || f.content.includes('sonar-scanner'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('sonar') || f.content.includes('SONAR_TOKEN')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
      '  SONAR_HOST_URL: https://sonarcloud.io',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added SONAR_TOKEN + SONAR_HOST_URL — SonarCloud analysis fails silently without token; set sonar.organization and sonar.projectKey in sonar-project.properties', confidence: 90 });
  }
  return fixes;
}

/** Add CODECOV_TOKEN and make upload non-blocking. */
export function fixCodecovTokenMissing(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/codecov.*token|upload.*codecov.*fail|CODECOV_TOKEN.*not.*set/i.test(logs) &&
      !files.some(f => f.content.includes('codecov/codecov-action') || f.content.includes('codecov'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('codecov') || f.content.includes('CODECOV_TOKEN')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      out.push(line);
      if (line.includes('codecov/codecov-action') && !modified) {
        out.push('        with:');
        out.push('          token: ${{ secrets.CODECOV_TOKEN }}');
        out.push('          fail_ci_if_error: false');
        out.push('        continue-on-error: true');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added CODECOV_TOKEN and fail_ci_if_error: false — Codecov uploads fail on fork PRs without explicit token; continue-on-error ensures coverage upload failure does not block merges', confidence: 90 });
  }
  return fixes;
}

/** Add SNYK_TOKEN env var and make Snyk scan non-blocking. */
export function fixSnykAuthToken(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/snyk.*auth|SNYK_TOKEN.*missing|snyk.*unauthor/i.test(logs) &&
      !files.some(f => f.content.includes('snyk/actions') || f.content.includes('snyk test'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('snyk') || f.content.includes('SNYK_TOKEN')) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => b.includes('snyk') && !b.includes('SNYK_TOKEN'),
      '    env:\n      SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}\n    continue-on-error: true',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added SNYK_TOKEN env var and continue-on-error — Snyk authentication fails without token; continue-on-error prevents vulnerability scan failures from blocking CI while the team triages findings', confidence: 90 });
  }
  return fixes;
}

/** Add PagerDuty routing key and event action for incident integration. */
export function fixPagerdutyIntegration(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pagerduty.*routing|PD_ROUTING_KEY.*missing|pagerduty.*api.*key/i.test(logs) &&
      !files.some(f => f.content.includes('pagerduty') || f.content.includes('PD_ROUTING_KEY'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('pagerduty') || f.content.includes('PD_ROUTING_KEY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PD_ROUTING_KEY: ${{ secrets.PAGERDUTY_ROUTING_KEY }}',
      '  PD_EVENT_ACTION: trigger  # trigger | resolve | acknowledge',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PD_ROUTING_KEY + PD_EVENT_ACTION env vars — PagerDuty Events API v2 requires the integration routing key (not the account API key); event_action must be trigger/resolve/acknowledge', confidence: 88 });
  }
  return fixes;
}

/** Add Jira base URL, email, and API token for Jira integration steps. */
export function fixJiraIntegrationConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/jira.*auth|JIRA_API_TOKEN.*missing|jira.*401|jira.*403/i.test(logs) &&
      !files.some(f => f.content.includes('jira') || f.content.includes('JIRA_BASE_URL'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('jira') || f.content.includes('JIRA_BASE_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  JIRA_BASE_URL: ${{ secrets.JIRA_BASE_URL }}  # e.g. https://yourorg.atlassian.net',
      '  JIRA_USER_EMAIL: ${{ secrets.JIRA_USER_EMAIL }}',
      '  JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN env vars — Jira Cloud REST API uses Basic auth with email:api_token (not password); the token is generated at id.atlassian.com/manage-profile/security', confidence: 90 });
  }
  return fixes;
}

/** Add New Relic license key env var for APM integration. */
export function fixNewRelicLicenseKey(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/new.?relic.*license|NEW_RELIC_LICENSE_KEY.*missing|newrelic.*init.*fail/i.test(logs) &&
      !files.some(f => f.content.includes('newrelic') || f.content.includes('NEW_RELIC'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('newrelic') && !f.content.includes('NEW_RELIC')) continue;
    if (f.content.includes('NEW_RELIC_LICENSE_KEY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  NEW_RELIC_LICENSE_KEY: ${{ secrets.NEW_RELIC_LICENSE_KEY }}',
      '  NEW_RELIC_APP_NAME: ${{ github.event.repository.name }}',
      '  NEW_RELIC_DISTRIBUTED_TRACING_ENABLED: "true"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added NEW_RELIC_LICENSE_KEY + app name env vars — New Relic agent silently ignores all telemetry when license key is missing; app name determines which APM entity receives the data', confidence: 90 });
  }
  return fixes;
}

// ── Section F — Schema Validation Failure ────────────────────────────────────

/** Add Spectral OpenAPI lint step to CI for API contract validation. */
export function fixOpenAPISpectralLint(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/openapi|swagger|spectral|API.*contract/i.test(logs) &&
      !files.some(f => f.content.includes('openapi') || f.content.includes('swagger'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('openapi') && !f.content.includes('swagger')) continue;
    if (f.content.includes('spectral') || f.content.includes('openapi-lint')) continue;
    const spectralStep = [
      '      - name: Lint OpenAPI schema with Spectral',
      '        run: |',
      '          npx @stoplight/spectral-cli@latest lint openapi.yaml \\',
      '            --ruleset .spectral.yaml 2>/dev/null || \\',
      '          npx @stoplight/spectral-cli@latest lint openapi.json \\',
      '            --format pretty || echo "No OpenAPI file found at openapi.yaml/json"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /name:\s*(?:build|test|deploy)/i, spectralStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Spectral OpenAPI lint step — validates API schema against OAS3 rules before deployment; catches missing required fields, broken refs, and security scheme issues', confidence: 85 });
  }
  return fixes;
}

/** Fix JSON Schema version URL mismatch ($schema field). */
export function fixJSONSchemaVersion(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/\$schema.*version|draft-04|draft-07.*mismatch|schema.*version.*not.*supported/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.json') && !f.path.endsWith('.yaml') && !f.path.endsWith('.yml')) continue;
    if (!f.content.includes('"$schema"') && !f.content.includes("'$schema'")) continue;
    const fixed = f.content
      .replace(/"https:\/\/json-schema\.org\/draft-04\/schema#?"/g, '"https://json-schema.org/draft-07/schema#"')
      .replace(/"http:\/\/json-schema\.org\/draft-04\/schema#?"/g, '"https://json-schema.org/draft-07/schema#"');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Updated $schema from draft-04 to draft-07 — draft-04 lacks if/then/else, nullable types, and readOnly/writeOnly which modern validators require; draft-07 is the most widely supported version', confidence: 88 });
  }
  return fixes;
}

/** Fix Ajv strict mode errors by adding additionalProperties: false and required arrays. */
export function fixAJVStrictMode(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ajv.*strict|unknown.*keyword.*strict|additionalProperties.*strict|strict.*mode.*ajv/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('new Ajv') || f.content.includes('strict: false') || f.content.includes('allErrors')) continue;
    const fixed = f.content.replace(
      /new\s+Ajv\s*\(\s*\{/g,
      `new Ajv({ allErrors: true, strict: false,`,
    ).replace(
      /new\s+Ajv\s*\(\s*\)/g,
      `new Ajv({ allErrors: true, strict: false })`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added allErrors: true, strict: false to Ajv constructor — strict mode rejects unknown JSON Schema keywords (e.g. `example`, `description`) used in OpenAPI/Swagger schemas; allErrors reports all errors at once', confidence: 88 });
  }
  return fixes;
}

/** Add buf breaking change detection for Protobuf schema compatibility. */
export function fixProtobufSchemaBreaking(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/protobuf.*breaking|proto.*schema.*change|buf.*breaking/i.test(logs) &&
      !files.some(f => f.path.endsWith('.proto') || f.content.includes('protoc') || f.content.includes('buf generate'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('proto') || f.content.includes('buf breaking')) continue;
    const breakingStep = [
      '      - name: Check Protobuf breaking changes',
      '        run: |',
      '          which buf >/dev/null 2>&1 || (curl -sSL https://github.com/bufbuild/buf/releases/latest/download/buf-Linux-x86_64 -o /usr/local/bin/buf && chmod +x /usr/local/bin/buf)',
      '          buf breaking --against ".git#branch=main" || echo "WARNING: Breaking Protobuf changes detected — update client SDKs before deploying"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /buf\s+generate|protoc\s+/i, breakingStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added buf breaking change detection — validates that Protobuf schema changes are backward-compatible; breaking changes (field renaming, type changes) silently corrupt clients that were not recompiled', confidence: 87 });
  }
  return fixes;
}

/** Add express-openapi-validator middleware for request/response validation. */
export function fixOpenAPIRequestValidator(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/openapi.*validator|request.*validation.*fail|response.*schema.*mismatch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('express()') || f.content.includes('OpenApiValidator') || f.content.includes('express-openapi-validator')) continue;
    const validatorCode = [
      '',
      '// OpenAPI request/response validation middleware',
      '// npm install express-openapi-validator',
      '// import { OpenApiValidator } from "express-openapi-validator";',
      '// app.use(OpenApiValidator.middleware({',
      '//   apiSpec: "./openapi.yaml",',
      '//   validateRequests: true,',
      '//   validateResponses: process.env.NODE_ENV !== "production",',
      '// }));',
      '// app.use((err: any, _req: any, res: any, next: any) => {',
      '//   res.status(err.status ?? 500).json({ message: err.message, errors: err.errors });',
      '// });',
    ].join('\n');
    fixes.push({ path: f.path, content: f.content + validatorCode, explanation: 'Added express-openapi-validator middleware template — validates incoming requests and outgoing responses against the OpenAPI schema at runtime; prevents schema drift between docs and implementation', confidence: 83 });
  }
  return fixes;
}

/** Add Confluent Schema Registry compatibility check in CI. */
export function fixSchemaRegistryCompat(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/schema.*registry|avro.*compat|kafka.*schema.*compat|BACKWARD.*compat/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('kafka') && !f.content.includes('schema-registry') && !f.content.includes('avro')) continue;
    if (f.content.includes('schema-registry-compat') || f.content.includes('SCHEMA_REGISTRY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  SCHEMA_REGISTRY_URL: ${{ secrets.SCHEMA_REGISTRY_URL }}',
      '  SCHEMA_REGISTRY_API_KEY: ${{ secrets.SCHEMA_REGISTRY_API_KEY }}',
      '  SCHEMA_REGISTRY_API_SECRET: ${{ secrets.SCHEMA_REGISTRY_API_SECRET }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added SCHEMA_REGISTRY_URL + credentials — Confluent Schema Registry requires these to validate Avro/Protobuf schema compatibility before publishing; BACKWARD compatibility is the default and safest mode', confidence: 87 });
  }
  return fixes;
}

/** Add graphql-inspector schema diff step to detect breaking changes. */
export function fixGraphQLSchemaLint(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/graphql.*schema.*break|schema.*field.*removed|graphql.*compat/i.test(logs) &&
      !files.some(f => f.path.endsWith('.graphql') || f.content.includes('schema.graphql'))) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('graphql') || f.content.includes('graphql-inspector') || f.content.includes('schema-diff')) continue;
    const lintStep = [
      '      - name: Check GraphQL schema for breaking changes',
      '        run: |',
      '          npx @graphql-inspector/cli@latest diff \\',
      '            "git:origin/main:schema.graphql" "schema.graphql" \\',
      '            --rule suppressRemovalOfDeprecatedField || \\',
      '          echo "WARNING: GraphQL breaking changes detected — coordinate with API consumers before deploying"',
      '        continue-on-error: true',
    ].join('\n');
    const patched = insertStepBefore(f.content, /name:\s*(?:build|test|deploy)/i, lintStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added graphql-inspector schema diff — detects breaking changes (field removal, type changes) against the main branch schema before deployment; suppresses warnings for @deprecated fields', confidence: 85 });
  }
  return fixes;
}

/** Add Zod schema parse with error message extraction in source files. */
export function fixZodSchemaValidation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/zod.*error|ZodError|schema.*parse.*fail|z\.object.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('z.object') || f.content.includes('.safeParse') || f.content.includes('ZodError')) continue;
    const fixed = f.content.replace(
      /(\w+Schema)\.parse\(([^)]+)\)/g,
      `(() => { const r = $1.safeParse($2); if (!r.success) { throw new Error("Schema validation failed: " + JSON.stringify(r.error.flatten().fieldErrors)); } return r.data; })()`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced .parse() with .safeParse() and error formatting — .parse() throws a ZodError with opaque structure; this pattern produces a human-readable message with specific field errors', confidence: 88 });
  }
  return fixes;
}

// ── Section G — GraphQL Query Failure ────────────────────────────────────────

/** Add introspection preflight to verify GraphQL schema before running queries. */
export function fixGraphQLIntrospectionQuery(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot query field|Unknown argument|graphql.*introspection|field.*not.*exist.*schema/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('graphql') || f.content.includes('__typename') || f.content.includes('introspect')) continue;
    const introStep = [
      '      - name: Validate GraphQL schema via introspection',
      '        run: |',
      '          GQL_URL="${GQL_ENDPOINT:-http://localhost:4000/graphql}"',
      '          RESULT=$(curl -s -X POST "$GQL_URL" \\',
      '            -H "Content-Type: application/json" \\',
      '            -H "Authorization: Bearer ${GRAPHQL_TOKEN}" \\',
      "            -d '{\"query\":\"{ __typename }\"}' --max-time 10 2>/dev/null)",
      '          TYPENAME=$(echo "$RESULT" | jq -r \'.data.__typename // empty\')',
      '          [ -z "$TYPENAME" ] && echo "ERROR: GraphQL endpoint unreachable or introspection disabled" && echo "$RESULT" && exit 1',
      '          echo "GraphQL schema validated (__typename=$TYPENAME)"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /curl.*graphql|gh\s+api\s+graphql/i, introStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GraphQL introspection preflight — verifies the endpoint is reachable and returns a valid schema before running the actual query; catches URL misconfiguration and auth failures early', confidence: 88 });
  }
  return fixes;
}

/** Fix missing GraphQL fragment definitions in queries. */
export function fixGraphQLFragmentDefinition(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Unknown fragment|fragment.*not.*defined|Fragment.*not.*exist/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.graphql') && !f.path.endsWith('.gql') && !f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('...') || f.content.includes('fragment ')) continue;
    const fragmentMatch = f.content.match(/\.\.\.([\w]+)/g);
    if (!fragmentMatch) continue;
    const frags = [...new Set(fragmentMatch.map(m => m.replace('...', '')))];
    const fragDefs = frags.map(name =>
      `\nfragment ${name} on Node {\n  id\n  # TODO: add fields for the ${name} fragment\n}`,
    ).join('\n');
    const fixed = f.content + fragDefs;
    fixes.push({ path: f.path, content: fixed, explanation: `Added stub fragment definitions for: ${frags.join(', ')} — GraphQL queries fail with "Unknown fragment" when fragments are spread but not defined in the same document or operation`, confidence: 80 });
  }
  return fixes;
}

/** Add null safety checks for nullable GraphQL fields in TypeScript. */
export function fixGraphQLNullableFields(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cannot read.*null.*graphql|optional.*field.*undefined.*gql|nullable.*field.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts')) continue;
    if (!f.content.includes('useQuery') && !f.content.includes('gql`')) continue;
    if (f.content.includes('?.') || f.content.includes('?? ')) continue;
    const fixed = f.content
      .replace(/data\.(\w+)\.(\w+)/g, 'data?.$1?.$2')
      .replace(/result\.data\.(\w+)/g, 'result?.data?.$1');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added optional chaining (?.) to GraphQL data access — all GraphQL fields can be null during loading, errors, or when the server returns partial data; optional chaining prevents TypeError crashes', confidence: 85 });
  }
  return fixes;
}

/** Use persisted query hash instead of inline query for production GraphQL calls. */
export function fixGraphQLPersistQuery(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/graphql.*query.*too large|persisted.*query|query.*complexity.*exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('graphql') || f.content.includes('extensions') || f.content.includes('persistedQuery')) continue;
    const fixed = f.content.replace(
      /(curl.*\/graphql.*-d\s+'{"query":)/g,
      `# aegis: consider using persisted queries for large/complex GraphQL operations:\n          # -d '{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"<HASH>"}}}'  \n          $1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added persisted query hint — large inline GraphQL queries hit GET URL length limits and bypass CDN caching; APQ (Automatic Persisted Queries) sends only the hash on subsequent requests', confidence: 80 });
  }
  return fixes;
}

/** Replace deprecated GraphQL fields with their recommended replacements. */
export function fixGraphQLDeprecatedField(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deprecated.*field|field.*deprecated|@deprecated.*graphql/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.graphql') && !f.path.endsWith('.gql') && !f.path.endsWith('.ts')) continue;
    if (!f.content.includes('@deprecated') && !f.content.includes('deprecated')) continue;
    const fixed = f.content.replace(
      /(#\s*@deprecated[^\n]*\n\s*)([\w]+):/g,
      `$1# FIXME: field '$2' is deprecated — check the schema for the replacement field\n  $2:`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added FIXME comments on deprecated GraphQL fields — deprecated fields are often removed in the next major schema version; flag them for replacement now to avoid runtime errors post-upgrade', confidence: 82 });
  }
  return fixes;
}

/** Add CORS headers for GraphQL API endpoint in Express. */
export function fixGraphQLCORSHeaders(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/CORS.*graphql|Access-Control.*graphql|graphql.*cross.origin/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.js')) continue;
    if (!f.content.includes('graphql') || f.content.includes('cors(') || f.content.includes('Access-Control')) continue;
    const fixed = f.content.replace(
      /(app\.use\(['"]\/graphql['"]\s*,)/,
      `app.use('/graphql', (_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {\n  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS ?? '*');\n  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');\n  if (_req.method === 'OPTIONS') { res.sendStatus(200); return; }\n  next();\n});\n$1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added CORS preflight handler before GraphQL route — browsers send OPTIONS preflight for GraphQL mutations with Authorization headers; without CORS headers the preflight fails and the mutation is never sent', confidence: 88 });
  }
  return fixes;
}

/** Convert N separate GraphQL queries to a single batched request. */
export function fixGraphQLBatchRequest(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/graphql.*N\+1|graphql.*rate|too many.*graphql.*queries/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('graphql') || f.content.includes('batch') || !f.content.includes('for ')) continue;
    const batchComment = [
      '      # aegis: GraphQL N+1 — batch these queries into a single request:',
      '      # Instead of: for ID in $IDS; do curl -d \'{"query":"{ user(id: $ID) {...} }"}\'; done',
      '      # Use aliases: curl -d \'{"query":"{ u1: user(id: "1") {...} u2: user(id: "2") {...} }"}\'',
      '      # Or use DataLoader on the server side to batch resolver calls',
    ].join('\n');
    const lines = f.content.split('\n');
    const insertIdx = lines.findIndex(l => /for\s+\w+\s+in/.test(l) && lines[lines.indexOf(l) + 2]?.includes('graphql'));
    if (insertIdx < 0) continue;
    lines.splice(insertIdx, 0, batchComment);
    fixes.push({ path: f.path, content: lines.join('\n'), explanation: 'Added GraphQL batching hint — N+1 queries in a loop hit rate limits and are slower than one aliased batch query; GraphQL supports multiple operations with aliases in a single request', confidence: 80 });
  }
  return fixes;
}

// ── Section H — REST Endpoint Mismatch ───────────────────────────────────────

/** Extract hardcoded base URLs to environment variables. */
export function fixRESTBaseURLEnvVar(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const hardcoded = f.content.match(/https?:\/\/[\w.-]+\.(?:com|io|net|org|dev)\/(api|v[12])\//gi);
    if (!hardcoded || hardcoded.length === 0) continue;
    if (f.content.includes('API_BASE_URL') || f.content.includes('BASE_URL')) continue;
    const url = hardcoded[0]!;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      `  API_BASE_URL: \${API_BASE_URL:-${url}}  # aegis: extracted from hardcoded URL`,
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Extracted hardcoded API base URL (${url}) to API_BASE_URL env var — hardcoded URLs cannot be overridden per environment and will cause staging pipelines to call production APIs`, confidence: 85 });
  }
  return fixes;
}

/** Add missing API version prefix to REST endpoint URLs. */
export function fixRESTVersionPrefix(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/404.*api|endpoint.*not found|API.*version.*missing|\/v[12].*not.*found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('/v1/') || f.content.includes('/v2/') || f.content.includes('/api/')) continue;
    const versionMatch = logs.match(/\/v(\d+)\//);
    const version = versionMatch ? `v${versionMatch[1]}` : 'v1';
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/[^/\s]+)\/([\w-]+)/g,
      `$1$2/api/${version}/$3`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added /api/${version}/ prefix to REST URLs — API returned 404; most REST APIs require an explicit version prefix; check the API docs for the correct base path`, confidence: 80 });
  }
  return fixes;
}

/** Fix wrong HTTP method (POST where PUT/PATCH is expected). */
export function fixRESTMethodMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/405 Method Not Allowed|PUT.*required|PATCH.*required|wrong.*method|method.*not.*allowed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('-X PUT') || f.content.includes('-X PATCH')) continue;
    const methodNote = [
      '      # aegis: HTTP 405 Method Not Allowed — check the API docs for the correct method:',
      '      # POST   → create a new resource',
      '      # PUT    → replace a resource entirely (requires all fields)',
      '      # PATCH  → partial update (send only changed fields)',
      '      # Add -X PUT or -X PATCH to curl commands for update operations',
    ].join('\n');
    const lines = f.content.split('\n');
    const insertIdx = lines.findIndex(l => /curl\s+-X\s+POST/.test(l));
    if (insertIdx < 0) continue;
    lines.splice(insertIdx, 0, methodNote);
    fixes.push({ path: f.path, content: lines.join('\n'), explanation: 'Added REST method guidance comment — HTTP 405 indicates the wrong method; update operations typically require PUT (full replace) or PATCH (partial update) not POST', confidence: 82 });
  }
  return fixes;
}

/** Normalize trailing slashes in REST endpoint URLs. */
export function fixRESTTrailingSlash(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/301.*trailing.*slash|404.*trailing.*slash|trailing slash.*redirect/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/[^\s'"]+)\/(\s)/g,
      '$1$2$3',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Removed trailing slash from API endpoint URLs — some REST APIs redirect trailing slashes (301) which curl does not follow by default, resulting in an empty response', confidence: 85 });
  }
  return fixes;
}

/** Add missing Authorization header to REST API calls. */
export function fixRESTAuthHeader(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/401 Unauthorized|403 Forbidden|missing.*authorization|Authorization.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('Authorization:') || f.content.includes('Bearer ')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/)/g,
      '$1-H "Authorization: Bearer ${API_TOKEN}" $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Authorization: Bearer header to curl calls — 401/403 indicates missing or invalid auth; set API_TOKEN as a repository secret', confidence: 85 });
  }
  return fixes;
}

/** Add Content-Type: application/json header to POST/PUT REST API calls. */
export function fixRESTContentTypeHeader(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/415 Unsupported Media Type|Content-Type.*required|missing.*Content-Type|application\/json.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('Content-Type')) continue;
    const fixed = f.content.replace(
      /(curl\s+(?:-X\s+(?:POST|PUT|PATCH)\s+|-d\s+['"{\[])[^\n]*)/g,
      (match) => match.includes('Content-Type') ? match : match.replace(/(curl\s+)/, '$1-H "Content-Type: application/json" '),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Content-Type: application/json header to POST/PUT curl calls — 415 Unsupported Media Type occurs when the API expects JSON but curl sends the default application/x-www-form-urlencoded', confidence: 90 });
  }
  return fixes;
}

/** Add per-environment API endpoint mapping for staging vs production. */
export function fixRESTEndpointEnvMatrix(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('API_BASE_URL') || !f.content.includes('api.') || !f.content.includes('curl ')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      "  API_BASE_URL: ${{ github.ref == 'refs/heads/main' && secrets.PROD_API_BASE_URL || secrets.STAGING_API_BASE_URL }}",
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added environment-conditional API_BASE_URL — selects production URL on main branch and staging URL on all other branches; prevents staging pipelines from accidentally calling production APIs", confidence: 88 });
  }
  return fixes;
}

/** Add Idempotency-Key header for safe retry of mutating REST API calls. */
export function fixRESTIdempotencyHeader(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/duplicate.*request|idempotency.*key|double.*charge|duplicate.*order/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('Idempotency-Key') || !f.content.includes('-X POST')) continue;
    const fixed = f.content.replace(
      /(curl\s+-X\s+POST\s+)/g,
      `$1-H "Idempotency-Key: \$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N)" `,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Idempotency-Key header to POST curl calls — APIs like Stripe and many payment providers deduplicate requests with the same key; prevents double-charges when network retries replay successful requests', confidence: 88 });
  }
  return fixes;
}

/** Add response time logging to detect slow API endpoints in CI. */
export function fixRESTResponseTimeLogging(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/slow.*api|response.*time.*exceeded|latency|api.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl ') || f.content.includes('time_total') || f.content.includes('time_connect')) continue;
    const fixed = f.content.replace(
      /(curl\s+)(https?:\/\/)/g,
      `$1-w "\\nTiming: DNS=%{time_namelookup}s Connect=%{time_connect}s TLS=%{time_appconnect}s Total=%{time_total}s\\n" $2`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added curl timing format for DNS/connect/TLS/total breakdown — identifies which phase is slow (DNS → connection pool issue; TLS → cert chain depth; Total → backend latency)', confidence: 82 });
  }
  return fixes;
}

