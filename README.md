<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark-light.svg" alt="AGENT SYNC" width="620">
  </picture>
</p>

<p align="center"><b>Carry your local AI agent setup to any machine.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@coldtea/agent-sync"><img src="https://img.shields.io/npm/v/%40coldtea%2Fagent-sync?color=5c9a8f&label=npm" alt="npm version"></a>
  <a href="https://github.com/coldteadotai/agent-sync/actions/workflows/ci.yml"><img src="https://github.com/coldteadotai/agent-sync/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-5c9a8f" alt="zero runtime dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5c9a8f" alt="MIT license"></a>
</p>

---

Your skills, subagents, slash commands and memory files live in `~/.claude` on one computer. When you work on a server, a VM or a cloud development environment, none of it is there, and the usual fixes are bad: committing personal config into project repos, opaque disk snapshots, or rsync scripts pointed at a directory that also holds your OAuth tokens.

agent-sync packs the portable part of your setup into a bundle you can read before it goes anywhere, and applies it on the target machine with checks at every step. Secrets never travel — not in files, not in MCP entries, not in env values.

```
▄▀▀▄ ▄▀▀▀ █▀▀▀ █▄ █ ▀█▀▀    ▄▀▀▀ █  █ █▄ █ ▄▀▀▀
█▀▀█ █ ▀█ █▀▀  █▀██  █       ▀▀▄  █▀  █▀██ █
▀  ▀  ▀▀▀ ▀▀▀▀ ▀  ▀  ▀      ▀▀▀   ▀   ▀  ▀  ▀▀▀
carry your agent setup anywhere · v0.3.0

┌  Found on this machine
│
│  Claude Code   2 skills · settings · 10 hooks · 3 plugins
│  Codex         memory · settings
│
◆  What goes in the bundle?   5 of 8 picked
│  space picks · enter continues with what is checked
│
│  Skills
│  ● boxd-cli
│  ● boxd-setup-hermes
│  Plugins
│  ○ ponytail
│  Codex
│  ● config.toml
│  ● AGENTS.md
│
│  ✕ 5 items never leave this machine · v to view
└  space pick · enter continue · ? keys
```

## Install

```sh
npm install -g @coldtea/agent-sync
```

Node 20.6 or newer. On Linux with nvm, `npm install -g` places the `agent-sync` binary in the active Node version's own bin directory — if the command is not found afterwards, your PATH is missing that directory; `nvm use` (or adding `$(npm prefix -g)/bin` to PATH) fixes it, and switching Node versions means reinstalling globals for that version.

## Status

Published as [`@coldtea/agent-sync`](https://www.npmjs.com/package/@coldtea/agent-sync). Four commands and a guided mode:

| Command | What it does |
| --- | --- |
| `scan` | Inventory your local setup and classify every item: portable, needs a secret, or excluded. Reads only; nothing leaves the machine. |
| `export` | Write a manifest plus file bundle to a directory, tarball or stdout. `--dry-run` prints the exact file list and stops. Hooks are included only when you name each one with `--hook`; plugins only with `--plugin` (as name and marketplace references, never code); `--skip` leaves any scanned item behind. |
| `apply` | Unpack a bundle on the target machine. Verifies every file against its manifest hash before writing anything, refuses hostile bundles whole, backs up what it overwrites, and names anything new since the last apply. Hooks need re-confirming with `--hook` and plugin references with `--plugin`; portable MCP servers register only when named with `--mcp`, through the agent's own CLI. |
| `undo` | Restore the backup the last `apply` saved and remove what it created. |

Run bare `agent-sync` in a terminal for the guided export: it scans first, shows what can travel next to what never leaves the machine, asks about each hook with the command it would run, and ends by printing the exact flag spelling of what you chose, so the interactive run teaches the scripted one. `agent-sync apply <bundle>` without consent flags is guided the same way: the verified plan first, then a y/N per hook and per plugin, then MCP registration showing the exact `claude mcp add` line, and writes only after every answer. `--plain` (or `AGENT_SYNC_ACCESSIBLE=1`, or `TERM=dumb`) swaps the picker for numbered-list prompts that screen readers can follow. In CI, in pipes, or with `--no-input`, nothing ever prompts.

Transport is yours. A bundle is a plain file, so `scp` it, pipe it over ssh, or upload it through whatever your remote environment provides:

```sh
agent-sync export - | ssh mybox 'agent-sync apply -'
```

The same binary runs on the remote machine, so the reverse direction works too: run `export` there and `apply` at home.

Bundles are deterministic: the same setup produces byte-identical output. The `.tar` form is the canonical one; `.tgz` adds a gzip header whose OS byte can differ between platforms, so compare `.tar` bytes when you need reproducibility across machines.

## What never leaves your machine

The scanner reads an explicit allowlist of paths and nothing else. These are excluded in code, with no flag to include them:

- `~/.claude.json` (OAuth state, MCP credentials, per-project history)
- `~/.claude/.credentials.json`, Codex `auth.json`, OpenCode `auth.json`
- session transcripts, caches and anything matching credential filename patterns (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `id_*`)

File contents are scanned at export too: a file whose content matches a token pattern (known key prefixes, private-key blocks, high-entropy strings) is refused by default and carried only after explicit consent — a y/N in the guided flow, `--allow-secret <path>` in flag mode. Findings name the file and line, never the matched value.

MCP server entries are recorded as a name plus a portability class. Remote servers travel as name and sanitized URL. Command-based (stdio) servers can travel too, as structure only — the command, its args, and the NAMES of the env variables it needs — behind a repeatable `--mcp <name>` at export and again at apply; the values are typed fresh on the target (the guided apply asks with a masked prompt, the scripted path reads the target machine's own environment and fails closed naming the missing variable — deliberately no flag, so secrets never touch argv or shell history). Secret values are never copied anywhere. Hooks are shell commands, so each one is confirmed individually before it is included, and confirmed again on the machine that applies it.

## No telemetry

agent-sync makes no network calls. `export` writes a local file and `apply` reads one. There is no phone-home, no update check and no analytics.

## Supported agents

`scan`, `export`, and `apply` cover Claude Code, Codex, and OpenCode. Codex and OpenCode files travel under agent namespaces in the bundle (`codex/`, `opencode/`) and apply into the roots those tools actually read: `~/.codex` and `~/.agents/skills` for Codex, the XDG config dir for OpenCode; each root gets its own backup and undo marker. A bundle carrying Codex or OpenCode content is manifest schema 2 — an older agent-sync refuses it with a clear upgrade message; a Claude-only bundle stays schema 1, byte-compatible with v1. OpenCode plugin code never syncs (plugins run code), and MCP registration remains Claude-only for now, since it goes through `claude mcp add`.

The full security design, including what the tool guarantees, the code that enforces each guarantee, and the known limitations, is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## License

MIT. Maintained by [Coldtea](https://coldtea.ai).
