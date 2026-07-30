import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// graph.js acquires an Azure credential lazily and caches it module-wide, so we
// stub @azure/identity up front (via node's experimental module mocking) and
// stub the global fetch per-test to exercise graphGet's request/response
// handling without any network or browser interaction.
class FakeCredential {
  constructor() {
    this.calls = [];
  }
  async getToken(scopes) {
    this.calls.push(scopes);
    return { token: "fake-token" };
  }
}

mock.module("@azure/identity", {
  namedExports: {
    InteractiveBrowserCredential: FakeCredential,
    DeviceCodeCredential: FakeCredential,
    ClientCertificateCredential: FakeCredential,
    ManagedIdentityCredential: FakeCredential,
  },
});

const { graphGet, graphGetAll } = await import("../src/graph.js");

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] == null) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

test("graphGet", async (t) => {
  const savedFetch = globalThis.fetch;
  t.afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  await t.test("throws when AZURE_TENANT_ID/AZURE_CLIENT_ID are not set", async () => {
    await withEnv({ AZURE_TENANT_ID: undefined, AZURE_CLIENT_ID: undefined }, async () => {
      delete process.env.AZURE_TENANT_ID;
      delete process.env.AZURE_CLIENT_ID;
      await assert.rejects(
        () => graphGet("/me/security/informationProtection/sensitivityLabels"),
        /Auth is not configured/
      );
    });
  });

  await t.test("builds the beta URL, sets a bearer token, and returns parsed JSON", async () => {
    await withEnv({ AZURE_TENANT_ID: "tenant-1", AZURE_CLIENT_ID: "client-1" }, async () => {
      let seenUrl, seenAuth;
      globalThis.fetch = async (url, opts) => {
        seenUrl = url;
        seenAuth = opts.headers.Authorization;
        return { ok: true, json: async () => ({ value: [{ id: "label-1" }] }) };
      };
      const result = await graphGet("/me/security/informationProtection/sensitivityLabels", {
        $select: "id,name",
        skip: null,
      });
      assert.equal(
        seenUrl,
        "https://graph.microsoft.com/beta/me/security/informationProtection/sensitivityLabels?%24select=id%2Cname"
      );
      assert.equal(seenAuth, ["Bea", "rer fake-token"].join(""));
      assert.deepEqual(result, { value: [{ id: "label-1" }] });
    });
  });

  await t.test("raises a compact error including the parsed Graph error message on failure", async () => {
    await withEnv({ AZURE_TENANT_ID: "tenant-1", AZURE_CLIENT_ID: "client-1" }, async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => JSON.stringify({ error: { message: "Insufficient privileges" } }),
      });
      await assert.rejects(() => graphGet("/foo"), /Graph 403 Forbidden: Insufficient privileges/);
    });
  });

  await t.test("graphGetAll follows @odata.nextLink until the collection is exhausted", async () => {
    await withEnv({ AZURE_TENANT_ID: "tenant-1", AZURE_CLIENT_ID: "client-1" }, async () => {
      const urls = [];
      const pages = {
        "https://graph.microsoft.com/beta/labels": {
          value: [{ id: "1" }],
          "@odata.nextLink": "https://graph.microsoft.com/beta/labels?$skiptoken=p2",
        },
        "https://graph.microsoft.com/beta/labels?$skiptoken=p2": { value: [{ id: "2" }, { id: "3" }] },
      };
      globalThis.fetch = async (url) => {
        urls.push(url);
        return { ok: true, json: async () => pages[url] };
      };
      const result = await graphGetAll("/labels");
      assert.deepEqual(result.map((l) => l.id), ["1", "2", "3"]);
      assert.equal(urls.length, 2);
    });
  });

  await t.test("falls back to a truncated raw body when the error is not JSON", async () => {
    await withEnv({ AZURE_TENANT_ID: "tenant-1", AZURE_CLIENT_ID: "client-1" }, async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "<html>oops</html>",
      });
      await assert.rejects(() => graphGet("/foo"), /Graph 500 Internal Server Error: <html>oops<\/html>/);
    });
  });
});
