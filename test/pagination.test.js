import { test } from "node:test";
import assert from "node:assert/strict";

import { createListPaginator } from "../src/pagination.js";

const format = (items) => items.map((item) => item.Name).join(",");

function paginator(now = () => 1_000) {
  return createListPaginator({ secret: "test-pagination-secret", cursorTtlMs: 100, now });
}

test("keyset pagination returns a complete ordered collection without overlap", () => {
  const page = paginator();
  const items = [{ Name: "Zulu", Guid: "3" }, { Name: "Alpha", Guid: "1" }, { Name: "Mike", Guid: "2" }];
  const first = page("list_dlp_policies", { limit: 2, mode: "Enable" }, items, format);

  assert.deepEqual(first.structuredContent.items.map((item) => item.name), ["Alpha", "Mike"]);
  assert.equal(first.structuredContent.count, 2);
  assert.equal(first.structuredContent.total_count, 3);
  assert.equal(first.structuredContent.has_more, true);
  assert.ok(first.structuredContent.next_cursor);

  const second = page(
    "list_dlp_policies",
    { limit: 2, mode: "Enable", cursor: first.structuredContent.next_cursor },
    items,
    format
  );
  assert.deepEqual(second.structuredContent.items.map((item) => item.name), ["Zulu"]);
  assert.equal(second.structuredContent.has_more, false);
  assert.equal(second.structuredContent.next_cursor, null);
});

test("normalised label results preserve GUID, SCC name, and display name", () => {
  const page = paginator();
  const result = page(
    "list_sensitivity_labels",
    { limit: 25 },
    [{ id: "label-guid", scc_name: "internal-name", display_name: "Friendly label", name: "Friendly label" }],
    () => "label"
  );
  assert.deepEqual(result.structuredContent.items, [
    { id: "label-guid", name: "Friendly label", display_name: "Friendly label", scc_name: "internal-name" },
  ]);
});

test("keyset cursor does not repeat earlier entries when the collection or item details change", () => {
  const page = paginator();
  const firstItems = [{ Name: "Bravo", Guid: "2" }, { Name: "Charlie", Guid: "3" }, { Name: "Delta", Guid: "4" }];
  const first = page("list_dlp_policies", { limit: 2 }, firstItems, format);
  const changedItems = [
    { Name: "Alpha", Guid: "1" },
    firstItems[0],
    { ...firstItems[1], Workload: "Exchange,SharePoint" },
    firstItems[2],
    { Name: "Echo", Guid: "5" },
  ];
  const second = page(
    "list_dlp_policies",
    { limit: 2, cursor: first.structuredContent.next_cursor },
    changedItems,
    format
  );

  assert.deepEqual(second.structuredContent.items.map((item) => item.name), ["Delta", "Echo"]);
});

test("cursor is bound to the tool and filters and rejects tampering", () => {
  const page = paginator();
  const items = [{ Name: "Alpha" }, { Name: "Bravo" }];
  const first = page("list_dlp_policies", { limit: 1, mode: "Enable" }, items, format);
  const cursor = first.structuredContent.next_cursor;

  assert.throws(
    () => page("list_dlp_policies", { limit: 1, mode: "Disable", cursor }, items, format),
    /invalid, expired, or belongs to different filters/
  );
  assert.throws(
    () => page("list_dlp_rules", { limit: 1, mode: "Enable", cursor }, items, format),
    /invalid, expired, or belongs to different filters/
  );
  assert.throws(
    () => page("list_dlp_policies", { limit: 1, mode: "Enable", cursor: `${cursor}x` }, items, format),
    /invalid, expired, or belongs to different filters/
  );
});

test("cursor expiry is enforced", () => {
  let clock = 1_000;
  const page = paginator(() => clock);
  const items = [{ Name: "Alpha" }, { Name: "Bravo" }];
  const first = page("list_dlp_policies", { limit: 1 }, items, format);
  clock = 1_101;

  assert.throws(
    () => page("list_dlp_policies", { limit: 1, cursor: first.structuredContent.next_cursor }, items, format),
    /invalid, expired, or belongs to different filters/
  );
});
