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
// The exact framing pwsh will accept over piped stdin is subtle — see
// wrapScript() below before changing anything about how a request is written.
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
// Connecting does more work than a normal cmdlet (module import, session
// handshake), so it gets a larger budget than EXEC_TIMEOUT_MS.
const CONNECT_TIMEOUT_MS = Number(process.env.PURVIEW_CONNECT_TIMEOUT_MS) || 300_000;
// Acquiring the token happens HERE in Node, before anything is sent to pwsh, so
// CONNECT_TIMEOUT_MS does not cover it. An interactive sign-in blocks on a human
// finding a browser window they may never have seen open, and without a bound of
// its own that blocks the agent's tool call forever.
const SIGNIN_TIMEOUT_MS = Number(process.env.PURVIEW_SIGNIN_TIMEOUT_MS) || CONNECT_TIMEOUT_MS;
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

/**
 * Wrap a script in the framed request/response block the bridge parses back.
 *
 * The trailing BLANK line is load-bearing. `pwsh -Command -` executes piped
 * input incrementally, but only flushes a MULTI-LINE block once it reads an
 * empty line — a block terminated by a single newline is held in the parser
 * forever, so every request hangs until its timeout and the child is killed.
 * For the same reason, no script passed in here may contain a blank line of its
 * own: that would flush this wrapper early and split the block.
 *
 * Exported so the smoke test can drive a real pwsh with it; a mocked child
 * process cannot see this class of bug.
 */
export function wrapScript(script, start, end) {
  return [
    "try {",
    "  $ErrorActionPreference = 'Stop'",
    `  $__out = & {`,
    script,
    "  }",
    "  $__json = $__out | ConvertTo-Json -Depth 8 -Compress",
    `  [Console]::Out.WriteLine('${start}')`,
    "  [Console]::Out.WriteLine('__OK__')",
    "  if ($null -ne $__json) { [Console]::Out.WriteLine($__json) } else { [Console]::Out.WriteLine('null') }",
    `  [Console]::Out.WriteLine('${end}')`,
    "} catch {",
    `  [Console]::Out.WriteLine('${start}')`,
    "  [Console]::Out.WriteLine('__ERR__')",
    "  [Console]::Out.WriteLine($_.Exception.Message)",
    `  [Console]::Out.WriteLine('${end}')`,
    "}",
    "", // terminates the block — see above
    "",
  ].join("\n");
}

/** Reject if `promise` has not settled within `ms`, so a tool call cannot hang. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(bridgeError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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

      try {
        proc.stdin.write(wrapScript(script, START, END));
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
    const token = await withTimeout(
      getToken(EXO_SCOPE),
      SIGNIN_TIMEOUT_MS,
      `Timed out after ${SIGNIN_TIMEOUT_MS}ms acquiring a Security & Compliance access token. ` +
        "If PURVIEW_AUTH_MODE is interactive, a browser sign-in window is waiting for you — " +
        "complete it and call the tool again, or switch to PURVIEW_AUTH_MODE=devicecode."
    );
    const org = process.env.PURVIEW_ORGANIZATION || orgFromToken(token);
    if (!org) {
      throw new Error(
        "DLP auth needs the tenant's organization domain. Set PURVIEW_ORGANIZATION to a " +
          "domain verified in your tenant — either <tenant>.onmicrosoft.com or the domain " +
          "of the signing-in admin's UPN."
      );
    }
    const b64 = Buffer.from(JSON.stringify({ token, org }), "utf8").toString("base64");
    return [
      `$__c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json`,
      // NOTE: Microsoft's app-only auth guide says "If a Connect-IPPSSession
      // command presents a sign in prompt, run the command: $Global:IsWindows =
      // $true before it." That advice must NOT be applied here. It only works in
      // Windows PowerShell 5.1, where $IsWindows does not exist and the
      // assignment creates an ordinary variable. In PowerShell 7 — which this
      // bridge requires — $IsWindows is a read-only automatic variable on every
      // platform, so the assignment is a terminating error under
      // $ErrorActionPreference='Stop' and the connect dies on its first line.
      // We do not need it regardless: the prompt it suppresses comes from the
      // module falling back to interactive auth, which -AccessToken avoids.
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

  /**
   * The full connect script: module presence check, import, the mode-specific
   * Connect-IPPSSession call, and a sentinel.
   *
   * Kept as its own method rather than inlined in #ensureConnected so the smoke
   * test can run it against a real pwsh with the cmdlet stubbed. That is the
   * only thing that catches a connect line PowerShell rejects outright, which a
   * mocked child process will happily accept.
   */
  async connectScript() {
    return [
      "if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {",
      "  throw 'The ExchangeOnlineManagement module is not installed. Run: Install-Module ExchangeOnlineManagement -Scope CurrentUser'",
      "}",
      "Import-Module ExchangeOnlineManagement -ErrorAction Stop",
      await this.#connectCommand(),
      "'connected'",
    ].join("\n");
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
      // The sign-in inside connectScript() is bounded by SIGNIN_TIMEOUT_MS; this
      // budget covers only the module import and session handshake in pwsh.
      const script = await this.connectScript();
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
      if (!retried && isAuthExpiry(err, cmdlet)) {
        this.connecting = null;
        return this.invoke(cmdlet, params, selectProps, true);
      }
      throw err;
    }
  }
}

// Auth rejections the service names outright. The cmdlet demonstrably never
// ran, so reconnecting and re-running is safe even for a New-/Set-/Remove-.
const AUTH_REJECTIONS = [
  "unauthorized",
  "access token",
  "token has expired",
  "token is expired",
  "invalid token",
  "authentication failed",
  "re-authenticate",
  "reauthenticate",
];

// What a lapsed or rejected token ACTUALLY looks like most of the time: the
// endpoint answers with an HTML error page and the module's JSON reader chokes
// on it ("Unexpected character encountered while parsing value: <"). The message
// names no cause, so we cannot prove the cmdlet did not run — see isAuthExpiry.
const OPAQUE_NON_JSON_RESPONSE = "unexpected character encountered while parsing";

/**
 * Does this error mean the session/token lapsed, so a reconnect-and-retry is
 * both safe and likely to succeed?
 *
 * Errors the bridge raised itself are always excluded: a timed-out cmdlet may
 * already have applied its change inside the child, so retrying it could
 * double-write. Keep the matchers narrow — words like "session" appear in the
 * bridge's own messages.
 *
 * The opaque non-JSON failure is retried for READS ONLY. It is the common way a
 * stale token surfaces, but it carries no evidence about whether the cmdlet
 * reached the service, and re-running an unproven New-/Set-/Remove- is a worse
 * outcome than returning the error.
 */
function isAuthExpiry(err, cmdlet = "") {
  if (!err || err.bridge) return false;
  const m = String(err.message || "").toLowerCase();
  if (AUTH_REJECTIONS.some((s) => m.includes(s))) return true;
  return m.includes(OPAQUE_NON_JSON_RESPONSE) && /^get-/i.test(cmdlet);
}

export const powershell = new PowerShellBridge();
