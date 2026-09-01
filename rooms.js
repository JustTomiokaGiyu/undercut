const { customAlphabet } = require("nanoid");
const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 5);

const MAX_PLAYERS = 25;
const MIN_PLAYERS = 2;

// phase: "lobby" | "talk" | "action" | "resolution" | "ended"
class Room {
  constructor(code, hostId, options, map) {
    this.code = code;
    this.hostId = hostId;
    this.playerLimit = options.playerLimit;
    this.chatPhaseSeconds = options.chatPhaseSeconds;
    this.map = map;

    this.players = new Map(); // socketId -> { id, name, connected }
    this.phase = "lobby";
    this.round = 0;

    this.zoneOwners = {}; // zoneId -> playerId (null = unclaimed)
    for (const z of map.zones) this.zoneOwners[z.id] = null;

    this.talkRequests = new Map(); // `${from}:${to}` -> pending
    this.chats = new Map(); // pairKey -> [{ from, text, ts }]
    this.pendingActions = new Map(); // playerId -> action

    this.phaseTimer = null;
    this.phaseEndsAt = null;
  }

  get playerCount() {
    return this.players.size;
  }

  isFull() {
    return this.playerCount >= this.playerLimit;
  }

  addPlayer(socketId, name) {
    this.players.set(socketId, { id: socketId, name, connected: true });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      playerLimit: this.playerLimit,
      chatPhaseSeconds: this.chatPhaseSeconds,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name })),
      map: {
        id: this.map.id,
        name: this.map.name,
        hideoutsToWin: this.map.hideoutsToWin,
        zones: this.map.zones,
        connections: this.map.connections,
      },
      zoneOwners: this.zoneOwners,
      phaseEndsAt: this.phaseEndsAt,
    };
  }

  pairKey(a, b) {
    return [a, b].sort().join("|");
  }
}

class RoomManager {
  constructor(maps) {
    this.rooms = new Map(); // code -> Room
    this.maps = maps; // { small: mapJson, ... } pick by player count for now: single map
  }

  pickMapFor(playerLimit) {
    if (playerLimit <= this.maps.ironport.maxPlayers) return this.maps.ironport;
    if (playerLimit <= this.maps.midtown.maxPlayers) return this.maps.midtown;
    return this.maps.metropolis;
  }

  createRoom(hostSocketId, hostName, options) {
    const playerLimit = Math.min(
      MAX_PLAYERS,
      Math.max(MIN_PLAYERS, parseInt(options.playerLimit, 10) || 4)
    );
    const chatPhaseSeconds = Math.min(
      600,
      Math.max(15, parseInt(options.chatPhaseSeconds, 10) || 60)
    );

    let code;
    do {
      code = makeCode();
    } while (this.rooms.has(code));

    const map = this.pickMapFor(playerLimit);
    const room = new Room(code, hostSocketId, { playerLimit, chatPhaseSeconds }, map);
    room.addPlayer(hostSocketId, hostName);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || "").toUpperCase());
  }

  removeRoomIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.playerCount === 0) {
      if (room.phaseTimer) clearTimeout(room.phaseTimer);
      this.rooms.delete(code);
    }
  }
}

module.exports = { RoomManager, MAX_PLAYERS, MIN_PLAYERS };
