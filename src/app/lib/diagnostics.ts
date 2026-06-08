// Classify CI/CD failures from raw log text and failed step names.
// Results drive contextBuilder (which extra files to fetch) and the AI prompt
// (category-specific fix instructions).
//
// ORDERING IS CRITICAL — patterns are checked top-to-bottom; the most specific
// categories must come first so broad patterns never shadow them.
//
// Categories are organised into three tiers that mirror the fixer modules:
//   Simple       → syntax, env vars, dependencies, build
//   Intermediate → git, pipeline, config, runtime, testing
//   Advanced     → auth, docker, deployment, API, database

export type ErrorCategory =
  // ── Simple ──────────────────────────────────────────────────────────────────
  | 'docker_auth'            // Docker Hub login — credentials not configured
  | 'docker_build'           // Dockerfile / image build failure (not auth)
  | 'permissions_error'      // Resource not accessible / 403 / missing token scopes
  | 'oidc_failure'           // OIDC/Federated auth for AWS, GCP, Azure
  | 'permission_denied'      // Shell script not executable, EACCES
  | 'missing_file'           // Referenced file doesn't exist
  | 'actions_deprecation'    // Node.js 20 runtime deprecated; action versions stale
  | 'job_timeout'            // Job exceeded runner time limit
  | 'lint_failure'           // ESLint / TypeScript / Prettier errors
  | 'test_failure'           // Jest / vitest / mocha / pytest failures
  | 'missing_dependency'     // npm/yarn ENOENT, Cannot find module
  | 'node_version'           // Node.js version resolution failure
  | 'env_missing'            // Secret / env var not set
  | 'python_deps'            // pip / requirements.txt failures
  | 'yaml_syntax'            // YAML parse error in workflow file
  | 'build_failure'          // Build command exited non-zero
  | 'concurrency_issue'      // Run cancelled by concurrency group
  | 'memory_error'           // OOM, heap overflow, segfault
  // ── Intermediate ────────────────────────────────────────────────────────────
  | 'git_merge_conflict'     // Merge conflict markers in committed files
  | 'git_push_rejected'      // Push rejected (protected branch, non-fast-forward)
  | 'git_submodule_error'    // Submodule init / update failure
  | 'git_lfs_error'          // Git LFS smudge filter failure
  | 'artifact_failure'       // Artifact upload / download failure
  | 'cache_failure'          // Cache restore / save failure
  | 'coverage_failure'       // Coverage threshold not met
  | 'snapshot_mismatch'      // Jest / Vitest snapshot mismatch
  | 'runner_unavailable'     // Runner offline or label not found
  // ── Advanced ────────────────────────────────────────────────────────────────
  | 'invalid_token'          // Expired / invalid API token (401)
  | 'ssh_key_error'          // SSH key authentication failure
  | 'docker_rate_limit'      // Docker Hub pull rate limit (429)
  | 'container_health_failure' // Container health check fails
  | 'deploy_failure'         // Production deployment failure
  | 'api_rate_limit'         // API rate limiting (429)
  | 'api_timeout'            // API / network timeout (ETIMEDOUT)
  | 'webhook_failure'        // Webhook delivery / signature failure
  | 'db_migration_error'     // Database migration failure
  | 'db_connection_error'    // Database connection failure (ECONNREFUSED)
  | 'db_deadlock'            // Database deadlock detected
  | 'db_query_failure'       // Query execution failure / timeout / syntax error
  | 'db_replication_lag'     // Read replica replication lag
  | 'db_schema_mismatch'     // Database schema out of sync with models
  | 'missing_db_index'       // Missing database index causing slow queries
  | 'transaction_rollback'   // Database transaction rolled back
  | 'rest_endpoint_mismatch' // REST endpoint URL / method mismatch
  // ── New granular categories ─────────────────────────────────────────────
  | 'compilation_failure'    // TypeScript / Python / Java compilation error
  | 'lockfile_corrupt'       // npm/yarn lockfile integrity failure
  | 'venv_missing'           // Python virtual environment not activated
  | 'invalid_branch'         // Branch reference not found / invalid ref
  | 'circular_dependency'    // Circular job dependency in pipeline
  | 'port_conflict'          // Port already bound / EADDRINUSE
  | 'image_pull_failure'     // Docker image pull denied / not found
  | 'service_unavailable'    // Upstream service 503 / 502 before deploy
  | 'load_balancer_issue'    // ALB/ELB/nginx health check failing
  | 'invalid_api_response'   // API returns unexpected HTTP status
  | 'third_party_failure'    // External integration outage (Snyk, Datadog…)
  | 'schema_validation'      // JSON/OpenAPI schema validation error
  | 'graphql_failure'        // GraphQL query / introspection error
  // ── New problem types ────────────────────────────────────────────────────
  | 'husky_hook_failure'     // Husky pre-commit/pre-push hooks failing in CI
  | 'go_build_failure'       // Go module download / build failure
  | 'rust_build_failure'     // Rust/Cargo compilation or dependency failure
  | 'dotnet_build_failure'   // .NET restore / build / publish failure
  | 'e2e_failure'            // End-to-end (Playwright / Cypress) test failure
  | 'lint_format_failure'    // Prettier / ESLint format check failure
  | 'git_tag_failure'        // git tag / git describe / semantic-release failure
  | 'git_credential_failure' // git clone / fetch / push auth failure
  | 'aws_auth_failure'       // AWS credential / IAM role assumption failure
  | 'gcp_auth_failure'       // GCP service account / workload identity failure
  | 'secret_missing'         // Required secret not configured in repo/org
  | 'terraform_failure'      // Terraform init / plan / apply failure
  | 'matrix_failure'         // Matrix strategy job failure
  | 'artifact_retention'     // Artifact storage / retention issue
  | 'vite_build_failure'     // Vite build failure (chunk size, env mode, etc.)
  | 'webpack_build_failure'  // Webpack OOM / config / bundle failure
  // ── Docker extended ──────────────────────────────────────────────────────
  | 'missing_docker_layer'    // Docker build layer missing from cache
  | 'dockerfile_syntax'       // Dockerfile instruction / syntax error
  | 'container_startup'       // Container failed to start or pass health check
  | 'registry_auth_failure'   // Registry push/pull authentication failure
  | 'volume_mount_failure'    // Docker volume mount failure
  // ── Auth extended ────────────────────────────────────────────────────────
  | 'oauth_failure'           // OAuth token invalid, expired, or exchange failed
  | 'secret_access_denied'    // Vault / secret manager access denied
  | 'insufficient_role'       // IAM / RBAC role lacks required permissions
  | 'cross_project_access'    // Cross-project or cross-org resource access denied
  // ── Build tools ──────────────────────────────────────────────────────────
  | 'gradle_build_failure'    // Gradle build or dependency resolution failure
  | 'maven_build_failure'     // Maven build or dependency resolution failure
  | 'artifact_missing'        // Required artifact not found for download
  // ── Runtime errors ───────────────────────────────────────────────────────
  | 'runtime_version_error'   // Node/Python/Java runtime version mismatch
  | 'null_reference'          // Null pointer / undefined reference exception
  | 'type_mismatch'           // Type cast or type assertion error
  | 'infinite_loop'           // Process hung or infinite loop detected
  | 'stack_overflow'          // Stack overflow / recursion limit exceeded
  | 'segfault'                // Segmentation fault / SIGSEGV
  | 'unhandled_exception'     // Unhandled exception / panic / fatal error
  // ── Test extended ────────────────────────────────────────────────────────
  | 'mock_failure'            // Test mock or stub setup failure
  // ── Pipeline orchestration ───────────────────────────────────────────────
  | 'pipeline_stage_failure'  // Pipeline stage orchestration failure
  | 'stage_order_error'       // Job stage dependency ordering error
  | 'invalid_trigger'         // Invalid pipeline trigger or event filter
  | 'artifact_upload_failure' // Artifact / report upload step failed
  | 'cache_restore_failure'   // Cache restore step failed
  | 'parallel_sync_issue'     // Parallel job synchronization failure
  // ── Git extended ─────────────────────────────────────────────────────────
  | 'git_detached_head'       // Git detached HEAD state during CI
  | 'git_commit_rejected'     // Commit rejected by hook or branch policy
  | 'git_access_denied'       // Git repository access denied
  | 'git_invalid_branch'      // Invalid or protected branch reference
  // ── Deployment extended ──────────────────────────────────────────────────
  | 'rollback_failure'        // Deployment rollback failed
  | 'failed_production_deploy'// Production deployment permanently failed
  | 'blue_green_conflict'     // Blue-green traffic switch conflict
  | 'canary_mismatch'         // Canary deployment version mismatch
  | 'health_check_failure'    // Service or container health check failure
  // ── Config errors ────────────────────────────────────────────────────────
  | 'invalid_gitlab_ci'       // Invalid .gitlab-ci.yml structure or syntax
  | 'invalid_workflow_syntax' // Invalid GitHub Actions workflow structure
  | 'missing_config_file'     // Required config file not found
  | 'config_hierarchy_error'  // Config inheritance or hierarchy error
  | 'unsupported_config_param'// Unsupported or unknown config parameter
  | 'duplicate_config_key'    // Duplicate key in config file
  | 'env_mapping_error'       // Environment variable mapping or injection error
  | 'unknown';

export interface ErrorDiagnosis {
  category: ErrorCategory;
  description: string;
  relevantFiles: string[];
  instructions: string;
}

const INSTRUCTIONS: Record<ErrorCategory, string> = {
  docker_auth:
    'The Docker registry login failed. Two-phase fix required:\n' +
    '1. If the job has NO event guard: add `if: github.event_name == \'push\' && github.ref == \'refs/heads/main\'`.\n' +
    '2. If the event guard ALREADY EXISTS but still fails (secrets not configured): add `continue-on-error: true` to the docker job AND any deploy job that depends on it.\n' +
    '3. If ./Dockerfile is referenced but does not exist, create a minimal one.\n' +
    'Do NOT hardcode credentials anywhere.',

  docker_build:
    'Examine the Dockerfile for invalid FROM images, wrong COPY sources, or failing RUN commands. ' +
    'Check .dockerignore does not exclude required files. ' +
    'If the Dockerfile does not exist, create a minimal one for the detected stack (Node.js / Python). ' +
    'Pin base image versions (node:20-alpine, python:3.12-slim) instead of :latest.',

  permissions_error:
    'Add a `permissions:` block at the workflow or job level with required scopes: ' +
    '`contents: write` (push/commit), `pull-requests: write` (create/comment PR), ' +
    '`packages: write` (ghcr.io push), `id-token: write` (OIDC). ' +
    'Example: add before `jobs:`: `permissions:\\n  contents: write\\n  pull-requests: write`',

  oidc_failure:
    'Add `permissions: id-token: write` at the workflow level — OIDC federation (AWS/GCP/Azure) requires this. ' +
    'Also verify the cloud provider trust policy allows the correct repo/branch combination.',

  permission_denied:
    'Add `chmod +x <script>` immediately before the failing step. ' +
    'Shell scripts committed without the executable bit always fail on fresh runners.',

  missing_file:
    'A file referenced in the workflow does not exist. Create it with minimal valid content: ' +
    'Dockerfile: use FROM node:20-alpine or FROM python:3.12-slim. ' +
    'Shell scripts: create with a basic shebang. ' +
    'Config files: create with sensible defaults.',

  actions_deprecation:
    'Upgrade deprecated actions to Node.js 24-compatible versions: ' +
    'checkout@v3→@v4, setup-node@v3→@v4, upload-artifact@v3→@v4, cache@v3→@v4. ' +
    'Also add `env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` at workflow level (GitHub forces this June 2026).',

  job_timeout:
    'Add `timeout-minutes: 30` at the job level to catch runaway builds faster. ' +
    'Investigate which step is hanging — common causes: network fetches without retries, interactive prompts, infinite polling.',

  lint_failure:
    'Fix the ESLint/TypeScript issue in the relevant config. ' +
    'If ESLint is not installed: use `npx eslint` instead of `eslint`. ' +
    'If config is missing: create .eslintrc.json with `{"env":{"node":true,"es2021":true},"extends":"eslint:recommended"}`.',

  test_failure:
    'Check the test runner config (jest.config.*, vitest.config.*) and test script in package.json. ' +
    'Look for missing test environment variables or service containers (database, Redis). ' +
    'If no tests exist, create a minimal passing test. ' +
    'Add --passWithNoTests to prevent failures when tests directory is empty.',

  missing_dependency:
    'Ensure `npm install` runs in the same job BEFORE the failing command. ' +
    'Check package.json for the missing package. ' +
    'For peer dep conflicts: add --legacy-peer-deps. ' +
    'For pnpm: add pnpm/action-setup@v4 before the checkout step.',

  node_version:
    'Pin node-version to a supported LTS version (18 or 20) in the workflow. ' +
    'Add/update .nvmrc with the same version. ' +
    'Check the "engines" field in package.json for constraints.',

  env_missing:
    'Add the missing variable to the workflow env block using `${{ secrets.NAME }}` for secrets. ' +
    'For non-sensitive defaults, hardcode a safe fallback value in the env block. ' +
    'Create .env.example with placeholder values for documentation.',

  python_deps:
    'Update requirements.txt with correct package versions. ' +
    'Add --no-cache-dir --upgrade to pip install. ' +
    'Upgrade pip itself before installing: `pip install --upgrade pip`. ' +
    'Ensure python-version in the workflow matches the project.',

  yaml_syntax:
    'Fix YAML indentation (2 spaces, never tabs). ' +
    'Verify top-level keys (on:, jobs:) are present. ' +
    'Every step must have either `uses:` or `run:`, not both. ' +
    'Check for duplicate top-level keys.',

  build_failure:
    'Check the build script in package.json — it may be missing or broken. ' +
    'Ensure all build dependencies are installed before the build step. ' +
    'For OOM: add NODE_OPTIONS=--max-old-space-size=4096. ' +
    'If dist/ is missing: add mkdir -p dist before npm run build.',

  concurrency_issue:
    'Add a `concurrency:` group at the workflow level: ' +
    '`concurrency:\\n  group: ${{ github.workflow }}-${{ github.ref }}\\n  cancel-in-progress: false`. ' +
    'Use cancel-in-progress: true only for CI (not deploy) workflows.',

  memory_error:
    'For Node.js: add NODE_OPTIONS=--max-old-space-size=4096 to the workflow env. ' +
    'For stack overflow: add NODE_OPTIONS=--stack-size=65536. ' +
    'For Linux ENOMEM: add MALLOC_ARENA_MAX=2. ' +
    'For Python recursion: add sys.setrecursionlimit(10000) before the failing script.',

  git_merge_conflict:
    'Merge conflict markers were found in committed files. ' +
    'Remove all <<<<<<< / ======= / >>>>>>> lines. ' +
    'Keep the correct version of the code from either HEAD or the incoming branch. ' +
    'Re-commit the resolved file.',

  git_push_rejected:
    'Push to protected branch was rejected. ' +
    'Use GITHUB_TOKEN remote URL: `git remote set-url origin https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/${{ github.repository }}`. ' +
    'Add write permissions to the workflow: `permissions: contents: write`. ' +
    'Configure git identity before committing: `git config user.email` and `git config user.name`.',

  git_submodule_error:
    'Add `submodules: recursive` to the actions/checkout step: ' +
    '`with:\\n  submodules: recursive`. ' +
    'For private submodules: add `token: ${{ secrets.GITHUB_TOKEN }}`.',

  git_lfs_error:
    'Add `lfs: true` to the actions/checkout step: ' +
    '`with:\\n  lfs: true`. ' +
    'Ensure git-lfs is installed on the runner (ubuntu-latest includes it). ' +
    'Run `git lfs pull` after checkout if files are not hydrated.',

  artifact_failure:
    'Check that the upload-artifact `path:` matches the actual build output directory. ' +
    'Ensure the build step runs before the upload step. ' +
    'Change `if-no-files-found: error` to `warn` to avoid blocking CI when dist/ is empty. ' +
    'Verify download-artifact `name:` matches what upload-artifact `name:` used.',

  cache_failure:
    'Simplify the cache `key:` — overly specific keys (including branch/matrix variables) never hit. ' +
    'Use format: `${{ runner.os }}-deps-${{ hashFiles("**/package-lock.json") }}`. ' +
    'Add `restore-keys:` fallback for partial cache hits.',

  coverage_failure:
    'Lower the coverage threshold by 10% in jest.config — current coverage does not meet the minimum. ' +
    'Increase test coverage incrementally rather than failing the build. ' +
    'Alternatively set the threshold to 0 while tests are being written.',

  snapshot_mismatch:
    'Add `--ci` flag to the Jest command to prevent snapshot creation in CI. ' +
    'To update snapshots: run `jest --updateSnapshot` locally and commit the updated .snap files. ' +
    'Outdated snapshots should be reviewed and updated intentionally, not auto-generated in CI.',

  runner_unavailable:
    'Check the `runs-on:` label — self-hosted runner may be offline. ' +
    'Fall back to GitHub-hosted runners (ubuntu-latest, windows-latest, macos-latest). ' +
    'For matrix jobs: add `timeout-minutes` to prevent runner exhaustion.',

  invalid_token:
    'The API token has expired or been revoked (401). ' +
    'Rotate the secret via repository Settings → Secrets and variables. ' +
    'Add `continue-on-error: true` to the affected job until the token is rotated. ' +
    'For GITHUB_TOKEN: check the permissions block and token expiry.',

  ssh_key_error:
    'SSH host key verification failed. ' +
    'Add ssh-keyscan before SSH operations: `ssh-keyscan -H ${{ secrets.PROD_HOST }} >> ~/.ssh/known_hosts`. ' +
    'Create `~/.ssh` directory with `mkdir -p ~/.ssh && chmod 700 ~/.ssh`. ' +
    'Ensure PROD_SSH_KEY secret is a valid private key.',

  docker_rate_limit:
    'Docker Hub pull rate limit (429). ' +
    'Add a docker/login-action step to authenticate — authenticated users get higher limits. ' +
    'Use `continue-on-error: true` on the login step in case DOCKER_USERNAME is not configured. ' +
    'Consider mirroring images to ghcr.io to avoid Docker Hub rate limits.',

  container_health_failure:
    'Container health check failed. ' +
    'Add a HEALTHCHECK instruction to the Dockerfile. ' +
    'Add `--health-cmd`, `--health-interval`, `--health-retries` options to the service definition. ' +
    'Add a wait loop before the step that requires the service to be ready.',

  deploy_failure:
    'Deployment failed. ' +
    'Add `continue-on-error: true` to prevent deploy failures from blocking CI. ' +
    'Add a rollback step with `if: failure()`. ' +
    'Add health check verification before switching traffic. ' +
    'For Kubernetes: add `kubectl rollout status --timeout=120s` after apply.',

  api_rate_limit:
    'API rate limit exceeded (429). ' +
    'Add sleep between API calls: `sleep 2` before each request. ' +
    'Add retry with exponential backoff using nick-fields/retry@v3. ' +
    'Add `per_page=100` to paginated GitHub API calls to reduce request count.',

  api_timeout:
    'API call timed out (ETIMEDOUT/ECONNRESET). ' +
    'Add `continue-on-error: true` to network-dependent steps. ' +
    'Add retry logic with nick-fields/retry@v3. ' +
    'Check if the target service is accessible from GitHub-hosted runners (some internal services are not).',

  webhook_failure:
    'Webhook delivery failed. ' +
    'Verify WEBHOOK_SECRET matches what is configured on the webhook provider. ' +
    'Check that the endpoint is publicly accessible from the internet. ' +
    'Add X-Hub-Signature-256 HMAC verification to the receiving endpoint.',

  db_migration_error:
    'Database migration failed. ' +
    'Add a database readiness check before migrations: poll `nc -z localhost 5432` until it responds. ' +
    'For lock timeout: add lock timeout flags to the migration command. ' +
    'For Prisma: ensure SHADOW_DATABASE_URL is configured. ' +
    'Wrap migration in a transaction with rollback on failure.',

  db_connection_error:
    'Database connection refused. ' +
    'Add a services: block to the workflow for the required database (postgres, mysql, redis). ' +
    'Add health check options to the service: `--health-cmd pg_isready --health-interval 10s`. ' +
    'Add a wait loop before running tests: poll `nc -z localhost 5432` up to 30 times.',

  db_deadlock:
    'Database deadlock detected. ' +
    'Add retry logic around the deadlocking query (ER_LOCK_DEADLOCK / deadlock detected). ' +
    'Use SELECT ... FOR UPDATE SKIP LOCKED for queue-style operations. ' +
    'Keep transactions short and acquire locks in a consistent order.',

  db_query_failure:
    'Query execution failed. Check the SQL syntax and parameter types. ' +
    'Add PGOPTIONS="-c statement_timeout=30000" to cap runaway queries at 30 seconds. ' +
    'Enable query logging: DEBUG=prisma:query,sequelize:*. ' +
    'For ORM query errors: check model definitions and migrations are in sync.',

  db_replication_lag:
    'Replication lag causing stale reads. ' +
    'Route write-then-read operations to the primary: use DATABASE_URL for writes, DATABASE_REPLICA_URL for reads. ' +
    'Add a sleep or retry after writes if your ORM does not route automatically. ' +
    'Consider using pg_sleep() + retry logic for critical read-after-write paths.',

  compilation_failure:
    'Compilation failed. For TypeScript: add skipLibCheck: true and esModuleInterop: true to tsconfig.json. ' +
    'Run tsc --noEmit to surface all type errors. ' +
    'For Python: check indentation, syntax with python -m py_compile. ' +
    'For Java/Kotlin: verify the JDK version matches the build tool configuration.',

  lockfile_corrupt:
    'Package lockfile is corrupted (EINTEGRITY / checksum mismatch). ' +
    'Delete package-lock.json and regenerate: rm package-lock.json && npm install. ' +
    'In CI: use npm install --prefer-offline with a fallback deletion. ' +
    'Commit the regenerated lockfile and ensure .gitignore does not exclude it.',

  venv_missing:
    'Python virtual environment not activated. ' +
    'Create and activate a venv: python -m venv .venv && source .venv/bin/activate. ' +
    'Add ${{ github.workspace }}/.venv/bin to $GITHUB_PATH so subsequent steps use it. ' +
    'Upgrade pip inside the venv: pip install --upgrade pip.',

  invalid_branch:
    'Branch reference is invalid or does not exist. ' +
    'Replace hardcoded branch names with dynamic refs: ${{ github.ref_name }}. ' +
    'Default to main if the branch is optional: ${{ github.ref_name || \'main\' }}. ' +
    'Check the branch was created before the workflow references it.',

  circular_dependency:
    'Circular job dependency in pipeline needs: graph. ' +
    'Remove the cycle: at least one job in the cycle must not depend on the others. ' +
    'Draw a DAG of your needs: relationships and verify there are no loops. ' +
    'Use outputs to pass data between jobs without circular dependency.',

  port_conflict:
    'Port already in use (EADDRINUSE). ' +
    'Remap the host port: change "3000:3000" to "3001:3000" in service container or docker-compose. ' +
    'Add lsof -i :PORT || true before starting the service to detect conflicts early. ' +
    'Use dynamic port assignment if the exact port is not required.',

  image_pull_failure:
    'Docker image pull failed (unauthorized / manifest unknown). ' +
    'Add docker/login-action before build-push-action to authenticate to Docker Hub. ' +
    'Verify the image tag exists: docker pull <image>:<tag> locally. ' +
    'For private registries: ensure DOCKER_USERNAME and DOCKER_PASSWORD secrets are configured. ' +
    'Consider mirroring images to GHCR (ghcr.io) to avoid Docker Hub rate limits.',

  service_unavailable:
    'Upstream service returned 503 Service Unavailable. ' +
    'Add a pre-deploy availability check: curl -f http://service/health with retry loop. ' +
    'Wait for the previous deployment to finish before starting the next. ' +
    'Add a sleep + retry loop polling /health until HTTP 200 before switching traffic.',

  load_balancer_issue:
    'Load balancer health check failing. ' +
    'Ensure the app exposes GET /health returning HTTP 200. ' +
    'Add a 30-second sleep after deployment for the LB to register new instances. ' +
    'Check that the security group allows the LB health check probe IP range. ' +
    'Verify the health check path, port, and protocol match the LB target group config.',

  invalid_api_response:
    'API returned an unexpected error response. ' +
    'Add --fail-with-body to curl commands to exit non-zero on 4xx/5xx. ' +
    'Log the full response body for debugging: curl -v or jq . on the response. ' +
    'Check the API endpoint is correct and the authentication token is valid.',

  third_party_failure:
    'Third-party integration is unavailable. ' +
    'Add continue-on-error: true to third-party integration jobs — external outages should not block CI. ' +
    'Add status checks before the integration step: curl the third-party status page. ' +
    'Consider skipping non-critical integrations on PR runs.',

  schema_validation:
    'JSON/OpenAPI schema validation failed. ' +
    'Use ajv or Spectral to lint the schema offline before CI. ' +
    'Add continue-on-error: true to schema validation steps until the schema is stabilised. ' +
    'Validate request/response payloads against the published contract.',

  graphql_failure:
    'GraphQL query or introspection failed. ' +
    'Verify the query against the current schema: send {"query":"{ __typename }"} to confirm the endpoint is live. ' +
    'Check field names — GraphQL is case-sensitive. ' +
    'Use a persisted query or code-gen from the schema to prevent field mismatches.',

  husky_hook_failure:
    'Husky pre-commit/pre-push hooks are failing in CI. ' +
    'Add HUSKY=0 to the CI environment to skip hooks: `env: HUSKY: 0` at workflow level. ' +
    'Hooks are designed for local development and should not run in CI where there is no interactive terminal. ' +
    'Also add GIT_HOOKS=0 as a fallback for other hook managers.',

  go_build_failure:
    'Go build/test failed. ' +
    'Add `go mod download && go mod verify` before build/test commands. ' +
    'Set GOPATH and GOMODCACHE in workflow env for caching. ' +
    'For CGO failures: install system dependencies (gcc, libc-dev) via apt-get first. ' +
    'Use actions/setup-go@v5 and enable module caching.',

  rust_build_failure:
    'Rust/Cargo build failed. ' +
    'Add Swatinem/rust-cache@v2 to cache target/ and ~/.cargo/registry across runs. ' +
    'For linker errors: install system dependencies (libssl-dev, pkg-config, build-essential). ' +
    'Pin Rust toolchain version in rust-toolchain.toml for reproducible builds.',

  dotnet_build_failure:
    '.NET build failed. ' +
    'Add `dotnet restore --locked-mode` before `dotnet build` or `dotnet test`. ' +
    'Use actions/setup-dotnet@v4 to install the correct SDK version. ' +
    'Set DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 and NUGET_PACKAGES to cache packages.',

  e2e_failure:
    'End-to-end tests failed. ' +
    'For Playwright: run `npx playwright install --with-deps` before tests; use xvfb-run for headless. ' +
    'For Cypress: install system dependencies (libgtk2.0-0, libnotify-dev, libnss3). ' +
    'Add screenshots/videos as artifacts for debugging. ' +
    'Set BASE_URL env var pointing to the running dev server. ' +
    'Start the app server in the background before running E2E tests.',

  lint_format_failure:
    'Code formatting/lint check failed. ' +
    'For Prettier: create .prettierrc with project standards and run `prettier --write` locally to fix. ' +
    'For ESLint v9: create eslint.config.js (flat config); old .eslintrc is not supported. ' +
    'Run `npx eslint --fix` locally to auto-fix fixable issues. ' +
    'Add a pre-commit hook to enforce formatting before committing.',

  git_tag_failure:
    'Git tag operation failed. ' +
    'Add fetch-depth: 0 + fetch-tags: true to actions/checkout to fetch all history and tags. ' +
    'For GPG signing: use git tag --no-sign in CI; CI platforms sign releases via their own mechanisms. ' +
    'For semantic-release: ensure GITHUB_TOKEN has contents: write permission.',

  git_credential_failure:
    'Git authentication failed during clone/fetch/push. ' +
    'Configure git credential store with GITHUB_TOKEN: ' +
    '`git config credential.helper store && echo "https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com" > ~/.git-credentials`. ' +
    'Add `git config url."https://github.com/".insteadOf "git@github.com:"` to convert SSH URLs to HTTPS.',

  aws_auth_failure:
    'AWS credential/role assumption failed. ' +
    'Use configure-aws-credentials action with OIDC (id-token: write permission required). ' +
    'Verify the IAM role trust policy allows the GitHub Actions OIDC provider. ' +
    'Check the role ARN and AWS region are correct in the workflow.',

  gcp_auth_failure:
    'GCP authentication failed. ' +
    'Use google-github-actions/auth with workload identity federation (id-token: write required). ' +
    'Create a workload identity pool and provider in GCP IAM. ' +
    'Grant the service account the necessary IAM roles.',

  secret_missing:
    'Required secret is not configured. ' +
    'Go to repository Settings → Secrets and variables → Actions and add the missing secret. ' +
    'For organization secrets: check the secret is accessible to this repository. ' +
    'Add continue-on-error: true to the affected step until the secret is configured.',

  terraform_failure:
    'Terraform command failed. ' +
    'Add TF_IN_AUTOMATION=true to disable prompts. ' +
    'Add TF_INPUT=false to prevent interactive input. ' +
    'For backend auth: ensure cloud credentials are configured before terraform init. ' +
    'Use terraform init -reconfigure if backend config has changed.',

  matrix_failure:
    'Matrix strategy job failed. ' +
    'Add fail-fast: false to get results from ALL matrix combinations, not just the first failure. ' +
    'Add timeout-minutes to prevent one slow matrix job from blocking all others. ' +
    'Use matrix.include to add specific combinations and matrix.exclude to skip known failures.',

  artifact_retention:
    'Artifact storage issue. ' +
    'Add retention-days: 7 to upload-artifact to reduce storage costs. ' +
    'Verify the artifact name in download-artifact matches the name used in upload-artifact exactly. ' +
    'Add if-no-files-found: warn to prevent upload failures when build is skipped.',

  vite_build_failure:
    'Vite build failed. ' +
    'Add --mode production to vite build command. ' +
    'Increase NODE_OPTIONS=--max-old-space-size to handle large bundles. ' +
    'Add chunkSizeWarningLimit: 1024 to vite.config to suppress false warnings. ' +
    'Use manualChunks to split vendor code from application code.',

  webpack_build_failure:
    'Webpack build failed due to memory or configuration issues. ' +
    'Add NODE_OPTIONS=--max-old-space-size=8192 before the webpack command. ' +
    'Add swapfile creation step for GitHub Actions Linux runners. ' +
    'Enable persistent caching: `cache: { type: "filesystem" }` in webpack config. ' +
    'Split the bundle with code splitting and dynamic imports.',

  db_schema_mismatch:
    'Database schema is out of sync with models. Run `prisma migrate status` or `flyway info` to see pending migrations. ' +
    'For Django: run `python manage.py makemigrations --check`. ' +
    'Apply pending migrations before running tests or deployments. ' +
    'Use `prisma migrate deploy` in CI (not `prisma migrate dev`).',

  missing_db_index:
    'A sequential scan is slowing down queries. Generate a migration with CREATE INDEX CONCURRENTLY IF NOT EXISTS. ' +
    'Run ANALYZE after creating the index to update planner statistics. ' +
    'Use EXPLAIN ANALYZE to verify the index is actually used by the query planner. ' +
    'Add pg_stat_user_indexes monitoring to detect bloated or unused indexes.',

  transaction_rollback:
    'A database transaction was rolled back. Wrap operations in a savepoint for partial rollback recovery. ' +
    'Add deadlock retry logic with exponential backoff (max 3 attempts). ' +
    'Set explicit transaction timeout: SET LOCAL lock_timeout = "5s". ' +
    'Ensure all connections are returned to the pool after rollback to prevent connection leaks.',

  rest_endpoint_mismatch:
    'REST API endpoint URL or HTTP method does not match server expectations. ' +
    'Verify BASE_URL env var is set correctly for the CI environment. ' +
    'Check HTTP method matches the route definition (GET vs POST vs PUT). ' +
    'Add trailing slash guard: normalize URLs with/without trailing slash. ' +
    'Ensure Authorization and Content-Type headers are set on every request.',

  missing_docker_layer:
    'Docker build layer is missing from cache or failed to pull. ' +
    'Add `cache-from: type=gha` and `cache-to: type=gha,mode=max` to docker/build-push-action. ' +
    'Pin base image digest (FROM node:20-alpine@sha256:...) for reproducible layers. ' +
    'Add --no-cache flag temporarily to force a clean rebuild if the cache is corrupt.',

  dockerfile_syntax:
    'Dockerfile contains a syntax or instruction error. ' +
    'Check for invalid FROM directives, missing arguments to COPY/ADD, or unsupported BuildKit syntax. ' +
    'Use `docker build --check .` (Docker 24+) to validate without building. ' +
    'Ensure multi-stage build stage names are correct and referenced consistently.',

  container_startup:
    'Container failed to start or did not pass its health check in time. ' +
    'Increase the health check timeout: add `options: --health-timeout 30s --health-retries 5` to service containers. ' +
    'Add a readiness wait loop: `until docker exec <container> pg_isready; do sleep 2; done`. ' +
    'Check container logs with `docker logs <container>` to find the root startup error.',

  registry_auth_failure:
    'Container registry push or pull authentication failed. ' +
    'Add a docker/login-action step before build-push-action for each registry (Docker Hub, GHCR, ECR). ' +
    'For GHCR: use registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }}. ' +
    'For ECR: use aws-actions/amazon-ecr-login after configuring AWS credentials.',

  volume_mount_failure:
    'Docker volume mount failed — path does not exist or permission denied. ' +
    'Use absolute paths for bind mounts. ' +
    'Add `mkdir -p <host-path>` before docker run or compose up. ' +
    'For named volumes: declare them under the top-level volumes: key in docker-compose.yml.',

  oauth_failure:
    'OAuth token is invalid, expired, or the token exchange failed. ' +
    'Refresh the token: add a dedicated step to re-request the access token before use. ' +
    'Store the client secret in Actions Secrets, not in the workflow file. ' +
    'Verify the redirect_uri and scope match the OAuth app configuration exactly.',

  secret_access_denied:
    'Secret manager (Vault, AWS Secrets Manager, GCP Secret Manager) denied access. ' +
    'Verify the IAM policy or Vault policy grants GetSecretValue or secretmanager.versions.access. ' +
    'For HashiCorp Vault: check the AppRole or JWT auth method is configured for this repo. ' +
    'Add the secret path to the policy: path "secret/data/myapp/*" { capabilities = ["read"] }.',

  insufficient_role:
    'IAM role or RBAC role lacks required permissions for this operation. ' +
    'Check the specific action that failed and add the minimal required permission. ' +
    'For AWS: attach an inline policy granting the specific action and resource. ' +
    'For GitHub Actions: add the required permission under permissions: at job or workflow level.',

  cross_project_access:
    'Cross-project or cross-organization resource access was denied. ' +
    'For GitHub: create a PAT with repo scope and store as a secret for cross-repo API calls. ' +
    'For GitLab: configure a group access token or project access token with the required scope. ' +
    'For AWS: set up a cross-account IAM role with a trust policy for the source account.',

  gradle_build_failure:
    'Gradle build failed. ' +
    'Add `./gradlew --no-daemon` to disable the Gradle daemon in CI (prevents memory issues). ' +
    'Use actions/cache to cache ~/.gradle/caches and ~/.gradle/wrapper for faster builds. ' +
    'For dependency resolution failures: add --refresh-dependencies flag. ' +
    'Set org.gradle.jvmargs=-Xmx4g in gradle.properties for large projects.',

  maven_build_failure:
    'Maven build failed. ' +
    'Add -B (batch mode) and -ntp (no transfer progress) flags to mvn commands in CI. ' +
    'Cache ~/.m2/repository with actions/cache to speed up dependency resolution. ' +
    'For SNAPSHOT resolution failures: add -U flag to force remote snapshot updates.',

  artifact_missing:
    'A required artifact was not found for the download step. ' +
    'Verify the artifact name in actions/download-artifact matches the name in actions/upload-artifact exactly (case-sensitive). ' +
    'Check that the upload job completed successfully and was not skipped. ' +
    'Add if-no-files-found: error to the upload step to catch missing files early.',

  runtime_version_error:
    'Runtime version does not match the required version. ' +
    'Pin the exact version in the setup action: actions/setup-node@v4 with node-version: "20.x". ' +
    'Add a .nvmrc or .node-version file to auto-detect the version. ' +
    'For Python: use python-version: "3.12" in actions/setup-python.',

  null_reference:
    'Null pointer or undefined reference exception in the build or test step. ' +
    'Add null guards before accessing object properties: use optional chaining (?.) and nullish coalescing (??). ' +
    'For Java: annotate parameters with @NonNull and enable NullAway or SpotBugs. ' +
    'Add a pre-test step to validate required environment variables and config files exist.',

  type_mismatch:
    'Type mismatch or invalid type cast error. ' +
    'Run the type-checker in CI: add `npx tsc --noEmit` as a separate step before build. ' +
    'For Python: add `mypy --strict` to CI and fix the flagged type annotations. ' +
    'Avoid `as unknown as T` casts — use type guards with instanceof or discriminated unions instead.',

  infinite_loop:
    'Process hung or infinite loop detected (job timed out waiting for a condition). ' +
    'Add a timeout to the loop: use a counter or deadline check with a maximum retry count. ' +
    'Add `timeout-minutes: 10` at the job level so the runner kills the hanging process. ' +
    'Instrument the loop with log output every N iterations to see where it stalls.',

  stack_overflow:
    'Stack overflow or maximum recursion depth exceeded. ' +
    'Refactor recursive functions to iterative using an explicit stack data structure. ' +
    'For Node.js: increase stack size via NODE_OPTIONS=--stack-size=65536. ' +
    'For Python: raise sys.setrecursionlimit only as a temporary measure; refactor the algorithm.',

  segfault:
    'Segmentation fault (SIGSEGV) caused the process to crash. ' +
    'Run with AddressSanitizer in CI: compile with -fsanitize=address,undefined. ' +
    'Check for buffer overflows, use-after-free, or double-free in native code. ' +
    'For Node.js native addons: test with valgrind. ' +
    'Capture core dumps by adding `ulimit -c unlimited` before the failing step.',

  unhandled_exception:
    'Unhandled exception, panic, or fatal error crashed the process. ' +
    'Add a top-level error boundary: `process.on("unhandledRejection", ...)` for Node.js. ' +
    'For Go: recover from panics with `defer func() { if r := recover(); r != nil { ... } }()`. ' +
    'For Python: wrap the entry point in try/except and log the full traceback.',

  mock_failure:
    'Test mock or stub setup failed — the mock framework could not intercept the call. ' +
    'Verify the import path being mocked matches exactly the path used in the module under test. ' +
    'For Jest: use jest.mock() at the top of the file, not inside describe/it blocks. ' +
    'Reset mocks between tests: add jest.resetAllMocks() or jest.restoreAllMocks() in afterEach.',

  pipeline_stage_failure:
    'A pipeline stage or job orchestration step failed. ' +
    'Check the failed job logs directly — the stage runner error wraps the real error. ' +
    'Ensure all jobs that this stage depends on completed successfully. ' +
    'Add allow_failure: true to non-critical stages to prevent them from blocking the pipeline.',

  stage_order_error:
    'Job stage dependency ordering is incorrect. ' +
    'Verify the stages: list in .gitlab-ci.yml covers all stage names used in jobs. ' +
    'For GitHub Actions: check needs: arrays reference actual job IDs (not display names). ' +
    'Draw the DAG: every job must have a clear dependency path to the final stage.',

  invalid_trigger:
    'Invalid pipeline trigger configuration or event filter. ' +
    'For GitHub Actions: check on: events are valid (push, pull_request, workflow_dispatch, schedule). ' +
    'For GitLab: verify rules: or only:/except: syntax against the GitLab CI reference. ' +
    'Add workflow_dispatch: to allow manual triggering for debugging.',

  artifact_upload_failure:
    'Artifact or test report upload step failed. ' +
    'Verify the path glob in actions/upload-artifact matches files that actually exist. ' +
    'Use `if: always()` on the upload step so it runs even if tests fail. ' +
    'Add if-no-files-found: warn during development; switch to error for required artifacts.',

  cache_restore_failure:
    'Cache restore step failed — cache key not found or restore error. ' +
    'Add a fallback restore-keys list using a partial key prefix. ' +
    'Verify the cache key template does not include values that change every run (e.g., timestamps). ' +
    'For npm: use hashFiles("**/package-lock.json") as the key suffix.',

  parallel_sync_issue:
    'Parallel job synchronization failed — race condition or ordering dependency missing. ' +
    'Use needs: to enforce job ordering in GitHub Actions. ' +
    'For GitLab: use stages to sequence parallel work. ' +
    'Avoid writing to shared artifacts from parallel jobs simultaneously.',

  git_detached_head:
    'Git is in detached HEAD state — branch-relative operations fail. ' +
    'Add `ref: ${{ github.head_ref || github.ref_name }}` to actions/checkout to check out a branch. ' +
    'For GitLab: ensure the pipeline runs on a branch, not a detached SHA. ' +
    'For semantic-release: add fetch-depth: 0 and fetch-tags: true to checkout.',

  git_commit_rejected:
    'Git commit was rejected by a branch protection rule, hook, or policy. ' +
    'Check branch protection settings: the bot token must have bypass permissions. ' +
    'Ensure CI-generated commit messages comply with the conventional commit format. ' +
    'Use a dedicated bot account or GitHub App token with the required repository write permissions.',

  git_access_denied:
    'Git repository read or write access was denied. ' +
    'Use ${{ secrets.GITHUB_TOKEN }} for same-repository operations. ' +
    'For cross-repo access: create a PAT with repo scope and store it as a secret. ' +
    'For GitLab: use a project access token or CI_JOB_TOKEN.',

  git_invalid_branch:
    'Git branch reference is invalid or refers to a protected branch. ' +
    'Verify the branch name does not contain invalid characters. ' +
    'Check that the branch exists before checking out: `git ls-remote --heads origin <branch>`. ' +
    'For push to protected branch: create a PR instead of pushing directly.',

  rollback_failure:
    'Deployment rollback failed after a bad deploy. ' +
    'Implement rollback as a separate parameterized workflow triggered manually. ' +
    'Tag every successful release image with a version tag before deploying the next version. ' +
    'For Kubernetes: use `kubectl rollout undo deployment/<name>`.',

  failed_production_deploy:
    'Production deployment permanently failed (not recoverable by retry). ' +
    'Add a smoke test step that polls the health endpoint for 60 seconds after deploy. ' +
    'On smoke test failure: trigger automatic rollback workflow via `gh workflow run rollback.yml`. ' +
    'Post deployment failure notifications to Slack with the run URL for quick investigation.',

  blue_green_conflict:
    'Blue-green traffic switch conflict — both environments are active simultaneously. ' +
    'Implement a mutex on the traffic switch using a state file in S3 or a DynamoDB lock. ' +
    'Verify only one deployment pipeline runs at a time: add concurrency group at workflow level. ' +
    'Add a pre-switch health check: blue environment must return HTTP 200 before switching traffic.',

  canary_mismatch:
    'Canary deployment version mismatch — canary and stable are out of sync. ' +
    'Pin the canary image tag explicitly (do not use :latest). ' +
    'Implement weighted routing validation: verify canary receives exactly N% of traffic before promoting. ' +
    'Add automated canary analysis: compare error rate and p99 latency against stable baseline.',

  health_check_failure:
    'Service or container health check failed. ' +
    'Ensure the application exposes GET /health returning HTTP 200 with body {"status":"ok"}. ' +
    'Increase health check timeout for slow-starting services: --health-start-period 30s. ' +
    'Log the health check response body in CI: `curl -v http://localhost:8080/health`.',

  invalid_gitlab_ci:
    'Invalid .gitlab-ci.yml file structure or syntax. ' +
    'Validate with the GitLab CI Lint API or run `gitlab-ci-local --list` locally. ' +
    'Common errors: missing stage in stages: list, invalid needs: reference, wrong extends: syntax. ' +
    'Use include: to split large files and !reference to reuse job definitions.',

  invalid_workflow_syntax:
    'Invalid GitHub Actions workflow file structure or YAML syntax. ' +
    'Use actionlint to validate: install and run `./actionlint` in the repo root. ' +
    'Common errors: wrong indentation under steps:, invalid expression syntax ${{ }}, misspelled on: event names. ' +
    'Add actionlint as a pre-commit hook to catch issues before pushing.',

  missing_config_file:
    'A required configuration file was not found. ' +
    'Check the file path is relative to the repository root, not to the script location. ' +
    'Add the config file to the repository or add a generation step before the step that requires it. ' +
    'Use `ls -la` before the failing step to confirm what files are present.',

  config_hierarchy_error:
    'Configuration inheritance or hierarchy resolution error. ' +
    'For ESLint: check extends: references are installed packages. ' +
    'For GitLab extends: verify the parent job exists in the same or included file. ' +
    'Flatten the config hierarchy temporarily to isolate which level introduces the error.',

  unsupported_config_param:
    'Unsupported or unknown configuration parameter. ' +
    'Check the documentation for the exact version being used — options change between major versions. ' +
    'Run with --debug to see which config keys are unrecognized. ' +
    'Remove the unknown parameter or replace it with the correct equivalent for the installed version.',

  duplicate_config_key:
    'Duplicate key detected in a configuration file. ' +
    'YAML does not error on duplicate keys by default — the last value wins silently. ' +
    'Use yamllint to detect duplicates: `yamllint .github/workflows/`. ' +
    'Search for the duplicate key and remove or merge the conflicting entries.',

  env_mapping_error:
    'Environment variable mapping or injection failed — variable not available in the target step. ' +
    'Declare env: at the job level for variables needed across multiple steps. ' +
    'Secrets must be explicitly mapped: `MY_SECRET: ${{ secrets.MY_SECRET }}`. ' +
    'For composite actions: pass env vars through inputs: since composite steps inherit a limited env.',

  unknown:
    'Analyse all provided files. Look for version mismatches, missing commands, ' +
    'wrong environment setup, or misconfigured steps. ' +
    'Pay attention to error exit codes and the exact failing step name.',
};

const PATTERNS: Array<{
  category: ErrorCategory;
  patterns: RegExp[];
  relevantFiles: string[];
  description: string;
}> = [
  // ── Docker auth (BEFORE docker_build — "login" ≠ "build") ───────────────
  {
    category: 'docker_auth',
    patterns: [
      /login.*docker\s*hub/i, /docker.*login/i,
      /Username and password required/i, /unauthorized.*registry/i,
      /authentication required.*docker/i, /DOCKER_(?:USERNAME|PASSWORD|TOKEN)/i,
      /docker.*credential/i, /denied.*repository/i,
    ],
    relevantFiles: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore'],
    description: 'Docker registry authentication failure',
  },

  // ── Docker rate limit ────────────────────────────────────────────────────
  {
    category: 'docker_rate_limit',
    patterns: [/toomanyrequests.*docker/i, /pull rate limit/i, /429.*docker\.io/i],
    relevantFiles: ['Dockerfile', 'docker-compose.yml'],
    description: 'Docker Hub pull rate limit exceeded',
  },

  // ── Docker build ────────────────────────────────────────────────────────
  {
    category: 'docker_build',
    patterns: [
      /dockerfile/i, /docker build/i, /COPY.*failed/i, /RUN.*failed/i,
      /image.*not found/i, /pull.*access.*denied/i,
      /no such file.*dockerfile/i, /failed to build.*image/i,
      /context.*no.*dockerfile/i,
    ],
    relevantFiles: ['Dockerfile', '.dockerignore', 'docker-compose.yml'],
    description: 'Docker image build failure',
  },

  // ── Container health check ──────────────────────────────────────────────
  {
    category: 'container_health_failure',
    patterns: [
      /health.*check.*failed/i, /container.*unhealthy/i,
      /no.*healthy.*instance/i, /liveness.*probe.*failed/i,
      /readiness.*probe.*failed/i,
    ],
    relevantFiles: ['Dockerfile', 'docker-compose.yml'],
    description: 'Container health check failure',
  },

  // ── GitHub API permissions ───────────────────────────────────────────────
  {
    category: 'permissions_error',
    patterns: [
      /resource not accessible by integration/i, /refusing to allow.*app/i,
      /403.*forbidden/i, /github.*token.*permission/i,
      /insufficient.*scope/i, /write access.*required/i,
    ],
    relevantFiles: [],
    description: 'GitHub token missing required permissions (403)',
  },

  // ── OIDC ────────────────────────────────────────────────────────────────
  {
    category: 'oidc_failure',
    patterns: [
      /jwt.*invalid/i, /oidc.*token/i, /id.?token.*permission/i,
      /AssumeRoleWithWebIdentity/i, /workload.identity/i, /federated.*credential/i,
    ],
    relevantFiles: [],
    description: 'OIDC/Federated identity token failure',
  },

  // ── Invalid / expired token (401) ────────────────────────────────────────
  {
    category: 'invalid_token',
    patterns: [
      /401 Unauthorized/i, /token.*expired/i, /authentication.*failed.*401/i,
      /invalid_token/i, /credentials.*expired/i,
    ],
    relevantFiles: [],
    description: 'API token expired or invalid (401)',
  },

  // ── SSH key error ────────────────────────────────────────────────────────
  {
    category: 'ssh_key_error',
    patterns: [
      /Host key verification failed/i, /ECDSA host key/i,
      /Permission denied.*publickey/i, /ssh.*could not read.*private key/i,
      /invalid format.*ssh.*key/i,
    ],
    relevantFiles: [],
    description: 'SSH key authentication failure',
  },

  // ── Shell permission denied ──────────────────────────────────────────────
  {
    category: 'permission_denied',
    patterns: [/permission denied/i, /EACCES/i, /not executable/i, /access denied/i],
    relevantFiles: [],
    description: 'File or script permission error',
  },

  // ── Missing file ─────────────────────────────────────────────────────────
  {
    category: 'missing_file',
    patterns: [
      /no such file.*dockerfile/i, /ENOENT.*scripts\//i,
      /cannot find.*config/i, /file not found.*\.sh/i,
      /no such file or directory.*\.py/i,
    ],
    relevantFiles: [],
    description: 'Referenced file does not exist',
  },

  // ── Node.js 20 deprecation ───────────────────────────────────────────────
  {
    category: 'actions_deprecation',
    patterns: [
      /Node\.js 20.*deprecated/i, /actions.*running on Node\.js 20/i,
      /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/i, /will be forced to run with Node\.js 24/i,
    ],
    relevantFiles: [],
    description: 'GitHub Actions running on deprecated Node.js 20 runtime',
  },

  // ── Job timeout ──────────────────────────────────────────────────────────
  {
    category: 'job_timeout',
    patterns: [
      /exceeded.*maximum execution time/i, /The job running on runner.*has exceeded/i,
      /canceling.*because.*took longer/i,
    ],
    relevantFiles: [],
    description: 'Job exceeded the runner time limit',
  },

  // ── Memory error ─────────────────────────────────────────────────────────
  {
    category: 'memory_error',
    patterns: [
      /JavaScript heap out of memory/i, /FATAL ERROR.*CALL_AND_RETRY/i,
      /Reached heap limit/i, /Segmentation fault/i, /SIGSEGV/i,
      /Cannot allocate memory/i, /ENOMEM/i, /stack overflow/i,
      /maximum call stack size exceeded/i, /Allocation failed/i,
    ],
    relevantFiles: [],
    description: 'Memory error — OOM, heap overflow, or segfault',
  },

  // ── Lint ─────────────────────────────────────────────────────────────────
  {
    category: 'lint_failure',
    patterns: [
      /eslint/i, /prettier/i, /TS\d{4}:/i, /TypeScript.*error/i,
      /tsc.*--noEmit/i, /lint.*error/i,
    ],
    relevantFiles: ['.eslintrc.json', '.eslintrc.js', 'tsconfig.json', '.prettierrc'],
    description: 'Linting or TypeScript compilation error',
  },

  // ── Coverage failure ─────────────────────────────────────────────────────
  {
    category: 'coverage_failure',
    patterns: [
      /coverage threshold.*not met/i, /Jest.*coverage.*threshold/i,
      /Uncovered.*Lines/i, /coverage.*below.*minimum/i,
    ],
    relevantFiles: ['jest.config.js', 'jest.config.ts', 'vitest.config.ts'],
    description: 'Test coverage threshold not met',
  },

  // ── Snapshot mismatch ────────────────────────────────────────────────────
  {
    category: 'snapshot_mismatch',
    patterns: [
      /snapshot.*obsolete/i, /1 snapshot.*written/i,
      /received value does not match stored snapshot/i,
      /snapshots?.*mismatch/i,
    ],
    relevantFiles: ['jest.config.js', 'jest.config.ts'],
    description: 'Jest/Vitest snapshot mismatch',
  },

  // ── Test failure ─────────────────────────────────────────────────────────
  {
    category: 'test_failure',
    patterns: [
      /jest/i, /vitest/i, /mocha/i, /pytest/i,
      /● /m, /FAIL\s+src/i, /Test Suites.*failed/i,
      /assertion.*failed/i, /tests.*failed/i,
    ],
    relevantFiles: ['jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'package.json'],
    description: 'Test suite failure',
  },

  // ── Git merge conflict ───────────────────────────────────────────────────
  {
    category: 'git_merge_conflict',
    patterns: [
      /<<<<<<< /i, /CONFLICT.*Merge conflict/i,
      /Automatic merge failed/i, /fix conflicts and then commit/i,
    ],
    relevantFiles: [],
    description: 'Git merge conflict markers in committed files',
  },

  // ── Git push rejected ────────────────────────────────────────────────────
  {
    category: 'git_push_rejected',
    patterns: [
      /GH006: Protected branch update failed/i, /rejected.*non-fast-forward/i,
      /push.*rejected/i, /remote.*rejected.*push/i,
      /Author identity unknown/i, /Please tell me who you are/i,
    ],
    relevantFiles: [],
    description: 'Git push rejected — protected branch or identity issue',
  },

  // ── Git submodule ────────────────────────────────────────────────────────
  {
    category: 'git_submodule_error',
    patterns: [
      /SM_PATH|submodule/i, /fatal.*repository.*does not exist.*submodule/i,
      /No url found for submodule/i,
    ],
    relevantFiles: ['.gitmodules'],
    description: 'Git submodule initialisation failure',
  },

  // ── Git LFS ─────────────────────────────────────────────────────────────
  {
    category: 'git_lfs_error',
    patterns: [/smudge filter lfs failed/i, /git-lfs.*not.*installed/i, /LFS.*pointer/i],
    relevantFiles: ['.gitattributes'],
    description: 'Git LFS download failure',
  },

  // ── Artifact failure ─────────────────────────────────────────────────────
  {
    category: 'artifact_failure',
    patterns: [
      /No files were found with the provided path/i,
      /artifact.*not found/i, /Unable to find.*artifact/i,
      /upload.*artifact.*failed/i, /download.*artifact.*failed/i,
    ],
    relevantFiles: [],
    description: 'Artifact upload or download failure',
  },

  // ── Cache failure ────────────────────────────────────────────────────────
  {
    category: 'cache_failure',
    patterns: [
      /cache.*miss/i, /Failed to restore cache/i,
      /cache.*not.*found/i, /Restore cache failed/i,
    ],
    relevantFiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    description: 'Cache restore or save failure',
  },

  // ── Runner unavailable ───────────────────────────────────────────────────
  {
    category: 'runner_unavailable',
    patterns: [
      /No hosted runner.*matching/i, /runner.*offline/i,
      /self-hosted runner.*not found/i, /Waiting for.*runner/i,
      /No runner matching the specified labels/i,
      /no available runners.*process the request/i,
      /Requested labels:.*no runners/i,
      /ubuntu-lates{2,}/i,
      /runs-on.*no runner/i,
      /Could not find.*runner.*label/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Runner offline, unknown label, or runner label typo',
  },

  // ── npm/yarn dependency issues ───────────────────────────────────────────
  {
    category: 'missing_dependency',
    patterns: [
      /cannot find module/i, /module not found/i, /ENOENT.*node_modules/i,
      /peer dep/i, /Cannot resolve/i, /failed to install/i, /unresolved dep/i,
    ],
    relevantFiles: ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    description: 'Missing or broken npm/yarn dependency',
  },

  // ── Node version ─────────────────────────────────────────────────────────
  {
    category: 'node_version',
    patterns: [
      /node.*not.*found/i, /nvmrc/i, /unsupported.*engine/i,
      /no.*matching.*version.*found/i, /ENODEVER/i, /required.*node.*version/i,
    ],
    relevantFiles: ['.nvmrc', '.node-version', 'package.json'],
    description: 'Node.js version unavailable or unsupported',
  },

  // ── Missing env var ──────────────────────────────────────────────────────
  {
    category: 'env_missing',
    patterns: [
      /env.*not.*set/i, /missing.*env/i, /undefined.*variable/i,
      /secret.*not.*found/i, /required.*secret/i,
    ],
    relevantFiles: ['.env.example'],
    description: 'Missing environment variable or secret',
  },

  // ── Python deps ──────────────────────────────────────────────────────────
  {
    category: 'python_deps',
    patterns: [
      /pip install/i, /requirements\.txt/i, /ModuleNotFoundError/i,
      /No module named/i, /ImportError/i,
    ],
    relevantFiles: ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Pipfile'],
    description: 'Python dependency or version issue',
  },

  // ── YAML syntax ──────────────────────────────────────────────────────────
  {
    category: 'yaml_syntax',
    patterns: [
      /yaml.*syntax/i, /invalid.*workflow/i, /unexpected.*mapping/i,
      /mapping.*values.*not.*allowed/i, /did not find expected/i,
    ],
    relevantFiles: [],
    description: 'YAML syntax error in workflow file',
  },

  // ── Build failure ────────────────────────────────────────────────────────
  {
    category: 'build_failure',
    patterns: [
      /missing script.*build/i, /npm run build.*exited.*1/i,
      /webpack.*error/i, /vite.*build.*failed/i,
    ],
    relevantFiles: ['package.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js'],
    description: 'Build command failed',
  },

  // ── Concurrency issue ────────────────────────────────────────────────────
  {
    category: 'concurrency_issue',
    patterns: [
      /This run has been cancelled/i, /run.*cancelled.*concurrency/i,
      /superseded by a newer run/i,
    ],
    relevantFiles: [],
    description: 'Workflow run cancelled by concurrency group',
  },

  // ── Deployment failure ───────────────────────────────────────────────────
  {
    category: 'deploy_failure',
    patterns: [
      /Deployment.*failed/i, /Failed to deploy/i,
      /rollout.*failed/i, /kubectl.*error/i,
      /502 Bad Gateway.*deploy/i, /health check.*failed.*deploy/i,
    ],
    relevantFiles: [],
    description: 'Production deployment failure',
  },

  // ── API rate limit ───────────────────────────────────────────────────────
  {
    category: 'api_rate_limit',
    patterns: [
      /429 Too Many Requests/i, /rate.?limit.*exceeded/i,
      /API rate limit/i, /You have exceeded/i,
    ],
    relevantFiles: [],
    description: 'API rate limit exceeded (429)',
  },

  // ── API timeout ──────────────────────────────────────────────────────────
  {
    category: 'api_timeout',
    patterns: [
      /ETIMEDOUT/i, /ECONNRESET/i, /ENOTFOUND/i,
      /connection timed out/i, /network timeout/i, /request timeout/i,
    ],
    relevantFiles: [],
    description: 'API or network connection timeout',
  },

  // ── Webhook failure ──────────────────────────────────────────────────────
  {
    category: 'webhook_failure',
    patterns: [
      /webhook.*signature.*invalid/i, /invalid.*webhook.*secret/i,
      /X-Hub-Signature/i, /HMAC.*mismatch/i, /webhook.*delivery.*failed/i,
    ],
    relevantFiles: [],
    description: 'Webhook delivery or signature failure',
  },

  // ── DB migration error ───────────────────────────────────────────────────
  {
    category: 'db_migration_error',
    patterns: [
      /migration.*failed/i, /Migration.*lock.*timeout/i,
      /shadowDatabaseUrl/i, /Cannot apply.*migration/i,
      /Flyway.*error/i, /Liquibase.*failed/i,
    ],
    relevantFiles: ['package.json', 'knexfile.js', 'prisma/schema.prisma'],
    description: 'Database migration failure',
  },

  // ── DB connection error ──────────────────────────────────────────────────
  {
    category: 'db_connection_error',
    patterns: [
      /ECONNREFUSED.*5432/i, /ECONNREFUSED.*3306/i, /ECONNREFUSED.*27017/i,
      /ECONNREFUSED.*6379/i, /could not connect.*server/i,
      /connection refused.*database/i, /pg_isready/i,
    ],
    relevantFiles: ['package.json'],
    description: 'Database connection refused — service not ready',
  },

  // ── DB deadlock ──────────────────────────────────────────────────────────
  {
    category: 'db_deadlock',
    patterns: [
      /deadlock detected/i, /ER_LOCK_DEADLOCK/i,
      /lock.*timeout.*exceeded/i, /could not obtain lock/i,
    ],
    relevantFiles: [],
    description: 'Database deadlock or lock timeout',
  },

  // ── DB query execution failure ───────────────────────────────────────────
  {
    category: 'db_query_failure',
    patterns: [
      /QueryFailedError/i, /query.*execution.*failed/i,
      /ERROR.*syntax.*near/i, /ORA-\d{5}/i,
      /PG.*query.*error/i, /mysql.*Query.*Error/i,
      /statement timeout exceeded/i,
    ],
    relevantFiles: ['package.json', 'prisma/schema.prisma'],
    description: 'Database query execution failure',
  },

  // ── DB replication lag ───────────────────────────────────────────────────
  {
    category: 'db_replication_lag',
    patterns: [
      /replication.*lag/i, /replica.*behind/i,
      /read.*replica.*stale/i, /slave.*delay/i,
      /standby.*not.*caught.*up/i, /could not serialize access/i,
    ],
    relevantFiles: [],
    description: 'Database read replica replication lag',
  },

  // ── DB schema mismatch / drift ───────────────────────────────────────────
  {
    category: 'db_schema_mismatch',
    patterns: [
      /schema.*drift|unapplied.*migration/i,
      /PrismaClientInitializationError/i,
      /Your models.*have.*changes.*not yet reflected/i,
      /TypeORM.*schema.*sync/i,
      /pending.*migration.*not.*applied/i,
    ],
    relevantFiles: ['prisma/schema.prisma', 'knexfile.js', 'package.json'],
    description: 'Database schema out of sync with application models',
  },

  // ── Missing database index ────────────────────────────────────────────────
  {
    category: 'missing_db_index',
    patterns: [
      /Seq Scan|sequential scan/i,
      /missing index hint|slow query.*index/i,
      /query.*exceeds.*threshold.*no index/i,
      /table scan.*performance/i,
    ],
    relevantFiles: ['package.json', 'prisma/schema.prisma'],
    description: 'Missing database index causing sequential scans or slow queries',
  },

  // ── Transaction rollback ──────────────────────────────────────────────────
  {
    category: 'transaction_rollback',
    patterns: [
      /transaction.*rolled.*back|rollback.*transaction/i,
      /TransactionRollbackError/i,
      /current.*transaction.*aborted/i,
      /could not serialize.*transaction/i,
      /ERROR.*in transaction.*aborted/i,
    ],
    relevantFiles: ['package.json', 'prisma/schema.prisma'],
    description: 'Database transaction rolled back due to error or conflict',
  },

  // ── REST endpoint mismatch ────────────────────────────────────────────────
  {
    category: 'rest_endpoint_mismatch',
    patterns: [
      /404.*endpoint|endpoint.*not.*found/i,
      /405.*method.*not.*allowed/i,
      /REST.*endpoint.*mismatch|base.*url.*undefined/i,
      /Cannot \w+ \/api\//i,
      /route.*not.*found.*[45]\d\d/i,
    ],
    relevantFiles: [],
    description: 'REST API endpoint URL or HTTP method does not match server definition',
  },

  // ── Compilation failure ──────────────────────────────────────────────────
  {
    category: 'compilation_failure',
    patterns: [
      /TS\d{4}:|error TS\d{4}/i, /Compilation failed/i,
      /SyntaxError.*python|IndentationError/i,
      /compilation.*error|failed to compile/i,
      /tsc.*exited.*1/i,
    ],
    relevantFiles: ['tsconfig.json', 'package.json'],
    description: 'TypeScript, Python, or other compilation error',
  },

  // ── Corrupted lockfile ───────────────────────────────────────────────────
  {
    category: 'lockfile_corrupt',
    patterns: [
      /EINTEGRITY/i, /corrupted.*lockfile/i,
      /integrity.*checksum.*failed/i, /npm ERR!.*cb\.apply/i,
      /invalid.*package-lock/i,
    ],
    relevantFiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    description: 'Package lockfile integrity failure',
  },

  // ── Missing virtualenv ───────────────────────────────────────────────────
  {
    category: 'venv_missing',
    patterns: [
      /\.venv.*activate|venv.*not.*found/i,
      /virtualenv.*not.*created/i,
      /pip.*externally.*managed/i,
    ],
    relevantFiles: ['requirements.txt', 'Pipfile'],
    description: 'Python virtual environment not activated',
  },

  // ── Invalid branch reference ─────────────────────────────────────────────
  {
    category: 'invalid_branch',
    patterns: [
      /invalid reference.*branch/i, /branch.*not found/i,
      /pathspec.*did not match.*any.*branch/i,
      /no upstream configured/i, /unknown revision/i,
    ],
    relevantFiles: [],
    description: 'Invalid or missing branch reference',
  },

  // ── Circular dependency ──────────────────────────────────────────────────
  {
    category: 'circular_dependency',
    patterns: [
      /circular dependency/i, /job.*depends.*itself/i,
      /cycle.*detected.*needs/i, /needs.*circular/i,
    ],
    relevantFiles: [],
    description: 'Circular job dependency in pipeline',
  },

  // ── Port binding conflict ────────────────────────────────────────────────
  {
    category: 'port_conflict',
    patterns: [
      /port.*already.*allocated/i, /address.*already.*in.*use/i,
      /Bind for.*failed/i, /EADDRINUSE/i,
      /0\.0\.0\.0:\d+.*already in use/i,
    ],
    relevantFiles: ['docker-compose.yml', 'docker-compose.yaml'],
    description: 'Port already bound — EADDRINUSE',
  },

  // ── Docker image pull failure ────────────────────────────────────────────
  {
    category: 'image_pull_failure',
    patterns: [
      /pull.*access.*denied/i, /manifest.*unknown.*docker/i,
      /Error response.*daemon.*pull/i,
      /unauthorized.*docker.*registry/i,
    ],
    relevantFiles: ['Dockerfile', 'docker-compose.yml'],
    description: 'Docker image pull failure — unauthorized or not found',
  },

  // ── Service unavailable ──────────────────────────────────────────────────
  {
    category: 'service_unavailable',
    patterns: [
      /503 Service Unavailable/i, /502 Bad Gateway.*deploy/i,
      /service.*not.*available.*deploy/i,
      /ECONNREFUSED.*deploy/i,
    ],
    relevantFiles: [],
    description: 'Upstream service unavailable before/during deployment',
  },

  // ── Load balancer routing issue ──────────────────────────────────────────
  {
    category: 'load_balancer_issue',
    patterns: [
      /load.?balancer.*health/i, /ALB.*health.*check/i,
      /ELB.*health/i, /target.*unhealthy/i,
      /health.*check.*path.*\d+/i,
    ],
    relevantFiles: [],
    description: 'Load balancer health check failing',
  },

  // ── Invalid API response ─────────────────────────────────────────────────
  {
    category: 'invalid_api_response',
    patterns: [
      /unexpected.*response.*API|API.*returned.*[45]\d\d/i,
      /response.*not.*ok.*fetch/i, /HTTP.*[45]\d\d.*endpoint/i,
      /invalid.*API.*response/i,
    ],
    relevantFiles: [],
    description: 'API returned an unexpected or error response',
  },

  // ── Third-party integration failure ─────────────────────────────────────
  {
    category: 'third_party_failure',
    patterns: [
      /third.?party.*service.*fail/i, /external.*service.*unavailable/i,
      /integration.*failed.*upstream/i,
      /snyk.*unavailable|datadog.*error|newrelic.*fail/i,
    ],
    relevantFiles: [],
    description: 'Third-party external service integration failure',
  },

  // ── Schema validation failure ────────────────────────────────────────────
  {
    category: 'schema_validation',
    patterns: [
      /schema.*validation.*failed/i, /JSON Schema.*error/i,
      /ajv.*error/i, /required.*property.*missing.*schema/i,
      /spectral.*error/i,
    ],
    relevantFiles: [],
    description: 'JSON/OpenAPI schema validation error',
  },

  // ── GraphQL failure ──────────────────────────────────────────────────────
  {
    category: 'graphql_failure',
    patterns: [
      /Cannot query field/i, /Unknown argument.*GraphQL/i,
      /GraphQL.*error/i, /graphql.*introspection/i,
      /Field.*does not exist.*schema/i,
    ],
    relevantFiles: [],
    description: 'GraphQL query or introspection failure',
  },

  // ── Husky git hook failure ───────────────────────────────────────────────
  {
    category: 'husky_hook_failure',
    patterns: [
      /husky.*pre-commit.*failed/i, /\.husky\/.*command not found/i,
      /HUSKY.*error/i, /husky.*hook.*fail/i,
      /pre-commit.*hook.*exit.*[^0]/i, /commit-msg.*hook.*fail/i,
    ],
    relevantFiles: ['.husky/', 'package.json', '.huskyrc'],
    description: 'Husky git hook failing in CI environment',
  },

  // ── Go build / module failure ────────────────────────────────────────────
  {
    category: 'go_build_failure',
    patterns: [
      /go.*build.*failed/i, /no required module provides/i,
      /cannot find package.*in.*go/i, /go mod download.*failed/i,
      /go: .*missing go\.sum entry/i, /package.*is not in GOROOT/i,
      /go: .*inconsistent vendoring/i,
    ],
    relevantFiles: ['go.mod', 'go.sum', 'vendor/'],
    description: 'Go module resolution or build compilation failure',
  },

  // ── Rust / Cargo build failure ───────────────────────────────────────────
  {
    category: 'rust_build_failure',
    patterns: [
      /error\[E\d+\].*rust/i, /cargo.*build.*failed/i,
      /error: could not compile/i, /cannot find.*in this scope.*rust/i,
      /the crate.*is not compiled/i, /cargo.*error.*Compilation failed/i,
    ],
    relevantFiles: ['Cargo.toml', 'Cargo.lock', 'src/'],
    description: 'Rust/Cargo compilation or dependency failure',
  },

  // ── .NET / dotnet build failure ──────────────────────────────────────────
  {
    category: 'dotnet_build_failure',
    patterns: [
      /dotnet.*build.*FAILED/i, /MSBuild.*Error/i,
      /error CS\d+/i, /dotnet restore.*fail/i,
      /NuGet.*package.*not found/i, /The type or namespace.*not found/i,
    ],
    relevantFiles: ['*.csproj', '*.sln', 'NuGet.config', 'global.json'],
    description: 'dotnet MSBuild / NuGet restore failure',
  },

  // ── End-to-end (Playwright / Cypress) failure ────────────────────────────
  {
    category: 'e2e_failure',
    patterns: [
      /playwright.*browser.*not found/i, /Executable.*chromium.*doesn.*exist/i,
      /cypress.*run.*failed/i, /cypress.*browser.*not found/i,
      /ENOENT.*playwright/i, /browserType\.launch.*failed/i,
      /Error: Timeout \d+ms exceeded.*playwright/i,
    ],
    relevantFiles: ['playwright.config.ts', 'cypress.config.ts', 'cypress.json'],
    description: 'End-to-end test runner (Playwright/Cypress) setup or browser failure',
  },

  // ── Lint / format failure ────────────────────────────────────────────────
  {
    category: 'lint_format_failure',
    patterns: [
      /ESLint.*\d+ error/i, /Prettier.*check.*failed/i,
      /eslint.*parsing error/i, /Cannot find.*eslint.*config/i,
      /prettier.*option.*unknown/i, /tslint.*error/i,
      /stylelint.*\d+ error/i,
    ],
    relevantFiles: ['.eslintrc', '.eslintrc.json', '.prettierrc', 'eslint.config.js', '.stylelintrc'],
    description: 'ESLint, Prettier, or stylelint check failure',
  },

  // ── Git tag / semantic-release failure ───────────────────────────────────
  {
    category: 'git_tag_failure',
    patterns: [
      /fatal: No tags can describe/i, /git.*describe.*failed/i,
      /semantic-release.*no commits since last release/i,
      /ENOTAG.*semantic-release/i, /No previous release found/i,
      /tag.*not.*found.*version/i, /git tag.*not.*fetched/i,
    ],
    relevantFiles: ['.releaserc', 'release.config.js', '.github/workflows/release.yml'],
    description: 'Git tag lookup or semantic-release tag resolution failure',
  },

  // ── Git credential / authentication failure ──────────────────────────────
  {
    category: 'git_credential_failure',
    patterns: [
      /terminal prompts disabled/i, /Authentication failed.*git/i,
      /could not read.*Password/i, /remote: Invalid username or password/i,
      /fatal: Authentication failed.*https/i,
      /git.*403.*remote/i, /git.*401.*remote/i,
    ],
    relevantFiles: ['.gitconfig', '.git/config'],
    description: 'Git HTTPS authentication failure or missing credentials',
  },

  // ── AWS authentication / OIDC failure ───────────────────────────────────
  {
    category: 'aws_auth_failure',
    patterns: [
      /Unable to locate credentials.*aws/i, /NoCredentialProviders/i,
      /AWS_ACCESS_KEY_ID.*not set/i, /Error.*AssumeRoleWithWebIdentity/i,
      /aws.*credentials.*expired/i, /AuthFailure.*aws/i,
      /InvalidClientTokenId/i,
    ],
    relevantFiles: ['.aws/credentials', '.aws/config'],
    description: 'AWS credential or OIDC role assumption failure',
  },

  // ── GCP authentication failure ───────────────────────────────────────────
  {
    category: 'gcp_auth_failure',
    patterns: [
      /GOOGLE_APPLICATION_CREDENTIALS.*not set/i, /gcloud.*auth.*failed/i,
      /Error.*Workload Identity/i, /google.*credentials.*invalid/i,
      /Application Default Credentials.*not found/i,
      /gcloud.*access.*denied/i,
    ],
    relevantFiles: ['gcloud.json', 'service-account.json'],
    description: 'GCP credentials or Workload Identity Federation failure',
  },

  // ── Missing secret / environment variable ───────────────────────────────
  {
    category: 'secret_missing',
    patterns: [
      /secret.*not.*set.*required/i, /Environment variable.*required.*not set/i,
      /process\.env\.\w+.*undefined/i, /secrets\.\w+.*not found/i,
      /\$\{\{ secrets\.\w+ \}\}.*empty/i,
      /Required environment variable.*missing/i,
    ],
    relevantFiles: ['.env', '.env.example', '.github/workflows/'],
    description: 'Required secret or environment variable not configured',
  },

  // ── Terraform / OpenTofu failure ─────────────────────────────────────────
  {
    category: 'terraform_failure',
    patterns: [
      /terraform.*plan.*failed/i, /Error.*Terraform/i,
      /terraform.*apply.*error/i, /tofu.*plan.*failed/i,
      /Provider.*configuration.*invalid/i, /terraform.*lock.*required/i,
      /Backend initialization required/i,
    ],
    relevantFiles: ['*.tf', '*.tfvars', '.terraform.lock.hcl', 'backend.tf'],
    description: 'Terraform or OpenTofu plan/apply/init failure',
  },

  // ── Matrix job / parallel job failure ───────────────────────────────────
  {
    category: 'matrix_failure',
    patterns: [
      /matrix.*job.*cancelled/i, /fail-fast.*cancelled/i,
      /Some jobs were not successful.*matrix/i,
      /Job.*was cancelled.*because.*fail-fast/i,
    ],
    relevantFiles: ['.github/workflows/', '.gitlab-ci.yml'],
    description: 'Matrix strategy job cancelled due to fail-fast',
  },

  // ── Artifact upload / retention issue ───────────────────────────────────
  {
    category: 'artifact_retention',
    patterns: [
      /artifact.*upload.*failed/i, /artifact.*not found/i,
      /actions\/upload-artifact.*error/i, /retention.*days.*exceeded/i,
      /Artifact.*expired/i, /No files were found.*artifact/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'GitHub Actions artifact upload or retention failure',
  },

  // ── Vite build failure ───────────────────────────────────────────────────
  {
    category: 'vite_build_failure',
    patterns: [
      /vite.*build.*failed/i, /Could not resolve.*vite/i,
      /\[vite\].*error/i, /rollup.*error.*vite/i,
      /chunk.*size.*warning.*vite/i, /vite.*transform.*error/i,
    ],
    relevantFiles: ['vite.config.ts', 'vite.config.js', 'index.html'],
    description: 'Vite bundler build or module resolution failure',
  },

  // ── Webpack build failure ────────────────────────────────────────────────
  {
    category: 'webpack_build_failure',
    patterns: [
      /webpack.*compilation.*failed/i, /Module not found.*webpack/i,
      /webpack.*out of memory/i, /ERROR in.*webpack/i,
      /FATAL ERROR.*Ineffective mark-compacts.*webpack/i,
      /webpack.*build.*error/i,
    ],
    relevantFiles: ['webpack.config.js', 'webpack.config.ts'],
    description: 'Webpack compilation or OOM failure',
  },

  // ── Docker layer cache miss ──────────────────────────────────────────────
  {
    category: 'missing_docker_layer',
    patterns: [
      /cache.*miss.*layer/i, /layer.*not.*found.*cache/i,
      /failed to.*fetch.*blob/i, /pulling.*layer.*failed/i,
      /COPY.*--from.*not.*found/i,
    ],
    relevantFiles: ['Dockerfile', '.dockerignore'],
    description: 'Docker build layer missing from cache',
  },

  // ── Dockerfile syntax error ──────────────────────────────────────────────
  {
    category: 'dockerfile_syntax',
    patterns: [
      /dockerfile.*parse.*error/i, /unknown instruction/i,
      /invalid.*dockerfile/i, /Dockerfile.*syntax.*error/i,
      /failed to.*read.*dockerfile/i,
    ],
    relevantFiles: ['Dockerfile'],
    description: 'Dockerfile instruction or syntax error',
  },

  // ── Container startup failure ────────────────────────────────────────────
  {
    category: 'container_startup',
    patterns: [
      /container.*did not.*start/i, /container.*health.*unhealthy/i,
      /service.*container.*failed.*start/i, /container.*exited.*during.*startup/i,
      /health.*check.*timed out/i,
    ],
    relevantFiles: ['docker-compose.yml', 'Dockerfile'],
    description: 'Container failed to start or pass health check',
  },

  // ── Registry authentication failure ─────────────────────────────────────
  {
    category: 'registry_auth_failure',
    patterns: [
      /push.*access.*denied.*registry/i, /unauthorized.*registry.*push/i,
      /registry.*authentication.*failed/i, /denied.*push.*image/i,
      /ghcr\.io.*unauthorized/i, /ecr.*auth.*failed/i,
    ],
    relevantFiles: ['Dockerfile'],
    description: 'Container registry push or pull authentication failure',
  },

  // ── Volume mount failure ─────────────────────────────────────────────────
  {
    category: 'volume_mount_failure',
    patterns: [
      /volume.*mount.*failed/i, /bind.*mount.*no such file/i,
      /Error response.*daemon.*volume/i, /cannot.*mount.*volume/i,
      /Mounts denied.*path/i,
    ],
    relevantFiles: ['docker-compose.yml', 'docker-compose.yaml'],
    description: 'Docker volume mount failed',
  },

  // ── OAuth token failure ──────────────────────────────────────────────────
  {
    category: 'oauth_failure',
    patterns: [
      /oauth.*token.*invalid|invalid.*oauth.*token/i,
      /oauth.*expired|token.*expired.*oauth/i,
      /authorization_code.*failed/i, /oauth2.*error/i,
      /refresh_token.*failed/i,
    ],
    relevantFiles: [],
    description: 'OAuth token invalid, expired, or exchange failed',
  },

  // ── Secret manager access denied ─────────────────────────────────────────
  {
    category: 'secret_access_denied',
    patterns: [
      /vault.*permission.*denied/i, /AccessDenied.*Secrets/i,
      /secret.*manager.*access.*denied/i, /vault.*403/i,
      /GetSecretValue.*AccessDeniedException/i,
    ],
    relevantFiles: [],
    description: 'Vault or secret manager access denied',
  },

  // ── Insufficient IAM / RBAC role ────────────────────────────────────────
  {
    category: 'insufficient_role',
    patterns: [
      /is not authorized to perform/i, /insufficient.*permission.*role/i,
      /Action.*not allowed.*role/i, /RBAC.*insufficient.*role/i,
      /User.*cannot.*resource.*policy/i,
    ],
    relevantFiles: [],
    description: 'IAM or RBAC role lacks required permissions',
  },

  // ── Cross-project access denied ──────────────────────────────────────────
  {
    category: 'cross_project_access',
    patterns: [
      /cross.*project.*access.*denied/i, /cross.*org.*unauthorized/i,
      /repository.*not.*accessible.*token/i, /outside.*organization.*access/i,
    ],
    relevantFiles: [],
    description: 'Cross-project or cross-org resource access denied',
  },

  // ── Gradle build failure ─────────────────────────────────────────────────
  {
    category: 'gradle_build_failure',
    patterns: [
      /gradle.*build.*failed/i, /FAILURE.*Build failed.*exception/i,
      /Could not resolve.*gradle/i, /Execution failed.*task.*gradle/i,
      /gradle.*compilation.*failed/i,
    ],
    relevantFiles: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'gradle.properties'],
    description: 'Gradle build or dependency resolution failure',
  },

  // ── Maven build failure ──────────────────────────────────────────────────
  {
    category: 'maven_build_failure',
    patterns: [
      /BUILD FAILURE.*maven|maven.*BUILD FAILURE/i,
      /Could not resolve dependencies.*maven/i, /mojo.*execution.*failed/i,
      /\[ERROR\].*pom\.xml/i, /maven.*lifecycle.*failed/i,
    ],
    relevantFiles: ['pom.xml', '.mvn/', 'settings.xml'],
    description: 'Maven build or dependency resolution failure',
  },

  // ── Artifact not found (download) ───────────────────────────────────────
  {
    category: 'artifact_missing',
    patterns: [
      /artifact.*not found.*download/i, /No artifact.*found with name/i,
      /artifact.*expired/i, /download.*artifact.*failed.*not exist/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Required artifact not found for download step',
  },

  // ── Runtime version mismatch ─────────────────────────────────────────────
  {
    category: 'runtime_version_error',
    patterns: [
      /requires node.*version/i, /node.*version.*does not match/i,
      /python.*version.*required/i, /java.*version.*unsupported/i,
      /engine.*node.*wanted.*got/i, /runtime.*version.*mismatch/i,
    ],
    relevantFiles: ['.nvmrc', '.node-version', 'package.json', '.python-version'],
    description: 'Node/Python/Java runtime version mismatch',
  },

  // ── Null reference / NPE ────────────────────────────────────────────────
  {
    category: 'null_reference',
    patterns: [
      /NullPointerException/i, /Cannot read prop.*of null/i,
      /Cannot read prop.*of undefined/i, /null.*reference.*exception/i,
      /TypeError.*null|TypeError.*undefined/i, /NullReferenceException/i,
    ],
    relevantFiles: [],
    description: 'Null pointer or undefined reference exception',
  },

  // ── Type mismatch / cast error ───────────────────────────────────────────
  {
    category: 'type_mismatch',
    patterns: [
      /ClassCastException/i, /type.*assertion.*failed/i,
      /cannot.*assign.*type/i, /incompatible.*types/i,
      /invalid.*type.*argument/i, /TypeException/i,
    ],
    relevantFiles: [],
    description: 'Type mismatch or invalid type cast error',
  },

  // ── Infinite loop / process hang ─────────────────────────────────────────
  {
    category: 'infinite_loop',
    patterns: [
      /process.*hung|infinite.*loop.*detected/i,
      /job.*timed.*out.*waiting/i, /exceeded.*maximum.*iterations/i,
      /no.*progress.*timeout/i,
    ],
    relevantFiles: [],
    description: 'Process hung or infinite loop detected',
  },

  // ── Stack overflow ───────────────────────────────────────────────────────
  {
    category: 'stack_overflow',
    patterns: [
      /StackOverflowError/i, /maximum.*call.*stack.*size.*exceeded/i,
      /recursion.*depth.*exceeded/i, /stack overflow/i,
    ],
    relevantFiles: [],
    description: 'Stack overflow or recursion limit exceeded',
  },

  // ── Segmentation fault ───────────────────────────────────────────────────
  {
    category: 'segfault',
    patterns: [
      /Segmentation fault/i, /SIGSEGV/i, /signal 11/i,
      /core.*dumped.*segfault/i, /memory.*access.*violation/i,
    ],
    relevantFiles: [],
    description: 'Segmentation fault or SIGSEGV crash',
  },

  // ── Unhandled exception / panic ──────────────────────────────────────────
  {
    category: 'unhandled_exception',
    patterns: [
      /UnhandledPromiseRejection/i, /panic:.*runtime/i,
      /fatal.*unhandled.*exception/i, /Unhandled exception\./i,
      /uncaught.*exception.*process/i, /goroutine.*panic/i,
    ],
    relevantFiles: [],
    description: 'Unhandled exception, panic, or fatal process error',
  },

  // ── Test mock / stub failure ─────────────────────────────────────────────
  {
    category: 'mock_failure',
    patterns: [
      /mock.*not.*called/i, /spy.*not.*invoked/i,
      /stub.*failed.*setup/i, /Cannot spy.*on.*property/i,
      /jest\.mock.*failed/i, /sinon.*mock.*error/i,
    ],
    relevantFiles: [],
    description: 'Test mock or stub setup failure',
  },

  // ── Pipeline stage orchestration failure ─────────────────────────────────
  {
    category: 'pipeline_stage_failure',
    patterns: [
      /stage.*failed.*pipeline/i, /pipeline.*stage.*error/i,
      /downstream.*pipeline.*failed/i, /triggered.*pipeline.*failed/i,
    ],
    relevantFiles: ['.gitlab-ci.yml', '.github/workflows/'],
    description: 'Pipeline stage orchestration failure',
  },

  // ── Stage ordering error ─────────────────────────────────────────────────
  {
    category: 'stage_order_error',
    patterns: [
      /stage.*not.*defined.*pipeline/i, /job.*references.*stage.*not.*defined/i,
      /needs.*job.*not.*found/i, /unknown stage/i,
    ],
    relevantFiles: ['.gitlab-ci.yml', '.github/workflows/'],
    description: 'Job stage dependency ordering error',
  },

  // ── Invalid pipeline trigger ─────────────────────────────────────────────
  {
    category: 'invalid_trigger',
    patterns: [
      /invalid.*trigger.*event/i, /unknown.*event.*trigger/i,
      /trigger.*not.*supported/i, /on:.*invalid.*event/i,
    ],
    relevantFiles: ['.github/workflows/', '.gitlab-ci.yml'],
    description: 'Invalid pipeline trigger or event filter',
  },

  // ── Artifact upload failure ──────────────────────────────────────────────
  {
    category: 'artifact_upload_failure',
    patterns: [
      /artifact.*upload.*failed/i, /Failed to upload artifact/i,
      /upload.*artifact.*error/i, /No files were found.*artifact.*upload/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Artifact upload step failed',
  },

  // ── Cache restore failure ────────────────────────────────────────────────
  {
    category: 'cache_restore_failure',
    patterns: [
      /cache.*restore.*failed/i, /Error restoring cache/i,
      /Failed to restore cache/i, /cache.*key.*not found/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Cache restore step failed',
  },

  // ── Parallel job sync issue ──────────────────────────────────────────────
  {
    category: 'parallel_sync_issue',
    patterns: [
      /parallel.*job.*sync.*failed/i, /race.*condition.*parallel/i,
      /concurrent.*write.*artifact/i, /parallel.*jobs.*conflict/i,
    ],
    relevantFiles: ['.github/workflows/', '.gitlab-ci.yml'],
    description: 'Parallel job synchronization failure',
  },

  // ── Git detached HEAD ────────────────────────────────────────────────────
  {
    category: 'git_detached_head',
    patterns: [
      /HEAD detached at/i, /detached HEAD state/i,
      /not on any branch/i, /git.*detached.*HEAD/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Git detached HEAD state during CI',
  },

  // ── Git commit rejected ──────────────────────────────────────────────────
  {
    category: 'git_commit_rejected',
    patterns: [
      /commit.*rejected.*policy/i, /pre-receive hook.*declined/i,
      /protected branch.*push.*rejected/i, /commit.*not allowed.*branch/i,
      /push.*rejected.*hook/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Git commit rejected by hook or branch policy',
  },

  // ── Git access denied ────────────────────────────────────────────────────
  {
    category: 'git_access_denied',
    patterns: [
      /git.*access.*denied/i, /repository.*not found.*or.*no.*access/i,
      /remote.*error.*access.*denied/i, /permission.*denied.*git/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Git repository access denied',
  },

  // ── Git invalid branch reference ─────────────────────────────────────────
  {
    category: 'git_invalid_branch',
    patterns: [
      /invalid.*branch.*reference/i, /branch.*protected.*cannot.*push/i,
      /refs\/heads.*not.*exist/i, /remote.*branch.*not.*found/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Invalid or protected branch reference',
  },

  // ── Rollback failure ─────────────────────────────────────────────────────
  {
    category: 'rollback_failure',
    patterns: [
      /rollback.*failed/i, /failed to rollback/i,
      /undo.*deployment.*failed/i, /revert.*failed.*deploy/i,
    ],
    relevantFiles: [],
    description: 'Deployment rollback failed',
  },

  // ── Production deployment failure ────────────────────────────────────────
  {
    category: 'failed_production_deploy',
    patterns: [
      /production.*deploy.*failed/i, /deploy.*production.*error/i,
      /prod.*deployment.*failed/i, /release.*to.*production.*failed/i,
    ],
    relevantFiles: [],
    description: 'Production deployment permanently failed',
  },

  // ── Blue-green conflict ──────────────────────────────────────────────────
  {
    category: 'blue_green_conflict',
    patterns: [
      /blue.*green.*conflict/i, /traffic.*switch.*failed/i,
      /blue.*green.*deploy.*error/i, /swap.*slot.*failed/i,
    ],
    relevantFiles: [],
    description: 'Blue-green deployment traffic switch conflict',
  },

  // ── Canary deployment mismatch ───────────────────────────────────────────
  {
    category: 'canary_mismatch',
    patterns: [
      /canary.*version.*mismatch/i, /canary.*deploy.*error/i,
      /canary.*traffic.*failed/i, /canary.*analysis.*failed/i,
    ],
    relevantFiles: [],
    description: 'Canary deployment version mismatch',
  },

  // ── Health check failure ─────────────────────────────────────────────────
  {
    category: 'health_check_failure',
    patterns: [
      /health.*check.*failed/i, /\/health.*returned.*[45]\d\d/i,
      /readiness.*probe.*failed/i, /liveness.*probe.*failed/i,
      /healthcheck.*timeout/i,
    ],
    relevantFiles: [],
    description: 'Service or container health check failure',
  },

  // ── Invalid .gitlab-ci.yml ───────────────────────────────────────────────
  {
    category: 'invalid_gitlab_ci',
    patterns: [
      /gitlab.*ci.*configuration.*invalid/i, /\.gitlab-ci\.yml.*error/i,
      /unknown.*key.*gitlab.*ci/i, /invalid.*ci.*configuration/i,
      /gitlab-ci.*lint.*failed/i,
    ],
    relevantFiles: ['.gitlab-ci.yml'],
    description: 'Invalid .gitlab-ci.yml structure or syntax',
  },

  // ── Invalid GitHub Actions workflow ─────────────────────────────────────
  {
    category: 'invalid_workflow_syntax',
    patterns: [
      /workflow.*file.*invalid/i, /actionlint.*error/i,
      /Invalid workflow file/i, /workflow.*syntax.*error/i,
      /Unexpected value.*workflow/i,
    ],
    relevantFiles: ['.github/workflows/'],
    description: 'Invalid GitHub Actions workflow file structure',
  },

  // ── Missing config file ──────────────────────────────────────────────────
  {
    category: 'missing_config_file',
    patterns: [
      /config.*file.*not found/i, /Cannot find.*config.*file/i,
      /No config.*file.*found/i, /config.*does not exist/i,
      /missing.*configuration.*file/i,
    ],
    relevantFiles: [],
    description: 'Required configuration file not found',
  },

  // ── Config hierarchy error ───────────────────────────────────────────────
  {
    category: 'config_hierarchy_error',
    patterns: [
      /extends.*not found.*config/i, /config.*inheritance.*failed/i,
      /base.*config.*not.*resolve/i, /circular.*extends.*config/i,
    ],
    relevantFiles: ['tsconfig.json', '.eslintrc', 'eslint.config.js'],
    description: 'Config inheritance or hierarchy resolution error',
  },

  // ── Unsupported config parameter ────────────────────────────────────────
  {
    category: 'unsupported_config_param',
    patterns: [
      /unknown.*option.*config/i, /unsupported.*configuration.*key/i,
      /unrecognized.*config.*param/i, /invalid.*option.*schema/i,
    ],
    relevantFiles: [],
    description: 'Unsupported or unknown configuration parameter',
  },

  // ── Duplicate config key ─────────────────────────────────────────────────
  {
    category: 'duplicate_config_key',
    patterns: [
      /duplicate.*key.*yaml/i, /duplicate mapping key/i,
      /duplicate.*entry.*config/i, /key.*already.*defined.*config/i,
    ],
    relevantFiles: ['.github/workflows/', '.gitlab-ci.yml'],
    description: 'Duplicate key in configuration file',
  },

  // ── Environment variable mapping error ───────────────────────────────────
  {
    category: 'env_mapping_error',
    patterns: [
      /env.*variable.*not.*mapped/i, /environment.*injection.*failed/i,
      /secret.*not.*mapped.*env/i, /env.*context.*not.*available/i,
    ],
    relevantFiles: ['.github/workflows/', '.gitlab-ci.yml'],
    description: 'Environment variable mapping or injection failure',
  },
];

export function categorizeError(logs: string, stepNames: string[] = []): ErrorDiagnosis {
  // Prepend step names — they are high-signal (e.g. "Login to Docker Hub")
  // and should be checked first to avoid broad log patterns shadowing them.
  const combined = [...stepNames, logs].join('\n');

  for (const { category, patterns, relevantFiles, description } of PATTERNS) {
    if (patterns.some(p => p.test(combined))) {
      return { category, description, relevantFiles, instructions: INSTRUCTIONS[category] };
    }
  }

  return {
    category: 'unknown',
    description: 'Unclassified CI/CD failure',
    relevantFiles: ['package.json'],
    instructions: INSTRUCTIONS.unknown,
  };
}

// ── Multi-category detection ──────────────────────────────────────────────────
// Returns EVERY matching category ranked by pattern match count (most matches
// first). Callers use this to apply fixers for ALL root causes simultaneously
// rather than stopping at the first pattern hit.

export interface MultiDiagnosis {
  primary: ErrorDiagnosis;
  all: ErrorDiagnosis[];
}

export function categorizeAllErrors(logs: string, stepNames: string[] = []): MultiDiagnosis {
  const combined = [...stepNames, logs].join('\n');

  const matches: Array<{ diagnosis: ErrorDiagnosis; matchCount: number }> = [];

  for (const { category, patterns, relevantFiles, description } of PATTERNS) {
    const matchCount = patterns.filter(p => p.test(combined)).length;
    if (matchCount > 0) {
      matches.push({
        diagnosis: { category, description, relevantFiles, instructions: INSTRUCTIONS[category] },
        matchCount,
      });
    }
  }

  if (matches.length === 0) {
    const fallback: ErrorDiagnosis = {
      category: 'unknown',
      description: 'Unclassified CI/CD failure',
      relevantFiles: ['package.json'],
      instructions: INSTRUCTIONS.unknown,
    };
    return { primary: fallback, all: [fallback] };
  }

  // Sort descending by number of matching patterns — highest match-density first
  matches.sort((a, b) => b.matchCount - a.matchCount);
  const all = matches.map(m => m.diagnosis);
  return { primary: all[0], all };
}
