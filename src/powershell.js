// Security & Compliance PowerShell bridge.
//
// DLP policy/rule CRUD is not available through Microsoft Graph; it lives only
// in the Security & Compliance PowerShell cmdlets (Get/New/Set-DlpCompliance*).
// Those cmdlets require a live IPPSSession, and Connect-IPPSSession performs an
// interactive sign-in. Spawning a fresh pwsh per call would re-authenticate
// every time, so we keep ONE long-lived pwsh child process: connect once, then
// stream subsequent cmdlets into the same session.
//
// Protocol: each request is wrapped so the child emits a framed block
//   @@PVW_START@@ / status line / payload / @@PVW_END@@
// which we parse back on stdout. Requests are serialised through a promise
// queue so framed blocks never interleave. Cmdlet parameters are passed as a
// base64-encoded JSON blob and rebuilt with ConvertFrom-Json -AsHashtable,
// which keeps model-supplied values out of the executable script text
// (no command injection).

import { spawn } from "node:child_process";

const START = "@@PVW_START@@";
const END = "@@PVW_END@@";
const EXEC_TIMEOUT_MS = Number(process.env.PURVIEW_EXEC_TIMEOUT_MS) || 60_000;
// The first Connect-IPPSSession opens a browser and blocks on a human sign-in,
// so it needs a far larger budget than a normal cmdlet's EXEC_TIMEOUT_MS.
const CONNECT_TIMEOUT_MS = Number(process.env.PURVIEW_CONNECT_TIMEOUT_MS) || 300_000;

class PowerShellBridge {
  constructor() {
    this.proc = null;
    this.queue = Promise.resolve();
    this.connected = false;
  }

  #ensureProc() {
    if (this.proc) return;
    const exe = process.env.PURVIEW_PWSH || "pwsh";
    this.proc = spawn(exe, ["-NoLogo", "-NoProfile", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdin.setDefaultEncoding("utf8");
    this.proc.stderr.on("data", (d) => {
      // pwsh diagnostics (and the interactive-login URL) go to the operator via
      // stderr; they must never reach the MCP stdio channel on stdout.
      process.stderr.write(`[pwsh] ${d}`);
    });
    this.proc.on("exit", () => {
      this.proc = null;
      this.connected = false;
    });
    this.proc.on("error", (err) => {
      process.stderr.write(`[pwsh] failed to start '${exe}': ${err.message}\n`);
      this.proc = null;
    });
  }

  // Serialise every request so their framed output blocks cannot interleave.
  #enqueue(script, timeoutMs = EXEC_TIMEOUT_MS) {
    const run = this.queue.then(() => this.#exec(script, timeoutMs));
    // Keep the chain alive even if a call rejects.
    this.queue = run.catch(() => {});
    return run;
  }

  #exec(script, timeoutMs = EXEC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      this.#ensureProc();
      // Capture the process reference now: it can flip to null (via the
      // 'exit'/'error' handlers in #ensureProc) while this request is still
      // in flight, and we must keep using the same stdout stream we attached
      // onData to rather than re-reading the (possibly now-null) this.proc.
      const proc = this.proc;
      if (!proc) {
        reject(new Error("PowerShell (pwsh) is not available. Install PowerShell 7+ or set PURVIEW_PWSH."));
        return;
      }

      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.stdout.off("data", onData);
        reject(new Error(`PowerShell command timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      const onData = (chunk) => {
        buffer += chunk.toString();
        const s = buffer.indexOf(START);
        const e = buffer.indexOf(END);
        if (s === -1 || e === -1 || e < s) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout.off("data", onData);

        const block = buffer.slice(s + START.length, e).trim();
        const nl = block.indexOf("\n");
        const status = (nl === -1 ? block : block.slice(0, nl)).trim();
        const body = nl === -1 ? "" : block.slice(nl + 1).trim();

        if (status === "__OK__") {
          if (!body || body === "null") return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body); // non-JSON payload (e.g. a status string)
          }
        } else {
          reject(new Error(body || "PowerShell command failed."));
        }
      };
      proc.stdout.on("data", onData);

      const wrapped = [
        "try {",
        "  $ErrorActionPreference = 'Stop'",
        `  $__out = & {`,
        script,
        "  }",
        "  $__json = $__out | ConvertTo-Json -Depth 8 -Compress",
        `  [Console]::Out.WriteLine('${START}')`,
        "  [Console]::Out.WriteLine('__OK__')",
        "  if ($null -ne $__json) { [Console]::Out.WriteLine($__json) } else { [Console]::Out.WriteLine('null') }",
        `  [Console]::Out.WriteLine('${END}')`,
        "} catch {",
        `  [Console]::Out.WriteLine('${START}')`,
        "  [Console]::Out.WriteLine('__ERR__')",
        "  [Console]::Out.WriteLine($_.Exception.Message)",
        `  [Console]::Out.WriteLine('${END}')`,
        "}",
        "",
      ].join("\n");

      proc.stdin.write(wrapped);
    });
  }

  /** Connect the IPPSSession on first use. Triggers an interactive sign-in. */
  async #ensureConnected() {
    if (this.connected) return;
    const upn = process.env.PURVIEW_UPN;
    // ExchangeOnlineManagement 3.7+ defaults to the WAM broker, which needs an
    // interactive window handle. This server runs pwsh as a windowless child
    // (piped stdio), so WAM fails instantly with "A window handle must be
    // configured." -DisableWAM falls back to the MSAL system-browser flow,
    // which works from a headless child (external browser + localhost redirect).
    // Set PURVIEW_ENABLE_WAM=1 to opt back in on an interactive host.
    const noWam = process.env.PURVIEW_ENABLE_WAM === "1" ? "" : " -DisableWAM";
    const connect = upn
      ? `Connect-IPPSSession -UserPrincipalName '${upn.replace(/'/g, "''")}'${noWam} -ShowBanner:$false`
      : `Connect-IPPSSession${noWam} -ShowBanner:$false`;
    const script = [
      "if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {",
      "  throw 'The ExchangeOnlineManagement module is not installed. Run: Install-Module ExchangeOnlineManagement -Scope CurrentUser'",
      "}",
      "Import-Module ExchangeOnlineManagement -ErrorAction Stop",
      `${connect}`,
      "'connected'",
    ].join("\n");
    // The connect blocks on an interactive browser sign-in, so give it the
    // longer connect budget rather than the per-cmdlet timeout.
    await this.#enqueue(script, CONNECT_TIMEOUT_MS);
    this.connected = true;
  }

  /**
   * Invoke a Security & Compliance cmdlet with a parameter object.
   * @param {string} cmdlet  e.g. "Get-DlpCompliancePolicy"
   * @param {object} [params]  Splatted parameters; values may be nested arrays/objects.
   * @param {string[]} [selectProps]  If given, pipe through Select-Object to trim output.
   */
  async invoke(cmdlet, params = {}, selectProps = null) {
    await this.#ensureConnected();
    const b64 = Buffer.from(JSON.stringify(params ?? {}), "utf8").toString("base64");
    const select = selectProps?.length ? ` | Select-Object ${selectProps.join(",")}` : "";
    const script = [
      `$__p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json -AsHashtable`,
      "if ($null -eq $__p) { $__p = @{} }",
      `${cmdlet} @__p${select}`,
    ].join("\n");
    return this.#enqueue(script);
  }
}

export const powershell = new PowerShellBridge();
