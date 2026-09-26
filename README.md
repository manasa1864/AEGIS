# AEGIS — Autonomous CI/CD Healing Dashboard

AEGIS monitors your GitHub Actions and GitLab CI pipelines, diagnoses failures the moment they happen, generates workflow fixes, and opens a pull request — all without you touching anything. It classifies 116 distinct error categories, runs 950+ deterministic rule-based fixer functions before falling back to AI, and verifies the fix by polling CI on the new branch before declaring success.

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
+ every source file the logs point at (stack frames, compiler/linter file:line)
    │
    ▼
Static YAML analysis (no logs needed — catches syntax bugs immediately)
    │
    ▼
Log-based error classification → 116 categories, ranked by confidence
    │
    ▼
Healing ladder — each strategy is a backup for the one before it:
    1. Known fix       replay a fix that already turned this exact error green
    2. Rules           deterministic rules + compiler "did you mean" + exact versions
    3. Flaky check     re-run failed jobs; green → change nothing  (first, if causes are transient)
    4. Auto-fixers     the repo's own eslint/prettier/ruff/black/gofmt/clippy/lockfile in CI
    5. AI              grounded Gemini → Groq → Gemini (refuses partially-seen files)
    6. Revert          revert to the last green build, candidates validated on CI
    │
    ▼
Merge static fixes + AI/rule fixes (deduped by file path)
    │
    ▼
Safety validation — block destructive or malformed fixes (incl. any fix that breaks YAML parsing)
    │
    ▼
Confidence < 65%? → Pause and show approval modal to operator
    │
    ▼
Create fix branch → commit fixes → open PR/MR
    │
    ▼
Poll CI on fix branch → deep second pass if still red → still red? escalate to revert-to-last-green
    │
    ▼
Record MTTR, save failure embedding for future similarity matching
```

---

## AI Providers

| Provider | Model | Used for |
|---|---|---|
| Groq | llama-3.3-70b-versatile | Primary AI analysis (fast, free tier) |
| Google Vertex AI | gemini-flash-latest (grounded) | Grounded analysis with live search |
| Google Gemini | gemini-flash-latest | Fallback AI + postmortem generation |

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
| `artifact_missing` | Required artifact not found for download | ✅ Rule-based |
| `artifact_upload_failure` | Artifact / report upload step failed | ✅ Rule-based |
| `artifact_retention` | Artifact storage / retention issue | ✅ Rule-based |
| `cache_failure` | Cache restore / save failure | ✅ Rule-based |
| `cache_restore_failure` | Cache restore step failed | ✅ Rule-based |
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
| Rule-based auto-fix (950+ fixer functions) | ✅ Working | Deterministic; no AI key required |
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
| Self-hosted GitLab | ✅ Working | Settings → GITLAB_HOST (the instance must allow CORS from the dashboard) |
| Auto-heal | ✅ Working | Settings → AUTO_HEAL: while the dashboard is open, a repo whose CI turns red starts healing (30s polling; not a server-side webhook) |
| Non-AI healing strategies | ✅ Working | Known-fix replay, compiler suggestions, exact versions, flaky rerun, the repo's own auto-fixers in CI, revert-to-last-green |
| Slack / Teams notifications | ❌ Not implemented | No outbound notification channel |
| Live healing view + per-file diffs | ✅ Working | Phase stepper, diagnosed causes, each fix's diff and commit status, PR + CI verdict update live |
| Code-level fixes | ✅ Working | Surgical edits at the logged file:line (unused imports, prefer-const, debugger, `.only`, TS2578, null deref, missing packages) |
| Fix catalog | ✅ Working | `fix-catalog/` — 131 real engine diffs across 115 categories, simple → complex |
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
│       ├── diagnostics.ts         # 116-category error classifier
│       ├── ruleBasedFixer.ts      # Fixer orchestrator (950+ rules)
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
│       ├── jsonExtract.ts         # String-aware JSON extraction from LLM output
│       ├── base64.ts              # UTF-8-safe base64 for GitHub/GitLab contents API
│       ├── sanitize.ts            # Prompt-injection filtering + log chunking
│       └── failureMemory.ts       # Embedding-based past-failure similarity
├── backend/
│   ├── app/
│   │   ├── models/           # SQLAlchemy models (HealingEvent, etc.)
│   │   └── routes/           # Flask REST API (/api/metrics, /api/events)
│   ├── requirements.txt
│   └── run.py
├── tests/                    # Vitest suite (validator, sanitizer, healing smoke tests)
├── server.js                 # MCP bridge server (GitLab MCP → REST)
├── vite.config.ts            # Proxies /api/groq and /api/gemini to avoid CORS
└── .github/
    └── workflows/
        ├── ci.yml            # Typecheck + tests + build on every push/PR
        └── code-quality.yml  # Dependency Review check
```

---

## Healing Ladder (non-AI first)

Aegis tries strategies in a fixed order — cheapest, safest and most proven first; AI is the last resort before reverting. Every result passes the same safety validator (YAML parse, dangerous-pattern, path checks) before anything is committed, and the live view shows each strategy as *used / no fix / skipped / not needed*.

| # | Strategy | What it does | Cost |
|---|---|---|---|
| 1 | **Known fix** | Replays a fix that previously resolved the identical error (hashed error signature), only if every file it touches is byte-identical to before | instant |
| 2 | **Rules** | ~1,000 deterministic rules, surgical code fixers, and the compiler's own *did you mean* suggestions (TypeScript, Python, rustc). `"latest"` versions are resolved to exact ones from npm / PyPI | instant |
| 3 | **Flaky check** | Re-runs only the failed jobs; if they pass, nothing is changed. Runs *before* the rules when every diagnosed cause is transient (timeouts, rate limits, runners) | one CI rerun |
| 4 | **Auto-fixers** | Pushes a throwaway branch with a tiny CI job that runs the repo's **own** tools with its own config — `eslint --fix`, `prettier --write`, `ruff`, `black`, `isort`, `gofmt`, `go mod tidy`, `cargo fmt`, `cargo clippy --fix`, `dotnet format`, lockfile refresh — and reads the changed files back from the log. The job is read-only and the branch is deleted | one CI job |
| 5 | **AI** | Search-grounded Gemini → Groq → Gemini, with the low-confidence approval gate. Rewrites of files the model saw only partially are refused | API call |
| 6 | **Revert** | Finds the last green run, builds candidate reverts (each recent commit alone, then the whole range), validates them on CI in parallel and opens a PR for the first that goes green | parallel CI runs |

After a fix PR is opened, CI on the fix branch is verified; if it stays red after the deep second pass, Aegis escalates to step 6. When a fix changes declared dependencies, the lockfile is regenerated by the auto-fixer job so `npm ci` / `pnpm install --frozen-lockfile` keep working.

---

## Live Healing View

While a heal runs, the repository page shows the run as it happens, not a static graph:

- **Pipeline stepper** — DETECT → ANALYZE → DIAGNOSE → FIX → VALIDATE → COMMIT → PR → VERIFY, each marked active / done / failed / skipped, with elapsed time.
- **System graph** — node colours come from the real run (a node stays green once its phase is done, turns red if it failed); edges animate only where work is flowing.
- **What failed** — failing workflows, jobs and steps, commit SHA, link to the run.
- **Diagnosed root causes** — every matched error category, primary first.
- **Changes** — one row per file with source (RULE / AI / STATIC / DEEP_PASS / RESUME), status (PROPOSED → COMMITTING → COMMITTED, or BLOCKED / FAILED with the reason), and an expandable unified diff.
- **Outcome** — PR link, CI result on the fix branch, and the *actual* reason when a run halts (the old overlay always said "NO_PROGRESS_DETECTED").
- The CI health panel re-scans at each milestone and polls while healing. Demo mode (no PAT) runs the real rule engine on a sample workflow, so its diffs are genuine too.

State lives in `src/app/lib/healingRun.ts` (pure reducer), rendered by `HealingProgressPanel.tsx`, `DiffView.tsx` and `SystemGraph.tsx`.

---

## Fix Catalog

[`fix-catalog/`](fix-catalog/README.md) has one `.diff` per failure scenario (131 scenarios, 115 error categories), numbered from the simplest fix to the most complex:

| Tier | Folder | What it covers |
|---|---|---|
| 1 | `01-simple/` | One-line CI config, syntax and toolchain-setup fixes |
| 2 | `02-code/` | Surgical edits to application code at the logged file:line |
| 3 | `03-intermediate/` | Tests, builds, git, artifacts, caching, orchestration, runtime |
| 4 | `04-advanced/` | Auth, containers, APIs, databases, infrastructure, deploy strategies |

Each diff begins with a `#` header (error, CI log excerpt, explanation of every change) and applies with `git apply`. The diffs are **generated from real engine output** (`pnpm catalog`, fixtures in `scripts/fix-catalog/fixtures.ts`); every one has been checked to apply cleanly and reproduce the engine's result byte-for-byte, and `tests/fixCatalog.test.ts` fails if a fixer stops producing its fix or the committed diffs go stale.

---

## Supported Platforms

| Platform | Detect failures | Fetch logs | Auto-fix + PR |
|---|---|---|---|
| GitHub Actions | ✅ | ✅ | ✅ |
| GitLab CI | ✅ | ✅ | ✅ (MR) |
| Bitbucket Pipelines | ❌ | ❌ | ❌ |
| CircleCI | ❌ | ❌ | ❌ |
| Jenkins | ❌ | ❌ | ❌ |

---

## Screenshots & Demo

> 📸 *Add screenshots here before publishing — visuals are the first thing reviewers look at.*
>
> Suggested captures (place them in `docs/screenshots/` and embed below):
> 1. Dashboard with a repo in `HEALING` state
> 2. The healing log stream (`DIAGNOSIS → FIX → PR_CREATED`)
> 3. The opened pull request with AEGIS-generated fixes
> 4. The confidence approval modal (< 65% confidence)
> 5. A generated postmortem report
>
> A 60–90 second GIF of *CI fails → AEGIS detects → PR opens → pipeline turns green* communicates the whole product in one loop.

---

## Testing

The repo ships with a Vitest suite covering the safety-critical offline pipeline — no network or API keys required:

```bash
pnpm test          # run once
pnpm test:watch    # watch mode
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint (react-hooks rules included)
```

What is covered:

- **`fixValidator`** — path traversal, absolute paths, dangerous shell patterns, malformed JSON/YAML fixes are blocked before any commit.
- **`sanitize`** — prompt-injection phrases in CI logs are filtered before reaching any AI model; oversized logs are chunked around error lines.
- **`jsonExtract`** — LLM responses with markdown fences, leading/trailing prose, and unbalanced braces inside string literals all parse correctly.
- **`base64`** — UTF-8 file content round-trips safely through the GitHub/GitLab contents API (the naive `atob`/`btoa` path corrupted non-ASCII characters and threw on commit).
- **Healing smoke tests** — `logs → categorizeAllErrors → applyRuleBasedFixes → validateFixes` runs end-to-end for both GitHub Actions and GitLab CI failures, across a representative spread of simple / intermediate / advanced categories, and never produces a fix that fails its own safety validation.
- **Category coverage** — every declared error category (except the intentional `unknown` AI-only fallback) is asserted to have a diagnosis pattern and a crash-free fixer path, so the README table can never silently drift from the code again.
- **Fix catalog** — every scenario in `fix-catalog/` still produces a validated fix, every diagnosable category has a scenario, and the committed diffs match current engine output.
- **Code-level fixers, YAML safety, diffs, live UI** — exact-output tests for the source-code fixers; YAML composition safety; unified-diff format (incl. `\ No newline at end of file`); the healing-run state machine; and a server-side render of the live progress panel and graph.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, and a production build on every push and pull request.

---

## Safety Model

AEGIS commits changes to *other people's repositories*, so several layers guard against destructive output:

1. **Fix validation** (`fixValidator.ts`) — every fix is checked for path traversal, absolute paths, dangerous shell patterns (`rm -rf /`, curl-pipe-to-shell, fork bombs…), invalid JSON, tab-indented YAML, and **YAML that no longer parses** before commit. Blocked fixes are dropped and logged.
1. **Composition safety** (`ruleBasedFixer.ts`) — rules are applied one at a time; a rule whose edit would make a valid YAML file unparseable is discarded on its own (the others still apply), and no rule is applied twice to the same file.
1. **Surgical source edits** — application code is only ever changed at the exact file/line a compiler, linter, test runner or stack trace names; older rules that rewrote whole files now see CI/config files only.
1. **Raw content for commits** — prompt-injection sanitising is applied only when text is sent to an AI model, never to the content that gets committed.
2. **Prompt-injection filtering** (`sanitize.ts`) — repository content and CI logs are untrusted input; known injection phrasings are stripped before any text reaches an AI model.
3. **Branch isolation** — fixes are only ever committed to a new `aegis/fix-<timestamp>` branch and opened as a PR/MR. AEGIS never pushes to the default branch.
4. **Confidence gate** — below 65% aggregate confidence, healing pauses and asks the operator for approval instead of proceeding.
5. **Safe mode** — analysis-only mode proposes fixes without committing anything.

Known residual risks: the AI providers can still produce semantically wrong (but structurally safe) fixes, and the injection filter is pattern-based, not exhaustive. Review AEGIS PRs like any other contributor's.

---

## Design Decisions & FAQ

**Why rules before AI?** Deterministic fixers are free, instant, reproducible, and auditable. AI is the fallback for the long tail, not the first resort.

**How are conflicting fixes resolved?** Fixes are threaded sequentially through the orchestrator — each rule sees the previous rule's output — and finally deduplicated by file path, with static YAML fixes merged before AI fixes.

**What stops a destructive patch?** The validator layer above, plus branch isolation: worst case is a bad PR that a human closes.

**When does AEGIS intentionally *not* open a PR?** When all candidate fixes are blocked by the validator, when confidence is below the gate and the operator rejects, or when no fixer or AI provider produces any change.

---

## Roadmap

- Webhook auto-trigger (heal on `workflow_run.completed` instead of manual start)
- Unified diff preview before commit
- Bitbucket Pipelines / CircleCI support
- GitHub Enterprise Server / self-hosted GitLab base URLs
- Slack / Teams outbound notifications
- Analytics dashboard: fixes by category, rule-vs-AI ratio, MTTR trend

---

## License

MIT — see [LICENSE](LICENSE).
