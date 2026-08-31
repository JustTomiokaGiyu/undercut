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
function renderMap() {
  const svg = el("map-svg");
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  state.map.connections.forEach(([a, b]) => {
    const za = state.map.zones.find((z) => z.id === a);
    const zb = state.map.zones.find((z) => z.id === b);
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", za.x);
    line.setAttribute("y1", za.y);
    line.setAttribute("x2", zb.x);
    line.setAttribute("y2", zb.y);
    line.setAttribute("stroke", "#444a55");
    line.setAttribute("stroke-width", "1.5");
    svg.appendChild(line);
  });

  state.map.zones.forEach((z) => {
    const g = document.createElementNS(ns, "g");
    const owner = state.zoneOwners[z.id];
    const fill = owner ? colorForPlayer(owner) : "#2a2e37";
    const stroke = z.hideout ? "var(--amber)" : "#565c68";

    const shape = document.createElementNS(ns, z.hideout ? "rect" : "circle");
    if (z.hideout) {
      const s = 26;
      shape.setAttribute("x", z.x - s / 2);
      shape.setAttribute("y", z.y - s / 2);
      shape.setAttribute("width", s);
      shape.setAttribute("height", s);
      shape.setAttribute("rx", 5);
      shape.setAttribute("transform", `rotate(45 ${z.x} ${z.y})`);
    } else {
      shape.setAttribute("cx", z.x);
      shape.setAttribute("cy", z.y);
      shape.setAttribute("r", 16);
    }
    shape.setAttribute("fill", fill);
    shape.setAttribute("stroke", stroke);
    shape.setAttribute("stroke-width", z.hideout ? "2" : "1.5");
    g.appendChild(shape);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", z.x);
    label.setAttribute("y", z.y + 34);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#c8cad0");
    label.setAttribute("font-size", "11px");
    label.setAttribute("font-family", "IBM Plex Mono, monospace");
    label.textContent = z.name;
    g.appendChild(label);

    svg.appendChild(g);
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
