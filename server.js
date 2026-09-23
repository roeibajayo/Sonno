const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = 3000;

// Simple static file server
const server = http.createServer((req, res) => {
  let filePath = path.join(
    __dirname,
    req.url === "/" ? "/sender.html" : req.url,
  );
  const ext = path.extname(filePath);
  const mimeTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// Single shared session: one sender, many receivers
let sender = null;
const receivers = new Set();

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function findReceiver(id) {
  for (const r of receivers) if (r.receiverId === id) return r;
  return null;
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

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "start": {
        // A new sender replaces any existing one
        if (sender && sender !== ws) sender.close();
        sender = ws;
        ws.role = "sender";
        send(ws, { type: "started" });
        // Offer to receivers that were already waiting
        receivers.forEach((r) =>
          send(ws, { type: "receiver-joined", receiverId: r.receiverId }),
        );
        break;
      }

      case "join": {
        ws.role = "receiver";
        ws.receiverId = Date.now() + Math.random().toString(36).slice(2);
        receivers.add(ws);
        send(ws, { type: "joined", live: !!sender });
        send(sender, { type: "receiver-joined", receiverId: ws.receiverId });
        break;
      }

      // WebRTC signalling — relay between sender and receivers
      case "offer": {
        if (ws !== sender) return;
        send(findReceiver(msg.targetId), { type: "offer", sdp: msg.sdp });
        break;
      }

      case "answer": {
        if (ws.role !== "receiver") return;
        send(sender, {
          type: "answer",
          sdp: msg.sdp,
          receiverId: ws.receiverId,
        });
        break;
      }

      case "ice-candidate": {
        if (ws === sender) {
          const target = findReceiver(msg.targetId);
          if (!target) return;
          send(target, {
            type: "ice-candidate",
            candidate: senderCandidateFor(target, msg.candidate),
          });
        } else if (ws.role === "receiver") {
          const extra = extraReceiverCandidate(ws, msg.candidate);
          [msg.candidate, extra].filter(Boolean).forEach((candidate) =>
            send(sender, {
              type: "ice-candidate",
              candidate,
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
      sender = null;
      receivers.forEach((r) => send(r, { type: "sender-disconnected" }));
    } else if (ws.role === "receiver") {
      receivers.delete(ws);
      send(sender, { type: "receiver-left", receiverId: ws.receiverId });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🔊 PhoneSpeaker server running at http://localhost:${PORT}`);
  console.log(`   Sender:   http://localhost:${PORT}/sender.html`);
  console.log(`   Receiver: http://localhost:${PORT}/receiver.html\n`);
});
