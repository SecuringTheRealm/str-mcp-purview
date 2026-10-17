const STOP_WORDS = new Set(["a", "an", "the", "this", "that", "these", "those", "for", "to", "of", "in", "on", "and", "or", "with", "by", "from", "me", "my", "is", "are", "it"]);
export function tokenize(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((s) => !STOP_WORDS.has(s))
    .map((s) => s.endsWith("ies") ? s.slice(0, -3) + "y" : s.length > 3 && s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);
}

/** Pure local BM25 with deterministic tie-breaking; input has already been filtered. */
export function rankCapabilities(entries, query) {
  const terms = [...new Set(tokenize(query))];
  const docs = entries.map((c) => tokenize([c.id, c.domain, c.action, c.description, ...c.keywords, ...(c.aliases ?? [])].join(" ")));
  const average = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1);
  const frequency = new Map(terms.map((term) => [term, docs.filter((d) => d.includes(term)).length]));
  const queryWords = new Set(terms);
  return entries.map((capability, i) => {
    let score = 0;
    for (const term of terms) {
      const tf = docs[i].filter((word) => word === term).length;
      const df = frequency.get(term);
      if (tf) score += Math.log(1 + (entries.length - df + 0.5) / (df + 0.5))
        * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * docs[i].length / (average || 1)));
    }
    if ([capability.id, ...(capability.aliases ?? [])].some((id) => id.toLowerCase() === query.toLowerCase().trim())) score += 20;
    if (queryWords.has(capability.domain)) score += 2;
    const verb = capability.operation ?? capability.id.split("_")[0];
    const synonyms = { list: ["find", "list", "enumerate"], get: ["get", "show", "inspect", "check"], create: ["create", "new"], update: ["set", "update", "modify"], delete: ["delete", "remove"], validate: ["validate", "verify"], publish: ["publish", "activate"], export: ["export", "download"] };
    if ((synonyms[verb] ?? []).some((v) => queryWords.has(v))) score += 3;
    return { capability, score: Math.round(score * 1e6) / 1e6 };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id));
}
