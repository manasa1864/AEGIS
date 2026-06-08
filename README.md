# AEGIS — Autonomous CI/CD Healing Dashboard

AEGIS monitors your GitHub Actions and GitLab CI pipelines, diagnoses failures the moment they happen, generates workflow fixes, and opens a pull request — all without you touching anything. It classifies 144 distinct error categories, runs 800+ deterministic rule-based fixers before falling back to AI, and verifies the fix by polling CI on the new branch before declaring success.

---

## How It Works

```
Push to repo
    │
    ▼
AEGIS detects failed workflow run(s)
    │
    ▼
Fetch all failing workflow files + job logs
    │
    ▼
Static YAML analysis (no logs needed — catches syntax bugs immediately)
    │
    ▼
Log-based error classification → 144 categories, ranked by confidence
    │
    ├── Rule-based fixers match? ──YES──► Apply 800+ deterministic fixes
    │                                            │
    └── No match / unknown ──────────────► AI analysis (Groq → Vertex AI → Gemini)
                                                 │
    ◄────────────────────────────────────────────┘
    │
    ▼
Merge static fixes + AI/rule fixes (deduped by file path)
    │
    ▼
Safety validation — block destructive or malformed fixes
    │
    ▼
Confidence < 65%? → Pause and show approval modal to operator
    │
    ▼
Create fix branch → commit fixes → open PR/MR
    │
    ▼
Poll CI on fix branch (60s) → deep second-pass diagnosis if still red
    │
    ▼
Record MTTR, save failure embedding for future similarity matching
```

---

## AI Providers

| Provider | Model | Used for |
|---|---|---|
| Groq | llama-3.3-70b-versatile | Primary AI analysis (fast, free tier) |
| Google Vertex AI | gemini-2.0-flash (grounded) | Grounded analysis with live search |
| Google Gemini | gemini-2.0-flash | Fallback AI + postmortem generation |

The system tries Groq first, then Vertex AI, then Gemini. All three are optional — if none are configured, only rule-based fixes run.

---

## Error Categories — What AEGIS Can Detect and Fix

### Simple (always run, no logs needed)

| Category | Description | Auto-Fix |
|---|---|---|
| `yaml_syntax` | YAML parse error, tab indentation, missing colon | ✅ Rule-based |
| `invalid_workflow_syntax` | GitHub Actions structural / semantic bugs | ✅ Rule-based |
| `invalid_gitlab_ci` | `.gitlab-ci.yml` structure / syntax error | ✅ Rule-based |
| `actions_deprecation` | Node.js 20 runtime deprecated, stale action versions | ✅ Rule-based |
| `env_missing` | Secret or env var not set | ✅ Rule-based |
| `secret_missing` | Required Actions secret not configured | ✅ Rule-based |
| `missing_file` | Referenced file does not exist | ✅ Rule-based |
| `missing_dependency` | npm/yarn ENOENT, cannot find module | ✅ Rule-based |
| `node_version` | Node.js version mismatch / unsupported | ✅ Rule-based |
| `python_deps` | pip / requirements.txt failure | ✅ Rule-based |
| `venv_missing` | Python virtualenv not activated | ✅ Rule-based |
| `lockfile_corrupt` | npm/yarn lockfile integrity failure | ✅ Rule-based |
| `build_failure` | Build command exited non-zero | ✅ Rule-based |
| `compilation_failure` | TypeScript / Python / Java compilation error | ✅ Rule-based |
| `lint_failure` | ESLint / TypeScript / Prettier errors | ✅ Rule-based |
| `lint_format_failure` | Prettier / ESLint format check failure | ✅ Rule-based |
| `test_failure` | Jest / vitest / mocha / pytest failures | ✅ Rule-based |
| `memory_error` | OOM, heap overflow, segfault | ✅ Rule-based |
| `permission_denied` | Script not executable, EACCES | ✅ Rule-based |
| `permissions_error` | GitHub token missing required scope (403) | ✅ Rule-based |
| `concurrency_issue` | Run cancelled by concurrency group | ✅ Rule-based |
| `job_timeout` | Job exceeded runner time limit | ✅ Rule-based |
| `husky_hook_failure` | Husky pre-commit hooks failing in CI | ✅ Rule-based |
| `vite_build_failure` | Vite chunk size / env mode / config error | ✅ Rule-based |
| `webpack_build_failure` | Webpack OOM / bundle / config failure | ✅ Rule-based |

### Intermediate (Git, Pipeline, Config, Runtime, Testing)

| Category | Description | Auto-Fix |
|---|---|---|
| `git_merge_conflict` | Merge conflict markers in committed files | ✅ Rule-based |
| `git_push_rejected` | Push rejected — protected branch or identity | ✅ Rule-based |
| `git_submodule_error` | Submodule init / update failure | ✅ Rule-based |
| `git_lfs_error` | Git LFS smudge filter failure | ✅ Rule-based |
| `git_tag_failure` | git tag / semantic-release failure | ✅ Rule-based |
| `git_credential_failure` | git clone / fetch / push auth failure | ✅ Rule-based |
| `git_detached_head` | Git detached HEAD state during CI | ✅ Rule-based |
| `git_commit_rejected` | Commit rejected by hook or branch policy | ✅ Rule-based |
| `git_access_denied` | Repository read/write access denied | ✅ Rule-based |
| `git_invalid_branch` | Invalid or protected branch reference | ✅ Rule-based |
| `invalid_branch` | Branch reference not found | ✅ Rule-based |
| `circular_dependency` | Circular job dependency in pipeline | ✅ Rule-based |
| `artifact_failure` | Artifact upload / download failure | ✅ Rule-based |
| `artifact_retention` | Artifact storage / retention issue | ✅ Rule-based |
| `cache_failure` | Cache restore / save failure | ✅ Rule-based |
| `coverage_failure` | Coverage threshold not met | ✅ Rule-based |
| `snapshot_mismatch` | Jest / Vitest snapshot mismatch | ✅ Rule-based |
| `runner_unavailable` | Runner offline or label typo | ✅ Rule-based |
| `e2e_failure` | Playwright / Cypress browser setup failure | ✅ Rule-based |
| `mock_failure` | Test mock / stub setup failure | ✅ Rule-based |
| `pipeline_stage_failure` | Pipeline stage orchestration failure | ✅ Rule-based |
| `stage_order_error` | Job stage dependency ordering error | ✅ Rule-based |
| `invalid_trigger` | Invalid pipeline trigger or event filter | ✅ Rule-based |
| `parallel_sync_issue` | Parallel job synchronization failure | ✅ Rule-based |
| `null_reference` | Null pointer / undefined reference | ✅ Rule-based |
| `type_mismatch` | Type cast or type assertion error | ✅ Rule-based |
| `infinite_loop` | Process hung / infinite loop | ✅ Rule-based |
| `stack_overflow` | Stack overflow / recursion limit | ✅ Rule-based |
| `segfault` | Segmentation fault / SIGSEGV | ✅ Rule-based |
| `unhandled_exception` | Unhandled exception / panic | ✅ Rule-based |
| `missing_config_file` | Required config file not found | ✅ Rule-based |
| `config_hierarchy_error` | Config inheritance / hierarchy error | ✅ Rule-based |
| `unsupported_config_param` | Unknown config parameter | ✅ Rule-based |
| `duplicate_config_key` | Duplicate key in config file | ✅ Rule-based |
| `env_mapping_error` | Env var mapping / injection error | ✅ Rule-based |

### Advanced (Auth, Docker, Deployment, API, Database)

| Category | Description | Auto-Fix |
|---|---|---|
| `docker_auth` | Docker Hub login / credentials not configured | ✅ Rule-based |
| `docker_build` | Dockerfile / image build failure | ✅ Rule-based |
| `docker_rate_limit` | Docker Hub pull rate limit (429) | ✅ Rule-based |
| `dockerfile_syntax` | Dockerfile instruction / syntax error | ✅ Rule-based |
| `missing_docker_layer` | Docker build layer missing from cache | ✅ Rule-based |
| `container_startup` | Container failed to start | ✅ Rule-based |
| `container_health_failure` | Container health check fails | ✅ Rule-based |
| `registry_auth_failure` | Registry push/pull auth failure (GHCR, ECR, GCR, ACR) | ✅ Rule-based |
| `volume_mount_failure` | Docker volume mount failure | ✅ Rule-based |
| `image_pull_failure` | Docker image pull denied / not found | ✅ Rule-based |
| `oidc_failure` | OIDC/Federated auth for AWS, GCP, Azure | ✅ Rule-based |
| `invalid_token` | Expired / invalid API token (401) | ✅ Rule-based |
| `ssh_key_error` | SSH key authentication failure | ✅ Rule-based |
| `oauth_failure` | OAuth token invalid / expired | ✅ Rule-based |
| `secret_access_denied` | Vault / secret manager access denied | ✅ Rule-based |
| `insufficient_role` | IAM / RBAC role lacks required permissions | ✅ Rule-based |
| `cross_project_access` | Cross-project / cross-org resource access denied | ✅ Rule-based |
| `aws_auth_failure` | AWS credential / IAM role assumption failure | ✅ Rule-based |
| `gcp_auth_failure` | GCP service account / workload identity failure | ✅ Rule-based |
| `deploy_failure` | Production deployment failure | ✅ Rule-based |
| `rollback_failure` | Deployment rollback failed | ✅ Rule-based |
| `failed_production_deploy` | Production deployment permanently failed | ✅ Rule-based |
| `blue_green_conflict` | Blue-green traffic switch conflict | ✅ Rule-based |
| `canary_mismatch` | Canary deployment version mismatch | ✅ Rule-based |
| `service_unavailable` | Upstream service 503 / 502 | ✅ Rule-based |
| `load_balancer_issue` | ALB/ELB/nginx health check failing | ✅ Rule-based |
| `health_check_failure` | Service or container health check failure | ✅ Rule-based |
| `port_conflict` | Port already bound / EADDRINUSE | ✅ Rule-based |
| `api_rate_limit` | API rate limiting (429) | ✅ Rule-based |
| `api_timeout` | API / network timeout (ETIMEDOUT) | ✅ Rule-based |
| `webhook_failure` | Webhook delivery / signature failure | ✅ Rule-based |
| `invalid_api_response` | API returns unexpected HTTP status | ✅ Rule-based |
| `rest_endpoint_mismatch` | REST endpoint URL / method mismatch | ✅ Rule-based |
| `third_party_failure` | External integration outage (Snyk, Datadog…) | ✅ Rule-based |
| `schema_validation` | JSON/OpenAPI schema validation error | ✅ Rule-based |
| `graphql_failure` | GraphQL query / introspection error | ✅ Rule-based |
| `terraform_failure` | Terraform init / plan / apply failure | ✅ Rule-based |
| `matrix_failure` | Matrix strategy job failure | ✅ Rule-based |
| `go_build_failure` | Go module download / build failure | ✅ Rule-based |
| `rust_build_failure` | Rust/Cargo compilation or dependency failure | ✅ Rule-based |
| `dotnet_build_failure` | .NET restore / build / publish failure | ✅ Rule-based |
| `gradle_build_failure` | Gradle build or dependency resolution failure | ✅ Rule-based |
| `maven_build_failure` | Maven build or dependency resolution failure | ✅ Rule-based |
| `runtime_version_error` | Node/Python/Java runtime version mismatch | ✅ Rule-based |
| `db_connection_error` | Database connection refused (ECONNREFUSED) | ✅ Rule-based |
| `db_migration_error` | Database migration failure | ✅ Rule-based |
| `db_deadlock` | Database deadlock detected | ✅ Rule-based |
| `db_query_failure` | Query execution failure / timeout | ✅ Rule-based |
| `db_replication_lag` | Read replica replication lag | ✅ Rule-based |
| `db_schema_mismatch` | Database schema out of sync with models | ✅ Rule-based |
| `missing_db_index` | Missing database index causing slow queries | ✅ Rule-based |
| `transaction_rollback` | Database transaction rolled back | ✅ Rule-based |
| `unknown` | Unclassified failure — no log signal | ⚠️ AI only |

---

## What Is and Isn't Solved

| Feature | Status | Notes |
|---|---|---|
| GitHub Actions integration | ✅ Working | Detects all failing workflows per push |
| GitLab CI integration | ✅ Working | Full pipeline + job log support |
| Static YAML analysis | ✅ Working | Runs before log-based diagnosis; catches bugs with no log output |
| Rule-based auto-fix (800+ fixers) | ✅ Working | Deterministic; no AI key required |
| Groq AI analysis | ✅ Working | JSON parser fixed (balanced-bracket extraction) |
| Gemini AI analysis | ✅ Working | Used as fallback + postmortem generation |
| Vertex AI grounded analysis | ✅ Working | Uses Google Search grounding |
| Static fixes merged into commit | ✅ Fixed | Were previously computed but orphaned; now correctly merged after AI path |
| Multi-workflow failure detection | ✅ Working | Fixes all failing workflows in one PR |
| Automatic branch + PR creation | ✅ Working | Branch named `aegis/fix-<timestamp>` |
| CI verification polling | ✅ Working | Polls fix branch up to 60s; triggers deep diagnosis if still red |
| Deep second-pass diagnosis | ✅ Working | Re-fetches logs from fix branch; runs full fixer pipeline again |
| Iterative healing | ✅ Working | Resumes from existing open aegis PRs instead of re-branching |
| Confidence threshold + approval | ✅ Working | Pauses at < 65% confidence and shows operator modal |
| Failure memory (embeddings) | ✅ Working | Gemini embeddings; surfaces similar past failures |
| MTTR tracking | ✅ Working | Recorded per healing event in the backend |
| Postmortem generation | ✅ Working | Gemini writes a markdown incident report |
| Safe mode (analysis only) | ✅ Working | Proposes fixes without committing anything |
| Dependency Review CI check | ✅ Fixed | `.github/workflows/code-quality.yml` added with correct permissions |
| Bitbucket Pipelines | ❌ Not supported | No Bitbucket API integration |
| CircleCI / Jenkins | ❌ Not supported | Only GitHub Actions and GitLab CI |
| GitHub Enterprise Server | ❌ Not supported | Hardcoded to `github.com` |
| Webhook auto-trigger | ❌ Not implemented | Healing must be triggered manually from the dashboard |
| Slack / Teams notifications | ❌ Not implemented | No outbound notification channel |
| Fix dry-run diff preview | ❌ Not implemented | Proposed fixes shown as text only, no unified diff |
| GitLab MCP tool calls | ⚠️ Partial | MCP bridge server (`server.js`) exists but tool coverage is limited |
| `unknown` category auto-fix | ⚠️ AI only | No rule-based fixer; depends entirely on Groq / Gemini output |

---

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| Node.js | 18 or 20 | Frontend + MCP bridge server |
| pnpm | 8+ | Package management |
| Python | 3.10+ | Flask backend |
| PostgreSQL | 14+ | Backend database (or use Render / Supabase) |

---

## Environment Variables

Create `.env` in the project root (copy from `.env.example`):

```env
# GitHub — required for GitHub Actions healing
VITE_GITHUB_PAT=ghp_...

# GitLab — required for GitLab CI healing
VITE_GITLAB_PAT=glpat-...

# AI providers — at least one required for AI analysis
VITE_GEMINI_KEY=...         # Google Gemini (also used for postmortems + embeddings)
VITE_GROQ_KEY=...           # Groq / llama-3.3-70b (fastest, has a free tier)
VITE_GCLOUD_KEY=...         # Google Vertex AI with grounding (optional)
```

Create `backend/.env` for the Flask server:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/aegis
SECRET_KEY=change-me-in-production
```

---

## How to Run

### 1. Install frontend dependencies

```bash
pnpm install
```

### 2. Set up the Python backend

```bash
cd backend

# Create and activate a virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### 3. Start everything

Open **three terminals** from the project root:

**Terminal 1 — Vite dev server (port 5173)**
```bash
pnpm dev
```

**Terminal 2 — Flask backend (port 5000)**
```bash
cd backend
python run.py
```

**Terminal 3 — MCP bridge for GitLab (port 3001, optional)**
```bash
node server.js
```

Open `http://localhost:5173` in your browser.

---

## Project Structure

```
aegis/
├── src/app/
│   ├── components/          # React UI components
│   ├── hooks/
│   │   └── useHealingProcess.ts   # Core healing orchestrator
│   └── lib/
│       ├── diagnostics.ts         # 144-category error classifier
│       ├── ruleBasedFixer.ts      # Fixer orchestrator (800+ rules)
│       ├── fixers/
│       │   ├── simple/            # Syntax, env vars, deps, build
│       │   ├── intermediate/      # Git, pipeline, config, runtime, testing
│       │   └── advanced/          # Auth, Docker, deployment, API, database
│       ├── groq.ts                # Groq / llama-3.3-70b integration
│       ├── gemini.ts              # Google Gemini integration
│       ├── vertexai.ts            # Vertex AI grounded analysis
│       ├── github.ts              # GitHub REST API client
│       ├── gitlab.ts              # GitLab REST API client
│       ├── contextBuilder.ts      # Fetches relevant extra files per error category
│       ├── fixValidator.ts        # Safety validation before committing
│       └── failureMemory.ts       # Embedding-based past-failure similarity
├── backend/
│   ├── app/
│   │   ├── models/           # SQLAlchemy models (HealingEvent, etc.)
│   │   └── routes/           # Flask REST API (/api/metrics, /api/events)
│   ├── requirements.txt
│   └── run.py
├── server.js                 # MCP bridge server (GitLab MCP → REST)
├── vite.config.ts            # Proxies /api/groq and /api/gemini to avoid CORS
└── .github/
    └── workflows/
        └── code-quality.yml  # Dependency Review CI check
```

---

## Supported Platforms

| Platform | Detect failures | Fetch logs | Auto-fix + PR |
|---|---|---|---|
| GitHub Actions | ✅ | ✅ | ✅ |
| GitLab CI | ✅ | ✅ | ✅ (MR) |
| Bitbucket Pipelines | ❌ | ❌ | ❌ |
| CircleCI | ❌ | ❌ | ❌ |
| Jenkins | ❌ | ❌ | ❌ |
