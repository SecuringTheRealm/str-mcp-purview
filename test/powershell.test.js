import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

// The bridge is Windows-only by default (Connect-IPPSSession platform gate);
// tests exercise the protocol itself, so opt out of the gate.
process.env.PURVIEW_ALLOW_UNSUPPORTED_OS = "1";

// Fake child process that mimics the pieces of a pwsh child the bridge relies
// on: a writable stdin we can inspect, and stdout/stderr event emitters we
// drive manually to simulate the framed @@PVW_<id>_START/END@@ protocol.
// Frame markers are unique per request, so responses derive them from the
// most recently written script.
// Mimics Readable.setEncoding: once set, Buffer chunks are decoded across
// chunk boundaries, so a split multibyte character arrives whole.
class FakeStdout extends EventEmitter {
  setEncoding(encoding) {
    this.decoder = new StringDecoder(encoding);
  }
  emit(event, chunk) {
    if (event === "data" && this.decoder && Buffer.isBuffer(chunk)) chunk = this.decoder.write(chunk);
    return super.emit(event, chunk);
  }
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStdout();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.killed = false;
    this.stdin = {
      setDefaultEncoding() {},
      on() {},
      write: (chunk) => {
        this.writes.push(chunk);
      },
    };
  }

  kill() {
    this.killed = true;
    this.emit("exit");
  }

  /** Extract the frame markers of the Nth written script (default: latest). */
  markers(index = this.writes.length - 1) {
    const m = this.writes[index].match(/@@PVW_[0-9a-f-]+_START@@/);
    assert.ok(m, "expected a frame START marker in the written script");
    const start = m[0];
    return { start, end: start.replace("_START@@", "_END@@") };
  }

  respondOk(payload) {
    const { start, end } = this.markers();
    const json = payload === undefined ? "null" : JSON.stringify(payload);
    this.stdout.emit("data", `${start}\n__OK__\n${json}\n${end}\n`);
  }

  respondErr(message) {
    const { start, end } = this.markers();
    this.stdout.emit("data", `${start}\n__ERR__\n${message}\n${end}\n`);
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

// Route spawn() to fresh fakes; returns every child spawned, oldest first.
function useFakes() {
  const procs = [];
  spawnImpl = () => {
    lastProc = new FakeChildProcess();
    procs.push(lastProc);
    return lastProc;
  };
  return procs;
}

/** Run fn with env vars set (undefined deletes), restoring the old values after. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v) => { for (const [k, x] of Object.entries(v)) x === undefined ? delete process.env[k] : (process.env[k] = x); };
  apply(vars);
  try { return await fn(); } finally { apply(saved); }
}

// Build a minimal unsigned JWT carrying a upn claim, so orgFromToken can derive
// the tenant org domain in token-injection mode.
function fakeJwt(upn) {
  const part = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${part({ alg: "none" })}.${part({ upn })}.sig`;
}

let tokenImpl = async () => fakeJwt("admin@contoso.onmicrosoft.com");
mock.module("../src/auth.js", {
  namedExports: {
    getToken: (...args) => tokenImpl(...args),
  },
});

// Each test below imports powershell.js with a unique query string so it gets
// its own module instance (and therefore its own fresh PowerShellBridge
// singleton with no connection state), since the bridge keeps state at module
// scope and there is no public reset API.
async function freshBridge(tag) {
  const mod = await import(`../src/powershell.js?${tag}`);
  return mod.powershell;
}

const b64 = (params) => Buffer.from(JSON.stringify(params), "utf8").toString("base64");

/** Let the bridge write its connect script, answer it, then let the cmdlet be written. */
async function connected(proc) {
  await tick();
  (proc ?? lastProc).respondOk("connected");
  await tick();
}

function tick() {
  return new Promise((r) => setImmediate(r));
}

test("PowerShellBridge.invoke", async (t) => {
  await t.test("connects the IPPSSession once, then invokes the cmdlet and parses JSON", async () => {
    const bridge = await freshBridge("connect-and-invoke");
    useFakes();

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {}, ["Name"]);
    // Let the bridge spawn the process and write the Connect-IPPSSession script.
    await tick();
    lastProc.respondOk("connected");
    // Let the connect response resolve and the next script (the cmdlet) be written.
    await tick();
    lastProc.respondOk([{ Name: "Policy1" }]);

    const result = await invokePromise;
    assert.deepEqual(result, [{ Name: "Policy1" }]);

    const scripts = lastProc.writes.join("");
    assert.match(scripts, /Connect-IPPSSession/);
    // The child never signs in itself: it has no console, so both WAM and the
    // -DisableWAM browser fallback would hang. It gets a Node-acquired token.
    assert.match(scripts, /Connect-IPPSSession -AccessToken/);
    assert.match(scripts, /Import-Module ExchangeOnlineManagement -MinimumVersion 3\.8\.0/);
    assert.match(scripts, /Parameters.ContainsKey\('AccessToken'\)/);
    assert.doesNotMatch(scripts, /-DisableWAM/);
    assert.match(scripts, /Get-DlpCompliancePolicy @__p \| Select-Object Name/);
  });

  await t.test("rejects with the PowerShell error message on __ERR__", async () => {
    const bridge = await freshBridge("err-response");
    useFakes();

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await connected();
    lastProc.respondErr("Something went wrong");

    await assert.rejects(() => invokePromise, /Something went wrong/);
  });

  await t.test("passes an empty splat and no Select-Object clause when no props are given", async () => {
    const bridge = await freshBridge("no-select-props");
    useFakes();

    const invokePromise = bridge.invoke("Get-DlpComplianceRule");
    await connected();
    lastProc.respondOk([]);
    await invokePromise;

    const scripts = lastProc.writes.join("");
    assert.match(scripts, /Get-DlpComplianceRule @__p\n/);
    assert.doesNotMatch(scripts, /Select-Object/);
  });

  await t.test("uses certificate app-only auth when the PURVIEW_APP_* env vars are set", () =>
    withEnv({ PURVIEW_APP_ID: "app-id-123", PURVIEW_ORGANIZATION: "contoso.onmicrosoft.com", PURVIEW_CERT_THUMBPRINT: "ABCDEF" }, async () => {
      const bridge = await freshBridge("app-only");
      useFakes();

      const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
      await connected();
      lastProc.respondOk([]);
      await invokePromise;

      const scripts = lastProc.writes.join("");
      assert.match(scripts, /Connect-IPPSSession -AppId 'app-id-123' -CertificateThumbprint 'ABCDEF' -Organization 'contoso\.onmicrosoft\.com'/);
      assert.doesNotMatch(scripts, /-DisableWAM/);
    }));

  await t.test("ignores a stale frame from a previous request (unique per-request markers)", async () => {
    const bridge = await freshBridge("stale-frame");
    useFakes();

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await connected();

    // A stale frame using the CONNECT request's markers must not settle the
    // in-flight cmdlet request...
    const stale = lastProc.markers(0);
    lastProc.stdout.emit("data", `${stale.start}\n__OK__\n["stale"]\n${stale.end}\n`);
    // ...only a frame with the cmdlet's own markers does.
    lastProc.respondOk([{ Name: "Fresh" }]);

    assert.deepEqual(await invokePromise, [{ Name: "Fresh" }]);
  });

  await t.test("kills the pwsh child on timeout so the next call reconnects cleanly", () =>
    withEnv({ PURVIEW_EXEC_TIMEOUT_MS: "40", PURVIEW_CONNECT_TIMEOUT_MS: "40" }, async () => {
      const bridge = await freshBridge("timeout-kill");
      const procs = useFakes();

      // Never respond: the connect request times out and must kill the child.
      await assert.rejects(() => bridge.invoke("Get-DlpCompliancePolicy", {}), /timed out .* session was reset/s);
      assert.equal(procs[0].killed, true);

      // The next call spawns a fresh child and re-runs Connect-IPPSSession.
      const retry = bridge.invoke("Get-DlpCompliancePolicy", {});
      await tick();
      assert.equal(procs.length, 2);
      assert.match(procs[1].writes.join(""), /Connect-IPPSSession/);
      procs[1].respondOk("connected");
      await tick();
      procs[1].respondOk([]);
      assert.deepEqual(await retry, []);
    }));

  await t.test("reconnects immediately after a command timeout even when the old child exits later", () =>
    withEnv({ PURVIEW_EXEC_TIMEOUT_MS: "80" }, async () => {
      const bridge = await freshBridge("timeout-delayed-exit");
      const procs = [];
      spawnImpl = () => {
        const child = new FakeChildProcess();
        child.kill = () => { child.killed = true; }; // Real kill does not emit exit synchronously.
        procs.push(child);
        return child;
      };
      const first = bridge.invoke("Set-DlpComplianceRule", { Identity: "R1", Disabled: true });
      const rejected = assert.rejects(first, /timed out .* session was reset/s);
      await tick();
      procs[0].respondOk("connected");
      await rejected;
      assert.equal(procs[0].killed, true);
      assert.equal(bridge.proc, null);

      const next = bridge.invoke("Get-DlpComplianceRule", { Identity: "R1" });
      await tick();
      assert.equal(procs.length, 2);
      assert.match(procs[1].writes.join(""), /Connect-IPPSSession/);
      procs[0].emit("exit");
      procs[0].emit("error", new Error("late error from retired child"));
      assert.equal(bridge.proc, procs[1], "Retired child events must not clear the new connection");
      procs[1].respondOk("connected");
      await tick();
      procs[1].respondOk({ Name: "R1", Disabled: false });
      assert.deepEqual(await next, { Name: "R1", Disabled: false });
      const again = bridge.invoke("Get-DlpComplianceRule", { Identity: "R1" });
      await tick();
      procs[1].respondOk({ Name: "R1" });
      await again;
      assert.equal(procs.length, 2);
      assert.equal(procs[1].writes.filter(s => s.includes("Connect-IPPSSession -")).length, 1);
      assert.equal(procs[0].writes.length, 2, "Timed-out mutation must not be retried");
    }));

  await t.test("a command queued behind a timeout reconnects instead of running on an unconnected child", () =>
    withEnv({ PURVIEW_EXEC_TIMEOUT_MS: "40" }, async () => {
      const bridge = await freshBridge("queued-behind-timeout");
      const procs = useFakes();
      const warm = bridge.invoke("Get-Label", {});
      await connected(procs[0]);
      procs[0].respondOk([]);
      await warm;

      // A hangs and times out; B is already past the connect check, queued behind it.
      const a = bridge.invoke("Set-DlpComplianceRule", { Identity: "R1" });
      const b = bridge.invoke("Get-DlpComplianceRule", { Identity: "R1" });
      const c = bridge.invoke("Get-DlpComplianceRule", { Identity: "R2" });
      await assert.rejects(a, /timed out/);
      await tick();
      assert.equal(procs.length, 2);
      assert.match(procs[1].writes[0], /Connect-IPPSSession/, "B must reconnect before it runs");
      procs[1].respondOk("connected");
      await tick();
      assert.ok(procs[1].writes[1].includes(b64({ Identity: "R1" })));
      procs[1].respondOk({ Name: "R1" });
      await tick();
      assert.ok(procs[1].writes[2].includes(b64({ Identity: "R2" })));
      procs[1].respondOk({ Name: "R2" });
      assert.deepEqual(await b, { Name: "R1" });
      assert.deepEqual(await c, { Name: "R2" });
      assert.equal(procs[1].writes.filter((w) => w.includes("Connect-IPPSSession -")).length, 1, "queued callers share one reconnect");
      assert.equal(procs[0].writes.filter((w) => w.includes("Set-DlpComplianceRule")).length, 1, "A is not retried");
    }));

  await t.test("refuses new commands at once when too many are already waiting", () =>
    withEnv({ PURVIEW_EXEC_TIMEOUT_MS: "40", PURVIEW_CONNECT_TIMEOUT_MS: "40" }, async () => {
      const bridge = await freshBridge("queue-limit");
      useFakes();
      const warm = bridge.invoke("Get-Label", {});
      await connected();
      lastProc.respondOk([]);
      await warm;
      // One running plus three waiting is the limit; the fifth is refused unsent.
      const held = [1, 2, 3, 4].map((n) => bridge.invoke("Get-Label", { Identity: `L${n}` }).catch(() => {}));
      await tick();
      const writes = lastProc.writes.length;
      await assert.rejects(bridge.invoke("Set-Label", { Identity: "L5" }), /busy with 4 commands\. Nothing was sent/);
      assert.equal(lastProc.writes.length, writes);
      await Promise.all(held);
    }));

  await t.test("decodes a multibyte character split across stdout chunks", async () => {
    const bridge = await freshBridge("utf8-split");
    useFakes();
    const p = bridge.invoke("Get-Label", {});
    await connected();
    const { start, end } = lastProc.markers();
    const frame = Buffer.from(`${start}\n__OK__\n{"Name":"Confidentiel – Société"}\n${end}\n`, "utf8");
    const cut = frame.indexOf(Buffer.from("é", "utf8")) + 1; // inside the two-byte é
    lastProc.stdout.emit("data", frame.subarray(0, cut));
    lastProc.stdout.emit("data", frame.subarray(cut));
    assert.deepEqual(await p, { Name: "Confidentiel – Société" });
  });

  await t.test("rejects the in-flight request promptly when the pwsh process dies", async () => {
    const bridge = await freshBridge("proc-death");
    useFakes();

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await tick();
    lastProc.emit("exit");

    await assert.rejects(() => invokePromise, /exited before responding/);
  });

  await t.test("concurrent first calls share a single Connect-IPPSSession", async () => {
    const bridge = await freshBridge("connect-dedup");
    useFakes();

    const a = bridge.invoke("Get-DlpCompliancePolicy", {});
    const b = bridge.invoke("Get-DlpComplianceRule", {});
    await connected();
    lastProc.respondOk([]);
    await tick();
    lastProc.respondOk([]);
    await Promise.all([a, b]);

    const connects = lastProc.writes.join("").match(/^Connect-IPPSSession -/gm);
    assert.equal(connects.length, 1);
  });

  await t.test("fails fast on non-Windows platforms unless overridden", () =>
    withEnv({ PURVIEW_ALLOW_UNSUPPORTED_OS: undefined }, async () => {
      if (process.platform === "win32") return; // gate only applies off-Windows
      const bridge = await freshBridge("platform-gate");
      await assert.rejects(() => bridge.invoke("Get-DlpCompliancePolicy", {}), /only supports.*on Windows/s);
    }));

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

    // spawn() returns a ChildProcess even for a missing executable and reports
    // the failure later via 'error'. The in-flight request must fail on that
    // event with a clear message, not wait out its timeout.
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      setImmediate(() => lastProc.emit("error", new Error("spawn pwsh ENOENT")));
      return lastProc;
    };

    await assert.rejects(
      () => bridge.invoke("Get-DlpCompliancePolicy", {}),
      /could not be started \(spawn pwsh ENOENT\)/
    );
  });
});

test("simulation connection is isolated and includes the search-only switch on the connect command", () =>
  withEnv({ PURVIEW_DLP_AUTH_MODE: "token" }, async () => {
    tokenImpl = async () => fakeJwt("admin@contoso.onmicrosoft.com");
    const bridge = await freshBridge("simulation-isolated");
    const children = [];
    spawnImpl = () => { const child = new FakeChildProcess(); children.push(child); lastProc = child; return child; };
    const simulation = bridge.invokeSimulation("Set-AutoSensitivityLabelPolicy", { Identity: "policy", StartSimulation: true });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.match(children[0].writes[0], /Connect-IPPSSession -AccessToken[^\n]* -EnableSearchOnlySession/);
    assert.match(children[0].writes[0], /Parameters.ContainsKey\('EnableSearchOnlySession'\)/);
    children[0].respondOk("connected"); await new Promise(r => setImmediate(r));
    children[0].respondOk(null); await simulation;
    const regular = bridge.invoke("Get-Label", {});
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.equal(children.length, 2);
    assert.doesNotMatch(children[1].writes[0], /EnableSearchOnlySession/);
    children[1].respondOk("connected"); await new Promise(r => setImmediate(r));
    children[1].respondOk([]); await regular;
  }));

test("PowerShellBridge token-injection connect", async (t) => {
  await t.test("connects with an injected access token and org derived from the token", () =>
    withEnv({ PURVIEW_DLP_AUTH_MODE: "token" }, async () => {
      tokenImpl = async () => fakeJwt("admin@contoso.onmicrosoft.com");
      const bridge = await freshBridge("token-connect");
      useFakes();

      const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {}, ["Name"]);
      await new Promise((r) => setImmediate(r)); // token acquired + connect script written
      await new Promise((r) => setImmediate(r));
      lastProc.respondOk("connected");
      await new Promise((r) => setImmediate(r));
      lastProc.respondOk([{ Name: "P1" }]);
      assert.deepEqual(await invokePromise, [{ Name: "P1" }]);

      const scripts = lastProc.writes.join("");
      // The connect passes the token via -AccessToken, never an interactive sign-in.
      assert.match(scripts, /Connect-IPPSSession -AccessToken \$__c\.token -Organization \$__c\.org/);
      assert.doesNotMatch(scripts, /-DisableWAM/);
      // The token + org travel as a base64 JSON blob, not raw in the script text.
      const b64 = scripts.match(/FromBase64String\('([^']+)'\)[^\n]*ConvertFrom-Json\b/)[1];
      const blob = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      assert.equal(blob.org, "contoso.onmicrosoft.com");
      assert.match(blob.token, /^[\w-]+\.[\w-]+\.\w+$/);
    }));

  await t.test("errors when no org can be determined", () =>
    withEnv({ PURVIEW_DLP_AUTH_MODE: "token", PURVIEW_ORGANIZATION: undefined }, async () => {
      tokenImpl = async () => fakeJwt("no-at-sign-here"); // no domain to derive
      try {
        const bridge = await freshBridge("token-no-org");
        useFakes();
        await assert.rejects(() => bridge.invoke("Get-DlpCompliancePolicy", {}), /PURVIEW_ORGANIZATION/);
      } finally {
        tokenImpl = async () => fakeJwt("admin@contoso.onmicrosoft.com");
      }
    }));
});

test("PowerShellBridge auth-expiry retry", async (t) => {
  await t.test("reconnects and retries once when the cmdlet reports an expired token", async () => {
    const bridge = await freshBridge("auth-retry");
    useFakes();

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await connected();
    // The injected token lapsed: the cmdlet rejects the call.
    lastProc.respondErr("The access token has expired.");
    await tick();
    // The bridge must reconnect (minting a fresh token) and re-run the cmdlet.
    lastProc.respondOk("connected");
    await tick();
    lastProc.respondOk([{ Name: "P1" }]);

    assert.deepEqual(await invokePromise, [{ Name: "P1" }]);
    const connects = lastProc.writes.join("").match(/^Connect-IPPSSession -/gm);
    assert.equal(connects.length, 2);
  });

  await t.test("two callers that both hit an expired token share one reconnect", async () => {
    const bridge = await freshBridge("auth-retry-shared");
    useFakes();
    const a = bridge.invoke("Get-DlpCompliancePolicy", { Identity: "A" });
    const b = bridge.invoke("Get-DlpCompliancePolicy", { Identity: "B" });
    await connected();
    lastProc.respondErr("The access token has expired."); // A
    await tick();
    lastProc.respondErr("The access token has expired."); // B
    await tick();
    lastProc.respondOk("connected");
    await tick();
    lastProc.respondOk({ Name: "A" });
    await tick();
    lastProc.respondOk({ Name: "B" });
    assert.deepEqual([await a, await b], [{ Name: "A" }, { Name: "B" }]);
    assert.equal(lastProc.writes.join("").match(/^Connect-IPPSSession -/gm).length, 2, "initial connect plus one shared reconnect");
  });

  await t.test("retries a READ when the module chokes on a non-JSON error page", async () => {
    // What a rejected token actually looks like in practice: the endpoint
    // answers with HTML and the module's JSON reader fails on it. Observed
    // verbatim against ExchangeOnlineManagement 3.10.0. The message names no
    // cause, so it is only safe to re-run for a read.
    const bridge = await freshBridge("opaque-retry-read");
    useFakes();

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await connected();
    lastProc.respondErr("Unexpected character encountered while parsing value: <. Path '', line 0, position 0.");
    await connected();
    lastProc.respondOk([{ Name: "P1" }]);

    assert.deepEqual(await invokePromise, [{ Name: "P1" }]);
    assert.equal(lastProc.writes.join("").match(/^Connect-IPPSSession -/gm).length, 2);
  });

  await t.test("does NOT retry a WRITE on that same opaque failure", async () => {
    // No evidence the cmdlet failed to reach the service, so re-running it
    // risks creating the rule twice. Surface the error instead.
    const bridge = await freshBridge("opaque-no-retry-write");
    useFakes();

    const invokePromise = bridge.invoke("New-DlpComplianceRule", { Name: "R1" });
    await connected();
    lastProc.respondErr("Unexpected character encountered while parsing value: <. Path '', line 0, position 0.");

    await assert.rejects(invokePromise, /Unexpected character/);
    assert.equal(lastProc.writes.join("").match(/^Connect-IPPSSession -/gm).length, 1);
  });

  await t.test("does NOT retry a timed-out cmdlet, which may already have applied", () =>
    withEnv({ PURVIEW_EXEC_TIMEOUT_MS: "40" }, async () => {
      // The bridge's own timeout message contains the word "session", which a
      // loose auth-expiry matcher would read as a stale session and retry — and
      // re-running a New-/Set- cmdlet that already ran inside the child would
      // double-write. Bridge-raised errors must never trigger the retry.
      const bridge = await freshBridge("no-retry-on-timeout");
      const procs = useFakes();

      const invokePromise = bridge.invoke("New-DlpComplianceRule", { Name: "R1" });
      await connected(procs[0]);
      // Never respond to the cmdlet: it times out, and the agent is told it may have applied.
      await assert.rejects(() => invokePromise, /timed out.*may already have applied/s);

      // Exactly one New-DlpComplianceRule was ever written — no silent re-run.
      const writes = procs.map((p) => p.writes.join("")).join("");
      assert.equal(writes.match(/New-DlpComplianceRule/g).length, 1);
    }));
});
