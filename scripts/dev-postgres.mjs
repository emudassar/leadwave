/**
 * A real Postgres server, downloaded by npm, run out of `.localdb/`.
 *
 * This machine has no Postgres and no Docker, and the free hosted tiers all
 * want an account before they hand you a connection string. `embedded-postgres`
 * ships the actual PostgreSQL binaries as an npm package, so `pnpm db:up` gets
 * you a genuine server on localhost with nothing to install.
 *
 *   node scripts/dev-postgres.mjs start   # boots, stays in the foreground
 *   node scripts/dev-postgres.mjs init    # first-run: initdb + create database
 *   node scripts/dev-postgres.mjs stop
 */
import EmbeddedPostgres from 'embedded-postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseDir = path.join(root, '.localdb');

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'leadwave',
  password: 'leadwave',
  port: 5432,
  persistent: true,
  // initdb on Windows otherwise inherits the system code page (WIN1252), and
  // the first emoji in a seeded message blows up with a 22P05 encoding error.
  initdbFlags: ['--encoding=UTF8', '--lc-collate=C', '--lc-ctype=C'],
  onLog: (msg) => process.stdout.write(msg),
  onError: (msg) => process.stderr.write(String(msg)),
});

const command = process.argv[2] ?? 'start';

if (command === 'init') {
  await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('leadwave');
    console.log('\n✓ database "leadwave" created');
  } catch (error) {
    if (!String(error).includes('already exists')) throw error;
    console.log('\n✓ database "leadwave" already there');
  }
  await pg.stop();
  console.log('✓ ready — run `pnpm db:up`');
  process.exit(0);
}

if (command === 'stop') {
  await pg.stop();
  process.exit(0);
}

await pg.start();
console.log('\n✓ postgres listening on postgresql://leadwave:leadwave@localhost:5432/leadwave');
console.log('  data dir: ' + databaseDir + '  (gitignored)');

const shutdown = async () => {
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
