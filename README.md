# agent-sync

Carry your local AI agent setup to any machine.

Your skills, subagents, slash commands and memory files live in `~/.claude` on one computer. When you work on a server, a VM or a cloud development environment, none of it is there, and the usual fixes are bad: committing personal config into project repos, opaque disk snapshots, or rsync scripts pointed at a directory that also holds your OAuth tokens.

agent-sync packs the portable part of your setup into a bundle you can read before it goes anywhere, and applies it on the target machine with checks at every step.

## Status

Implemented and tested; first npm release pending. Four commands:

| Command | What it does |
| --- | --- |
| `scan` | Inventory your local setup and classify every item: portable, needs a secret, or excluded. Reads only; nothing leaves the machine. |
| `export` | Write a manifest plus file bundle to a directory, tarball or stdout. `--dry-run` prints the exact file list and stops. Hooks are included only when you name each one with `--hook`. |
| `apply` | Unpack a bundle on the target machine. Verifies every file against its manifest hash before writing anything, refuses hostile bundles whole, backs up what it overwrites, and names anything new since the last apply. Hooks need re-confirming with `--hook`; portable MCP servers register only when named with `--mcp`, through the agent's own CLI. |
| `undo` | Restore the backup the last `apply` saved and remove what it created. |

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

MCP server entries are recorded as a name plus a portability class. Secret values are never copied; a server that needs one gets flagged so you can re-enter it on the target. Hooks are shell commands, so each one is confirmed individually before it is included, and confirmed again on the machine that applies it.

## No telemetry

agent-sync makes no network calls. `export` writes a local file and `apply` reads one. There is no phone-home, no update check and no analytics.

## Supported agents

`scan` covers Claude Code, Codex, and OpenCode. `export`/`apply` sync Claude Code setups today; Codex and OpenCode sync is next, since their files span more than one directory root and deserve their own careful mapping.

The full security design, including what the tool guarantees, the code that enforces each guarantee, and the known limitations, is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## License

MIT. Maintained by [Coldtea](https://coldtea.ai).
