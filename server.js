import 'dotenv/config';

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { DefaultAzureCredential } from '@azure/identity';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3001);
const VOICELIVE_ENDPOINT = process.env.VOICELIVE_ENDPOINT || '';
const VOICELIVE_API_VERSION = process.env.VOICELIVE_API_VERSION || '2025-10-01';
const AGENT_PROJECT_NAME = process.env.AGENT_PROJECT_NAME || '';
const AGENT_NAME = process.env.AGENT_NAME || '';
const AGENT_VERSION = process.env.AGENT_VERSION || '';
const AGENT_ID = process.env.AGENT_ID || '';
const AGENT_PARAM_STYLE = (process.env.AGENT_PARAM_STYLE || 'new').toLowerCase();

// Entra scope required by Voice Live. The Foundry Agent Service leg of the
// connection uses the same audience.
const AI_SCOPE = 'https://ai.azure.com/.default';

if (!VOICELIVE_ENDPOINT) {
  throw new Error('VOICELIVE_ENDPOINT is not set.');
}
if (!AGENT_PROJECT_NAME || (!AGENT_NAME && !AGENT_ID)) {
  throw new Error('AGENT_PROJECT_NAME and AGENT_NAME (or AGENT_ID) must be set.');
}

const credential = new DefaultAzureCredential();

/** @type {{ token: string, expiresOnTimestamp: number } | null} */
let cachedToken = null;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresOnTimestamp - now > 5 * 60 * 1000) {
    return cachedToken.token;
  }
  const result = await credential.getToken(AI_SCOPE);
  if (!result) {
    throw new Error(`Failed to acquire a token for ${AI_SCOPE}.`);
  }
  cachedToken = result;
  return result.token;
}

function buildUpstreamUrl() {
  const base = new URL(VOICELIVE_ENDPOINT);
  const url = new URL('/voice-live/realtime', `wss://${base.host}`);
  url.searchParams.set('api-version', VOICELIVE_API_VERSION);
  url.searchParams.set('agent-project-name', AGENT_PROJECT_NAME);

  if (AGENT_PARAM_STYLE === 'classic') {
    url.searchParams.set('agent-id', AGENT_ID || AGENT_NAME);
  } else {
    url.searchParams.set('agent-name', AGENT_NAME);
    if (AGENT_VERSION) {
      url.searchParams.set('agent-version', AGENT_VERSION);
    }
  }
  return url.toString();
}

function buildAvatarConfig() {
  const kind = (process.env.AVATAR_KIND || 'photo').toLowerCase();
  if (kind === 'none') return null;

  const character = (process.env.AVATAR_CHARACTER || 'camila').toLowerCase();
  const style = process.env.AVATAR_STYLE || '';
  const customized = String(process.env.AVATAR_CUSTOMIZED || 'false') === 'true';
  const backgroundImageUrl = process.env.AVATAR_BACKGROUND_IMAGE_URL || '';
  const backgroundColor = process.env.AVATAR_BACKGROUND_COLOR || '';

  // 'webrtc' streams avatar media directly from the browser to an Azure TURN
  // relay, which corporate networks often block. 'websocket' muxes the avatar
  // into this session's WebSocket instead, so it follows the same path as the
  // rest of the traffic.
  const outputProtocol =
    (process.env.AVATAR_OUTPUT || 'webrtc').toLowerCase() === 'websocket' ? 'websocket' : 'webrtc';

  const video = {
    codec: 'h264',
    bitrate: kind === 'photo' ? 500000 : 1000000,
    resolution: { width: 1920, height: 1080 },
  };
  if (backgroundImageUrl) {
    video.background = { image_url: backgroundImageUrl };
  } else if (backgroundColor) {
    // Real-time avatar discards the alpha byte, so #00000000 renders as opaque
    // black rather than transparent. That is what additive displays need anyway.
    video.background = { color: backgroundColor };
  }

  if (kind === 'photo') {
    return {
      type: 'photo-avatar',
      model: 'vasa-1',
      character,
      ...(style ? { style } : {}),
      ...(customized ? { customized: true } : {}),
      output_protocol: outputProtocol,
      video,
      scene: {
        zoom: 1.0,
        position_x: 0.0,
        position_y: 0.0,
        rotation_x: 0.0,
        rotation_y: 0.0,
        rotation_z: 0.0,
        amplitude: 0.6,
      },
    };
  }

  // Standard (video) text-to-speech avatar, e.g. lisa / casual-sitting.
  return {
    character,
    ...(style ? { style } : {}),
    customized,
    output_protocol: outputProtocol,
    video: {
      ...video,
      crop: { top_left: [560, 0], bottom_right: [1360, 1080] },
    },
  };
}

// Spoken filler ("Let me check...") while the agent is still thinking. This does
// not reduce latency, but it removes the dead air that makes it noticeable.
// Field names are not in the published wire reference; they were confirmed
// against the service, which echoes them back in session.updated.
function buildInterimResponse() {
  const mode = (process.env.INTERIM_RESPONSE || 'off').toLowerCase();
  if (mode !== 'static' && mode !== 'llm') return null;

  const base = {
    triggers: (process.env.INTERIM_RESPONSE_TRIGGERS || 'latency')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    latency_threshold_ms: Number(process.env.INTERIM_RESPONSE_THRESHOLD_MS || 500),
  };

  if (mode === 'llm') {
    return {
      ...base,
      type: 'llm_interim_response',
      model: process.env.INTERIM_RESPONSE_MODEL || 'gpt-4.1-mini',
      ...(process.env.INTERIM_RESPONSE_INSTRUCTIONS
        ? { instructions: process.env.INTERIM_RESPONSE_INSTRUCTIONS }
        : {}),
      max_completion_tokens: Number(process.env.INTERIM_RESPONSE_MAX_TOKENS || 50),
    };
  }

  return {
    ...base,
    type: 'static_interim_response',
    texts: (process.env.INTERIM_RESPONSE_TEXTS ||
      'Let me check that.|One moment.|Let me look that up.|Give me a second.')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

const clientConfig = {
  // Nothing about the Foundry project leaks to the browser unless it is set
  // explicitly here, so the demo can carry a friendly title instead.
  title: process.env.DISPLAY_TITLE || AGENT_NAME || AGENT_ID,
  subtitle: process.env.DISPLAY_SUBTITLE || '',
  greetOnConnect: String(process.env.GREET_ON_CONNECT || 'true') === 'true',
  greeting: process.env.GREETING_TEXT || '',
  showTranscript: String(process.env.SHOW_TRANSCRIPT || 'true') === 'true',
  session: {
    modalities: ['text', 'audio'],
    input_audio_sampling_rate: 24000,
    input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
    input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
    input_audio_transcription: { model: 'azure-speech' },
    turn_detection: {
      type: process.env.TURN_DETECTION_TYPE || 'azure_semantic_vad',
      // Dead time before the agent is even asked. Semantic VAD also weighs
      // whether the sentence sounds finished, so this can run short.
      silence_duration_ms: Number(process.env.VAD_SILENCE_MS || 300),
    },
    voice: {
      name: process.env.VOICE_NAME || 'en-US-Ava:DragonHDLatestNeural',
      type: process.env.VOICE_TYPE || 'azure-standard',
      temperature: Number(process.env.VOICE_TEMPERATURE || 0.8),
    },
    ...(buildAvatarConfig() ? { avatar: buildAvatarConfig() } : {}),
    ...(buildInterimResponse() ? { interim_response: buildInterimResponse() } : {}),
  },
};

const app = express();
app.disable('x-powered-by');

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
    },
  })
);

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// The browser never sees an Entra token or an API key: it only receives the
// session shape it should request. Credentials stay on the server.
app.get('/api/config', (_req, res) => res.json(clientConfig));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function allowedOrigins(req) {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const host = req.headers.host;
  const own = host ? [`https://${host}`, `http://${host}`] : [];
  return new Set([...own, ...configured]);
}

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  // Non-browser clients omit Origin; browsers always send it. Requiring a match
  // prevents cross-site WebSocket hijacking of the proxied agent session.
  if (!origin) return false;
  return allowedOrigins(req).has(origin);
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/realtime') {
    socket.destroy();
    return;
  }
  if (!isOriginAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', async (browserWs) => {
  let upstream;
  const pending = [];

  const closeBoth = (code, reason) => {
    const safeCode = code >= 1000 && code <= 4999 ? code : 1011;
    try {
      browserWs.close(safeCode, reason);
    } catch {
      /* already closed */
    }
    try {
      upstream?.close();
    } catch {
      /* already closed */
    }
  };

  // Voice Live rejects binary frames for control events, so the text/binary
  // flag must survive the hop through this proxy.
  browserWs.on('message', (data, isBinary) => {
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      pending.push({ data, isBinary });
    }
  });
  browserWs.on('close', () => closeBoth(1000, 'client closed'));
  browserWs.on('error', () => closeBoth(1011, 'client error'));

  try {
    const token = await getAccessToken();
    upstream = new WebSocket(buildUpstreamUrl(), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    console.error('Failed to acquire Entra token:', err.message);
    browserWs.send(
      JSON.stringify({
        type: 'error',
        error: { message: 'Server could not authenticate to Microsoft Foundry.' },
      })
    );
    closeBoth(1011, 'auth failure');
    return;
  }

  upstream.on('open', () => {
    while (pending.length) {
      const { data, isBinary } = pending.shift();
      upstream.send(data, { binary: isBinary });
    }
  });
  upstream.on('message', (data, isBinary) => {
    if (browserWs.readyState === WebSocket.OPEN) browserWs.send(data, { binary: isBinary });
  });
  upstream.on('close', (code, reason) => closeBoth(code, reason?.toString() || ''));
  upstream.on('error', (err) => {
    console.error('Voice Live upstream error:', err.message);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: 'error',
          error: { message: 'Upstream Voice Live connection failed.' },
        })
      );
    }
    closeBoth(1011, 'upstream error');
  });
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Proxying to ${buildUpstreamUrl().replace(/Authorization=[^&]*/, '')}`);
});
