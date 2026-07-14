const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Check for PostgreSQL connection string (Railway sets this)
const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;

// Detect if we're on Railway (or similar) vs local dev
const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || databaseUrl;

let db;

if (databaseUrl) {
  console.log('Using PostgreSQL database');

  // PostgreSQL connection
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  // Create a wrapper that mimics better-sqlite3 API but async
  db = {
    pool,

    // For raw SQL execution (used in init.js)
    async exec(sql) {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    },

    // Prepare returns an object with run, get, all methods
    prepare(sql) {
      // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
      let pgSql = sql;
      let paramIndex = 0;
      pgSql = pgSql.replace(/\?/g, () => `$${++paramIndex}`);

      // Convert SQLite-specific syntax
      pgSql = pgSql.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
      pgSql = pgSql.replace(/date\('now'\)/gi, 'CURRENT_DATE');
      // Convert SQLite date modifications: date('now', '-1 month') -> CURRENT_DATE - INTERVAL '1 month'
      pgSql = pgSql.replace(/date\('now',\s*'([+-])(\d+)\s+(month|months|day|days|year|years)'\)/gi,
        (match, sign, num, unit) => `(CURRENT_DATE ${sign} INTERVAL '${num} ${unit}')`);
      pgSql = pgSql.replace(/INSERT OR IGNORE/gi, 'INSERT');

      return {
        sql: pgSql,

        async run(...params) {
          const client = await pool.connect();
          try {
            const result = await client.query(pgSql, params);
            return {
              changes: result.rowCount,
              lastInsertRowid: result.rows[0]?.id || null
            };
          } finally {
            client.release();
          }
        },

        async get(...params) {
          const client = await pool.connect();
          try {
            const result = await client.query(pgSql, params);
            return result.rows[0] || null;
          } finally {
            client.release();
          }
        },

        async all(...params) {
          const client = await pool.connect();
          try {
            const result = await client.query(pgSql, params);
            return result.rows;
          } finally {
            client.release();
          }
        }
      };
    },

    // Direct query method
    async query(sql, params = []) {
      const client = await pool.connect();
      try {
        const result = await client.query(sql, params);
        return result;
      } finally {
        client.release();
      }
    },

    // Convenience methods (shorthand for prepare().xxx())
    async get(sql, params = []) {
      return this.prepare(sql).get(...params);
    },

    async all(sql, params = []) {
      return this.prepare(sql).all(...params);
    },

    async run(sql, params = []) {
      return this.prepare(sql).run(...params);
    }
  };

} else if (isRailway) {
  // On Railway but no DATABASE_URL - configuration error
  console.error('ERROR: Running on Railway but DATABASE_URL is not set!');
  console.error('Please add DATABASE_URL variable referencing your PostgreSQL database.');
  console.error('Available env vars:', Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('RAILWAY')).join(', '));
  process.exit(1);

} else {
  // Local development with SQLite
  console.log('Using SQLite database (local development)');

  const Database = require('better-sqlite3');
  const dbPath = process.env.DATABASE_PATH || './db/notes.sqlite';

  // Check if db directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const sqliteDb = new Database(dbPath);

  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  // Wrap SQLite to provide consistent async-like API
  db = {
    exec(sql) {
      return sqliteDb.exec(sql);
    },

    prepare(sql) {
      const stmt = sqliteDb.prepare(sql);
      return {
        sql,
        run(...params) {
          const result = stmt.run(...params);
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid
          };
        },
        get(...params) {
          return stmt.get(...params);
        },
        all(...params) {
          return stmt.all(...params);
        }
      };
    },

    query(sql, params = []) {
      const stmt = sqliteDb.prepare(sql);
      return { rows: stmt.all(...params) };
    },

    // Convenience methods (shorthand for prepare().xxx())
    get(sql, params = []) {
      return this.prepare(sql).get(...params);
    },

    all(sql, params = []) {
      return this.prepare(sql).all(...params);
    },

    run(sql, params = []) {
      return this.prepare(sql).run(...params);
    }
  };
}

module.exports = db;
