import '../env.js';
import readline from 'node:readline/promises';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { buildContext } from '../context.js';
import { DisabledEmailProvider } from '../email/providers.js';
import { NoVerificationService } from '../scanning/verification.js';
import { createDb, migrateLatest } from './knex.js';
import { DEMO_PASSWORD, seedDemo } from './seed.js';
import { createUser } from '../services/users.js';

/** Usage: migrate | seed | create-admin */
async function main() {
  const cmd = process.argv[2];
  const config = loadConfig();
  const db = createDb(config);
  const log = pino({ level: 'warn' });
  try {
    const applied = await migrateLatest(db);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date');
    const ctx = buildContext({ config, db, log, email: new DisabledEmailProvider(), verifier: new NoVerificationService() });

    if (cmd === 'seed') {
      const { users, enrollmentCode } = await seedDemo(ctx);
      console.log(`Demo data loaded (fictional). Users: ${users.join(', ')} — password: ${DEMO_PASSWORD}`);
      console.log(`Gate tablet enrolment code (valid 24 h): ${enrollmentCode}`);
    } else if (cmd === 'create-admin') {
      let username = process.env.ADMIN_USERNAME;
      let password = process.env.ADMIN_PASSWORD;
      let displayName = process.env.ADMIN_DISPLAY_NAME ?? 'Administrator';
      if (!username || !password) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        username = username || (await rl.question('Admin username: '));
        displayName = (await rl.question(`Display name [${displayName}]: `)) || displayName;
        password = password || (await rl.question('Temporary password (min 10 chars, letters + numbers): '));
        rl.close();
      }
      const u = await createUser(ctx, { id: null, username: 'cli' }, { username, displayName, role: 'admin', password }, { mustChangePassword: true });
      console.log(`Administrator "${u.username}" created. They must change the password at first sign-in.`);
    } else if (cmd !== 'migrate') {
      console.log('Usage: cli.ts migrate | seed | create-admin');
    }
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
