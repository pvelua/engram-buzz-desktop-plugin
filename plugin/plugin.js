// ENGRAM for Buzz Desktop agents: an MCP client over host.request; per-COMMUNITY ENGRAM addresses (an agent's
// calls go to its own community's ENGRAM, so a DEV agent's PAT can never reach PROD); a Settings card and an agent
// tab that map each local agent, per community, to its ENGRAM identity; six agent tools (skill, recall, remember,
// search, get_article, whoami) that act under that agent's own PAT; and a standing "load your skill first"
// instruction for mapped agents.
// The PAT is kept in this plug-in's localStorage (Desktop 1.0.5 has no plug-in secret store) and is
// never logged, returned to an agent, or shown back in the card.
// Only `inject` and `apply` are exported (the host contract); helpers ride on `apply.internals` for tests.
export const inject = ["react", "agents", "host", "settingsCards"];

// Every ENGRAM host must also be in manifest.json's networkOrigins (the host refuses any other). To use another
// ENGRAM, add its origin here AND to networkOrigins, then press Update in Manage plugins (README, "Which ENGRAM").
const ORIGINS = { "https://engram.pvelua.net": "ENGRAM" };
// A community's default ENGRAM, by the community's host. A community not listed has none until its owner picks one.
const DEFAULTS = { "engram-buzz.pvelua.net": "https://engram.pvelua.net" };
const endpoint = (origin) => origin + "/mcp/"; // trailing slash required: /mcp answered 307 (to http://)
const PROTOCOL = "2025-11-25";
const STORE = "pvelua.engram.v2";
const STORE_V1 = "pvelua.engram.mappings.v1"; // { <pubkey>: {pat, project} }, before mappings were per community
const CLIENT = { name: "pvelua.engram", version: "0.2.0" };
const NO_IDENTITY = "This agent has no ENGRAM identity yet. Ask its owner to add it in Settings → ENGRAM.";
const noOrigin = (host) => "This agent's community (" + (host || "unknown") + ") has no ENGRAM address. Ask its owner to set one in Settings → ENGRAM.";

// ---------- storage: { communities: { <host>: {origin} }, agents: { "<host>|<pubkey>": {pat, project, channel} },
//              inbox: { "<host>|<pubkey>": [item_id, …] } (the ENGRAM inbox items already rung),
//              turns: { <session_id>: last turn_seq } } ----------

// "wss://engram-buzz.pvelua.net/", "https://…", or a bare host -> "engram-buzz.pvelua.net".
function hostOf(relay) {
  const t = String(relay ?? "").trim();
  if (!t) return "";
  try { return new URL(/^[a-z]+:\/\//i.test(t) ? t : "https://" + t).hostname.toLowerCase(); } catch { return ""; }
}
const agentKey = (host, pubkey) => host + "|" + pubkey;

function readJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function loadStore(storage) {
  const v = readJson(storage, STORE) ?? {};
  return { communities: v.communities && typeof v.communities === "object" ? v.communities : {},
           agents: v.agents && typeof v.agents === "object" ? v.agents : {},
           inbox: v.inbox && typeof v.inbox === "object" ? v.inbox : {},
           turns: v.turns && typeof v.turns === "object" ? v.turns : {} };
}

function saveStore(storage, store) {
  try {
    storage?.setItem(STORE, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

// v1 mappings were keyed by pubkey alone, and every v1 build could reach only ENGRAM DEV. Move each into the
// community where that agent is found now; drop v1 only when every entry has found its community.
function migrateV1(storage, agents) {
  const v1 = readJson(storage, STORE_V1);
  if (!v1) return false;
  const store = loadStore(storage);
  let left = 0;
  for (const [pubkey, m] of Object.entries(v1)) {
    const found = agents.filter((a) => a.pubkey === pubkey && a.host);
    if (!found.length) { left++; continue; }
    for (const a of found) {
      const k = agentKey(a.host, pubkey);
      if (!store.agents[k] && m?.pat) store.agents[k] = { pat: m.pat, project: m.project ?? "" };
    }
  }
  if (!saveStore(storage, store)) return false;
  if (left === 0) { try { storage?.removeItem(STORE_V1); } catch { /* keep it */ } }
  return true;
}

function originFor(store, host) {
  const chosen = store.communities[host]?.origin;
  if (chosen === "") return null; // the owner chose "none"
  const o = chosen ?? DEFAULTS[host] ?? null;
  return o && ORIGINS[o] ? o : null;
}

// ---------- MCP client ----------

class EngramError extends Error {
  constructor(message, code = null, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ENGRAM refusals arrive as `Error executing tool <tool>: [code] ...`; the code is AFTER the prefix.
function errorCode(text) {
  const m = /^Error executing tool [^:]+:\s*\[([a-z0-9_]+)\]/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

// A response body is JSON, or an SSE stream whose `data:` lines carry the JSON-RPC message.
function parseBody(body, contentType) {
  const text = String(body ?? "");
  const sse = /text\/event-stream/i.test(contentType ?? "") || (!text.trimStart().startsWith("{") && /^(event|data):/m.test(text));
  if (sse) {
    const datas = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (let i = datas.length - 1; i >= 0; i--) {
      try { return JSON.parse(datas[i]); } catch { /* keep looking */ }
    }
    throw new EngramError("ENGRAM error, try again (unreadable event stream)");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EngramError("ENGRAM error, try again (unreadable response)");
  }
}

function header(headers, name) {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return undefined;
}

function createClient(request, pat, origin) {
  let negotiated = null; // the protocol version the server answered with
  let sessionId = null; // ENGRAM is stateless and sends none; echo one only if a server does
  let nextId = 1;

  async function post(message) {
    const headers = {
      Authorization: "Bearer " + pat,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (negotiated) headers["mcp-protocol-version"] = negotiated;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    let r;
    try {
      r = await request({ url: endpoint(origin), method: "POST", headers, body: JSON.stringify(message), timeoutMs: 30000 });
    } catch (e) {
      throw new EngramError("Could not reach ENGRAM (" + String(e?.message ?? e).slice(0, 120) + ")");
    }
    const sid = header(r.headers, "mcp-session-id");
    if (sid) sessionId = sid;
    if (r.status === 401 || r.status === 403) {
      throw new EngramError("ENGRAM refused this agent's PAT (HTTP " + r.status + "). Check or replace it in Settings → ENGRAM.", "unauthorized", r.status);
    }
    if (r.status === 202) return null;
    if (r.status < 200 || r.status >= 300) {
      throw new EngramError("ENGRAM error, try again (HTTP " + r.status + ")", null, r.status);
    }
    return parseBody(r.body, header(r.headers, "content-type"));
  }

  async function initialize() {
    const res = await post({ jsonrpc: "2.0", id: nextId++, method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
    if (res?.error) throw new EngramError("ENGRAM error, try again (" + (res.error.message ?? "initialize failed") + ")");
    negotiated = res?.result?.protocolVersion ?? PROTOCOL;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return negotiated;
  }

  async function callTool(name, args = {}) {
    if (!negotiated) await initialize();
    const res = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
    if (res?.error) throw new EngramError("ENGRAM error, try again (" + (res.error.message ?? "call failed") + ")");
    const result = res?.result ?? {};
    const text = (result.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
    if (result.isError) {
      const code = errorCode(text);
      // A coded refusal is ENGRAM's answer and is passed on; a fault with no code is never parsed.
      // An uncoded fault is not parsed, but its text is passed on (trimmed) so the agent does not guess a cause.
      const detail = text.replace(/^Error executing tool [^:]+:\s*/, "").slice(0, 400);
      throw new EngramError(code ? detail : "ENGRAM error, try again. ENGRAM said: " + detail, code);
    }
    let data = result.structuredContent;
    if (data && typeof data === "object" && "result" in data && Object.keys(data).length === 1) data = data.result;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* leave as text */ } }
    if (data === undefined) { try { data = JSON.parse(text); } catch { data = text; } }
    return data;
  }

  return { initialize, callTool, get protocol() { return negotiated; } };
}

// What the card says about a whoami answer.
function judgeWhoami(w) {
  const problems = [];
  const warnings = [];
  if (!w || typeof w !== "object") problems.push("ENGRAM returned no identity.");
  else {
    if (w.kind !== "agent") problems.push("This PAT belongs to a " + (w.kind ?? "non-agent") + ", not an agent. Issue the agent its own PAT in ENGRAM.");
    const role = w.credential?.pat_role;
    if (role !== "restricted") warnings.push("This PAT's role is '" + (role ?? "unknown") + "', not 'restricted'. It is kept in plug-in storage, so a restricted PAT is strongly recommended.");
  }
  return { ok: problems.length === 0, problems, warnings };
}

// ---------- agents ----------

function snapshot(ctx) {
  try { return ctx.agents.snapshot?.() ?? null; } catch { return null; }
}
const describe = (a) => ({ key: a.key, pubkey: a.pubkey, name: a.name ?? a.pubkey.slice(0, 8), host: hostOf(a.relay) });

// The selected community's agents (what the Settings card lists).
function communityAgents(ctx) {
  const seen = new Map();
  for (const a of snapshot(ctx)?.agents ?? []) if (a?.pubkey && !seen.has(a.pubkey)) seen.set(a.pubkey, describe(a));
  return [...seen.values()];
}

// Every agent this Desktop knows, in every community (for migration and tool calls).
function allAgents(ctx) {
  const snap = snapshot(ctx);
  const out = [];
  for (const a of [...(snap?.running ?? []), ...(snap?.agents ?? [])]) if (a?.pubkey) out.push(describe(a));
  return out;
}

// The calling agent: its pubkey and its community, from the key the host passes to a tool.
function callerFor(ctx, clientKey) {
  const a = allAgents(ctx).find((x) => x.key === clientKey) ?? allAgents(ctx).find((x) => x.pubkey === clientKey);
  return a ?? null;
}

// ---------- skill delivery ----------

// The measured "load it first" wording (Buzz v1.4.2 single-file bootstrap, 5 of 5 on Anthropic and Gemini),
// adapted from load_skill to a tool. Goose's skills list says to load a skill "when it can help"; this says always.
const INSTRUCTION = [
  "You are connected to ENGRAM through the ENGRAM plug-in.",
  "Before you do anything else, call engram_skill and follow what it returns, on every new task, even one that looks simple enough to answer without it. It holds the rules for your role in this project. If it says no skill is assigned, carry on normally.",
  "Memory: ENGRAM memory is durable and yours across sessions; others see it only when you share it or hand it off. Use engram_recall before saying you remember something, and engram_remember for facts, decisions and findings worth keeping. Buzz's own mem_get/mem_set is local to this Desktop.",
  "Knowledge base: engram_search finds articles by title, engram_get_article reads one in full.",
  "Hand-offs: to pass findings to a teammate agent, use engram_hand_off with its ENGRAM user id; it is woken to review them.",
  "When a task is finished and you have posted your result, call engram_turn once with the outcome and your reply's event id.",
  "Inbox: a plugin-wake from the ENGRAM plug-in means an ENGRAM item is waiting on you (a hand-off, an approval, a project change). Act on it with engram_inbox_act using the tools it names. Report what you did in that channel, in one message; if it needs your owner's decision, say so and stop.",
].join("\n");

// Turn a get_assigned_skill result into what the agent reads.
function skillText(r) {
  const status = r?.status;
  if (status === "assigned") {
    const notes = [];
    const unreadable = r.unreadable_parts ?? [];
    const collisions = r.name_collisions ?? [];
    if (unreadable.length) notes.push("WARNING: part of this skill could not be read (" + unreadable.map((u) => u?.name ?? u?.skill_id ?? JSON.stringify(u)).join(", ") + "). You are running under an incomplete skill; say so if it matters to the task.");
    if (collisions.length) notes.push("Note: some included skills share a name (" + collisions.map((c) => c?.name ?? JSON.stringify(c)).join(", ") + ").");
    const name = r.root?.name ?? r.skill?.name ?? r.name ?? null;
    const lines = ["Your assigned ENGRAM skill" + (name ? ": " + name : "") + ". Follow it.", ...notes];
    if (r.precedence) lines.push(r.precedence);
    lines.push("", r.composed_markdown ?? "(the skill came back empty)");
    return lines.join("\n");
  }
  if (status === "no_skill_assigned") {
    if (r.require_assigned_skill === true) return "No ENGRAM skill is assigned to you in this project, and this project requires one. Do not take on tasks here; tell your owner that a skill needs assigning in ENGRAM.";
    return "No ENGRAM skill is assigned to you in this project. Carry on normally.";
  }
  if (status === "skills_disabled") return "Skills are disabled for this project. Carry on normally, and do not mention this in the channel.";
  return "ENGRAM returned an unexpected skill answer (status " + JSON.stringify(status ?? null) + "). Carry on normally.";
}


// ---------- the ENGRAM inbox: doorbells for Desktop agents ----------
// Desktop wakes an agent on a mention only from its owner or an attested sibling, so ENGRAM's relay doorbell never
// reaches it. Instead the plug-in polls ENGRAM's Unified Inbox (`list_pending`) under each agent's own PAT and wakes
// the agent locally (`ctx.agents.wake`, which Desktop admits without the owner check) once per new item.

const POLL_MS = 60000;
const FIRST_POLL_MS = 15000;
const INBOX_CATEGORIES = "approvals,project_changes,memory"; // knowledge_gaps are not part of the Inbox total
const MAX_WAKES_PER_POLL = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wakeText(item) {
  const lines = [
    "ENGRAM inbox: a new item is waiting on you. Call engram_inbox_act to act on it, or engram_inbox to see everything waiting.",
    "item_id: " + item.item_id,
    "kind: " + (item.kind ?? "?"),
    "title: " + (item.title ?? ""),
  ];
  if (item.requested_by_name || item.requested_by) lines.push("from: " + (item.requested_by_name ?? item.requested_by));
  if (item.project_name || item.project_id) lines.push("project: " + (item.project_name ?? item.project_id));
  const tools = item.action?.tools ?? [];
  if (tools.length) lines.push("tools for it: " + tools.join(", "));
  return lines.join("\n");
}


// Where an inbox item wakes the agent, without a setting: the channel ENGRAM has bound to the item's project, else to
// the agent's own project; the owner's per-agent override wins when set. This is the room a hosted agent's doorbell
// would ring in, so rebinding a project's channel in ENGRAM moves the wake-ups with it.
const CHANNELS_TTL_MS = 10 * 60 * 1000;
function boundChannel(answer) {
  const bound = (answer?.channels ?? []).filter((c) => c?.state === "bound" && UUID.test(String(c.channel_id ?? "")));
  bound.sort((a, b) => String(a.bound_at ?? "").localeCompare(String(b.bound_at ?? "")));
  return bound[0] ? { id: bound[0].channel_id, name: bound[0].name ?? null, count: bound.length } : null;
}
function makeChannelResolver(now = () => Date.now()) {
  const cache = new Map(); // origin|pat|project -> { at, channel }
  async function forProject(client, origin, pat, project) {
    if (!project) return null;
    const k = origin + "|" + pat + "|" + project;
    const hit = cache.get(k);
    if (hit && now() - hit.at < CHANNELS_TTL_MS) return hit.channel;
    const channel = boundChannel(await client.callTool("list_project_channels", { project }));
    cache.set(k, { at: now(), channel });
    return channel;
  }
  return async function resolve({ client, origin, mapping, item }) {
    if (mapping.channel) return { id: mapping.channel, via: "override" };
    if (item?.project_id) {
      try { const c = await forProject(client, origin, mapping.pat, item.project_id); if (c) return { ...c, via: "item project" }; } catch { /* fall back */ }
    }
    const c = await forProject(client, origin, mapping.pat, mapping.project);
    return c ? { ...c, via: "agent project" } : null;
  };
}

// One poll over every mapped agent this copy runs. `agents()` gives the running agents (describe() shape),
// `clientFor(origin, pat)` an MCP client, `wake(key, opts)` the host's wake, `log(msg)` a console line.
// The first poll for an agent records what is already waiting and wakes nothing: an existing backlog is not news,
// and the owner has just switched this on. Failures are logged once per change of state, never with a PAT.
function makePoller({ agents, storage, clientFor, wake, log = () => {}, resolveChannel = makeChannelResolver() }) {
  let running = false;
  const states = new Map();
  const note = (k, state) => { if (states.get(k) !== state) { states.set(k, state); log(k.split("|")[0] + " " + k.split("|")[1].slice(0, 8) + ": " + state); } };
  return async function poll() {
    if (running) return { skipped: true };
    running = true;
    const woken = [];
    try {
      for (const a of agents()) {
        const k = agentKey(a.host, a.pubkey);
        const store = loadStore(storage);
        const m = store.agents[k];
        if (!m?.pat) continue;
        const origin = originFor(store, a.host);
        if (!origin) continue;
        let items;
        try {
          const r = await clientFor(origin, m.pat).callTool("list_pending", { category: INBOX_CATEGORIES, limit: 50 });
          items = Array.isArray(r?.items) ? r.items.filter((i) => i?.item_id) : [];
        } catch (e) {
          note(k, "inbox read failed: " + String(e?.message ?? e).slice(0, 160));
          continue;
        }
        const ids = items.map((i) => i.item_id);
        const fresh = loadStore(storage);
        if (!Array.isArray(fresh.inbox[k])) {
          fresh.inbox[k] = ids;
          saveStore(storage, fresh);
          note(k, "inbox watched (" + ids.length + " already waiting)");
          continue;
        }
        const seen = new Set(fresh.inbox[k]);
        let state = "inbox ok";
        let rung = 0;
        for (const item of items) {
          if (seen.has(item.item_id) || rung >= MAX_WAKES_PER_POLL) continue;
          let where;
          try {
            where = await resolveChannel({ client: clientFor(origin, m.pat), origin, mapping: m, item });
          } catch (e) {
            state = "channel lookup failed: " + String(e?.message ?? e).slice(0, 160);
            break;
          }
          if (!where) { state = "inbox wake-ups off: project " + (item.project_id ?? m.project ?? "?") + " has no channel bound"; break; }
          try {
            wake(a.key, { channel: where.id, topLevel: true, text: wakeText(item) });
            seen.add(item.item_id);
            woken.push({ agent: a.key, item_id: item.item_id });
            rung++;
          } catch (e) {
            state = "wake failed: " + String(e?.message ?? e).slice(0, 160);
            break; // the rest wait for the next poll
          }
        }
        // Keep only what is still waiting, so a re-proposed item rings again.
        fresh.inbox[k] = ids.filter((id) => seen.has(id));
        saveStore(storage, fresh);
        note(k, state);
      }
    } finally {
      running = false;
    }
    return { woken };
  };
}

// ---------- turn records: one per task, reported by the agent (v0.2) ----------
// Goose on Desktop has no hooks, so the record comes from a tool the agent calls when a task is done. ENGRAM groups
// episodes by episode_ref, channel_id and delivered; harness is distinct from buzz-acp's so review can tell them
// apart. No usage: Desktop does not give a plug-in the model's token counts.
const HARNESS = "buzz-desktop-plugin";
const HEX64 = /^[0-9a-f]{64}$/;
const OUTCOMES = ["answered", "refused", "degraded", "error"];

function turnRecord({ pubkey, project, context, args, seq, startedAt, now }) {
  const channel = context?.channel ?? null;
  const trigger = HEX64.test(String(args?.trigger_event_id ?? "")) ? args.trigger_event_id : null;
  const reply = HEX64.test(String(args?.reply_event_id ?? "")) ? args.reply_event_id : null;
  const root = HEX64.test(String(context?.root ?? "")) ? context.root : null;
  return {
    harness: HARNESS,
    harness_version: CLIENT.version,
    session_id: "desktop:" + pubkey.slice(0, 16) + ":" + (channel ?? "-") + ":" + (root ?? "top"),
    turn_seq: seq,
    project_id: project,
    started_at: new Date(startedAt ?? now).toISOString(),
    ended_at: new Date(now).toISOString(),
    // A top-level wake has no thread and no trigger message: the agent's reply then starts the episode.
    episode_ref: root ?? trigger ?? reply,
    trigger_event_id: trigger,
    channel_id: channel,
    outcome: OUTCOMES.includes(args?.outcome) ? args.outcome : "answered",
    delivered: { event_id: reply },
  };
}

// The skill a task ran under, in buzz-acp's shape. ENGRAM's v0.2 note §3c: the ROOT part's ids (the part whose role
// is "assigned", the version delivered; `skill` carries the same), fetched_at on the plug-in's clock when the answer
// came back, and a digest that is sha256 of composed_markdown as received. That recipe must never change: ENGRAM
// compares one agent's digests for one version, so a new recipe would read as a conflict.
async function skillRef(r, receivedAt = Date.now()) {
  const root = (r?.parts ?? []).find((p) => p?.role === "assigned") ?? r?.skill ?? null;
  if (!root?.chain_id || !root?.version_id) return null;
  let digest = null;
  try {
    const bytes = new TextEncoder().encode(String(r.composed_markdown ?? ""));
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    digest = "sha256:" + [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { /* no Web Crypto: leave it out */ }
  const names = (r.parts ?? []).map((p) => p?.name).filter(Boolean);
  return { chain_id: root.chain_id, version_id: root.version_id, fetched_at: new Date(receivedAt).toISOString(), digest,
           names: names.length ? names : [root.name ?? r.skill?.name].filter(Boolean) };
}

// A tool result, reduced to what a turn record may carry (ENGRAM's note §3a, item 4): ids, a count, the status and
// any error text, never the contents. The raw blob's readers (project owner and admins) may not be allowed to read
// what the agent's recall or search returned.
const ID_KEYS = ["id", "article_id", "memory_id", "recap_id", "item_id", "skill_id", "version_id"];
function summarizeResult(tool, status, out) {
  const s = { tool, status };
  if (status !== "completed") { s.error = String(out ?? "").slice(0, 500); return s; }
  let data = out;
  if (typeof out === "string") { try { data = JSON.parse(out); } catch { data = null; } }
  const ids = new Set();
  let count = null;
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 4 || ids.size >= 50) return;
    if (Array.isArray(v)) { if (count === null) count = v.length; v.forEach((x) => walk(x, depth + 1)); return; }
    for (const k of ID_KEYS) if (typeof v[k] === "string") ids.add(v[k]);
    for (const x of Object.values(v)) if (x && typeof x === "object") walk(x, depth + 1);
  };
  walk(data, 0);
  if (ids.size) s.ids = [...ids].slice(0, 50);
  if (count !== null) s.count = count;
  return s;
}

// The plug-in's part of a record: what it saw of the task, never the model's reasoning or its other tools. Fields it
// cannot fill are left absent (a marker would be dropped by ENGRAM, and `harness` already says how it was captured).
function rawMaterial(trace, { channelText, triggerText }) {
  const calls = trace?.calls ?? [];
  const tools = [];
  for (const c of calls) {
    let t = tools.find((x) => x.name === c.name);
    if (!t) { t = { extension: "pvelua.engram", name: c.name, calls: 0, errors: 0 }; tools.push(t); }
    t.calls++; if (c.status === "failed") t.errors++;
  }
  const skill = trace?.skill ?? null;
  const out = {
    tool_calls: calls.map((c) => ({ extension: "pvelua.engram", name: c.name, status: c.status })),
    tools,
    raw: { tool_results: (trace?.results ?? []).slice(0, 200) },
  };
  if (channelText) out.raw.channel_text = channelText;
  if (triggerText) out.raw.trigger_text = triggerText;
  if (skill) {
    out.loaded = skill.names;
    out.skill = { chain_id: skill.chain_id, version_id: skill.version_id, fetched_at: skill.fetched_at };
    if (skill.digest) out.skill.digest = skill.digest;
  }
  return out;
}

// ---------- plug-in ----------

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const storage = (() => { try { return globalThis.localStorage; } catch { return null; } })();
  const request = (opts) => ctx.host.request(opts);
  const clients = new Map(); // origin|PAT -> client, so initialize runs once per pair per plug-in start
  try { migrateV1(storage, allAgents(ctx)); } catch { /* retried when the card opens */ }

  function clientFor(origin, pat) {
    const k = origin + "|" + pat;
    if (!clients.has(k)) clients.set(k, createClient(request, pat, origin));
    return clients.get(k);
  }
  function forget(pat) {
    for (const k of [...clients.keys()]) if (k.endsWith("|" + pat)) clients.delete(k);
  }

  const MAX_OUT = 60000;
  const cap = (text) => (text.length > MAX_OUT ? text.slice(0, MAX_OUT) + "\n…[truncated by the ENGRAM plug-in]" : text);
  const json = (v) => cap(typeof v === "string" ? v : JSON.stringify(v, null, 2));

  // The caller's mapping and its community's ENGRAM, or a clear refusal.
  function mapped(client) {
    const who = callerFor(ctx, client?.key);
    const store = loadStore(storage);
    const m = who ? store.agents[agentKey(who.host, who.pubkey)] : null;
    if (!m?.pat) throw new Error(NO_IDENTITY);
    const origin = originFor(store, who.host);
    if (!origin) throw new Error(noOrigin(who.host));
    return { ...m, origin };
  }
  function projectOf(m) {
    if (!m.project) throw new Error("This agent's ENGRAM identity has no project. Ask its owner to set one in Settings → ENGRAM.");
    return m.project;
  }
  async function engram(client, name, args) {
    const m = mapped(client);
    return clientFor(m.origin, m.pat).callTool(name, typeof args === "function" ? args(m) : args);
  }

  const taskStart = new Map(); // "<agent>|<channel>|<root>" -> ms, set when engram_skill opens a task
  const placeKey = (client, context) => String(client?.key) + "|" + (context?.channel ?? "") + "|" + (context?.root ?? "");
  const observationOff = new Set(); // origins answering [observation_disabled], for this run
  // What the plug-in itself saw during a task, per place, for the turn record's raw material: its own tool calls and
  // their results, the skill it delivered, and the wake text that started the task. It sees nothing else of a turn.
  const traces = new Map();
  const traceFor = (k) => { if (!traces.has(k)) traces.set(k, { calls: [], results: [], skill: null, wake: null, at: Date.now() }); return traces.get(k); };
  const pruneTraces = () => { const old = Date.now() - 6 * 3600 * 1000; for (const [k, t] of traces) if (t.at < old) traces.delete(k); };
  function addTool(tool) {
    if (tool.name === "engram_turn") return ctx.agents.addTool(tool);
    return ctx.agents.addTool({ ...tool, async call(client, context, args) {
      const t = traceFor(placeKey(client, context));
      try {
        const out = await tool.call(client, context, args);
        t.calls.push({ name: tool.name, status: "completed" });
        t.results.push(summarizeResult(tool.name, "completed", out));
        return out;
      } catch (e) {
        t.calls.push({ name: tool.name, status: "failed" });
        t.results.push(summarizeResult(tool.name, "failed", e?.message ?? e));
        throw e;
      }
    } });
  }

  addTool({
    name: "engram_whoami",
    description: "Show which ENGRAM identity you act as: your principal, owner, credential role and project. Takes no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async call(client) {
      const m = mapped(client);
      const w = await clientFor(m.origin, m.pat).callTool("whoami", {});
      return json({ engram: m.origin,
        user_id: w?.user_id, name: w?.name, kind: w?.kind, agent_role: w?.agent_role,
        owner_root_user_id: w?.delegation?.owner_root_user_id, pat_role: w?.credential?.pat_role,
        project: m.project || null,
      });
    },
  });

  addTool({
    name: "engram_skill",
    description: "Get your assigned ENGRAM skill for this project: the rules for your role, managed in ENGRAM. Call it before anything else on every new task, and follow what it returns. Takes no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async call(client, context) {
      taskStart.set(placeKey(client, context), Date.now());
      const r = await engram(client, "get_assigned_skill", (m) => ({ project: projectOf(m) }));
      if (r?.status === "assigned") traceFor(placeKey(client, context)).skill = await skillRef(r);
      return skillText(r);
    },
  });

  addTool({
    name: "engram_recall",
    description: "Recall your ENGRAM memories for this project (durable across sessions), plus any shared with you. Use it before claiming you remember something, and when earlier decisions or findings may matter.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "What to recall, in plain words." },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "At most this many memories (default 8)." },
    }, required: ["query"], additionalProperties: false },
    async call(client, _context, args) {
      const r = await engram(client, "recall", (m) => ({ query: String(args?.query ?? ""), active_project_id: projectOf(m), limit: args?.limit ?? 8 }));
      return json(r);
    },
  });

  addTool({
    name: "engram_remember",
    description: "Save a memory to ENGRAM for this project: a fact, decision or finding that should outlast this conversation. It is yours; others see it only if it is shared with them.",
    inputSchema: { type: "object", properties: {
      content: { type: "string", description: "The memory, written so it makes sense on its own later." },
      title: { type: "string", description: "A short title (optional)." },
    }, required: ["content"], additionalProperties: false },
    async call(client, _context, args) {
      const r = await engram(client, "remember", (m) => {
        // An agent's memory defaults to the `context` ring, which needs a context_id; a Desktop agent's
        // memory belongs to its mapped project, so say so (measured: without it ENGRAM answers 400).
        const a = { content: String(args?.content ?? ""), active_project_id: projectOf(m), owner_scope: "project", source_agent: "buzz-desktop" };
        if (args?.title) a.title = String(args.title);
        return a;
      });
      return json(r);
    },
  });

  addTool({
    name: "engram_search",
    description: "Search the ENGRAM knowledge base by article title words. Read a result in full with engram_get_article.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Words from the article's title." },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "At most this many results (default 8)." },
    }, required: ["query"], additionalProperties: false },
    async call(client, _context, args) {
      return json(await engram(client, "search_articles", { query: String(args?.query ?? ""), limit: args?.limit ?? 8 }));
    },
  });

  addTool({
    name: "engram_get_article",
    description: "Read one ENGRAM knowledge-base article in full, by its id (use the full id, all 36 characters).",
    inputSchema: { type: "object", properties: {
      article_id: { type: "string", description: "The article's full id." },
    }, required: ["article_id"], additionalProperties: false },
    async call(client, _context, args) {
      return json(await engram(client, "get_article", { article_id: String(args?.article_id ?? "") }));
    },
  });


  addTool({
    name: "engram_inbox",
    description: "List what is waiting on you in ENGRAM: hand-offs to review, approvals, project changes. Each item names the tools that act on it; use engram_inbox_act. Takes no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async call(client) {
      const r = await engram(client, "list_pending", { category: INBOX_CATEGORIES, limit: 50 });
      const items = (r?.items ?? []).map((i) => ({ item_id: i.item_id, kind: i.kind, title: i.title,
        from: i.requested_by_name ?? i.requested_by, project: i.project_name ?? i.project_id, tools: i.action?.tools ?? [] }));
      return json(items.length ? items : "Nothing is waiting on you in ENGRAM.");
    },
  });

  addTool({
    name: "engram_inbox_act",
    description: "Act on one item from your ENGRAM inbox with one of the tools ENGRAM names for it (for a hand-off: get_recap to read it, then accept_memories or review_recap). The item's own arguments are filled in for you; add others only if the tool needs them.",
    inputSchema: { type: "object", properties: {
      item_id: { type: "string", description: "The item's item_id, from the wake or from engram_inbox." },
      tool: { type: "string", description: "One of the tools the item names." },
      args: { type: "object", description: "Extra arguments for that tool (optional). The item's own arguments always win." },
    }, required: ["item_id", "tool"], additionalProperties: false },
    async call(client, _context, args) {
      const r = await engram(client, "list_pending", { category: INBOX_CATEGORIES, limit: 200 });
      const item = (r?.items ?? []).find((i) => i?.item_id === String(args?.item_id ?? ""));
      if (!item) throw new Error("That item is no longer waiting on you in ENGRAM (someone may have acted on it). Call engram_inbox to see what is.");
      const allowed = item.action?.tools ?? [];
      const tool = String(args?.tool ?? "");
      if (!allowed.includes(tool)) throw new Error("ENGRAM does not offer " + JSON.stringify(tool) + " for this item. Its tools are: " + (allowed.join(", ") || "none (act on it in ENGRAM's UI)") + ".");
      const extra = args?.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
      return json(await engram(client, tool, { ...extra, ...(item.action?.args ?? {}) }));
    },
  });



  addTool({
    name: "engram_hand_off",
    description: "Hand findings to a teammate agent through ENGRAM: they land in that agent's ENGRAM inbox for review, and its plug-in wakes it. When it accepts them they become its memories, and ENGRAM grants them back to you. Use it to pass on work, not to chat.",
    inputSchema: { type: "object", properties: {
      to: { type: "string", description: "The receiving agent's ENGRAM user id (user_…), as your instructions name it." },
      items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "The findings, one per item, each written so it makes sense on its own." },
      title: { type: "string", description: "A short title for the hand-off." },
    }, required: ["to", "items"], additionalProperties: false },
    async call(client, context, args) {
      mapped(client); // an unmapped agent hears that first, whatever it passed
      const to = String(args?.to ?? "").trim();
      if (!/^user_[0-9a-z]+$/i.test(to)) throw new Error("`to` must be the receiving agent's ENGRAM user id (user_…), not its name.");
      const items = (Array.isArray(args?.items) ? args.items : []).map((x) => String(x ?? "").trim()).filter(Boolean);
      if (!items.length) throw new Error("Nothing to hand off: give at least one finding in `items`.");
      const r = await engram(client, "suggest_memories", (m) => {
        const a = { items, context_ref: "desktop:" + (context?.channel ?? "-") + ":" + (context?.root ?? "top"), active_project_id: projectOf(m), hand_off_to: to };
        if (args?.title) a.task_ref = String(args.title);
        return a;
      });
      if (!r?.recap_id) throw new Error("ENGRAM made no hand-off from these items (it found nothing to remember in them). Rewrite them as concrete findings.");
      return json({ handed_off_to: to, recap_id: r.recap_id, memories: (r.memory_ids ?? []).length });
    },
  });

  addTool({
    name: "engram_turn",
    description: "Report a finished task to ENGRAM, once, after you have posted your result: the outcome and the event id of the message that delivered it. ENGRAM uses this to see the task as one episode.",
    inputSchema: { type: "object", properties: {
      outcome: { type: "string", enum: OUTCOMES, description: "answered: you did the task; refused: you declined it; degraded: you did part of it; error: it failed." },
      reply_event_id: { type: "string", description: "The event id (64 hex characters) of your message that delivered the result." },
      trigger_event_id: { type: "string", description: "The event id of the message that asked for the task, if you know it (optional)." },
    }, required: ["outcome"], additionalProperties: false },
    async call(client, context, args) {
      const m = mapped(client);
      const project = projectOf(m);
      if (observationOff.has(m.origin)) return "Not recorded: ENGRAM's observation is off. Carry on.";
      const who = callerFor(ctx, client?.key);
      const store = loadStore(storage);
      const rec0 = turnRecord({ pubkey: who?.pubkey ?? String(client?.key ?? ""), project, context, args, seq: 0, startedAt: taskStart.get(placeKey(client, context)), now: Date.now() });
      const seq = (Number(store.turns?.[rec0.session_id]) || 0) + 1;
      // Read the reply (and the trigger) as the agent; the reply counts only if this agent wrote it.
      const place = placeKey(client, context);
      const trace = traces.get(place) ?? traces.get(String(client?.key) + "|" + (context?.channel ?? "") + "|");
      const readOne = async (id) => {
        if (!id || typeof client?.query !== "function") return null;
        try { return (await client.query([{ kinds: [9], ids: [id], limit: 1 }]))?.[0] ?? null; } catch { return null; }
      };
      const replyEv = await readOne(rec0.delivered.event_id);
      const channelText = replyEv && (!client?.pubkey || replyEv.pubkey === client.pubkey) ? String(replyEv.content ?? "") : "";
      const triggerEv = await readOne(rec0.trigger_event_id);
      const triggerText = triggerEv ? String(triggerEv.content ?? "") : trace?.wake ?? null;
      const rec = { ...rec0, turn_seq: seq, ...rawMaterial(trace, { channelText, triggerText }) };
      store.turns = { ...(store.turns ?? {}), [rec.session_id]: seq };
      saveStore(storage, store);
      let r;
      try {
        r = await request({ url: m.origin + "/api/agent-turns", method: "POST", timeoutMs: 30000,
          headers: { Authorization: "Bearer " + m.pat, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(rec) });
      } catch (e) {
        throw new Error("Could not reach ENGRAM to record the task (" + String(e?.message ?? e).slice(0, 120) + ")");
      }
      const body = String(r.body ?? "");
      if (r.status === 404 && body.includes("[observation_disabled]")) { observationOff.add(m.origin); return "Not recorded: ENGRAM's observation is off. Carry on."; }
      if (r.status === 409 && body.includes("turn_key_conflict")) return "Already recorded.";
      if (r.status === 401 || r.status === 403) throw new Error("ENGRAM refused this agent's PAT (HTTP " + r.status + "). Check or replace it in Settings → ENGRAM.");
      if (r.status < 200 || r.status >= 300) throw new Error("ENGRAM did not record the task (HTTP " + r.status + "). Carry on; do not retry.");
      taskStart.delete(place);
      traces.delete(place);
      pruneTraces();
      let id = null; try { id = JSON.parse(body)?.id ?? JSON.parse(body)?.turn_id ?? null; } catch { /* no id */ }
      return "Recorded" + (id ? " (" + id + ")" : "") + (rec.delivered.event_id ? "." : ". Next time pass reply_event_id: it links the episode to your reply.");
    },
  });

  ctx.agents.addInstructions({
    id: "engram",
    when: (agent) => {
      const host = hostOf(agent?.relay);
      const store = loadStore(storage);
      return Boolean(agent?.pubkey && store.agents[agentKey(host, agent.pubkey)]?.pat && originFor(store, host));
    },
    text: INSTRUCTION,
  });


  // The inbox poll: owned by ctx.effect so it stops on disable, replacement and teardown.
  const poll = makePoller({
    agents: () => (snapshot(ctx)?.running ?? []).filter((a) => a?.pubkey).map(describe),
    storage, clientFor,
    wake: (key, opts) => { ctx.agents.wake(key, opts); const t = traceFor(key + "|" + opts.channel + "|"); t.wake = opts.text; t.at = Date.now(); },
    log: (msg) => { try { console.info("[ENGRAM plug-in] " + msg); } catch { /* no console */ } },
  });
  if (typeof ctx.effect === "function" && typeof ctx.agents.wake === "function") {
    ctx.effect(() => {
      const first = setTimeout(() => { poll().catch(() => {}); }, FIRST_POLL_MS);
      const every = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
      return () => { clearTimeout(first); clearInterval(every); };
    });
  }

  const FIELD = { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 220px", minWidth: 0 };
  const LABEL = { fontSize: "0.85em", opacity: 0.75 };
  const INPUT = { width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: "6px",
    border: "1px solid var(--color-border, var(--border-color, #c8c8c8))", background: "var(--color-surface, transparent)", color: "inherit", font: "inherit" };

  function AgentRow({ agent, mapping, origin, onChange }) {
    const k = agentKey(agent.host, agent.pubkey);
    const [pat, setPat] = React.useState("");
    const [project, setProject] = React.useState(mapping?.project ?? "");
    const [channel, setChannel] = React.useState(mapping?.channel ?? "");
    const [status, setStatus] = React.useState(null);
    const [busy, setBusy] = React.useState(false);

    function save() {
      const store = loadStore(storage);
      const ch = channel.trim();
      if (ch && !UUID.test(ch)) { setStatus({ problems: ["The override is a channel id (a UUID, from the channel's details), not its name. Leave it blank to use the project's bound channel."], warnings: [] }); return; }
      const next = { ...(store.agents[k] ?? {}), project: project.trim(), channel: ch };
      if (ch !== (store.agents[k]?.channel ?? "")) delete store.inbox[k]; // a new channel starts watching afresh
      if (pat.trim()) next.pat = pat.trim();
      if (!next.pat) { setStatus({ problems: ["Paste the agent's ENGRAM PAT first."], warnings: [] }); return; }
      store.agents[k] = next;
      if (!saveStore(storage, store)) { setStatus({ problems: ["Could not save: this Desktop's storage is unavailable."], warnings: [] }); return; }
      if (mapping?.pat) forget(mapping.pat);
      setPat("");
      onChange();
      setStatus({ info: "Saved.", problems: [], warnings: [] });
    }

    function remove() {
      const store = loadStore(storage);
      if (store.agents[k]?.pat) forget(store.agents[k].pat);
      delete store.agents[k];
      delete store.inbox[k];
      saveStore(storage, store);
      onChange();
      setStatus({ info: "Removed. Revoke the PAT in ENGRAM if it is no longer needed.", problems: [], warnings: [] });
    }

    async function test() {
      const m = loadStore(storage).agents[k];
      if (!m?.pat) { setStatus({ problems: ["Save a PAT first."], warnings: [] }); return; }
      if (!origin) { setStatus({ problems: [noOrigin(agent.host)], warnings: [] }); return; }
      setBusy(true);
      try {
        const c = createClient(request, m.pat, origin);
        const w = await c.callTool("whoami", {});
        const judged = judgeWhoami(w);
        // Where inbox items will wake this agent: the override, else the project's bound channel.
        let wakeInfo = null;
        try {
          const where = await makeChannelResolver()({ client: c, origin, mapping: m, item: null });
          if (where?.via === "override") wakeInfo = "Inbox wake-ups: in the override channel " + where.id + ".";
          else if (where) wakeInfo = "Inbox wake-ups: in " + (where.name ?? where.id) + ", the channel bound to " + m.project + (where.count > 1 ? " (the first of " + where.count + " bound; set an override to choose)" : "") + ".";
          else judged.warnings.push("Inbox wake-ups are off: " + (m.project ? "no channel is bound to " + m.project + " in ENGRAM. Bind one there, or set an override." : "this agent has no project."));
        } catch (e) {
          judged.warnings.push("Could not read the project's channels: " + String(e?.message ?? e).slice(0, 160));
        }
        setStatus({ ...judged, who: w, info: wakeInfo });
      } catch (e) {
        setStatus({ problems: [String(e?.message ?? e)], warnings: [] });
      } finally {
        setBusy(false);
      }
    }

    const who = status?.who;
    return h("section", { className: "ui-card", style: { padding: "var(--space-panel-inset)", marginBottom: "var(--space-2)" } },
      h("h3", null, agent.name),
      h("p", { style: { opacity: 0.7, wordBreak: "break-all" } }, agent.pubkey.slice(0, 16) + "… · " + (mapping?.pat ? "ENGRAM identity saved" : "no ENGRAM identity") + " · " + (origin ? ORIGINS[origin] + " (" + origin.replace("https://", "") + ")" : "no ENGRAM for this community")),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end" } },
        h("label", { style: FIELD },
          h("span", { style: LABEL }, "ENGRAM PAT"),
          h("input", { type: "password", autoComplete: "off", placeholder: mapping?.pat ? "saved — paste a new one to replace" : "paste the agent's restricted PAT",
            value: pat, onChange: (e) => setPat(e.target.value), style: INPUT })),
        h("label", { style: FIELD },
          h("span", { style: LABEL }, "ENGRAM project"),
          h("input", { type: "text", placeholder: "project:…", value: project, onChange: (e) => setProject(e.target.value), style: INPUT })),
        h("label", { style: FIELD },
          h("span", { style: LABEL }, "Inbox wake-ups channel (override)"),
          h("input", { type: "text", placeholder: "blank = the project's bound channel", value: channel, onChange: (e) => setChannel(e.target.value), style: INPUT }))),
      // Buttons on their own row under the fields, so they never wrap between them in a narrow panel.
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-2)" } },
        h("button", { type: "button", onClick: save }, "Save"),
        h("button", { type: "button", onClick: test, disabled: busy || !mapping?.pat }, busy ? "Testing…" : "Test"),
        mapping ? h("button", { type: "button", onClick: remove }, "Remove") : null),
      status?.info ? h("p", null, status.info) : null,
      who ? h("p", null, "ENGRAM: " + who.name + " (" + who.user_id + ") · kind " + who.kind + " · owner " + (who.delegation?.owner_root_user_id ?? "?") + " · PAT role " + (who.credential?.pat_role ?? "?")) : null,
      ...(status?.problems ?? []).map((t, i) => h("p", { key: "p" + i, style: { color: "var(--color-danger, #c0392b)" } }, "✖ " + t)),
      ...(status?.warnings ?? []).map((t, i) => h("p", { key: "w" + i, style: { color: "var(--color-warning, #b9770e)" } }, "⚠ " + t)),
      status?.ok ? h("p", null, "✔ Agent identity confirmed.") : null);
  }

  // Which ENGRAM this community's agents use. Defaults from the community's host; the owner may change it.
  function CommunityRow({ host, origin, chosen, onChange }) {
    const [value, setValue] = React.useState(chosen === undefined ? (origin ?? "") : chosen);
    const [info, setInfo] = React.useState(null);
    function save() {
      const store = loadStore(storage);
      if (value === (DEFAULTS[host] ?? "")) delete store.communities[host];
      else store.communities[host] = { origin: value };
      setInfo(saveStore(storage, store) ? "Saved. This community's agents now use " + (value ? ORIGINS[value] : "no ENGRAM") + "." : "Could not save: this Desktop's storage is unavailable.");
      onChange();
    }
    return h("section", { className: "ui-card", style: { padding: "var(--space-panel-inset)", marginBottom: "var(--space-2)" } },
      h("h3", null, "ENGRAM for this community"),
      h("p", { style: { opacity: 0.7, wordBreak: "break-all" } }, host + (DEFAULTS[host] ? " · default " + ORIGINS[DEFAULTS[host]] : " · no default")),
      h("label", { style: FIELD },
        h("span", { style: LABEL }, "Every agent in this community calls"),
        h("select", { value, onChange: (e) => setValue(e.target.value), style: INPUT },
          ...Object.entries(ORIGINS).map(([o, name]) => h("option", { key: o, value: o }, name + " — " + o.replace("https://", ""))),
          h("option", { key: "none", value: "" }, "No ENGRAM for this community"))),
      h("div", { style: { display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" } },
        h("button", { type: "button", onClick: save }, "Save")),
      info ? h("p", null, info) : null);
  }

  // The same row on each Desktop agent's own page (Agents → agent → ENGRAM), for agents running here.
  if (typeof ctx.agents.registerTab === "function") {
    ctx.agents.registerTab({
      id: "engram",
      title: "ENGRAM",
      when: (agent) => agent?.place === undefined || agent?.place === "here",
      component: function EngramTab({ agent }) {
        const [, bump] = React.useState(0);
        if (!agent?.pubkey) return h("p", null, "This agent has no key on this device.");
        const a = describe(agent);
        const store = loadStore(storage);
        return h("div", null,
          h("p", null, "This agent's ENGRAM identity: its own restricted PAT and its project. Which ENGRAM it uses is set for its community, in Settings → ENGRAM, which also lists every Desktop agent."),
          h(AgentRow, { agent: a, mapping: store.agents[agentKey(a.host, a.pubkey)], origin: originFor(store, a.host), onChange: () => bump((n) => n + 1) }));
      },
    });
  }

  ctx.settingsCards.register({
    id: "engram",
    title: "ENGRAM",
    component: function EngramSettings({ community }) {
      const [, bump] = React.useState(0);
      const refresh = () => bump((n) => n + 1);
      React.useEffect(() => { const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);
      const agents = communityAgents(ctx);
      React.useEffect(() => { try { migrateV1(storage, allAgents(ctx)); } catch { /* next time */ } }, []);
      const store = loadStore(storage);
      // The selected community: from its agents' relay, else from the community's name when it is a host.
      const host = agents[0]?.host || hostOf(community?.name) || "";
      const origin = host ? originFor(store, host) : null;
      return h("div", null,
        host ? h(CommunityRow, { key: host, host, origin, chosen: store.communities[host]?.origin, onChange: refresh }) : null,
        h("p", null, "Give each Desktop agent its own ENGRAM identity: create the agent in ENGRAM (a sub-agent you own), issue it a restricted PAT, and paste it here with the agent's project. Agents you create in Desktop in this community are listed below; an agent left blank gets no ENGRAM tools."),
        h("p", { style: { color: "var(--color-warning, #b9770e)" } },
          "⚠ The PAT is stored in this plug-in's local storage on this computer, not in the Keychain (Desktop has no plug-in secret store yet). Use a restricted PAT. To revoke or rotate it, use ENGRAM, where it was issued."),
        agents.length === 0 ? h("p", null, "No agents in this community yet.") : null,
        ...agents.map((a) => h(AgentRow, { key: agentKey(a.host, a.pubkey), agent: a, mapping: store.agents[agentKey(a.host, a.pubkey)], origin: originFor(store, a.host), onChange: refresh })));
    },
  });
}

apply.internals = { boundChannel, makeChannelResolver, summarizeResult, rawMaterial, skillRef, turnRecord, HARNESS, makePoller, wakeText, INBOX_CATEGORIES, UUID, POLL_MS, skillText, INSTRUCTION, loadStore, saveStore, migrateV1, originFor, hostOf, agentKey, errorCode, parseBody, createClient, judgeWhoami, callerFor, NO_IDENTITY, noOrigin, ORIGINS, DEFAULTS, STORE, STORE_V1 };
