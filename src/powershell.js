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
  #enqueue(script) {
    const run = this.queue.then(() => this.#exec(script));
    // Keep the chain alive even if a call rejects.
    this.queue = run.catch(() => {});
    return run;
  }

  #exec(script) {
    return new Promise((resolve, reject) => {
      this.#ensureProc();
      if (!this.proc) {
        reject(new Error("PowerShell (pwsh) is not available. Install PowerShell 7+ or set PURVIEW_PWSH."));
        return;
      }

      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString();
        const s = buffer.indexOf(START);
        const e = buffer.indexOf(END);
        if (s === -1 || e === -1 || e < s) return;
        this.proc.stdout.off("data", onData);

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
      this.proc.stdout.on("data", onData);

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

      this.proc.stdin.write(wrapped);
    });
  }

  /** Connect the IPPSSession on first use. Triggers an interactive sign-in. */
  async #ensureConnected() {
    if (this.connected) return;
    const upn = process.env.PURVIEW_UPN;
    const connect = upn
      ? `Connect-IPPSSession -UserPrincipalName '${upn.replace(/'/g, "''")}' -ShowBanner:$false`
      : "Connect-IPPSSession -ShowBanner:$false";
    const script = [
      "if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {",
      "  throw 'The ExchangeOnlineManagement module is not installed. Run: Install-Module ExchangeOnlineManagement -Scope CurrentUser'",
      "}",
      "Import-Module ExchangeOnlineManagement -ErrorAction Stop",
      "if (-not (Get-Command Get-DlpCompliancePolicy -ErrorAction SilentlyContinue)) {",
      `  ${connect}`,
      "}",
      "'connected'",
    ].join("\n");
    await this.#enqueue(script);
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
