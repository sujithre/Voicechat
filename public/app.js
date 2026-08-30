const SAMPLE_RATE = 24000;

// H.264 video + AAC audio, matching the fragmented MP4 the avatar service emits
// when output_protocol is 'websocket'.
const FMP4_MIME = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

const els = {
  toggle: document.getElementById('toggle'),
  status: document.getElementById('status'),
  avatar: document.getElementById('avatar'),
  placeholder: document.getElementById('placeholder'),
  transcript: document.getElementById('transcript'),
  transcriptToggle: document.getElementById('transcript-toggle'),
  mute: document.getElementById('mute'),
  agentName: document.getElementById('agent-name'),
  agentSubtitle: document.getElementById('agent-subtitle'),
  logo: document.getElementById('logo'),
  state: document.getElementById('state'),
  stateLabel: document.getElementById('state-label'),
  caption: document.getElementById('caption'),
  captionUser: document.getElementById('caption-user'),
  captionText: document.getElementById('caption-text'),
};

let config = null;
let ws = null;
let peer = null;
let micStream = null;
let audioCtx = null;
let workletNode = null;
let sourceNode = null;
let player = null;
let avatarStarted = false;
let running = false;
let assistantLine = null;
let assistantRaw = '';
let kickedOff = false;
let interimArmed = false;
let micMuted = false;

let mediaSource = null;
let sourceBuffer = null;
let videoQueue = [];

// ---------------------------------------------------------------- utilities

function setStatus(text, kind = 'idle') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

// Conversation state shown over the avatar: listening | thinking | speaking.
const STATE_LABELS = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  muted: 'Muted',
};

let convState = null;

function setConvState(next) {
  // While muted nothing can be heard, so the service's own state events would
  // only contradict what the presenter sees.
  if (micMuted && next && next !== 'muted') return;
  if (!next) {
    convState = null;
    els.state.hidden = true;
    els.state.className = 'state';
    return;
  }
  if (convState === next) return;
  convState = next;
  els.state.hidden = false;
  els.state.className = `state ${next}`;
  els.stateLabel.textContent = STATE_LABELS[next];
}

// Agent replies are authored for reading, not for a caption bar: strip markdown
// and the 【6:0†source】 style citation markers the Foundry agent emits.
function cleanText(text) {
  return text
    .replace(/【[^】]*】/g, '')
    .replace(/\[\d+:\d+†[^\]]*\]/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(?<!\*)\*(?!\s)([^*]+?)\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    // The agent hyphenates acronyms (F-R-A) so the voice spells them out; the
    // caption should still read FRA.
    .replace(/\b[A-Z](?:-[A-Z]){1,5}s?\b/g, (match) => match.replace(/-/g, ''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

function showCaption(text) {
  els.caption.hidden = false;
  els.captionText.textContent = text;
  // The caption box is two lines tall and clipped, so keep the newest text visible.
  els.captionText.scrollTop = els.captionText.scrollHeight;
}

function showUserCaption(text) {
  els.captionUser.hidden = !text;
  els.captionUser.textContent = text || '';
}

function clearCaptions() {
  els.caption.hidden = true;
  els.captionText.textContent = '';
  showUserCaption('');
}

function log(text, kind = 'system') {
  const div = document.createElement('div');
  div.className = `line ${kind}`;
  div.textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
}

function revealTranscript() {
  els.transcript.hidden = false;
  els.transcriptToggle.setAttribute('aria-expanded', 'true');
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function send(event) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ------------------------------------------------------- audio-only playback
// Used when the avatar is disabled. With an avatar the service delivers audio
// on the WebRTC track instead, so nothing is played here.

function createPlayer(ctx) {
  let cursor = 0;
  const sources = new Set();

  return {
    play(int16) {
      const buffer = ctx.createBuffer(1, int16.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 0x8000;

      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      cursor = Math.max(cursor, ctx.currentTime);
      node.start(cursor);
      cursor += buffer.duration;
      sources.add(node);
      node.onended = () => sources.delete(node);
    },
    stop() {
      for (const node of sources) {
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
      sources.clear();
      cursor = 0;
    },
  };
}

// --------------------------------------------------------------- avatar/WebRTC

async function startAvatar(iceServers) {
  if (avatarStarted) return;
  avatarStarted = true;

  peer = new RTCPeerConnection(iceServers?.length ? { iceServers } : undefined);

  peer.ontrack = (event) => {
    const media = document.createElement(event.track.kind);
    media.id = `avatar-${event.track.kind}`;
    media.srcObject = event.streams[0];
    media.autoplay = true;
    media.playsInline = true;
    if (event.track.kind === 'video') {
      els.placeholder.hidden = true;
    } else {
      media.hidden = true;
    }
    els.avatar.appendChild(media);
    media.play().catch(() => {
      /* autoplay may need a gesture; the Start click already provided one */
    });
  };

  peer.addTransceiver('video', { direction: 'sendrecv' });
  peer.addTransceiver('audio', { direction: 'sendrecv' });
  peer.createDataChannel('eventChannel');

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForIceGathering(peer);

  send({
    type: 'session.avatar.connect',
    client_sdp: btoa(JSON.stringify(peer.localDescription)),
  });
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    }, 3000);
    pc.addEventListener('icegatheringstatechange', done);
  });
}

async function acceptAvatarAnswer(serverSdpBase64) {
  const answer = JSON.parse(atob(serverSdpBase64));
  await peer.setRemoteDescription(answer);
  setStatus('Live', 'live');
}

// ------------------------------------------------- avatar over the WebSocket
// The service muxes video and audio into fragmented MP4 chunks delivered as
// response.video.delta events, so no peer connection (and no TURN relay) is
// involved. Chunks must be appended one at a time; SourceBuffer rejects a new
// append while the previous one is still updating.

function startWebSocketAvatar() {
  if (avatarStarted) return;
  avatarStarted = true;

  if (!window.MediaSource || !MediaSource.isTypeSupported(FMP4_MIME)) {
    fail('This browser cannot play the avatar stream. Use desktop Chrome, Edge or Firefox.');
    return;
  }

  const video = document.createElement('video');
  video.id = 'avatar-video';
  video.autoplay = true;
  video.playsInline = true;
  video.addEventListener('canplay', () => video.play().catch(() => {}));

  mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener('sourceopen', () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(FMP4_MIME);
      sourceBuffer.addEventListener('updateend', flushVideoQueue);
      flushVideoQueue();
    } catch (err) {
      fail(`Avatar playback setup failed: ${err.message}`);
    }
  });

  els.avatar.appendChild(video);
  els.placeholder.hidden = true;
  setStatus('Live', 'live');
}

function flushVideoQueue() {
  if (!sourceBuffer || sourceBuffer.updating) return;
  if (!mediaSource || mediaSource.readyState !== 'open') return;

  const chunk = videoQueue.shift();
  if (!chunk) return;

  try {
    sourceBuffer.appendBuffer(chunk);
  } catch (err) {
    console.error('Failed to append avatar video chunk:', err);
  }
}

function handleVideoChunk(base64) {
  videoQueue.push(base64ToBytes(base64));
  flushVideoQueue();
}

function teardownWebSocketAvatar() {
  videoQueue = [];
  if (mediaSource && mediaSource.readyState === 'open' && sourceBuffer && !sourceBuffer.updating) {
    try {
      mediaSource.endOfStream();
    } catch {
      /* stream already ended */
    }
  }
  sourceBuffer = null;
  mediaSource = null;
}

// ------------------------------------------------------------------ microphone

const MIC_PROMPT_TIMEOUT_MS = 20000;

// getUserMedia can hang indefinitely when the permission prompt is suppressed by
// policy or never answered, so every failure mode is surfaced explicitly rather
// than leaving the UI stuck on "Connecting...".
async function acquireMicrophone() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      `Microphone needs a secure context. Open the app on http://localhost or over https, not ${location.origin}.`
    );
  }

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  if (devices.length && !devices.some((d) => d.kind === 'audioinput')) {
    throw new Error('No microphone detected on this machine.');
  }

  const constraints = {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            'Timed out waiting for microphone access. Check for a permission prompt or a blocked-microphone icon in the address bar.'
          )
        ),
      MIC_PROMPT_TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([navigator.mediaDevices.getUserMedia(constraints), timeout]);
  } catch (err) {
    switch (err.name) {
      case 'NotAllowedError':
        throw new Error(
          'Microphone permission denied. Allow it via the icon in the address bar, then reload.'
        );
      case 'NotFoundError':
        throw new Error('No microphone detected on this machine.');
      case 'NotReadableError':
        throw new Error('The microphone is in use by another application.');
      default:
        throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function startMicrophone() {
  micStream = await acquireMicrophone();

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await audioCtx.audioWorklet.addModule('pcm-processor.js');
  player = createPlayer(audioCtx);

  sourceNode = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
  workletNode.port.onmessage = (event) => {
    // Disabling the track already yields silence, but the service can still open
    // a turn on it. Dropping the frames outright is what guarantees no reply.
    if (micMuted) return;
    send({
      type: 'input_audio_buffer.append',
      audio: bytesToBase64(new Uint8Array(event.data)),
    });
  };

  sourceNode.connect(workletNode);
  // Keep the worklet alive without routing the mic back to the speakers.
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  workletNode.connect(sink).connect(audioCtx.destination);
}

// ---------------------------------------------------------------- event loop

function handleServerEvent(event) {
  switch (event.type) {
    case 'session.updated': {
      const avatar = config.session.avatar;
      if (!avatar) {
        setStatus('Live', 'live');
        els.placeholder.hidden = false;
      } else if (avatar.output_protocol === 'websocket') {
        startWebSocketAvatar();
      } else {
        startAvatar(event.session?.avatar?.ice_servers).catch((err) =>
          fail(`Avatar setup failed: ${err.message}`)
        );
      }
      setConvState('listening');
      kickOff();
      break;
    }

    case 'session.avatar.connecting':
      acceptAvatarAnswer(event.server_sdp).catch((err) =>
        fail(`Avatar negotiation failed: ${err.message}`)
      );
      break;

    case 'response.video.delta':
      if (event.delta) handleVideoChunk(event.delta);
      break;

    case 'input_audio_buffer.speech_started':
      // Barge-in: drop anything still queued locally.
      player?.stop();
      setConvState('listening');
      break;

    case 'input_audio_buffer.speech_stopped':
      setConvState('thinking');
      break;

    case 'conversation.item.input_audio_transcription.completed':
      if (event.transcript) {
        log(event.transcript, 'user');
        showUserCaption(event.transcript);
      }
      break;

    case 'response.created':
      assistantLine = null;
      assistantRaw = '';
      setConvState('thinking');
      break;

    case 'response.audio_transcript.delta':
    case 'response.text.delta':
      if (event.delta) {
        assistantRaw += event.delta;
        const text = cleanText(assistantRaw);
        if (!assistantLine) assistantLine = log('', 'assistant');
        assistantLine.textContent = text;
        els.transcript.scrollTop = els.transcript.scrollHeight;
        showCaption(text);
        setConvState('speaking');
      }
      break;

    case 'response.done':
      assistantLine = null;
      assistantRaw = '';
      setConvState('listening');
      armInterimResponses();
      break;

    case 'response.audio.delta':
      setConvState('speaking');
      if (!config.session.avatar && event.delta) {
        const bytes = base64ToBytes(event.delta);
        player?.play(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
      }
      break;

    case 'error':
      log(event.error?.message || 'Unknown error from Voice Live.', 'error');
      revealTranscript();
      break;

    default:
      break;
  }
}

function greet() {
  // Asking the agent to compose a greeting produces different wording every
  // session, which is wrong for a scripted event opening.
  const text = config.greeting
    ? `Say exactly this, word for word, and nothing else: "${config.greeting}"`
    : 'Greet the user briefly to start the conversation.';

  send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text }],
    },
  });
  send({ type: 'response.create' });
}

// session.updated can arrive more than once; the opening turn must only fire once.
function kickOff() {
  if (kickedOff) return;
  kickedOff = true;

  if (config.greetOnConnect) greet();
}

// The greeting is a scripted turn, so a "let me check that" ahead of it makes no
// sense. Interim responses are withheld until it has been delivered.
function openingSessionUpdate() {
  const session = { ...config.session };
  if (config.greetOnConnect) delete session.interim_response;
  send({ type: 'session.update', session });
}

// Only the changed field is sent: the service rejects a voice change once an
// avatar is attached, and the full config carries one.
function armInterimResponses() {
  if (interimArmed || !config.session.interim_response) return;
  interimArmed = true;
  send({
    type: 'session.update',
    session: { interim_response: config.session.interim_response },
  });
}

// ------------------------------------------------------------------ lifecycle

function fail(message) {
  log(message, 'error');
  // The transcript is collapsed by default, so errors would otherwise be invisible.
  revealTranscript();
  setStatus('Error', 'error');
  stop();
}

// Muting both disables the mic track and stops forwarding frames, so the service
// receives nothing at all and cannot open a turn.
function setMuted(next) {
  micMuted = next;
  micStream?.getAudioTracks().forEach((track) => (track.enabled = !next));
  els.mute.textContent = next ? 'Unmute' : 'Mute';
  els.mute.classList.toggle('muted', next);
  els.mute.setAttribute('aria-pressed', String(next));

  // Drop whatever the service already buffered, so unmuting cannot replay a
  // half-heard utterance from before the mute.
  if (next && ws?.readyState === WebSocket.OPEN) {
    send({ type: 'input_audio_buffer.clear' });
  }
  setConvState(next ? 'muted' : 'listening');
}

async function start() {
  els.toggle.disabled = true;
  els.avatar.replaceChildren();
  clearCaptions();
  setStatus('Waiting for mic…');

  try {
    await startMicrophone();
  } catch (err) {
    els.toggle.disabled = false;
    fail(err.message);
    return;
  }

  setStatus('Connecting…');
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/realtime`);

  ws.onopen = () => {
    running = true;
    els.toggle.disabled = false;
    els.toggle.textContent = 'Stop';
    els.toggle.classList.add('stop');
    els.mute.hidden = false;
    setMuted(false);
    setStatus('Negotiating…');
    interimArmed = !config.greetOnConnect;
    openingSessionUpdate();
  };

  ws.onmessage = (message) => {
    try {
      handleServerEvent(JSON.parse(message.data));
    } catch {
      /* non-JSON frames are ignored */
    }
  };

  ws.onerror = () => log('WebSocket error.', 'error');

  ws.onclose = () => {
    if (running) log('Session closed.', 'system');
    stop();
  };
}

// Copies the frame currently on screen into a canvas. The live stream goes black
// the moment its tracks end, so this has to run before any teardown.
function captureAvatarFrame() {
  const video = els.avatar.querySelector('video');
  if (!video?.videoWidth) return null;

  const canvas = document.createElement('canvas');
  canvas.id = 'avatar-still';
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  try {
    canvas.getContext('2d').drawImage(video, 0, 0);
  } catch {
    return null;
  }
  return canvas;
}

function stop() {
  running = false;
  const still = captureAvatarFrame();
  avatarStarted = false;
  assistantLine = null;
  assistantRaw = '';
  kickedOff = false;
  interimArmed = false;
  setConvState(null);
  clearCaptions();

  try {
    ws?.close();
  } catch {
    /* already closed */
  }
  ws = null;

  peer?.getSenders().forEach((sender) => sender.track?.stop());
  peer?.close();
  peer = null;

  teardownWebSocketAvatar();

  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;

  workletNode?.port.close();
  workletNode?.disconnect();
  sourceNode?.disconnect();
  workletNode = null;
  sourceNode = null;

  player?.stop();
  player = null;
  audioCtx?.close();
  audioCtx = null;

  els.avatar.replaceChildren(...(still ? [still] : []));
  els.placeholder.hidden = Boolean(still);
  micMuted = false;
  els.mute.hidden = true;
  els.mute.textContent = 'Mute';
  els.mute.classList.remove('muted');
  els.toggle.disabled = false;
  els.toggle.textContent = 'Start';
  els.toggle.classList.remove('stop');
  if (els.status.className.indexOf('error') === -1) setStatus('Idle');
}

els.toggle.addEventListener('click', () => (running ? stop() : start()));

els.mute.addEventListener('click', () => setMuted(!micMuted));

els.transcriptToggle.addEventListener('click', () => {
  if (els.transcript.hidden) revealTranscript();
  else {
    els.transcript.hidden = true;
    els.transcriptToggle.setAttribute('aria-expanded', 'false');
  }
});

window.addEventListener('beforeunload', stop);

// The brand asset is deployment-specific and may simply not be there.
if (els.logo.complete && els.logo.naturalWidth) els.logo.hidden = false;
else els.logo.addEventListener('load', () => (els.logo.hidden = false));

(async function init() {
  try {
    config = await (await fetch('/api/config')).json();
    document.title = config.title;
    els.agentName.textContent = config.title;
    els.agentSubtitle.textContent = config.subtitle || '';
    els.agentSubtitle.hidden = !config.subtitle;
  } catch {
    fail('Could not load app configuration.');
  }
})();
