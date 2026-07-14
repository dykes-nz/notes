# Notes App

A single-user notes app with ink canvas, PDF annotation, audio transcription, and passkey authentication.

## Tech Stack

- **Express.js + EJS** - Server-side rendering
- **SQLite** (dev) / **PostgreSQL** (production) - Dual database adapter
- **Tailwind CSS** via CDN - No build step
- **SimpleWebAuthn** - Passkey/Face ID/Touch ID authentication
- **OpenAI Whisper** - Audio transcription
- **GPT-4o-mini** - Transcript summarization
- **PDF.js + Fabric.js** - Canvas drawing and PDF annotation

## Commands

```bash
npm install     # Install dependencies
npm run dev     # Start with nodemon (auto-reload)
npm start       # Production start
```

## Project Structure

```
notes/
├── server.js           # Express app entry point
├── db/
│   ├── index.js        # SQLite/PostgreSQL adapter
│   └── init.js         # Schema initialization
├── routes/
│   ├── auth.js         # Passkey authentication
│   └── notes.js        # Notes, folders CRUD
├── middleware/
│   └── auth.js         # requireAuth middleware
├── utils/
│   └── openai.js       # Whisper + GPT integration
├── views/
│   ├── layouts/main.ejs
│   ├── login.ejs
│   ├── settings.ejs
│   ├── error.ejs
│   └── notes/
│       ├── index.ejs      # Notes list (home)
│       └── annotator.ejs  # Note canvas (ink or PDF)
└── public/
    ├── js/
    │   └── annotator.js   # Canvas drawing, audio recording
    ├── uploads/           # PDF files
    └── backgrounds/       # Random background images
```

## Database Schema

- `user` - Single user (id=1)
- `passkey_credentials` - WebAuthn credentials
- `folders` - Folder organization
- `notes` - Notes with canvas state, optional PDF, and audio transcript

Each note has:
- `canvas_states` - JSON of Fabric.js canvas per page
- `pdf_filename` - Optional PDF background
- `transcript` - Audio transcript text
- `summary` - AI-generated summary

## Key Features

### Note = Canvas
Each note is a single ink canvas. No separate "blocks" - the annotator IS the note.
- `/note/:id` goes directly to the annotator view
- Create note -> opens blank canvas
- Import PDF -> PDF becomes permanent background

### Audio Recording
- Microphone button in toolbar opens audio panel
- Sidebar on iPad, bottom bar on mobile
- 15-second chunks transcribed via Whisper API
- Summarize button generates AI summary

### Ink & PDF Annotation
- Smooth Bezier curves via custom SmoothPencilBrush
- Palm rejection for stylus (iPad, Samsung S Pen)
- Tools: pen, highlighter, eraser, shapes, text, select, pan
- Pinch-to-zoom, floating draggable toolbar
- 50-level undo/redo per page

### Passkey Authentication
- Single-user app protected by Face ID / Touch ID
- Discoverable credentials (no username needed)

## Environment Variables

```
DATABASE_URL         - PostgreSQL connection (Railway)
SESSION_SECRET       - Session encryption key
WEBAUTHN_RP_ID       - Domain for passkey (e.g., notes.up.railway.app)
WEBAUTHN_ORIGIN      - Full URL (e.g., https://notes.up.railway.app)
OPENAI_API_KEY       - For Whisper + GPT
```

## API Endpoints

- `POST /note` - Create new ink note
- `POST /note/pdf` - Create note with PDF background
- `GET /note/:id` - View/edit note (annotator)
- `POST /note/:id/canvas` - Save canvas state
- `GET /note/:id/canvas` - Get canvas state
- `POST /note/:id/transcribe` - Transcribe audio chunk
- `GET /note/:id/transcript` - Get transcript & summary
- `POST /note/:id/summarize` - Generate AI summary

## Deployment (Railway)

1. Create PostgreSQL database
2. Set environment variables
3. Deploy from GitHub
4. First visit will prompt passkey setup
