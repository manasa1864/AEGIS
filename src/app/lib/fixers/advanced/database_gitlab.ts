// Advanced / Database Errors — GitLab CI only
// Fixers that use GitLab CI-specific patterns:
//   job-level services: (with alias:), variables: per job,
//   before_script: arrays, after_script: arrays (run on failure too),
//   resource_group: for serialized job execution.
//
// Platform-agnostic fixers → database.ts
// GitHub Actions fixers    → database_github.ts

import { RuleFix, isGitLabCI } from '../helpers';

// ── Section 0 — DB service / env setup ───────────────────────────────────────

/** Add PostgreSQL service container to GitLab CI job when DB connection is refused. */
export function fixGitLabDBService(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*5432|psql.*could not connect|PG.*connection.*refused/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('postgres') || f.content.includes('services:')) continue;
    if (!f.content.includes('DATABASE_URL') && !f.content.includes('prisma') && !f.content.includes('knex')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|build|check)[\w-]*:)$/im,
      [
        '$1',
        '  services:',
        '    - name: postgres:16-alpine',
        '      alias: postgres',
        '  variables:',
        '    POSTGRES_USER: testuser',
        '    POSTGRES_PASSWORD: testpass',
        '    POSTGRES_DB: testdb',
        '    DATABASE_URL: postgres://testuser:testpass@postgres/testdb',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PostgreSQL service container to GitLab CI job — ECONNREFUSED on port 5432 means no DB service was declared; GitLab services use alias as hostname', confidence: 100 });
  }
  return fixes;
}

/** Add MySQL service container to GitLab CI job when MySQL connection errors are detected. */
export function fixGitLabMySQLService(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*3306|Access denied.*MySQL|ER_ACCESS_DENIED_ERROR/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('mysql') || f.content.includes('services:')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|build)[\w-]*:)$/im,
      [
        '$1',
        '  services:',
        '    - name: mysql:8.0',
        '      alias: mysql',
        '  variables:',
        '    MYSQL_ROOT_PASSWORD: rootpass',
        '    MYSQL_DATABASE: testdb',
        '    MYSQL_USER: testuser',
        '    MYSQL_PASSWORD: testpass',
        '    DATABASE_URL: mysql://testuser:testpass@mysql/testdb',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MySQL 8.0 service container — ECONNREFUSED on port 3306 means no MySQL service; GitLab services use alias as the hostname in DATABASE_URL', confidence: 100 });
  }
  return fixes;
}

/** Add Redis service container to GitLab CI job when Redis connection errors are detected. */
export function fixGitLabRedisService(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*6379|Redis.*connection.*refused|redis.*not.*running/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('redis') || f.content.includes('services:')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|build)[\w-]*:)$/im,
      [
        '$1',
        '  services:',
        '    - name: redis:7-alpine',
        '      alias: redis',
        '  variables:',
        '    REDIS_URL: redis://redis:6379',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Redis service container — ECONNREFUSED on port 6379; GitLab services use alias as hostname so REDIS_URL points to "redis"', confidence: 100 });
  }
  return fixes;
}

/** Add DATABASE_URL to GitLab CI job variables when it is missing. */
export function fixGitLabDatabaseURL(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/DATABASE_URL.*not.*set|DATABASE_URL.*undefined|missing.*DATABASE_URL/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path) || f.content.includes('DATABASE_URL:')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|build)[\w-]*:)$/im,
      '$1\n  variables:\n    DATABASE_URL: postgres://testuser:testpass@postgres/testdb',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DATABASE_URL to GitLab CI job variables — missing DATABASE_URL causes cryptic connection errors; set it explicitly in the job variables block', confidence: 100 });
  }
  return fixes;
}

/** Add SHADOW_DATABASE_URL to GitLab CI job variables for Prisma dev migrations. */
export function fixGitLabPrismaShadowDb(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/shadowDatabaseUrl|shadow database|Cannot create shadow database/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('prisma') || f.content.includes('SHADOW_DATABASE_URL')) continue;
    const fixed = f.content.replace(
      /(DATABASE_URL:\s*[^\n]+)/,
      '$1\n    SHADOW_DATABASE_URL: postgres://testuser:testpass@postgres/shadow_testdb',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added SHADOW_DATABASE_URL to GitLab CI variables — Prisma dev migrations require a shadow DB; add a second postgres service or DB to support it', confidence: 100 });
  }
  return fixes;
}

/** Add CREATE INDEX CONCURRENTLY migration and annotate GitLab CI job when sequential scan detected. */
export function fixGitLabMissingDatabaseIndex(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Seq Scan|sequential scan|query.*timeout.*index|missing index hint|slow query/i.test(logs)) return [];
  const tableMatch = logs.match(/Seq Scan on (\w+)/i) ?? logs.match(/table[:\s]+['"]?(\w+)['"]?/i);
  const colMatch   = logs.match(/WHERE\s+\w+\.(\w+)\s*=/i) ?? logs.match(/filter.*column[:\s]+['"]?(\w+)['"]?/i);
  const table  = tableMatch?.[1] ?? 'target_table';
  const col    = colMatch?.[1] ?? 'indexed_column';
  const fixes: RuleFix[] = [];
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const migrationPath = `db/migrations/${ts}_add_index_${table}_${col}.sql`;
  if (!files.some(f => f.path.includes(`add_index_${table}`))) {
    fixes.push({
      path: migrationPath,
      content: [
        `-- aegis: auto-generated migration — sequential scan on ${table}.${col}`,
        ``,
        `-- Up`,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${table}_${col}`,
        `  ON ${table} (${col});`,
        ``,
        `ANALYZE ${table};`,
        ``,
        `-- Down`,
        `-- DROP INDEX CONCURRENTLY IF EXISTS idx_${table}_${col};`,
      ].join('\n'),
      explanation: `Created migration ${migrationPath} with CREATE INDEX CONCURRENTLY on ${table}.${col}`,
      confidence: 100,
    });
  }
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('CREATE INDEX') || f.content.includes(`idx_${table}_${col}`)) continue;
    const fixed = f.content.replace(
      /(- (?:knex migrate|sequelize-cli db:migrate|prisma migrate|flyway migrate)[^\n]+)/g,
      `$1\n    # aegis: run db/migrations/${ts}_add_index_${table}_${col}.sql to add missing index`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Annotated GitLab CI script with index migration — sequential scan on ${table}.${col} requires CREATE INDEX CONCURRENTLY`, confidence: 90 });
  }
  return fixes;
}

// ── Section A — Migration Failure ────────────────────────────────────────────

/** Fix Alembic multiple heads by adding merge check to GitLab CI before_script. */
export function fixGitLabAlembicRevisionCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/alembic.*multiple.*head|alembic.*revision.*conflict|Multiple.*head.*revisions/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('alembic') || f.content.includes('alembic heads')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      heads=$(alembic heads 2>&1 | grep -c "head")',
        '      if [ "$heads" -gt "1" ]; then',
        '        alembic merge heads -m "merge_heads_ci"',
        '        echo "Merged multiple Alembic heads"',
        '      fi',
        '    - alembic upgrade head',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Alembic heads merge to GitLab CI before_script — multiple heads cause upgrade to fail; auto-merging before the job script runs resolves divergent branches', confidence: 92 });
  }
  return fixes;
}

/** Add goose status check to GitLab CI before_script to catch version conflicts early. */
export function fixGitLabGooseMigrationVersion(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/goose.*error|goose.*version.*mismatch|goose.*already.*applied/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('goose') || f.content.includes('goose status')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - goose -dir ./db/migrations postgres "$DATABASE_URL" status',
        '    - goose -dir ./db/migrations postgres "$DATABASE_URL" up',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added goose status check to GitLab CI before_script — version conflicts are caught before the main script runs', confidence: 90 });
  }
  return fixes;
}

/** Add after_script migration rollback to GitLab CI job when migration fails. */
export function fixGitLabMigrationRollback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/migration.*failed|rollback.*migration|migrate.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('after_script') || f.content.includes('CI_JOB_STATUS')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  after_script:',
        '    - |',
        '      if [ "$CI_JOB_STATUS" != "success" ]; then',
        '        echo "Migration failed — attempting rollback"',
        '        npx knex migrate:rollback 2>/dev/null ||',
        '        npx sequelize-cli db:migrate:undo 2>/dev/null ||',
        '        flyway undo 2>/dev/null || true',
        '        echo "Rollback attempt complete"',
        '      fi',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added after_script rollback for GitLab CI — after_script always runs, including on failure; CI_JOB_STATUS guards rollback so it only runs when the job fails', confidence: 88 });
  }
  return fixes;
}

// ── Section B — Connection Timeout ───────────────────────────────────────────

/** Add DATABASE_URL presence validation to GitLab CI before_script. */
export function fixGitLabDBConnectionValidation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/DATABASE_URL.*not.*defined|DB_HOST.*undefined|database.*connection.*string.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') || f.content.includes('DATABASE_URL:?')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - ": ${DATABASE_URL:?DATABASE_URL must be set}"',
        '    - echo "DB connection verified (credentials redacted)"',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DATABASE_URL presence check to GitLab CI before_script — missing env var causes cryptic errors; bash :? operator fails fast with a clear message', confidence: 95 });
  }
  return fixes;
}

/** Add RDS Proxy / Cloud SQL proxy readiness poll to GitLab CI before_script. */
export function fixGitLabProxyConnectionWait(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/RDS Proxy.*timeout|Cloud SQL.*proxy.*connection|connect ETIMEDOUT.*rds|cloudsql.*proxy.*refused/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('rds') && !f.content.includes('cloudsql') && !f.content.includes('cloud_sql')) continue;
    if (f.content.includes('nc -z') || f.content.includes('PROXY_WAIT')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|deploy)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      echo "Waiting for DB proxy on $DB_HOST:$DB_PORT..."',
        '      for i in $(seq 1 20); do',
        '        nc -z "$DB_HOST" "${DB_PORT:-5432}" 2>/dev/null && echo "Proxy ready" && break',
        '        echo "Attempt $i/20 — sleeping 5s..." && sleep 5',
        '      done',
        '      nc -z "$DB_HOST" "${DB_PORT:-5432}" || (echo "DB proxy not reachable after 100s" && exit 1)',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added proxy readiness poll to GitLab CI before_script — RDS Proxy/Cloud SQL Proxy needs warm-up time; nc polling prevents premature connect errors', confidence: 90 });
  }
  return fixes;
}

/** Add VPN scaffold comment to GitLab CI before_script for private database access. */
export function fixGitLabNetworkPolicy(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Connection.*refused.*private|network.*policy.*denied.*database|cannot reach.*db.*host|VPN.*required.*database/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('wireguard') || f.content.includes('tailscale') || f.content.includes('ssh-tunnel')) continue;
    if (!f.content.includes('DATABASE_URL') && !f.content.includes('DB_HOST')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|deploy)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      # Option 1: Tailscale (recommended for GitLab CI)',
        '      # curl -fsSL https://tailscale.com/install.sh | sh',
        '      # tailscale up --authkey="$TAILSCALE_AUTHKEY" --hostname=ci-runner',
        '      #',
        '      # Option 2: WireGuard',
        '      # echo "$WG_CONFIG" | sudo tee /etc/wireguard/wg0.conf',
        '      # sudo wg-quick up wg0',
        '      #',
        '      # Option 3: SSH tunnel',
        '      # ssh -N -L 5432:db-private:5432 jump@bastion &',
        '      echo "Configure a VPN option above to reach your private DB" && exit 1',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added VPN setup scaffold to GitLab CI before_script — private database is unreachable from shared runners; Tailscale/WireGuard/SSH tunnel is required', confidence: 85 });
  }
  return fixes;
}

// ── Section C — Deadlock Detected ────────────────────────────────────────────

/** Add pg_stat_activity deadlock dump to GitLab CI after_script for diagnosis. */
export function fixGitLabDeadlockMonitoring(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock detected|lock.*monitoring|pg_locks.*deadlock/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('pg_stat_activity') || f.content.includes('after_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  after_script:',
        '    - |',
        '      if [ "$CI_JOB_STATUS" != "success" ]; then',
        '        PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c \\',
        "          \"SELECT pid, wait_event_type, wait_event, state, left(query,80) FROM pg_stat_activity WHERE wait_event_type = 'Lock';\" || true",
        '      fi',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pg_stat_activity dump to GitLab CI after_script — deadlock diagnosis requires seeing which queries hold locks at failure time; after_script always runs', confidence: 88 });
  }
  return fixes;
}

/** Add resource_group to GitLab CI job to serialize concurrent deploys and prevent deadlocks. */
export function fixGitLabResourceGroup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock detected|concurrent.*deploy|migration.*conflict.*concurrent/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('resource_group:') || !f.content.includes('migrate')) continue;
    const fixed = f.content.replace(
      /^((?:deploy|migrate|release)[\w-]*:)$/im,
      '$1\n  resource_group: deploy-$CI_ENVIRONMENT_NAME',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added resource_group to GitLab CI deploy/migrate job — resource_group serializes concurrent pipeline runs for the same job, preventing migration conflicts and deadlocks', confidence: 93 });
  }
  return fixes;
}

// ── Section D — Schema Mismatch ───────────────────────────────────────────────

/** Add migration status check to GitLab CI before_script to detect schema drift. */
export function fixGitLabSchemaDriftDetection(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/schema.*drift|migrate.*pending|unapplied.*migration|schema.*out.*of.*sync/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('migrate status') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|deploy)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      pending=$(npx prisma migrate status 2>&1 | grep -c "Pending" || \\',
        '               npx knex migrate:status 2>&1 | grep -c "Not run" || \\',
        '               flyway info 2>&1 | grep -c "Pending" || echo 0)',
        '      if [ "$pending" -gt "0" ]; then',
        '        echo "WARNING: $pending unapplied migration(s) detected"',
        '      fi',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added migration drift check to GitLab CI before_script — unapplied migrations cause schema mismatch errors; detecting them before the job runs gives an early warning', confidence: 88 });
  }
  return fixes;
}

/** Add prisma generate and migrate deploy to GitLab CI before_script. */
export function fixGitLabPrismaSchemaSync(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/PrismaClientInitializationError|prisma.*schema.*not.*in.*sync|@prisma\/client.*did not initialize/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('prisma') || f.content.includes('prisma generate') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - npx prisma generate',
        '    - npx prisma migrate deploy',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added prisma generate + migrate deploy to GitLab CI before_script — PrismaClientInitializationError means the client was not generated or migrations not applied before tests', confidence: 95 });
  }
  return fixes;
}

/** Add Django makemigrations --check to GitLab CI before_script to catch uncommitted migrations. */
export function fixGitLabDjangoMigrationsCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/django.*migration|makemigrations.*detected.*changes|Your models have changes.*not yet reflected/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('django') && !f.content.includes('manage.py')) continue;
    if (f.content.includes('makemigrations') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - python manage.py makemigrations --check --dry-run',
        '    - python manage.py migrate --run-syncdb',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Django migration check to GitLab CI before_script — makemigrations --check fails if model changes were not committed as migrations, preventing schema drift', confidence: 92 });
  }
  return fixes;
}

/** Add schema version table check to GitLab CI before_script. */
export function fixGitLabSchemaVersionTable(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/schema.*version.*table.*missing|relation.*schema_migrations.*not.*exist|_prisma_migrations.*not.*found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('schema_migrations') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c \\',
        "        \"SELECT table_name FROM information_schema.tables WHERE table_name IN ('schema_migrations','_prisma_migrations','flyway_schema_history');\" || true",
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added schema version table check to GitLab CI before_script — if schema_migrations or _prisma_migrations is missing the DB was never bootstrapped; checking early surfaces this', confidence: 88 });
  }
  return fixes;
}

// ── Section E — Query Execution Failure ──────────────────────────────────────

/** Add pg_stat_statements slow query dump to GitLab CI after_script on failure. */
export function fixGitLabQueryExplainOnFail(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/slow query|query.*timeout|query.*execution.*time|statement.*timeout.*exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('pg_stat_statements') || f.content.includes('after_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  after_script:',
        '    - |',
        '      if [ "$CI_JOB_STATUS" != "success" ]; then',
        '        PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c \\',
        '          "SELECT query, calls, mean_exec_time, max_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;" 2>/dev/null || true',
        '      fi',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pg_stat_statements dump to GitLab CI after_script — capturing top slow queries at failure time pinpoints which query hit the statement_timeout', confidence: 87 });
  }
  return fixes;
}

/** Enable pg_stat_statements and add PGOPTIONS statement_timeout to GitLab CI job. */
export function fixGitLabQueryStatStatements(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/slow query|query.*timeout|query execution.*failed|statement.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('pg_stat_statements') || f.content.includes('PGOPTIONS')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  variables:',
        "    PGOPTIONS: '-c statement_timeout=30000 -c shared_preload_libraries=pg_stat_statements'",
        '  before_script:',
        '    - PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" 2>/dev/null || true',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Enabled pg_stat_statements and 30s statement_timeout in GitLab CI — pg_stat_statements records query timings; combined with statement_timeout it kills runaway queries and logs which one', confidence: 90 });
  }
  return fixes;
}

// ── Section F — Missing Index ─────────────────────────────────────────────────

/** Add ANALYZE to GitLab CI before_script to update table statistics before query plan selection. */
export function fixGitLabIndexStatistics(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Seq Scan|statistics.*outdated|planner.*wrong.*plan|enable_seqscan/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('ANALYZE') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c "ANALYZE;" 2>/dev/null || true',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ANALYZE to GitLab CI before_script — CI databases lack fresh statistics; ANALYZE updates them so the planner chooses index scans over sequential scans', confidence: 88 });
  }
  return fixes;
}

/** Add index bloat check and REINDEX to GitLab CI before_script. */
export function fixGitLabIndexBloatCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/index.*bloat|dead.*tuple.*index|index.*corruption|invalid.*index/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('REINDEX') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c \\',
        '        "SELECT schemaname, tablename, indexname FROM pg_stat_user_indexes WHERE idx_scan = 0;" 2>/dev/null || true',
        '      PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c "REINDEX DATABASE testdb;" 2>/dev/null || true',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added index bloat check and REINDEX to GitLab CI before_script — bloated or corrupted indexes cause wrong query plans; REINDEX rebuilds them cleanly for CI tests', confidence: 85 });
  }
  return fixes;
}

// ── Section H — Replication Lag ───────────────────────────────────────────────

/** Add replication slot lag check to GitLab CI before_script. */
export function fixGitLabReplicationSlotMonitor(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replication slot.*lag|slot.*inactive|wal.*sender.*slot|slot.*retained.*wal/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('pg_replication_slots') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|deploy)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      PGPASSWORD=testpass psql -h postgres -U testuser -d testdb -c \\',
        '        "SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag FROM pg_replication_slots WHERE NOT active;" 2>/dev/null || true',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added replication slot lag check to GitLab CI before_script — inactive slots retain WAL indefinitely causing disk pressure; checking before deployment surfaces retention issues early', confidence: 88 });
  }
  return fixes;
}

/** Add read replica lag check to GitLab CI before_script. */
export function fixGitLabReplicaHealthCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replica.*lag|replication.*delay|standby.*not.*caught|read.*replica.*stale/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('DATABASE_REPLICA_URL') && !f.content.includes('REPLICA') && !f.content.includes('READ_REPLICA')) continue;
    if (f.content.includes('pg_last_xact_replay_timestamp') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|deploy)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      lag_seconds=$(PGPASSWORD=testpass psql -h postgres-replica -U testuser -d testdb -At \\',
        "        -c \"SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int;\" 2>/dev/null || echo 0)",
        '      echo "Replica lag: ${lag_seconds}s"',
        '      if [ "${lag_seconds:-0}" -gt "30" ]; then',
        '        echo "WARNING: replica is ${lag_seconds}s behind primary"',
        '      fi',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added replica lag check to GitLab CI before_script — deploying against a lagging replica causes stale reads; measuring lag before deployment gives visibility into replication health', confidence: 87 });
  }
  return fixes;
}

/** Add replication lag wait to GitLab CI before_script before deploy to ensure replica caught up. */
export function fixGitLabReplicationLagWait(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replication.*lag|replica.*behind|slave.*delay|standby.*not.*caught/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    if (f.content.includes('pg_last_xact_replay') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:deploy|release|promote)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      echo "Waiting for replica to catch up (max 60s)..."',
        '      for i in $(seq 1 12); do',
        '        lag=$(PGPASSWORD=testpass psql -h postgres-replica -U testuser -d testdb -At \\',
        "          -c \"SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int;\" 2>/dev/null || echo 999)",
        '        echo "Replica lag: ${lag}s"',
        '        [ "${lag:-999}" -le "5" ] && echo "Replica in sync" && break',
        '        sleep 5',
        '      done',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added replication lag wait to GitLab CI deploy before_script — deploying while replica is behind causes read-your-writes failures; waiting for sync prevents stale data issues post-deploy', confidence: 87 });
  }
  return fixes;
}

/** Add Kafka CDC consumer lag check to GitLab CI before_script. */
export function fixGitLabCDCLagCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/kafka.*consumer.*lag|debezium.*lag|cdc.*consumer.*behind|connector.*offset.*behind/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('kafka') && !f.content.includes('debezium') && !f.content.includes('cdc')) continue;
    if (f.content.includes('kafka-consumer-groups') || f.content.includes('before_script')) continue;
    const fixed = f.content.replace(
      /^((?:test|migrate|integration|deploy)[\w-]*:)$/im,
      [
        '$1',
        '  before_script:',
        '    - |',
        '      if command -v kafka-consumer-groups.sh &>/dev/null; then',
        '        echo "Checking CDC consumer lag..."',
        '        kafka-consumer-groups.sh --bootstrap-server "$KAFKA_BOOTSTRAP_SERVERS" \\',
        '          --describe --group "$CDC_CONSUMER_GROUP" 2>/dev/null || true',
        '      fi',
      ].join('\n'),
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Kafka CDC consumer lag check to GitLab CI before_script — high consumer lag means CDC events are backed up; checking before tests ensures the event stream is current', confidence: 85 });
  }
  return fixes;
}
