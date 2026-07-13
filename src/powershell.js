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
//   @@PVW_<id>_START@@ / status line / payload / @@PVW_<id>_END@@
// which we parse back on stdout. The <id> is unique per request, so a frame
// from a timed-out earlier command can never be mis-read as the current
// response, and payload data containing a marker string cannot spoof a frame.
// Requests are serialised through a promise queue so blocks never interleave.
// Cmdlet parameters are passed as a base64-encoded JSON blob and rebuilt with
// ConvertFrom-Json -AsHashtable, which keeps model-supplied values out of the
// executable script text (no command injection).
//
// PLATFORM: Microsoft supports Connect-IPPSSession (Security & Compliance
// PowerShell) on Windows only — not in PowerShell 7 on macOS or Linux. See
// README "Platform support". The gate below fails fast with a clear message
// instead of a confusing sign-in error; PURVIEW_ALLOW_UNSUPPORTED_OS=1 skips
// it for anyone whose module version proves otherwise.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const EXEC_TIMEOUT_MS = Number(process.env.PURVIEW_EXEC_TIMEOUT_MS) || 60_000;
// The first Connect-IPPSSession opens a browser and blocks on a human sign-in,
// so it needs a far larger budget than a normal cmdlet's EXEC_TIMEOUT_MS.
const CONNECT_TIMEOUT_MS = Number(process.env.PURVIEW_CONNECT_TIMEOUT_MS) || 300_000;

/** Escape a value for inclusion inside a single-quoted PowerShell string. */
const q = (s) => String(s).replace(/'/g, "''");

const PLATFORM_ERROR =
  "The DLP and label write/read-back tools need Security & Compliance PowerShell " +
  "(Connect-IPPSSession), which Microsoft only supports on Windows — it is not " +
  "available in PowerShell 7 on macOS or Linux. The sensitivity-label read tools " +
  "(Microsoft Graph) still work on this platform. See README → 'Platform support'. " +
  "Set PURVIEW_ALLOW_UNSUPPORTED_OS=1 to attempt the connection anyway.";

class PowerShellBridge {
  constructor() {
    this.proc = null;
    this.queue = Promise.resolve();
    this.connecting = null;
  }

  #ensureProc() {
    if (this.proc) return;
    const exe = process.env.PURVIEW_PWSH || "pwsh";
    this.proc = spawn(exe, ["-NoLogo", "-NoProfile", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdin.setDefaultEncoding("utf8");
    // A write racing a dying child emits 'error' (EPIPE) on stdin; without a
    // listener that is an uncaught exception that kills the whole MCP server.
    this.proc.stdin.on?.("error", (err) => {
      process.stderr.write(`[pwsh] stdin error: ${err.message}\n`);
    });
    this.proc.stderr.on("data", (d) => {
      // pwsh diagnostics (and the interactive-login URL) go to the operator via
      // stderr; they must never reach the MCP stdio channel on stdout.
      process.stderr.write(`[pwsh] ${d}`);
    });
    this.proc.on("exit", () => {
      this.proc = null;
      this.connecting = null;
    });
    this.proc.on("error", (err) => {
      process.stderr.write(`[pwsh] failed to start '${exe}': ${err.message}\n`);
      this.proc = null;
      this.connecting = null;
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
      // in flight, and we must keep using the same streams we attached to.
      const proc = this.proc;
      if (!proc) {
        reject(new Error("PowerShell (pwsh) is not available. Install PowerShell 7+ or set PURVIEW_PWSH."));
        return;
      }

      // Request-scoped frame markers: a stale frame from a previous (timed
      // out) command, or marker-lookalike text inside payload data, can never
      // match this request's markers.
      const id = randomUUID();
      const START = `@@PVW_${id}_START@@`;
      const END = `@@PVW_${id}_END@@`;

      let buffer = "";
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        proc.off("exit", onExit);
        fn(value);
      };
      const timer = setTimeout(() => {
        // Settle before killing: kill() triggers the 'exit' listener, which
        // must not win the race and mask the timeout message.
        settle(reject, new Error(
          `PowerShell command timed out after ${timeoutMs}ms. The PowerShell session was reset; the next call will reconnect.`
        ));
        // The command is still running inside the child and would keep the
        // serialised session wedged for every later request — kill the child
        // so the next call gets a fresh process (and a fresh sign-in).
        proc.kill();
      }, timeoutMs);
      const onExit = () => {
        settle(reject, new Error("The PowerShell process exited before responding. The next call will start a fresh session."));
      };
      const onData = (chunk) => {
        buffer += chunk.toString();
        const s = buffer.indexOf(START);
        const e = buffer.indexOf(END);
        if (s === -1 || e === -1 || e < s) return;

        const block = buffer.slice(s + START.length, e).trim();
        const nl = block.indexOf("\n");
        const status = (nl === -1 ? block : block.slice(0, nl)).trim();
        const body = nl === -1 ? "" : block.slice(nl + 1).trim();

        if (status === "__OK__") {
          if (!body || body === "null") return settle(resolve, null);
          try {
            settle(resolve, JSON.parse(body));
          } catch {
            settle(resolve, body); // non-JSON payload (e.g. a status string)
          }
        } else {
          settle(reject, new Error(body || "PowerShell command failed."));
        }
      };
      proc.stdout.on("data", onData);
      proc.on("exit", onExit);

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

      try {
        proc.stdin.write(wrapped);
      } catch (err) {
        settle(reject, new Error(`Failed to send command to PowerShell: ${err.message}`));
      }
    });
  }

  /**
   * Build the Connect-IPPSSession invocation. Two modes:
   *  - App-only (unattended/hosted): PURVIEW_APP_ID + PURVIEW_ORGANIZATION +
   *    a certificate (PURVIEW_CERT_THUMBPRINT, or PURVIEW_CERT_PATH with
   *    optional PURVIEW_CERT_PASSWORD). No browser, no human.
   *  - Delegated (default): interactive browser sign-in as the operator.
   */
  #connectCommand() {
    const appId = process.env.PURVIEW_APP_ID;
    const org = process.env.PURVIEW_ORGANIZATION;
    const thumbprint = process.env.PURVIEW_CERT_THUMBPRINT;
    const certPath = process.env.PURVIEW_CERT_PATH;
    if (appId && org && (thumbprint || certPath)) {
      const cert = thumbprint
        ? `-CertificateThumbprint '${q(thumbprint)}'`
        : `-CertificateFilePath '${q(certPath)}'` +
          (process.env.PURVIEW_CERT_PASSWORD
            ? ` -CertificatePassword (ConvertTo-SecureString '${q(process.env.PURVIEW_CERT_PASSWORD)}' -AsPlainText -Force)`
            : "");
      return `Connect-IPPSSession -AppId '${q(appId)}' ${cert} -Organization '${q(org)}' -ShowBanner:$false`;
    }

    const upn = process.env.PURVIEW_UPN;
    // ExchangeOnlineManagement 3.7+ defaults to the WAM broker, which needs an
    // interactive window handle. This server runs pwsh as a windowless child
    // (piped stdio), so WAM fails instantly with "A window handle must be
    // configured." -DisableWAM (added in 3.7.2) falls back to the MSAL
    // system-browser flow, which works from a headless child (external browser
    // + localhost redirect). Set PURVIEW_ENABLE_WAM=1 to opt back in on an
    // interactive host.
    const noWam = process.env.PURVIEW_ENABLE_WAM === "1" ? "" : " -DisableWAM";
    return upn
      ? `Connect-IPPSSession -UserPrincipalName '${q(upn)}'${noWam} -ShowBanner:$false`
      : `Connect-IPPSSession${noWam} -ShowBanner:$false`;
  }

  /** Connect the IPPSSession on first use (single-flight, safe under concurrency). */
  #ensureConnected() {
    if (this.connecting) return this.connecting;
    if (process.platform !== "win32" && process.env.PURVIEW_ALLOW_UNSUPPORTED_OS !== "1") {
      return Promise.reject(new Error(PLATFORM_ERROR));
    }
    const script = [
      "if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {",
      "  throw 'The ExchangeOnlineManagement module is not installed. Run: Install-Module ExchangeOnlineManagement -Scope CurrentUser'",
      "}",
      "Import-Module ExchangeOnlineManagement -ErrorAction Stop",
      this.#connectCommand(),
      "'connected'",
    ].join("\n");
    // The delegated connect blocks on an interactive browser sign-in, so give
    // it the longer connect budget rather than the per-cmdlet timeout.
    this.connecting = this.#enqueue(script, CONNECT_TIMEOUT_MS).catch((err) => {
      this.connecting = null; // allow a retry on the next call
      throw err;
    });
    return this.connecting;
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
