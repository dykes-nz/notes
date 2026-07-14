const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const openai = require('../utils/openai');

const router = express.Router();

// Configure multer for PDF uploads. PDFs are held in memory and stored
// in the database - the container filesystem is ephemeral on Railway,
// so files written to disk vanish on every deploy/restart.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB for audio
});

// Helper for async database operations
const isPostgres = !!process.env.DATABASE_URL;

async function dbGet(sql, params = []) {
  if (isPostgres) {
    return await db.get(sql, params);
  }
  return db.get(sql, params);
}

async function dbAll(sql, params = []) {
  if (isPostgres) {
    return await db.all(sql, params);
  }
  return db.all(sql, params);
}

async function dbRun(sql, params = []) {
  if (isPostgres) {
    return await db.run(sql, params);
  }
  return db.run(sql, params);
}

// Login page
router.get('/login', async (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/');
  }

  // Check if setup is needed
  const result = await dbGet('SELECT COUNT(*) as count FROM passkey_credentials');
  const setupNeeded = (result?.count || 0) === 0;

  res.render('login', { title: 'Login', setupNeeded });
});

// Settings page
router.get('/settings', requireAuth, async (req, res) => {
  res.render('settings', { title: 'Settings' });
});

// Home / Notes list
router.get('/', requireAuth, async (req, res) => {
  let folders = await dbAll('SELECT * FROM folders ORDER BY sort_order, name');
  let notes = await dbAll(`
    SELECT n.*, f.name as folder_name
    FROM notes n
    LEFT JOIN folders f ON n.folder_id = f.id
    ORDER BY n.sort_order, n.updated_at DESC
  `);

  // Safety sweep: folders with no notes self-destruct; folders with one
  // note revert to a loose note
  const stale = folders.filter(f => notes.filter(n => n.folder_id === f.id).length <= 1);
  if (stale.length > 0) {
    for (const f of stale) {
      await dissolveFolderIfNeeded(f.id);
    }
    folders = await dbAll('SELECT * FROM folders ORDER BY sort_order, name');
    notes = await dbAll(`
      SELECT n.*, f.name as folder_name
      FROM notes n
      LEFT JOIN folders f ON n.folder_id = f.id
      ORDER BY n.sort_order, n.updated_at DESC
    `);
  }

  // iOS-style home grid: folder tiles and loose notes share one ordering
  const foldersWithNotes = folders.map(f => ({
    ...f,
    notes: notes.filter(n => n.folder_id === f.id)
  }));
  const gridItems = [
    ...foldersWithNotes.map(f => ({ kind: 'folder', sort: f.sort_order || 0, folder: f })),
    ...notes.filter(n => !n.folder_id).map(n => ({ kind: 'note', sort: n.sort_order || 0, note: n }))
  ].sort((a, b) => a.sort - b.sort);

  res.render('notes/index', {
    title: 'Notes',
    folders,
    notes,
    foldersWithNotes,
    gridItems,
    currentFolder: null
  });
});

// Notes in a folder
router.get('/folder/:id', requireAuth, async (req, res) => {
  const folderId = req.params.id;
  const folders = await dbAll('SELECT * FROM folders ORDER BY sort_order, name');
  const currentFolder = await dbGet('SELECT * FROM folders WHERE id = ?', [folderId]);

  if (!currentFolder) {
    return res.redirect('/');
  }

  const notes = await dbAll(`
    SELECT n.*, f.name as folder_name
    FROM notes n
    LEFT JOIN folders f ON n.folder_id = f.id
    WHERE n.folder_id = ?
    ORDER BY n.sort_order, n.updated_at DESC
  `, [folderId]);

  res.render('notes/index', {
    title: currentFolder.name,
    folders,
    notes,
    foldersWithNotes: [],
    gridItems: notes.map(n => ({ kind: 'note', note: n })),
    currentFolder
  });
});

// Create a folder from two notes (iOS-style: drop one note onto another)
router.post('/folders/create-from-notes', requireAuth, async (req, res) => {
  const { targetNoteId, droppedNoteId } = req.body;
  const target = await dbGet('SELECT id, sort_order FROM notes WHERE id = ?', [targetNoteId]);
  const dropped = await dbGet('SELECT id FROM notes WHERE id = ?', [droppedNoteId]);
  if (!target || !dropped || target.id === dropped.id) {
    return res.status(400).json({ error: 'Invalid notes' });
  }

  const result = await dbRun(
    'INSERT INTO folders (name, sort_order) VALUES (?, ?)',
    ['Folder', target.sort_order || 0]
  );
  const folderId = result.lastInsertRowid;
  await dbRun('UPDATE notes SET folder_id = ? WHERE id IN (?, ?)', [folderId, target.id, dropped.id]);

  res.json({ success: true, folderId });
});

// Create folder
router.post('/folder', requireAuth, async (req, res) => {
  const { name, parent_id } = req.body;
  await dbRun('INSERT INTO folders (name, parent_id) VALUES (?, ?)', [name, parent_id || null]);
  res.redirect(req.headers.referer || '/');
});

// Rename folder
router.post('/folder/:id/rename', requireAuth, async (req, res) => {
  const { name } = req.body;
  await dbRun('UPDATE folders SET name = ? WHERE id = ?', [name, req.params.id]);
  res.json({ success: true });
});

// Delete folder
router.post('/folder/:id/delete', requireAuth, async (req, res) => {
  // Move notes to no folder, then delete
  await dbRun('UPDATE notes SET folder_id = NULL WHERE folder_id = ?', [req.params.id]);
  await dbRun('DELETE FROM folders WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Create new note (blank ink canvas)
router.post('/note', requireAuth, async (req, res) => {
  const { title, folder_id } = req.body;
  const result = await dbRun('INSERT INTO notes (title, folder_id) VALUES (?, ?)', [title || 'Untitled', folder_id || null]);
  const noteId = result.lastInsertRowid;

  // Return JSON if requested, otherwise redirect
  if (req.headers['content-type']?.includes('application/json') || req.headers['accept']?.includes('application/json')) {
    res.json({ success: true, noteId });
  } else {
    res.redirect(`/note/${noteId}`);
  }
});

// Create new note with PDF background
router.post('/note/pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const title = req.body.title || req.file.originalname.replace('.pdf', '');
  const folderId = req.body.folder_id || null;
  // pdf_filename doubles as the "this note has a PDF" marker
  const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`;

  const result = await dbRun(
    'INSERT INTO notes (title, folder_id, pdf_filename, pdf_original_name, pdf_data) VALUES (?, ?, ?, ?, ?)',
    [title, folderId, uniqueName, req.file.originalname, req.file.buffer]
  );

  res.json({ success: true, noteId: result.lastInsertRowid });
});

// Serve a note's PDF from the database (legacy notes fall back to disk)
router.get('/note/:id/pdf', requireAuth, async (req, res) => {
  const note = await dbGet('SELECT pdf_data, pdf_filename, pdf_original_name FROM notes WHERE id = ?', [req.params.id]);
  if (!note) {
    return res.status(404).send('Note not found');
  }

  if (note.pdf_data) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(note.pdf_data);
  }

  // Legacy: PDFs uploaded before database storage lived on disk
  if (note.pdf_filename) {
    const filePath = path.join(__dirname, '..', 'public', 'uploads', note.pdf_filename);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }

  res.status(404).send('PDF not found');
});

// View/Edit note (the annotator IS the note view)
router.get('/note/:id', requireAuth, async (req, res) => {
  const note = await dbGet('SELECT * FROM notes WHERE id = ?', [req.params.id]);
  if (!note) {
    return res.redirect('/');
  }

  // Determine mode based on whether note has PDF
  const mode = note.pdf_filename ? 'pdf' : 'ink';

  res.render('notes/annotator', {
    title: note.title,
    note,
    mode,
    openaiConfigured: openai.isConfigured()
  });
});

// Update note title
router.post('/note/:id/title', requireAuth, async (req, res) => {
  const { title } = req.body;
  await dbRun('UPDATE notes SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [title, req.params.id]);
  res.json({ success: true });
});

// A folder left with one note reverts to a loose note; empty folders vanish
async function dissolveFolderIfNeeded(folderId) {
  if (!folderId) return;
  const remaining = await dbAll('SELECT id FROM notes WHERE folder_id = ?', [folderId]);
  if (remaining.length > 1) return;

  if (remaining.length === 1) {
    const folder = await dbGet('SELECT sort_order FROM folders WHERE id = ?', [folderId]);
    await dbRun(
      'UPDATE notes SET folder_id = NULL, sort_order = ? WHERE id = ?',
      [folder?.sort_order || 0, remaining[0].id]
    );
  }
  await dbRun('DELETE FROM folders WHERE id = ?', [folderId]);
}

// Move note to folder (folder_id null = out of its folder)
router.post('/note/:id/move', requireAuth, async (req, res) => {
  const { folder_id } = req.body;
  const note = await dbGet('SELECT folder_id FROM notes WHERE id = ?', [req.params.id]);
  await dbRun('UPDATE notes SET folder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [folder_id || null, req.params.id]);
  if (note && note.folder_id && note.folder_id !== (folder_id || null)) {
    await dissolveFolderIfNeeded(note.folder_id);
  }
  res.json({ success: true });
});

// Delete note
async function deleteNote(req, res) {
  const note = await dbGet('SELECT pdf_filename FROM notes WHERE id = ?', [req.params.id]);

  // Delete PDF file if exists
  if (note && note.pdf_filename) {
    const filePath = path.join(__dirname, '..', 'public', 'uploads', note.pdf_filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  await dbRun('DELETE FROM notes WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}

router.post('/note/:id/delete', requireAuth, deleteNote);
router.delete('/note/:id', requireAuth, deleteNote);

// Save canvas state
router.post('/note/:id/canvas', requireAuth, async (req, res) => {
  const { canvasStates, currentPage, totalPages, backgroundTemplate } = req.body;
  // Store totalPages and background template in the canvasStates object under a meta key
  const stateToSave = { ...canvasStates };
  if (totalPages || backgroundTemplate) {
    stateToSave._meta = {};
    if (totalPages) stateToSave._meta.totalPages = totalPages;
    if (backgroundTemplate) stateToSave._meta.backgroundTemplate = backgroundTemplate;
  }
  await dbRun(
    'UPDATE notes SET canvas_states = ?, current_page = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(stateToSave), currentPage || 1, req.params.id]
  );
  res.json({ success: true });
});

// Get canvas state
router.get('/note/:id/canvas', requireAuth, async (req, res) => {
  const note = await dbGet('SELECT canvas_states, current_page FROM notes WHERE id = ?', [req.params.id]);
  const parsed = note?.canvas_states ? JSON.parse(note.canvas_states) : null;
  // Extract meta values and remove _meta from response
  let totalPages = null;
  let backgroundTemplate = null;
  if (parsed && parsed._meta) {
    totalPages = parsed._meta.totalPages;
    backgroundTemplate = parsed._meta.backgroundTemplate || null;
    delete parsed._meta;
  }
  res.json({
    canvasStates: parsed,
    currentPage: note?.current_page || 1,
    totalPages: totalPages,
    backgroundTemplate: backgroundTemplate
  });
});

// Transcribe audio chunk
router.post('/note/:id/transcribe', requireAuth, audioUpload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file' });
  }

  if (!openai.isConfigured()) {
    return res.status(400).json({ error: 'OpenAI not configured' });
  }

  try {
    const result = await openai.transcribeAudio(req.file.buffer, req.file.mimetype);

    if (result.text && result.text.trim()) {
      // Append to existing transcript; paragraph break if the chunk began after a pause
      const note = await dbGet('SELECT transcript FROM notes WHERE id = ?', [req.params.id]);
      const existingTranscript = note?.transcript || '';
      const separator = existingTranscript ? (result.leadingPause ? '\n\n' : ' ') : '';
      const newTranscript = existingTranscript + separator + result.text;

      await dbRun(
        'UPDATE notes SET transcript = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newTranscript, req.params.id]
      );
    }

    res.json({
      success: true,
      text: result.text,
      leadingPause: result.leadingPause,
      duration: result.duration
    });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: 'Transcription failed: ' + err.message });
  }
});

// Get transcript
router.get('/note/:id/transcript', requireAuth, async (req, res) => {
  const note = await dbGet('SELECT transcript, summary FROM notes WHERE id = ?', [req.params.id]);
  res.json({
    transcript: note?.transcript || '',
    summary: note?.summary || ''
  });
});

// Update transcript
router.post('/note/:id/transcript', requireAuth, async (req, res) => {
  const { transcript } = req.body;
  await dbRun(
    'UPDATE notes SET transcript = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [transcript, req.params.id]
  );
  res.json({ success: true });
});

// Summarize transcript
router.post('/note/:id/summarize', requireAuth, async (req, res) => {
  const note = await dbGet('SELECT title, transcript FROM notes WHERE id = ?', [req.params.id]);

  if (!note || !note.transcript) {
    return res.status(400).json({ error: 'No transcript to summarize' });
  }

  if (!openai.isConfigured()) {
    return res.status(400).json({ error: 'OpenAI not configured' });
  }

  try {
    const summary = await openai.summariseTranscript(note.transcript, note.title || '');

    await dbRun('UPDATE notes SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [summary, req.params.id]);

    res.json({ success: true, summary });
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ error: 'Summarization failed: ' + err.message });
  }
});

// Reorder notes
router.post('/notes/reorder', requireAuth, async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'Invalid order' });
  }

  try {
    for (let i = 0; i < order.length; i++) {
      const item = order[i];
      if (item && typeof item === 'object' && item.type === 'folder') {
        await dbRun('UPDATE folders SET sort_order = ? WHERE id = ?', [i, item.id]);
      } else if (item && typeof item === 'object') {
        await dbRun('UPDATE notes SET sort_order = ? WHERE id = ?', [i, item.id]);
      } else {
        // Legacy: plain array of note ids
        await dbRun('UPDATE notes SET sort_order = ? WHERE id = ?', [i, item]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Reorder error:', err);
    res.status(500).json({ error: 'Failed to reorder' });
  }
});

// Search notes
router.get('/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.json([]);
  }

  const searchTerm = `%${q}%`;
  const notes = await dbAll(`
    SELECT id, title, updated_at
    FROM notes
    WHERE title LIKE ? OR transcript LIKE ?
    ORDER BY updated_at DESC
    LIMIT 20
  `, [searchTerm, searchTerm]);

  res.json(notes);
});

module.exports = router;
