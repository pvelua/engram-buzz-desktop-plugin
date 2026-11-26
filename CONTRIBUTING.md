# Contributing

Thank you for helping. Issues and pull requests are welcome.

## Before you open a pull request

1. **Run the tests:** `node tools/test.mjs`. They run the plug-in against a fake Desktop host and a fake ENGRAM
   server, need no network, and must all pass. Add a test for any behaviour you change.
2. **Keep the plug-in dependency-free.** `plugin/plugin.js` is plain JavaScript loaded by Buzz Desktop as it is:
   no build step, no packages.
3. **Never put a credential in code, tests or examples.** Tests use obvious fakes (`"Bearer AGENT-PAT"`,
   `user_900`). A PAT for a live test comes from the environment only:
   `ENGRAM_TEST_PAT=… node tools/test.mjs --live`.
4. **Try it in Desktop.** Install your copy with Settings → Plugins → Manage plugins → **Add** → **Browse**, and
   check the change works with a mapped agent. After editing, **Reload** the plug-in (or **Update** if you changed
   `manifest.json`).

## Reporting a bug

Open an issue with the plug-in version (`CLIENT` in `plugin/plugin.js`), your Buzz Desktop version, what you did,
what you expected and what happened. Leave out PATs, keys and private channel content. For anything
security-related, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## License

By contributing, you agree that your contribution is licensed under the Apache License 2.0, the same as the rest
of this repository (see `LICENSE`).
