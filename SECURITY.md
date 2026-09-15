# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the "Report a vulnerability" button under this repository's Security tab. Do not open a public issue for a security problem. You will get a response within a week.

## Design constraints

These constraints govern the design. A build that violates one is a bug, and a report about it is treated as a vulnerability report:

1. The scanner reads an explicit allowlist of paths. Credential files, OAuth state, session history and caches are excluded in code; no flag or configuration includes them.
2. Secrets never enter a bundle. MCP server entries carry names and portability classes only.
3. The tool makes no network calls. There is no telemetry, no update check and no upload target.
4. `apply` verifies every file against its manifest hash before writing, rejects paths and symlinks that escape the target directory, and writes a backup before the first change.
5. The published package has zero runtime dependencies and will be built and published from this repository's CI.
