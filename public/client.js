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

function renderMap() {
  const svg = el("map-svg");
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  // cork board texture
  const defs = document.createElementNS(ns, "defs");
  const pattern = document.createElementNS(ns, "pattern");
  pattern.setAttribute("id", "cork");
  pattern.setAttribute("width", "22");
  pattern.setAttribute("height", "22");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx", "11");
  dot.setAttribute("cy", "11");
  dot.setAttribute("r", "1");
  dot.setAttribute("fill", "rgba(255,255,255,0.035)");
  pattern.appendChild(dot);
  defs.appendChild(pattern);
  svg.appendChild(defs);
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
  bg.setAttribute("width", "620"); bg.setAttribute("height", "460");
  bg.setAttribute("fill", "url(#cork)");
  svg.appendChild(bg);

  // red string connections, curved with a stable jitter + pinned "tack" ends
  state.map.connections.forEach(([a, b]) => {
    const za = state.map.zones.find((z) => z.id === a);
    const zb = state.map.zones.find((z) => z.id === b);
    const mx = (za.x + zb.x) / 2, my = (za.y + zb.y) / 2;
    const dx = zb.x - za.x, dy = zb.y - za.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const jitter = (seededRand(hashStr(a + "|" + b)) - 0.5) * 22;
    const cx = mx + nx * jitter, cy = my + ny * jitter;

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M ${za.x} ${za.y} Q ${cx} ${cy} ${zb.x} ${zb.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#A33B2E");
    path.setAttribute("stroke-opacity", "0.6");
    path.setAttribute("stroke-width", "1.5");
    svg.appendChild(path);

    [[za.x, za.y], [zb.x, zb.y]].forEach(([tx, ty]) => {
      const tack = document.createElementNS(ns, "circle");
      tack.setAttribute("cx", tx); tack.setAttribute("cy", ty);
      tack.setAttribute("r", "2.2");
      tack.setAttribute("fill", "#7A2A20");
      svg.appendChild(tack);
    });
  });

  // zones as small pinned index cards
  state.map.zones.forEach((z) => {
    const owner = state.zoneOwners[z.id];
    const ownerColor = owner ? colorForPlayer(owner) : "#8a7f66";
    const rotation = (seededRand(hashStr(z.id)) - 0.5) * 9;
    const cardW = z.hideout ? 70 : 60, cardH = z.hideout ? 42 : 36;

    const g = document.createElementNS(ns, "g");
    g.setAttribute("transform", `rotate(${rotation.toFixed(1)} ${z.x} ${z.y})`);

    const card = document.createElementNS(ns, "rect");
    card.setAttribute("x", z.x - cardW / 2);
    card.setAttribute("y", z.y - cardH / 2);
    card.setAttribute("width", cardW);
    card.setAttribute("height", cardH);
    card.setAttribute("rx", "1.5");
    card.setAttribute("fill", "#F4ECD8");
    card.setAttribute("stroke", ownerColor);
    card.setAttribute("stroke-width", owner ? "3" : "1.3");
    g.appendChild(card);

    const pin = document.createElementNS(ns, "circle");
    pin.setAttribute("cx", z.x); pin.setAttribute("cy", z.y - cardH / 2);
    pin.setAttribute("r", "3.6");
    pin.setAttribute("fill", "#C9A227");
    pin.setAttribute("stroke", "#7a5f14");
    pin.setAttribute("stroke-width", "0.6");
    g.appendChild(pin);

    if (z.hideout) {
      const seal = document.createElementNS(ns, "circle");
      seal.setAttribute("cx", z.x + cardW / 2 - 8);
      seal.setAttribute("cy", z.y + cardH / 2 - 8);
      seal.setAttribute("r", "6.5");
      seal.setAttribute("fill", "#A33B2E");
      seal.setAttribute("stroke", "#7A2A20");
      seal.setAttribute("stroke-width", "1");
      g.appendChild(seal);
      const sealRing = document.createElementNS(ns, "circle");
      sealRing.setAttribute("cx", z.x + cardW / 2 - 8);
      sealRing.setAttribute("cy", z.y + cardH / 2 - 8);
      sealRing.setAttribute("r", "3.2");
      sealRing.setAttribute("fill", "none");
      sealRing.setAttribute("stroke", "#F2D77A");
      sealRing.setAttribute("stroke-width", "1");
      g.appendChild(sealRing);
    }

    svg.appendChild(g);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", z.x);
    label.setAttribute("y", z.y + cardH / 2 + 15);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#C9BCA0");
    label.setAttribute("font-size", "10px");
    label.setAttribute("font-family", "'Courier Prime', monospace");
    label.textContent = z.name;
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
