import { test } from "node:test";
import assert from "node:assert/strict";

import { truncate, cell, shortDate, bulletFields, asArray } from "../src/format.js";

test("truncate", async (t) => {
  await t.test("returns empty string for null/undefined", () => {
    assert.equal(truncate(null), "");
    assert.equal(truncate(undefined), "");
  });

  await t.test("passes short strings through unchanged", () => {
    assert.equal(truncate("hello", 100), "hello");
  });

  await t.test("cuts long strings and appends an ellipsis", () => {
    assert.equal(truncate("abcdefghij", 5), "ab...");
  });

  await t.test("coerces non-string values to strings", () => {
    assert.equal(truncate(12345, 100), "12345");
  });

  await t.test("uses the default max of 100 when omitted", () => {
    const s = "x".repeat(150);
    assert.equal(truncate(s), "x".repeat(97) + "...");
  });
});

test("cell", async (t) => {
  await t.test("renders missing/empty values as a dash", () => {
    assert.equal(cell(null), "-");
    assert.equal(cell(undefined), "-");
    assert.equal(cell(""), "-");
  });

  await t.test("stringifies present values", () => {
    assert.equal(cell(42), "42");
    assert.equal(cell(false), "false");
  });

  await t.test("pads to width when provided", () => {
    assert.equal(cell("ab", 5), "ab   ");
    assert.equal(cell(null, 5), "-    ");
  });

  await t.test("does not pad when width is falsy", () => {
    assert.equal(cell("ab", 0), "ab");
  });
});

test("shortDate", async (t) => {
  await t.test("returns a dash for missing values", () => {
    assert.equal(shortDate(null), "-");
    assert.equal(shortDate(undefined), "-");
    assert.equal(shortDate(""), "-");
  });

  await t.test("truncates an ISO datetime down to the date portion", () => {
    assert.equal(shortDate("2024-01-02T03:04:05Z"), "2024-01-02");
  });

  await t.test("coerces non-string input via String()", () => {
    assert.equal(shortDate(20240102), "20240102");
  });
});

test("bulletFields", async (t) => {
  await t.test("renders a markdown bullet per non-empty field", () => {
    const obj = { id: "abc", name: "Foo", empty: "", missing: null, list: [] };
    const out = bulletFields(obj, [
      ["id", "ID"],
      ["name", "Name"],
      ["empty", "Empty"],
      ["missing", "Missing"],
      ["list", "List"],
    ]);
    assert.equal(out, "- **ID:** abc\n- **Name:** Foo");
  });

  await t.test("joins array values with commas", () => {
    const obj = { tags: ["a", "b", "c"] };
    const out = bulletFields(obj, [["tags", "Tags"]]);
    assert.equal(out, "- **Tags:** a, b, c");
  });

  await t.test("returns an empty string when nothing matches", () => {
    assert.equal(bulletFields({}, [["missing", "Missing"]]), "");
  });

  await t.test("handles a nullish object gracefully", () => {
    assert.equal(bulletFields(undefined, [["id", "ID"]]), "");
  });
});

test("asArray", async (t) => {
  await t.test("returns an empty array for null/undefined", () => {
    assert.deepEqual(asArray(null), []);
    assert.deepEqual(asArray(undefined), []);
  });

  await t.test("wraps a single object in an array", () => {
    const obj = { a: 1 };
    assert.deepEqual(asArray(obj), [obj]);
  });

  await t.test("passes arrays through unchanged", () => {
    const arr = [1, 2, 3];
    assert.equal(asArray(arr), arr);
  });

  await t.test("wraps scalars", () => {
    assert.deepEqual(asArray("x"), ["x"]);
    assert.deepEqual(asArray(0), [0]);
  });
});
