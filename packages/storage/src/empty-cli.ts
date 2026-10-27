// CLI entry: `node packages/storage/dist/empty-cli.js --yes`, which deploy/reset-db.sh runs in a
// one-off api container (the api's MEDIA_* variables, deploy/compose.yaml) after the database wipe
// (docs/RESET.md; owner decision 2026-10-19, ADR-0073). Deletes every object in the media bucket:
// the wipe has deleted every row that pointed at one. A store with no bucket named, and the local
// directory, are skipped without an error. What it does is `runEmptyCli` (empty.ts, tested in
// empty.test.ts); this file only prints its lines and exits with its code.
import { runEmptyCli } from './empty.js';

const outcome = await runEmptyCli(process.argv.slice(2), process.env);
for (const line of outcome.out) console.log(line);
for (const line of outcome.err) console.error(line);
process.exitCode = outcome.code;
