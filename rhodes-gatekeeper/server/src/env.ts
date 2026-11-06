import fs from 'node:fs';
import path from 'node:path';

/** Load a local .env (development convenience). In production, inject environment variables / secrets directly. */
for (const candidate of [path.resolve('.env'), path.resolve('..', '.env')]) {
  if (fs.existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}
