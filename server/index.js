const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { RoomManager } = require("./rooms");

const ironport = require("./maps/ironport.json");
const midtown = require("./maps/midtown.json");
const metropolis = require("./maps/metropolis.json");
const maps = { ironport, midtown, metropolis };

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager(maps);

app.use(express.static(path.join(__dirname, "..", "public")));

// ---- helpers ----------------------------------------------------------

function broadcastRoom(room) {
  io.to(room.code).emit("room:state", room.publicState());
}

function clearPhaseTimer(room) {
  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }
  room.phaseEndsAt = null;
}

function startTalkPhase(room) {
  room.phase = "talk";
  room.round += 1;
  room.pendingActions.clear();
  clearPhaseTimer(room);
  room.phaseEndsAt = Date.now() + room.chatPhaseSeconds * 1000;
  room.phaseTimer = setTimeout(() => startActionPhase(room), room.chatPhaseSeconds * 1000);
  broadcastRoom(room);
}

function startActionPhase(room) {
  room.phase = "action";
  clearPhaseTimer(room);
  broadcastRoom(room);
  // Auto-resolve after a fixed 45s window if not everyone has submitted.
  room.phaseTimer = setTimeout(() => resolveRound(room), 45 * 1000);
  room.phaseEndsAt = Date.now() + 45 * 1000;
}

function neighborsOf(room, zoneId) {
  return room.map.connections
    .filter(([a, b]) => a === zoneId || b === zoneId)
    .map(([a, b]) => (a === zoneId ? b : a));
}

// Simplified resolution, documented in README as a first-pass ruleset.
function resolveRound(room) {
  clearPhaseTimer(room);
  room.phase = "resolution";

  const pushesByTarget = new Map(); // zoneId -> [playerId]
  const supportsByTarget = new Map(); // zoneId -> count

  for (const [playerId, action] of room.pendingActions.entries()) {
    if (action.type === "push") {
      if (!pushesByTarget.has(action.target)) pushesByTarget.set(action.target, []);
      pushesByTarget.get(action.target).push(playerId);
    } else if (action.type === "support") {
      supportsByTarget.set(action.target, (supportsByTarget.get(action.target) || 0) + 1);
    }
  }

  for (const [zoneId, attackers] of pushesByTarget.entries()) {
    const defenderId = room.zoneOwners[zoneId];
    let attackStrength = attackers.length;
    let defenseStrength = defenderId ? 1 : 0;

    if (attackers.length === 1) {
      attackStrength += supportsByTarget.get(zoneId) || 0;
    }
    // Multi-way contests ignore supports for now (ambiguous without
    // per-attacker support targeting) - highest raw push count wins ties go
    // to the defender.

    if (attackStrength > defenseStrength) {
      const winner = attackers.length === 1 ? attackers[0] : attackers.sort()[0];
      if (defenderId) room.zoneOwners[zoneId] = null;
      room.zoneOwners[zoneId] = winner;
      room.players.get(winner).position = zoneId;
    }
  }

  // Holds with no incoming push simply reinforce - no state change needed
  // beyond having survived; supports on non-pushed zones already counted
  // as defense above via the defenderId check.

  broadcastRoom(room);

  const counts = {};
  for (const z of room.map.zones) {
    if (!z.hideout) continue;
    const owner = room.zoneOwners[z.id];
    if (owner) counts[owner] = (counts[owner] || 0) + 1;
  }
  const winner = Object.entries(counts).find(([, c]) => c >= room.map.hideoutsToWin);

  if (winner) {
    room.phase = "ended";
    io.to(room.code).emit("game:over", { winnerId: winner[0] });
    broadcastRoom(room);
    return;
  }

  setTimeout(() => startTalkPhase(room), 4000);
}

// ---- sockets ------------------------------------------------------------

io.on("connection", (socket) => {
  let joinedCode = null;

  socket.on("room:create", ({ name, playerLimit, chatPhaseSeconds }, cb) => {
    const cleanName = String(name || "").trim().slice(0, 24) || "Player";
    const room = rooms.createRoom(socket.id, cleanName, { playerLimit, chatPhaseSeconds });
    joinedCode = room.code;
    socket.join(room.code);
    cb({ ok: true, state: room.publicState() });
    broadcastRoom(room);
  });

  socket.on("room:join", ({ code, name }, cb) => {
    const room = rooms.getRoom(code);
    if (!room) return cb({ ok: false, error: "No room with that code." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "That game has already started." });
    if (room.isFull()) return cb({ ok: false, error: "Room is full." });

    const cleanName = String(name || "").trim().slice(0, 24) || "Player";
    room.addPlayer(socket.id, cleanName);
    joinedCode = room.code;
    socket.join(room.code);
    cb({ ok: true, state: room.publicState() });
    broadcastRoom(room);
  });

  socket.on("room:start", (_, cb) => {
    const room = rooms.getRoom(joinedCode);
    if (!room) return cb && cb({ ok: false, error: "Not in a room." });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: "Only the host can start." });
    if (room.phase !== "lobby") return cb && cb({ ok: false, error: "Already started." });
    if (room.playerCount < 2) return cb && cb({ ok: false, error: "Need at least 2 players." });

    const nonHideout = room.map.zones.filter((z) => !z.hideout);
    const ids = [...room.players.keys()];
    ids.forEach((id, i) => {
      const zone = nonHideout[i % nonHideout.length];
      room.players.get(id).position = zone.id;
      room.zoneOwners[zone.id] = id;
    });

    startTalkPhase(room);
    cb && cb({ ok: true });
  });

  // --- talk requests ---
  socket.on("talk:request", ({ toId }) => {
    const room = rooms.getRoom(joinedCode);
    if (!room || room.phase !== "talk") return;
    if (!room.players.has(toId)) return;
    io.to(toId).emit("talk:incoming", { fromId: socket.id, fromName: room.players.get(socket.id).name });
  });

  socket.on("talk:respond", ({ toId, accept }) => {
    const room = rooms.getRoom(joinedCode);
    if (!room) return;
    if (accept) {
      const key = room.pairKey(socket.id, toId);
      if (!room.chats.has(key)) room.chats.set(key, []);
      io.to(toId).emit("talk:accepted", { withId: socket.id, withName: room.players.get(socket.id).name });
      socket.emit("talk:accepted", { withId: toId, withName: room.players.get(toId).name });
    } else {
      io.to(toId).emit("talk:declined", { byId: socket.id });
    }
  });

  socket.on("chat:send", ({ toId, text }) => {
    const room = rooms.getRoom(joinedCode);
    if (!room || room.phase !== "talk") return;
    const clean = String(text || "").trim().slice(0, 500);
    if (!clean) return;
    const key = room.pairKey(socket.id, toId);
    if (!room.chats.has(key)) room.chats.set(key, []);
    const msg = { from: socket.id, text: clean, ts: Date.now() };
    room.chats.get(key).push(msg);
    io.to(toId).emit("chat:message", { withId: socket.id, ...msg });
    socket.emit("chat:message", { withId: toId, ...msg });
  });

  // --- actions ---
  socket.on("action:submit", ({ type, target }) => {
    const room = rooms.getRoom(joinedCode);
    if (!room || room.phase !== "action") return;
    const player = room.players.get(socket.id);
    if (!player) return;

    if (type === "hold") {
      room.pendingActions.set(socket.id, { type: "hold" });
    } else if ((type === "push" || type === "support") && target) {
      const legal = neighborsOf(room, player.position);
      if (!legal.includes(target)) return;
      room.pendingActions.set(socket.id, { type, target });
    } else {
      return;
    }

    socket.emit("action:ack", { type, target });

    if (room.pendingActions.size === room.playerCount) {
      resolveRound(room);
    }
  });

  socket.on("disconnect", () => {
    const room = rooms.getRoom(joinedCode);
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.playerCount === 0) {
      rooms.removeRoomIfEmpty(room.code);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = [...room.players.keys()][0];
    }
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Speak-clone server listening on :${PORT}`));
