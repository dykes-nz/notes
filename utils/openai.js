/**
 * OpenAI Integration
 * - Whisper API for audio transcription
 * - GPT-4o-mini for summarisation
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

let openai = null;

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

function getClient() {
  if (!openai && isConfigured()) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openai;
}

/**
 * Convert audio to mp3 format using ffmpeg
 */
function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

/**
 * Transcribe audio using Whisper API
 * @param {Buffer} audioBuffer - Audio data (webm, mp3, wav, etc.)
 * @param {string} mimeType - MIME type of the audio
 * @returns {Promise<{text: string, segments?: Array, duration?: number}>}
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
  const client = getClient();
  if (!client) {
    throw new Error('OpenAI not configured');
  }

  // Determine file extension from mime type (strip codec info like ;codecs=opus)
  const baseMime = mimeType.split(';')[0].trim().toLowerCase();
  let ext = 'webm';
  if (baseMime.includes('mp4') || baseMime.includes('m4a')) {
    ext = 'mp4';
  } else if (baseMime.includes('mp3') || baseMime.includes('mpeg')) {
    ext = 'mp3';
  } else if (baseMime.includes('wav')) {
    ext = 'wav';
  } else if (baseMime.includes('ogg') || baseMime.includes('oga')) {
    ext = 'ogg';
  } else if (baseMime.includes('webm')) {
    ext = 'webm';
  }

  console.log('Transcribing audio:', { mimeType, baseMime, ext, bufferSize: audioBuffer.length });

  const timestamp = Date.now();
  const tempInputPath = path.join(os.tmpdir(), `whisper-input-${timestamp}.${ext}`);
  const tempOutputPath = path.join(os.tmpdir(), `whisper-output-${timestamp}.mp3`);

  // Common Whisper hallucinations to filter out
  const HALLUCINATION_PATTERNS = [
    /^thanks?\.?$/i,
    /^thank you\.?$/i,
    /^thanks for watching\.?$/i,
    /^have a good one\.?$/i,
    /^bye\.?$/i,
    /^goodbye\.?$/i,
    /^see you\.?$/i,
    /^take care\.?$/i,
    /^subscribe.*$/i,
    /transcribed? by/i,
    /^\s*$/
  ];

  function isHallucination(text) {
    const trimmed = text.trim();
    return HALLUCINATION_PATTERNS.some(pattern => pattern.test(trimmed));
  }

  try {
    // Write input file
    fs.writeFileSync(tempInputPath, audioBuffer);

    // Convert to mp3 to ensure compatibility
    console.log('Converting audio to mp3...');
    await convertToMp3(tempInputPath, tempOutputPath);
    console.log('Audio conversion complete');

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempOutputPath),
      model: 'whisper-1',
      language: 'en',
      // Whisper uses the prompt as style context - primes UK English spelling
      prompt: 'This transcript uses UK English spelling: colour, organise, realise, centre, favourite.',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });

    // Build paragraphs from segment timing: a silence gap of >= 1s between
    // segments starts a new paragraph (joined with \n\n)
    const PAUSE_THRESHOLD = 1.0;
    const segments = transcription.segments || [];
    let paragraphs = [];
    let leadingPause = false;

    if (segments.length > 0) {
      // Chunk starts with >= 1s of silence - caller should break before appending
      leadingPause = segments[0].start >= PAUSE_THRESHOLD;

      let current = '';
      let prevEnd = null;
      for (const seg of segments) {
        const segText = (seg.text || '').trim();
        if (!segText) continue;
        if (current && prevEnd !== null && seg.start - prevEnd >= PAUSE_THRESHOLD) {
          paragraphs.push(current);
          current = segText;
        } else {
          current = current ? current + ' ' + segText : segText;
        }
        prevEnd = seg.end;
      }
      if (current) paragraphs.push(current);
    } else if (transcription.text) {
      paragraphs = [transcription.text];
    }

    // Filter out hallucinated paragraphs
    paragraphs = paragraphs.filter(p => {
      if (isHallucination(p)) {
        console.log('Filtered hallucination:', p);
        return false;
      }
      return true;
    });

    return {
      text: paragraphs.join('\n\n'),
      leadingPause: leadingPause,
      segments: segments,
      duration: transcription.duration
    };
  } finally {
    // Clean up temp files
    try {
      fs.unlinkSync(tempInputPath);
    } catch (e) {
      // Ignore cleanup errors
    }
    try {
      fs.unlinkSync(tempOutputPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Summarise transcript using GPT-4o-mini
 * @param {string} transcript - Full transcript text
 * @param {string} title - Optional note title for context
 * @returns {Promise<string>} Summary text
 */
async function summariseTranscript(transcript, title = '') {
  const client = getClient();
  if (!client) {
    throw new Error('OpenAI not configured');
  }

  const systemPrompt = `You are a helpful assistant that summarises audio transcripts into clear, concise notes.

RULES:
- Output ONLY bullet points, one per line, each starting with "- "
- No headings, intro text, or nested bullets
- Keep each bullet to ONE short sentence
- Extract key points, decisions, and action items
- Be brief - less is more
- Use simple, clear language
- Use UK English spelling (organise, colour, centre)`;

  const userPrompt = `${title ? `Title: ${title}\n\n` : ''}Transcript:\n${transcript}\n\nCreate a brief summary with bullet points.`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.3,
    max_tokens: 1000
  });

  return response.choices[0]?.message?.content || '';
}

module.exports = {
  isConfigured,
  transcribeAudio,
  summariseTranscript
};
