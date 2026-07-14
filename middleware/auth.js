const db = require('../db/index');

/**
 * Require authentication middleware
 * For single-user app, just checks if authenticated via passkey
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }

  // For AJAX/JSON requests, return JSON error instead of redirect
  if (req.xhr || req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('application/json')) {
    return res.status(401).json({ error: 'Not authenticated', redirect: '/login' });
  }

  res.redirect('/login');
}

/**
 * Check if any passkeys are registered
 * Used to determine initial setup state
 */
function hasPasskeys() {
  const isPostgres = !!process.env.DATABASE_URL;
  if (isPostgres) {
    // Async for PostgreSQL
    return db.get('SELECT COUNT(*) as count FROM passkey_credentials').then(r => r?.count > 0);
  } else {
    // Sync for SQLite
    const result = db.get('SELECT COUNT(*) as count FROM passkey_credentials');
    return result?.count > 0;
  }
}

module.exports = { requireAuth, hasPasskeys };
