// Smoke tests that drive a REAL pwsh child process.
//
// Every other bridge test mocks node:child_process, which makes them blind to
// the one thing that matters most: whether PowerShell actually accepts and runs
// what the bridge sends it. Two real defects hid behind that mock —
//   * the framed block was terminated with a single newline, and
//     `pwsh -Command -` never flushes a multi-line block without a blank line,
//     so every request hung until its timeout;
//   * the connect script assigned $Global:IsWindows, which is read-only, so the
//     connect died before Connect-IPPSSession ran.
// Both produced a green suite. These tests exist so they cannot come back.
//
// Skipped when pwsh is unavailable, so non-PowerShell dev boxes still pass.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const PWSH = process.env.PURVIEW_PWSH || "pwsh";
const havePwsh = (() => {
  try {
    return spawnSync(PWSH, ["-NoLogo", "-NoProfile", "-Command", "exit 0"]).status === 0;
  } catch {
    return false;
  }
})();

// The bridge is Windows-only by default; these tests never reach the platform
// gate, but connectScript() is built through the same module.
process.env.PURVIEW_ALLOW_UNSUPPORTED_OS = "1";

function fakeJwt(upn) {
  const part = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${part({ alg: "none" })}.${part({ upn })}.sig`;
}

mock.module("../src/auth.js", {
  namedExports: { getToken: async () => fakeJwt("admin@contoso.onmicrosoft.com") },
});

const { wrapScript, powershell } = await import("../src/powershell.js");

/**
 * Send one framed script to a real pwsh over piped stdin and read the response.
 * Deliberately never closes stdin: the bridge keeps the child alive across
 * calls, so a script that only runs at EOF is a broken script.
 */
function runReal(script, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(PWSH, ["-NoLogo", "-NoProfile", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.setDefaultEncoding("utf8");
    proc.stdin.on("error", () => {});

    const id = randomUUID();
    const START = `@@PVW_${id}_START@@`;
    const END = `@@PVW_${id}_END@@`;
    let buffer = "";
    const done = (value) => {
      clearTimeout(timer);
      proc.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done({ status: "TIMEOUT", body: buffer }), timeoutMs);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const s = buffer.indexOf(START);
      const e = buffer.indexOf(END);
      if (s === -1 || e === -1 || e < s) return;
      const block = buffer.slice(s + START.length, e).trim();
      const nl = block.indexOf("\n");
      done({
        status: (nl === -1 ? block : block.slice(0, nl)).trim(),
        body: nl === -1 ? "" : block.slice(nl + 1).trim(),
      });
    });

    proc.stdin.write(wrapScript(script, START, END));
  });
}

// Bounded explicitly: the failure mode these tests guard against IS a hang, so
// without a ceiling a regression stalls CI instead of reporting.
const SUITE = { skip: havePwsh ? false : "pwsh not available", timeout: 90_000 };

test("real pwsh: framed protocol", SUITE, async (t) => {
  await t.test("executes and answers without stdin being closed", async () => {
    const res = await runReal("'hello'");
    // A TIMEOUT here means pwsh is still holding the block in its parser —
    // almost certainly the terminating blank line in wrapScript() was lost.
    assert.equal(res.status, "__OK__", `expected a framed reply, got ${res.status}: ${res.body}`);
    assert.equal(res.body, '"hello"');
  });

  await t.test("reports cmdlet failures as __ERR__ rather than hanging", async () => {
    const res = await runReal("throw 'boom'");
    assert.equal(res.status, "__ERR__");
    assert.match(res.body, /boom/);
  });
});

test("real pwsh: connect script", SUITE, async (t) => {
  await t.test("PowerShell accepts every line of the token-mode connect script", async () => {
    const connect = await powershell.connectScript();
    assert.match(connect, /Connect-IPPSSession -AccessToken/);

    // Shadow the three commands that would reach the network or need the
    // ExchangeOnlineManagement module, so this runs anywhere pwsh does. In
    // PowerShell, functions take precedence over cmdlets. Everything else —
    // including any line that PowerShell itself rejects — runs for real.
    const stubs = [
      "function Get-Module { 'stubbed-module' }",
      "function Import-Module { }",
      "function Connect-IPPSSession { }",
    ].join("\n");

    const res = await runReal(`${stubs}\n${connect}`);
    // __ERR__ here means a line of the connect script is invalid PowerShell.
    // "Cannot overwrite variable IsWindows" is the known regression.
    assert.equal(res.status, "__OK__", `connect script rejected by pwsh: ${res.body}`);
    assert.match(res.body, /connected/);
  });

  await t.test("does not assign the read-only $IsWindows automatic variable", async () => {
    const connect = await powershell.connectScript();
    assert.doesNotMatch(connect, /\$(Global:)?IsWindows\s*=/);
  });
});
