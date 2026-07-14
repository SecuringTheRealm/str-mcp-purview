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
//
// AUTH: this bridge spawns pwsh with piped stdio, so the child has no console
// and Connect-IPPSSession's own interactive sign-in cannot complete there —
// WAM fails on the missing window handle and the -DisableWAM browser fallback
// hangs. So we do not ask it to sign in. We acquire the Security & Compliance
// token here in Node (which can sign in) and hand it over via -AccessToken.
// The credential behind that token is chosen in auth.js — interactive, device
// code, managed identity, or certificate — which is what makes the same bridge
// work locally and on a hosted, human-less box.
//
// Certificate app-only is the one exception: Connect-IPPSSession reads it from
// the Windows certificate store by thumbprint, which Node cannot do, so that
// path stays cmdlet-native.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getToken } from "./auth.js";

const EXEC_TIMEOUT_MS = Number(process.env.PURVIEW_EXEC_TIMEOUT_MS) || 60_000;
// The connect can block on an interactive sign-in, so it needs a far larger
// budget than a normal cmdlet's EXEC_TIMEOUT_MS.
const CONNECT_TIMEOUT_MS = Number(process.env.PURVIEW_CONNECT_TIMEOUT_MS) || 300_000;
// Resource scope for a Security & Compliance access token.
const EXO_SCOPE = process.env.PURVIEW_EXO_SCOPE || "https://outlook.office365.com/.default";

/** Escape a value for inclusion inside a single-quoted PowerShell string. */
const q = (s) => String(s).replace(/'/g, "''");

/**
 * An error raised by the bridge itself rather than by a cmdlet. Flagged so the
 * retry path can tell "the session went stale, safely re-run" apart from "the
 * command timed out and may already have applied" — see isAuthExpiry.
 */
function bridgeError(message) {
  const err = new Error(message);
  err.bridge = true;
  return err;
}

const PLATFORM_ERROR =
  "The DLP and label write/read-back tools need Security & Compliance PowerShell " +
  "(Connect-IPPSSession), which Microsoft only supports on Windows — it is not " +
  "available in PowerShell 7 on macOS or Linux. The sensitivity-label read tools " +
  "(Microsoft Graph) still work on this platform. See README → 'Platform support'. " +
  "Set PURVIEW_ALLOW_UNSUPPORTED_OS=1 to attempt the connection anyway.";

// Derive the tenant org domain (Connect-IPPSSession -Organization) from the
// token's upn claim, so token mode works without an explicit PURVIEW_ORGANIZATION.
function orgFromToken(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const upn = claims.upn || claims.unique_name || "";
    return upn.includes("@") ? upn.split("@")[1] : null;
  } catch {
    return null;
  }
}

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
        reject(bridgeError("PowerShell (pwsh) is not available. Install PowerShell 7+ or set PURVIEW_PWSH."));
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
        settle(reject, bridgeError(
          `PowerShell command timed out after ${timeoutMs}ms. The PowerShell session was reset; the next call will reconnect.`
        ));
        // The command is still running inside the child and would keep the
        // serialised session wedged for every later request — kill the child
        // so the next call gets a fresh process (and a fresh sign-in).
        proc.kill();
      }, timeoutMs);
      const onExit = () => {
        settle(reject, bridgeError("The PowerShell process exited before responding. The next call will start a fresh session."));
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
        settle(reject, bridgeError(`Failed to send command to PowerShell: ${err.message}`));
      }
    });
  }

  /**
   * Build the Connect-IPPSSession invocation. Three modes, in precedence order:
   *
   *  1. Certificate app-only — PURVIEW_APP_ID + PURVIEW_ORGANIZATION +
   *     PURVIEW_CERT_THUMBPRINT. Cmdlet-native, because the certificate is read
   *     from the Windows certificate store and Node cannot do that. Unattended
   *     Windows hosts. No browser, no human, no secret in the script text.
   *  2. Token injection (default) — we sign in here in Node and pass the token
   *     over. See the AUTH note at the top of this file for why the child
   *     cannot sign in itself. Works locally (interactive/device code) and on a
   *     hosted box (managed identity), with the credential chosen in auth.js.
   *  3. Interactive — PURVIEW_DLP_AUTH_MODE=interactive. Lets the pwsh child do
   *     its own sign-in. Retained for a host that gives pwsh a real console;
   *     it HANGS on this server's piped-stdio child, so it is not the default.
   */
  #certCommand() {
    const appId = process.env.PURVIEW_APP_ID;
    const org = process.env.PURVIEW_ORGANIZATION;
    const thumbprint = process.env.PURVIEW_CERT_THUMBPRINT;
    if (!appId || !org || !thumbprint) return null;
    return (
      `Connect-IPPSSession -AppId '${q(appId)}' -CertificateThumbprint '${q(thumbprint)}' ` +
      `-Organization '${q(org)}' -ShowBanner:$false`
    );
  }

  // Acquire a Security & Compliance token in Node and hand it to the child. The
  // token and org travel as a base64 JSON blob rebuilt inside pwsh, so the
  // bearer token never appears in the script text or in process arguments.
  async #tokenCommand() {
    const token = await getToken(EXO_SCOPE);
    const org = process.env.PURVIEW_ORGANIZATION || orgFromToken(token);
    if (!org) {
      throw new Error(
        "DLP auth needs the tenant's organization domain. Set PURVIEW_ORGANIZATION " +
          "to your <tenant>.onmicrosoft.com domain."
      );
    }
    const b64 = Buffer.from(JSON.stringify({ token, org }), "utf8").toString("base64");
    return [
      `$__c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json`,
      "Connect-IPPSSession -AccessToken $__c.token -Organization $__c.org -ShowBanner:$false",
    ].join("\n");
  }

  // ExchangeOnlineManagement 3.7+ defaults to the WAM broker, which needs an
  // interactive window handle; -DisableWAM falls back to the MSAL system-browser
  // flow. Neither completes from a piped-stdio child — see the AUTH note above.
  #interactiveCommand() {
    const upn = process.env.PURVIEW_UPN;
    const noWam = process.env.PURVIEW_ENABLE_WAM === "1" ? "" : " -DisableWAM";
    return upn
      ? `Connect-IPPSSession -UserPrincipalName '${q(upn)}'${noWam} -ShowBanner:$false`
      : `Connect-IPPSSession${noWam} -ShowBanner:$false`;
  }

  async #connectCommand() {
    const cert = this.#certCommand();
    if (cert) return cert;
    const mode = (process.env.PURVIEW_DLP_AUTH_MODE || "token").toLowerCase();
    return mode === "interactive" ? this.#interactiveCommand() : this.#tokenCommand();
  }

  /** Connect the IPPSSession on first use (single-flight, safe under concurrency). */
  #ensureConnected() {
    if (this.connecting) return this.connecting;
    if (process.platform !== "win32" && process.env.PURVIEW_ALLOW_UNSUPPORTED_OS !== "1") {
      return Promise.reject(bridgeError(PLATFORM_ERROR));
    }
    // Acquiring the token is async, so the whole build-and-connect runs inside
    // the single-flight promise: concurrent first calls share one sign-in.
    this.connecting = (async () => {
      const script = [
        "if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {",
        "  throw 'The ExchangeOnlineManagement module is not installed. Run: Install-Module ExchangeOnlineManagement -Scope CurrentUser'",
        "}",
        "Import-Module ExchangeOnlineManagement -ErrorAction Stop",
        await this.#connectCommand(),
        "'connected'",
      ].join("\n");
      // The sign-in behind the token can block on a human, so give the connect
      // the longer budget rather than the per-cmdlet timeout.
      return this.#enqueue(script, CONNECT_TIMEOUT_MS);
    })().catch((err) => {
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
  async invoke(cmdlet, params = {}, selectProps = null, retried = false) {
    await this.#ensureConnected();
    const b64 = Buffer.from(JSON.stringify(params ?? {}), "utf8").toString("base64");
    const select = selectProps?.length ? ` | Select-Object ${selectProps.join(",")}` : "";
    const script = [
      `$__p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json -AsHashtable`,
      "if ($null -eq $__p) { $__p = @{} }",
      `${cmdlet} @__p${select}`,
    ].join("\n");
    try {
      return await this.#enqueue(script);
    } catch (err) {
      // An injected access token lasts about an hour; when it lapses the cmdlet
      // rejects the call outright. Drop the stale session and reconnect once
      // (which mints a fresh token) before giving up.
      if (!retried && isAuthExpiry(err)) {
        this.connecting = null;
        return this.invoke(cmdlet, params, selectProps, true);
      }
      throw err;
    }
  }
}

/**
 * Does this error mean the session/token lapsed, so a reconnect-and-retry is
 * both safe and likely to succeed?
 *
 * Only cmdlet-reported auth rejections qualify. Errors the bridge raised itself
 * are excluded: a timed-out cmdlet may already have applied its change inside
 * the child, so retrying it could double-write a New-/Set- call. Keep this
 * matcher narrow — words like "session" appear in the bridge's own messages.
 */
function isAuthExpiry(err) {
  if (!err || err.bridge) return false;
  const m = String(err.message || "").toLowerCase();
  return (
    m.includes("unauthorized") ||
    m.includes("access token") ||
    m.includes("token has expired") ||
    m.includes("token is expired") ||
    m.includes("invalid token") ||
    m.includes("authentication failed") ||
    m.includes("re-authenticate") ||
    m.includes("reauthenticate")
  );
}

export const powershell = new PowerShellBridge();
