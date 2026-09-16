import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandDef, ExitCode } from "../main.js";
import { loadBundleFromBuffer, loadBundleFromDirectory, type LoadedBundle } from "../apply/bundle.js";
import {
  assertPortableSettings,
  defaultAgentRoots,
  executeApply,
  gateSettingsHooks,
  gateSettingsPlugins,
  planApply,
  splitBundleByRoot,
} from "../apply/apply.js";
import { planMcpRegistrations, runMcpRegistration } from "../apply/mcp.js";
import { stringList } from "./export.js";
import { chooseEntry, runGuidedApply } from "./guided.js";

const HELP = [
  "Usage: agent-sync apply <bundle> [flags]",
  "",
  "Unpack a bundle into the target directory. Every file is verified against",
  "its manifest hash before anything is written, and what gets overwritten is",
  "backed up first so `agent-sync undo` can put it back.",
  "bundle is a directory, a .tar or .tgz file, or - for a tar stream on stdin.",
  "",
  "Hooks and statusLine in a bundle run shell commands, and an enabled plugin",
  "installs marketplace code, so each applies only when re-confirmed here with",
  "--hook or --plugin, mirroring the confirmation export required.",
  "",
  "Flags:",
  "  --target <dir>   Directory to apply into (default: ~/.claude, honoring CLAUDE_CONFIG_DIR)",
  "  --hook <name>    Re-confirm one hook from the bundle (repeatable), e.g. --hook hooks.PostToolUse",
  "  --plugin <name>  Re-confirm one plugin reference from the bundle (repeatable)",
  "  --mcp <name>     Register one portable MCP server via `claude mcp add` (repeatable, name + URL only)",
  "  --dry-run        Print what would change and write nothing",
  "  --plain          Guided apply with plain sequential prompts (no cursor UI)",
  "  --no-input       Never prompt; use the static flag surface",
  "  --help           Show help",
  "",
  "Run `agent-sync apply <bundle>` bare in a terminal for the guided apply:",
  "verified plan first, per-hook and per-plugin consent, MCP registration",
  "showing the exact command, writes last.",
].join("\n");

export const applyCommand: CommandDef = {
  word: "apply",
  summary: "Apply a bundle to this machine, with backup and verification",
  help: HELP,
  flags: {
    target: { type: "string", description: "Directory to apply into" },
    hook: { type: "string", description: "Re-confirm one hook from the bundle (repeatable)", multiple: true },
    plugin: { type: "string", description: "Re-confirm one plugin reference from the bundle (repeatable)", multiple: true },
    mcp: { type: "string", description: "Register one portable MCP server from the manifest (repeatable)", multiple: true },
    "dry-run": { type: "boolean", description: "Print what would change and write nothing" },
    plain: { type: "boolean", description: "Guided apply with plain sequential prompts (no cursor UI)" },
    "no-input": { type: "boolean", description: "Never prompt; use the static flag surface" },
  },
  async run({ positionals, values, io }): Promise<ExitCode> {
    const source = positionals[0];
    if (source === undefined || positionals.length > 1) {
      io.err("apply: exactly one bundle expected (directory, .tar, .tgz, or -).");
      return 2;
    }
    const confirmedHooks = stringList(values.hook);
    const confirmedPlugins = stringList(values.plugin);
    const requestedMcp = stringList(values.mcp);
    const dryRun = values["dry-run"] === true;

    // Any consent or mode flag keeps the exact static surface; only a bare
    // `apply <bundle>` on TTYs outside CI goes interactive (frame 4). A "-"
    // source is always static: stdin IS the bundle, so there is nothing left
    // to read consent from.
    const anyStaticFlag =
      confirmedHooks.length > 0 ||
      confirmedPlugins.length > 0 ||
      requestedMcp.length > 0 ||
      dryRun ||
      source === "-";
    const mode = anyStaticFlag
      ? "static"
      : chooseEntry({
          help: false,
          version: false,
          plain: values.plain === true,
          noInput: values["no-input"] === true,
          stdinTTY: process.stdin.isTTY === true,
          stdoutTTY: process.stdout.isTTY === true,
          env: process.env,
        });
    if (mode !== "static") {
      const interactiveBundle = await loadBundle(source);
      const overrides: Parameters<typeof runGuidedApply>[4] =
        typeof values.target === "string" ? { targetDir: values.target, explicitTarget: true } : {};
      return runGuidedApply(io, mode, interactiveBundle, source, overrides);
    }

    const bundle = await loadBundle(source);
    // The allowlist runs before either consent gate: an unknown settings key
    // refuses the whole bundle before any withheld/kept decision is made.
    assertPortableSettings(bundle);
    const withheld = gateSettingsHooks(bundle, confirmedHooks);
    for (const name of withheld) {
      io.out(`Withheld ${name}: hooks run shell commands, so re-confirm with --hook ${name} to apply it.`);
    }
    const withheldPlugins = gateSettingsPlugins(bundle, confirmedPlugins);
    for (const name of withheldPlugins) {
      io.out(`Withheld plugin ${name}: enabling installs marketplace code, so re-confirm with --plugin ${name} to apply it.`);
    }
    // Registrations are validated before any file write so a bad --mcp refuses
    // the whole apply, not half of it.
    const registrations = planMcpRegistrations(bundle.manifest.mcpServers, requestedMcp);

    // A bundle may span several agents; each agent root gets its own plan,
    // marker and backups, and every root is planned (write-checked) before
    // the first root writes, so a hostile layout in ANY root refuses all.
    const roots = defaultAgentRoots(typeof values.target === "string" ? values.target : undefined);
    const slices = splitBundleByRoot(bundle, roots);
    const planned = slices.map((slice) => ({ slice, plan: planApply(slice.bundle, slice.root) }));

    let totalCreated = 0;
    let totalUpdated = 0;
    const appliedRoots: string[] = [];
    for (const { slice, plan } of planned) {
      const creates = plan.actions.filter((action) => action.kind === "create");
      const updates = plan.actions.filter((action) => action.kind === "update");

      if (plan.previousMarker !== null && plan.addedSinceLast.length > 0) {
        io.out(`${plan.addedSinceLast.length} new since last apply: ${plan.addedSinceLast.join(", ")}`);
      }

      if (creates.length === 0 && updates.length === 0) {
        io.out(`Nothing to change in ${slice.root}; already applied.`);
        continue;
      }
      io.out(`${dryRun ? "Would apply" : "Applying"} to ${slice.root}:`);
      for (const action of plan.actions) {
        if (action.kind !== "unchanged") io.out(`  ${action.kind.padEnd(7)} ${action.path}`);
      }
      if (!dryRun) {
        // Every root was planned (and write-checked) up front, so hostility
        // refuses everything before any root writes. A runtime I/O failure
        // between roots can still leave earlier roots applied; each has its
        // own marker, so the recovery is one `undo` — and the failure says so
        // instead of pretending nothing happened.
        let marker;
        try {
          marker = executeApply(slice.bundle, slice.root, plan);
        } catch (error) {
          if (appliedRoots.length > 0) {
            io.err(
              `apply: already applied to ${appliedRoots.join(", ")} before this failure; run \`agent-sync undo\` to revert them.`,
            );
          }
          throw error;
        }
        appliedRoots.push(slice.root);
        if (marker !== null && marker.updated.length > 0) {
          io.out(`Backed up ${marker.updated.length} overwritten file(s); \`agent-sync undo\` restores them.`);
        }
        totalCreated += creates.length;
        totalUpdated += updates.length;
        if (slice.bundle.files.has("opencode.json") && existsSync(join(slice.root, "opencode.jsonc"))) {
          io.out(
            `Note: ${slice.root} also has opencode.jsonc, which OpenCode may read instead of the applied opencode.json.`,
          );
        }
      }
    }
    if (!dryRun && (totalCreated > 0 || totalUpdated > 0)) {
      io.out(`Done: ${totalCreated} created, ${totalUpdated} updated.`);
    }

    let failedRegistrations = 0;
    for (const registration of registrations) {
      if (dryRun) {
        io.out(`Would register MCP server ${registration.name}: claude ${registration.args.join(" ")}`);
        continue;
      }
      try {
        runMcpRegistration(registration);
        io.out(`Registered MCP server ${registration.name} (user scope). \`agent-sync undo\` does not remove it; use \`claude mcp remove ${registration.name}\`.`);
      } catch (error) {
        failedRegistrations += 1;
        io.err(`apply: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const unregistered = bundle.manifest.mcpServers.filter(
      (server) => server.status === "candidate" && server.url !== undefined && !requestedMcp.includes(server.name),
    );
    if (unregistered.length > 0) {
      io.out(
        `Bundle records ${unregistered.length} portable MCP server(s) not registered; pass --mcp <name> to register: ${unregistered.map((server) => server.name).join(", ")}`,
      );
    }
    if (failedRegistrations > 0) {
      io.err(`apply: ${failedRegistrations} MCP registration(s) failed; files were applied and stay applied.`);
      return 2;
    }
    return 0;
  },
};

async function loadBundle(source: string): Promise<LoadedBundle> {
  if (source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return loadBundleFromBuffer(Buffer.concat(chunks));
  }
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (stat === undefined) throw new Error(`${source} does not exist.`);
  if (stat.isDirectory()) return loadBundleFromDirectory(source);
  return loadBundleFromBuffer(readFileSync(source));
}
