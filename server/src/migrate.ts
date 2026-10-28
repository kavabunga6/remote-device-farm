import { diagnostic } from './diagnostics.js';
import { Pool } from 'pg';
import { migrate } from './db.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error(diagnostic('migrate.3980494fc0'));
const pool = new Pool({ connectionString: databaseUrl });
try {
  await migrate(pool);
  console.log(diagnostic('migrate.6ccf2db1ea'));
} finally {
  await pool.end();
}
