import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { EventEmitter } from "node:events";

// The bridge is Windows-only by default (Connect-IPPSSession platform gate);
// tests exercise the protocol itself, so opt out of the gate.
process.env.PURVIEW_ALLOW_UNSUPPORTED_OS = "1";

// Fake child process that mimics the pieces of a pwsh child the bridge relies
// on: a writable stdin we can inspect, and stdout/stderr event emitters we
// drive manually to simulate the framed @@PVW_<id>_START/END@@ protocol.
// Frame markers are unique per request, so responses derive them from the
// most recently written script.
class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
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

function tick() {
  return new Promise((r) => setImmediate(r));
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
    assert.doesNotMatch(scripts, /-DisableWAM/);
    assert.match(scripts, /Get-DlpCompliancePolicy @__p \| Select-Object Name/);
  });

  await t.test("rejects with the PowerShell error message on __ERR__", async () => {
    const bridge = await freshBridge("err-response");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await tick();
    lastProc.respondOk("connected");
    await tick();
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
    await tick();
    lastProc.respondOk("connected");
    await tick();
    lastProc.respondOk([]);
    await invokePromise;

    const scripts = lastProc.writes.join("");
    assert.match(scripts, /Get-DlpComplianceRule @__p\n/);
    assert.doesNotMatch(scripts, /Select-Object/);
  });

  await t.test("uses certificate app-only auth when the PURVIEW_APP_* env vars are set", async () => {
    process.env.PURVIEW_APP_ID = "app-id-123";
    process.env.PURVIEW_ORGANIZATION = "contoso.onmicrosoft.com";
    process.env.PURVIEW_CERT_THUMBPRINT = "ABCDEF";
    try {
      const bridge = await freshBridge("app-only");
      spawnImpl = () => {
        lastProc = new FakeChildProcess();
        return lastProc;
      };

      const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
      await tick();
      lastProc.respondOk("connected");
      await tick();
      lastProc.respondOk([]);
      await invokePromise;

      const scripts = lastProc.writes.join("");
      assert.match(scripts, /Connect-IPPSSession -AppId 'app-id-123' -CertificateThumbprint 'ABCDEF' -Organization 'contoso\.onmicrosoft\.com'/);
      assert.doesNotMatch(scripts, /-DisableWAM/);
    } finally {
      delete process.env.PURVIEW_APP_ID;
      delete process.env.PURVIEW_ORGANIZATION;
      delete process.env.PURVIEW_CERT_THUMBPRINT;
    }
  });

  await t.test("ignores a stale frame from a previous request (unique per-request markers)", async () => {
    const bridge = await freshBridge("stale-frame");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await tick();
    lastProc.respondOk("connected");
    await tick();

    // A stale frame using the CONNECT request's markers must not settle the
    // in-flight cmdlet request...
    const stale = lastProc.markers(0);
    lastProc.stdout.emit("data", `${stale.start}\n__OK__\n["stale"]\n${stale.end}\n`);
    // ...only a frame with the cmdlet's own markers does.
    lastProc.respondOk([{ Name: "Fresh" }]);

    assert.deepEqual(await invokePromise, [{ Name: "Fresh" }]);
  });

  await t.test("kills the pwsh child on timeout so the next call reconnects cleanly", async () => {
    process.env.PURVIEW_EXEC_TIMEOUT_MS = "40";
    process.env.PURVIEW_CONNECT_TIMEOUT_MS = "40";
    try {
      const bridge = await freshBridge("timeout-kill");
      const procs = [];
      spawnImpl = () => {
        lastProc = new FakeChildProcess();
        procs.push(lastProc);
        return lastProc;
      };

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
    } finally {
      delete process.env.PURVIEW_EXEC_TIMEOUT_MS;
      delete process.env.PURVIEW_CONNECT_TIMEOUT_MS;
    }
  });

  await t.test("rejects the in-flight request promptly when the pwsh process dies", async () => {
    const bridge = await freshBridge("proc-death");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await tick();
    lastProc.emit("exit");

    await assert.rejects(() => invokePromise, /exited before responding/);
  });

  await t.test("concurrent first calls share a single Connect-IPPSSession", async () => {
    const bridge = await freshBridge("connect-dedup");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const a = bridge.invoke("Get-DlpCompliancePolicy", {});
    const b = bridge.invoke("Get-DlpComplianceRule", {});
    await tick();
    lastProc.respondOk("connected");
    await tick();
    lastProc.respondOk([]);
    await tick();
    lastProc.respondOk([]);
    await Promise.all([a, b]);

    const connects = lastProc.writes.join("").match(/Connect-IPPSSession/g);
    assert.equal(connects.length, 1);
  });

  await t.test("fails fast on non-Windows platforms unless overridden", async () => {
    if (process.platform === "win32") return; // gate only applies off-Windows
    delete process.env.PURVIEW_ALLOW_UNSUPPORTED_OS;
    try {
      const bridge = await freshBridge("platform-gate");
      await assert.rejects(() => bridge.invoke("Get-DlpCompliancePolicy", {}), /only supports.*on Windows/s);
    } finally {
      process.env.PURVIEW_ALLOW_UNSUPPORTED_OS = "1";
    }
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
    // event handled in #ensureProc. The 'error' handler clears this.proc; the
    // in-flight request then hits its execution timeout since no frame ever
    // arrives.
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

test("PowerShellBridge token-injection connect", async (t) => {
  await t.test("connects with an injected access token and org derived from the token", async () => {
    const saved = process.env.PURVIEW_DLP_AUTH_MODE;
    process.env.PURVIEW_DLP_AUTH_MODE = "token";
    tokenImpl = async () => fakeJwt("admin@contoso.onmicrosoft.com");
    try {
      const bridge = await freshBridge("token-connect");
      spawnImpl = () => {
        lastProc = new FakeChildProcess();
        return lastProc;
      };

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
    } finally {
      if (saved == null) delete process.env.PURVIEW_DLP_AUTH_MODE;
      else process.env.PURVIEW_DLP_AUTH_MODE = saved;
    }
  });

  await t.test("errors when no org can be determined", async () => {
    const saved = process.env.PURVIEW_DLP_AUTH_MODE;
    const savedOrg = process.env.PURVIEW_ORGANIZATION;
    process.env.PURVIEW_DLP_AUTH_MODE = "token";
    delete process.env.PURVIEW_ORGANIZATION;
    tokenImpl = async () => fakeJwt("no-at-sign-here"); // no domain to derive
    try {
      const bridge = await freshBridge("token-no-org");
      spawnImpl = () => {
        lastProc = new FakeChildProcess();
        return lastProc;
      };
      await assert.rejects(
        () => bridge.invoke("Get-DlpCompliancePolicy", {}),
        /PURVIEW_ORGANIZATION/
      );
    } finally {
      if (saved == null) delete process.env.PURVIEW_DLP_AUTH_MODE;
      else process.env.PURVIEW_DLP_AUTH_MODE = saved;
      if (savedOrg != null) process.env.PURVIEW_ORGANIZATION = savedOrg;
      tokenImpl = async () => fakeJwt("admin@contoso.onmicrosoft.com");
    }
  });
});

test("PowerShellBridge auth-expiry retry", async (t) => {
  await t.test("reconnects and retries once when the cmdlet reports an expired token", async () => {
    const bridge = await freshBridge("auth-retry");
    spawnImpl = () => {
      lastProc = new FakeChildProcess();
      return lastProc;
    };

    const invokePromise = bridge.invoke("Get-DlpCompliancePolicy", {});
    await tick();
    lastProc.respondOk("connected");
    await tick();
    // The injected token lapsed: the cmdlet rejects the call.
    lastProc.respondErr("The access token has expired.");
    await tick();
    // The bridge must reconnect (minting a fresh token) and re-run the cmdlet.
    lastProc.respondOk("connected");
    await tick();
    lastProc.respondOk([{ Name: "P1" }]);

    assert.deepEqual(await invokePromise, [{ Name: "P1" }]);
    const connects = lastProc.writes.join("").match(/Connect-IPPSSession/g);
    assert.equal(connects.length, 2);
  });

  await t.test("does NOT retry a timed-out cmdlet, which may already have applied", async () => {
    // The bridge's own timeout message contains the word "session", which a
    // loose auth-expiry matcher would read as a stale session and retry — and
    // re-running a New-/Set- cmdlet that already ran inside the child would
    // double-write. Bridge-raised errors must never trigger the retry.
    process.env.PURVIEW_EXEC_TIMEOUT_MS = "40";
    try {
      const bridge = await freshBridge("no-retry-on-timeout");
      const procs = [];
      spawnImpl = () => {
        lastProc = new FakeChildProcess();
        procs.push(lastProc);
        return lastProc;
      };

      const invokePromise = bridge.invoke("New-DlpComplianceRule", { Name: "R1" });
      await tick();
      procs[0].respondOk("connected");
      await tick();
      // Never respond to the cmdlet: it times out.
      await assert.rejects(() => invokePromise, /timed out/);

      // Exactly one New-DlpComplianceRule was ever written — no silent re-run.
      const writes = procs.map((p) => p.writes.join("")).join("");
      assert.equal(writes.match(/New-DlpComplianceRule/g).length, 1);
    } finally {
      delete process.env.PURVIEW_EXEC_TIMEOUT_MS;
    }
  });
});
