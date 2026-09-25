// Advanced / Database Errors — GitHub Actions only
// Fixers that use GitHub Actions-specific patterns:
//   service containers, insertStepBefore (- name:/run: steps),
//   if: failure() conditionals, $GITHUB_ENV writes, concurrency: groups.
//
// Platform-agnostic fixers → database.ts
// GitLab CI fixers          → database_gitlab.ts

import { RuleFix, isGitHubWorkflow, insertStepBefore, injectWorkflowLevelBlock } from '../helpers';

/** Add Prisma shadow DATABASE_URL under the env: block of a GitHub Actions workflow. */
export function fixPrismaShadowDb(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/shadowDatabaseUrl|shadow database|Cannot create shadow database/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('prisma') || f.content.includes('SHADOW_DATABASE_URL')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      out.push(line);
      if (/DATABASE_URL:/.test(line) && !modified) {
        out.push(line.replace('DATABASE_URL:', 'SHADOW_DATABASE_URL:').replace(/\/([\w-]+)$/, '/shadow_$1'));
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added SHADOW_DATABASE_URL for Prisma — dev migrations require a shadow database to detect schema drift', confidence: 100 });
  }
  return fixes;
}

/** Generate a CREATE INDEX CONCURRENTLY migration and annotate the GitHub Actions workflow. */
export function fixMissingDatabaseIndex(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Seq Scan|sequential scan|query.*timeout.*index|missing index hint|slow query/i.test(logs)) return [];
  const tableMatch = logs.match(/Seq Scan on (\w+)/i) ?? logs.match(/table[:\s]+['"]?(\w+)['"]?/i);
  const colMatch   = logs.match(/WHERE\s+\w+\.(\w+)\s*=/i) ?? logs.match(/filter.*column[:\s]+['"]?(\w+)['"]?/i);
  const table  = tableMatch?.[1] ?? 'target_table';
  const col    = colMatch?.[1] ?? 'indexed_column';
  const idxName = `idx_${table}_${col}`;
  const fixes: RuleFix[] = [];
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const migrationPath = `db/migrations/${ts}_add_index_${table}_${col}.sql`;
  if (!files.some(f => f.path.includes(`add_index_${table}`))) {
    fixes.push({
      path: migrationPath,
      content: [
        `-- aegis: auto-generated migration — sequential scan detected on ${table}.${col}`,
        ``,
        `-- Up`,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idxName}`,
        `  ON ${table} (${col});`,
        ``,
        `ANALYZE ${table};`,
        ``,
        `-- Down`,
        `-- DROP INDEX CONCURRENTLY IF EXISTS ${idxName};`,
        ``,
      ].join('\n'),
      explanation: `Created migration with CREATE INDEX CONCURRENTLY on ${table}.${col} — sequential scan detected`,
      confidence: 100,
    });
  }
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('CREATE INDEX') || f.content.includes(idxName)) continue;
    const fixed = f.content.replace(
      /(run:\s*(?:knex migrate|sequelize-cli db:migrate|prisma migrate|flyway migrate)[^\n]+)/g,
      `$1\n          # aegis: run db/migrations/${ts}_add_index_${table}_${col}.sql\n          # psql $DATABASE_URL -f db/migrations/${ts}_add_index_${table}_${col}.sql`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added index migration annotation — sequential scan on ${table}.${col} requires CREATE INDEX CONCURRENTLY`, confidence: 100 });
  }
  return fixes;
}

/** Add a PostgreSQL service container to a GitHub Actions workflow. */
export function fixMissingDBService(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*5432|psql.*could not connect|PG.*connection.*refused/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Skip only when a database service is actually declared — a DATABASE_URL
    // like postgresql://… contains "postgres" but provides no server.
    if (/^\s+services:/m.test(f.content) || /image:\s*['"]?postgres/i.test(f.content)) continue;
    if (!f.content.includes('DATABASE_URL') && !f.content.includes('prisma') && !f.content.includes('knex')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      out.push(line);
      if (/^\s+runs-on:/.test(line) && !modified) {
        out.push('    services:');
        out.push('      postgres:');
        out.push('        image: postgres:16-alpine');
        out.push('        env:');
        out.push('          POSTGRES_USER: testuser');
        out.push('          POSTGRES_PASSWORD: testpass');
        out.push('          POSTGRES_DB: testdb');
        out.push('        ports:');
        out.push("          - '5432:5432'");
        out.push('        options: >-');
        out.push('          --health-cmd pg_isready');
        out.push('          --health-interval 10s');
        out.push('          --health-timeout 5s');
        out.push('          --health-retries 5');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added PostgreSQL service container — tests connect to a DB but no service was configured', confidence: 100 });
  }
  return fixes;
}

/** Add DATABASE_URL env var at workflow level when it is missing. */
export function fixMissingDatabaseURL(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/DATABASE_URL.*not.*set|DATABASE_URL.*undefined|missing.*DATABASE_URL/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || f.content.includes('DATABASE_URL:')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DATABASE_URL: postgres://testuser:testpass@localhost:5432/testdb',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DATABASE_URL env var — tests required a database URL but none was configured', confidence: 100 });
  }
  return fixes;
}

/** Add a MySQL 8.0 service container to a GitHub Actions workflow. */
export function fixMissingMySQLService(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*3306|Access denied.*MySQL|ER_ACCESS_DENIED_ERROR/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('mysql') || f.content.includes('services:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      out.push(line);
      if (/^\s+runs-on:/.test(line) && !modified) {
        out.push('    services:');
        out.push('      mysql:');
        out.push('        image: mysql:8.0');
        out.push('        env:');
        out.push('          MYSQL_ROOT_PASSWORD: rootpass');
        out.push('          MYSQL_DATABASE: testdb');
        out.push('          MYSQL_USER: testuser');
        out.push('          MYSQL_PASSWORD: testpass');
        out.push('        ports:');
        out.push("          - '3306:3306'");
        out.push('        options: --health-cmd "mysqladmin ping" --health-interval 10s --health-timeout 5s --health-retries 5');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added MySQL 8.0 service container — ECONNREFUSED on port 3306 means no MySQL service in workflow', confidence: 100 });
  }
  return fixes;
}

/** Add a Redis 7 service container to a GitHub Actions workflow. */
export function fixMissingRedisService(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*6379|Redis.*connection.*refused|redis.*not.*running/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || f.content.includes('redis')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      out.push(line);
      if (/^\s+runs-on:/.test(line) && !modified) {
        out.push('    services:');
        out.push('      redis:');
        out.push('        image: redis:7-alpine');
        out.push('        ports:');
        out.push("          - '6379:6379'");
        out.push('        options: --health-cmd "redis-cli ping" --health-interval 10s');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added Redis service container — ECONNREFUSED on port 6379 means no Redis service in workflow', confidence: 100 });
  }
  return fixes;
}

// ── Section A ─────────────────────────────────────────────────────────────────

/** Insert Alembic heads merge step before upgrade in GitHub Actions. */
export function fixAlembicRevisionCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/alembic.*multiple.*head|alembic.*revision.*conflict|Multiple.*head.*revisions|alembic.*upgrade.*head.*fail/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const mergeStep = [
    `      - name: Merge Alembic heads`,
    `        run: |`,
    `          heads=$(alembic heads 2>&1 | grep -c "head")`,
    `          if [ "$heads" -gt "1" ]; then`,
    `            alembic merge heads -m "merge_heads_ci"`,
    `          fi`,
    `          alembic upgrade head`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('alembic') || f.content.includes('alembic heads')) continue;
    const patched = insertStepBefore(f.content, /alembic upgrade head/i, mergeStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Alembic heads merge step — multiple heads cause upgrade to fail; auto-merging resolves divergent migration branches', confidence: 92 });
  }
  return fixes;
}

/** Insert goose migration status check step in GitHub Actions. */
export function fixGooseMigrationVersion(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/goose.*error|goose.*version.*mismatch|goose.*already.*applied/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const statusStep = [
    `      - name: Check goose migration status`,
    `        run: |`,
    `          goose -dir ./db/migrations postgres "$DATABASE_URL" status`,
    `          goose -dir ./db/migrations postgres "$DATABASE_URL" up`,
    `        env:`,
    `          DATABASE_URL: \${{ env.DATABASE_URL }}`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('goose') || f.content.includes('goose status')) continue;
    const patched = insertStepBefore(f.content, /goose.*up/i, statusStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added goose status check before migration — version conflicts are caught early before applying new ones', confidence: 90 });
  }
  return fixes;
}

/** Insert a migration rollback step (if: failure()) in GitHub Actions. */
export function fixMigrationRollbackStep(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/migration.*failed|rollback.*migration|migrate.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const rollbackStep = [
    `      - name: Rollback migration on failure`,
    `        if: failure()`,
    `        run: |`,
    `          echo "Migration failed — attempting rollback"`,
    `          npx knex migrate:rollback 2>/dev/null || \\`,
    `          npx sequelize-cli db:migrate:undo 2>/dev/null || \\`,
    `          flyway undo 2>/dev/null || true`,
    `          echo "Rollback attempt complete"`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('if: failure()')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|pytest|jest)/i, rollbackStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added migration rollback step on CI failure — partial migrations leave DB in inconsistent state; rolling back restores a clean baseline', confidence: 88 });
  }
  return fixes;
}

// ── Section B ─────────────────────────────────────────────────────────────────

/** Insert DATABASE_URL presence validation step in GitHub Actions. */
export function fixDBConnectionEnvValidation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/DATABASE_URL.*not.*defined|DB_HOST.*undefined|database.*connection.*string.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const validateStep = [
    `      - name: Validate database environment`,
    `        run: |`,
    `          : "\${DATABASE_URL:?DATABASE_URL must be set}"`,
    `          echo "DB: $(echo $DATABASE_URL | sed 's/:\/\/.*@/:\/\/***@/')"`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') || f.content.includes('DATABASE_URL:?')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:migrate|prisma|knex|sequelize)/i, validateStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added DATABASE_URL presence check before migration — missing env var causes cryptic errors; fail-fast with a clear message is better', confidence: 95 });
  }
  return fixes;
}

/** Insert RDS Proxy / Cloud SQL proxy readiness poll step in GitHub Actions. */
export function fixDBConnectionProxyTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/RDS Proxy.*timeout|Cloud SQL.*proxy.*connection|connect ETIMEDOUT.*rds|cloudsql.*proxy.*refused/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const proxyWaitStep = [
    `      - name: Wait for DB proxy to be ready`,
    `        run: |`,
    `          for i in $(seq 1 20); do`,
    `            nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null && echo "Proxy ready" && break`,
    `            echo "Attempt $i/20 — sleeping 5s..." && sleep 5`,
    `          done`,
    `          nc -z "$DB_HOST" "$DB_PORT" || (echo "Proxy not reachable after 100s" && exit 1)`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('rds') && !f.content.includes('cloudsql') && !f.content.includes('cloud_sql')) continue;
    if (f.content.includes('PROXY_WAIT') || f.content.includes('nc -z')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:migrate|prisma|knex|sequelize)/i, proxyWaitStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added proxy readiness poll — RDS/Cloud SQL Proxy needs time to establish; polling with nc prevents premature connection errors', confidence: 90 });
  }
  return fixes;
}

/** Insert VPN/SSH tunnel scaffold step for private DB access in GitHub Actions. */
export function fixDBNetworkPolicyCIJob(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Connection.*refused.*private|network.*policy.*denied.*database|cannot reach.*db.*host|VPN.*required.*database/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('wireguard') || f.content.includes('tailscale') || f.content.includes('ssh-tunnel')) continue;
    if (!f.content.includes('DATABASE_URL') && !f.content.includes('DB_HOST')) continue;
    const vpnStep = [
      `      - name: Configure network access to private database`,
      `        run: |`,
      `          # Option 1 — Tailscale (recommended):`,
      `          # curl -fsSL https://tailscale.com/install.sh | sh`,
      `          # tailscale up --authkey=\${{ secrets.TAILSCALE_AUTHKEY }}`,
      `          # Option 2 — WireGuard:`,
      `          # echo "\${{ secrets.WG_CONFIG }}" | sudo tee /etc/wireguard/wg0.conf && sudo wg-quick up wg0`,
      `          # Option 3 — SSH tunnel:`,
      `          # ssh -N -L 5432:db-private:5432 jump@bastion &`,
      `          echo "Configure a VPN option above, then remove this exit"`,
      `          exit 1`,
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:migrate|prisma|knex|sequelize|npm test)/i, vpnStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added VPN scaffold — private DB is unreachable from the GitHub Actions runner; Tailscale/WireGuard/SSH tunnel is required', confidence: 85 });
  }
  return fixes;
}

// ── Section C ─────────────────────────────────────────────────────────────────

/** Insert pg_stat_activity deadlock diagnostic step (if: failure()) in GitHub Actions. */
export function fixDeadlockMonitoring(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock detected|lock.*monitoring|pg_locks.*deadlock/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const monitorStep = [
    `      - name: Capture lock contention on failure`,
    `        if: failure()`,
    `        run: |`,
    `          PGPASSWORD=testpass psql -h localhost -U testuser -d testdb -c "`,
    `            SELECT pid, wait_event_type, wait_event, state, LEFT(query,120) AS query`,
    `            FROM pg_stat_activity WHERE wait_event_type = 'Lock';`,
    `          " || true`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('pg_stat_activity')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest|pytest)/i, monitorStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added pg_stat_activity deadlock capture step — runs on failure to show which queries were blocking', confidence: 88 });
  }
  return fixes;
}

/** Add GitHub Actions concurrency group to serialize migration jobs. */
export function fixDeadlockConcurrencyGroup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock.*migration|concurrent.*deploy.*migration.*conflict/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('concurrency:')) continue;
    const concurrencyBlock = 'concurrency:\n  group: db-migration-${{ github.ref }}\n  cancel-in-progress: false\n\n';
    const fixed = f.content.replace(/^(on:)/m, `${concurrencyBlock}$1`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added concurrency group — concurrent migration pipelines deadlock each other; cancel-in-progress: false serializes them safely', confidence: 95 });
  }
  return fixes;
}

// ── Section D ─────────────────────────────────────────────────────────────────

/** Insert schema drift detection step in GitHub Actions. */
export function fixSchemaDriftDetection(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/schema.*mismatch|column.*does not exist|relation.*does not exist|table.*not found.*migrate|schema.*out.*of.*sync/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const driftStep = [
    `      - name: Detect schema drift`,
    `        run: |`,
    `          npx prisma migrate status 2>/dev/null || \\`,
    `          npx knex migrate:status 2>/dev/null || \\`,
    `          npx sequelize-cli db:migrate:status 2>/dev/null || \\`,
    `          flyway info 2>/dev/null || alembic current 2>/dev/null || true`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('migrate:status') || f.content.includes('migrate status')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest|pytest)/i, driftStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added schema drift detection — "column does not exist" means an unapplied migration; checking status before tests surfaces this clearly', confidence: 92 });
  }
  return fixes;
}

/** Insert prisma generate + prisma migrate deploy steps in GitHub Actions. */
export function fixPrismaSchemaSync(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/prisma.*schema.*not.*found|@prisma\/client.*not.*generated|PrismaClient.*initialization.*error|prisma.*generate.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const prismaStep = [
    `      - name: Generate Prisma client`,
    `        run: npx prisma generate`,
    `      - name: Apply Prisma migrations`,
    `        run: npx prisma migrate deploy`,
    `        env:`,
    `          DATABASE_URL: \${{ env.DATABASE_URL }}`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('prisma') || f.content.includes('prisma generate') || f.content.includes('prisma migrate deploy')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest)/i, prismaStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added prisma generate + migrate deploy steps — PrismaClient must be generated before use; missing it causes initialization errors', confidence: 98 });
  }
  return fixes;
}

/** Insert Django makemigrations --check step in GitHub Actions. */
export function fixDjangoMakeMigrationsCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/django.*migration.*missing|No migrations to apply.*django|unapplied migration.*django/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const djangoStep = [
    `      - name: Check for missing Django migrations`,
    `        run: python manage.py makemigrations --check --dry-run`,
    `      - name: Apply Django migrations`,
    `        run: python manage.py migrate --noinput`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('manage.py') || f.content.includes('makemigrations --check')) continue;
    const patched = insertStepBefore(f.content, /python manage\.py migrate/i, djangoStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added Django makemigrations --check — catches unapplied model changes before running tests', confidence: 95 });
  }
  return fixes;
}

/** Insert migration version table check step in GitHub Actions. */
export function fixSchemaVersionTable(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/schema_migrations.*corrupt|migration.*version.*table.*missing|SequelizeMeta.*does not exist/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const checkStep = [
    `      - name: Verify migration version table`,
    `        run: |`,
    `          PGPASSWORD=testpass psql -h localhost -U testuser -d testdb -c "`,
    `            SELECT COUNT(*) FROM information_schema.tables`,
    `            WHERE table_name IN ('schema_migrations','SequelizeMeta','_prisma_migrations','knex_migrations');`,
    `          " || echo "Version table missing — needs init"`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('schema_migrations')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:migrate|prisma migrate|knex migrate)/i, checkStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added migration version table check — missing table causes all migrations to re-run; detecting it first allows targeted repair', confidence: 88 });
  }
  return fixes;
}

// ── Section E ─────────────────────────────────────────────────────────────────

/** Insert pg_stat_statements query plan capture step (if: failure()) in GitHub Actions. */
export function fixQueryAnalyzeExplain(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/query.*execution.*failed|QueryFailedError|ORA-\d{5}|PG.*ERROR.*syntax/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const explainStep = [
    `      - name: Capture slow query plan on failure`,
    `        if: failure()`,
    `        run: |`,
    `          PGPASSWORD=testpass psql -h localhost -U testuser -d testdb -c "`,
    `            SELECT query, calls, total_exec_time, mean_exec_time`,
    `            FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;`,
    `          " 2>/dev/null || echo "pg_stat_statements not available"`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('pg_stat_statements')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest|pytest)/i, explainStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added pg_stat_statements capture on failure — reveals the slowest queries when tests fail', confidence: 88 });
  }
  return fixes;
}

/** Insert pg_stat_statements extension setup step in GitHub Actions. */
export function fixQueryStatStatements(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/slow.*query|query.*performance|statement.*timeout|query.*plan/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const setupStep = [
    `      - name: Enable pg_stat_statements`,
    `        run: |`,
    `          PGPASSWORD=testpass psql -h localhost -U testuser -d testdb \\`,
    `            -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" || true`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('pg_stat_statements')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest|pytest)/i, setupStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added pg_stat_statements setup — enables per-query execution time tracking for diagnosing slow queries in CI', confidence: 88 });
  }
  return fixes;
}

// ── Section F ─────────────────────────────────────────────────────────────────

/** Insert ANALYZE step after seed/migrate in GitHub Actions to update planner statistics. */
export function fixIndexStatisticsUpdate(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/statistics.*out.*of.*date|planner.*estimate.*off|rows.*estimated.*actual.*mismatch|ANALYZE.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const analyzeStep = [
    `      - name: Update table statistics after seed/migrate`,
    `        run: |`,
    `          PGPASSWORD=testpass psql -h localhost -U testuser -d testdb -c "ANALYZE VERBOSE;" || true`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('ANALYZE')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest|pytest)/i, analyzeStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added ANALYZE after migrations — stale stats cause the planner to choose bad query plans; ANALYZE updates row count estimates', confidence: 88 });
  }
  return fixes;
}

/** Insert invalid-index check step in GitHub Actions. */
export function fixIndexBloatReindex(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/index.*bloat|VACUUM.*index.*pages|index.*corruption|invalid.*index/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const reindexStep = [
    `      - name: Check for invalid indexes`,
    `        run: |`,
    `          PGPASSWORD=testpass psql -h localhost -U testuser -d testdb -c "`,
    `            SELECT indexrelid::regclass AS index_name FROM pg_index WHERE NOT indisvalid;`,
    `          " 2>/dev/null || true`,
    `          # Rebuild: REINDEX CONCURRENTLY INDEX <index_name>;`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('REINDEX')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest)/i, reindexStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added invalid index check — bloated or invalid indexes cause query failures; REINDEX CONCURRENTLY rebuilds without a table lock', confidence: 85 });
  }
  return fixes;
}

// ── Section H ─────────────────────────────────────────────────────────────────

/** Insert replication slot lag check step in GitHub Actions. */
export function fixReplicationSlotMonitor(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replication.*slot.*lag|pg_replication_slots.*inactive|slot.*wal.*retained/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const monitorStep = [
    `      - name: Check replication slot health`,
    `        run: |`,
    `          PGPASSWORD=\${{ secrets.DB_PASSWORD }} psql "$DATABASE_URL" -c "`,
    `            SELECT slot_name, active,`,
    `              pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag`,
    `            FROM pg_replication_slots ORDER BY lag DESC;`,
    `          " || true`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') || f.content.includes('pg_replication_slots')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:migrate|deploy)/i, monitorStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added replication slot lag check before deploy — inactive slots accumulate WAL and can fill disk', confidence: 88 });
  }
  return fixes;
}

/** Insert replica lag check + fallback-to-primary in GitHub Actions via $GITHUB_ENV. */
export function fixReplicaHealthCheck(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replica.*not.*ready|standby.*not.*caught.*up|replica.*behind.*seconds/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const replicaCheck = [
    `      - name: Check replica replication lag`,
    `        run: |`,
    `          LAG=$(PGPASSWORD=\${{ secrets.REPLICA_DB_PASSWORD }} psql "$DATABASE_READ_URL" \\`,
    `            -At -c "SELECT EXTRACT(EPOCH FROM (now()-pg_last_xact_replay_timestamp()))::int;" 2>/dev/null || echo 999)`,
    `          echo "Replica lag: \${LAG}s"`,
    `          if [ "$LAG" -gt "30" ]; then`,
    `            echo "DATABASE_READ_URL=$DATABASE_URL" >> $GITHUB_ENV`,
    `          fi`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('DATABASE_READ_URL') || f.content.includes('pg_last_xact_replay_timestamp')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:test|npm test|jest)/i, replicaCheck);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added replica lag check — falls back to primary via GITHUB_ENV when lag > 30s to prevent stale reads', confidence: 90 });
  }
  return fixes;
}

/** Insert replication lag wait step before deploy in GitHub Actions. */
export function fixReplicationMonitoringStep(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replication.*lag.*deploy|deploy.*replication.*behind|replica.*not.*synced.*deploy/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const lagStep = [
    `      - name: Wait for replication to catch up`,
    `        run: |`,
    `          for i in $(seq 1 20); do`,
    `            LAG=$(PGPASSWORD="\${{ secrets.DB_PASSWORD }}" psql "$DATABASE_URL" \\`,
    `              -At -c "SELECT COALESCE(MAX(EXTRACT(EPOCH FROM write_lag)),0)::int FROM pg_stat_replication;" 2>/dev/null || echo 999)`,
    `            echo "Replication lag: \${LAG}s (attempt \$i/20)"`,
    `            [ "\$LAG" -le "5" ] && echo "Replica caught up" && break`,
    `            sleep 10`,
    `          done`,
  ].join('\n');
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') || f.content.includes('pg_stat_replication')) continue;
    const patched = insertStepBefore(f.content, /run:.*(?:deploy|helm upgrade|kubectl apply|flyway migrate)/i, lagStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added replication lag wait before deploy — deploying while replica is behind causes read-after-write inconsistency', confidence: 90 });
  }
  return fixes;
}

/** Insert Debezium/CDC consumer lag check step in GitHub Actions. */
export function fixCDCEventStreamLag(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/debezium.*lag|CDC.*event.*lag|change.*data.*capture.*behind|kafka.*connect.*lag/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('debezium') && !f.content.includes('kafka-connect') && !f.content.includes('CDC')) continue;
    if (f.content.includes('consumer-group-offset')) continue;
    const lagStep = [
      `      - name: Check CDC consumer lag`,
      `        run: |`,
      `          kafka-consumer-groups.sh --bootstrap-server "$KAFKA_BOOTSTRAP" \\`,
      `            --group "$CDC_CONSUMER_GROUP" --describe 2>/dev/null | \\`,
      `            awk 'NR>1 {sum += $5} END {print "Total CDC lag: " sum " messages"}'`,
    ].join('\n');
    const patched = insertStepBefore(f.content, /run:.*(?:deploy|helm upgrade|kubectl apply)/i, lagStep);
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added CDC consumer lag check — deploying while Debezium lags causes event processing gaps', confidence: 87 });
  }
  return fixes;
}
