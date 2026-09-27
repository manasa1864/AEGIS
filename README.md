# AEGIS — Autonomous CI/CD Healing Dashboard

AEGIS monitors your GitHub Actions and GitLab CI pipelines, diagnoses failures the moment they happen, fixes the CI config **and the code in the repo**, and opens a pull request — without you touching anything. It classifies 116 error categories, tries ~1,000 deterministic rules and non-AI strategies before falling back to AI, and verifies the fix by polling CI on the new branch before declaring success.

Every fix PR is **repair-only**: it contains the changes that fix the failure and nothing else — no bundled "best-practice" edits, and never an edit that makes CI green by switching a check off.

---

## How It Works

```
Push to repo
    │
    ▼
AEGIS detects failed workflow run(s)
    │
    ▼
Fetch the logs of every failed job (up to 10) + all failing workflow files
    │   (a run that failed with no jobs = GitHub rejected the workflow file itself)
    ▼
List the repo tree once → fetch every file the logs point at, wherever it lives
(paths relative to a job's working-directory, manifests of every job, moved modules)
    │
    ▼
Static checks (no logs needed — only definitions that are invalid on their own)
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
Repair-only guard — drop optional hardening and any edit that only silences a check
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

AI is step 5 of the healing ladder: grounded Vertex AI first, then Groq, then Gemini. All three are optional — without any key, every non-AI strategy (known fixes, rules, flaky re-run, the repo's own auto-fixers, revert) still runs.

---

## Error Categories — What AEGIS Can Detect and Fix

**Fix column:** *Rule-based* — a deterministic rule fixes it · *Re-run* — transient, re-running the failed jobs heals it with no code change · *Revert* — revert to the last green build · *AI* — needs judgement (rules still fix the specific errors they recognise) · *Owner* — needs credentials or tokens only the repo owner can create

### Simple

| Category | Description | Auto-Fix |
|---|---|---|
| `yaml_syntax` | YAML parse error, tab indentation, missing colon | Rule-based |
| `invalid_workflow_syntax` | GitHub Actions structural / semantic bugs | Rule-based |
| `invalid_gitlab_ci` | `.gitlab-ci.yml` structure / syntax error | Rule-based |
| `actions_deprecation` | Node.js 20 runtime deprecated, stale action versions | Rule-based |
| `env_missing` | Secret or env var not set | Rule-based |
| `secret_missing` | Required Actions secret not configured | Rule-based |
| `missing_file` | Referenced file does not exist | Rule-based |
| `missing_dependency` | npm/yarn ENOENT, cannot find module | Rule-based |
| `node_version` | Node.js version mismatch / unsupported | Rule-based |
| `python_deps` | pip / requirements.txt failure | Rule-based |
| `venv_missing` | Python virtualenv not activated | Rule-based |
| `lockfile_corrupt` | npm/yarn lockfile integrity failure | Rule-based |
| `dependency_vulnerability` | npm audit / pip-audit gate fails on known advisories | Rule-based |
| `build_failure` | Build command exited non-zero | Rule-based |
| `compilation_failure` | TypeScript / Python / Java compilation error | Rule-based |
| `lint_failure` | ESLint / TypeScript / Prettier errors | Rule-based |
| `lint_format_failure` | Prettier / ESLint format check failure | Rule-based |
| `test_failure` | Jest / vitest / mocha / pytest failures | Rule-based |
| `memory_error` | OOM, heap overflow, segfault | Rule-based |
| `permission_denied` | Script not executable, EACCES | Rule-based |
| `permissions_error` | GitHub token missing required scope (403) | Rule-based |
| `concurrency_issue` | Run cancelled by concurrency group | Re-run — a newer run superseded it; nothing is broken |
| `job_timeout` | Job exceeded runner time limit | Rule-based |
| `husky_hook_failure` | Husky pre-commit hooks failing in CI | Rule-based |
| `vite_build_failure` | Vite chunk size / env mode / config error | Rule-based |
| `webpack_build_failure` | Webpack OOM / bundle / config failure | Rule-based |

### Intermediate (Git, Pipeline, Config, Runtime, Testing)

| Category | Description | Auto-Fix |
|---|---|---|
| `git_merge_conflict` | Merge conflict markers in committed files | Rule-based |
| `git_push_rejected` | Push rejected — protected branch or identity | Rule-based |
| `git_submodule_error` | Submodule init / update failure | Rule-based |
| `git_lfs_error` | Git LFS smudge filter failure | Rule-based |
| `git_tag_failure` | git tag / semantic-release failure | Rule-based |
| `git_credential_failure` | git clone / fetch / push auth failure | Rule-based |
| `git_detached_head` | Git detached HEAD state during CI | Rule-based |
| `git_commit_rejected` | Commit rejected by hook or branch policy | Rule-based |
| `git_access_denied` | Repository read/write access denied | Rule-based |
| `git_invalid_branch` | Invalid or protected branch reference | Rule-based |
| `invalid_branch` | Branch reference not found | Rule-based |
| `circular_dependency` | Circular job dependency in pipeline | Rule-based |
| `artifact_failure` | Artifact upload / download failure | Rule-based |
| `artifact_missing` | Required artifact not found for download | Rule-based |
| `artifact_upload_failure` | Artifact / report upload step failed | Rule-based |
| `artifact_retention` | Artifact storage / retention issue | Rule-based |
| `cache_failure` | Cache restore / save failure | Rule-based |
| `cache_restore_failure` | Cache restore step failed | Rule-based |
| `coverage_failure` | Coverage threshold not met | AI — writes tests; thresholds are never lowered |
| `snapshot_mismatch` | Jest / Vitest snapshot mismatch | Rule-based |
| `runner_unavailable` | Runner offline or label typo | Rule-based |
| `e2e_failure` | Playwright / Cypress browser setup failure | Rule-based |
| `mock_failure` | Test mock / stub setup failure | Rule-based |
| `pipeline_stage_failure` | Pipeline stage orchestration failure | Rule-based |
| `stage_order_error` | Job stage dependency ordering error | Rule-based |
| `invalid_trigger` | Invalid pipeline trigger or event filter | Rule-based |
| `parallel_sync_issue` | Parallel job synchronization failure | AI |
| `null_reference` | Null pointer / undefined reference | Rule-based |
| `type_mismatch` | Type cast or type assertion error | Rule-based |
| `infinite_loop` | Process hung / infinite loop | Rule-based |
| `stack_overflow` | Stack overflow / recursion limit | Rule-based |
| `segfault` | Segmentation fault / SIGSEGV | Rule-based |
| `unhandled_exception` | Unhandled exception / panic | Rule-based |
| `missing_config_file` | Required config file not found | Rule-based |
| `config_hierarchy_error` | Config inheritance / hierarchy error | Rule-based |
| `unsupported_config_param` | Unknown config parameter | Rule-based |
| `duplicate_config_key` | Duplicate key in config file | Rule-based |
| `env_mapping_error` | Env var mapping / injection error | Rule-based |

### Advanced (Auth, Docker, Deployment, API, Database)

| Category | Description | Auto-Fix |
|---|---|---|
| `docker_auth` | Docker Hub login / credentials not configured | Rule-based |
| `docker_build` | Dockerfile / image build failure | Rule-based for specific errors (Dockerfile path, unknown / misspelled instructions) · AI otherwise |
| `docker_rate_limit` | Docker Hub pull rate limit (429) | Re-run · authenticate pulls if it persists |
| `dockerfile_syntax` | Dockerfile instruction / syntax error | Rule-based |
| `missing_docker_layer` | Docker build layer missing from cache | Rule-based |
| `container_startup` | Container failed to start | Rule-based |
| `container_health_failure` | Container health check fails | Rule-based |
| `registry_auth_failure` | Registry push/pull auth failure (GHCR, ECR, GCR, ACR) | Rule-based |
| `volume_mount_failure` | Docker volume mount failure | Rule-based |
| `image_pull_failure` | Docker image pull denied / not found | Re-run · then AI / owner (image name or credentials) |
| `oidc_failure` | OIDC/Federated auth for AWS, GCP, Azure | Rule-based |
| `invalid_token` | Expired / invalid API token (401) | Owner — re-issue the token secret |
| `ssh_key_error` | SSH key authentication failure | Rule-based |
| `oauth_failure` | OAuth token invalid / expired | Rule-based |
| `secret_access_denied` | Vault / secret manager access denied | Rule-based |
| `insufficient_role` | IAM / RBAC role lacks required permissions | Rule-based |
| `cross_project_access` | Cross-project / cross-org resource access denied | Rule-based |
| `aws_auth_failure` | AWS credential / IAM role assumption failure | Owner — OIDC role or access-key secrets |
| `gcp_auth_failure` | GCP service account / workload identity failure | Owner — Workload Identity or service-account key |
| `deploy_failure` | Production deployment failure | Rule-based for manifest errors (selector/labels, revision history) · AI otherwise |
| `rollback_failure` | Deployment rollback failed | Rule-based |
| `failed_production_deploy` | Production deployment permanently failed | Revert to last green |
| `blue_green_conflict` | Blue-green traffic switch conflict | Rule-based |
| `canary_mismatch` | Canary deployment version mismatch | Revert to last green |
| `service_unavailable` | Upstream service 503 / 502 | Rule-based |
| `load_balancer_issue` | ALB/ELB/nginx health check failing | AI |
| `health_check_failure` | Service or container health check failure | Rule-based |
| `port_conflict` | Port already bound / EADDRINUSE | Rule-based |
| `api_rate_limit` | API rate limiting (429) | Rule-based |
| `api_timeout` | API / network timeout (ETIMEDOUT) | Rule-based |
| `webhook_failure` | Webhook delivery / signature failure | Rule-based |
| `invalid_api_response` | API returns unexpected HTTP status | Rule-based |
| `rest_endpoint_mismatch` | REST endpoint URL / method mismatch | Rule-based |
| `third_party_failure` | External integration outage (Snyk, Datadog…) | Rule-based |
| `schema_validation` | JSON/OpenAPI schema validation error | AI — the spec itself is fixed; the gate is never switched off |
| `graphql_failure` | GraphQL query / introspection error | Rule-based |
| `terraform_failure` | Terraform init / plan / apply failure | Rule-based |
| `matrix_failure` | Matrix strategy job failure | Rule-based |
| `go_build_failure` | Go module download / build failure | Rule-based |
| `rust_build_failure` | Rust/Cargo compilation or dependency failure | Rule-based |
| `dotnet_build_failure` | .NET restore / build / publish failure | Rule-based |
| `gradle_build_failure` | Gradle build or dependency resolution failure | Rule-based |
| `maven_build_failure` | Maven build or dependency resolution failure | AI (dependency coordinates / repository auth) |
| `runtime_version_error` | Node/Python/Java runtime version mismatch | Rule-based |
| `db_connection_error` | Database connection refused (ECONNREFUSED) | Rule-based |
| `db_migration_error` | Database migration failure | Rule-based |
| `db_deadlock` | Database deadlock detected | Rule-based |
| `db_query_failure` | Query execution failure / timeout | Rule-based |
| `db_replication_lag` | Read replica replication lag | Rule-based |
| `db_schema_mismatch` | Database schema out of sync with models | Rule-based |
| `missing_db_index` | Missing database index causing slow queries | Rule-based |
| `transaction_rollback` | Database transaction rolled back | Rule-based |
| `unknown` | Unclassified failure — no log signal | AI only |

---

## What Is and Isn't Solved

| Feature | Status | Notes |
|---|---|---|
| GitHub Actions integration | Working | Detects all failing workflows per push |
| GitLab CI integration | Working | Full pipeline + job log support |
| Static YAML analysis | Working | Runs before log-based diagnosis; catches bugs with no log output |
| Rule-based auto-fix (~1,000 fixer functions) | Working | Deterministic; no AI key required |
| Repair-only fix PRs | Working | Optional hardening (caching, probes, env niceties) is never mixed into a heal; edits that silence a check (`continue-on-error`, `\|\| true`, lowered coverage…) are rejected |
| Monorepo / subdirectory projects | Working | Repo tree resolves paths relative to each job's `working-directory`; manifest fixes edit the manifest of the failing job |
| Every failed job diagnosed | Working | Up to 10 failed jobs per heal (was 5); runs rejected before any job started are recognised as invalid workflow files |
| Dependency security gates | Working | `npm audit` / `pip-audit` failures → vulnerable direct dependencies upgraded to their first patched release |
| Groq AI analysis | Working | JSON parser fixed (balanced-bracket extraction) |
| Gemini AI analysis | Working | Used as fallback + postmortem generation |
| Vertex AI grounded analysis | Working | Uses Google Search grounding |
| Static fixes merged into commit | Fixed | Were previously computed but orphaned; now correctly merged after AI path |
| Multi-workflow failure detection | Working | Fixes all failing workflows in one PR |
| Automatic branch + PR creation | Working | Branch named `aegis/fix-<timestamp>` |
| CI verification polling | Working | Polls the fix branch; triggers the deep second pass if still red, then escalates to revert |
| Deep second-pass diagnosis | Working | Re-fetches logs from fix branch; runs full fixer pipeline again |
| Iterative healing | Working | Resumes from existing open aegis PRs instead of re-branching |
| Confidence threshold + approval | Working | Pauses at < 65% confidence and shows operator modal |
| Failure memory (embeddings) | Working | Gemini embeddings; surfaces similar past failures |
| MTTR tracking | Working | Recorded per healing event in the backend |
| Postmortem generation | Working | Gemini writes a markdown incident report |
| Safe mode (analysis only) | Working | Proposes fixes without committing anything |
| Dependency Review CI check | Fixed | `.github/workflows/code-quality.yml` added with correct permissions |
| Bitbucket Pipelines | No Not supported | No Bitbucket API integration |
| CircleCI / Jenkins | Not supported | Only GitHub Actions and GitLab CI |
| GitHub Enterprise Server | Not supported | Hardcoded to `github.com` |
| Self-hosted GitLab | Working | Settings → GITLAB_HOST (the instance must allow CORS from the dashboard) |
| Auto-heal | Working | Settings → AUTO_HEAL: while the dashboard is open, a repo whose CI turns red starts healing (30s polling; not a server-side webhook) |
| Non-AI healing strategies | Working | Known-fix replay, compiler suggestions, exact versions, flaky rerun, the repo's own auto-fixers in CI, revert-to-last-green |
| Slack / Teams notifications | Not implemented | No outbound notification channel |
| Live healing view + per-file diffs | Working | Phase stepper, diagnosed causes, each fix's diff and commit status, PR + CI verdict update live |
| Code-level fixes | Working | Surgical edits at the logged file:line — unused imports, prefer-const, ESLint `eqeqeq`/`use-isnan`/`no-var`/`no-console`/unused locals, ruff `E711`/`E722`/`F541`/`B006`, missing TS exports, moved Python modules, `yaml.load`, off-by-one loops, compiler "did you mean", debugger, `.only`, TS2578, null deref, missing packages |
| Fix catalog | Working | `fix-catalog/` — 146 scenarios across 116 categories, simple → complex; every diff is real engine output |
| GitLab MCP tool calls | Partial | MCP bridge server (`server.js`) exists but tool coverage is limited |
| `unknown` category auto-fix | AI only | No rule-based fixer; depends entirely on Groq / Gemini output |

---

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| Node.js | 20+ (CI uses 22) | Frontend + MCP bridge server |
| pnpm | 11 (pinned in `packageManager`; `corepack enable` picks it up) | Package management |
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
pnpm dev:server
```

(`pnpm dev:full` starts the Vite server and the MCP bridge together.) Open `http://localhost:5173` in your browser.

---

## Using the Dashboard

The dashboard does one thing — heal CI — and has three tabs:

| Tab | What it shows |
|---|---|
| **HEALING** | Your repositories and their CI health. Select one and start a heal; the live healing view (below) shows every step. |
| **HISTORY** | Every past heal — root cause, the fix steps applied, alternatives considered, and the generated postmortem report. |
| **INTELLIGENCE** | Totals across heals — success rate, mean time to recover, average AI confidence, outcomes by severity and by provider, recent events. |

Issues, pull requests, branches, releases and security alerts are left to GitHub/GitLab themselves.

**Settings** (gear icon) holds the GitHub / GitLab tokens, a self-hosted **GITLAB_HOST**, the Groq / Gemini / Google Cloud AI keys, and **AUTO_HEAL** — when on, any repository whose CI turns red while the dashboard is open starts healing on its own (checked every 30 s). Keys stay in the browser session; in development they are pre-filled from `.env`.

---

## Project Structure

```
aegis/
├── src/app/
│   ├── components/          # Dashboard (Healing / History / Intelligence), live healing view, settings
│   ├── hooks/
│   │   └── useHealingProcess.ts   # Core healing orchestrator (GitHub + GitLab flows)
│   └── lib/
│       ├── diagnostics.ts         # 116-category error classifier
│       ├── ruleBasedFixer.ts      # Fixer orchestrator (~1,000 rules) + repair-only policy + masking guard
│       ├── healEngine.ts          # Lazy-loaded entry point for the heavy engine
│       ├── healingRun.ts          # Live healing state (pure reducer) behind the UI
│       ├── strategies/            # Healing ladder: known fixes, flaky re-run, auto-fixer CI job, revert, versions
│       ├── fixers/
│       │   ├── simple/            # Syntax, env vars, deps, build
│       │   ├── intermediate/      # Git, pipeline, config, runtime, testing
│       │   ├── advanced/          # Auth, Docker, deployment, API, database, infra manifests
│       │   ├── code/              # Source-code fixers (file:line) + dependency-manifest repairs
│       │   └── workflowJobs.ts    # Jobs, working directories and runtime versions of a workflow
│       ├── groq.ts                # Groq / llama-3.3-70b integration
│       ├── gemini.ts              # Google Gemini integration
│       ├── vertexai.ts            # Vertex AI grounded analysis
│       ├── github.ts              # GitHub REST API client
│       ├── gitlab.ts              # GitLab REST API client
│       ├── contextBuilder.ts      # Lists the repo tree and fetches the files the failure involves
│       ├── fixValidator.ts        # Safety validation before committing
│       ├── jsonExtract.ts         # String-aware JSON extraction from LLM output
│       ├── base64.ts              # UTF-8-safe base64 for GitHub/GitLab contents API
│       ├── sanitize.ts            # Prompt-injection filtering + log chunking
│       ├── yamlCheck.ts           # YAML parse guard for every rule edit
│       └── failureMemory.ts       # Embedding-based past-failure similarity
├── backend/
│   ├── app/
│   │   ├── models/           # SQLAlchemy models (HealingEvent, etc.)
│   │   └── routes/           # Flask REST API (/api/metrics, /api/events)
│   ├── requirements.txt
│   └── run.py
├── tests/                    # Vitest suite (validator, rules, strategies, catalog, UI)
├── fix-catalog/              # One real engine diff per failure scenario (pnpm catalog)
├── scripts/fix-catalog/      # Catalog fixtures + generator
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

### Repair-only

A fix PR contains only changes that fix the failure:

- **Evidence-gated rules.** Rules that read the CI log act only on the error they parse. Rules that read only file content fire on every repo, so during healing they run only when the definition is invalid on its own (a cron field out of range, a step with both `uses:` and `run:`, two compose services on one host port, a Deployment selector that does not match its pod labels…). Optional hardening — caching, probes, notifications, env-var niceties — is never mixed into a heal (`applyRuleBasedFixes(…, { hardening: true })` still offers it for audits).
- **Heal, don't hide.** An edit that only switches the check off is rejected: `continue-on-error: true`, `allow_failure: true`, `|| true`, `fail_ci_if_error: false`, `--passWithNoTests`, or a lowered coverage threshold.

### Reads the whole failure

- **Every failed job.** Logs are read from up to 10 failed jobs sharing one size budget; a run that failed with no jobs is recognised as an invalid workflow file.
- **Two views of the log.** Diagnosis and keyword-matched rules read the error-focused text; parsers of exact tool output (ESLint / tsc / ruff rows, `npm audit` and `pip-audit` reports, pip build output) read the complete log, with runner timestamps and `##[error]` markers stripped.
- **Monorepo-aware context.** The repo tree is listed once, so paths printed relative to a job's `working-directory` (`src/utils/dates.ts` → `services/api/src/utils/dates.ts`) resolve to real files, manifests are fetched from every job directory, and relocated modules, Dockerfiles and `kubectl apply -f` targets are found wherever they live. Each manifest fix edits the manifest that governs the failing job.

### General repairs (examples)

| Error | Repair |
|---|---|
| `EBADENGINE` — job Node below `engines` | Raise that job's `node-version` (to a version the repo already runs) / drop unsupported matrix legs |
| pip: pinned version never published / not for this Python / fails to build | Newest published release from pip's own list, or unpin for the resolver to pick the current release |
| `npm audit` / `pip-audit` gate | Each vulnerable direct dependency → first patched release (npm's own "Will install …" choice when printed; major upgrades flagged) |
| Merge conflict markers (`TS1185`, `<<<<<<<`) | Keep HEAD, flagged for review |
| ESLint `eqeqeq` / `use-isnan` / `no-var` / `no-console` / unused locals | Mechanical fix at the reported row (side-effect-free initializers only) |
| ruff/flake8 `E711` `E722` `F541` `B006` | Standard rewrite (`is None`, `except Exception`, plain string, `None` default + init) |
| `TS2459` / `TS2305` — name declared but not exported | Add `export` to the declaration |
| `No module named 'pkg.mod'` after a move | Rewrite the import to where the module lives now |
| `Cannot find package '@vitejs/plugin-react'` with `-swc` installed | Import the installed variant; otherwise declare the package in the importing package's `package.json` |
| Jest 28+ with `jsdom` not installed | `node` environment for DOM-less packages, else add `jest-environment-jsdom` |
| `Cannot read properties of undefined` inside `i <= arr.length` | Fix the loop bound (instead of optional chaining) |
| Invalid cron, missing Dockerfile path, glued/misspelled Dockerfile instruction, missing bind-mount source, `revisionHistoryLimit: 0`, artifact path ≠ build output dir, download before upload, venv never created, script not executable | Targeted one-line repairs |

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

[`fix-catalog/`](fix-catalog/README.md) has one `.diff` per failure scenario (146 scenarios, 116 error categories), numbered from the simplest fix to the most complex. Scenarios healed without a rule diff — re-run (transient), revert (a release regression), the AI step (needs judgement) or the repo owner (credentials) — say so instead of showing an invented fix:

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
| GitHub Actions | Yes | Yes | Yes |
| GitLab CI | Yes | Yes | Yes (MR) |
| Bitbucket Pipelines | No | No | No |
| CircleCI | No | No | No |
| Jenkins | No | No | No |

---

## Screenshots & Demo

> *Add screenshots here before publishing — visuals are the first thing reviewers look at.*
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
- **Repair-only healing** (`repairs.test.ts`) — a healthy repo gets no changes; masking edits are rejected; job/working-directory parsing; manifest, lint, infra and code repairs including their edge cases (no side-effecting deletes, no guessing between several packages); repo-tree context resolution; diagnosis false positives.
- **Healing ladder** (`strategies.test.ts`) — known-fix replay, flaky detection, autofix job output parsing, version pinning.
- **Hook wiring** (`hookWiring.test.ts`) — guards against the history wrappers calling themselves (a regression that froze every heal at its first step).

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, and a production build on every push and pull request.

---

## Safety Model

AEGIS commits changes to *other people's repositories*, so several layers guard against destructive output:

1. **Fix validation** (`fixValidator.ts`) — every fix is checked for path traversal, absolute paths, dangerous shell patterns (`rm -rf /`, curl-pipe-to-shell, fork bombs…), invalid JSON, tab-indented YAML, and **YAML that no longer parses** before commit. Blocked fixes are dropped and logged.
2. **Repair-only policy** (`ruleBasedFixer.ts`) — rules that need no log evidence may change a file only when its definition is invalid on its own; optional hardening never rides along in a fix PR.
3. **Masking guard** — an edit that turns CI green by silencing the check (`continue-on-error: true`, `allow_failure: true`, `|| true`, `fail_ci_if_error: false`, `--passWithNoTests`, a lowered coverage threshold) is rejected.
4. **Composition safety** — rules are applied one at a time; a rule whose edit would make a valid YAML file unparseable is discarded on its own (the others still apply), no rule is applied twice to the same file, and line-precise fixers keep addressing the line numbers the tools printed even after an earlier fixer removed lines.
5. **Surgical source edits** — application code is only ever changed at the exact file/line a compiler, linter, test runner or stack trace names; older rules that rewrote whole files now see CI/config files only.
6. **Raw content for commits** — prompt-injection sanitising is applied only when text is sent to an AI model, never to the content that gets committed.
7. **Prompt-injection filtering** (`sanitize.ts`) — repository content and CI logs are untrusted input; known injection phrasings are stripped before any text reaches an AI model.
8. **Branch isolation** — fixes are only ever committed to a new `aegis/fix-<timestamp>` branch and opened as a PR/MR. AEGIS never pushes to the default branch.
9. **Confidence gate** — below 65% aggregate confidence, healing pauses and asks the operator for approval instead of proceeding.
10. **Safe mode** — analysis-only mode proposes fixes without committing anything.

Known residual risks: the AI providers can still produce semantically wrong (but structurally safe) fixes, and the injection filter is pattern-based, not exhaustive. Review AEGIS PRs like any other contributor's.

---

## Design Decisions & FAQ

**Why rules before AI?** Deterministic fixers are free, instant, reproducible, and auditable. AI is the fallback for the long tail, not the first resort.

**How are conflicting fixes resolved?** Fixes are threaded sequentially through the orchestrator — each rule sees the previous rule's output — and finally deduplicated by file path, with static YAML fixes merged before AI fixes.

**Why doesn't a fix PR include "best-practice" improvements?** A PR that fixes a failure should be easy to review and safe to merge. Caching, probes, notification tweaks and similar improvements change behaviour nobody asked to change, so they are left out of heals; they are still available with `{ hardening: true }` for an explicit audit.

**Why won't AEGIS make a failing check non-blocking?** Because that hides the failure instead of healing it. When a failure can't be fixed in code — an expired token, missing cloud credentials — AEGIS reports what the owner needs to do rather than switching the check off.

**Does it understand monorepos?** Yes. Tools print paths relative to the directory a job runs in; AEGIS lists the repo tree and maps those paths to real files, reads the manifests of every job directory, and edits the `package.json` / `requirements.txt` that governs the failing job.

**What stops a destructive patch?** The validator layer above, plus branch isolation: worst case is a bad PR that a human closes.

**When does AEGIS intentionally *not* open a PR?** When all candidate fixes are blocked by the validator, when confidence is below the gate and the operator rejects, or when no fixer or AI provider produces any change.

---

## Roadmap

- Server-side webhook trigger (heal on `workflow_run.completed` even when the dashboard is closed — today's auto-heal runs in the open dashboard)
- Bitbucket Pipelines / CircleCI support
- GitHub Enterprise Server base URLs (self-hosted GitLab is supported)
- Slack / Teams outbound notifications
- Unified diff approval for every PR (today the approval gate triggers below 65% confidence)

---

## License

MIT — see [LICENSE](LICENSE).
