import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { EventEmitter } from "node:events";

// Fake child process that mimics the pieces of a pwsh child the bridge relies
// on: a writable stdin we can inspect, and stdout/stderr event emitters we
// drive manually to simulate the framed @@PVW_START@@/@@PVW_END@@ protocol.
class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.stdin = {
      setDefaultEncoding() {},
      write: (chunk) => {
        this.writes.push(chunk);
      },
    };
  }

  respondOk(payload) {
    const json = payload === undefined ? "null" : JSON.stringify(payload);
    this.stdout.emit("data", `@@PVW_START@@\n__OK__\n${json}\n@@PVW_END@@\n`);
  }

  respondErr(message) {
    this.stdout.emit("data", `@@PVW_START@@\n__ERR__\n${message}\n@@PVW_END@@\n`);
  }
}

let lastProc;
let spawnImpl = () => {
  lastProc = new FakeChildProcess();
  return lastProc;
};

mock.module("node:child_process", {
  namedExports: {
    spawn: (...args) => spawnImpl(...args),
  },
});

// Each test below imports powershell.js with a unique query string so it gets
// its own module instance (and therefore its own fresh PowerShellBridge
// singleton with connected=false), since the bridge keeps connection state at
// module scope and there is no public reset API.
async function freshBridge(tag) {
  const mod = await import(`../src/powershell.js?${tag}`);
  return mod.powershell;
}

test("PowerShellBridge.invoke", async (t) => {
  await t.test("connects the IPPSSession once, then invokes the cmdlet and parses JSON", async () => {
    const bridge = await freshBridge("connect-and-invoke");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {}, ["Name"]);
    // Let the bridge spawn the process and write the Connect-IPPSSession script.
    await new Promise((r) => setImmediate(r));
    lastProc.respondOk("connected");
    // Let the connect response resolve and the next script (the cmdlet) be written.
    await new Promise((r) => setImmediate(r));
    lastProc.respondOk([{ Name: "Policy1" }]);

    const result = await invokePromise;
    assert.deepEqual(result, [{ Name: "Policy1" }]);

    const scripts = lastProc.writes.join("");
    assert.match(scripts, /Connect-IPPSSession/);
    // WAM is disabled by default so the headless pwsh child can use the browser
    // flow instead of the window-handle-dependent broker.
    assert.match(scripts, /-DisableWAM/);
    assert.match(scripts, /Get-DlpCompliancePolicy @__p \| Select-Object Name/);
  });

  await t.test("rejects with the PowerShell error message on __ERR__", async () => {
    const bridge = await freshBridge("err-response");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await new Promise((r) => setImmediate(r));
    lastProc.respondOk("connected");
    await new Promise((r) => setImmediate(r));
    lastProc.respondErr("Something went wrong");

    await assert.rejects(() => invokePromise, /Something went wrong/);
  });

  await t.test("passes an empty splat and no Select-Object clause when no props are given", async () => {
    const bridge = await freshBridge("no-select-props");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const invokePromise = bridge.invoke("Get-DlpComplianceRule");
    await new Promise((r) => setImmediate(r));
    lastProc.respondOk("connected");
    await new Promise((r) => setImmediate(r));
    lastProc.respondOk([]);
    await invokePromise;

    const scripts = lastProc.writes.join("");
    assert.match(scripts, /Get-DlpComplianceRule @__p\n/);
    assert.doesNotMatch(scripts, /Select-Object/);
  });

  await t.test("rejects when the pwsh executable cannot be started", async () => {
    const savedTimeout = process.env.PURVIEW_EXEC_TIMEOUT_MS;
    const savedConnectTimeout = process.env.PURVIEW_CONNECT_TIMEOUT_MS;
    process.env.PURVIEW_EXEC_TIMEOUT_MS = "50";
    // The first in-flight request is the Connect-IPPSSession, which now has its
    // own (much longer) budget; shrink it too or this test waits minutes.
    process.env.PURVIEW_CONNECT_TIMEOUT_MS = "50";
    const bridge = await freshBridge("spawn-error");
    if (savedTimeout == null) delete process.env.PURVIEW_EXEC_TIMEOUT_MS;
    else process.env.PURVIEW_EXEC_TIMEOUT_MS = savedTimeout;
    if (savedConnectTimeout == null) delete process.env.PURVIEW_CONNECT_TIMEOUT_MS;
    else process.env.PURVIEW_CONNECT_TIMEOUT_MS = savedConnectTimeout;

    // spawn() itself always returns a ChildProcess synchronously (even for a
    // missing executable) and reports failure asynchronously via the 'error'
    // event handled in #ensureProc, which only clears this.proc for *future*
    // calls. Exercise that failure surface: the in-flight request still hits
    // its execution timeout since no @@PVW_END@@ frame ever arrives.
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      setImmediate(() => lastProc.emit("error", new Error("spawn pwsh ENOENT")));
      return lastProc;
    };

    await assert.rejects(
      () => bridge.invoke("Get-DlpCompliancePolicy", {}),
      /PowerShell command timed out/
    );
  });
});
