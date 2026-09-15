# agent-sync

Carry your local AI agent setup to any machine.

Your skills, subagents, slash commands and memory files live in `~/.claude` on one computer. When you work on a server, a VM or a cloud development environment, none of it is there, and the usual fixes are bad: committing personal config into project repos, opaque disk snapshots, or rsync scripts pointed at a directory that also holds your OAuth tokens.

agent-sync packs the portable part of your setup into a bundle you can read before it goes anywhere, and applies it on the target machine with checks at every step.

## Status

Early development. Nothing is on npm yet. The first release ships four commands:

| Command | What it does |
| --- | --- |
| `scan` | Inventory your local setup and classify every item: portable, needs a secret, or excluded. Reads only; nothing leaves the machine. |
| `export` | Write a manifest plus file bundle to a directory, tarball or stdout. `--dry-run` prints the exact file list and stops. |
| `apply` | Unpack a bundle on the target machine. Verifies every file against its manifest hash, backs up what it overwrites, and names anything new since the last apply. |
| `undo` | Restore the backup the last `apply` saved. |

Transport is yours. A bundle is a plain file, so `scp` it, pipe it over ssh, or upload it through whatever your remote environment provides:

```sh
agent-sync export - | ssh mybox 'agent-sync apply -'
```

The same binary runs on the remote machine, so the reverse direction works too: run `export` there and `apply` at home.

Bundles are deterministic: the same setup produces byte-identical output. The `.tar` form is the canonical one; `.tgz` adds a gzip header whose OS byte can differ between platforms, so compare `.tar` bytes when you need reproducibility across machines.

## What never leaves your machine

The scanner will read an explicit allowlist of paths and nothing else. These will be excluded in code, with no flag to include them:

- `~/.claude.json` (OAuth state, MCP credentials, per-project history)
- `~/.claude/.credentials.json`
- session transcripts, caches and anything matching credential filename patterns (`.env`, `*.pem`, `id_*`)

MCP server entries will be recorded as a name plus a portability class. Secret values are never copied; a server that needs one gets flagged so you can re-enter it on the target. Hooks are shell commands, so each one will be confirmed individually before it is included.

## No telemetry

agent-sync makes no network calls. `export` writes a local file and `apply` reads one. There is no phone-home, no update check and no analytics.

## Supported agents

Claude Code first. Codex and OpenCode scanners are planned for the first release; see the issue tracker for progress.

## License

MIT. Maintained by [Coldtea](https://coldtea.ai).
