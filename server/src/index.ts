import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db';
import { seed } from './seed';
import { createApp } from './app';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(here, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DB_PATH || path.join(dataDir, 'spendoath.db');

const db = openDb(dbPath);
seed(db);

const port = Number(process.env.PORT || 4000);
const app = createApp(db);
app.listen(port, () => {
  console.log(`[spendoath] enforcement layer listening on http://localhost:${port}`);
  console.log('[spendoath] mode: local deterministic simulation (x402-compatible HTTP 402)');
});