import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { CommandIo, ExitCode } from "../main.js";
import { collectExport, skipToken, type ExportPlan } from "../export/collect.js";
import {
  assertPortableSettings,
  defaultAgentRoots,
  executeApply,
  gateSettingsHooks,
  gateSettingsPlugins,
  planApply,
  splitBundleByRoot,
  type AgentRoots,
} from "../apply/apply.js";
import type { LoadedBundle } from "../apply/bundle.js";
import { assertPortableStdioServer, commandOnPath, planMcpRegistrations, runMcpRegistration, type McpRegistration } from "../apply/mcp.js";
import type { JsonValue } from "../scan/classify.js";
import { commandSummary, scanClaudeCode } from "../scan/scanner.js";
import { scanCodex } from "../scan/codex.js";
import { scanOpencode } from "../scan/opencode.js";
import type { ScanItem, ScanReport } from "../scan/types.js";
import { createTheme } from "../tui/theme.js";
import { Screen } from "../tui/terminal.js";
import { createFlow, type Flow, type MultiGroup } from "../tui/components.js";
import { Plain } from "../tui/plain.js";
import { wordmarkLines } from "../tui/wordmark.js";
import { buildTar, writeBundleDirectory } from "./export.js";

declare const __PKG_VERSION__: string;

export type GuidedMode = "picker" | "plain";

export interface EntryContext {
  help: boolean;
  version: boolean;
  plain: boolean;
  noInput: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  env: Record<string, string | undefined>;
}

// The entry rule, verbatim from the design doc: the picker engages only when
// both ends are TTYs, CI is unset, and nothing asked it not to. --plain is an
// explicit request and works anywhere (that is what makes it scriptable);
// env-triggered plain only replaces a picker that would otherwise have run.
export function chooseEntry(context: EntryContext): GuidedMode | "static" {
  if (context.help || context.version || context.noInput) return "static";
  if (context.plain) return "plain";
  if (!context.stdinTTY || !context.stdoutTTY || context.env.CI !== undefined) return "static";
  if (context.env.AGENT_SYNC_ACCESSIBLE === "1" || context.env.TERM === "dumb") return "plain";
  return "picker";
}

interface Selections {
  skips: string[];
  plugins: string[];
  hooks: string[];
  mcp?: string[];
  allowSecrets?: string[];
  dest: string;
}

// The picker teaches the script: the exact non-interactive spelling of what
// the user just chose.
export function flagEcho(selections: Selections): string {
  const parts = ["agent-sync", "export", quote(selections.dest)];
  for (const skip of [...selections.skips].sort()) parts.push("--skip", quote(skip));
  for (const plugin of [...selections.plugins].sort()) parts.push("--plugin", quote(plugin));
  for (const hook of [...selections.hooks].sort()) parts.push("--hook", quote(hook));
  for (const server of [...(selections.mcp ?? [])].sort()) parts.push("--mcp", quote(server));
  for (const path of [...(selections.allowSecrets ?? [])].sort()) parts.push("--allow-secret", quote(path));
  return parts.join(" ");
}

function quote(token: string): string {
  return /^[A-Za-z0-9@._/-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

const KIND_GROUPS: ReadonlyArray<{ kind: ScanItem["kind"]; title: string; preselected: boolean }> = [
  { kind: "skill", title: "Skills", preselected: true },
  { kind: "subagent", title: "Subagents", preselected: true },
  { kind: "command", title: "Commands", preselected: true },
  { kind: "memory", title: "Memory", preselected: true },
  { kind: "settings", title: "Settings", preselected: true },
  { kind: "plugin", title: "Plugins — declarative, re-installed by name", preselected: false },
];

const AGENT_TITLES: Record<"codex" | "opencode", string> = {
  codex: "Codex",
  opencode: "OpenCode",
};

// The target-agents multi-select, folded into the travel picker: an agent's
// groups appear only when that agent is present with candidates, so the
// picker never shows a choice that does nothing.
export function buildTravelGroups(report: ScanReport, others: ScanReport[] = []): MultiGroup<string>[] {
  const userItems = report.items.filter((item) => item.scope === "user" && item.status === "candidate");
  const groups: MultiGroup<string>[] = [];
  for (const definition of KIND_GROUPS) {
    const items = userItems
      .filter((item) => item.kind === definition.kind)
      .map((item) => {
        const entry: MultiGroup<string>["items"][number] = {
          value: skipToken(item),
          label: item.name,
          preselected: definition.preselected,
        };
        if (item.detail !== undefined) entry.hint = item.detail;
        return entry;
      });
    if (items.length > 0) groups.push({ title: definition.title, items });
  }
  for (const other of others) {
    if (other.agent === "claude-code") continue;
    const agent = other.agent;
    const candidates = other.items.filter(
      (item) => item.scope === "user" && item.status === "candidate" && item.kind !== "mcp_server",
    );
    if (candidates.length === 0) continue;
    groups.push({
      title: AGENT_TITLES[agent],
      items: candidates.map((item) => {
        const entry: MultiGroup<string>["items"][number] = {
          value: skipToken(item, agent),
          label: item.name,
          hint: item.kind,
          preselected: true,
        };
        return entry;
      }),
    });
  }
  const stdioServers = report.items.filter(
    (item) => item.scope === "user" && item.kind === "mcp_server" && item.stdio !== undefined,
  );
  if (stdioServers.length > 0) {
    groups.push({
      title: "MCP servers \u00b7 commands, re-created with your consent",
      items: stdioServers.map((item) => {
        const stdio = item.stdio;
        const entry: MultiGroup<string>["items"][number] = {
          value: `mcp/${item.name}`,
          label: item.name,
          preselected: false,
        };
        if (stdio !== undefined) {
          const envSuffix = stdio.envNames.length > 0 ? ` (needs ${stdio.envNames.join(", ")})` : "";
          entry.hint = `${[stdio.command, ...stdio.args].join(" ")}${envSuffix}`;
        }
        return entry;
      }),
    });
  }
  // Exclusions no longer occupy the picker: the review's
  // closing line accounts for them where the leaves-the-machine story lives.
  return groups;
}

export function buildHookGroup(report: ScanReport): MultiGroup<string> | null {
  const hooks = report.items.filter((item) => item.scope === "user" && item.kind === "hook");
  if (hooks.length === 0) return null;
  return {
    title: "Hooks — each runs the shell command shown",
    items: hooks.map((item) => {
      const entry: MultiGroup<string>["items"][number] = { value: item.name, label: item.name };
      if (item.detail !== undefined) entry.hint = item.detail;
      return entry;
    }),
  };
}

interface AgentFact {
  name: string;
  summary: string;
}

function agentFacts(reports: ScanReport[]): AgentFact[] {
  const titles: Record<ScanReport["agent"], string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
  };
  return reports.flatMap((report) => {
    // Absent agents are simply not mentioned; the card lists what IS here.
    if (!report.present) return [];
    const name = titles[report.agent];
    const userItems = report.items.filter((item) => item.scope === "user");
    const counts: string[] = [];
    for (const [kind, singular, plural] of [
      ["skill", "skill", "skills"],
      ["subagent", "subagent", "subagents"],
      ["command", "command", "commands"],
      ["memory", "memory", "memory"],
      ["settings", "settings", "settings"],
      ["hook", "hook", "hooks"],
      ["plugin", "plugin", "plugins"],
      ["mcp_server", "MCP server", "MCP servers"],
    ] as const) {
      const total = userItems.filter((item) => item.kind === kind).length;
      if (total === 0) continue;
      if (kind === "settings" || kind === "memory") counts.push(singular);
      else counts.push(`${total} ${total === 1 ? singular : plural}`);
    }
    return [{ name, summary: counts.length > 0 ? counts.join(" \u00b7 ") : "nothing to sync" }];
  });
}

const DESTINATIONS = [
  { value: "setup.tgz", label: "setup.tgz", hint: "compressed bundle in this directory" },
  { value: "setup.tar", label: "setup.tar", hint: "uncompressed bundle in this directory" },
  { value: "agent-sync-bundle", label: "agent-sync-bundle/", hint: "plain directory, inspectable" },
];

export interface GuidedOverrides {
  userDir?: string;
  claudeJsonPath?: string;
  codexHome?: string;
  codexAgentsDir?: string;
  opencodeConfigDir?: string;
  destDir?: string;
  screen?: Screen;
  plain?: Plain;
  env?: Record<string, string | undefined>;
}

export async function runGuided(io: CommandIo, mode: GuidedMode, overrides: GuidedOverrides = {}): Promise<ExitCode> {
  const scanOptions: Parameters<typeof scanClaudeCode>[0] = { projectDir: null };
  if (overrides.userDir !== undefined) scanOptions.userDir = overrides.userDir;
  if (overrides.claudeJsonPath !== undefined) scanOptions.claudeJsonPath = overrides.claudeJsonPath;
  const report = scanClaudeCode(scanOptions);
  const codexScan: Parameters<typeof scanCodex>[0] = { projectDir: null };
  if (overrides.codexHome !== undefined) codexScan.codexHome = overrides.codexHome;
  if (overrides.codexAgentsDir !== undefined) codexScan.agentsDir = overrides.codexAgentsDir;
  const opencodeScan: Parameters<typeof scanOpencode>[0] = { projectDir: null };
  if (overrides.opencodeConfigDir !== undefined) opencodeScan.configDir = overrides.opencodeConfigDir;
  const reports = [report, scanCodex(codexScan), scanOpencode(opencodeScan)];

  const groups = buildTravelGroups(report, reports.slice(1));
  const hookGroup = buildHookGroup(report);
  if (groups.length === 0 && hookGroup === null) {
    io.err("Nothing to sync yet. Run `agent-sync scan` to see what agent-sync looks for.");
    return 0;
  }

  const ui = mode === "picker" ? pickerUi({ ...overrides, wordmark: true }) : plainUi(io, overrides);
  try {
    ui.intro("Found on this machine", `carry your agent setup anywhere ${"\u00b7"} v${__PKG_VERSION__}`, agentFacts(reports));

    const travel = await ui.groupMultiselect("What goes in the bundle?", groups);
    if (travel === null) return 2;
    const chosen = new Set(travel);
    // Plugins are opt-in (--plugin), everything else is opt-out (--skip), so an
    // unselected plugin needs no skip token — the default already excludes it.
    const skips = groups
      .filter((group) => group.locked !== true)
      .flatMap((group) => group.items.map((item) => item.value))
      .filter((token) => !chosen.has(token) && !token.startsWith("plugin/") && !token.startsWith("mcp/"));
    const plugins = travel.filter((token) => token.startsWith("plugin/")).map((token) => token.slice("plugin/".length));
    const selectedMcp = travel.filter((token) => token.startsWith("mcp/")).map((token) => token.slice("mcp/".length));

    let hooks: string[] = [];
    if (hookGroup !== null) {
      const picked = await ui.groupMultiselect(
        "Which hooks go in the bundle?",
        [hookGroup],
        "hooks run shell commands on the target \u00b7 none go unless you pick them",
      );
      if (picked === null) return 2;
      hooks = picked;
    }

    const collectOptions: Parameters<typeof collectExport>[0] = {
      confirmedHooks: hooks,
      selectedPlugins: plugins,
      selectedMcp,
      skips,
    };
    if (overrides.userDir !== undefined) collectOptions.userDir = overrides.userDir;
    if (overrides.claudeJsonPath !== undefined) collectOptions.claudeJsonPath = overrides.claudeJsonPath;
    if (overrides.codexHome !== undefined) collectOptions.codexHome = overrides.codexHome;
    if (overrides.codexAgentsDir !== undefined) collectOptions.codexAgentsDir = overrides.codexAgentsDir;
    if (overrides.opencodeConfigDir !== undefined) collectOptions.opencodeConfigDir = overrides.opencodeConfigDir;
    let plan = collectExport(collectOptions);

    // Secret findings become a consent step: refuse-by-default, carried only
    // after an explicit yes per file. The prompt names file, line and kind —
    // never the matched content.
    const allowSecrets: string[] = [];
    const flaggedPaths = [...new Set(plan.secretFindings.map((finding) => finding.path))];
    if (flaggedPaths.length > 0) {
      for (const path of flaggedPaths) {
        const findings = plan.secretFindings.filter((finding) => finding.path === path);
        const first = findings[0];
        if (first === undefined) continue;
        const where =
          findings.length === 1
            ? `line ${first.line}, ${first.kind}`
            : `line ${first.line}, ${first.kind}, +${findings.length - 1} more`;
        const consent = await ui.confirm(`${path} looks like it contains a secret (${where}). Carry it anyway?`, false);
        if (consent === null) return 2;
        if (consent) allowSecrets.push(path);
      }
      if (allowSecrets.length > 0) {
        plan = collectExport({ ...collectOptions, allowSecrets });
      }
    }

    if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      for (const diagnostic of plan.diagnostics) io.err(`${diagnostic.severity}: ${diagnostic.message}`);
      return 2;
    }
    if (plan.entries.length === 0) {
      ui.outro("Nothing selected; nothing was written.");
      return 0;
    }

    const totalBytes = plan.entries.reduce((sum, entry) => sum + entry.content.length, 0);
    // The review IS the product promise: the actual tree of what leaves the
    // machine, read before anything is written. The destination is a named
    // default inside the confirm, not a step of its own.
    let dest = "setup.tgz";
    for (;;) {
      const choice = await ui.review(buildReviewLines(plan, hooks, plugins, report.excluded.length), destLabel(dest));
      if (choice === null) return 2;
      if (choice === "skip") {
        ui.outro(
          "Nothing was written.",
          `To pack a different way, scripted: ${flagEcho({ skips, plugins, hooks, mcp: selectedMcp, allowSecrets, dest })}`,
        );
        return 0;
      }
      if (choice === "dest") {
        const picked = await ui.select("Where should the bundle go?", DESTINATIONS);
        if (picked === null) return 2;
        dest = picked;
        continue;
      }
      break;
    }

    const destPath = join(overrides.destDir ?? process.cwd(), dest);
    writeDestination(destPath, dest, plan);

    const selections: Selections = { skips, plugins, hooks, mcp: selectedMcp, allowSecrets, dest };
    ui.outro(
      `Packed ${plan.entries.length} files (${formatBytes(totalBytes)}) -> ${destLabel(dest)}`,
      `Next time, scripted: ${flagEcho(selections)}`,
      `Apply on the other side: npx @coldtea/agent-sync@latest apply ${destLabel(dest)}`,
    );
    return 0;
  } finally {
    ui.close();
  }
}

// Full-content wrapping for consent blocks: every character lands on some
// line; nothing hides past an ellipsis.
export function wrapDisplay(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += width) {
    lines.push(index === 0 ? text.slice(0, width) : `    ${text.slice(index, index + width)}`);
  }
  return lines;
}

function destLabel(dest: string): string {
  return dest === "agent-sync-bundle" ? "agent-sync-bundle/" : dest;
}

// The review screen must never scroll its own prompt away: renderLive slices
// top-first, so a tree taller than the terminal would cut "Pack it?". The
// tree yields instead — head lines, an elision count, and always the closing
// consent-accounting line.
export function fitReviewLines(lines: string[], budget: number): string[] {
  if (lines.length <= budget || budget < 4) return lines.slice(0, Math.max(budget, 4));
  const tail = lines.slice(-2);
  const head = lines.slice(0, budget - 3);
  const elided = lines.length - head.length - tail.length;
  return [...head, `... ${elided} more`, ...tail];
}

// The bundle as a readable tree: skill directories aggregate to a count and
// size, config files name the keys they carry, and the closing line accounts
// for consents and exclusions, so the screen is the manifest in prose.
export function buildReviewLines(
  plan: ExportPlan,
  hooks: string[],
  plugins: string[],
  excludedCount: number,
): string[] {
  const lines: string[] = [];
  const seenDirGroups = new Set<string>();
  const annotate = (path: string, content: Buffer): string => {
    const name = path.split("/").pop() ?? path;
    if (name === "CLAUDE.md" || name === "AGENTS.md") return "memory";
    if (name.endsWith(".json") || name.endsWith(".toml")) {
      try {
        // TOML lines must look like a bare-key assignment to count as a key:
        // anything else (section headers, multi-line array elements, closing
        // brackets) is CONTENT and must never reach the screen.
        const keys =
          name.endsWith(".json")
            ? Object.keys(JSON.parse(content.toString("utf8")) as Record<string, unknown>)
            : content
                .toString("utf8")
                .split("\n")
                .map((line) => /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1] ?? "")
                .filter((key) => key.length > 0);
        if (keys.length > 0) return keys.sort().join(", ");
      } catch {
        // Annotation only; an unparseable file just goes unannotated.
      }
    }
    return "";
  };

  const pad = (name: string, note: string, indent: string): string =>
    note.length > 0 ? `${indent}${name.padEnd(Math.max(22 - indent.length + 2, name.length + 2))}${note}` : `${indent}${name}`;

  for (const entry of plan.entries) {
    const parts = entry.path.split("/");
    if (parts.length === 1) {
      lines.push(pad(entry.path, annotate(entry.path, entry.content), ""));
      continue;
    }
    // skills/<name>/** and codex/skills/<name>/** aggregate per skill dir;
    // every other nested path lists as a file under its top-level dir.
    const isSkillTree = parts[0] === "skills" || (parts[0] === "codex" && parts[1] === "skills");
    const groupKey = isSkillTree ? parts.slice(0, parts[0] === "codex" ? 3 : 2).join("/") : null;
    const header = `${parts[0]}/`;
    if (!seenDirGroups.has(header)) {
      seenDirGroups.add(header);
      lines.push(header);
    }
    if (groupKey !== null) {
      if (seenDirGroups.has(groupKey)) continue;
      seenDirGroups.add(groupKey);
      const members = plan.entries.filter((candidate) => candidate.path.startsWith(`${groupKey}/`));
      const bytes = members.reduce((sum, member) => sum + member.content.length, 0);
      const label = `${groupKey.split("/").pop() ?? groupKey}/`;
      lines.push(pad(label, `${members.length} files, ${formatBytes(bytes)}`, "  "));
    } else {
      const rest = parts.slice(1).join("/");
      lines.push(pad(rest, annotate(entry.path, entry.content), "  "));
    }
  }
  lines.push(pad("manifest.json", "hashes for every file above", ""));
  // The manifest's MCP entries leave the machine too (names and sanitized
  // URLs, never secrets), so the accounting names them — the drawing's
  // "mcp servers recorded by name" line, restored.
  const mcpNames = plan.manifest.mcpServers.map((server) => server.name);
  lines.push("");
  lines.push(
    `hooks: ${hooks.length > 0 ? hooks.join(", ") : "none"} | plugins: ${plugins.length > 0 ? plugins.join(", ") : "none"}`,
  );
  lines.push(
    `mcp servers recorded by name: ${mcpNames.length > 0 ? mcpNames.join(", ") : "none"} | ${excludedCount} excluded item${excludedCount === 1 ? "" : "s"} stayed behind`,
  );
  return lines;
}

function writeDestination(destPath: string, dest: string, plan: ExportPlan): void {
  const manifestBytes = Buffer.from(`${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");
  if (dest.endsWith(".tgz")) writeFileSync(destPath, gzipSync(buildTar(plan, manifestBytes), { level: 9 }));
  else if (dest.endsWith(".tar")) writeFileSync(destPath, buildTar(plan, manifestBytes));
  else writeBundleDirectory(destPath, plan, manifestBytes);
}

function formatBytes(total: number): string {
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${Math.round(total / 1024)} KB`;
  return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ApplySelections {
  source: string;
  target?: string;
  hooks: string[];
  plugins: string[];
  mcp: string[];
}

export function applyFlagEcho(selections: ApplySelections): string {
  const parts = ["agent-sync", "apply", quote(selections.source)];
  if (selections.target !== undefined) parts.push("--target", quote(selections.target));
  for (const hook of [...selections.hooks].sort()) parts.push("--hook", quote(hook));
  for (const plugin of [...selections.plugins].sort()) parts.push("--plugin", quote(plugin));
  for (const server of [...selections.mcp].sort()) parts.push("--mcp", quote(server));
  return parts.join(" ");
}

export interface GuidedApplyOverrides {
  targetDir?: string;
  explicitTarget?: boolean;
  roots?: AgentRoots;
  screen?: Screen;
  plain?: Plain;
  env?: Record<string, string | undefined>;
  register?: (registration: McpRegistration) => void;
}

// Frame 4: plan first, consent second, writes last. The flow only collects
// answers; the writes run through the identical gate → plan → execute path
// the flags use, so it structurally cannot half-apply.
export async function runGuidedApply(
  io: CommandIo,
  mode: GuidedMode,
  bundle: LoadedBundle,
  source: string,
  overrides: GuidedApplyOverrides = {},
): Promise<ExitCode> {
  const roots = overrides.roots ?? defaultAgentRoots(overrides.targetDir);
  assertPortableSettings(bundle);

  const ui = mode === "picker" ? pickerUi(overrides) : plainUi(io, overrides);
  try {
    ui.intro("agent-sync apply", `${source} → ${roots.claude}`, []);

    // Preview per agent root, pre-consent: bundle-relative paths keep their
    // namespaces, so a codex line is self-identifying; each non-claude root
    // is named once.
    const previewSlices = splitBundleByRoot(bundle, roots);
    const previewLines: string[] = [
      `Bundle verified · ${bundle.manifest.files.length} files, every hash checked, nothing written yet`,
    ];
    let unchangedTotal = 0;
    for (const slice of previewSlices) {
      if (slice.agent !== "claude-code") previewLines.push(`${slice.agent} → ${slice.root}`);
      const preview = planApply(slice.bundle, slice.root);
      for (const action of preview.actions) {
        if (action.kind === "unchanged") {
          unchangedTotal += 1;
          continue;
        }
        const consentNote = action.path === "settings.json" ? " · final content follows your answers below" : "";
        previewLines.push(
          action.kind === "update"
            ? `update  ${action.path} (backed up first · undo restores it)${consentNote}`
            : `create  ${action.path}${consentNote}`,
        );
      }
    }
    if (unchangedTotal > 0) previewLines.push(`${unchangedTotal} unchanged`);
    ui.note(previewLines);

    const settings =
      bundle.files.has("settings.json")
        ? (JSON.parse(bundle.files.get("settings.json")!.content.toString("utf8")) as Record<string, JsonValue>)
        : {};

    const confirmedHooks: string[] = [];
    const hookNames: { name: string; command: string | null }[] = [];
    if ("statusLine" in settings) {
      hookNames.push({ name: "settings.statusLine", command: commandSummary([settings.statusLine ?? null]) });
    }
    const bundleHooks = settings.hooks;
    if (bundleHooks !== null && bundleHooks !== undefined && typeof bundleHooks === "object" && !Array.isArray(bundleHooks)) {
      for (const event of Object.keys(bundleHooks).sort()) {
        hookNames.push({ name: `hooks.${event}`, command: commandSummary([bundleHooks[event] ?? null]) });
      }
    }
    for (const hook of hookNames) {
      const consent = await ui.confirm(
        `Run ${hook.name} on this machine?${hook.command !== null ? ` (${hook.command})` : ""}`,
        false,
      );
      if (consent === null) return 2;
      if (consent) confirmedHooks.push(hook.name);
    }

    const confirmedPlugins: string[] = [];
    const enabledPlugins = settings.enabledPlugins;
    if (enabledPlugins !== null && enabledPlugins !== undefined && typeof enabledPlugins === "object" && !Array.isArray(enabledPlugins)) {
      for (const name of Object.keys(enabledPlugins).sort()) {
        const consent = await ui.confirm(`Enable plugin ${name} (installs marketplace code)?`, false);
        if (consent === null) return 2;
        if (consent) confirmedPlugins.push(name);
      }
    }

    const requestedMcp: string[] = [];
    const stdioConsents: { name: string; command: string; envNames: string[] }[] = [];
    for (const server of bundle.manifest.mcpServers) {
      if (server.transport === "stdio" && typeof server.command === "string") {
        // Validation precedes display: a string that has not passed the
        // portability-and-hygiene gate must never reach a frame, so a
        // hostile manifest cannot forge or steer the consent screen. The
        // block is wrapped across full lines with no elision — what you
        // read is the complete command, because this display IS the
        // security boundary.
        const validated = assertPortableStdioServer(server.name, server);
        const commandLine = [validated.command, ...validated.args].join(" ");
        ui.note([
          `mcp server ${server.name} wants to register on this machine:`,
          // Width follows the live terminal: the note prefix costs 3 cells,
          // fit() truncates at columns-1, and continuation lines indent 4, so
          // columns-8 keeps every wrapped character on screen even at 80.
          ...wrapDisplay(`  command: ${commandLine}`, Math.max(20, ui.width() - 8)),
          validated.envNames.length > 0
            ? `  env (values asked next, never carried): ${validated.envNames.join(", ")}`
            : "  env: none",
        ]);
        const consent = await ui.confirm(`Register MCP server ${server.name}?`, false);
        if (consent === null) return 2;
        if (consent) {
          requestedMcp.push(server.name);
          stdioConsents.push({ name: server.name, command: validated.command, envNames: validated.envNames });
        }
        continue;
      }
      if (server.status !== "candidate" || server.url === undefined) continue;
      let registration: McpRegistration | undefined;
      try {
        registration = planMcpRegistrations([server], [server.name])[0];
      } catch {
        continue;
      }
      if (registration === undefined) continue;
      const consent = await ui.confirm(
        `Register MCP server ${server.name}? (claude ${registration.args.join(" ")})`,
        false,
      );
      if (consent === null) return 2;
      if (consent) requestedMcp.push(server.name);
    }

    // Secrets are typed fresh on this machine, after consent and before any
    // write; they live only in this map on their way into the argv.
    const secretValues = new Map<string, string>();
    for (const consent of stdioConsents) {
      for (const envName of consent.envNames) {
        const value = await ui.secret(`${consent.name} needs ${envName}`);
        if (value === null) return 2;
        secretValues.set(`${consent.name}\u0000${envName}`, value);
      }
      if (!commandOnPath(consent.command)) {
        ui.note([`note: ${consent.command} is not on this machine's PATH yet; the registration still lands.`]);
      }
    }

    // Assemble done; from here it is exactly the flag path. The split runs
    // AFTER the gates because gating rewrites settings.json in the bundle,
    // and every root is planned before the first root writes.
    gateSettingsHooks(bundle, confirmedHooks);
    gateSettingsPlugins(bundle, confirmedPlugins);
    const registrations = planMcpRegistrations(bundle.manifest.mcpServers, requestedMcp, (serverName, envName) =>
      secretValues.get(`${serverName}\u0000${envName}`),
    );
    const slices = splitBundleByRoot(bundle, roots);
    const planned = slices.map((slice) => ({ slice, plan: planApply(slice.bundle, slice.root) }));
    let creates = 0;
    let updates = 0;
    for (const { plan } of planned) {
      creates += plan.actions.filter((action) => action.kind === "create").length;
      updates += plan.actions.filter((action) => action.kind === "update").length;
    }
    const appliedRoots: string[] = [];
    for (const { slice, plan } of planned) {
      try {
        executeApply(slice.bundle, slice.root, plan);
      } catch (error) {
        if (appliedRoots.length > 0) {
          io.err(
            `apply: already applied to ${appliedRoots.join(", ")} before this failure; run \`agent-sync undo\` to revert them.`,
          );
        }
        throw error;
      }
      appliedRoots.push(slice.root);
    }
    const shadowed = planned.find(
      ({ slice }) => slice.bundle.files.has("opencode.json") && existsSync(join(slice.root, "opencode.jsonc")),
    );
    if (shadowed !== undefined) {
      ui.note([
        `Note: ${shadowed.slice.root} also has opencode.jsonc, which OpenCode may read instead of the applied opencode.json.`,
      ]);
    }

    const register = overrides.register ?? runMcpRegistration;
    let failedRegistrations = 0;
    const registered: string[] = [];
    for (const registration of registrations) {
      try {
        register(registration);
        registered.push(registration.name);
      } catch (error) {
        failedRegistrations += 1;
        io.err(`apply: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const selections: ApplySelections = {
      source,
      hooks: confirmedHooks,
      plugins: confirmedPlugins,
      mcp: requestedMcp,
    };
    if (overrides.explicitTarget === true) selections.target = roots.claude;
    ui.outro(
      creates + updates === 0
        ? "Nothing to change; the bundle is already applied."
        : `Done · ${creates} created, ${updates} updated${registered.length > 0 ? `, ${registered.length} MCP registered` : ""}`,
      `Same run, scripted: ${applyFlagEcho(selections)}`,
      "agent-sync undo puts it all back.",
    );
    return failedRegistrations > 0 ? 2 : 0;
  } finally {
    ui.close();
  }
}

// Both modes speak the same verbs; null means the user cancelled.
interface GuidedUi {
  intro(title: string, subtitle: string, facts: { name: string; summary: string }[]): void;
  note(lines: string[]): void;
  groupMultiselect(message: string, groups: MultiGroup<string>[], coach?: string): Promise<string[] | null>;
  select(message: string, items: typeof DESTINATIONS): Promise<string | null>;
  confirm(message: string, initial?: boolean): Promise<boolean | null>;
  secret(message: string): Promise<string | null>;
  width(): number;
  review(lines: string[], dest: string): Promise<"pack" | "skip" | "dest" | null>;
  outro(...lines: string[]): void;
  close(): void;
}

function pickerUi(overrides: GuidedOverrides & { wordmark?: boolean }): GuidedUi {
  const theme = createTheme(overrides.env === undefined ? {} : { env: overrides.env });
  const screen = overrides.screen ?? new Screen({ ellipsis: theme.glyphs.ellipsis });
  const flow: Flow = createFlow(screen, theme);
  const g = theme.glyphs;
  const bar = theme.paint("accent", g.bar);
  let open = false;
  // Prose from the flow layer spells separators as the unicode mid-dot; the
  // UI owns rendering, so it swaps in the theme separator (ascii "-").
  const fmt = (text: string): string => text.replaceAll("\u00b7", g.sep);
  return {
    intro(title, subtitle, facts) {
      if (overrides.wordmark === true) {
        screen.open();
        open = true;
        screen.commit(["", ...wordmarkLines(theme, screen.columns), theme.paint("dim", fmt(subtitle)), ""]);
        flow.intro(title);
      } else {
        flow.intro(title, subtitle);
        open = true;
      }
      if (facts.length > 0) {
        flow.note(facts.map((fact) => `${fact.name.padEnd(13)} ${theme.paint("dim", fmt(fact.summary))}`));
      }
    },
    note(lines) {
      flow.note(lines);
    },
    async groupMultiselect(message, groups, coach) {
      const options: { coach?: string } = {};
      if (coach !== undefined) options.coach = fmt(coach);
      const result = await flow.groupMultiselect(message, groups, options);
      if (result.cancelled) open = false;
      return result.cancelled ? null : result.value;
    },
    async select(message, items) {
      const result = await flow.select(message, items);
      if (result.cancelled) open = false;
      return result.cancelled ? null : result.value;
    },
    async confirm(message, initial = true) {
      const result = await flow.confirm(message, initial);
      if (result.cancelled) open = false;
      return result.cancelled ? null : result.value;
    },
    async secret(message) {
      const result = await flow.secret(message);
      if (result.cancelled) open = false;
      return result.cancelled ? null : result.value;
    },
    width() {
      return screen.columns;
    },
    // The review screen: the bundle tree, then "Pack it?" with the
    // destination as a named default. y packs, n leaves, d changes the
    // destination, esc cancels. The picker still owns no writes.
    async review(lines, dest) {
      const message = "This is what leaves the machine";
      for (;;) {
        const fitted = fitReviewLines(lines, Math.max(4, screen.rows - 6));
        screen.renderLive([
          `${theme.paint("accent", g.stepActive)}  ${theme.paint("bright", message)}`,
          bar,
          ...fitted.map((line) => `${bar}  ${line.length > 0 ? line : ""}`),
          bar,
          `${bar}  ${theme.paint("bright", "Pack it?")}  ${theme.paint("ok", dest)}  ${theme.paint("dim", "(y / n / d changes destination)")}`,
          `${theme.paint("accent", g.railEnd)}  ${theme.paint("dim", ["y pack", "d destination", "esc cancel"].join(` ${g.sep} `))}`,
        ]);
        const key = await screen.waitKey();
        if (key.name === "cancel" || key.name === "escape") {
          screen.commit([
            `${theme.paint("bad", g.stepError)}  ${theme.paint("strike", message)}`,
            `${theme.paint("accent", g.railEnd)}  ${theme.paint("bright", "Cancelled. Nothing was written.")}`,
          ]);
          screen.close();
          open = false;
          return null;
        }
        const lower = key.char?.toLowerCase();
        if (lower === "y" || key.name === "return" || key.name === "enter") {
          screen.clearLive();
          screen.commit([
            `${theme.paint("ok", g.stepDone)}  ${message} ${theme.paint("dim", `${g.sep} ${dest}`)}`,
            bar,
          ]);
          return "pack";
        }
        if (lower === "n") {
          screen.clearLive();
          screen.commit([`${theme.paint("ok", g.stepDone)}  ${message} ${theme.paint("dim", `${g.sep} not packed`)}`, bar]);
          return "skip";
        }
        if (lower === "d") {
          screen.clearLive();
          return "dest";
        }
      }
    },
    outro(...lines) {
      // Lines print in order; the last one lands on the rail end, so the
      // teaching lines close the transcript.
      if (lines.length > 1) flow.note(lines.slice(0, -1));
      flow.outro(lines[lines.length - 1] ?? "");
      open = false;
    },
    close() {
      // Cancel and outro already closed the screen through the flow.
      if (open) screen.close();
    },
  };
}

function plainUi(io: CommandIo, overrides: GuidedOverrides): GuidedUi {
  const plain = overrides.plain ?? new Plain();
  const fmt = (text: string): string => text.replaceAll("\u00b7", "-");
  return {
    intro(title, subtitle, facts) {
      plain.say(`${title} - ${fmt(subtitle)} (plain mode)`);
      for (const fact of facts) plain.say(`${fact.name.padEnd(13)} ${fmt(fact.summary)}`);
      plain.say("");
    },
    note(lines) {
      for (const line of lines) plain.say(line);
    },
    async groupMultiselect(message, groups, coach) {
      if (coach !== undefined) plain.say(fmt(coach));
      const result = await plain.groupMultiselect(message, groups);
      if (result.cancelled) io.err("Cancelled. Nothing was written.");
      return result.cancelled ? null : result.value;
    },
    async select(message, items) {
      const result = await plain.select(message, items);
      if (result.cancelled) io.err("Cancelled. Nothing was written.");
      return result.cancelled ? null : result.value;
    },
    async confirm(message, initial = true) {
      const result = await plain.confirm(message, initial);
      if (result.cancelled) io.err("Cancelled. Nothing was written.");
      return result.cancelled ? null : result.value;
    },
    async secret(message) {
      const result = await plain.secret(message);
      if (result.cancelled) {
        io.err("Cancelled. Nothing was written.");
        return null;
      }
      return result.value;
    },
    width() {
      // Plain mode never truncates, so wrapping is cosmetic there.
      return 4096;
    },
    // Plain mode reads the same tree and answers one y/N; changing the
    // destination in plain mode is the scripted flags' job, which the echo
    // teaches on pack and on skip alike.
    async review(lines, dest) {
      plain.say("This is what leaves the machine:");
      for (const line of lines) plain.say(line);
      const result = await plain.confirm(`Pack to ${dest}?`, true);
      if (result.cancelled) {
        io.err("Cancelled. Nothing was written.");
        return null;
      }
      return result.value ? "pack" : "skip";
    },
    outro(...lines) {
      for (const line of lines) plain.say(line);
    },
    close() {
      // The long-lived readline interface holds stdin open; without this the
      // process never exits after the last answer.
      plain.close();
    },
  };
}
