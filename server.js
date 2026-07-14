require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { initDatabase } = require('./db/init');
const db = require('./db/index');

const app = express();
const PORT = process.env.PORT || 3003;

// Trust proxy (for Railway)
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers (relaxed for Tailwind CDN and inline handlers)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    }
  }
}));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
const sessionConfig = {
  name: 'notes.sid',
  secret: process.env.SESSION_SECRET || 'notes-app-secret-change-in-production-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
};

// Use PostgreSQL session store in production
if (process.env.DATABASE_URL) {
  const pgSession = require('connect-pg-simple')(session);
  sessionConfig.store = new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'session',
    createTableIfMissing: true
  });
}

app.use(session(sessionConfig));

// CSRF token generation
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many authentication attempts'
});

// Initialize database
const isPostgres = !!process.env.DATABASE_URL;
if (isPostgres) {
  initDatabase().then(() => {
    console.log('Database initialized');
  }).catch(err => {
    console.error('Database init error:', err);
  });
} else {
  initDatabase();
}

// Routes
const authRoutes = require('./routes/auth');
const notesRoutes = require('./routes/notes');

app.use('/auth', authLimiter, authRoutes);
app.use('/', notesRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).render('error', {
    title: 'Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Notes app running on http://localhost:${PORT}`);
});
