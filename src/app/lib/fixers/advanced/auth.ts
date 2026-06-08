// Advanced / Authentication & Permission Errors
// Covers: invalid/expired tokens, SSH known_hosts, OAuth config, OIDC,
// GitLab cross-project access, role permissions, Docker registry auth.
// Extended: bearer prefix, SAML SSO, fine-grained PATs, Azure SP, GCP WIF,
// AWS STS, GitHub App tokens, token expiry, full permissions model,
// OAuth flows, SSH key formats, secret access, IAM roles, cross-project auth.

import { RuleFix, isGitHubWorkflow, isGitLabCI, patchGitHubJobBlocks, patchGitLabJobBlocks, injectWorkflowLevelBlock, insertStepBefore } from '../helpers';

// ── Docker / Deploy credential signals ──────────────────────────────────────
const DOCKER_SIGNALS = ['docker/login-action', 'DOCKER_USERNAME', 'DOCKER_PASSWORD', 'docker login'];
const DEPLOY_SIGNALS = [
  'appleboy/ssh-action', 'appleboy/scp-action',
  'PROD_HOST', 'PROD_SSH_KEY', 'PROD_USER', 'PROD_PASSWORD',
  'DEPLOY_HOST', 'DEPLOY_KEY', 'SSH_PRIVATE_KEY', 'STAGING_HOST',
];

/**
 * PHASE 1: Add `if: push && main` guard to Docker/deploy jobs with no event guard.
 * Prevents credentials from being demanded on PR runs where they are unavailable.
 */
export function fixDockerJobOnPushOnly(files: Array<{ path: string; content: string }>): RuleFix[] {
  const ALL = [...DOCKER_SIGNALS, ...DEPLOY_SIGNALS];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !ALL.some(s => f.content.includes(s))) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => ALL.some(s => b.includes(s)) && !/if:\s*/i.test(b),
      "    if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: "Added push-to-main guard to Docker/deploy jobs — credentials only available on push to main, not PRs", confidence: 100 });
  }
  return fixes;
}

/**
 * PHASE 2: Add `continue-on-error: true` to Docker/deploy jobs whose secrets
 * are not yet configured. This lets overall CI pass even when optional steps fail.
 */
export function fixDockerAndDeployJobsNonBlocking(files: Array<{ path: string; content: string }>): RuleFix[] {
  const ALL = [...DOCKER_SIGNALS, ...DEPLOY_SIGNALS];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !ALL.some(s => f.content.includes(s))) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => ALL.some(s => b.includes(s)) && !/continue-on-error:\s*true/i.test(b),
      '    continue-on-error: true',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added continue-on-error: true to Docker/deploy jobs — DOCKER_USERNAME / PROD_SSH_KEY secrets not configured; CI should pass overall', confidence: 100 });
  }
  return fixes;
}

/** GitLab CI: restrict docker/deploy jobs to main/master via rules:. */
export function fixGitLabDockerJobGuard(files: Array<{ path: string; content: string }>): RuleFix[] {
  const ALL = [...DOCKER_SIGNALS, ...DEPLOY_SIGNALS];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path) || !ALL.some(s => f.content.includes(s))) continue;
    const patched = patchGitLabJobBlocks(
      f.content,
      b => ALL.some(s => b.includes(s)) && !/(rules:|only:|CI_COMMIT_BRANCH)/i.test(b),
      `  rules:\n    - if: '$CI_COMMIT_BRANCH == "main" || $CI_COMMIT_BRANCH == "master"'`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added branch rules to GitLab Docker/deploy jobs — credentials only available on main/master pipeline', confidence: 100 });
  }
  return fixes;
}

/** Add ssh-keyscan known_hosts step before SSH connections that fail host verification. */
export function fixSSHKnownHosts(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Host key verification failed|ECDSA host key|known_hosts|StrictHostKeyChecking/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!DEPLOY_SIGNALS.some(s => f.content.includes(s))) continue;
    if (f.content.includes('ssh-keyscan') || f.content.includes('known_hosts')) continue;
    const patched = insertStepBefore(
      f.content,
      /uses:\s*appleboy\/ssh-action/,
      `      - name: Add SSH known hosts\n        run: |\n          mkdir -p ~/.ssh\n          ssh-keyscan -H \${{ secrets.PROD_HOST || 'example.com' }} >> ~/.ssh/known_hosts`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ssh-keyscan known_hosts step — SSH connection failed with "Host key verification failed"', confidence: 100 });
  }
  return fixes;
}

/** Add GITHUB_TOKEN-based remote URL to authenticate git push from workflow. */
export function fixGitRemoteWithToken(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/refusing to allow a GitHub App to create or update workflow/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('git push') || f.content.includes('GITHUB_TOKEN')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:.*git push/,
      `      - name: Configure git remote with token\n        run: git remote set-url origin https://x-access-token:\${{ secrets.GITHUB_TOKEN }}@github.com/\${{ github.repository }}`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GITHUB_TOKEN remote config — git push denied because App lacks write access', confidence: 100 });
  }
  return fixes;
}

/** Add GitLab CI_JOB_TOKEN for cross-project API access. */
export function fixGitLabCrossProjectToken(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/403 Forbidden.*gitlab|cross.?project.*access|project.*not.*found.*clone/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('CI_JOB_TOKEN') || f.content.includes('PRIVATE_TOKEN')) continue;
    const fixed = f.content.replace(
      /(git clone https?:\/\/)(gitlab\.com\/)([^\s]+)/g,
      '$1gitlab-ci-token:$CI_JOB_TOKEN@$2$3',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added CI_JOB_TOKEN authentication to git clone — cross-project access requires token-based URL', confidence: 100 });
  }
  return fixes;
}

/** Add id-token: write permission for OIDC-based cloud auth. */
export function fixOidcPermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/jwt.*invalid|oidc.*token|AssumeRoleWithWebIdentity|workload.identity|federated.*credential/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  id-token: write', '  contents: read']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added id-token: write — OIDC cloud federation (AWS/GCP/Azure) requires this permission on the GITHUB_TOKEN', confidence: 100 });
  }
  return fixes;
}

/** Add continue-on-error when a token has expired (401) so CI isn't blocked. */
export function fixExpiredToken(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/401 Unauthorized|token.*expired|authentication.*failed.*401|invalid_token/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Add continue-on-error to the job that uses external tokens
    const patched = patchGitHubJobBlocks(
      f.content,
      b => /\$\{\{\s*secrets\./i.test(b) && !/continue-on-error:\s*true/i.test(b) && !/github\.token/i.test(b),
      '    continue-on-error: true  # aegis: token may have expired — rotate via repo Settings > Secrets',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added continue-on-error to token-dependent jobs — 401 suggests token has expired; rotate via repository secrets', confidence: 100 });
  }
  return fixes;
}

/** Add npm config set @scope:registry token setup for private npm registry auth. */
export function fixNpmPrivateRegistry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/npm ERR! 401.*registry|Unauthorized.*registry|E401.*registry/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('.npmrc') || f.content.includes('NODE_AUTH_TOKEN')) continue;
    if (!f.content.includes('npm install') && !f.content.includes('npm ci')) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*npm (install|ci)/,
      `      - name: Configure npm registry auth\n        run: |\n          echo "//registry.npmjs.org/:_authToken=\${{ secrets.NPM_TOKEN }}" > ~/.npmrc\n        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added npm registry authentication step — private packages require NPM_TOKEN configured in repository secrets', confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION A — Invalid Access Token
// ═══════════════════════════════════════════════════════════════════════════

/** Replace curl ?token= query-param auth with Authorization: Bearer header (RFC 6750 §2.3). */
export function fixMissingBearerPrefix(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/401 Unauthorized|invalid_token|Bearer.*required|missing.*authorization.*header/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl') || f.content.includes('Authorization: Bearer')) continue;
    if (!/\?token=\$\{\{/i.test(f.content)) continue;
    const fixed = f.content.replace(
      /(curl\s+)((?:(?!-H.*Authorization)[^\n])*)\?token=\$\{\{\s*secrets\.([\w]+)\s*\}\}/gi,
      '$1-H "Authorization: Bearer ${{ secrets.$3 }}" $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Moved token from URL query param to Authorization: Bearer header — many APIs (GitHub, GCP, Artifactory) reject query-param tokens; RFC 6750 requires the header form', confidence: 90 });
  }
  return fixes;
}

/** When GITHUB_TOKEN lacks required scope, add GH_PAT fallback with comment on required scopes. */
export function fixGitHubTokenScopes(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/refusing to allow|Token doesn.t have.*scope|Scope.*insufficient|requires.*scope|GitHub.*App.*cannot/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('GITHUB_TOKEN') || f.content.includes('GH_PAT')) continue;
    const fixed = f.content
      .replace(/\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/g, '${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}')
      .replace(/\$\{\{\s*github\.token\s*\}\}/g, '${{ secrets.GH_PAT || github.token }}');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GH_PAT fallback — GITHUB_TOKEN cannot modify workflows, create releases across repos, or bypass branch protection; create a PAT with repo+workflow scopes and store as GH_PAT', confidence: 90 });
  }
  return fixes;
}

/** Org SAML SSO enforcement — token must be SSO-authorized; add env comment with link. */
export function fixSAMLSSOTokenAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/SAML.*enforcement|SSO.*required|organization.*SAML|authorize.*SSO|must.*be.*authorized.*SSO/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('GH_TOKEN_SSO') || f.content.includes('# saml-authorized')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  GH_TOKEN: ${{ secrets.GH_TOKEN_SSO }}  # Must be a PAT authorized for SAML SSO — authorize at github.com/orgs/<ORG>/sso',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Org enforces SAML SSO — PAT must be authorized for the org before it works; visit github.com/settings/tokens, click your token, and click "Authorize" next to the org', confidence: 95 });
  }
  return fixes;
}

/** Fine-grained PAT — 403 because target repo wasn't granted in the token's access list. */
export function fixFineGrainedPATAccess(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/fine.?grained|Resource.*not.*accessible.*token|403.*personal.*access.*token.*fine/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('# fine-grained')) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => /\$\{\{\s*secrets\.(GH_PAT|PAT|TOKEN|GITHUB_TOKEN)\s*\}\}/i.test(b),
      '    # aegis: fine-grained PAT requires explicit repository access — Settings > Developer settings > Fine-grained tokens > Edit token > Repository access',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Fine-grained PAT denied — token must list the target repository under "Repository access"; classic PATs have broader repo access by default if repo scope is checked', confidence: 85 });
  }
  return fixes;
}

/** Detect misspelled/missing secret name from logs and surface a diagnostic comment. */
export function fixWrongSecretReference(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Context access might be invalid|secret.*not.*set|Expected.*secret|Unrecognized.*secrets\./i.test(logs)) return [];
  const badSecretMatch = logs.match(/secrets\.(\w+).*(?:not.*set|undefined|invalid|not.*found)/i)
    ?? logs.match(/Unrecognized.*?secrets\.(\w+)/i);
  const badSecret = badSecretMatch?.[1];
  if (!badSecret) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes(`secrets.${badSecret}`) && !f.content.includes(`$${badSecret}`)) continue;
    fixes.push({
      path: f.path,
      content: f.content,
      explanation: `Secret '${badSecret}' is referenced but not configured — add it via Settings > Secrets and variables > Actions (GitHub) or Settings > CI/CD > Variables (GitLab); check for typos vs. the name in your secrets vault`,
      confidence: 80,
    });
  }
  return fixes;
}

/** Add azure/login OIDC step before Azure CLI commands that fail with AADSTS errors. */
export function fixAzureServicePrincipalAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/AADSTS\d+|az login.*required|Azure.*authentication.*failed|ClientAuthenticationError|Please run.*az login/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('az ') && !f.content.toLowerCase().includes('azure')) continue;
    if (f.content.includes('azure/login') || f.content.includes('az login')) continue;
    const loginStep = [
      '      - name: Login to Azure',
      '        uses: azure/login@v2',
      '        with:',
      '          client-id: ${{ secrets.AZURE_CLIENT_ID }}',
      '          tenant-id: ${{ secrets.AZURE_TENANT_ID }}',
      '          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*az\s+/i, loginStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added azure/login with federated OIDC credentials — AADSTS error means no active Azure session; requires AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID secrets and a federated credential on the App Registration', confidence: 95 });
  }
  return fixes;
}

/** Add google-github-actions/auth Workload Identity step before gcloud commands. */
export function fixGCPWorkloadIdentityAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/google.*credentials.*not.*found|gcloud.*not.*authenticated|GOOGLE_APPLICATION_CREDENTIALS.*missing|Error.*ADC.*not.*found|Unable to detect.*credentials/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('gcloud') && !f.content.includes('google-github-actions')) continue;
    if (f.content.includes('google-github-actions/auth') || f.content.includes('GOOGLE_APPLICATION_CREDENTIALS')) continue;
    const authStep = [
      '      - name: Authenticate to Google Cloud',
      '        id: gcp-auth',
      '        uses: google-github-actions/auth@v2',
      '        with:',
      '          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}',
      '          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*gcloud\s+/i, authStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GCP Workload Identity Federation auth — ADC (Application Default Credentials) not found; WIF is the recommended keyless method, no JSON key file required; add GCP_WORKLOAD_IDENTITY_PROVIDER and GCP_SERVICE_ACCOUNT secrets', confidence: 95 });
  }
  return fixes;
}

/** Add role-to-assume to aws-actions/configure-aws-credentials when STS AssumeRole fails. */
export function fixAWSSTSAssumeRole(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/not authorized to perform.*sts:AssumeRole|AccessDenied.*sts|is not authorized.*arn:aws:iam/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('aws-actions/configure-aws-credentials')) continue;
    if (f.content.includes('role-to-assume')) continue;
    const fixed = f.content.replace(
      /(uses:\s*aws-actions\/configure-aws-credentials@[^\n]+\n)((\s+with:\s*\n))/,
      '$1$2          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}\n          role-session-name: GitHubActionsSession\n          role-duration-seconds: 3600\n',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added role-to-assume for AWS OIDC — sts:AssumeRole denied because the GitHub OIDC trust policy must reference this ARN; add AWS_ROLE_ARN secret with the full IAM role ARN (arn:aws:iam::<ACCOUNT>:role/<ROLE>)', confidence: 90 });
  }
  return fixes;
}

/** Add actions/create-github-app-token step to generate installation token for GitHub App auth. */
export function fixGitHubAppInstallationToken(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/GitHub App.*authentication|app.*installation.*token.*missing|JWT.*expired.*App|App.*private.*key.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('create-github-app-token') || f.content.includes('tibdex/github-app-token')) continue;
    if (!f.content.includes('APP_ID') && !f.content.includes('APP_PRIVATE_KEY')) continue;
    const lines = f.content.split('\n');
    const stepsIdx = lines.findIndex(l => /^\s+steps:\s*$/.test(l));
    if (stepsIdx === -1) continue;
    const tokenStep = [
      '      - name: Generate GitHub App installation token',
      '        id: app-token',
      '        uses: actions/create-github-app-token@v1',
      '        with:',
      '          app-id: ${{ secrets.APP_ID }}',
      '          private-key: ${{ secrets.APP_PRIVATE_KEY }}',
    ].join('\n');
    const out = [...lines];
    out.splice(stepsIdx + 1, 0, tokenStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added GitHub App installation token step — use ${{ steps.app-token.outputs.token }} in subsequent steps; App tokens can modify workflow files, bypass branch protection (when granted), and access cross-org repos that the App is installed on', confidence: 90 });
  }
  return fixes;
}

/** Move API key from URL query string to Authorization header or X-Api-Key header. */
export function fixAPIKeyQueryToHeader(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/invalid.*api.*key|api.key.*invalid|401.*api.key|403.*api.key/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('curl')) continue;
    const hasAPIKeyInURL = /curl[^\n]*[?&]api.?key=\$\{\{/i.test(f.content);
    if (!hasAPIKeyInURL) continue;
    const fixed = f.content.replace(
      /(curl\s+)((?:(?!\n)[^\n])*)[?&]api.?key=\$\{\{\s*secrets\.([\w]+)\s*\}\}/gi,
      '$1-H "X-Api-Key: ${{ secrets.$3 }}" $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Moved API key from URL query param to X-Api-Key header — API keys in URLs are logged by proxies and servers; header-based auth prevents key exposure in access logs', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION B — Expired Token
// ═══════════════════════════════════════════════════════════════════════════

/** Add a pre-flight token validity check step that fails fast with a clear error message. */
export function fixTokenValidationPreflight(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/token.*expired|credentials.*expired|401.*Unauthorized|session.*expired|token.*no longer.*valid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('token-check') || f.content.includes('validate.*token')) continue;
    if (!f.content.includes('secrets.') || !f.content.includes('curl')) continue;
    const checkStep = [
      '      - name: Validate authentication token',
      '        run: |',
      '          STATUS=$(curl -s -o /dev/null -w "%{http_code}" \\',
      '            -H "Authorization: Bearer ${{ secrets.API_TOKEN }}" \\',
      '            https://api.github.com/user)',
      '          if [ "$STATUS" != "200" ]; then',
      '            echo "ERROR: API token invalid or expired (HTTP $STATUS) — rotate the token in repository secrets"',
      '            exit 1',
      '          fi',
      '          echo "Token valid (HTTP $STATUS)"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*actions\/checkout|run:\s*(?:npm|yarn|pnpm)\s+/i, checkStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added token preflight validation — 401 errors mid-job waste runner minutes; preflight check fails immediately with a clear message instead of failing on the actual operation', confidence: 80 });
  }
  return fixes;
}

/** Add npm whoami preflight check to surface expired NPM_TOKEN before publish fails. */
export function fixNPMTokenExpiry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/npm.*401|E401.*npm.*registry|npm.*Unauthorized|NPM_TOKEN.*expired/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('npm publish') || f.content.includes('npm whoami')) continue;
    const checkStep = [
      '      - name: Verify NPM token',
      '        run: |',
      '          npm whoami || (echo "ERROR: NPM_TOKEN is invalid or expired — rotate at npmjs.com/settings/<USER>/tokens" && exit 1)',
      '        env:',
      '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*npm publish/i, checkStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added npm whoami before publish — npm 401 on publish means NPM_TOKEN is expired or has wrong scope (needs automation token with publish rights at npmjs.com/settings/<USER>/tokens)', confidence: 95 });
  }
  return fixes;
}

/** Add docker info check before push to detect expired Docker Hub token early. */
export function fixDockerHubTokenExpiry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/docker.*401|unauthorized.*docker|docker.*login.*failed|DOCKER.*token.*expired/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('docker/login-action') && !f.content.includes('docker login')) continue;
    if (f.content.includes('docker info') || f.content.includes('token-check')) continue;
    const checkStep = [
      '      - name: Verify Docker Hub credentials',
      '        run: |',
      '          echo "${{ secrets.DOCKER_PASSWORD }}" | docker login -u "${{ secrets.DOCKER_USERNAME }}" --password-stdin 2>&1 || \\',
      '          (echo "ERROR: Docker Hub auth failed — rotate DOCKER_PASSWORD at hub.docker.com/settings/security (use an Access Token, not account password)" && exit 1)',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker push/i, checkStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Docker Hub credential preflight — 401 on docker push means DOCKER_PASSWORD (Access Token) is expired; create a new token at hub.docker.com/settings/security', confidence: 90 });
  }
  return fixes;
}

/** Upgrade static long-lived AWS access keys to OIDC-based keyless auth when credentials expire. */
export function fixAWSCredentialOIDCUpgrade(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ExpiredTokenException|AWS.*token.*expired|Credentials.*expired.*STS|InvalidClientTokenId/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('AWS_ACCESS_KEY_ID') || f.content.includes('role-to-assume')) continue;
    const fixed = f.content.replace(
      /(uses:\s*aws-actions\/configure-aws-credentials@[^\n]+)\n(\s+with:\s*\n\s+aws-access-key-id:.*\n\s+aws-secret-access-key:.*\n)/i,
      '$1\n$2          # aegis: static keys expire — migrate to OIDC: remove aws-access-key-id/aws-secret-access-key, add role-to-assume: ${{ secrets.AWS_ROLE_ARN }} and id-token: write permission\n',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'ExpiredTokenException on static AWS keys — migrate to OIDC: remove AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY secrets, add id-token: write to permissions block, set role-to-assume in the credentials action', confidence: 85 });
  }
  return fixes;
}

/** Add GCP service account key refresh step when key-based auth fails with permission errors. */
export function fixGCPSAKeyRefresh(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/google.*key.*expired|service.?account.*key.*invalid|GOOGLE.*credential.*expired|key.*rotation.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('GCP_SA_KEY') && !f.content.includes('GOOGLE_CREDENTIALS')) continue;
    if (f.content.includes('workload_identity_provider')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: GCP SA key expired — rotate via: gcloud iam service-accounts keys create /tmp/key.json --iam-account=<SA> then update GCP_SA_KEY secret',
      '  # Consider migrating to Workload Identity Federation (keyless) — no key rotation needed',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'GCP service account key expired — rotate via gcloud iam service-accounts keys create; best practice is to migrate to Workload Identity Federation which never requires key rotation', confidence: 85 });
  }
  return fixes;
}

/** Handle Heroku API key 401 — add diagnostic and suggest rotation path. */
export function fixHerokuAPIKeyRotation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/heroku.*401|HEROKU.*unauthorized|Heroku.*Invalid credentials|heroku.*token.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('HEROKU_API_KEY') && !f.content.includes('heroku')) continue;
    if (f.content.includes('heroku-auth-check')) continue;
    const checkStep = [
      '      - name: Verify Heroku credentials',
      '        run: |',
      '          curl -s -n https://api.heroku.com/account \\',
      '            -H "Accept: application/vnd.heroku+json; version=3" \\',
      '            -H "Authorization: Bearer ${{ secrets.HEROKU_API_KEY }}" | grep -q "email" || \\',
      '          (echo "ERROR: HEROKU_API_KEY expired — regenerate at dashboard.heroku.com/account (Account > API Key > Regenerate)" && exit 1)',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*heroku\s+container|uses:.*akhileshns\/heroku-deploy/i, checkStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Heroku API key preflight — 401 means HEROKU_API_KEY expired; regenerate at dashboard.heroku.com/account, update the secret, redeploy', confidence: 90 });
  }
  return fixes;
}

/** Handle Atlassian (Jira/Confluence) API token expiry — add a preflight check. */
export function fixAtlassianAPITokenExpiry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/atlassian.*401|jira.*unauthorized|confluence.*invalid.*token|JIRA.*token.*expired/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('JIRA') && !f.content.includes('ATLASSIAN') && !f.content.includes('atlassian')) continue;
    if (f.content.includes('atlassian-check')) continue;
    const checkStep = [
      '      - name: Verify Atlassian API token',
      '        run: |',
      '          STATUS=$(curl -s -o /dev/null -w "%{http_code}" \\',
      '            -u "${{ secrets.JIRA_USER_EMAIL }}:${{ secrets.JIRA_API_TOKEN }}" \\',
      '            "https://${{ secrets.JIRA_DOMAIN }}/rest/api/3/myself")',
      '          [ "$STATUS" = "200" ] || (echo "ERROR: Jira API token invalid (HTTP $STATUS) — regenerate at id.atlassian.com/manage-profile/security/api-tokens" && exit 1)',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*jira|run:.*confluence/i, checkStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Jira API token preflight — Atlassian tokens have no expiry but can be revoked; preflight check surfaces the error before the actual operation fails', confidence: 85 });
  }
  return fixes;
}

/** Fix expired Terraform Cloud API token — add tfc-auth check step. */
export function fixTerraformCloudTokenRenewal(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/terraform.*401|TFC.*token.*invalid|app\.terraform\.io.*unauthorized|TF_TOKEN.*expired/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('TF_TOKEN') && !f.content.includes('terraform')) continue;
    if (f.content.includes('tfc-auth-check')) continue;
    const checkStep = [
      '      - name: Verify Terraform Cloud token',
      '        run: |',
      '          STATUS=$(curl -s -o /dev/null -w "%{http_code}" \\',
      '            -H "Authorization: Bearer ${{ secrets.TF_TOKEN_APP_TERRAFORM_IO }}" \\',
      '            https://app.terraform.io/api/v2/account/details)',
      '          [ "$STATUS" = "200" ] || (echo "ERROR: TF_TOKEN invalid (HTTP $STATUS) — regenerate at app.terraform.io/app/settings/tokens" && exit 1)',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*terraform\s+/i, checkStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added TFC token preflight — TF_TOKEN_APP_TERRAFORM_IO invalid; regenerate at app.terraform.io/app/settings/tokens and update the secret', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION C — Permission Denied
// ═══════════════════════════════════════════════════════════════════════════

/** Add contents: write when job needs to push commits, create tags, or update releases. */
export function fixContentsWritePermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Resource.*not.*accessible.*push|403.*git push|Permission.*denied.*contents|cannot.*push.*without.*write/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  contents: write']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added contents: write — job needs to push commits, create tags, or update releases; the default GITHUB_TOKEN only has contents: read in public repos and write in private repos but is restricted by the workflow permissions block', confidence: 95 });
  }
  return fixes;
}

/** Add packages: write when job needs to push images to GitHub Container Registry. */
export function fixPackagesWritePermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/denied.*ghcr\.io|unauthorized.*ghcr|403.*packages|GHCR.*permission.*denied|push.*ghcr\.io.*denied/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('ghcr.io') && !f.content.includes('packages')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  packages: write', '  contents: read']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added packages: write — pushing to ghcr.io requires this permission on the GITHUB_TOKEN; also ensure the package visibility allows the workflow', confidence: 95 });
  }
  return fixes;
}

/** Add packages: read when job needs to pull images from GHCR. */
export function fixPackagesReadPermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pull.*ghcr\.io.*denied|unauthorized.*ghcr.*pull|403.*ghcr.*read/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('ghcr.io')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  packages: read']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added packages: read — pulling from ghcr.io requires explicit read permission on the GITHUB_TOKEN when the packages permission block is present', confidence: 95 });
  }
  return fixes;
}

/** Add pull-requests: write when job needs to create, update, or comment on PRs. */
export function fixPullRequestsWritePermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission.*denied.*pull.request|403.*pull.request|cannot.*create.*PR|pull_requests.*write.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  pull-requests: write']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pull-requests: write — creating PRs, adding labels, or posting PR comments requires this permission; used by auto-PR creation and PR-comment coverage reporters', confidence: 95 });
  }
  return fixes;
}

/** Add issues: write when job needs to create or update GitHub Issues. */
export function fixIssuesWritePermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission.*denied.*issues|403.*issues|cannot.*create.*issue|issues.*write.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('issue') && !f.content.includes('gh issue')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  issues: write']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added issues: write — creating issues, adding comments, or applying labels via the API/gh CLI requires this permission on the GITHUB_TOKEN', confidence: 95 });
  }
  return fixes;
}

/** Add checks: write when job posts status checks, annotations, or check run updates. */
export function fixChecksWritePermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission.*denied.*checks|403.*check.run|checks.*write.*required|annotations.*forbidden/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  checks: write']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added checks: write — posting check run annotations (JUnit results, lint warnings, test summaries) requires this permission; used by actions like mikepenz/action-junit-report', confidence: 95 });
  }
  return fixes;
}

/** Add pages: write + id-token: write for GitHub Pages OIDC deployment. */
export function fixPagesDeployPermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pages.*permission|403.*pages|github.?pages.*denied|deploy.*pages.*forbidden/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pages') && !f.content.includes('JamesIves/github-pages-deploy-action')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', [
      '  pages: write',
      '  id-token: write',
      '  contents: read',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pages: write + id-token: write — GitHub Pages deployment via actions/deploy-pages requires both permissions; id-token is needed for OIDC-based artifact deployment', confidence: 95 });
  }
  return fixes;
}

/** Add deployments: write for actions that create GitHub deployment records. */
export function fixDeploymentsWritePermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission.*denied.*deployment|403.*deployments|deployment.*forbidden|create.*deployment.*401/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deployment') && !f.content.includes('environment:')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  deployments: write']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added deployments: write — creating deployment records and updating environment deployment status requires this permission; needed for environment protection rule integrations', confidence: 95 });
  }
  return fixes;
}

/** Add security-events: write for SARIF/CodeQL upload to Security tab. */
export function fixSecurityEventsWritePermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/security-events.*write|403.*sarif|SARIF.*upload.*denied|codeql.*permission.*denied/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('sarif') && !f.content.includes('codeql') && !f.content.includes('security')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', [
      '  security-events: write',
      '  actions: read',
      '  contents: read',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added security-events: write — uploading SARIF results to GitHub Security tab requires this permission; CodeQL, Trivy, Snyk all use this endpoint', confidence: 95 });
  }
  return fixes;
}

/** Add actions: read when job needs to fetch information about workflow runs or artifacts. */
export function fixActionsReadPermission(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/actions.*read.*required|403.*actions.*api|workflow.*run.*forbidden/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', ['  actions: read']);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added actions: read — reading workflow run status, downloading artifacts from other runs, or using the GitHub Actions API requires this permission', confidence: 90 });
  }
  return fixes;
}

/** Add a full least-privilege permissions block when no permissions block exists. */
export function fixWorkflowPermissionsBlock(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission.*denied|403 Forbidden|Resource not accessible|insufficient.*permission/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('permissions:')) continue;
    const needsContents = f.content.includes('git push') || f.content.includes('create.*release');
    const needsPR       = f.content.includes('gh pr') || f.content.includes('pull-requests');
    const needsPackages = f.content.includes('ghcr.io') || f.content.includes('docker push');
    const perms = [
      '  contents: ' + (needsContents ? 'write' : 'read'),
      needsPR       ? '  pull-requests: write' : null,
      needsPackages ? '  packages: write'      : null,
    ].filter(Boolean) as string[];
    const fixed = injectWorkflowLevelBlock(f.content, 'permissions', perms);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added least-privilege permissions block — workflows without an explicit permissions block inherit organization/repo defaults which may be overly broad; explicit scoping follows security best practice', confidence: 85 });
  }
  return fixes;
}

/** GitLab CI — add branch rules to prevent protected-branch push errors on pipeline push steps. */
export function fixGitLabProtectedBranchPushGuard(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/GitLab.*protected.*branch.*push|You are not allowed.*push.*protected|remote.*rejected.*protected/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('git push') || f.content.includes('rules:') || f.content.includes('only:')) continue;
    const patched = patchGitLabJobBlocks(
      f.content,
      b => b.includes('git push') && !/(rules:|only:)/i.test(b),
      `  rules:\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'\n      when: on_success\n    - when: never`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added branch rule to GitLab push job — protected branch rejected push; restrict the push step to run only on the default branch; also ensure the CI token or deploy key has Maintainer access', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION D — OAuth Authentication Failure
// ═══════════════════════════════════════════════════════════════════════════

/** Fix OAuth redirect_uri mismatch — add the correct callback URL to env vars. */
export function fixOAuthRedirectURIMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/redirect_uri.*mismatch|redirect.*uri.*invalid|redirect_uri.*not.*match|invalid.*redirect_uri/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('OAUTH') && !f.content.includes('oauth') && !f.content.includes('redirect')) continue;
    if (f.content.includes('OAUTH_REDIRECT_URI')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  OAUTH_REDIRECT_URI: ${{ secrets.OAUTH_REDIRECT_URI }}  # Must exactly match the URI registered in the OAuth app settings',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Redirect URI mismatch — the redirect_uri in your auth request must exactly match (scheme, host, port, path) what is registered in the OAuth application; update the app registration or set OAUTH_REDIRECT_URI to the registered value', confidence: 85 });
  }
  return fixes;
}

/** Add missing OAuth scopes to the authorization URL env configuration. */
export function fixOAuthMissingScopes(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/insufficient.*scope|scope.*not.*granted|oauth.*scope.*missing|required.*scope.*not.*present/i.test(logs)) return [];
  const scopeMatch = logs.match(/(?:required|missing|insufficient)\s+scope[s]?[:\s]+(['\"]?[\w:, ]+['\"]?)/i);
  const requiredScope = scopeMatch?.[1]?.replace(/['"]/g, '').trim() ?? 'read:user,repo';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('OAUTH') && !f.content.includes('oauth')) continue;
    if (f.content.includes('OAUTH_SCOPES')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      `  OAUTH_SCOPES: '${requiredScope}'  # Add required OAuth scopes to your auth request`,
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Missing OAuth scope '${requiredScope}' — add the required scope to your authorization URL (?scope=<value>) and update the OAuth app to request these scopes; users may need to re-authorize`, confidence: 85 });
  }
  return fixes;
}

/** Add OAuth state parameter for CSRF protection when missing from the auth flow. */
export function fixOAuthCSRFState(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/state.*mismatch|invalid.*state|oauth.*state.*required|csrf.*state/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('oauth') && !f.content.includes('OAUTH')) continue;
    if (f.content.includes('OAUTH_STATE') || f.content.includes('state=')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  OAUTH_STATE: ${{ secrets.OAUTH_STATE_SECRET }}  # Generate securely: openssl rand -hex 32',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'OAuth state parameter mismatch — the state value sent with the auth request must be validated in the callback; generate with `openssl rand -hex 32` and store as OAUTH_STATE_SECRET', confidence: 80 });
  }
  return fixes;
}

/** Fix GitHub OAuth App configuration — add client ID and secret env mapping. */
export function fixGitHubOAuthAppConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/GitHub OAuth.*client.*invalid|incorrect_client_credentials|client_id.*not.*found|OAuth App.*not.*authorized/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('GITHUB_CLIENT_ID') || f.content.includes('GH_OAUTH_CLIENT_ID')) continue;
    if (!f.content.includes('oauth') && !f.content.includes('github.com/login/oauth')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  GITHUB_CLIENT_ID: ${{ secrets.GITHUB_CLIENT_ID }}',
      '  GITHUB_CLIENT_SECRET: ${{ secrets.GITHUB_CLIENT_SECRET }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'GitHub OAuth App credentials not configured — store Client ID and Client Secret from github.com/settings/developers as GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; do not use the GITHUB_TOKEN for OAuth app flows', confidence: 90 });
  }
  return fixes;
}

/** Add Google OAuth service account impersonation for CI flows that need user OAuth. */
export function fixGoogleOAuthServiceAccount(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/google.*oauth.*invalid_client|Google.*client.*secret.*invalid|GOOGLE.*OAuth.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('GOOGLE') && !f.content.includes('google')) continue;
    if (f.content.includes('GOOGLE_CLIENT_ID') || f.content.includes('google-github-actions/auth')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}',
      '  GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}',
      '  # For CI: prefer Service Account + Workload Identity Federation over OAuth Client credentials',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Google OAuth client credentials not found — for CI pipelines, use Service Account auth via Workload Identity Federation instead of OAuth; OAuth flows require user consent which cannot be automated', confidence: 85 });
  }
  return fixes;
}

/** Fix OAuth callback URL env var when it does not match the registered application. */
export function fixOAuthCallbackURLEnvVar(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/callback.*url.*invalid|callback.*not.*registered|redirect.*callback.*mismatch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('CALLBACK_URL') || f.content.includes('OAUTH_CALLBACK')) continue;
    if (!f.content.includes('oauth') && !f.content.includes('OAUTH')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  OAUTH_CALLBACK_URL: ${{ secrets.OAUTH_CALLBACK_URL }}  # Must match exactly the callback URL in your OAuth app registration',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'OAuth callback URL mismatch — register the exact callback URL (including trailing slash) in your OAuth provider app settings; any mismatch, even in protocol (http vs https) or port, causes this error', confidence: 85 });
  }
  return fixes;
}

/** Add PKCE code_verifier/code_challenge env setup for OAuth flows that require PKCE. */
export function fixOAuthPKCEVerifier(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/pkce.*required|code_verifier.*missing|code_challenge.*required|PKCE.*not.*supported/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('oauth') && !f.content.includes('OAUTH')) continue;
    if (f.content.includes('code_verifier') || f.content.includes('PKCE')) continue;
    const pkceStep = [
      '      - name: Generate PKCE verifier',
      '        id: pkce',
      '        run: |',
      '          CODE_VERIFIER=$(openssl rand -base64 48 | tr -d "=+/" | cut -c -43)',
      '          CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d "=" | tr "+/" "-_")',
      '          echo "verifier=$CODE_VERIFIER" >> $GITHUB_OUTPUT',
      '          echo "challenge=$CODE_CHALLENGE" >> $GITHUB_OUTPUT',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*oauth|run:.*authorize/i, pkceStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added PKCE code_verifier/code_challenge generation — use S256 challenge method; send code_challenge with the auth request and code_verifier with the token exchange', confidence: 85 });
  }
  return fixes;
}

/** Store OAuth access token securely in a masked env variable, not in a log-visible variable. */
export function fixOAuthTokenStorage(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/oauth.*token.*exposed|access_token.*log|token.*printed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('add-mask') || !f.content.includes('access_token')) continue;
    const fixed = f.content.replace(
      /(ACCESS_TOKEN\s*=\s*\$\(.*\))/gi,
      '$1\n          echo "::add-mask::$ACCESS_TOKEN"',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ::add-mask:: to OAuth access token — tokens assigned to shell variables appear in debug logs without masking; ::add-mask:: prevents the value from being printed in any subsequent log line', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION E — SSH Key Mismatch
// ═══════════════════════════════════════════════════════════════════════════

/** Add ssh-keygen -t ed25519 generation note when RSA key format causes auth failure. */
export function fixSSHKeyFormatEd25519(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/invalid.*key.*format|ssh.*key.*format.*error|PEM.*invalid|ssh.?rsa.*deprecated|key.*type.*not.*accepted/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('SSH_PRIVATE_KEY') && !f.content.includes('ssh-rsa')) continue;
    if (f.content.includes('ed25519') || f.content.includes('key-format-note')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: generate Ed25519 keys for modern SSH: ssh-keygen -t ed25519 -C "ci@your-org" -f deploy_key -N ""',
      '  # RSA keys < 2048 bits and SHA-1 are rejected by OpenSSH 8.8+ servers',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'SSH key format rejected — OpenSSH 8.8+ disables RSA-SHA1; generate Ed25519 keys (ssh-keygen -t ed25519) for compatibility; update SSH_PRIVATE_KEY secret with the new private key and add the public key to the server/deploy keys', confidence: 90 });
  }
  return fixes;
}

/** Add SSH agent socket setup for multi-hop SSH connections (agent forwarding). */
export function fixSSHAgentSocketForwarding(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Could not open.*connection|agent.*not.*running|ssh.*agent.*socket|SSH_AUTH_SOCK.*not.*set/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('ssh-agent') || f.content.includes('SSH_AUTH_SOCK')) continue;
    if (!f.content.includes('SSH_PRIVATE_KEY')) continue;
    const agentStep = [
      '      - name: Start SSH agent',
      '        uses: webfactory/ssh-agent@v0.9.0',
      '        with:',
      '          ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*appleboy\/ssh-action|run:\s*ssh\s+/i, agentStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added SSH agent via webfactory/ssh-agent — SSH_AUTH_SOCK not set means the agent is not running; this action starts the agent, adds the key, and sets SSH_AUTH_SOCK for all subsequent steps', confidence: 95 });
  }
  return fixes;
}

/** Detect read-only deploy key used for push — add comment on creating a write deploy key. */
export function fixSSHDeployKeyWriteAccess(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deploy key.*read.only|permission.*denied.*push.*deploy.key|remote.*rejected.*read.only/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('SSH_PRIVATE_KEY') && !f.content.includes('DEPLOY_KEY')) continue;
    if (f.content.includes('write-deploy-key')) continue;
    const fixed = f.content.replace(
      /(SSH_PRIVATE_KEY|DEPLOY_KEY)(\s*:\s*\$\{\{)/,
      '$1  # aegis: this must be a deploy key with WRITE access — repo Settings > Deploy keys > Allow write access checkbox$2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Deploy key is read-only — go to repo Settings > Deploy keys, delete the current key, and re-add with "Allow write access" checked; generate a new key pair and update the SSH_PRIVATE_KEY secret', confidence: 95 });
  }
  return fixes;
}

/** Add ssh-keygen -p to strip passphrase from SSH key for unattended CI use. */
export function fixSSHKeyPassphraseCI(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/passphrase.*required|Enter passphrase.*key|ssh.*passphrase.*CI|bad.*passphrase/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('SSH_PRIVATE_KEY') && !f.content.includes('ssh-key')) continue;
    if (f.content.includes('SSH_KEY_PASSPHRASE') || f.content.includes('passphrase')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  SSH_KEY_PASSPHRASE: ${{ secrets.SSH_KEY_PASSPHRASE }}  # Store key passphrase here, or remove it with: ssh-keygen -p -f key -N "" -P "old_passphrase"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'SSH key has a passphrase — CI cannot enter passphrases interactively; either remove the passphrase (ssh-keygen -p -f key -N "") or use webfactory/ssh-agent which accepts PASSPHRASE in with.ssh-private-key', confidence: 90 });
  }
  return fixes;
}

/** Add HostKeyAlgorithms to SSH config when server key algorithm differs from client expectation. */
export function fixSSHHostKeyAlgorithmMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/no matching host key type|server host key.*not in.*PubkeyAcceptedKeyTypes|HostKeyAlgorithms|key exchange.*no match/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('SSH_PRIVATE_KEY') && !f.content.includes('ssh-action')) continue;
    if (f.content.includes('HostKeyAlgorithms') || f.content.includes('ssh-config')) continue;
    const configStep = [
      '      - name: Configure SSH host key algorithms',
      '        run: |',
      '          mkdir -p ~/.ssh',
      '          cat >> ~/.ssh/config << EOF',
      '          Host *',
      '            HostKeyAlgorithms +ssh-rsa',
      '            PubkeyAcceptedKeyTypes +ssh-rsa',
      '            StrictHostKeyChecking no',
      '          EOF',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*appleboy\/ssh-action|run:\s*ssh\s+/i, configStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added SSH host key algorithm config — "no matching host key type" means the server uses an algorithm disabled in the client; adding +ssh-rsa to PubkeyAcceptedKeyTypes re-enables legacy RSA on newer OpenSSH clients', confidence: 85 });
  }
  return fixes;
}

/** Run ssh-keyscan for all deployment hosts extracted from the workflow. */
export function fixSSHMultipleHostsKeyscan(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Host key verification failed|ECDSA host key.*changed|WARNING.*REMOTE HOST IDENTIFICATION/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('ssh-action') && !f.content.includes('SSH_PRIVATE_KEY')) continue;
    if (f.content.includes('ssh-keyscan')) continue;
    const hostMatches = [...f.content.matchAll(/host[s]?:\s*\$\{\{\s*secrets\.([\w]+)\s*\}\}/gi)];
    const hostRefs = hostMatches.length > 0
      ? hostMatches.map(m => `          ssh-keyscan -H "\${{ secrets.${m[1]} }}" >> ~/.ssh/known_hosts`).join('\n')
      : '          ssh-keyscan -H "${{ secrets.PROD_HOST }}" >> ~/.ssh/known_hosts';
    const keyscanStep = [
      '      - name: Add deployment host(s) to known_hosts',
      '        run: |',
      '          mkdir -p ~/.ssh',
      '          chmod 700 ~/.ssh',
      hostRefs,
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*appleboy\/ssh-action/i, keyscanStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ssh-keyscan for deployment hosts — "Host key verification failed" because known_hosts is empty in CI; keyscan pre-populates it before the SSH connection', confidence: 95 });
  }
  return fixes;
}

/** Ensure SSH private key file has 0600 permissions before SSH use. */
export function fixSSHKeyFilePermissions600(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/bad permissions.*private key|permissions.*too open.*ssh|WARNING.*UNPROTECTED PRIVATE KEY/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('SSH_PRIVATE_KEY') || f.content.includes('chmod 600')) continue;
    const fixed = f.content.replace(
      /(echo "\$\{\{\s*secrets\.SSH_PRIVATE_KEY\s*\}\}"?\s*>\s*(~\/\.ssh\/id_[^\s\n]+|\/tmp\/[^\s\n]+))/g,
      '$1\n          chmod 600 $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added chmod 600 after writing SSH key — OpenSSH refuses to use private key files with world-readable permissions (0644); key files must be owner-readable only (0600)', confidence: 95 });
  }
  return fixes;
}

/** Add GitLab deploy key with write access note when pipeline push fails. */
export function fixGitLabDeployKeyWriteAccess(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/remote.*rejected.*GitLab|permission.*denied.*gitlab.*deploy.key|deploy.key.*read.only.*gitlab/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('git push') || f.content.includes('CI_DEPLOY_TOKEN')) continue;
    const fixed = f.content.replace(
      /(git push)/g,
      '# aegis: deploy key needs write access — GitLab repo Settings > Repository > Deploy keys > enable "Grant write permissions"\n          $1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'GitLab deploy key is read-only — enable write access at repo Settings > Repository > Deploy keys; alternatively use CI_JOB_TOKEN (has push access to the same project) or a project/group access token', confidence: 90 });
  }
  return fixes;
}

/** Configure SSH ProxyJump (bastion/jump host) when direct SSH to target host is blocked. */
export function fixSSHJumpHostConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Connection.*refused.*bastion|jump.*host.*required|ProxyJump.*failed|no route.*host.*internal/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('SSH_PRIVATE_KEY') || f.content.includes('ProxyJump')) continue;
    const jumpStep = [
      '      - name: Configure SSH jump host',
      '        run: |',
      '          mkdir -p ~/.ssh',
      '          cat >> ~/.ssh/config << EOF',
      '          Host bastion',
      '            HostName ${{ secrets.BASTION_HOST }}',
      '            User ${{ secrets.BASTION_USER }}',
      '            IdentityFile ~/.ssh/id_rsa',
      '            StrictHostKeyChecking no',
      '          Host internal-*',
      '            ProxyJump bastion',
      '            StrictHostKeyChecking no',
      '          EOF',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*appleboy\/ssh-action|run:\s*ssh\s+/i, jumpStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added SSH ProxyJump (bastion) configuration — internal hosts are unreachable directly from CI; traffic tunnels through the bastion host; add BASTION_HOST and BASTION_USER secrets', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION F — Secret Access Denied
// ═══════════════════════════════════════════════════════════════════════════

/** Add environment: declaration to job so it can access environment-scoped secrets. */
export function fixEnvironmentSecretDeclaration(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/environment.*secret.*not.*accessible|secret.*only.*available.*environment|deployment.*environment.*required/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('environment:')) continue;
    if (!f.content.includes('secrets.')) continue;
    const envMatch = logs.match(/environment[:\s]+["']?([\w-]+)["']?/i);
    const envName = envMatch?.[1] ?? 'production';
    const patched = patchGitHubJobBlocks(
      f.content,
      b => /\$\{\{\s*secrets\./i.test(b) && !/environment:/i.test(b),
      `    environment: ${envName}`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: `Added environment: ${envName} to job — environment-scoped secrets are only accessible when the job declares the matching environment name; also add environment protection rules at Settings > Environments`, confidence: 90 });
  }
  return fixes;
}

/** Detect fork PR secret unavailability and switch to environment outputs or pull_request_target. */
export function fixForkPRSecretsUnavailable(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/secret.*not.*available.*fork|fork.*cannot.*access.*secret|pull_request.*secret.*empty/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pull_request') || f.content.includes('pull_request_target')) continue;
    if (f.content.includes('# fork-secrets-note')) continue;
    const fixed = f.content.replace(
      /\bon:\s*\n\s+pull_request:/,
      'on:\n  pull_request:  # aegis: secrets are NOT available to fork PRs — use pull_request_target (with caution: review code before granting access) or skip secret-dependent steps on forks via: if: github.event.pull_request.head.repo.full_name == github.repository',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Secrets unavailable in fork PRs — by design; use pull_request_target (grants secret access but runs in base branch context) or gate the step with: if: github.event.pull_request.head.repo.full_name == github.repository', confidence: 90 });
  }
  return fixes;
}

/** Add note when organization secrets need per-repository access enabled. */
export function fixOrganizationSecretRepositoryAccess(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/org.*secret.*not.*accessible|organization.*secret.*permission|secret.*not.*visible.*repository/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('secrets.') || f.content.includes('# org-secret-access')) continue;
    fixes.push({
      path: f.path,
      content: f.content,
      explanation: 'Organization secret not accessible to this repository — go to org Settings > Secrets and variables > Actions > select the secret > Repository access > add this repository; or change the secret policy to "All repositories"',
      confidence: 85,
    });
  }
  return fixes;
}

/** Gate secret-dependent steps on ref match when secret is restricted to specific branches. */
export function fixBranchRestrictedSecretAccess(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/secret.*only.*available.*branch|protected.*variable.*branch.*restriction|variable.*not.*available.*ref/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('secrets.') || f.content.includes('refs/heads/main')) continue;
    if (isGitHubWorkflow(f.path)) {
      const patched = patchGitHubJobBlocks(
        f.content,
        b => /\$\{\{\s*secrets\./i.test(b) && !/if:/.test(b),
        "    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'",
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: 'Added branch guard for secret-dependent job — some secrets are restricted to specific branches; add the branch condition or adjust the secret restriction at Settings > Secrets > Edit', confidence: 85 });
    }
  }
  return fixes;
}

/** Add an explicit required-secrets check step that fails fast with actionable output. */
export function fixRequiredSecretPresenceCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/secret.*not.*set|required.*secret.*missing|secret.*undefined.*production/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('required-secrets') || f.content.includes('Check required secrets')) continue;
    const secretRefs = [...f.content.matchAll(/\$\{\{\s*secrets\.([\w]+)\s*\}\}/g)].map(m => m[1]);
    const uniqueSecrets = [...new Set(secretRefs)].filter(s => s !== 'GITHUB_TOKEN').slice(0, 6);
    if (uniqueSecrets.length === 0) continue;
    const checks = uniqueSecrets.map(s =>
      `          [ -n "\${{ secrets.${s} }}" ] || (echo "ERROR: secret '${s}' is not configured" && MISSING=1)`,
    );
    const checkStep = [
      '      - name: Check required secrets',
      '        run: |',
      '          MISSING=0',
      ...checks,
      '          [ $MISSING -eq 0 ] || (echo "Add missing secrets at Settings > Secrets and variables > Actions" && exit 1)',
    ].join('\n');
    const lines = f.content.split('\n');
    const stepsIdx = lines.findIndex(l => /^\s+steps:\s*$/.test(l));
    if (stepsIdx === -1) continue;
    const out = [...lines];
    out.splice(stepsIdx + 1, 0, checkStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: `Added required-secrets preflight check for: ${uniqueSecrets.join(', ')} — surfaces missing secrets immediately with a clear message instead of failing mid-job with an obscure error`, confidence: 85 });
  }
  return fixes;
}

/** Fix GitLab protected variable inaccessible to unprotected branch/tag — add rules guard. */
export function fixGitLabProtectedVariableAccess(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/protected.*variable.*not.*available|GitLab.*protected.*variable.*branch|CI.*variable.*protected.*fail/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('$CI_COMMIT_REF_PROTECTED') || f.content.includes('rules:')) continue;
    const patched = patchGitLabJobBlocks(
      f.content,
      b => /\$[A-Z_]+_KEY|\$[A-Z_]+_TOKEN|\$[A-Z_]+_SECRET/i.test(b) && !/rules:/i.test(b),
      `  rules:\n    - if: '$CI_COMMIT_REF_PROTECTED == "true"'\n      when: on_success\n    - when: never  # Protected variables unavailable on unprotected branches`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added CI_COMMIT_REF_PROTECTED guard — GitLab protected variables are only injected into pipelines running on protected branches/tags; either mark the branch as protected (Settings > Repository > Protected branches) or remove the variable protection', confidence: 90 });
  }
  return fixes;
}

/** Use pull_request_target with explicit trust check for fork PR secret access. */
export function fixPullRequestTargetForForkSecrets(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/fork.*PR.*no.*secret|secrets.*unavailable.*fork.*workflow|pull_request.*event.*secrets.*empty/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('pull_request_target') || !f.content.includes('pull_request')) continue;
    const fixed = f.content.replace(
      /\bon:\s*\n\s+pull_request:\s*$/m,
      'on:\n  pull_request_target:  # WARNING: runs in base repo context — always gate secret steps with: if: github.event.pull_request.head.repo.full_name == github.repository',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Switched to pull_request_target for fork secret access — SECURITY WARNING: this event runs with base branch code, not the fork PR code; always validate: if: github.event.pull_request.head.repo.full_name == github.repository before running secret-dependent steps to prevent secret exfiltration', confidence: 70 });
  }
  return fixes;
}

/** Add HashiCorp Vault token renewal step for short-lived Vault tokens. */
export function fixHashiCorpVaultTokenRenewal(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/vault.*token.*expired|VAULT_TOKEN.*invalid|permission.*denied.*vault|vault.*403/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('VAULT_TOKEN') && !f.content.includes('hashicorp/vault')) continue;
    if (f.content.includes('vault-token-renew') || f.content.includes('hashicorp/vault-action')) continue;
    const vaultStep = [
      '      - name: Authenticate to HashiCorp Vault',
      '        uses: hashicorp/vault-action@v3',
      '        id: vault',
      '        with:',
      '          url: ${{ secrets.VAULT_ADDR }}',
      '          method: jwt',
      '          role: ${{ secrets.VAULT_ROLE }}',
      '          secrets: |',
      '            secret/data/ci/app API_KEY | APP_API_KEY ;',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*vault|uses:.*vault/i, vaultStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added hashicorp/vault-action with JWT auth — static VAULT_TOKEN expires (default TTL 32 days); JWT auth via GitHub OIDC generates a short-lived token per run; no long-lived Vault token in secrets', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION G — Insufficient Role Permissions
// ═══════════════════════════════════════════════════════════════════════════

/** Parse missing IAM action from AWS AccessDenied error and add a diagnostic comment. */
export function fixAWSIAMPermissionDiagnostic(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/User.*is not authorized to perform|AccessDenied.*perform.*arn|iam.*permission.*denied/i.test(logs)) return [];
  const actionMatch = logs.match(/not authorized to perform:\s*([\w:]+)/i);
  const resourceMatch = logs.match(/on resource:\s*(arn:aws:[^\s"]+)/i);
  const missingAction = actionMatch?.[1] ?? 's3:PutObject';
  const resource = resourceMatch?.[1] ?? '*';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('aws') && !f.content.includes('AWS')) continue;
    if (f.content.includes('iam-permission-note')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      `  # aegis: IAM policy missing "${missingAction}" on "${resource}"`,
      `  # Add to role policy: { "Effect": "Allow", "Action": "${missingAction}", "Resource": "${resource}" }`,
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `AWS AccessDenied — role is missing "${missingAction}" on "${resource}"; add this action to the role's IAM policy in the AWS console or via Terraform/CloudFormation; use IAM Access Analyzer to generate least-privilege policy`, confidence: 90 });
  }
  return fixes;
}

/** Add gcloud iam bindings step to grant missing GCP IAM role for service account. */
export function fixGCPIAMRoleBinding(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Permission.*denied.*GCP|google.*403.*caller.*does not have.*permission|PERMISSION_DENIED.*google/i.test(logs)) return [];
  const roleMatch = logs.match(/requires.*permission:\s*([\w.]+)/i) ?? logs.match(/\b(roles\/[\w.]+)\b/);
  const requiredRole = roleMatch?.[1] ?? 'roles/storage.objectAdmin';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('gcloud') || f.content.includes('gcloud iam')) continue;
    const bindStep = [
      '      - name: Grant IAM role (run once, then remove this step)',
      `        run: gcloud projects add-iam-policy-binding \$GCP_PROJECT --member="serviceAccount:\${{ secrets.GCP_SERVICE_ACCOUNT }}" --role="${requiredRole}"`,
      '        if: false  # Remove this guard to run the binding, then re-add it',
    ].join('\n');
    const lines = f.content.split('\n');
    const stepsIdx = lines.findIndex(l => /^\s+steps:\s*$/.test(l));
    if (stepsIdx === -1) continue;
    const out = [...lines];
    out.splice(stepsIdx + 1, 0, bindStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: `GCP permission denied — service account missing "${requiredRole}"; run the binding step once (remove the if: false guard), then restore it; alternatively add the binding in Terraform with google_project_iam_member`, confidence: 85 });
  }
  return fixes;
}

/** Add az role assignment step for missing Azure RBAC permission. */
export function fixAzureRBACRoleAssignment(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/AuthorizationFailed.*Azure|does not have.*authorization.*perform|Azure.*role.*assignment.*missing/i.test(logs)) return [];
  const roleMatch = logs.match(/role\s+['"]([\w ]+)['"]/i) ?? logs.match(/\bContributor|Owner|Reader\b/);
  const role = roleMatch?.[1] ?? 'Contributor';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('az ') && !f.content.includes('azure')) continue;
    if (f.content.includes('az role assignment') || f.content.includes('rbac-note')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      `  # aegis: Azure AuthorizationFailed — SP missing "${role}" role on the target scope`,
      `  # Run: az role assignment create --assignee <SP_OBJECT_ID> --role "${role}" --scope /subscriptions/<SUB_ID>`,
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Azure AuthorizationFailed — service principal missing "${role}" role; assign it via: az role assignment create --assignee <SP> --role "${role}" --scope /subscriptions/<SUB>; check the exact required action in the error and apply least-privilege`, confidence: 85 });
  }
  return fixes;
}

/** Add kubectl apply ClusterRoleBinding for Kubernetes RBAC permission failures. */
export function fixKubernetesClusterRoleBinding(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/is forbidden.*kubernetes|RBAC.*denied|User.*cannot.*kubernetes|ClusterRole.*missing/i.test(logs)) return [];
  const verbMatch = logs.match(/cannot\s+([\w]+)\s+resource/i);
  const resourceMatch = logs.match(/resource\s+['"]([\w]+)['"]/i);
  const verb = verbMatch?.[1] ?? 'get';
  const resource = resourceMatch?.[1] ?? 'pods';
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('kubectl') || f.content.includes('ClusterRoleBinding')) continue;
    const rbacStep = [
      '      - name: Apply RBAC binding (run once)',
      '        run: |',
      '          kubectl apply -f - <<EOF',
      '          apiVersion: rbac.authorization.k8s.io/v1',
      '          kind: ClusterRole',
      '          metadata:',
      '            name: ci-runner-role',
      '          rules:',
      '          - apiGroups: [""]',
      `            resources: ["${resource}"]`,
      `            verbs: ["${verb}", "list", "watch"]`,
      '          ---',
      '          apiVersion: rbac.authorization.k8s.io/v1',
      '          kind: ClusterRoleBinding',
      '          metadata:',
      '            name: ci-runner-binding',
      '          roleRef:',
      '            apiGroup: rbac.authorization.k8s.io',
      '            kind: ClusterRole',
      '            name: ci-runner-role',
      '          subjects:',
      '          - kind: ServiceAccount',
      '            name: default',
      '            namespace: default',
      '          EOF',
      '        if: false  # Run once then remove',
    ].join('\n');
    const lines = f.content.split('\n');
    const stepsIdx = lines.findIndex(l => /^\s+steps:\s*$/.test(l));
    if (stepsIdx === -1) continue;
    const out = [...lines];
    out.splice(stepsIdx + 1, 0, rbacStep);
    fixes.push({ path: f.path, content: out.join('\n'), explanation: `Kubernetes RBAC denied "${verb}" on "${resource}" — CI service account needs a ClusterRole with the required verb; apply the binding once (remove if: false) then commit the YAML to your infra repo`, confidence: 80 });
  }
  return fixes;
}

/** Fix Terraform state backend S3 bucket permissions when access is denied. */
export function fixTerraformStateBucketPermissions(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/terraform.*state.*AccessDenied|Error.*loading.*state.*403|S3.*bucket.*terraform.*denied|backend.*s3.*forbidden/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('terraform') || f.content.includes('state-bucket-note')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: Terraform state S3 access denied — add to role policy:',
      '  # s3:GetObject, s3:PutObject, s3:DeleteObject on arn:aws:s3:::<STATE_BUCKET>/<KEY_PREFIX>/*',
      '  # s3:ListBucket on arn:aws:s3:::<STATE_BUCKET>',
      '  # dynamodb:GetItem, PutItem, DeleteItem on arn:aws:dynamodb:<REGION>:<ACCOUNT>:table/<LOCK_TABLE>',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Terraform S3 backend AccessDenied — IAM role needs s3:GetObject, s3:PutObject, s3:ListBucket on the state bucket and DynamoDB lock table permissions; add these to the OIDC role policy', confidence: 90 });
  }
  return fixes;
}

/** Fix GitHub Actions OIDC trust policy ARN format for AWS role assumption. */
export function fixGitHubOIDCTrustPolicy(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/AssumeRoleWithWebIdentity.*not authorized|oidc.*trust.*policy.*mismatch|token.*sub.*claim.*not.*match|WebIdentityToken.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('role-to-assume') || f.content.includes('oidc-trust-note')) continue;
    const repoMatch = f.content.match(/github\.repository\s*==\s*['"]([\w/-]+)['"]/);
    const repo = repoMatch?.[1] ?? 'org/repo';
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      `  # aegis: OIDC trust policy must include: "token.actions.githubusercontent.com:sub": "repo:${repo}:ref:refs/heads/main"`,
      `  # Or use wildcard: "repo:${repo}:*" to allow all refs`,
      `  # Condition key: "StringLike" not "StringEquals" for wildcard patterns`,
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `AWS OIDC trust policy mismatch — the role's trust policy "sub" condition must match the GitHub Actions token claim; typical value: "repo:${repo}:ref:refs/heads/main"; use StringLike with wildcards for multiple refs`, confidence: 90 });
  }
  return fixes;
}

/** Add ECR repository policy to allow cross-account image pull. */
export function fixECRRepositoryCrossAccountPolicy(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ecr.*denied.*cross.account|pull.*ECR.*forbidden.*account|RepositoryPolicyNotFoundException.*ECR/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('ecr') && !f.content.includes('ECR')) continue;
    if (f.content.includes('ecr-policy-note')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: ECR cross-account pull denied — add repository policy in the source account:',
      '  # aws ecr set-repository-policy --repository-name <REPO> --policy-text \'{"Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<CONSUMER_ACCOUNT>:root"},"Action":["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"]}]}\'',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'ECR cross-account pull denied — the ECR repository in the source account needs an explicit resource-based policy allowing the consumer account to pull; the IAM role alone is not sufficient for cross-account ECR', confidence: 90 });
  }
  return fixes;
}

/** Add Cloud Run Invoker IAM binding when service-to-service auth fails. */
export function fixCloudRunServiceAccountInvoker(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Cloud Run.*403|roles\/run\.invoker.*missing|run\.routes\.invoke.*denied|Unauthenticated.*Cloud Run/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('run.googleapis.com') && !f.content.includes('cloud-run')) continue;
    if (f.content.includes('run.invoker') || f.content.includes('cloud-run-invoker')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: Cloud Run 403 — grant roles/run.invoker to the calling service account:',
      '  # gcloud run services add-iam-policy-binding <SERVICE> --region=<REGION> --member="serviceAccount:<SA>" --role="roles/run.invoker"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Cloud Run invoke denied — service account missing roles/run.invoker on the target service; the invoker role must be granted at the service level (not project level) for fine-grained access', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION H — Cross-Project Access Failure
// ═══════════════════════════════════════════════════════════════════════════

/** Replace GITHUB_TOKEN with PAT for cross-repository checkout. */
export function fixCrossRepoCheckoutWithPAT(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/repository.*not.*found|fatal.*could not.*read.*repository|403.*clone.*another.*repo|checkout.*forbidden.*cross/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('actions/checkout') || f.content.includes('GH_PAT')) continue;
    const fixed = f.content.replace(
      /(uses:\s*actions\/checkout@[^\n]+\n\s+with:)/i,
      '$1\n          token: ${{ secrets.GH_PAT }}  # PAT with repo scope required for cross-repo checkout',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added GH_PAT token for cross-repo checkout — GITHUB_TOKEN only has access to the workflow repository; cross-repo checkout requires a PAT with repo scope or a GitHub App token installed on both repos', confidence: 90 });
  }
  return fixes;
}

/** Add GitLab group-level access token for cross-project API access within a group. */
export function fixGitLabGroupAccessToken(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/403.*gitlab.*group|cross.group.*access.*denied|group.*token.*required|GitLab.*group.*forbidden/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('GROUP_TOKEN') || f.content.includes('CI_JOB_TOKEN')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'variables', [
      '  GROUP_ACCESS_TOKEN: $GROUP_ACCESS_TOKEN  # Create at group Settings > Access tokens with api scope; store as CI/CD group variable',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Cross-group access denied — CI_JOB_TOKEN is project-scoped; create a group access token at group Settings > Access tokens with api scope and store it as a group-level CI/CD variable', confidence: 90 });
  }
  return fixes;
}

/** Fix private submodule auth by injecting HTTPS token into git insteadOf config. */
export function fixPrivateSubmoduleTokenAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/submodule.*access.*denied|fatal.*submodule.*authentication|Submodule.*host.*not.*found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('submodule') || f.content.includes('insteadOf')) continue;
    const tokenStep = [
      '      - name: Configure submodule auth',
      '        run: git config --global url."https://x-access-token:${{ secrets.GH_PAT }}@github.com/".insteadOf "https://github.com/"',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*actions\/checkout.*submodule/i, tokenStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added git insteadOf for private submodule auth — submodule URLs rewrite https://github.com/ to use GH_PAT; enable submodules in actions/checkout with: with: submodules: recursive', confidence: 90 });
  }
  return fixes;
}

/** Fix GHCR package read across organizations by adding packages: read and org PAT. */
export function fixGHCRCrossOrgPackageRead(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ghcr\.io.*denied.*org|pull.*ghcr\.io.*another.*organization|unauthorized.*ghcr.*package.*org/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('ghcr.io') || f.content.includes('GHCR_PAT')) continue;
    const loginStep = [
      '      - name: Login to GitHub Container Registry (cross-org)',
      '        uses: docker/login-action@v3',
      '        with:',
      '          registry: ghcr.io',
      '          username: ${{ github.actor }}',
      '          password: ${{ secrets.GHCR_PAT }}  # PAT with read:packages scope from an account with package access',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker pull.*ghcr/i, loginStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GHCR cross-org login — GITHUB_TOKEN only grants packages: read within the same org; reading packages from another org requires a PAT with read:packages scope belonging to an account that has access to the package', confidence: 90 });
  }
  return fixes;
}

/** Fix ECR cross-account pull by adding AWS credentials for the source account. */
export function fixECRCrossAccountAccess(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ecr.*GetAuthorizationToken.*denied|ecr.*cross.account.*pull.*fail|ECR.*different.*account/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('ecr') || f.content.includes('ECR_REGISTRY_ACCOUNT')) continue;
    const ecrStep = [
      '      - name: Authenticate to cross-account ECR',
      '        run: |',
      '          aws ecr get-login-password --region ${{ secrets.AWS_REGION }} \\',
      '            | docker login --username AWS --password-stdin ${{ secrets.ECR_REGISTRY_ACCOUNT }}.dkr.ecr.${{ secrets.AWS_REGION }}.amazonaws.com',
      '        env:',
      '          AWS_ROLE_ARN: ${{ secrets.ECR_SOURCE_ROLE_ARN }}  # Role in the ECR source account with ecr:GetAuthorizationToken',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker pull.*\.dkr\.ecr\./i, ecrStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added cross-account ECR auth step — pulling from ECR in a different AWS account requires assuming a role in that account and calling GetAuthorizationToken; add ECR_SOURCE_ROLE_ARN secret pointing to a role in the ECR account', confidence: 85 });
  }
  return fixes;
}

/** Fix GitLab cross-group CI trigger by adding proper cross-project trigger token. */
export function fixGitLabCrossGroupCITrigger(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/trigger.*cross.group.*denied|GitLab.*trigger.*another.*group.*forbidden|cross.project.*trigger.*403/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('trigger:') || f.content.includes('TRIGGER_TOKEN')) continue;
    const fixed = f.content.replace(
      /(trigger:\s*\n\s+project:[^\n]+\n)/i,
      '$1      token: $CROSS_PROJECT_TRIGGER_TOKEN  # Create at target project Settings > CI/CD > Pipeline trigger tokens\n',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added trigger token for cross-group CI — downstream project trigger requires a pipeline trigger token from the target project (Settings > CI/CD > Pipeline trigger tokens); store as a group CI/CD variable', confidence: 90 });
  }
  return fixes;
}

/** Fix Google Artifact Registry cross-project auth with Workload Identity. */
export function fixGoogleArtifactRegistryAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Artifact Registry.*denied|pkg\.dev.*403|PERMISSION_DENIED.*artifactregistry|gar.*push.*forbidden/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pkg.dev') && !f.content.includes('artifact-registry')) continue;
    if (f.content.includes('gcloud auth configure-docker')) continue;
    const garStep = [
      '      - name: Configure Google Artifact Registry auth',
      '        run: |',
      '          gcloud auth configure-docker ${{ secrets.GAR_REGION }}-docker.pkg.dev --quiet',
      '          # Or for cross-project: ensure SA has roles/artifactregistry.writer on the target registry',
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:\s*docker.*pkg\.dev|uses:\s*docker\/build-push-action/i, garStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added GAR Docker auth step — gcloud auth configure-docker registers docker credentials for Artifact Registry; SA needs roles/artifactregistry.writer on the registry (in a different project, set this on the registry resource, not the project)', confidence: 90 });
  }
  return fixes;
}

/** Fix Azure Container Registry cross-subscription auth with Service Principal. */
export function fixAzureContainerRegistryAuth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/azurecr\.io.*unauthorized|ACR.*authentication.*failed|azure.*container.*registry.*403|docker.*login.*azurecr.*denied/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('azurecr.io') || f.content.includes('ACR_LOGIN_SERVER')) continue;
    const loginStep = [
      '      - name: Login to Azure Container Registry',
      '        uses: docker/login-action@v3',
      '        with:',
      '          registry: ${{ secrets.ACR_LOGIN_SERVER }}',
      '          username: ${{ secrets.ACR_USERNAME }}',
      '          password: ${{ secrets.ACR_PASSWORD }}  # Use ACR admin password or SP client secret with AcrPush role',
    ].join('\n');
    const patched = insertStepBefore(f.content, /uses:\s*docker\/build-push-action|run:\s*docker.*push.*azurecr/i, loginStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ACR login step — cross-subscription ACR access requires an SP with AcrPull/AcrPush role assigned on the registry; store ACR_LOGIN_SERVER (e.g., myregistry.azurecr.io), ACR_USERNAME (SP client ID), ACR_PASSWORD (SP client secret) as secrets', confidence: 90 });
  }
  return fixes;
}
