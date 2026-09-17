# Threat model

agent-sync moves the portable part of an AI agent setup between machines. The files it touches sit next to the most sensitive data on a developer's computer: OAuth tokens, API keys, session transcripts. This document says what the tool defends against, how, and where the honest edges are.

## Trust boundaries

Three boundaries shape the design:

1. The source machine is trusted. `scan` and `export` run on your own computer against your own files.
2. A bundle is untrusted input. By the time `apply` opens one it may have crossed machines, and nothing about its manifest or payload is believed until verified. Every claim the manifest makes is re-derived on the receiving side.
3. The transport is yours. agent-sync makes no network calls, so a bundle's integrity in transit rides on however you moved it. The manifest is not cryptographically signed in v1; signing is planned. If you need integrity guarantees today, move bundles over a channel you trust and compare `.tar` bytes, which are deterministic.

The target machine's existing directory layout is also treated as hostile, because an attacker who can plant a symlink inside `~/.claude` should not gain anything from your next `apply`.

## What the tool guarantees

Each guarantee names the code that enforces it. All of them are covered by tests that plant secrets or hostile inputs and assert the outcome.

**Reads are allowlisted.** The scanners read a fixed list of paths per agent and nothing else. Credential files, OAuth state, session history and caches are excluded in code, with no flag to include them (`src/scan/scanner.ts`, `src/scan/codex.ts`, `src/scan/opencode.ts`).

**Secret values never reach an output.** Reports and manifests carry names and classifications, not values. Environment references are extracted as variable names only, with strict rules under secret-bearing keys so a `$` inside a literal secret cannot surface a fragment of it (`src/scan/classify.ts`). Parse errors from every parser in the tool carry positions, never file content, because JavaScript and library error messages can embed source excerpts (`src/scan/toml.ts`, `readJsonObject` in `src/scan/scanner.ts`).

**MCP endpoints are only carried when they cannot hold a secret.** A server URL enters a report or bundle only if it is http(s) with no userinfo, no query, no fragment, and does not point at loopback, link-local, or private address space, including IPv4-mapped and IPv4-compatible IPv6 spellings. The same sanitizer runs at export and again at apply, so a crafted manifest cannot register an endpoint the classifier would refuse (`sanitizeRemoteEndpoint` in `src/scan/classify.ts`, `src/apply/mcp.ts`).

**Nothing is written until everything verifies.** `apply` parses archives with a strict reader (regular files and directories only, checksums verified, duplicates and traversal refused), gates on the manifest schema version, verifies every payload against its SHA-256 and size, and refuses payloads the manifest does not list. A bundle that fails any check leaves the target untouched (`src/apply/untar.ts`, `src/apply/bundle.ts`).

**The write policy is an allowlist of what export can produce.** A bundle may write only `CLAUDE.md`, `settings.json`, files under `skills/`, `agents/`, or `commands/`, and the agent-namespaced set (`codex/AGENTS.md`, `codex/config.toml`, `codex/skills/`, `opencode/opencode.json`, `opencode/commands/`); any other path refuses the bundle whole. Each agent namespace applies into its own root with its own marker, backups, and symlink containment, and the namespaced config files carry only their agent's portable preference keys — any other key refuses the bundle whole, exactly as `settings.json` does. This is deliberately not a denylist: a denylist over an open path space loses to whatever it forgot to name (`settings.local.json` carrying unconsented hooks, agent-sync's own marker file). Credential-shaped filenames and `.claude.json` are additionally refused at any depth, case-folded because targets may sit on case-insensitive filesystems (`assertWritablePath` in `src/apply/bundle.ts`).

**Writes cannot escape the target.** Beyond lexical path containment, every write path is walked component by component and refused if any existing component is a symlink. The target directory itself may be a symlink; nothing under it may be (`resolveForWrite` in `src/apply/apply.ts`).

**Code execution needs consent on both machines.** Hooks and `statusLine` entries are shell commands, and an enabled plugin installs marketplace code. They enter a bundle only when named with `--hook` or `--plugin` at export, and they apply only when named again at apply; a marketplace source survives the gate only when a confirmed plugin references it. Behind the gates sits a settings allowlist: a bundle's `settings.json` may carry only the keys export can produce (the portable preference keys, `statusLine`, `hooks`, `enabledPlugins`, `extraKnownMarketplaces`, each shape-checked), so keys that execute code on the target (`apiKeyHelper`, `env`, auth refresh scripts) refuse the bundle whole rather than riding past a consent filter that does not know them (`assertPortableSettings` in `src/apply/apply.ts`). A consequence with teeth: adding a new portable settings key is no longer a schema-invisible change, because an older apply will refuse a newer bundle that carries it — a future key must bump the manifest schema version, or knowingly accept that older applies fail loud on such bundles. The schema version itself is an advisory compatibility signal, not a trust boundary: every receive-side control (path allowlist, per-agent key allowlists, per-root containment) is enforced regardless of the schema a bundle claims, so no check may ever gate on it. MCP registration is opt-in per server with `--mcp` on BOTH sides and goes through the agent's own CLI. Remote servers carry name and sanitized URL only. Command-based (stdio) servers carry structure only — command, args, env NAMES — with values dropped at classification time so no downstream layer can see one (superseding the earlier rule that stdio servers are never applied); on the target, values are typed fresh in the guided flow or read from the machine's own environment, the untrusted manifest entry is fully revalidated before anything is displayed or assembled — string hygiene across the whole C0 range, env-name shape, size caps, and a rerun of the same portability gate export uses — and env values are masked in every echoed or dry-run line, and no shell is ever involved. Servers pinned to a machine (local paths, localhost endpoints) remain blocked. Tokens, headers, and environment values never travel in any form.

**Applies are reversible.** What an apply overwrites is backed up first, the record of the apply lands before the first destructive write, and `agent-sync undo` restores it or aborts untouched if the backup is incomplete.

## Known limitations

These are deliberate v1 edges, kept here so they are decisions rather than surprises.

- There is a window between the symlink check and the write. Exploiting it requires racing a local process on your own machine, which is outside the single-user model this CLI assumes. File-descriptor-based writes would close it.
- The manifest is unsigned, as described under trust boundaries above.
- Under keys that are not secret-shaped, bare `$WORD` fragments in strings are still extracted as environment-variable names, matching the reference classifier this port follows. A secret smuggled into a field like `args` could surface a fragment of itself as a name. Secrets in such fields are invisible to any key-based model.
- The strict extraction under secret-shaped keys means a mid-string reference like `"Bearer $GITHUB_TOKEN"` loses its name hint; the braced `${GITHUB_TOKEN}` form keeps it. This is the safe side of the trade.
- OpenCode `environment` blocks are covered by the strict secret-key rules, so values cannot leak, but variable name hints are not extracted from them.
- `.tgz` output can differ between platforms by one byte, the gzip header's OS field. `.tar` is the canonical deterministic form.

## Out of scope

agent-sync does not defend against a compromised source machine, and it does not judge the content of what you sync: a skill is data to this tool, and a malicious skill synced faithfully is still malicious on arrival. Review what lives in your setup before carrying it anywhere. Supply-chain trust in the published package itself rests today on two things: a zero-dependency runtime and a deterministic build. Releases are currently published by the maintainer under two-factor authentication, and no automation token capable of publishing this package exists. npm provenance attestation and pinned-CI publishing arrive together when releases move into CI (`.github/workflows/release.yml` is that path, dormant until then). Until provenance lands, verify a release by unpacking the registry tarball and comparing per-file hashes against a local `npm pack` of the same tagged commit: the build is deterministic, so the contents must match even though the compressed tarballs may differ by a gzip header byte.

## Reporting

Security problems go through private vulnerability reporting, described in [SECURITY.md](../SECURITY.md). A report that shows any guarantee above failing is a vulnerability, not a bug.
