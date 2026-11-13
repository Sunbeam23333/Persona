import assert from "node:assert/strict";
import test from "node:test";
import { detector, formatReport, inspect, main, versionAtLeast } from "./doctor.mjs";

const fakeDetector = (installed = [], app = null) => ({
  command: async (name) => installed.includes(name) ? `/fixture/bin/${name}` : null,
  orcaApp: async () => app,
});
const fixture = (installed, nodeVersion = "22.22.0", app = null) => inspect({ detect: fakeDetector(installed, app), nodeVersion, nodeExecutable: "/fixture/bin/node" });

test("Node version compares every component and rejects malformed/pre-release values", () => {
  for (const version of ["22.19.0", "22.22.0", "23.0.0", "24.1.2"]) assert.equal(versionAtLeast(version), true, version);
  for (const version of ["20.99.0", "22.18.9", "22.19", "v22.19.0", "22.19.0-rc.1", "unknown"]) assert.equal(versionAtLeast(version), false, version);
});

test("filesystem detector probes only PATH candidates and does not accept directories", async () => {
  const accessed = [];
  const detect = detector({ platform: "linux", searchPath: "/missing:/fixture/bin", home: "/fixture/home",
    probeAccess: async (candidate) => { accessed.push(candidate); if (!candidate.startsWith("/fixture/bin/")) throw new Error("missing"); },
    probeStat: async (candidate) => ({ isFile: () => candidate.endsWith("/codex"), isDirectory: () => !candidate.endsWith("/codex") }),
  });
  assert.equal(await detect.command("codex"), "/fixture/bin/codex");
  assert.equal(await detect.command("directory"), null);
  assert.equal(await detect.orcaApp(), null);
  assert.deepEqual(accessed, ["/missing/codex", "/fixture/bin/codex", "/missing/directory", "/fixture/bin/directory"]);
});

test("empty PATH does not implicitly scan the current directory", async () => {
  const detect = detector({ platform: "linux", searchPath: "", probeAccess: async () => { assert.fail("no filesystem access expected"); } });
  assert.equal(await detect.command("codex"), null);
});

test("Windows command lookup supports script wrappers but never executes them", async () => {
  const seen = [];
  const detect = detector({ platform: "win32", searchPath: "C:\\tools", extensions: ".EXE;.CMD;../invalid", probeAccess: async (candidate) => {
    seen.push(candidate); if (!candidate.endsWith(".cmd")) throw new Error("missing");
  }, probeStat: async () => ({ isFile: () => true }) });
  assert.equal(await detect.command("codex"), "C:\\tools\\codex.cmd");
  assert.deepEqual(seen, ["C:\\tools\\codex.exe", "C:\\tools\\codex.cmd"]);
});

test("macOS probes only conventional app bundle locations", async () => {
  const seen = [];
  const detect = detector({ platform: "darwin", searchPath: "", home: "/fixture/home", probeAccess: async (candidate) => {
    seen.push(candidate); if (!candidate.startsWith("/fixture/home/")) throw new Error("missing");
  }, probeStat: async () => ({ isDirectory: () => true }) });
  assert.equal(await detect.orcaApp(), "/fixture/home/Applications/Orca.app");
  assert.deepEqual(seen, ["/Applications/Orca.app", "/fixture/home/Applications/Orca.app"]);
});

test("all optional tools stay optional and psql does not stand in for a database server", async () => {
  const report = await fixture(["go", "psql"]);
  assert.deepEqual(report.missingCore, ["database-candidate"]);
  assert.equal(report.authenticated, "not_checked"); assert.equal(report.connected, "not_checked");
  assert.ok(report.checks.find((c) => c.id === "claude").suggestion);
  assert.deepEqual((await fixture(["go", "postgres"])).missingCore, []);
  assert.deepEqual((await fixture(["go", "docker"])).missingCore, []);
  assert.deepEqual((await fixture(["go", "docker"], "20.0.0")).missingCore, ["node"]);
});

test("codex and generic agent commands are explicitly unverified candidates", async () => {
  const report = await fixture(["codex", "agent", "t3", "dsh", "personad", "persona-node", "claude"], "22.22.0", "/Applications/Orca.app");
  assert.match(report.checks.find((c) => c.id === "codex").verification, /not proof.*official Codex app-server/);
  assert.match(report.checks.find((c) => c.id === "cursor").verification, /may be unrelated/);
  assert.equal(report.checks.find((c) => c.id === "orca").path, "/Applications/Orca.app");
  assert.match(formatReport(report), /Installed != authenticated != connected/);
});

test("default exit means completion, strict checks core, JSON is parseable, help never probes", async () => {
  const missing = await fixture([]), ready = await fixture(["go", "postgres"]);
  let printed = "";
  const options = { inspectTools: async () => missing, output: (line) => { printed = line; }, error: () => {} };
  assert.equal(await main([], options), 0);
  assert.equal(await main(["--strict", "--json"], options), 1);
  assert.deepEqual(JSON.parse(printed).missingCore, ["go", "database-candidate"]);
  assert.equal(await main(["--strict"], { ...options, inspectTools: async () => ready }), 0);
  assert.equal(await main(["--unknown"], options), 2);
  assert.equal(await main(["--help"], { ...options, inspectTools: async () => { assert.fail("help must not probe"); } }), 0);
});
