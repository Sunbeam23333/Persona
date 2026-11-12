#!/usr/bin/env node
// Read-only workbench preflight: PATH/file presence, not authentication or live connectivity.
// No discovered executable is invoked, including wrappers named codex, agent, dsh or go.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MIN_NODE = "22.19.0";
const TOOLS = [
  { id: "go", label: "Go toolchain", commands: ["go"], suggestion: "Install the Go version required by server/go.mod before building Persona." },
  { id: "postgres", label: "PostgreSQL server executable", commands: ["postgres"], suggestion: "Install PostgreSQL or use an explicitly configured database deployment. No database is created by this check." },
  { id: "psql", label: "PostgreSQL client", commands: ["psql"], suggestion: "Install psql for database administration if needed. A client alone does not prove a server exists." },
  { id: "docker", label: "Docker CLI", commands: ["docker"], suggestion: "Install Docker only if you choose a container-based deployment. Its presence does not prove the daemon is running." },
  { id: "personad", label: "Persona daemon", commands: ["personad"], suggestion: "Build server/cmd/personad or install the repository's Persona release, then configure it explicitly." },
  { id: "persona-node", label: "Persona node", commands: ["persona-node"], suggestion: "Build server/cmd/persona-node or use personad node after configuring the hub connection." },
  { id: "claude", label: "Claude Code CLI", commands: ["claude"], suggestion: "Install the official Claude Code CLI and complete its own authentication flow if you choose this runtime." },
  { id: "codex", label: "Codex command candidate", commands: ["codex"], suggestion: "Install or verify the official OpenAI Codex CLI with app-server support. A command named codex may be a different wrapper.", verification: "unverified: presence is not proof of the official Codex app-server; this check never executes the command" },
  { id: "cursor", label: "Cursor agent command candidate", commands: ["agent", "cursor-agent"], suggestion: "Install the official Cursor CLI with ACP support, then authenticate through Cursor if you choose this runtime.", verification: "unverified: a command named agent may be unrelated; verify the official Cursor CLI and ACP support" },
  { id: "t3", label: "T3 Code CLI", commands: ["t3"], suggestion: "Install the official T3 Code CLI and matching server; add a project before starting integrations/t3." },
  { id: "dsh", label: "DeepSeek Harness CLI", commands: ["dsh"], suggestion: "Install DeepSeek Harness and configure dsh web plus the Persona runtime plugin. Super-agent setup is separate." },
  { id: "orca", label: "Orca command or desktop app", commands: ["orca"], suggestion: "Install Orca if you choose its worktree host; enable its runtime bridge explicitly. An app alone is not a connection." },
];

export function versionAtLeast(version, minimum = MIN_NODE) {
  const parse = (input) => /^(\d+)\.(\d+)\.(\d+)$/.exec(input)?.slice(1).map(Number);
  const actual = parse(version), wanted = parse(minimum);
  if (!actual || !wanted) return false;
  for (let i = 0; i < 3; i++) if (actual[i] !== wanted[i]) return actual[i] > wanted[i];
  return true;
}

/** Injectable filesystem/environment boundary: tests need no installed tools, shell or user configuration. */
export function detector({ platform = process.platform, searchPath = process.env.PATH ?? "", extensions = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", home = homedir(), probeAccess = access, probeStat = stat } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const dirs = searchPath.split(paths.delimiter).filter(Boolean);
  const suffixes = platform === "win32" ? [...new Set(extensions.split(";").filter((s) => /^\.[a-z0-9]+$/i.test(s)).map((s) => s.toLowerCase()))] : [""];
  const exists = async (candidate, directory = false) => {
    try {
      await probeAccess(candidate, directory || platform === "win32" ? constants.F_OK : constants.X_OK);
      const info = await probeStat(candidate);
      return directory ? info.isDirectory() : info.isFile();
    } catch { return false; }
  };
  return {
    async command(name) {
      for (const dir of dirs) for (const ext of suffixes) {
        const candidate = paths.resolve(dir, name + ext);
        if (await exists(candidate)) return candidate;
      }
      return null;
    },
    async orcaApp() {
      if (platform !== "darwin") return null;
      for (const candidate of ["/Applications/Orca.app", paths.join(home, "Applications", "Orca.app")]) {
        if (await exists(candidate, true)) return candidate;
      }
      return null;
    },
  };
}

export async function inspect({ detect = detector(), nodeVersion = process.versions.node, nodeExecutable = process.execPath } = {}) {
  const checks = [{
    id: "node", label: "Node.js running this check", installed: true, path: nodeExecutable, version: nodeVersion,
    supported: versionAtLeast(nodeVersion), minimum: MIN_NODE,
    suggestion: `Run this check and the runtime bridges with Node.js ${MIN_NODE} or newer.`,
  }];
  for (const tool of TOOLS) {
    let found = null;
    for (const name of tool.commands) { found = await detect.command(name); if (found) break; }
    if (!found && tool.id === "orca") found = await detect.orcaApp();
    checks.push({ id: tool.id, label: tool.label, installed: found !== null, path: found, version: "not_checked", suggestion: tool.suggestion,
      ...(tool.verification ? { verification: tool.verification } : {}) });
  }
  const installed = (id) => checks.find((c) => c.id === id)?.installed === true;
  const core = [
    { id: "node", available: checks[0].supported, requirement: `Node.js >= ${MIN_NODE}` },
    { id: "go", available: installed("go"), requirement: "Go command present; verify its version against server/go.mod separately" },
    { id: "database-candidate", available: installed("postgres") || installed("docker"), requirement: "Local PostgreSQL server executable or Docker CLI present; remote-only database setups may intentionally fail this local-source preflight" },
  ];
  return {
    schema: "persona.workbench.doctor.v1", scope: "local-source-development-preflight", checks, core,
    missingCore: core.filter((c) => !c.available).map((c) => c.id),
    authenticated: "not_checked", connected: "not_checked",
    limitations: [
      "Installed does not mean authenticated, running, compatible, or connected.",
      "Only Node's current version is known. Other command names and app bundles are unverified installation candidates.",
      "No subprocess, login, installation, service start, network request, token/config read, or session scan is performed.",
      "Strict mode checks only local source-development prerequisites, not production readiness. Optional agents are not required.",
    ],
  };
}

export function formatReport(report) {
  const lines = ["Persona workbench preflight (read-only)", "Installed != authenticated != connected", ""];
  for (const item of report.checks) {
    lines.push(`${item.installed ? "FOUND" : "MISSING"} ${item.label}${item.path ? `: ${item.path}` : ""}${item.id === "node" ? ` (${item.version}; needs >= ${item.minimum})` : ""}`);
    if (!item.installed || item.supported === false || item.verification) lines.push(`  ${item.verification ?? item.suggestion}`);
  }
  lines.push("", `Core local-source prerequisites: ${report.missingCore.length ? `missing ${report.missingCore.join(", ")}` : "installation candidates found"}.`, ...report.limitations.map((s) => `- ${s}`));
  return lines.join("\n");
}

export async function main(args, { inspectTools = inspect, output = console.log, error = console.error } = {}) {
  if (args.some((a) => !["--json", "--strict", "--help", "-h"].includes(a))) {
    error("Usage: node scripts/workbench/doctor.mjs [--json] [--strict]"); return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    output("Usage: node scripts/workbench/doctor.mjs [--json] [--strict]\nRead-only installation candidates. Exit 0 means the check completed; --strict exits 1 for missing local-source core prerequisites. No authentication or connectivity is checked."); return 0;
  }
  const report = await inspectTools();
  output(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  return args.includes("--strict") && report.missingCore.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => { console.error("Preflight could not complete."); process.exitCode = 2; });
}
