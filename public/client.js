const socket = io();

let myName = "";
let state = null; // last room:state payload
let openChats = new Map(); // withId -> [{from, text, ts}]
let pendingTalkFrom = null;
let selectedActionType = null;

const PLAYER_COLORS = ["--p1", "--p2", "--p3", "--p4", "--p5", "--p6"];

function el(id) { return document.getElementById(id); }
function show(id) { el(id).classList.remove("hidden"); }
function hide(id) { el(id).classList.add("hidden"); }
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  show(id);
}

function colorForPlayer(playerId) {
  if (!state) return "var(--ink-dim)";
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx < 0) return "var(--ink-dim)";
  return `var(${PLAYER_COLORS[idx % PLAYER_COLORS.length]})`;
}

function nameFor(playerId) {
  const p = state && state.players.find((pl) => pl.id === playerId);
  return p ? p.name : "someone";
}

// ---------- AUTH ----------
el("form-auth").addEventListener("submit", (e) => {
  e.preventDefault();
  myName = el("input-name").value.trim();
  if (!myName) return;
  el("home-greeting").textContent = `at the table as ${myName}`;
  showScreen("screen-home");
});

// ---------- HOME ----------
el("input-playerlimit").addEventListener("input", (e) => {
  el("label-playerlimit").textContent = e.target.value;
});
el("input-chattimer").addEventListener("input", (e) => {
  el("label-chattimer").textContent = `${e.target.value}s`;
});

el("btn-create").addEventListener("click", () => {
  socket.emit(
    "room:create",
    {
      name: myName,
      playerLimit: el("input-playerlimit").value,
      chatPhaseSeconds: el("input-chattimer").value,
    },
    (res) => {
      if (!res.ok) return (el("home-error").textContent = res.error || "Couldn't create table.");
      state = res.state;
      enterLobby();
    }
  );
});

el("btn-join").addEventListener("click", () => {
  const code = el("input-joincode").value.trim();
  if (!code) return;
  socket.emit("room:join", { code, name: myName }, (res) => {
    if (!res.ok) return (el("home-error").textContent = res.error || "Couldn't join table.");
    state = res.state;
    enterLobby();
  });
});

// ---------- LOBBY ----------
function enterLobby() {
  showScreen("screen-lobby");
  renderLobby();
}

function renderLobby() {
  el("lobby-code").textContent = state.code;
  const list = el("lobby-players");
  list.innerHTML = "";
  state.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${p.name}${p.id === state.hostId ? " (host)" : ""}</span>`;
    list.appendChild(li);
  });

  if (state.hostId === socket.id) {
    show("btn-start");
    hide("lobby-wait");
  } else {
    hide("btn-start");
    show("lobby-wait");
  }
}

el("btn-start").addEventListener("click", () => {
  socket.emit("room:start", {}, (res) => {
    if (res && !res.ok) alert(res.error);
  });
});

// ---------- GAME STATE ----------
socket.on("room:state", (s) => {
  state = s;
  if (state.phase === "lobby") {
    if (el("screen-lobby").classList.contains("hidden")) enterLobby();
    else renderLobby();
    return;
  }
  showScreen("screen-game");
  renderGame();
});

socket.on("game:over", ({ winnerId }) => {
  el("over-title").textContent =
    winnerId === socket.id ? "You control the city." : `${nameFor(winnerId)} controls the city.`;
  showScreen("screen-over");
});

el("btn-again").addEventListener("click", () => {
  location.reload();
});

function renderGame() {
  el("phase-label").textContent =
    state.phase === "talk" ? "talk phase" : state.phase === "action" ? "action phase" : state.phase;
  el("round-label").textContent = `round ${state.round}`;
  renderTimer();
  renderMap();
  renderLegend();
  renderTalkPanel();
  renderActionPanel();
}

function renderTimer() {
  clearInterval(window.__timerInt);
  if (!state.phaseEndsAt) {
    el("phase-timer").textContent = "--";
    return;
  }
  const tick = () => {
    const left = Math.max(0, Math.round((state.phaseEndsAt - Date.now()) / 1000));
    el("phase-timer").textContent = `${left}s`;
  };
  tick();
  window.__timerInt = setInterval(tick, 1000);
}

// ---------- MAP ----------
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function seededRand(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}
function quadPoint(p0, c, p1, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  };
}

function renderMap() {
  const svg = el("map-svg");
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  const defs = document.createElementNS(ns, "defs");
  const filter = document.createElementNS(ns, "filter");
  filter.setAttribute("id", "terrain-blob");
  filter.setAttribute("x", "-20%"); filter.setAttribute("y", "-20%");
  filter.setAttribute("width", "140%"); filter.setAttribute("height", "140%");
  const blur = document.createElementNS(ns, "feGaussianBlur");
  blur.setAttribute("in", "SourceGraphic");
  blur.setAttribute("stdDeviation", "16");
  blur.setAttribute("result", "blur");
  const matrix = document.createElementNS(ns, "feColorMatrix");
  matrix.setAttribute("in", "blur");
  matrix.setAttribute("mode", "matrix");
  matrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9");
  filter.appendChild(blur);
  filter.appendChild(matrix);
  defs.appendChild(filter);
  svg.appendChild(defs);

  // water
  const water = document.createElementNS(ns, "rect");
  water.setAttribute("x", "0"); water.setAttribute("y", "0");
  water.setAttribute("width", "620"); water.setAttribute("height", "460");
  water.setAttribute("fill", "#0A0E15");
  svg.appendChild(water);

  // terrain island(s), fused from a blob per zone via the gooey filter
  const blobGroup = document.createElementNS(ns, "g");
  blobGroup.setAttribute("filter", "url(#terrain-blob)");
  state.map.zones.forEach((z) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", z.x); c.setAttribute("cy", z.y);
    c.setAttribute("r", "40");
    c.setAttribute("fill", "#4A4530");
    blobGroup.appendChild(c);
  });
  svg.appendChild(blobGroup);
  const shade = document.createElementNS(ns, "g");
  shade.setAttribute("filter", "url(#terrain-blob)");
  shade.setAttribute("opacity", "0.5");
  state.map.zones.forEach((z) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", z.x); c.setAttribute("cy", z.y - 3);
    c.setAttribute("r", "32");
    c.setAttribute("fill", "#615a3d");
    shade.appendChild(c);
  });
  svg.appendChild(shade);

  // roads: gently curved, with small neutral waypoint dots for a woven, dense look
  state.map.connections.forEach(([a, b]) => {
    const za = state.map.zones.find((z) => z.id === a);
    const zb = state.map.zones.find((z) => z.id === b);
    const mx = (za.x + zb.x) / 2, my = (za.y + zb.y) / 2;
    const dx = zb.x - za.x, dy = zb.y - za.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const jitter = (seededRand(hashStr(a + "|" + b)) - 0.5) * Math.min(14, len * 0.18);
    const c = { x: mx + nx * jitter, y: my + ny * jitter };

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M ${za.x} ${za.y} Q ${c.x} ${c.y} ${zb.x} ${zb.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#C7BC9A");
    path.setAttribute("stroke-opacity", "0.55");
    path.setAttribute("stroke-width", "1.4");
    svg.appendChild(path);

    const waypointCount = len > 90 ? 2 : len > 50 ? 1 : 0;
    for (let i = 1; i <= waypointCount; i++) {
      const t = i / (waypointCount + 1);
      const pt = quadPoint({ x: za.x, y: za.y }, c, { x: zb.x, y: zb.y }, t);
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", pt.x.toFixed(1)); dot.setAttribute("cy", pt.y.toFixed(1));
      dot.setAttribute("r", "2.4");
      dot.setAttribute("fill", "#B9AE8C");
      dot.setAttribute("fill-opacity", "0.85");
      svg.appendChild(dot);
    }
  });

  // zones: district dots or hideout house-icons, with a colored ring if owned
  state.map.zones.forEach((z) => {
    const owner = state.zoneOwners[z.id];
    const g = document.createElementNS(ns, "g");

    if (owner) {
      const ring = document.createElementNS(ns, "circle");
      ring.setAttribute("cx", z.x); ring.setAttribute("cy", z.y);
      ring.setAttribute("r", z.hideout ? "13" : "10");
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", colorForPlayer(owner));
      ring.setAttribute("stroke-width", "2.5");
      g.appendChild(ring);
    }

    if (z.hideout) {
      const house = document.createElementNS(ns, "path");
      house.setAttribute("d", `M ${z.x - 6} ${z.y + 5} L ${z.x - 6} ${z.y - 1} L ${z.x} ${z.y - 7} L ${z.x + 6} ${z.y - 1} L ${z.x + 6} ${z.y + 5} Z`);
      house.setAttribute("fill", "#EFE9D6");
      house.setAttribute("stroke", "#2B2A22");
      house.setAttribute("stroke-width", "1");
      g.appendChild(house);
    } else {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", z.x); dot.setAttribute("cy", z.y);
      dot.setAttribute("r", "5");
      dot.setAttribute("fill", "#CFC6A8");
      dot.setAttribute("stroke", "#2B2A22");
      dot.setAttribute("stroke-width", "1");
      g.appendChild(dot);
    }

    svg.appendChild(g);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", z.x);
    label.setAttribute("y", z.y + (z.hideout ? 20 : 18));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#9A9584");
    label.setAttribute("font-size", "9px");
    label.setAttribute("font-family", "'Inter', sans-serif");
    label.setAttribute("letter-spacing", "0.02em");
    label.textContent = z.name.toUpperCase();
    svg.appendChild(label);
  });
}

function renderLegend() {
  const legend = el("legend");
  legend.innerHTML = "";
  state.players.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot" style="background:var(${PLAYER_COLORS[i % PLAYER_COLORS.length]})"></span>${p.name}`;
    legend.appendChild(li);
  });
}

// ---------- TALK PHASE ----------
function renderTalkPanel() {
  const isTalk = state.phase === "talk";
  const list = el("talk-player-list");
  list.innerHTML = "";
  state.players
    .filter((p) => p.id !== socket.id)
    .forEach((p) => {
      const li = document.createElement("li");
      const btn = isTalk ? `<button data-to="${p.id}">Ask to talk</button>` : "";
      li.innerHTML = `<span>${p.name}</span>${btn}`;
      list.appendChild(li);
    });
  list.querySelectorAll("button[data-to]").forEach((btn) => {
    btn.addEventListener("click", () => {
      socket.emit("talk:request", { toId: btn.dataset.to });
      btn.disabled = true;
      btn.textContent = "Request sent";
    });
  });
}

socket.on("talk:incoming", ({ fromId, fromName }) => {
  pendingTalkFrom = fromId;
  el("toast-name").textContent = fromName;
  show("talk-toast");
});

el("toast-accept").addEventListener("click", () => {
  if (!pendingTalkFrom) return;
  socket.emit("talk:respond", { toId: pendingTalkFrom, accept: true });
  hide("talk-toast");
  pendingTalkFrom = null;
});
el("toast-deny").addEventListener("click", () => {
  if (!pendingTalkFrom) return;
  socket.emit("talk:respond", { toId: pendingTalkFrom, accept: false });
  hide("talk-toast");
  pendingTalkFrom = null;
});

socket.on("talk:accepted", ({ withId, withName }) => {
  openChatWindow(withId, withName);
});

socket.on("talk:declined", ({ byId }) => {
  // Quiet no-op in the UI beyond the request button already reading "sent" -
  // avoids telegraphing who declined whom to the rest of the table.
});

function openChatWindow(withId, withName) {
  if (document.getElementById(`chat-${withId}`)) return;
  if (!openChats.has(withId)) openChats.set(withId, []);

  const box = document.createElement("div");
  box.className = "chat-window";
  box.id = `chat-${withId}`;
  box.innerHTML = `
    <div class="chat-head"><span>${withName}</span></div>
    <div class="chat-log" id="chat-log-${withId}"></div>
    <div class="chat-input">
      <input type="text" placeholder="Say something…" maxlength="500" />
      <button>Send</button>
    </div>
  `;
  el("open-chats").appendChild(box);

  const input = box.querySelector("input");
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    socket.emit("chat:send", { toId: withId, text });
    input.value = "";
  };
  box.querySelector("button").addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
}

socket.on("chat:message", ({ withId, from, text }) => {
  if (!openChats.has(withId)) openChats.set(withId, []);
  openChats.get(withId).push({ from, text });
  if (!document.getElementById(`chat-${withId}`)) openChatWindow(withId, nameFor(withId));
  const log = el(`chat-log-${withId}`);
  const bubble = document.createElement("div");
  bubble.className = "bubble " + (from === socket.id ? "me" : "them");
  bubble.textContent = text;
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
});

// ---------- ACTION PHASE ----------
function renderActionPanel() {
  const isAction = state.phase === "action";
  el("panel-action").classList.toggle("hidden", !isAction);
  el("panel-talk").classList.toggle("hidden", isAction);
  if (!isAction) return;

  const me = state.players.find((p) => p.id === socket.id);
  const myZone = state.map.zones.find((z) => z.id === me && me.position) || null;
  const posId = findMyPosition();
  const posZone = state.map.zones.find((z) => z.id === posId);
  el("action-position").textContent = posZone ? posZone.name : "—";
  el("action-status").textContent = "";
  hide2("action-targets");
  selectedActionType = null;
  document.querySelectorAll(".action-type").forEach((b) => b.classList.remove("active"));
}

function hide2(id) {
  el(id).classList.add("hidden");
}

// The client doesn't get its own position from the public state directly
// (only zoneOwners), so infer it: the zone this player currently owns.
function findMyPosition() {
  for (const [zoneId, owner] of Object.entries(state.zoneOwners)) {
    if (owner === socket.id) return zoneId;
  }
  return null;
}

document.querySelectorAll(".action-type").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedActionType = btn.dataset.type;
    document.querySelectorAll(".action-type").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    if (selectedActionType === "hold") {
      hide2("action-targets");
      socket.emit("action:submit", { type: "hold" });
      el("action-status").textContent = "Holding your ground.";
      return;
    }
    renderTargets();
  });
});

function renderTargets() {
  const posId = findMyPosition();
  const container = el("action-targets");
  container.innerHTML = "";
  if (!posId) return;

  const neighborIds = state.map.connections
    .filter(([a, b]) => a === posId || b === posId)
    .map(([a, b]) => (a === posId ? b : a));

  neighborIds.forEach((zoneId) => {
    const zone = state.map.zones.find((z) => z.id === zoneId);
    const btn = document.createElement("button");
    btn.textContent = zone.name;
    btn.addEventListener("click", () => {
      socket.emit("action:submit", { type: selectedActionType, target: zoneId });
      el("action-status").textContent = `${selectedActionType === "push" ? "Pushing into" : "Supporting"} ${zone.name}.`;
    });
    container.appendChild(btn);
  });
  container.classList.remove("hidden");
}

socket.on("action:ack", () => {
  // Server confirmed the order was legal and recorded.
});
