const SAMPLE_RATE = 24000;

const els = {
  toggle: document.getElementById('toggle'),
  status: document.getElementById('status'),
  avatar: document.getElementById('avatar'),
  placeholder: document.getElementById('placeholder'),
  transcript: document.getElementById('transcript'),
  agentName: document.getElementById('agent-name'),
  agentProject: document.getElementById('agent-project'),
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

// ---------------------------------------------------------------- utilities

function setStatus(text, kind = 'idle') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function log(text, kind = 'system') {
  const div = document.createElement('div');
  div.className = `line ${kind}`;
  div.textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
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
      const ice = event.session?.avatar?.ice_servers;
      if (config.session.avatar) {
        startAvatar(ice).catch((err) => fail(`Avatar setup failed: ${err.message}`));
      } else {
        setStatus('Live', 'live');
        els.placeholder.hidden = false;
      }
      break;
    }

    case 'session.avatar.connecting':
      acceptAvatarAnswer(event.server_sdp).catch((err) =>
        fail(`Avatar negotiation failed: ${err.message}`)
      );
      break;

    case 'input_audio_buffer.speech_started':
      // Barge-in: drop anything still queued locally.
      player?.stop();
      break;

    case 'conversation.item.input_audio_transcription.completed':
      if (event.transcript) log(event.transcript, 'user');
      break;

    case 'response.created':
      assistantLine = null;
      break;

    case 'response.audio_transcript.delta':
    case 'response.text.delta':
      if (event.delta) {
        if (!assistantLine) assistantLine = log('', 'assistant');
        assistantLine.textContent += event.delta;
        els.transcript.scrollTop = els.transcript.scrollHeight;
      }
      break;

    case 'response.done':
      assistantLine = null;
      break;

    case 'response.audio.delta':
      if (!config.session.avatar && event.delta) {
        const bytes = base64ToBytes(event.delta);
        player?.play(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
      }
      break;

    case 'error':
      log(event.error?.message || 'Unknown error from Voice Live.', 'error');
      break;

    default:
      break;
  }
}

function greet() {
  send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: 'Greet the user briefly to start the conversation.' }],
    },
  });
  send({ type: 'response.create' });
}

// ------------------------------------------------------------------ lifecycle

function fail(message) {
  log(message, 'error');
  setStatus('Error', 'error');
  stop();
}

async function start() {
  els.toggle.disabled = true;
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
    setStatus('Negotiating…');
    send({ type: 'session.update', session: config.session });
    if (config.greetOnConnect) setTimeout(greet, 800);
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

function stop() {
  running = false;
  avatarStarted = false;
  assistantLine = null;

  try {
    ws?.close();
  } catch {
    /* already closed */
  }
  ws = null;

  peer?.getSenders().forEach((sender) => sender.track?.stop());
  peer?.close();
  peer = null;

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

  els.avatar.replaceChildren();
  els.placeholder.hidden = false;
  els.toggle.disabled = false;
  els.toggle.textContent = 'Start';
  els.toggle.classList.remove('stop');
  if (els.status.className.indexOf('error') === -1) setStatus('Idle');
}

els.toggle.addEventListener('click', () => (running ? stop() : start()));
window.addEventListener('beforeunload', stop);

(async function init() {
  try {
    config = await (await fetch('/api/config')).json();
    els.agentName.textContent = config.agentName;
    els.agentProject.textContent = `Foundry project: ${config.projectName}`;
  } catch {
    fail('Could not load app configuration.');
  }
})();
