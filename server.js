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

// Rooms: roomId -> { sender, receivers[] }
const rooms = new Map();

function broadcast(clients, msg) {
  const data = JSON.stringify(msg);
  clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

wss.on("connection", (ws) => {
  ws.roomId = null;
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "create-room": {
        const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
        rooms.set(roomId, { sender: ws, receivers: [] });
        ws.roomId = roomId;
        ws.role = "sender";
        ws.send(JSON.stringify({ type: "room-created", roomId }));
        break;
      }

      case "join-room": {
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
          return;
        }
        ws.roomId = msg.roomId;
        ws.role = "receiver";
        room.receivers.push(ws);
        // Tell sender a new receiver joined
        if (room.sender && room.sender.readyState === 1) {
          room.sender.send(
            JSON.stringify({
              type: "receiver-joined",
              receiverId: ws._socket.remoteAddress + Date.now(),
            }),
          );
        }
        ws.send(JSON.stringify({ type: "room-joined", roomId: msg.roomId }));
        // Generate unique receiver id
        ws.receiverId = Date.now() + Math.random().toString(36).slice(2);
        if (room.sender && room.sender.readyState === 1) {
          room.sender.send(
            JSON.stringify({
              type: "receiver-joined",
              receiverId: ws.receiverId,
            }),
          );
        }
        break;
      }

      // WebRTC signalling — relay between sender and receivers
      case "offer": {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        // Sender sends offer to a specific receiver
        const target = room.receivers.find(
          (r) => r.receiverId === msg.targetId,
        );
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({ type: "offer", sdp: msg.sdp }));
        }
        break;
      }

      case "answer": {
        const room = rooms.get(ws.roomId);
        if (!room || !room.sender) return;
        ws.receiverId = ws.receiverId || msg.receiverId;
        room.sender.send(
          JSON.stringify({
            type: "answer",
            sdp: msg.sdp,
            receiverId: ws.receiverId,
          }),
        );
        break;
      }

      case "ice-candidate": {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        if (ws.role === "sender") {
          const target = room.receivers.find(
            (r) => r.receiverId === msg.targetId,
          );
          if (target && target.readyState === 1) {
            target.send(
              JSON.stringify({
                type: "ice-candidate",
                candidate: msg.candidate,
              }),
            );
          }
        } else {
          if (room.sender && room.sender.readyState === 1) {
            room.sender.send(
              JSON.stringify({
                type: "ice-candidate",
                candidate: msg.candidate,
                receiverId: ws.receiverId,
              }),
            );
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (ws.role === "sender") {
      // Notify all receivers
      broadcast(room.receivers, { type: "sender-disconnected" });
      rooms.delete(ws.roomId);
    } else {
      room.receivers = room.receivers.filter((r) => r !== ws);
      if (room.sender && room.sender.readyState === 1) {
        room.sender.send(
          JSON.stringify({ type: "receiver-left", receiverId: ws.receiverId }),
        );
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🔊 PhoneSpeaker server running at http://localhost:${PORT}`);
  console.log(`   Sender:   http://localhost:${PORT}/sender.html`);
  console.log(`   Receiver: http://localhost:${PORT}/receiver.html\n`);
});
