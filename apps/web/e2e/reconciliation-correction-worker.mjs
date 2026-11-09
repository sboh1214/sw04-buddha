/** Only a dedicated local test profile or this repository's disposable CI service.
 * @param {Partial<NodeJS.ProcessEnv>} [env]
 */
export function correctionFixtureUrls(env = process.env) {
  const appUrl = env.DATABASE_URL;
  const migrateUrl = env.DATABASE_MIGRATE_URL;
  if (!appUrl || !migrateUrl) throw new Error('Correction E2E needs explicit test database URLs');
  let app, owner;
  try {
    app = new URL(appUrl);
    owner = new URL(migrateUrl);
  } catch {
    throw new Error('Correction E2E database URLs are invalid');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname);
  const testDb =
    app.port === '5433' && /^\/buddha_(?:e2e|shots93|m93)[a-zA-Z0-9_]*$/.test(app.pathname);
  const ciDb =
    env.GITHUB_ACTIONS === 'true' &&
    env.CI === 'true' &&
    app.port === '5432' &&
    app.pathname === '/buddha';
  // pg-connection-string lets query parameters override authority host, port and user.
  if (
    !local ||
    (!testDb && !ciDb) ||
    !['postgres:', 'postgresql:'].includes(app.protocol) ||
    !['postgres:', 'postgresql:'].includes(owner.protocol) ||
    app.search !== '' ||
    owner.search !== '' ||
    owner.hostname !== app.hostname ||
    owner.port !== app.port ||
    owner.pathname !== app.pathname ||
    owner.username !== 'buddha_migrate'
  ) {
    throw new Error('Correction E2E refuses a development, remote, or mismatched owner database');
  }
  return {
    appUrl,
    migrateUrl,
    database: decodeURIComponent(app.pathname.slice(1)),
  };
}

async function startWorker() {
  // Validate before importing the DB graph or opening a connection, even for direct invocation.
  const urls = correctionFixtureUrls();
  if (!process.send) throw new Error('Correction E2E native fixture requires a parent IPC channel');
  process.env.TEST_DATABASE_URL = urls.appUrl;
  process.env.TEST_DATABASE_MIGRATE_URL = urls.migrateUrl;
  const [{ createDb, closeDb }, { damageActualCoinForTest, fundTestTreasury }] = await Promise.all([
    import('@buddha/db'),
    import('@buddha/db/test'),
  ]);
  const db = createDb(urls.appUrl, {
    max: 3,
    applicationName: 'e2e-reconciliation-corrections',
    onPoolError: () => {},
  });
  let held;
  let locked = false;
  let closing;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (locked)
          await held.query(
            "SELECT pg_advisory_unlock(hashtext('e2e:reconciliation-corrections'), 93)",
          );
      } finally {
        held?.release();
        await closeDb(db);
      }
    })());
  const stop = () => {
    void close().finally(() => process.exit(0));
  };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  const ready = (async () => {
    held = await db.$client.connect();
    const actual = await held.query('SELECT current_database() AS name');
    if (actual.rows[0]?.name !== urls.database) throw new Error('Correction E2E database mismatch');
    const until = Date.now() + 180_000;
    while (!locked) {
      const result = await held.query(
        "SELECT pg_try_advisory_lock(hashtext('e2e:reconciliation-corrections'), 93) AS locked",
      );
      locked = result.rows[0]?.locked === true;
      if (!locked && Date.now() >= until) throw new Error('Correction E2E fixture lock timed out');
      if (!locked) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  void ready.catch(() => undefined);
  async function operation(name, args) {
    await ready;
    if (name === 'ready') return null;
    if (name === 'close') {
      await close();
      return null;
    }
    if (name === 'account') {
      const { rows } = await db.$client.query(
        "SELECT a.id::text AS id, b.available_coin::text AS available, b.ledger_coin::text AS ledger FROM ledger_accounts a JOIN balances b ON b.account_id=a.id WHERE a.kind='user' AND a.owner_id=$1",
        [args.userId],
      );
      if (!rows[0]) throw new Error('Correction E2E holder account missing');
      const id = Number(rows[0].id);
      if (!Number.isSafeInteger(id))
        throw new Error('Correction E2E account id is outside the supported range');
      return { ...rows[0], id };
    }
    if (name === 'damage') {
      await damageActualCoinForTest(args.accountId, BigInt(args.delta));
      return null;
    }
    if (name === 'ledger') {
      const { rows } = await db.$client.query(
        "SELECT to_jsonb(e) AS row FROM ledger_entries e WHERE e.from_account_id=(SELECT id FROM ledger_accounts WHERE kind='user' AND owner_id=$1) OR e.to_account_id=(SELECT id FROM ledger_accounts WHERE kind='user' AND owner_id=$1) ORDER BY e.id",
        [args.userId],
      );
      return rows.map((row) => row.row);
    }
    if (name === 'treasury') {
      const { rows } = await db.$client.query(
        "SELECT b.available_coin::text AS amount FROM balances b JOIN ledger_accounts a ON a.id=b.account_id WHERE a.kind='treasury'",
      );
      return rows[0]?.amount ?? '0';
    }
    if (name === 'fund') {
      await fundTestTreasury(db, BigInt(args.amount));
      return null;
    }
    throw new Error('Unknown correction E2E fixture operation');
  }
  let sequence = Promise.resolve();
  process.on('message', (message) => {
    sequence = sequence.then(async () => {
      const { id, operation: name, args } = message;
      try {
        const data = await operation(name, args);
        process.send({ id, data }, () => {
          if (name === 'close') process.disconnect();
        });
      } catch (error) {
        const safe = String(
          error instanceof Error ? error.message : 'Correction E2E fixture failed',
        ).replace(/postgres(?:ql)?:\/\/\S+/g, '[database URL]');
        process.send({ id, error: safe });
      }
    });
  });
  process.send({ id: 0, data: 'boot' });
}

if (process.argv[2] === 'correction-fixture-worker') {
  startWorker().catch((error) => {
    // Validation and loader failures contain no environment values; never print an error stack.
    const safe = String(
      error instanceof Error ? error.message : 'Correction E2E fixture failed',
    ).replace(/postgres(?:ql)?:\/\/\S+/g, '[database URL]');
    process.stderr.write(`${safe}\n`);
    process.exit(1);
  });
}
