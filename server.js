const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = 3000;
const HEARTBEAT_MS = 10000;

const mimeTypes = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
};

// Simple static file server
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    urlPath = "";
  }
  const filePath = path.join(__dirname, urlPath === "/" ? "sender.html" : urlPath);
  if (!filePath.startsWith(__dirname + path.sep)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    // no-cache: phones otherwise keep running an old receiver after an update
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "text/plain",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// Single shared session: one sender, many receivers.
// Receivers are keyed by a client-chosen id so a reconnecting phone keeps its identity
// and the sender can keep the existing (still working) peer connection.
let sender = null;
const receivers = new Map();

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

const ipv4 = (addr) => addr.replace(/^::ffff:/, "");

// Swap a candidate's connection address (field 4), keeping port and type
function withAddress(candidate, address) {
  const parts = candidate.candidate.split(" ");
  parts[4] = address;
  return { ...candidate, candidate: parts.join(" ") };
}

// Chrome hides host IPs behind "<uuid>.local" names, which only resolve on the same
// subnet. The sender runs on this machine, so its real IP is whatever address the
// receiver used to reach the server.
function senderCandidateFor(receiver, candidate) {
  if (!candidate?.candidate?.split(" ")[4]?.endsWith(".local")) return candidate;
  return withAddress(candidate, ipv4(receiver._socket.localAddress));
}

// A receiver behind another router (NAT) is only reachable at the address the server
// sees it connect from. Offering that too lets the sender punch through.
function extraReceiverCandidate(receiver, candidate) {
  const parts = candidate?.candidate?.split(" ") ?? [];
  const seenAs = ipv4(receiver._socket.remoteAddress);
  if (parts[7] !== "host" || parts[4] === seenAs || seenAs.includes(":")) return null;
  return withAddress(candidate, seenAs);
}

const clientIdOf = (msg) =>
  typeof msg.clientId === "string" && /^[\w-]{1,64}$/.test(msg.clientId)
    ? msg.clientId
    : Date.now() + Math.random().toString(36).slice(2);

wss.on("connection", (ws) => {
  ws.role = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "ping": {
        send(ws, { type: "pong" });
        break;
      }

      case "start": {
        // A new sender replaces any existing one; tell the old page so it stops reconnecting
        if (sender && sender !== ws) {
          send(sender, { type: "replaced" });
          sender.close();
        }
        sender = ws;
        ws.role = "sender";
        send(ws, { type: "started" });
        // Offer to receivers that were already waiting (or re-announce after a sender reconnect)
        receivers.forEach((r, receiverId) => {
          send(ws, { type: "receiver-joined", receiverId, pcId: r.pcId });
          send(r, { type: "sender-live" });
        });
        break;
      }

      case "stop": {
        if (ws !== sender) return;
        sender = null;
        receivers.forEach((r) => send(r, { type: "sender-stopped" }));
        break;
      }

      case "join": {
        const receiverId = clientIdOf(msg);
        const previous = receivers.get(receiverId);
        ws.role = "receiver";
        ws.receiverId = receiverId;
        ws.pcId = typeof msg.pcId === "string" ? msg.pcId : null;
        receivers.set(receiverId, ws);
        // Same phone reconnected before its old socket timed out
        if (previous && previous !== ws) previous.terminate();
        send(ws, { type: "joined", live: !!sender });
        send(sender, { type: "receiver-joined", receiverId, pcId: ws.pcId });
        break;
      }

      // WebRTC signalling — relay between sender and receivers
      case "offer": {
        if (ws !== sender) return;
        send(receivers.get(msg.targetId), { type: "offer", pcId: msg.pcId, sdp: msg.sdp });
        break;
      }

      case "answer": {
        if (ws.role !== "receiver") return;
        ws.pcId = msg.pcId;
        send(sender, {
          type: "answer",
          sdp: msg.sdp,
          pcId: msg.pcId,
          receiverId: ws.receiverId,
        });
        break;
      }

      case "ice-candidate": {
        if (ws === sender) {
          const target = receivers.get(msg.targetId);
          if (!target) return;
          send(target, {
            type: "ice-candidate",
            pcId: msg.pcId,
            candidate: senderCandidateFor(target, msg.candidate),
          });
        } else if (ws.role === "receiver") {
          const extra = extraReceiverCandidate(ws, msg.candidate);
          [msg.candidate, extra].filter(Boolean).forEach((candidate) =>
            send(sender, {
              type: "ice-candidate",
              candidate,
              pcId: msg.pcId,
              receiverId: ws.receiverId,
            }),
          );
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (ws === sender) {
      // Signalling only — peer connections may still be playing, so receivers keep them
      sender = null;
      receivers.forEach((r) => send(r, { type: "sender-disconnected" }));
    } else if (ws.role === "receiver" && receivers.get(ws.receiverId) === ws) {
      receivers.delete(ws.receiverId);
      send(sender, { type: "receiver-left", receiverId: ws.receiverId });
    }
  });
});

// Drop sockets whose peer vanished without closing (phone lost Wi-Fi, went to sleep)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`\n🔊 PhoneSpeaker server running at http://localhost:${PORT}`);
  console.log(`   Sender:   http://localhost:${PORT}/sender.html`);
  console.log(`   Receiver: http://localhost:${PORT}/receiver.html\n`);
});
