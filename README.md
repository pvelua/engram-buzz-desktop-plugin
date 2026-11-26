# ENGRAM for Buzz Desktop agents

A Buzz Desktop plug-in (Desktop 1.x) that gives the agents you create in Desktop, Goose agents included, ENGRAM
**memory**, **skills**, the **knowledge base** and **hand-offs** between agents. A hand-off wakes the agent it is
for, with no one mentioning it.

Tutorial: [pvelua.net/tutorial_12](https://www.pvelua.net/tutorial_12), a release desk of three agents built
step by step.

> ⚠️ Desktop agents run only while Buzz Desktop is open. For always-on agents, use hosted agents.

## What it adds

- **Settings → ENGRAM**: one row per Desktop agent. Paste the agent's ENGRAM PAT (use a `restricted` one) and its
  project, **Save**, then **Test**. Test shows the agent's ENGRAM identity, its PAT role, and the channel its
  wake-ups go to.
- **Ten agent tools**, each acting under the calling agent's own PAT:

  | tool | what it does |
  |---|---|
  | `engram_skill` | the agent's assigned skill in its project, composed by ENGRAM |
  | `engram_recall` / `engram_remember` | the agent's own memory in its project |
  | `engram_search` / `engram_get_article` | find and read knowledge-base articles |
  | `engram_hand_off` | hand findings to a teammate agent; they land in its ENGRAM inbox |
  | `engram_inbox` / `engram_inbox_act` | list what is waiting on the agent, and act on an item with the tools ENGRAM names for it |
  | `engram_turn` | report a finished task, so ENGRAM sees the work as one episode |
  | `engram_whoami` | the agent's ENGRAM identity |

- **Wake-ups.** Once a minute the plug-in checks each mapped agent's ENGRAM inbox. A new item (a hand-off, an
  approval, a project change) wakes the agent in the channel bound to its project.
- **One standing instruction** for mapped agents: load your skill first on every new task.

An agent with no mapping gets *"This agent has no ENGRAM identity yet. Ask its owner to add it in Settings →
ENGRAM."*

⚠️ The PAT is kept in this plug-in's `localStorage` (Desktop has no plug-in secret store). Use a restricted PAT, and
revoke or rotate it in ENGRAM. The plug-in never logs it, returns it to an agent, or shows it again.

## Install (owner, once)

Settings → Plugins → Manage plugins → **Add** → **Browse** (under Add from folder) → pick `plugin/` → review host
access (`https://engram.pvelua.net`) → **Install plugin**. Use Browse, not drag and drop: a dropped folder is
copied and cannot be reloaded.

## Which ENGRAM

Each Buzz **community** uses one ENGRAM, and an agent's calls go only to its own community's ENGRAM, so a PAT never
crosses communities. The hosted community `engram-buzz.pvelua.net` uses ENGRAM at `engram.pvelua.net` by default;
a community with no ENGRAM refuses clearly. Mappings are per community and agent: the same Desktop agent in two
communities has two identities.

**To use another ENGRAM**, add its origin in two places in your copy, then press **Update** in Manage plugins:
`networkOrigins` in `plugin/manifest.json`, and `ORIGINS` (with a `DEFAULTS` entry if it should be a community's
default) at the top of `plugin/plugin.js`. Desktop refuses any host the manifest does not declare.

## Tests

`node tools/test.mjs` runs the client and the plug-in against a fake host and a fake MCP server.
`ENGRAM_TEST_PAT=… node tools/test.mjs --live` adds a `whoami` against ENGRAM (`ENGRAM_TEST_ORIGIN` to point it
elsewhere). The PAT is read from the environment only.

## License

Apache-2.0. See `LICENSE`.
