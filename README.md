# Генератор промпта

Node.js MVP that accepts text notes and voice notes, transcribes audio, and generates a final prompt from the combined input.

## Stack

- Backend: Node.js + Express
- Frontend: HTML + CSS + vanilla JavaScript
- LLM pipeline: OpenAI Responses API
- Speech-to-text: OpenAI Audio Transcriptions API

## Quick start

1. Copy `.env.example` to `.env`
2. Fill in `OPENAI_API_KEY`
3. If frontend and backend are split, set the backend URL in `public/config.js`
4. Run `npm install`
5. Run `npm run dev`
6. Open `http://localhost:3000`

## What was fixed

- Added more resilient audio handling for browser recordings.
- Backend now accepts a wider range of browser MIME types, including `audio/ogg`, `video/webm`, and `video/mp4`.
- Backend now normalizes browser MIME types and filenames before sending audio to OpenAI.
- Empty recordings are rejected before upload.
- Frontend can now work with same-origin backend by default when `API_BASE_URL` is empty.

## Backend connection status on frontend

The frontend shows a dedicated backend connection indicator in the page header.
It checks `GET /api/health` on load and then repeats the check every 30 seconds.

Before deploying the static site separately, update `public/config.js`:

```js
window.APP_CONFIG = {
  API_BASE_URL: 'https://your-backend.onrender.com'
};
```

If frontend and backend live on the same domain, keep `API_BASE_URL` empty.

## Render deployment (Variant A)

This project is configured for a split deployment:

- frontend on **Render Static Site**
- backend on **Render Web Service**

### Frontend configuration

Edit `public/config.js` and set your backend URL only when frontend and backend are on different origins:

```js
window.APP_CONFIG = {
  API_BASE_URL: 'https://your-backend.onrender.com'
};
```

### Backend configuration

Set these environment variables in the Render Web Service:

```env
PORT=10000
CLIENT_ORIGIN=https://your-frontend.onrender.com
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-5.4-mini
OPENAI_MAX_OUTPUT_TOKENS=2200
OPENAI_REASONING_EFFORT=low
OPENAI_TIMEOUT_MS=60000
TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
TRANSCRIPTION_LANGUAGE=ru
TRANSCRIPTION_TIMEOUT_MS=90000
MAX_AUDIO_SIZE_MB=25
```

### How frontend and backend communicate

The frontend reads the backend base URL from `public/config.js` and sends requests to:

- `${API_BASE_URL}/api/transcribe`
- `${API_BASE_URL}/api/prompt/pipeline`

If `API_BASE_URL` is empty, the frontend uses the current site origin.
