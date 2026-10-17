# The Last 20% Catalog

The recurring categories the scene-list residue falls into. For each: what it is, the probe question to ask of any build, and worked examples across domains. Use this after decomposing the scene (Phase 2) — run the build against every category and probe; anything that lands unanswered goes on the finish list.

## 1. Content and voice

What the system's output actually reads like, sentence by sentence. This is the single most-skipped category: the machinery to *produce* content gets built, and the question of what good content *is* never gets asked.

**Probe:** Pick one real artifact the system will produce. Could you write out, right now, the ideal version of it by hand? If not, nobody has decided what the output should be.

- *Knowledge wiki:* Does a page open with the answer or with boilerplate ("This page describes...")? Are headings the questions readers ask, or the names of database fields? Does every claim cite its source doc?
- *Report generator:* Does the report lead with the finding or with methodology? Is there a one-paragraph executive summary a director would actually forward?
- *Chatbot / assistant:* Does it have a register — terse, warm, formal? Or does every reply read like the average of the internet?
- *Code generator:* Does emitted code match the host repo's idioms, or a generic style no reviewer would approve?

## 2. Information architecture

Which pages, screens, sections, or commands exist, and why those. The noun list produces a data model; it never produces an answer to "what does the table of contents look like?"

**Probe:** Draw the sitemap (or screen map, or command tree) from memory. If it's just "list view + detail view" or "one page per database row," nobody designed it.

- *Wiki:* What page *types* exist — overviews, how-tos, policy pages, glossaries? One page per source document is ingestion leaking into IA; readers need pages organized by question, not by file.
- *Dashboard:* Which questions does each view answer? A dashboard that shows "all the metrics" answers none of them.
- *CLI tool:* What does `--help` print, and is the most common workflow the shortest command?
- *API:* Do the endpoints map to consumer intents, or mirror internal tables?

## 3. First-run and empty states

What the person sees on day zero, before there's data, history, or content. Builds get tested against a populated fixture; users arrive at an empty one.

**Probe:** Delete all the data and open the product. Is what you see an invitation or a wall?

- *Wiki:* Before ingestion finishes — a spinner, or a starter set of hand-seeded pages proving what the wiki will be?
- *Dashboard:* No events yet — blank charts, or a guided "send your first event" path with example output?
- *SaaS app:* Fresh account — a barren table, or a worked example the user can poke at and then replace?

## 4. Opinionated defaults

Every configuration surface is a decision the product refused to make. The 80% instinct is to make everything configurable; the 20% is choosing well so nobody has to configure anything.

**Probe:** List every option, flag, and setting. For each: what happens if a user never touches it? If the answer is "the product is worse," the default is wrong or the option shouldn't exist.

- *Wiki:* Which model, which chunk size, which page template? Ship the choice, note it in one line, let power users override later.
- *Report generator:* Default period, default recipients, default format — a report that asks five questions before running will never be run.
- *CLI:* Zero-flag invocation should do the most common thing correctly.

## 5. The golden path

The one flow that must feel effortless — the scene from Phase 1, end to end. Everything else can be merely functional; this one path has to be fast, obvious, and dead-end-free.

**Probe:** Time yourself performing the magic moment cold. Count the steps where you hesitated, guessed, or needed knowledge only the builder has. Each is a gap.

- *Wiki:* Question in head → answer on screen. How many clicks, and was any of them a guess?
- *Internal tool:* Is the golden path reachable from wherever users actually start (Slack, a bookmark, an email link), or only from a URL nobody knows?
- *Library / SDK:* The README's first code block *is* the golden path. Does it run as pasted?

## 6. The failure experience

Errors get *handled* in the 80% (caught, logged, retried). What the person *experiences* at that moment is 20% work.

**Probe:** Force the three most likely failures — no results, bad input, upstream down — and read what appears on screen as a stranger. Does it tell them what happened and what to do next, in their vocabulary?

- *Wiki search, zero hits:* Bare "no results," or the three nearest pages plus a "request this page" action?
- *Ingestion, one bad document:* Silent skip, or a visible note on the affected pages that a source failed?
- *API:* Do error bodies name the fix ("field X must be ISO-8601") or just the failure?

## 7. Naming and microcopy

Titles, labels, button text, section names, empty-state sentences. Tiny surface, outsized effect — this is most of what a user actually reads, and builders leave placeholder names in it ("Untitled", "Home", "Data", "Submit").

**Probe:** Read every string a user will see, out loud, in one sitting. Flag anything a builder wrote for themselves: internal jargon, table names, "TODO", or copy so generic it could sit on any product.

- *Wiki:* Is the wiki itself named? Do page titles read like answers ("How contract review works") or like keys ("contract_review_v2")?
- *Dashboard:* Are metrics labeled in the reader's language ("Signups this week") or the pipeline's ("dim_user_cnt_7d")?

## 8. The second visit

Whether the thing gets better with use — or at least remembers you came. Demos optimize the first impression; products live on return visits.

**Probe:** Use it, leave, come back tomorrow. What's different? If the answer is "nothing," the product has no memory and no pull.

- *Wiki:* Do fresh pages get flagged? Do stale ones warn? Is there a "recently answered" trail that makes the wiki feel alive?
- *Dashboard:* Does it open on what changed since you last looked, or on the same static default?
- *Assistant:* Does it recall context from last time, or start every session as a stranger?

---

## Using the catalog

Not every category applies to every build — a batch job has no microcopy to speak of; a library has no empty state. Run all eight probes anyway; deciding a category is N/A takes seconds, and the skipped 20% is by definition the part you didn't think to check. Every probe that lands unanswered becomes a finish-list item with concrete done-criteria (Phase 3).
