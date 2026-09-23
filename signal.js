// Signalling socket that survives Wi-Fi hiccups and phone sleep: reconnects with backoff,
// detects silently dead connections (half-open TCP after a Wi-Fi nap), and runs handlers
// one at a time so WebRTC operations never interleave.
const PING_EVERY_MS = 4000;
const DEAD_AFTER_MS = 8000; // unanswered ping this old => connection is dead
const MAX_RETRY_MS = 5000;

function connectSignal({ onOpen, onMessage, onDown }) {
  let socket = null;
  let retryDelay = 500;
  let retryTimer;
  let pingSentAt = 0;
  let closed = false;
  let queue = Promise.resolve();

  const run = (fn) =>
    (queue = queue.then(fn).catch((e) => console.warn("signal task failed", e)));

  function open() {
    clearTimeout(retryTimer);
    const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    socket = s;
    pingSentAt = 0;
    s.onopen = () => {
      if (s !== socket) return;
      retryDelay = 500;
      run(onOpen);
    };
    s.onmessage = ({ data }) => {
      if (s !== socket) return;
      pingSentAt = 0;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type !== "pong") run(() => onMessage(msg));
    };
    s.onclose = () => {
      if (s === socket) lost();
    };
  }

  // Abandon the current socket without waiting for a close handshake that may never come
  function lost() {
    const s = socket;
    socket = null;
    if (s) s.close();
    if (closed) return;
    onDown?.();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }

  function ping() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (!pingSentAt) pingSentAt = Date.now();
    socket.send('{"type":"ping"}');
  }

  // Timers may be throttled in background tabs; only an unanswered ping counts as dead
  const heartbeat = setInterval(() => {
    if (pingSentAt && Date.now() - pingSentAt > DEAD_AFTER_MS) lost();
    else ping();
  }, PING_EVERY_MS);

  // Network came back or the user returned to the tab: retry now instead of waiting out the backoff
  function wake() {
    if (closed) return;
    if (!socket) {
      retryDelay = 500;
      open();
    } else ping();
  }
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wake();
  });

  open();

  return {
    run,
    get isOpen() {
      return socket?.readyState === WebSocket.OPEN;
    },
    send(msg) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
  };
}
