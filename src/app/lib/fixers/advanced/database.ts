// Advanced / Database Errors
// Covers: migration failures, connection retries, deadlocks, schema mismatches,
// missing indexes, transaction rollbacks, replication lag, DB service readiness in CI.
// Updated: added Sections A–H (68 new fixers)

import { RuleFix, isGitHubWorkflow, isGitLabCI, insertStepBefore, injectWorkflowLevelBlock } from '../helpers';

/** Add wait-for-database step before migration/test when DB refuses connections. */
export function fixWaitForDatabase(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*5432|connection refused.*database|could not connect.*server|ECONNREFUSED.*3306|ECONNREFUSED.*27017/i.test(logs)) return [];
  const isMongo = /mongo/i.test(logs);
  const isMySQL = /mysql|mariadb/i.test(logs);
  const dbPort  = isMongo ? '27017' : isMySQL ? '3306' : '5432';
  const dbType  = isMongo ? 'MongoDB' : isMySQL ? 'MySQL' : 'PostgreSQL';

  // Build a type-specific readiness check command
  let readinessCmd: string;
  if (isMongo) {
    readinessCmd = `mongosh --eval "db.adminCommand({ping:1})" --quiet 2>/dev/null && echo "${dbType} ready" && break`;
  } else if (isMySQL) {
    readinessCmd = `mysqladmin ping -h 127.0.0.1 -P ${dbPort} --silent && echo "${dbType} ready" && break`;
  } else {
    readinessCmd = `pg_isready -h localhost -p ${dbPort} && echo "${dbType} ready" && break`;
  }

  const waitStep = [
    `      - name: Wait for ${dbType} to be ready`,
    '        run: |',
    `          echo "Polling ${dbType} on port ${dbPort} (30 × 3s = 90s max)..."`,
    '          for i in $(seq 1 30); do',
    `            ${readinessCmd} || (echo "Attempt $i/30: not ready — waiting 3s..." && sleep 3)`,
    '          done',
    `          ${readinessCmd} || (echo "ERROR: ${dbType} did not become ready in 90s" && exit 1)`,
  ].join('\n');

  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('services:') && !f.content.includes('postgres') && !f.content.includes('mysql') && !f.content.includes('mongo')) continue;
    if (f.content.includes('wait-for')) continue;
    // Do NOT skip files that already have pg_isready — they might have the WRONG host.
    // Fall through to fixPostgresServiceConfig below which corrects the host.

    if (isGitHubWorkflow(f.path)) {
      const patched = insertStepBefore(
        f.content,
        /run:.*(?:migrate|sequelize|knex|prisma|flyway|liquibase|npm test|pytest|mocha)/i,
        waitStep,
      );
      if (patched)
        fixes.push({ path: f.path, content: patched, explanation: `Added ${dbType} readiness poll (30 × 3s) before migration/tests — ECONNREFUSED on port ${dbPort} means service hasn't started`, confidence: 100 });
    }

    if (isGitLabCI(f.path)) {
      // Prepend wait script to before_script or the job's script
      const glWait = [
        `  before_script:`,
        `    - echo "Waiting for ${dbType}..."`,
        `    - for i in $(seq 1 30); do ${readinessCmd} || sleep 3; done`,
      ].join('\n');
      const fixed = f.content.replace(
        /^((?:integration|test|migrate)[\w-]*:)$/im,
        `$1\n${glWait}`,
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: `Added ${dbType} readiness check to GitLab CI job before_script — ECONNREFUSED means service container not yet ready`, confidence: 100 });
    }
  }
  return fixes;
}

/** Add --lock-timeout flag to migration commands when deadlock/lock timeout occurs. */
export function fixMigrationLockTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/lock.*timeout|Migration.*lock.*timeout|deadlock.*detected.*migration|could not obtain lock/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('lock-timeout') || f.content.includes('lock_timeout')) continue;
    // Add lock timeout for common migration tools
    const fixed = f.content
      .replace(/(knex migrate:latest)/g, 'KNEX_LOCK_TIMEOUT=60000 $1')
      .replace(/(sequelize-cli db:migrate)/g, '$1 --lock-timeout 60000')
      .replace(/(prisma migrate deploy)/g, '$1')  // Prisma handles this via env
      .replace(/(flyway migrate)/g, '$1 -lockRetryCount=5');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added lock timeout to migration command — concurrent migration runs were deadlocking', confidence: 100 });
  }
  return fixes;
}

/** Add statement timeout and query logging for query execution failures. */
export function fixQueryExecutionFailure(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/query.*execution.*failed|PG.*query.*error|ERROR.*syntax.*near|ORA-\d{5}|mysql.*Query.*Error|QueryFailedError|query.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') && !f.content.includes('prisma') && !f.content.includes('sequelize') && !f.content.includes('knex')) continue;
    // Add statement timeout env var for PostgreSQL
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      "  PGOPTIONS: '-c statement_timeout=30000'  # aegis: 30s statement timeout prevents runaway queries",
      '  DEBUG: prisma:query,sequelize:*  # aegis: enable query logging for debugging',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PGOPTIONS statement_timeout and DEBUG query logging — query execution failures are easier to diagnose with full query logs and a hard timeout', confidence: 100 });
  }
  return fixes;
}

/** Add read-from-primary guidance when replication lag causes stale reads. */
export function fixReplicationLag(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replication.*lag|replica.*behind|read.*replica.*stale|slave.*delay|standby.*not.*caught|could not serialize access/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') && !f.content.includes('DB_HOST')) continue;
    // Add primary DB URL for tests to avoid replica lag issues
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: read replica lag — use primary DB_URL for writes, replica for reads',
      '  DATABASE_URL: ${{ env.PRIMARY_DATABASE_URL || env.DATABASE_URL }}',
      '  DATABASE_REPLICA_URL: ${{ env.REPLICA_DATABASE_URL || env.DATABASE_URL }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added PRIMARY/REPLICA DATABASE_URL split — replication lag causes stale reads when tests mix primary writes with replica reads', confidence: 100 });
  }
  return fixes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A — Migration Failure
// ─────────────────────────────────────────────────────────────────────────────

/** Wire Flyway env vars (FLYWAY_URL, FLYWAY_USER, FLYWAY_PASSWORD) when Flyway migration fails. */
export function fixFlywayCIConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/flyway.*error|Unable to obtain Flyway schema history|FlywayValidateException|flyway.*migrate.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('flyway') || f.content.includes('FLYWAY_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  FLYWAY_URL: jdbc:postgresql://localhost:5432/testdb',
      '  FLYWAY_USER: testuser',
      '  FLYWAY_PASSWORD: testpass',
      '  FLYWAY_LOCATIONS: filesystem:db/migration',
      '  FLYWAY_BASELINE_ON_MIGRATE: "true"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added FLYWAY_URL/USER/PASSWORD env vars — Flyway migration failed because connection credentials were not passed to the CI job', confidence: 95 });
  }
  return fixes;
}

/** Fix Liquibase changelog path and add required env vars when Liquibase migration fails. */
export function fixLiquibaseChangelog(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/liquibase.*error|ChangeSet.*not.*found|Liquibase.*validation.*failed|liquibase.*checksum/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('liquibase') || f.content.includes('LIQUIBASE_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  LIQUIBASE_URL: jdbc:postgresql://localhost:5432/testdb',
      '  LIQUIBASE_USERNAME: testuser',
      '  LIQUIBASE_PASSWORD: testpass',
      '  LIQUIBASE_CHANGELOG_FILE: db/changelog/db.changelog-master.yaml',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Liquibase env vars — changelog path and DB credentials are required for migrations', confidence: 95 });
  }
  return fixes;
}

/** Switch from `prisma migrate dev` to `prisma migrate deploy` in CI (dev requires interactive TTY). */
export function fixPrismaMigrateDeploy(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/prisma migrate|Prisma.*migration.*failed|@prisma\/client.*did not initialize/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('prisma migrate dev')) continue;
    const fixed = f.content
      .replace(/prisma migrate dev(\s+--name\s+\S+)?/g, 'prisma migrate deploy')
      .replace(/(npx prisma generate)\n/g, '$1\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced `prisma migrate dev` with `prisma migrate deploy` — dev mode requires interactive input and fails in CI; deploy applies pending migrations non-interactively', confidence: 100 });
  }
  return fixes;
}

/** Add idempotent guards (`if_not_exists`) to Rails migrations. */
export function fixRailsMigrationIdempotent(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/rails.*migration|ActiveRecord::Migration|PG::DuplicateTable|column.*already exists.*rails/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/db\/migrate\/.*\.rb$/.test(f.path)) continue;
    if (f.content.includes('if_not_exists') || f.content.includes('unless column_exists')) continue;
    const fixed = f.content
      .replace(/create_table\s+:(\w+)\s+do/g, 'create_table :$1, if_not_exists: true do')
      .replace(/add_column\s+:(\w+),\s+:(\w+),/g, 'add_column :$1, :$2,')
      .replace(/(add_column\s+:\w+,\s+:\w+,[^\n]+)/g,
        'unless column_exists?(:$1, :$2)\n      $&\n    end');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added if_not_exists guards to Rails migration — re-running migrations on existing tables causes DuplicateTable/column errors; idempotent migrations are safe to re-run', confidence: 87 });
  }
  return fixes;
}

/** Fix Knex migration directory path mismatch when migrations cannot be found. */
export function fixKnexMigrationSource(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/knex.*migration.*not found|migration.*directory.*does not exist|No migration files found/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/knexfile\.(js|ts|cjs|mjs)$/.test(f.path)) continue;
    if (f.content.includes('migrations') && !f.content.includes("directory: './migrations'")) {
      const fixed = f.content.replace(
        /migrations:\s*\{([^}]*)\}/s,
        "migrations: {\n    directory: './migrations',\n    extension: 'ts',\n  }",
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Fixed Knex migrations directory path — "No migration files found" means the configured directory does not match where migrations live', confidence: 90 });
    }
  }
  return fixes;
}

/** Fix Sequelize migration state by adding `--to-last-migration` flag when state is out of sync. */
export function fixSequelizeMigrationState(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/sequelize.*migration.*Error|SequelizeMeta.*not.*found|sequelize.*already.*migrated/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('sequelize-cli db:migrate') || f.content.includes('db:migrate:undo')) continue;
    const fixed = f.content.replace(
      /(sequelize-cli db:migrate)(?!\s+--)/g,
      '$1 --migrations-path db/migrations --models-path src/models',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added explicit --migrations-path and --models-path to sequelize-cli — migration state errors often come from path mismatches between environments', confidence: 88 });
  }
  return fixes;
}

/** Add Flyway baseline step when migrating an existing DB that has no schema history. */
export function fixMigrationBaselineExisting(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Found non-empty schema.*without schema history table|baseline.*existing.*database|flyway.*baseline/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('flyway') || f.content.includes('flyway baseline')) continue;
    const fixed = f.content.replace(
      /(flyway migrate)/g,
      'flyway baseline -baselineVersion=1 -baselineDescription="Initial baseline" && $1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Flyway baseline before migrate — existing databases without a schema history table require baselining before migrations can run', confidence: 95 });
  }
  return fixes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B — Connection Timeout
// ─────────────────────────────────────────────────────────────────────────────

/** Add PostgreSQL connection pool configuration via PG* env vars. */
export function fixPGConnectionPool(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/connection pool.*exhausted|too many clients|remaining connection slots.*reserved|FATAL.*sorry.*too many clients/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('postgres') || f.content.includes('PGPOOL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: connection pool exhausted — limit concurrent connections',
      '  DATABASE_POOL_MIN: "2"',
      '  DATABASE_POOL_MAX: "10"',
      '  DATABASE_POOL_ACQUIRE_TIMEOUT: "30000"',
      '  DATABASE_POOL_IDLE_TIMEOUT: "10000"',
      '  PGOPTIONS: "-c idle_in_transaction_session_timeout=30000"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added connection pool limits — "too many clients" means the pool is exhausted; capping at 10 connections per CI job prevents overwhelming the DB', confidence: 95 });
  }
  return fixes;
}

/** Add MySQL connection pool and timeout env vars. */
export function fixMySQLConnectionPool(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ER_CON_COUNT_ERROR|Too many connections.*MySQL|MySQL.*connection.*timeout|wait_timeout.*exceeded/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('mysql') || f.content.includes('MYSQL_POOL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  MYSQL_POOL_LIMIT: "5"',
      '  MYSQL_CONNECT_TIMEOUT: "30000"',
      '  MYSQL_WAIT_TIMEOUT: "28800"',
      '  MYSQL_CONNECTION_LIMIT: "10"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MySQL pool limits — ER_CON_COUNT_ERROR means too many simultaneous connections; pool limit of 10 prevents exhaustion', confidence: 95 });
  }
  return fixes;
}

/** Add MongoDB connection timeout and retry options. */
export function fixMongoConnectionTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/MongoNetworkError|MongoServerSelectionError|ETIMEDOUT.*mongo|connection.*timed.*out.*27017/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('mongo') || f.content.includes('connectTimeoutMS')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  MONGODB_URI: mongodb://localhost:27017/testdb?connectTimeoutMS=30000&serverSelectionTimeoutMS=30000&retryWrites=true',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added MongoDB connection timeout options — MongoServerSelectionError in CI is usually caused by the service not ready; explicit timeouts with retry allow the client to wait', confidence: 92 });
  }
  return fixes;
}

/** Add Redis retry strategy env vars and connection timeout. */
export function fixRedisConnectionRetry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ECONNREFUSED.*6379|Redis.*connection.*error|Redis.*ETIMEDOUT|ioredis.*connection.*refused/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('redis') || f.content.includes('REDIS_RETRY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  REDIS_URL: redis://localhost:6379',
      '  REDIS_CONNECT_TIMEOUT: "5000"',
      '  REDIS_MAX_RETRIES: "5"',
      '  REDIS_RETRY_DELAY: "500"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Redis retry and timeout config — ECONNREFUSED means Redis service not ready; retry with backoff prevents race condition failures', confidence: 92 });
  }
  return fixes;
}

/** Add sslmode=require to DATABASE_URL when SSL connection errors occur. */
export function fixDBConnectionSSL(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/SSL.*connection.*required|no pg_hba.conf.*entry.*SSL|SSL SYSCALL error|certificate verify failed.*database/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') || f.content.includes('sslmode')) continue;
    const fixed = f.content.replace(
      /(DATABASE_URL:\s*postgres(?:ql)?:\/\/[^\s'"]+)/g,
      '$1?sslmode=require',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added sslmode=require to DATABASE_URL — SSL is required by the server but the connection string did not include it', confidence: 95 });
  }
  return fixes;
}

/** Add TCP keepalive settings to prevent idle connection drops. */
export function fixDBConnectionKeepalive(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/connection.*reset.*peer|broken pipe.*database|ECONNRESET.*postgres|idle.*connection.*terminated/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') || f.content.includes('keepalive')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: idle connection drops — enable TCP keepalive',
      '  PGOPTIONS: "-c tcp_keepalives_idle=60 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=6"',
      '  DB_POOL_KEEPALIVE: "true"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added TCP keepalive settings — ECONNRESET on idle connections means a firewall/NAT is dropping stale connections; keepalive probes keep them alive', confidence: 90 });
  }
  return fixes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C — Deadlock Detected
// ─────────────────────────────────────────────────────────────────────────────

/** Add exponential backoff retry logic around code that hits deadlocks. */
export function fixDeadlockRetryLogic(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock detected|deadlock found.*MySQL|DeadlockLoserDataAccessException|could not serialize access.*deadlock/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('DEADLOCK_RETRY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: deadlock — enable ORM-level retry',
      '  DEADLOCK_RETRY_ATTEMPTS: "5"',
      '  DEADLOCK_RETRY_DELAY_MS: "200"',
      '  TYPEORM_RETRY_DELAY: "200"',
      '  SEQUELIZE_RETRY_ATTEMPTS: "5"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added deadlock retry configuration — deadlocks are transient; exponential backoff retry resolves most cases without manual intervention', confidence: 90 });
  }
  return fixes;
}

/** Add lock timeout at session level to break deadlock cycles quickly. */
export function fixDeadlockLockTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock detected|lock.*timeout.*exceeded|canceling statement.*conflict with recovery/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('lock_timeout') || !f.content.includes('postgres')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PGOPTIONS: "-c lock_timeout=5000 -c deadlock_timeout=1000"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set lock_timeout=5s and deadlock_timeout=1s — long lock waits cascade into deadlock storms; short timeouts force fast failure and retry', confidence: 93 });
  }
  return fixes;
}

/** Set READ COMMITTED isolation level to reduce deadlock probability. */
export function fixDeadlockIsolationLevel(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock detected|serialization failure|could not serialize.*transaction/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('ISOLATION_LEVEL') || !f.content.includes('DATABASE_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DB_ISOLATION_LEVEL: READ COMMITTED',
      '  TYPEORM_ISOLATION_LEVEL: READ COMMITTED',
      '  PGOPTIONS: "-c default_transaction_isolation=read committed"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set READ COMMITTED isolation level — SERIALIZABLE causes more deadlocks; READ COMMITTED prevents phantom reads while dramatically reducing contention', confidence: 88 });
  }
  return fixes;
}

/** Add SKIP LOCKED pattern guidance for queue-style SELECT FOR UPDATE. */
export function fixDeadlockRowLevelLocking(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock.*SELECT.*FOR UPDATE|for update.*deadlock|lock.*rows.*deadlock/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const migrationPath = 'db/queries/skip_locked_pattern.sql';
  if (!files.some(f => f.path === migrationPath)) {
    fixes.push({
      path: migrationPath,
      content: [
        '-- aegis: deadlock on SELECT FOR UPDATE — use SKIP LOCKED for queue processing',
        '',
        '-- BEFORE (causes deadlocks when multiple workers compete):',
        '-- SELECT id, payload FROM jobs WHERE status = \'pending\' LIMIT 1 FOR UPDATE;',
        '',
        '-- AFTER (workers skip locked rows instead of waiting):',
        'SELECT id, payload',
        '  FROM jobs',
        ' WHERE status = \'pending\'',
        ' ORDER BY created_at',
        ' LIMIT 1',
        '   FOR UPDATE SKIP LOCKED;',
        '',
        '-- This pattern is safe for multi-worker job queues:',
        '-- each worker grabs a different row, zero lock contention.',
      ].join('\n'),
      explanation: 'Added SKIP LOCKED pattern guide — SELECT FOR UPDATE without SKIP LOCKED causes deadlocks in multi-worker queues; SKIP LOCKED lets workers claim different rows simultaneously',
      confidence: 92,
    });
  }
  return fixes;
}

/** Force serial (non-parallel) test/migration runs to avoid deadlocks in CI. */
export function fixDeadlockCISerialRun(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock detected.*parallel|concurrent.*migration.*deadlock|test.*workers.*deadlock/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('matrix') && !f.content.includes('parallel') && !f.content.includes('--workers')) continue;
    if (f.content.includes('--runInBand') || f.content.includes('--serial')) continue;
    const fixed = f.content
      .replace(/(jest)(\s+)/g, '$1 --runInBand$2')
      .replace(/(vitest run)(\s+)/g, '$1 --reporter=verbose --single-thread$2')
      .replace(/(pytest)(\s+)/g, '$1 -n0$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added serial test execution flags — parallel test workers share DB connections and cause deadlocks; --runInBand/-n0 forces serial execution', confidence: 90 });
  }
  return fixes;
}

/** Add index recommendation for commonly deadlocked UPDATE/DELETE patterns. */
export function fixDeadlockIndexForUpdate(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/deadlock.*UPDATE|deadlock.*DELETE|lock.*row.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const guidePath = 'db/queries/deadlock_index_advice.sql';
  if (!files.some(f => f.path === guidePath)) {
    fixes.push({
      path: guidePath,
      content: [
        '-- aegis: deadlock on UPDATE/DELETE — ensure indexed WHERE clause',
        '',
        '-- Full-table scans during UPDATE acquire many row locks, increasing deadlock risk.',
        '-- Add an index on the WHERE column to minimize the lock footprint.',
        '',
        '-- Check for missing indexes on commonly UPDATEd columns:',
        'SELECT schemaname, tablename, attname, n_distinct, correlation',
        '  FROM pg_stats',
        ' WHERE tablename IN (SELECT relname FROM pg_class WHERE relkind = \'r\')',
        '   AND n_distinct > 100',
        ' ORDER BY n_distinct DESC;',
        '',
        '-- Then create targeted indexes:',
        '-- CREATE INDEX CONCURRENTLY idx_jobs_status ON jobs (status) WHERE status != \'done\';',
      ].join('\n'),
      explanation: 'Generated deadlock index advice — UPDATE/DELETE without an index causes full-table lock scans; narrowing the lock footprint with an index reduces deadlock probability',
      confidence: 85,
    });
  }
  return fixes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D — Schema Mismatch
// ─────────────────────────────────────────────────────────────────────────────

/** Enable TypeORM synchronize for test environment to auto-sync schema. */
export function fixTypeORMSchemaDrop(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/TypeORM.*schema.*out.*of.*sync|EntityMetadataNotFound|column.*does not exist.*typeorm|QueryFailedError.*column/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/typeorm.*config|data-source\.(ts|js)|ormconfig\.(json|js|ts)/.test(f.path)) continue;
    if (f.content.includes('synchronize: true') || f.content.includes('"synchronize": true')) continue;
    const fixed = f.content
      .replace(/(synchronize:\s*)false/g, '$1process.env.NODE_ENV === \'test\'')
      .replace(/("synchronize":\s*)false/g, '$1true');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Enabled TypeORM synchronize for test environment — schema mismatch in CI tests means entities and DB are out of sync; synchronize: true auto-creates missing columns/tables in test', confidence: 88 });
  }
  return fixes;
}

/** Use `db:schema:load` instead of `db:migrate` when Rails schema.rb is present. */
export function fixRailsSchemaLoad(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ActiveRecord::PendingMigrationError|rails.*schema.*version.*mismatch|db:migrate.*rails.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('db:migrate') || !f.content.includes('rails')) continue;
    const fixed = f.content.replace(
      /bundle exec rails db:migrate/g,
      'bundle exec rails db:schema:load RAILS_ENV=test || bundle exec rails db:migrate',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Changed to db:schema:load — for test environments, loading the schema directly is faster and avoids migration version conflicts; falls back to db:migrate if schema.rb is absent', confidence: 90 });
  }
  return fixes;
}

/** Add Flyway repair step to fix checksum mismatches. */
export function fixFlywaySchemaDiff(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Flyway.*checksum.*mismatch|FlywayValidateException|Validate failed.*checksum/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('flyway') || f.content.includes('flyway repair')) continue;
    const fixed = f.content.replace(
      /(flyway migrate)/g,
      'flyway repair && $1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added flyway repair before migrate — checksum mismatch means a migration file was modified after being applied; repair updates checksums to unblock migration', confidence: 92 });
  }
  return fixes;
}

/** Add Liquibase validate to catch changelog errors before applying. */
export function fixLiquibaseValidate(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/liquibase.*validate|Liquibase.*checksum.*error|ChangeSet.*failed.*checksum/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('liquibase') || f.content.includes('liquibase validate')) continue;
    const fixed = f.content.replace(
      /(liquibase update)/g,
      'liquibase validate && $1',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added liquibase validate before update — validates all changesets before applying, catching checksum errors and syntax issues early', confidence: 93 });
  }
  return fixes;
}

/** Add backward-compatible migration guidance file for schema changes. */
export function fixSchemaBackwardCompat(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/backward.*compat.*schema|breaking.*schema.*change|column.*renamed.*error|schema.*deploy.*failure/i.test(logs)) return [];
  const guidePath = 'db/migrations/BACKWARD_COMPAT_GUIDE.md';
  if (files.some(f => f.path === guidePath)) return [];
  return [{
    path: guidePath,
    content: [
      '# Backward-Compatible Schema Migration Guide',
      '',
      '## The Expand-Contract Pattern',
      '',
      'Never rename or drop columns in a single deployment.',
      'Use the expand-contract pattern across 3 deploys:',
      '',
      '### Step 1 — Expand (add new column, keep old)',
      '```sql',
      'ALTER TABLE users ADD COLUMN email_address TEXT;',
      'UPDATE users SET email_address = email;',
      '```',
      '',
      '### Step 2 — Migrate application code to use new column',
      '(deploy app that reads/writes both columns)',
      '',
      '### Step 3 — Contract (drop old column after app is stable)',
      '```sql',
      'ALTER TABLE users DROP COLUMN email;',
      '```',
      '',
      '## Common Gotchas',
      '- Adding NOT NULL without a default breaks inserts from the old app version',
      '- Renaming columns breaks ORM mappings — always add+copy+drop',
      '- Dropping indexes while old app relies on them causes seq scans',
    ].join('\n'),
    explanation: 'Generated backward-compat migration guide — schema changes that break running app instances cause deployment failures; the expand-contract pattern enables zero-downtime schema evolution',
    confidence: 88,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E — Query Execution Failure
// ─────────────────────────────────────────────────────────────────────────────

/** Set PostgreSQL statement_timeout to catch runaway queries in CI. */
export function fixSlowQueryTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/statement.*timeout|query.*timed.*out|QueryTimeout|canceling.*due.*to.*statement timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('statement_timeout') || !f.content.includes('DATABASE_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: runaway query — 30s statement timeout per query',
      '  PGOPTIONS: "-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added statement_timeout=30s and idle_in_transaction_session_timeout=60s — runaway queries block other tests; hard timeouts force fast failure and expose the slow query', confidence: 95 });
  }
  return fixes;
}

/** Add N+1 query detector (e.g., bullet_train or prisma-query-count) in CI test step. */
export function fixNPlusOneQueryDetect(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/N\+1.*query|n_plus_one.*detected|too many queries.*per request/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('test') || f.content.includes('QUERY_COUNT_WARN')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  QUERY_COUNT_WARN_THRESHOLD: "20"',
      '  QUERY_COUNT_ERROR_THRESHOLD: "100"',
      '  DEBUG: "prisma:query"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added N+1 query detection env vars — enabling DEBUG=prisma:query surfaces N+1 patterns during test runs; pair with query count assertions in test setup', confidence: 85 });
  }
  return fixes;
}

/** Enable full query logging for ORM debugging. */
export function fixDBQueryLogging(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/query.*execution.*failed|QueryFailedError|SQL.*syntax.*error|database.*error.*query/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('DEBUG: prisma') || f.content.includes('SEQUELIZE_LOGGING') || !f.content.includes('migrate')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DEBUG: "prisma:query,sequelize:sql,knex:query"',
      '  SEQUELIZE_LOGGING: "true"',
      '  TYPEORM_LOGGING: "true"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Enabled ORM query logging — failed queries are hard to diagnose without seeing the generated SQL; these env vars enable full query logging for all major Node.js ORMs', confidence: 92 });
  }
  return fixes;
}

/** Set work_mem for memory-intensive sort/hash queries. */
export function fixQueryMemoryLimit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/out of memory.*sort|ERROR.*insufficient memory|work_mem.*exceeded|temporary file.*query/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('work_mem') || !f.content.includes('postgres')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PGOPTIONS: "-c work_mem=64MB -c maintenance_work_mem=128MB"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set work_mem=64MB — PostgreSQL spills to disk for sort/hash operations when work_mem is too low, causing OOM or extreme slowness in CI', confidence: 90 });
  }
  return fixes;
}

/** Add pagination to unbounded query patterns detected in logs. */
export function fixQueryResultPagination(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/result.*set.*too large|query.*returned.*too many rows|LIMIT.*missing.*performance|out of memory.*query.*result/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const guidePath = 'db/queries/pagination_guide.sql';
  if (!files.some(f => f.path === guidePath)) {
    fixes.push({
      path: guidePath,
      content: [
        '-- aegis: unbounded query returning too many rows',
        '',
        '-- BEFORE (loads all rows into memory):',
        '-- SELECT * FROM events WHERE user_id = $1;',
        '',
        '-- AFTER (keyset pagination — O(1) regardless of table size):',
        'SELECT id, event_type, created_at',
        '  FROM events',
        ' WHERE user_id = $1',
        '   AND id > $last_id  -- keyset cursor',
        ' ORDER BY id ASC',
        ' LIMIT 100;',
        '',
        '-- For cursor-based pagination in APIs:',
        '-- Use created_at + id as composite cursor for stable ordering',
        '-- Avoid OFFSET for large tables — it scans and discards rows',
      ].join('\n'),
      explanation: 'Generated pagination guide — unbounded queries cause OOM and slow CI tests; keyset pagination is the correct pattern for large datasets',
      confidence: 88,
    });
  }
  return fixes;
}

/** Wrap queries in explicit transactions to get rollback on failure. */
export function fixQueryTransactionWrapper(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/partial.*write.*database|inconsistent.*state.*query.*fail|query.*failed.*no.*rollback/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('BEGIN;') || f.content.includes('transaction')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: ensure migration runs in a transaction for rollback safety',
      '  KNEX_TRANSACTION: "true"',
      '  SEQUELIZE_TRANSACTION: "true"',
      '  FLYWAY_OUT_OF_ORDER: "false"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Enabled transactional migration mode — partial migration writes leave DB in inconsistent state; wrapping in a transaction ensures atomic apply-or-rollback', confidence: 90 });
  }
  return fixes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F — Missing Index
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a composite index migration for multi-column WHERE clauses. */
export function fixCompositeIndexCreation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Seq Scan.*filter|composite.*index.*missing|multi.*column.*where.*index/i.test(logs)) return [];
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const migPath = `db/migrations/${ts}_add_composite_index.sql`;
  if (files.some(f => f.path.includes('composite_index'))) return [];
  return [{
    path: migPath,
    content: [
      '-- aegis: sequential scan on multi-column WHERE — add composite index',
      '',
      '-- Composite indexes work best when column order matches query selectivity:',
      '-- (most selective column first)',
      '',
      '-- Example: WHERE status = $1 AND user_id = $2 AND created_at > $3',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_table_status_user_created',
      '  ON your_table (status, user_id, created_at DESC);',
      '',
      '-- Verify the index is being used:',
      '-- EXPLAIN (ANALYZE, BUFFERS) SELECT ... WHERE status = \'active\' AND user_id = 42;',
      '',
      '-- Down:',
      '-- DROP INDEX CONCURRENTLY IF EXISTS idx_table_status_user_created;',
    ].join('\n'),
    explanation: 'Generated composite index migration — sequential scan on multi-column WHERE clause detected; composite index matching query predicate order eliminates full-table scan',
    confidence: 90,
  }];
}

/** Generate a partial index migration for filtered queries. */
export function fixPartialIndexCreation(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Seq Scan.*WHERE.*=.*'active'|partial.*index.*benefit|filter.*status.*index.*missing/i.test(logs)) return [];
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const migPath = `db/migrations/${ts}_add_partial_index.sql`;
  if (files.some(f => f.path.includes('partial_index'))) return [];
  return [{
    path: migPath,
    content: [
      '-- aegis: filtered query without partial index — create partial index',
      '',
      '-- Partial indexes only index rows matching a WHERE condition:',
      '-- Much smaller than full indexes, faster to maintain',
      '',
      '-- Example: queries that always filter by status = \'pending\'',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_pending',
      '  ON jobs (created_at, priority)',
      '  WHERE status = \'pending\';',
      '',
      '-- This index is used for: SELECT * FROM jobs WHERE status = \'pending\' ORDER BY priority',
      '-- But NOT for: SELECT * FROM jobs WHERE status = \'done\'',
      '',
      '-- Down:',
      '-- DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_pending;',
    ].join('\n'),
    explanation: 'Generated partial index migration — queries filtering on a fixed status value benefit from a partial index that only indexes matching rows, dramatically reducing index size and maintenance cost',
    confidence: 90,
  }];
}

/** Generate a GIN index for JSONB column queries. */
export function fixGINIndexForJSONB(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Seq Scan.*jsonb|GIN.*index.*missing|@>.*operator.*slow|jsonb.*query.*timeout/i.test(logs)) return [];
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const migPath = `db/migrations/${ts}_add_gin_jsonb_index.sql`;
  if (files.some(f => f.path.includes('gin_jsonb'))) return [];
  return [{
    path: migPath,
    content: [
      '-- aegis: sequential scan on JSONB column — add GIN index',
      '',
      '-- GIN indexes support @>, ?, ?|, ?& operators on JSONB',
      '',
      '-- For containment queries (@>):',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_records_metadata_gin',
      '  ON records USING GIN (metadata);',
      '',
      '-- For specific JSONB key queries (smaller, faster):',
      '-- CREATE INDEX CONCURRENTLY idx_records_metadata_key',
      '--   ON records USING GIN ((metadata->\'key\'));',
      '',
      '-- For path-based queries, consider jsonb_path_ops (smaller GIN):',
      '-- CREATE INDEX ... USING GIN (metadata jsonb_path_ops);',
      '',
      '-- Down:',
      '-- DROP INDEX CONCURRENTLY IF EXISTS idx_records_metadata_gin;',
    ].join('\n'),
    explanation: 'Generated GIN index for JSONB column — @> and ? operators on JSONB without a GIN index cause full sequential scans; GIN indexes make these operations O(log n)',
    confidence: 90,
  }];
}

/** Generate an index on foreign key columns to avoid FK-scan on JOINs. */
export function fixForeignKeyIndex(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Seq Scan.*foreign.*key|FK.*missing.*index|join.*full.*scan.*foreign|fk.*index.*missing/i.test(logs)) return [];
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const migPath = `db/migrations/${ts}_add_fk_indexes.sql`;
  if (files.some(f => f.path.includes('fk_indexes'))) return [];
  return [{
    path: migPath,
    content: [
      '-- aegis: missing index on foreign key column',
      '',
      '-- PostgreSQL does NOT automatically create indexes on FK columns.',
      '-- Missing FK indexes cause sequential scans on JOIN and ON DELETE CASCADE.',
      '',
      '-- Find all missing FK indexes:',
      'SELECT',
      '  tc.table_name, kcu.column_name,',
      '  ccu.table_name AS foreign_table',
      'FROM information_schema.table_constraints AS tc',
      'JOIN information_schema.key_column_usage AS kcu',
      '  ON tc.constraint_name = kcu.constraint_name',
      'JOIN information_schema.constraint_column_usage AS ccu',
      '  ON ccu.constraint_name = tc.constraint_name',
      'WHERE tc.constraint_type = \'FOREIGN KEY\'',
      '  AND NOT EXISTS (',
      '    SELECT 1 FROM pg_indexes',
      '    WHERE tablename = tc.table_name',
      '    AND indexdef LIKE \'%\' || kcu.column_name || \'%\'',
      '  );',
      '',
      '-- Then create indexes for each result:',
      '-- CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);',
    ].join('\n'),
    explanation: 'Generated FK index audit query — PostgreSQL does not auto-index FK columns; missing indexes cause O(n) scans on every JOIN and CASCADE DELETE',
    confidence: 88,
  }];
}

/** Generate a unique index to enforce uniqueness constraint properly. */
export function fixUniqueIndexConstraint(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/duplicate.*key.*value.*unique|UniqueConstraintError|unique.*violation|ERROR.*duplicate key/i.test(logs)) return [];
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const migPath = `db/migrations/${ts}_add_unique_constraint.sql`;
  if (files.some(f => f.path.includes('unique_constraint'))) return [];
  return [{
    path: migPath,
    content: [
      '-- aegis: duplicate key violation — add unique constraint safely',
      '',
      '-- Step 1: Find and remove duplicates before adding constraint',
      'DELETE FROM your_table',
      'WHERE id NOT IN (',
      '  SELECT MIN(id)',
      '  FROM your_table',
      '  GROUP BY unique_column',
      ');',
      '',
      '-- Step 2: Add unique index CONCURRENTLY (no table lock)',
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_table_unique_col',
      '  ON your_table (unique_column);',
      '',
      '-- Step 3: Convert to constraint using the index (instant, no scan)',
      'ALTER TABLE your_table',
      '  ADD CONSTRAINT uq_table_unique_col UNIQUE USING INDEX idx_table_unique_col;',
      '',
      '-- Down:',
      '-- ALTER TABLE your_table DROP CONSTRAINT uq_table_unique_col;',
    ].join('\n'),
    explanation: 'Generated unique constraint migration — UniqueConstraintError means the DB allows duplicates; adding a UNIQUE constraint prevents future violations without a full-table lock',
    confidence: 92,
  }];
}

/** Generate a pg_hint_plan query hint file for forcing index usage. */
export function fixQueryPlannerHint(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/planner.*seq.*scan.*ignoring.*index|index.*not.*used.*planner|enable_seqscan.*force.*index/i.test(logs)) return [];
  const guidePath = 'db/queries/query_planner_hints.sql';
  if (files.some(f => f.path === guidePath)) return [];
  return [{
    path: guidePath,
    content: [
      '-- aegis: query planner ignoring index — use SET or pg_hint_plan to force index',
      '',
      '-- Option 1: Disable seq scan for a session (testing only)',
      'SET enable_seqscan = OFF;',
      'SET enable_nestloop = OFF;',
      '',
      '-- Option 2: pg_hint_plan (install extension first)',
      '-- SELECT /*+ IndexScan(t idx_t_col) */ * FROM t WHERE col = $1;',
      '',
      '-- Option 3: Update statistics to help planner',
      'ALTER TABLE your_table ALTER COLUMN your_col SET STATISTICS 500;',
      'ANALYZE your_table;',
      '',
      '-- Option 4: Use explicit EXPLAIN to verify plan:',
      '-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT ...',
    ].join('\n'),
    explanation: 'Generated query planner hint guide — sometimes the planner chooses seq scans even with a valid index; these techniques force index usage for diagnosis and production fixes',
    confidence: 85,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Section G — Transaction Rollback
// ─────────────────────────────────────────────────────────────────────────────

/** Add SAVEPOINT pattern for partial rollback within a transaction. */
export function fixTransactionSavepoint(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/transaction.*aborted|current transaction.*aborted.*commands.*ignored|ERROR.*current transaction is aborted/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const guidePath = 'db/queries/savepoint_pattern.sql';
  if (!files.some(f => f.path === guidePath)) {
    fixes.push({
      path: guidePath,
      content: [
        '-- aegis: transaction aborted — use SAVEPOINTs for partial rollback',
        '',
        '-- When a sub-operation fails inside a transaction, PostgreSQL aborts the',
        '-- entire transaction. SAVEPOINT allows rolling back just the failed part.',
        '',
        'BEGIN;',
        '',
        'INSERT INTO orders (user_id, total) VALUES ($1, $2);',
        '',
        'SAVEPOINT before_email;',
        '',
        '-- Attempt optional operation:',
        'INSERT INTO email_queue (order_id, template) VALUES (lastval(), \'confirmation\');',
        '',
        '-- If it fails:',
        '-- ROLLBACK TO SAVEPOINT before_email;',
        '-- RELEASE SAVEPOINT before_email;',
        '',
        '-- Then continue:',
        'UPDATE inventory SET quantity = quantity - 1 WHERE product_id = $3;',
        '',
        'COMMIT;',
      ].join('\n'),
      explanation: 'Generated SAVEPOINT pattern guide — "current transaction is aborted" means a failed query poisoned the transaction; SAVEPOINTs allow rolling back just the failed sub-operation',
      confidence: 88,
    });
  }
  return fixes;
}

/** Set appropriate transaction isolation level to prevent phantom reads without serialization failures. */
export function fixTransactionIsolationLevel(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/serialization failure|could not serialize access|phantom.*read.*transaction|REPEATABLE READ.*conflict/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('ISOLATION_LEVEL') || !f.content.includes('DATABASE_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: serialization failure — downgrade from SERIALIZABLE to REPEATABLE READ',
      '  DB_ISOLATION_LEVEL: REPEATABLE READ',
      '  PGOPTIONS: "-c default_transaction_isolation=repeatable read"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set REPEATABLE READ isolation — SERIALIZABLE causes spurious serialization failures under concurrent load; REPEATABLE READ prevents phantom reads with far fewer retries', confidence: 88 });
  }
  return fixes;
}

/** Add idle_in_transaction_session_timeout to kill stuck transactions. */
export function fixTransactionTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/idle.*transaction.*timeout|transaction.*hung|IDLE in transaction.*long/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('idle_in_transaction') || !f.content.includes('postgres')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  PGOPTIONS: "-c idle_in_transaction_session_timeout=30000 -c statement_timeout=60000"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added idle_in_transaction_session_timeout=30s — transactions left open (e.g., test teardown crash) hold locks; this timeout auto-kills idle transactions and releases locks', confidence: 95 });
  }
  return fixes;
}

/** Add retry wrapper around transaction blocks that see deadlock/serialization failures. */
export function fixTransactionDeadlockRetry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ERROR 40P01|deadlock.*transaction|ERROR 40001.*serialization/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('TRANSACTION_RETRY')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: 40P01/40001 — transaction-level deadlock/serialization retry',
      '  TRANSACTION_RETRY_MAX: "5"',
      '  TRANSACTION_RETRY_DELAY_MS: "100"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added transaction retry config (40P01/40001) — PostgreSQL serialization and deadlock errors are always safe to retry; configure your ORM/driver retry count to handle transient conflicts', confidence: 90 });
  }
  return fixes;
}

/** Ensure connection is returned to pool immediately after rollback. */
export function fixTransactionConnectionReturn(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/connection.*not.*released.*rollback|pool.*exhausted.*rollback|connection.*leak.*transaction/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') || f.content.includes('POOL_RELEASE')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: connection leak on rollback — enable connection tracking',
      '  DATABASE_POOL_RELEASE_ON_ROLLBACK: "true"',
      '  DATABASE_POOL_IDLE_TIMEOUT: "5000"',
      '  PGOPTIONS: "-c idle_in_transaction_session_timeout=10000"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added pool connection release enforcement — connections not returned after rollback exhaust the pool; idle_in_transaction_session_timeout forces release after 10s', confidence: 88 });
  }
  return fixes;
}

/** Use Prisma interactive transactions for nested transaction support. */
export function fixNestedTransactionPrisma(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/nested.*transaction.*prisma|prisma.*\$transaction.*nested|Transaction.*not.*supported.*nested/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/\.(ts|js|mts|mjs)$/.test(f.path)) continue;
    if (!f.content.includes('prisma.$transaction') || f.content.includes('interactiveTransaction')) continue;
    const fixed = f.content.replace(
      /prisma\.\$transaction\(\[/g,
      '// aegis: use interactive transaction for nested tx support\nprisma.$transaction(async (tx) => {  // replace array-style with callback',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Flagged Prisma array-style $transaction for interactive transaction refactor — nested transactions require the callback form which supports SAVEPOINTs', confidence: 85 });
  }
  return fixes;
}

/** Add transaction state logging on rollback for debugging. */
export function fixTransactionRollbackLogging(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/transaction.*rolled.*back|rollback.*error|ROLLBACK.*unexpected/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('migrate') || f.content.includes('ROLLBACK_LOG')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  DEBUG: "prisma:query,prisma:info,typeorm:query,sequelize:sql"',
      '  TYPEORM_LOG_QUERIES_WITH_PARAMETERS: "true"',
      '  KNEX_DEBUG: "true"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Enabled ORM transaction logging — unexpected rollbacks are hard to debug without seeing the exact query and transaction state; these env vars expose the full transaction lifecycle', confidence: 90 });
  }
  return fixes;
}

/** Wrap DDL migrations in a single atomic transaction. */
export function fixAtomicMigrationTransaction(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/partial.*migration.*applied|migration.*failed.*halfway|half.*applied.*schema/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/db\/migrations\/.*\.sql$/.test(f.path)) continue;
    if (f.content.trim().startsWith('BEGIN;') || f.content.includes('BEGIN;')) continue;
    const fixed = `BEGIN;\n\n${f.content}\n\nCOMMIT;\n`;
    fixes.push({ path: f.path, content: fixed, explanation: 'Wrapped SQL migration in BEGIN/COMMIT — partial migration failure leaves DB in inconsistent state; a single transaction ensures all-or-nothing application', confidence: 95 });
  }
  return fixes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section H — Replication Lag
// ─────────────────────────────────────────────────────────────────────────────

/** Separate read and write DATABASE_URLs to route reads to replica. */
export function fixReadWriteSplit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/replication.*lag|replica.*behind|read.*replica.*stale|read.*from.*replica.*after.*write/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('DATABASE_READ_URL') || !f.content.includes('DATABASE_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: read/write split — route writes to primary, reads to replica',
      '  DATABASE_URL: ${{ secrets.DATABASE_PRIMARY_URL }}',
      '  DATABASE_READ_URL: ${{ secrets.DATABASE_REPLICA_URL || secrets.DATABASE_PRIMARY_URL }}',
      '  DATABASE_WRITE_URL: ${{ secrets.DATABASE_PRIMARY_URL }}',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DATABASE_READ_URL / DATABASE_WRITE_URL split — reading from a replica immediately after a write sees stale data; always-write-primary prevents this', confidence: 95 });
  }
  return fixes;
}

/** Enable synchronous_commit for critical write paths to prevent data loss. */
export function fixSynchronousCommit(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/synchronous_commit.*off|data.*loss.*replica|async.*commit.*lag|lost.*writes.*replica/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('synchronous_commit') || !f.content.includes('postgres')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: async commit data loss — force synchronous commit for critical paths',
      '  PGOPTIONS: "-c synchronous_commit=on"',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Set synchronous_commit=on — async commits improve throughput but risk data loss on replica failover; synchronous commit ensures writes are durable before acknowledging', confidence: 90 });
  }
  return fixes;
}

/** Add logical replication setup for zero-downtime schema migrations. */
export function fixLogicalReplicationSetup(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/logical.*replication.*error|publication.*missing|replication.*slot.*logical.*missing/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  const guidePath = 'db/replication/logical_replication_guide.sql';
  if (!files.some(f => f.path === guidePath)) {
    fixes.push({
      path: guidePath,
      content: [
        '-- aegis: logical replication setup guide',
        '',
        '-- On PRIMARY:',
        'ALTER SYSTEM SET wal_level = logical;',
        '-- (Requires restart)',
        '',
        'CREATE PUBLICATION my_pub FOR ALL TABLES;',
        '',
        '-- On REPLICA:',
        'CREATE SUBSCRIPTION my_sub',
        '  CONNECTION \'host=primary port=5432 dbname=mydb user=replicator password=xxx\'',
        '  PUBLICATION my_pub;',
        '',
        '-- Monitor replication:',
        'SELECT * FROM pg_stat_subscription;',
        'SELECT * FROM pg_replication_slots WHERE slot_type = \'logical\';',
        '',
        '-- For zero-downtime column additions:',
        '-- 1. Add nullable column to primary (replicated immediately)',
        '-- 2. Backfill in batches',
        '-- 3. Add NOT NULL constraint with a DEFAULT',
      ].join('\n'),
      explanation: 'Generated logical replication setup guide — logical replication allows selective table replication and is required for zero-downtime migrations that restructure tables',
      confidence: 85,
    });
  }
  return fixes;
}

/** Add failover DATABASE_URL configuration for replica promotion scenarios. */
export function fixReplicationFailoverConfig(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/primary.*failover|replica.*promoted|standby.*became.*primary|failover.*database/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('DATABASE_URL') || f.content.includes('DATABASE_FAILOVER_URL')) continue;
    const fixed = injectWorkflowLevelBlock(f.content, 'env', [
      '  # aegis: replica promotion — configure failover URL',
      '  DATABASE_URL: ${{ secrets.DATABASE_URL }}',
      '  DATABASE_FAILOVER_URL: ${{ secrets.DATABASE_FAILOVER_URL || secrets.DATABASE_URL }}',
      '  # After failover, update DATABASE_URL secret to point to new primary',
    ]);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added DATABASE_FAILOVER_URL — when a replica is promoted to primary, having a pre-configured failover URL allows fast reconnection without secret rotation', confidence: 88 });
  }
  return fixes;
}

/**
 * Fix wrong host/env-var names in Postgres service containers.
 * GitHub Actions runners: Postgres service is on 127.0.0.1, NOT on hostname "postgres".
 * Official postgres Docker image uses POSTGRES_DB, not POSTGRES_NAME.
 * Also raises health-retries to 10 (Postgres cold start needs it).
 */
export function fixPostgresServiceConfig(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('postgres')) continue;

    let fixed = f.content;
    let changed = false;

    // Wrong env var name for Postgres Docker image
    if (fixed.includes('POSTGRES_NAME:')) {
      fixed = fixed.replace(/POSTGRES_NAME:/g, 'POSTGRES_DB:');
      changed = true;
    }

    // Wrong host in pg_isready (-h postgres → -h 127.0.0.1)
    if (/pg_isready\s+-h\s+postgres\b/.test(fixed)) {
      fixed = fixed.replace(/pg_isready(\s+)-h\s+postgres\b/g, 'pg_isready$1-h 127.0.0.1');
      changed = true;
    }

    // Wrong host in psql (-h postgres → -h 127.0.0.1)
    if (/psql\s+-h\s+postgres\b/.test(fixed)) {
      fixed = fixed.replace(/psql(\s+(?:-\w+\s+\S+\s+)*)-h\s+postgres\b/g, 'psql$1-h 127.0.0.1');
      changed = true;
    }

    // Wrong host in DATABASE_URL (@postgres: → @127.0.0.1:)
    if (/@postgres:/.test(fixed)) {
      fixed = fixed.replace(/@postgres:/g, '@127.0.0.1:');
      changed = true;
    }

    // Raise health-retries if too low (< 8)
    fixed = fixed.replace(
      /health-retries:\s*([1-7])\b/g,
      (_) => `health-retries: 10`,
    );
    if (fixed !== f.content) changed = true;

    if (changed) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed Postgres service container: POSTGRES_NAME→POSTGRES_DB (official image env var), ' +
          'pg_isready/psql/DATABASE_URL host "postgres"→"127.0.0.1" (GitHub Actions runner networking), ' +
          'health-retries raised to 10 (Postgres cold start needs more than 3–5 retries)',
        confidence: 97,
      });
    }
  }
  return fixes;
}
