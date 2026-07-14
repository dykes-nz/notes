/**
 * Database initialization
 * Creates tables if they don't exist
 */

const db = require('./index');

function initDatabase() {
  const isPostgres = !!process.env.DATABASE_URL;

  if (isPostgres) {
    return initPostgres();
  } else {
    return initSQLite();
  }
}

function initSQLite() {
  console.log('Initializing SQLite database...');

  db.exec(`
    -- Single user (for passkey association)
    CREATE TABLE IF NOT EXISTS user (
      id INTEGER PRIMARY KEY DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Insert default user if not exists
    INSERT OR IGNORE INTO user (id) VALUES (1);

    -- Passkey credentials
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER DEFAULT 0,
      device_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    );

    -- Folder organization
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Notes (each note is a single canvas, optionally with PDF background)
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      sort_order INTEGER DEFAULT 0,
      -- Canvas data
      canvas_states TEXT,
      current_page INTEGER DEFAULT 1,
      -- PDF background (optional)
      pdf_filename TEXT,
      pdf_original_name TEXT,
      -- Audio transcript (optional)
      transcript TEXT,
      summary TEXT,
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
  `);

  // Migration: add new columns to existing notes table
  const columnsToAdd = [
    { name: 'canvas_states', type: 'TEXT' },
    { name: 'current_page', type: 'INTEGER DEFAULT 1' },
    { name: 'pdf_filename', type: 'TEXT' },
    { name: 'pdf_original_name', type: 'TEXT' },
    { name: 'transcript', type: 'TEXT' },
    { name: 'summary', type: 'TEXT' }
  ];

  for (const col of columnsToAdd) {
    try {
      db.get(`SELECT ${col.name} FROM notes LIMIT 1`);
    } catch (err) {
      if (err.message.includes('no such column')) {
        console.log(`Adding ${col.name} column to notes table...`);
        db.exec(`ALTER TABLE notes ADD COLUMN ${col.name} ${col.type}`);
      }
    }
  }

  // Migration: move data from note_blocks to notes (if note_blocks exists)
  try {
    const hasBlocks = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='note_blocks'");
    if (hasBlocks) {
      console.log('Migrating data from note_blocks to notes...');

      // Get all blocks and merge into notes
      const blocks = db.all(`
        SELECT note_id, canvas_states, current_page, pdf_filename, pdf_original_name, transcript, summary
        FROM note_blocks
        ORDER BY note_id, sort_order
      `) || [];

      for (const block of blocks) {
        // Update note with block data (last block wins for each field)
        if (block.canvas_states) {
          db.run('UPDATE notes SET canvas_states = ? WHERE id = ?', [block.canvas_states, block.note_id]);
        }
        if (block.current_page) {
          db.run('UPDATE notes SET current_page = ? WHERE id = ?', [block.current_page, block.note_id]);
        }
        if (block.pdf_filename) {
          db.run('UPDATE notes SET pdf_filename = ?, pdf_original_name = ? WHERE id = ?',
            [block.pdf_filename, block.pdf_original_name, block.note_id]);
        }
        if (block.transcript) {
          db.run('UPDATE notes SET transcript = ?, summary = ? WHERE id = ?',
            [block.transcript, block.summary, block.note_id]);
        }
      }

      // Drop note_blocks table
      db.exec('DROP TABLE IF EXISTS note_blocks');
      db.exec('DROP INDEX IF EXISTS idx_blocks_note');
      console.log('Migration complete: removed note_blocks table');
    }
  } catch (err) {
    console.log('Note: Block migration skipped -', err.message);
  }

  console.log('SQLite database initialized');
}

async function initPostgres() {
  console.log('Initializing PostgreSQL database...');

  await db.exec(`
    -- Single user (for passkey association)
    CREATE TABLE IF NOT EXISTS "user" (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Insert default user if not exists
    INSERT INTO "user" (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Passkey credentials
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER DEFAULT 0,
      device_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP
    );

    -- Folder organization
    CREATE TABLE IF NOT EXISTS folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Notes (each note is a single canvas, optionally with PDF background)
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      sort_order INTEGER DEFAULT 0,
      -- Canvas data
      canvas_states TEXT,
      current_page INTEGER DEFAULT 1,
      -- PDF background (optional)
      pdf_filename TEXT,
      pdf_original_name TEXT,
      -- Audio transcript (optional)
      transcript TEXT,
      summary TEXT,
      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

    -- Add columns if they don't exist (PostgreSQL migration)
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notes' AND column_name='canvas_states') THEN
        ALTER TABLE notes ADD COLUMN canvas_states TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notes' AND column_name='current_page') THEN
        ALTER TABLE notes ADD COLUMN current_page INTEGER DEFAULT 1;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notes' AND column_name='pdf_filename') THEN
        ALTER TABLE notes ADD COLUMN pdf_filename TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notes' AND column_name='pdf_original_name') THEN
        ALTER TABLE notes ADD COLUMN pdf_original_name TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notes' AND column_name='transcript') THEN
        ALTER TABLE notes ADD COLUMN transcript TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notes' AND column_name='summary') THEN
        ALTER TABLE notes ADD COLUMN summary TEXT;
      END IF;
    END $$;

    -- Migrate data from note_blocks if it exists
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='note_blocks') THEN
        UPDATE notes n SET
          canvas_states = (SELECT canvas_states FROM note_blocks WHERE note_id = n.id ORDER BY sort_order DESC LIMIT 1),
          current_page = (SELECT current_page FROM note_blocks WHERE note_id = n.id ORDER BY sort_order DESC LIMIT 1),
          pdf_filename = (SELECT pdf_filename FROM note_blocks WHERE note_id = n.id AND pdf_filename IS NOT NULL ORDER BY sort_order DESC LIMIT 1),
          pdf_original_name = (SELECT pdf_original_name FROM note_blocks WHERE note_id = n.id AND pdf_original_name IS NOT NULL ORDER BY sort_order DESC LIMIT 1),
          transcript = (SELECT transcript FROM note_blocks WHERE note_id = n.id AND transcript IS NOT NULL ORDER BY sort_order DESC LIMIT 1),
          summary = (SELECT summary FROM note_blocks WHERE note_id = n.id AND summary IS NOT NULL ORDER BY sort_order DESC LIMIT 1);
        DROP TABLE IF EXISTS note_blocks;
      END IF;
    END $$;
  `);

  console.log('PostgreSQL database initialized');
}

module.exports = { initDatabase };
