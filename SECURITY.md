# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue: use **Report a vulnerability** on this
repository's **Security** tab (GitHub private vulnerability reporting). Include what you found, how to reproduce
it, and which version of the plug-in and of Buzz Desktop you used.

Do not include a real PAT, private key or other credential in the report, even a revoked one. Describe it instead
("a restricted PAT for an agent in project X").

We aim to acknowledge a report within a few working days, and to tell you what we will do about it.

## What the plug-in handles, and how

The plug-in runs inside Buzz Desktop and calls ENGRAM on behalf of the agents you map. The parts that matter for
security:

- **Agent PATs.** Each mapped agent's ENGRAM PAT is stored in the plug-in's `localStorage`, because Desktop has no
  plug-in secret store yet. The plug-in never logs a PAT, returns it to an agent, puts it in a tool result, or shows
  it again in Settings. Use a **restricted** PAT for every agent, and revoke or rotate it in ENGRAM if it may have
  leaked.
- **One identity per agent.** Every tool call acts under the calling agent's own PAT, never another agent's or the
  owner's.
- **Communities stay separate.** An agent's calls go only to its own community's ENGRAM, so a PAT is never sent to
  another community's server. A community with no ENGRAM configured refuses rather than falling back.
- **Declared hosts only.** The plug-in can reach only the origins in `plugin/manifest.json` (`networkOrigins`);
  Desktop refuses any other host.

Reports about any of these are especially welcome, as are reports about ENGRAM content reaching an agent it
should not.
