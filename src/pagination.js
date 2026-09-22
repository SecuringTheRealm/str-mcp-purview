import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_CURSOR_TTL_MS = 15 * 60_000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function itemToken(item) {
  const name = String(
    item?.displayName ?? item?.DisplayName ?? item?.Name ?? item?.name ?? item?.Identity ?? ""
  ).normalize("NFKC").toLowerCase();
  const id = String(item?.id ?? item?.Id ?? item?.Guid ?? item?.Identity ?? "").toLowerCase();
  const tieBreaker = id || createHash("sha256").update(canonicalJson(item)).digest("base64url");
  return `${name}\u0000${tieBreaker}`;
}

export function normalizeListItem(item) {
  const fields = {
    id: item?.id ?? item?.Id ?? item?.Guid ?? item?.Identity,
    name: item?.name ?? item?.Name,
    display_name: item?.displayName ?? item?.DisplayName,
    mode: item?.Mode ?? item?.mode,
    enabled: item?.Enabled ?? item?.enabled,
    state: item?.State ?? item?.state,
    workload: item?.Workload ?? item?.workload,
    policy: item?.Policy ?? item?.policy,
    priority: item?.Priority ?? item?.priority,
    publisher: item?.Publisher ?? item?.publisher,
    sensitivity: item?.sensitivity ?? item?.Sensitivity,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

export function createListPaginator({
  secret = process.env.MCP_CURSOR_SECRET || randomBytes(32).toString("base64url"),
  cursorTtlMs = DEFAULT_CURSOR_TTL_MS,
  now = Date.now,
} = {}) {
  function signature(encoded) {
    return createHmac("sha256", secret).update(encoded).digest("base64url");
  }

  function makeCursor(tool, filters, after) {
    const payload = { v: 1, tool, filters: canonical(filters), after, exp: now() + cursorTtlMs };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${signature(encoded)}`;
  }

  function readCursor(cursor, tool, filters) {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2) throw new Error();
      const [encoded, supplied] = parts;
      const expected = signature(encoded);
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(expected);
      if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
        throw new Error();
      }
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (
        payload.v !== 1 ||
        payload.tool !== tool ||
        payload.exp < now() ||
        typeof payload.after !== "string" ||
        canonicalJson(payload.filters) !== canonicalJson(filters)
      ) {
        throw new Error();
      }
      return payload.after;
    } catch {
      throw new Error(
        `The pagination cursor for ${tool} is invalid, expired, or belongs to different filters. Restart from the first page.`
      );
    }
  }

  return function paginateList(tool, args, items, formatPage, normalizeItem = normalizeListItem) {
    const limit = args.limit;
    const filters = Object.fromEntries(
      Object.entries(args).filter(([key]) => key !== "limit" && key !== "cursor")
    );
    const after = args.cursor ? readCursor(args.cursor, tool, filters) : null;
    const sorted = items
      .map((item) => ({ item, token: itemToken(item) }))
      .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    const start = after === null ? 0 : sorted.findIndex(({ token }) => token > after);
    const pageEntries = start < 0 ? [] : sorted.slice(start, start + limit);
    const hasMore = start >= 0 && start + pageEntries.length < sorted.length;
    const page = pageEntries.map(({ item }) => item);
    const nextCursor = hasMore
      ? makeCursor(tool, filters, pageEntries[pageEntries.length - 1].token)
      : null;
    const suffix = nextCursor
      ? `\n\nMore results are available. Call ${tool} again with the returned next_cursor as cursor.`
      : "";
    return {
      content: [{ type: "text", text: `${formatPage(page)}${suffix}` }],
      structuredContent: {
        items: page.map(normalizeItem),
        count: page.length,
        total_count: sorted.length,
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    };
  };
}
