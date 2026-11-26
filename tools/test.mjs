// Unit tests for plugin/plugin.js against a fake host and a fake ENGRAM MCP server.
//   node tools/test.mjs                 -- offline tests
//   ENGRAM_TEST_PAT=... node tools/test.mjs --live   -- also whoami against ENGRAM (ENGRAM_TEST_ORIGIN to change; PAT from env only)
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const mod = await import(pathToFileURL(path.join(here, "../plugin/plugin.js")).href);
const I = mod.apply.internals;
const MANIFEST = JSON.parse((await import("node:fs")).readFileSync(path.join(here, "../plugin/manifest.json"), "utf8"));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + (e?.stack ?? e)); process.exitCode = 1; }
}

// ---- a fake MCP server, recording every request ----
function fakeServer({ sse = false, sessionId = null, tools = {}, status = 200 } = {}) {
  const log = [];
  async function request(req) {
    log.push(req);
    if (status !== 200) return { status, headers: {}, body: "{\"detail\":\"nope\"}" };
    const msg = JSON.parse(req.body);
    const headers = { "content-type": sse ? "text/event-stream" : "application/json" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (msg.method === "notifications/initialized") return { status: 202, headers: {}, body: "" };
    let result;
    if (msg.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake" } };
    else if (msg.method === "tools/call") {
      const t = tools[msg.params.name];
      result = t ? t(msg.params.arguments) : { content: [{ type: "text", text: "Error executing tool " + msg.params.name + ": [tool_not_found] no" }], isError: true };
    }
    const json = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    return { status: 200, headers, body: sse ? "event: message\ndata: " + json + "\n\n" : json };
  }
  return { request, log };
}
const WHO = { user_id: "user_900", kind: "agent", name: "P0 Tester (agent)", credential: { pat_role: "restricted" }, delegation: { owner_root_user_id: "user_900" } };
const ok = (data) => () => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data }, isError: false });

await test("handshake: initialize, initialized, then tools/call; slash endpoint; PAT only in Authorization", async () => {
  const s = fakeServer({ tools: { whoami: ok(WHO) } });
  const c = I.createClient(s.request, "SECRET-PAT", "https://engram.pvelua.net");
  const w = await c.callTool("whoami");
  assert.equal(w.user_id, "user_900");
  assert.deepEqual(s.log.map((r) => JSON.parse(r.body).method), ["initialize", "notifications/initialized", "tools/call"]);
  for (const r of s.log) {
    assert.equal(r.url, "https://engram.pvelua.net/mcp/");
    assert.equal(r.headers.Authorization, "Bearer SECRET-PAT");
    assert.ok(!r.body.includes("SECRET-PAT"), "PAT must not be in a body");
  }
  assert.equal(JSON.parse(s.log[0].body).params.protocolVersion, "2025-11-25");
  assert.equal(s.log[2].headers["mcp-protocol-version"], "2025-11-25");
  assert.equal(s.log[2].headers["mcp-session-id"], undefined, "no session id is invented");
});

await test("initialize runs once per client", async () => {
  const s = fakeServer({ tools: { whoami: ok(WHO) } });
  const c = I.createClient(s.request, "p", "https://engram.pvelua.net");
  await c.callTool("whoami"); await c.callTool("whoami");
  assert.equal(s.log.filter((r) => JSON.parse(r.body).method === "initialize").length, 1);
});

await test("a session id is echoed only when a server sends one", async () => {
  const s = fakeServer({ sessionId: "abc", tools: { whoami: ok(WHO) } });
  await I.createClient(s.request, "p", "https://engram.pvelua.net").callTool("whoami");
  assert.equal(s.log[2].headers["mcp-session-id"], "abc");
});

await test("SSE responses are parsed", async () => {
  const s = fakeServer({ sse: true, tools: { whoami: ok(WHO) } });
  assert.equal((await I.createClient(s.request, "p", "https://engram.pvelua.net").callTool("whoami")).kind, "agent");
});

await test("a coded refusal: the [code] after the prefix is surfaced", async () => {
  const s = fakeServer({ tools: { get_assigned_skill: () => ({ content: [{ type: "text", text: "Error executing tool get_assigned_skill: [not_an_agent] humans have no skills" }], isError: true }) } });
  await assert.rejects(I.createClient(s.request, "p", "https://engram.pvelua.net").callTool("get_assigned_skill"), (e) => e.code === "not_an_agent" && e.message.startsWith("[not_an_agent]"));
});

await test("an uncoded fault is shown as 'ENGRAM error, try again', never parsed", async () => {
  const s = fakeServer({ tools: { get_article: () => ({ content: [{ type: "text", text: "Error executing tool get_article: 404 Not Found: {'detail': 'x'}" }], isError: true }) } });
  await assert.rejects(I.createClient(s.request, "p", "https://engram.pvelua.net").callTool("get_article"), (e) => e.code === null && e.message.startsWith("ENGRAM error, try again. ENGRAM said: 404 Not Found"));
});

await test("401 says the PAT was refused", async () => {
  const s = fakeServer({ status: 401 });
  await assert.rejects(I.createClient(s.request, "p", "https://engram.pvelua.net").callTool("whoami"), (e) => e.code === "unauthorized" && /Settings → ENGRAM/.test(e.message));
});

await test("a 404 or 500 is a generic ENGRAM error", async () => {
  for (const status of [404, 500, 307]) {
    const s = fakeServer({ status });
    await assert.rejects(I.createClient(s.request, "p", "https://engram.pvelua.net").callTool("whoami"), (e) => e.status === status && /ENGRAM error, try again/.test(e.message));
  }
});

await test("errorCode only reads a code right after the prefix", () => {
  assert.equal(I.errorCode("Error executing tool x: [project_not_found] y"), "project_not_found");
  assert.equal(I.errorCode("[project_not_found] y"), null);
  assert.equal(I.errorCode("Error executing tool x: boom [late_code]"), null);
});

await test("judgeWhoami: agent + restricted is clean; a human is refused; owner role warns", () => {
  assert.deepEqual(I.judgeWhoami(WHO), { ok: true, problems: [], warnings: [] });
  const human = I.judgeWhoami({ ...WHO, kind: "human" });
  assert.equal(human.ok, false);
  const owner = I.judgeWhoami({ ...WHO, credential: { pat_role: "owner" } });
  assert.equal(owner.ok, true); assert.equal(owner.warnings.length, 1);
});

await test("storage: corrupt reads as empty; a throwing store does not crash", () => {
  const empty = { communities: {}, agents: {}, inbox: {}, turns: {} };
  assert.deepEqual(I.loadStore({ getItem: () => "{not json" }), empty);
  assert.deepEqual(I.loadStore({ getItem: () => { throw new Error("blocked"); } }), empty);
  assert.equal(I.saveStore({ setItem: () => { throw new Error("full"); } }, empty), false);
});

await test("hostOf reads wss, https and bare relay addresses", () => {
  assert.equal(I.hostOf("wss://engram-buzz.pvelua.net/"), "engram-buzz.pvelua.net");
  assert.equal(I.hostOf("https://Engram-Buzz.pvelua.net"), "engram-buzz.pvelua.net");
  assert.equal(I.hostOf("engram-buzz.pvelua.net"), "engram-buzz.pvelua.net");
  assert.equal(I.hostOf(""), "");
});

await test("originFor: defaults by community, an owner's choice wins, 'none' means none, undeclared is refused", () => {
  const st = (communities = {}) => ({ communities, agents: {} });
  assert.equal(I.originFor(st(), "engram-buzz.pvelua.net"), "https://engram.pvelua.net");
  assert.equal(I.originFor(st(), "engram-buzz.pvelua.net"), "https://engram.pvelua.net");
  assert.equal(I.originFor(st(), "customer.example"), null);
  assert.equal(I.originFor(st({ "customer.example": { origin: "https://engram.pvelua.net" } }), "customer.example"), "https://engram.pvelua.net");
  assert.equal(I.originFor(st({ "engram-buzz.pvelua.net": { origin: "" } }), "engram-buzz.pvelua.net"), null);
  assert.equal(I.originFor(st({ "x": { origin: "https://evil.example" } }), "x"), null);
  for (const o of Object.keys(I.ORIGINS)) assert.ok(MANIFEST.host.networkOrigins.includes(o), o + " must be declared in the manifest");
});

await test("v1 mappings migrate into the agent's community, and v1 is dropped once all have moved", () => {
  const mem = new Map([[I.STORE_V1, JSON.stringify({ ["aa".repeat(32)]: { pat: "OLD", project: "project:x" } })]]);
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  I.migrateV1(st, [{ pubkey: "aa".repeat(32), host: "engram-buzz.pvelua.net" }]);
  assert.deepEqual(I.loadStore(st).agents[I.agentKey("engram-buzz.pvelua.net", "aa".repeat(32))], { pat: "OLD", project: "project:x" });
  assert.equal(mem.has(I.STORE_V1), false);
});

// ---- apply() against a fake host ----
function fakeHost(server, agents) {
  const reg = { tools: [], instr: [], cards: [] };
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const ctx = {
    react: { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {} },
    agents: { addTool: (t) => reg.tools.push(t), addInstructions: (i) => reg.instr.push(i), registerTab: (t) => (reg.tabs = [...(reg.tabs ?? []), t]), snapshot: () => ({ agents, running: agents }) },
    host: { request: server.request },
    settingsCards: { register: (c) => reg.cards.push(c) },
  };
  mod.apply(ctx);
  return { reg, mem };
}
function mapAgent(host, pubkey, m, communities = {}) {
  const st = I.loadStore(globalThis.localStorage);
  st.agents[I.agentKey(host, pubkey)] = m;
  Object.assign(st.communities, communities);
  I.saveStore(globalThis.localStorage, st);
}

await test("apply registers ten tools, one per-agent instruction, one Settings card", () => {
  const { reg } = fakeHost(fakeServer(), []);
  assert.deepEqual(reg.tools.map((t) => t.name), ["engram_whoami", "engram_skill", "engram_recall", "engram_remember", "engram_search", "engram_get_article", "engram_inbox", "engram_inbox_act", "engram_hand_off", "engram_turn"]);
  for (const t of reg.tools) { assert.match(t.name, /^[a-z][a-z0-9_]{0,63}$/); assert.equal(t.inputSchema.type, "object"); }
  assert.equal(reg.cards[0].id, "engram");
  assert.equal(reg.tabs?.[0]?.id, "engram", "an ENGRAM tab on each agent's page");
  assert.equal(reg.tabs[0].when({ place: "here" }), true);
  assert.equal(reg.tabs[0].when({ place: "hosted" }), false, "hosted agents run elsewhere and have no local PAT");
  assert.ok(Buffer.byteLength(reg.instr[0].text) <= 4096);
});

await test("an unmapped agent gets the clear message, and no instruction", async () => {
  const { reg } = fakeHost(fakeServer(), [{ key: "k1", pubkey: "aa".repeat(32), name: "A", relay: "wss://engram-buzz.pvelua.net" }]);
  for (const t of reg.tools) await assert.rejects(t.call({ key: "k1" }, {}, { query: "x", content: "x", article_id: "x" }), (e) => e.message === I.NO_IDENTITY, t.name);
  assert.equal(reg.instr[0].when({ pubkey: "aa".repeat(32), relay: "wss://engram-buzz.pvelua.net" }), false);
});

await test("a mapped agent calls whoami under its own PAT, which never reaches the tool output", async () => {
  const s = fakeServer({ tools: { whoami: ok(WHO) } });
  const pk = "bb".repeat(32);
  const { reg } = fakeHost(s, [{ key: "k2", pubkey: pk, name: "B", relay: "wss://engram-buzz.pvelua.net" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "AGENT-PAT", project: "project:0000000000000001" });
  const out = await reg.tools.find((t) => t.name === "engram_whoami").call({ key: "k2" }, {}, {});
  assert.ok(!out.includes("AGENT-PAT"));
  assert.equal(JSON.parse(out).project, "project:0000000000000001");
  assert.equal(s.log.at(-1).headers.Authorization, "Bearer AGENT-PAT");
  assert.equal(reg.instr[0].when({ pubkey: pk, relay: "wss://engram-buzz.pvelua.net" }), true);
  assert.equal(reg.instr[0].when({ pubkey: pk, relay: "wss://other.example" }), false, "the same agent in another community is a different mapping");
});

await test("skillText: assigned returns the composed body and passes on unreadable parts", () => {
  const t = I.skillText({ status: "assigned", root: { name: "desktop-tester" }, precedence: "P", composed_markdown: "# Body", unreadable_parts: [{ name: "missing-part" }], name_collisions: [] });
  assert.match(t, /desktop-tester/); assert.match(t, /# Body/); assert.match(t, /incomplete skill/); assert.match(t, /missing-part/);
});

await test("skillText: no_skill_assigned and skills_disabled mean carry on; disabled says do not announce", () => {
  assert.match(I.skillText({ status: "no_skill_assigned", require_assigned_skill: false }), /Carry on normally/);
  assert.match(I.skillText({ status: "no_skill_assigned", require_assigned_skill: true }), /Do not take on tasks/);
  const d = I.skillText({ status: "skills_disabled" });
  assert.match(d, /Carry on normally/); assert.match(d, /do not mention this in the channel/);
});

await test("the instruction fits the 4096-byte limit and says call engram_skill first", () => {
  assert.ok(Buffer.byteLength(I.INSTRUCTION) <= 4096);
  assert.match(I.INSTRUCTION, /Before you do anything else, call engram_skill/);
});

await test("mapped tools send the agent's project; skill is called WITHOUT format", async () => {
  const seen = {};
  const rec = (name, data) => (args) => { seen[name] = args; return ok(data)(); };
  const s = fakeServer({ tools: {
    get_assigned_skill: rec("get_assigned_skill", { status: "assigned", root: { name: "desktop-tester" }, composed_markdown: "# Rules" }),
    recall: rec("recall", []), remember: rec("remember", { memory_id: "m1" }),
    search_articles: rec("search_articles", []), get_article: rec("get_article", { article_id: "a" }) } });
  const pk = "cc".repeat(32);
  const { reg } = fakeHost(s, [{ key: "k3", pubkey: pk, name: "C", relay: "wss://engram-buzz.pvelua.net" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "P", project: "project:0000000000000001" });
  const t = (n) => reg.tools.find((x) => x.name === n);
  assert.match(await t("engram_skill").call({ key: "k3" }, {}, {}), /# Rules/);
  assert.deepEqual(seen.get_assigned_skill, { project: "project:0000000000000001" });
  await t("engram_recall").call({ key: "k3" }, {}, { query: "q" });
  assert.equal(seen.recall.active_project_id, "project:0000000000000001"); assert.equal(seen.recall.limit, 8);
  await t("engram_remember").call({ key: "k3" }, {}, { content: "c", title: "T" });
  assert.equal(seen.remember.active_project_id, "project:0000000000000001"); assert.equal(seen.remember.title, "T");
  assert.equal(seen.remember.owner_scope, "project", "without it ENGRAM refuses an agent's memory (context ring needs a context_id)");
  await t("engram_search").call({ key: "k3" }, {}, { query: "q" });
  assert.equal(seen.search_articles.query, "q");
  await t("engram_get_article").call({ key: "k3" }, {}, { article_id: "a" });
  assert.equal(seen.get_article.article_id, "a");
});

await test("a mapping with no project refuses project tools clearly", async () => {
  const pk = "dd".repeat(32);
  const { reg } = fakeHost(fakeServer(), [{ key: "k4", pubkey: pk, name: "D", relay: "wss://engram-buzz.pvelua.net" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "P", project: "" });
  await assert.rejects(reg.tools.find((x) => x.name === "engram_recall").call({ key: "k4" }, {}, { query: "q" }), /has no project/);
});

await test("a call goes to the caller's community's ENGRAM, and a PAT never crosses communities", async () => {
  const s = fakeServer({ tools: { whoami: ok(WHO) } });
  const pk = "ee".repeat(32);
  const { reg } = fakeHost(s, [
    { key: "prod-k", pubkey: pk, name: "E", relay: "wss://engram-buzz.pvelua.net" },
    { key: "other-k", pubkey: pk, name: "E", relay: "wss://other.example" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "PROD-PAT", project: "project:p" });
  mapAgent("other.example", pk, { pat: "OTHER-PAT", project: "project:o" });
  const who = reg.tools.find((t) => t.name === "engram_whoami");
  await who.call({ key: "prod-k" }, {}, {});
  assert.equal(s.log.at(-1).url, "https://engram.pvelua.net/mcp/"); assert.equal(s.log.at(-1).headers.Authorization, "Bearer PROD-PAT");
  const n = s.log.length;
  await assert.rejects(who.call({ key: "other-k" }, {}, {}), (e) => /no ENGRAM address/.test(e.message) && !e.message.includes("OTHER-PAT"));
  assert.equal(s.log.length, n, "a community with no ENGRAM sends nothing, so its PAT goes nowhere");
});

await test("a community with no ENGRAM refuses clearly, even for a mapped agent", async () => {
  const pk = "ff".repeat(32);
  const { reg } = fakeHost(fakeServer(), [{ key: "kx", pubkey: pk, name: "F", relay: "wss://customer.example" }]);
  mapAgent("customer.example", pk, { pat: "P", project: "project:c" });
  await assert.rejects(reg.tools.find((t) => t.name === "engram_whoami").call({ key: "kx" }, {}, {}), /customer\.example\) has no ENGRAM address/);
  assert.equal(reg.instr[0].when({ pubkey: pk, relay: "wss://customer.example" }), false);
});


// ---- the inbox poll (v0.2 doorbells) ----
const HAND_OFF = { item_id: "recap.waiting:recap:user_901:36c13d1ac7fe20c3", kind: "recap.waiting", category: "memory",
  title: "plugin v0.2 spike: list_pending control", requested_by: "user_902", requested_by_name: "Buzz Lead (agent)",
  project_id: null, action: { tools: ["get_recap", "list_recap_suggestions", "review_recap", "accept_memories"], args: { recap_id: "recap:user_901:36c13d1ac7fe20c3" } } };
const CH = "7dfc1946-10d3-4497-8080-94db7575fc70";
function inboxRig(itemsRef, { wakeThrows = null } = {}) {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const calls = []; const wakes = []; const logs = [];
  const s = fakeServer({ tools: {
    list_pending: (a) => { calls.push(a); return ok({ items: itemsRef.items, next_offset: null })(); },
    list_project_channels: (a) => ok({ channels: (itemsRef.bound ?? {})[a.project] ?? [] })(),
  } });
  const clientFor = (origin, pat) => I.createClient(s.request, pat, origin);
  const pk = "cc".repeat(32);
  const agents = () => [{ key: "kc", pubkey: pk, name: "C", host: "engram-buzz.pvelua.net" }];
  const set = (m) => { const st = I.loadStore(storage); st.agents[I.agentKey("engram-buzz.pvelua.net", pk)] = m; I.saveStore(storage, st); };
  const poll = I.makePoller({ agents, storage, clientFor, log: (m) => logs.push(m),
    wake: (key, opts) => { if (wakeThrows) throw new Error(wakeThrows); wakes.push({ key, ...opts }); } });
  return { poll, set, storage, calls, wakes, logs, s, k: I.agentKey("engram-buzz.pvelua.net", pk) };
}

await test("inbox: the first poll watches and wakes nothing; a new item wakes once", async () => {
  const ref = { items: [HAND_OFF] };
  const r = inboxRig(ref);
  r.set({ pat: "AGENT-PAT", project: "project:x", channel: CH });
  await r.poll();
  assert.equal(r.wakes.length, 0, "what is already waiting when watching starts is not news");
  assert.deepEqual(r.calls[0], { category: I.INBOX_CATEGORIES, limit: 50 });
  assert.match(r.logs.at(-1), /inbox watched \(1 already waiting\)/);
  const NEW = { ...HAND_OFF, item_id: "recap.waiting:recap:user_901:new", title: "second hand-off" };
  ref.items = [HAND_OFF, NEW];
  await r.poll();
  assert.equal(r.wakes.length, 1);
  assert.deepEqual({ key: r.wakes[0].key, channel: r.wakes[0].channel, topLevel: r.wakes[0].topLevel }, { key: "kc", channel: CH, topLevel: true });
  assert.match(r.wakes[0].text, /item_id: recap\.waiting:recap:user_901:new/);
  assert.match(r.wakes[0].text, /tools for it: get_recap, list_recap_suggestions, review_recap, accept_memories/);
  await r.poll();
  assert.equal(r.wakes.length, 1, "an item rings once");
  for (const req of r.s.log) assert.ok(!req.body.includes("AGENT-PAT"));
  assert.ok(!r.logs.join("\n").includes("AGENT-PAT"));
});

await test("inbox: an item that leaves is forgotten, so it rings again if re-proposed; at most three wakes per poll", async () => {
  const ref = { items: [] };
  const r = inboxRig(ref);
  r.set({ pat: "P", project: "project:x", channel: CH });
  await r.poll();
  ref.items = [1, 2, 3, 4, 5].map((n) => ({ ...HAND_OFF, item_id: "i" + n }));
  await r.poll();
  assert.equal(r.wakes.length, 3);
  await r.poll();
  assert.equal(r.wakes.length, 5, "the rest ring on the next poll");
  ref.items = [];
  await r.poll();
  assert.deepEqual(I.loadStore(r.storage).inbox[r.k], []);
  ref.items = [{ ...HAND_OFF, item_id: "i1" }];
  await r.poll();
  assert.equal(r.wakes.length, 6);
});

await test("inbox: a failed wake is retried next poll and logged once; a failed read is logged once", async () => {
  const ref = { items: [] };
  const r = inboxRig(ref, { wakeThrows: "mention lane full" });
  r.set({ pat: "P", project: "project:x", channel: CH });
  await r.poll();
  ref.items = [HAND_OFF];
  await r.poll(); await r.poll();
  assert.deepEqual(I.loadStore(r.storage).inbox[r.k], [], "not marked as rung");
  assert.equal(r.logs.filter((l) => /wake failed: mention lane full/.test(l)).length, 1);
  const bad = inboxRig({ items: [] });
  bad.set({ pat: "P", project: "project:x", channel: CH });
  bad.s.request = async () => ({ status: 401, headers: {}, body: "" });
  const poll2 = I.makePoller({ agents: () => [{ key: "kc", pubkey: "cc".repeat(32), host: "engram-buzz.pvelua.net" }], storage: bad.storage,
    clientFor: (o, p) => I.createClient(async () => ({ status: 401, headers: {}, body: "" }), p, o), wake: () => {}, log: (m) => bad.logs.push(m) });
  await poll2(); await poll2();
  assert.equal(bad.logs.filter((l) => /inbox read failed/.test(l)).length, 1);
});

await test("engram_inbox_act runs only a tool the item names, with the item's own args winning", async () => {
  const seen = [];
  const s = fakeServer({ tools: {
    list_pending: ok({ items: [HAND_OFF] }),
    get_recap: (a) => { seen.push(a); return ok({ id: a.recap_id })(); },
  } });
  const pk = "dd".repeat(32);
  const { reg } = fakeHost(s, [{ key: "kd", pubkey: pk, name: "D", relay: "wss://engram-buzz.pvelua.net" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "P", project: "project:x" });
  const act = reg.tools.find((t) => t.name === "engram_inbox_act");
  await act.call({ key: "kd" }, {}, { item_id: HAND_OFF.item_id, tool: "get_recap", args: { recap_id: "recap:someone:else", extra: 1 } });
  assert.deepEqual(seen[0], { recap_id: "recap:user_901:36c13d1ac7fe20c3", extra: 1 });
  await assert.rejects(act.call({ key: "kd" }, {}, { item_id: HAND_OFF.item_id, tool: "forget" }), /does not offer "forget"/);
  await assert.rejects(act.call({ key: "kd" }, {}, { item_id: "gone", tool: "get_recap" }), /no longer waiting/);
  const list = JSON.parse(await reg.tools.find((t) => t.name === "engram_inbox").call({ key: "kd" }, {}, {}));
  assert.equal(list[0].item_id, HAND_OFF.item_id);
});


await test("turnRecord: harness, required fields, episode_ref falls back root -> trigger -> reply", () => {
  const base = { pubkey: "ee".repeat(32), project: "project:x", seq: 3, startedAt: 1795540090000, now: 1795540201000 };
  const R = "1".repeat(64), T = "2".repeat(64), D = "3".repeat(64);
  const a = I.turnRecord({ ...base, context: { channel: CH, root: R }, args: { outcome: "answered", trigger_event_id: T, reply_event_id: D } });
  assert.equal(a.harness, "buzz-desktop-plugin");
  for (const f of ["harness", "session_id", "turn_seq", "project_id", "started_at", "outcome"]) assert.ok(a[f] !== undefined && a[f] !== null, f);
  assert.deepEqual([a.episode_ref, a.trigger_event_id, a.channel_id, a.delivered.event_id, a.turn_seq], [R, T, CH, D, 3]);
  assert.equal(a.started_at, new Date(1795540090000).toISOString());
  assert.equal("usage" in a, false, "no usage is sent");
  const b = I.turnRecord({ ...base, context: { channel: CH }, args: { outcome: "answered", trigger_event_id: T, reply_event_id: D } });
  assert.equal(b.episode_ref, T);
  const c = I.turnRecord({ ...base, context: { channel: CH }, args: { outcome: "answered", reply_event_id: D } });
  assert.equal(c.episode_ref, D, "a top-level wake: the reply starts the episode");
  const d = I.turnRecord({ ...base, context: {}, args: { outcome: "bogus", reply_event_id: "not-hex" } });
  assert.deepEqual([d.outcome, d.delivered.event_id, d.episode_ref], ["answered", null, null]);
});

await test("engram_turn posts to /api/agent-turns under the agent's PAT; observation off stops; a conflict is terminal", async () => {
  const posts = []; let reply = { status: 201, body: "{\"id\":\"turn_1\"}" };
  const request = async (req) => {
    if (req.url.endsWith("/api/agent-turns")) { posts.push(req); return { status: reply.status, headers: {}, body: reply.body }; }
    return { status: 500, headers: {}, body: "" };
  };
  const pk = "ff".repeat(32);
  const { reg } = fakeHost({ request }, [{ key: "kf", pubkey: pk, name: "F", relay: "wss://engram-buzz.pvelua.net" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "TURN-PAT", project: "project:x" });
  const turn = reg.tools.find((t) => t.name === "engram_turn");
  const out = await turn.call({ key: "kf" }, { channel: CH }, { outcome: "answered", reply_event_id: "4".repeat(64) });
  assert.match(out, /^Recorded \(turn_1\)\.$/);
  assert.equal(posts[0].url, "https://engram.pvelua.net/api/agent-turns");
  assert.equal(posts[0].headers.Authorization, "Bearer TURN-PAT");
  const body = JSON.parse(posts[0].body);
  assert.equal(body.turn_seq, 1); assert.equal(body.delivered.event_id, "4".repeat(64)); assert.ok(!posts[0].body.includes("TURN-PAT"));
  await turn.call({ key: "kf" }, { channel: CH }, { outcome: "answered" });
  assert.equal(JSON.parse(posts[1].body).turn_seq, 2, "turn_seq increases per session");
  reply = { status: 409, body: "Error: [turn_key_conflict] x" };
  assert.equal(await turn.call({ key: "kf" }, { channel: CH }, { outcome: "answered" }), "Already recorded.");
  reply = { status: 404, body: "[observation_disabled]" };
  assert.match(await turn.call({ key: "kf" }, { channel: CH }, { outcome: "answered" }), /observation is off/);
  const n = posts.length;
  assert.match(await turn.call({ key: "kf" }, { channel: CH }, { outcome: "answered" }), /observation is off/);
  assert.equal(posts.length, n, "no further sends once observation is off");
});


await test("engram_turn carries raw material: the reply (only the agent's own), the trigger, its own tool calls and the skill", async () => {
  const posts = [];
  const pk = "ab".repeat(32), other = "cd".repeat(32);
  const R = "5".repeat(64), T = "6".repeat(64);
  const SK = { status: "assigned", skill: { chain_id: "chain-1", version_id: "ver-2", name: "desktop-tester" }, composed_markdown: "# Body",
    parts: [{ name: "working-together", role: "inherited", chain_id: "c0", version_id: "v0" }, { name: "desktop-tester", role: "assigned", chain_id: "chain-1", version_id: "ver-2" }] };
  const mcp = fakeServer({ tools: { get_assigned_skill: ok(SK), recall: ok({ memories: [{ id: "memory:remember:user_903:aa", content: "SECRET MEMORY TEXT" }, { id: "memory:remember:user_903:bb", content: "x" }] }) } });
  const request = async (req) => (req.url.endsWith("/api/agent-turns") ? (posts.push(req), { status: 201, headers: {}, body: "{\"id\":\"t\"}" }) : mcp.request(req));
  const { reg } = fakeHost({ request }, [{ key: "kr", pubkey: pk, name: "R", relay: "wss://engram-buzz.pvelua.net" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "P", project: "project:x" });
  const events = { [R]: { id: R, pubkey: pk, kind: 9, content: "Done: the answer." }, [T]: { id: T, pubkey: other, kind: 9, content: "Please do the task." } };
  const client = { key: "kr", pubkey: pk, query: async (f) => (f[0].ids ?? []).map((id) => events[id]).filter(Boolean) };
  const where = { channel: CH, root: T };
  const tool = (n) => reg.tools.find((x) => x.name === n);
  await tool("engram_skill").call(client, where, {});
  await tool("engram_recall").call(client, where, { query: "q" });
  await assert.rejects(tool("engram_get_article").call(client, where, { article_id: "nope" }));
  await tool("engram_turn").call(client, where, { outcome: "answered", reply_event_id: R, trigger_event_id: T });
  const b = JSON.parse(posts[0].body);
  assert.equal(b.raw.channel_text, "Done: the answer.");
  assert.equal(b.raw.trigger_text, "Please do the task.");
  assert.deepEqual(b.tool_calls.map((c) => [c.name, c.status]), [["engram_skill", "completed"], ["engram_recall", "completed"], ["engram_get_article", "failed"]]);
  assert.deepEqual(b.tools.find((x) => x.name === "engram_get_article"), { extension: "pvelua.engram", name: "engram_get_article", calls: 1, errors: 1 });
  assert.equal(b.raw.tool_results.length, 3);
  assert.ok(!posts[0].body.includes("SECRET MEMORY TEXT"), "tool results carry ids and counts, never contents");
  assert.deepEqual(b.raw.tool_results[1], { tool: "engram_recall", status: "completed", ids: ["memory:remember:user_903:aa", "memory:remember:user_903:bb"], count: 2 });
  assert.equal(b.raw.tool_results[2].status, "failed"); assert.ok(b.raw.tool_results[2].error);
  assert.deepEqual(b.loaded, ["working-together", "desktop-tester"]);
  assert.equal(b.skill.chain_id, "chain-1"); assert.equal(b.skill.version_id, "ver-2"); assert.match(b.skill.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(b.tool_calls.some((c) => c.name === "engram_turn"), false, "the report itself is not a traced call");
  // A reply written by someone else is not this agent's channel text; the trace was cleared by the first record.
  events[R] = { ...events[R], pubkey: other };
  await tool("engram_turn").call(client, where, { outcome: "answered", reply_event_id: R });
  const b2 = JSON.parse(posts[1].body);
  assert.equal("channel_text" in b2.raw, false, "absent, not empty");
  assert.deepEqual(b2.tool_calls, []);
});

await test("rawMaterial: a wake's text stands in for a trigger; unfillable fields are absent", () => {
  const r = I.rawMaterial({ calls: [{ name: "engram_inbox_act", status: "completed" }], results: [{ tool: "engram_inbox_act", status: "completed", ids: ["x"] }], skill: null }, { channelText: "ok", triggerText: "ENGRAM inbox: …" });
  assert.equal(r.raw.trigger_text, "ENGRAM inbox: …");
  for (const k of ["skill", "loaded", "usage", "model", "reasoning"]) assert.equal(k in r || k in r.raw, false, k);
});

await test("skillRef: the root part's ids, the plug-in's clock, a fixed digest recipe", async () => {
  const r = { status: "assigned", composed_markdown: "abc", skill: { chain_id: "S", version_id: "SV" },
    parts: [{ name: "a", role: "inherited", chain_id: "x", version_id: "y" }, { name: "root", role: "assigned", chain_id: "C", version_id: "V" }] };
  const ref = await I.skillRef(r, Date.parse("2026-11-24T17:30:00Z"));
  assert.deepEqual([ref.chain_id, ref.version_id, ref.fetched_at], ["C", "V", "2026-11-24T17:30:00.000Z"]);
  assert.equal(ref.digest, "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256('abc')");
  assert.deepEqual(ref.names, ["a", "root"]);
});


await test("inbox channel: override, else the item's project's bound channel, else the agent's; none means no wake", async () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", OLD = "cccccccc-0000-4000-8000-000000000003";
  const bound = (id, at, state = "bound") => ({ channel_id: id, name: "#" + id.slice(0, 4), state, bound_at: at });
  const ref = { items: [], bound: {} };
  const r = inboxRig(ref);
  r.set({ pat: "P", project: "project:mine" });
  await r.poll();
  ref.items = [{ ...HAND_OFF, item_id: "n1", project_id: null }];
  await r.poll();
  assert.equal(r.wakes.length, 0);
  assert.match(r.logs.at(-1), /inbox wake-ups off: project project:mine has no channel bound/);
  ref.bound = { "project:mine": [bound(B, "2026-11-02"), bound(OLD, "2026-10-01", "unbound")], "project:theirs": [bound(A, "2026-11-01")] };
  const r2 = inboxRig(ref);
  r2.set({ pat: "P", project: "project:mine" });
  ref.items = [];
  await r2.poll();
  ref.items = [{ ...HAND_OFF, item_id: "n1", project_id: null }, { ...HAND_OFF, item_id: "n2", project_id: "project:theirs" }];
  await r2.poll();
  assert.deepEqual(r2.wakes.map((w) => w.channel), [B, A], "agent project for an item with none; the item's own project when it has one");
  r2.set({ pat: "P", project: "project:mine", channel: CH });
  ref.items = [...ref.items, { ...HAND_OFF, item_id: "n3", project_id: "project:theirs" }];
  await r2.poll();
  assert.equal(r2.wakes.at(-1).channel, CH, "the owner's override wins");
});

await test("boundChannel: only bound channels with a channel id, earliest bound first", () => {
  assert.equal(I.boundChannel({ channels: [] }), null);
  const c = I.boundChannel({ channels: [{ channel_id: "bbbbbbbb-0000-4000-8000-000000000002", state: "bound", bound_at: "2026-11-02" }, { channel_id: "aaaaaaaa-0000-4000-8000-000000000001", state: "bound", bound_at: "2026-11-01", name: "#a" }, { channel_id: "x", state: "bound" }] });
  assert.deepEqual(c, { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "#a", count: 2 });
});


await test("engram_hand_off: suggest_memories to a user id, scoped to the project, keyed by the conversation", async () => {
  const seen = [];
  const s = fakeServer({ tools: { suggest_memories: (a) => { seen.push(a); return ok({ recap_id: "recap:user_904:x", memory_ids: ["m1", "m2"] })(); } } });
  const pk = "a1".repeat(32);
  const { reg } = fakeHost(s, [{ key: "kh", pubkey: pk, name: "H", relay: "wss://engram-buzz.pvelua.net" }]);
  mapAgent("engram-buzz.pvelua.net", pk, { pat: "P", project: "project:0000000000000002" });
  const ho = reg.tools.find((t) => t.name === "engram_hand_off");
  const out = JSON.parse(await ho.call({ key: "kh" }, { channel: CH, root: "1".repeat(64) }, { to: "user_904", items: [" Finding one ", ""], title: "Scout to Writer" }));
  assert.deepEqual(out, { handed_off_to: "user_904", recap_id: "recap:user_904:x", memories: 2 });
  assert.deepEqual(seen[0], { items: ["Finding one"], context_ref: "desktop:" + CH + ":" + "1".repeat(64), active_project_id: "project:0000000000000002", hand_off_to: "user_904", task_ref: "Scout to Writer" });
  await assert.rejects(ho.call({ key: "kh" }, {}, { to: "Writer", items: ["x"] }), /ENGRAM user id/);
  await assert.rejects(ho.call({ key: "kh" }, {}, { to: "user_904", items: ["  "] }), /Nothing to hand off/);
});

if (process.argv.includes("--live")) {
  await test("LIVE: whoami against $ENGRAM_TEST_ORIGIN (default ENGRAM) with $ENGRAM_TEST_PAT", async () => {
    const pat = process.env.ENGRAM_TEST_PAT;
    assert.ok(pat, "set ENGRAM_TEST_PAT in the environment");
    const request = async ({ url, method, headers, body }) => {
      const r = await fetch(url, { method, headers, body, redirect: "manual" });
      return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
    };
    const c = I.createClient(request, pat, process.env.ENGRAM_TEST_ORIGIN || "https://engram.pvelua.net");
    const w = await c.callTool("whoami");
    console.log("     live:", w.user_id, w.kind, "pat_role=" + w.credential?.pat_role, "protocol=" + c.protocol, JSON.stringify(I.judgeWhoami(w)));
    // ENGRAM v1.22.2 (DEV 2026-11-20) codes this refusal; before, it was an uncoded 404. Accept either, report which.
    await assert.rejects(c.callTool("get_article", { article_id: "nope" }), (e) => {
      console.log("     live get_article(bad id):", e.code ? "[" + e.code + "]" : "uncoded", "-", e.message.slice(0, 80));
      return e.code === "article_not_found" || e.message.startsWith("ENGRAM error, try again");
    });
  });
}

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
