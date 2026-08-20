# Decision log

Decisions resolved while building. [`spec.md`](spec.md) is the design document; this file
records where the code settled something the spec left open, and where it deliberately
differs. A deviation is a decision, and decisions get written down.

Format: **D-nnn — title** · what was decided · why · what it would cost to change.

---

## Resolved

### D-001 — Runtime: headless daemon, clients attach

Settled in the build prompt, superseding the first bullet of spec §11 (Tauri vs. daemon).
The core is a Node process listening on a Unix domain socket; adapters attach over it.

The core must append to disk continuously, survive SIGKILL, and eventually host a resident
listener and spawn a subprocess executor. None of that is available to a browser page, so
the Tauri option was not a like-for-like alternative.

Cost to change: total. Everything else assumes it.

### D-002 — Separate repository from Creative Archive v1

v2 lives in its own repo rather than as a package inside `creative-archive`.

v1 is a browser-first React app (FSA `FileStore`, sqlite-wasm, Drizzle); v2 is a headless
Node daemon with no UI. The shared surface is the on-disk archive format, not code.

Cost to change: moderate, and it grows. If the two ever need to share format code, the
sharing should be a published schema, not a merge.

### D-003 — Personality persisted per archive

Resolves the "personality persistence granularity" bullet in §11. Identity — name and
personality together — lives at `<archive>/.creative-archive/identity.yaml`.

Per §4: the agent working a novel archive can differ from the one working a study archive.
Per-mode or per-session granularity would make identity a setting rather than a fact about
a body of work.

Cost to change: low. One file, one loader.

### D-004 — The transcript records both sides

`transcript.md` contains the agent's turns as well as the user's.

The alternative — recording only the human — would make the transcript unreadable as a
record of a conversation, and would put the agent's half in the derived layer where it is
regenerable and therefore not ground truth.

Consequence, and it is load-bearing: **the transcript is not personality-invariant.** A
preset changes how the agent's turns read, so §4.4's invariance claim can only hold over
the _derived_ layer, not over the raw transcript. See the note in
`tests/invariants/personality-invariance.spec.ts`.

Cost to change: high once transcripts exist. Old transcripts cannot be un-mixed.

### D-005 — No database, local model only

No SQLite, no embedded store. Sessions are markdown and YAML on disk. The only
`ModelClient` implementations are a deterministic in-process fake (the default) and Ollama
over localhost, opt-in via `CREATIVE_ARCHIVE_MODEL`.

Also resolves §11's "cleanup pass model" bullet toward local: the archive stays sealed.

**Resolved against §8 at step 2.** §8 phase 1 specifies SQLite FTS5, which this rules out.
The index is built in process from the files instead, and rebuilt rather than persisted.
That is not only a concession: §8's stated reason for going structural before semantic is
debuggable results — "when a query returns the wrong thing you can see exactly why" — and an
index whose scoring you can read serves that better than FTS5's opaque ranking.

Measured before committing to it, on a synthetic archive of 5,500 documents / 30,000 spans /
25k distinct tokens (28.6 MB of markdown):

|               |                         |
| ------------- | ----------------------- |
| cold build    | 2.0–3.7 s               |
| heap retained | 153 MB (~5× the corpus) |
| query         | 3–10 ms                 |

Memory, not latency, is what would eventually force a real database. A personal archive an
order of magnitude larger than that test would want reconsidering.

Cost to change: moderate. The scanner, query language, and `retrieve` tool are all
backend-agnostic; only `ArchiveIndex` internals would be replaced.

### D-006 — Config split: identity inside the archive, grants outside it

Identity is per-archive and lives in the archive. The archive-root allowlist (§6.0) lives
in user-level state (`~/Library/Application Support/creative-archive/archives.yaml` on
macOS, `CREATIVE_ARCHIVE_STATE_DIR` to override).

An archive that could authorize itself is not an allowlist. Anything that _grants_ lives
outside every archive; anything that _describes_ lives inside one.

Cost to change: low.

### D-007 — Mode scope is enforced at the storage chokepoint

`ScopedFileStore` checks every read and every mutation. Tools do not check scope.

A tool that forgets the check is a bug found in production; a store that cannot be reached
without checking has no such failure mode. Tools added in later steps therefore cannot
widen scope by omission.

Cost to change: low, but changing it re-opens the failure mode.

### D-008 — An archive must be inside a git working tree

`openArchive` refuses a root with no `.git` above it.

§6.2 gates on reversibility and classifies in-scope writes as needing no gate at all,
because "the diff is the undo." Without git there is no diff and no undo, so the premise of
the ungated write does not hold. Refusing is honest; writing anyway would silently
downgrade the guarantee.

Cost to change: low.

### D-009 — An orphaned buffer is promoted, not discarded

§5.1 says a buffer is discarded if the user aborts before commit. A crash is not an abort.
Recovery promotes any pre-commit buffer that has content into a session folder with
`mode: null` and `recovered: true`; a buffer holding only the greeting is deleted.

The preamble captured before intake is frequently the most diagnostic content in the
session. Recording `mode: null` rather than defaulting keeps a scope claim nobody made out
of the record.

Cost to change: low.

### D-010 — Deferred declarations are rejected, not ignored

A mode manifest naming `retrieve` (step 2), carrying a `capabilities` block (§6.3, step 8),
or a `legend` key (§5.6) fails to load, with an error naming the step it arrives in.

§6.3's whole premise is that declared capability is real and needs no prompt. A declaration
the core silently drops inverts that: the manifest says one thing and the system does
another, which is the failure declaration exists to prevent.

Cost to change: trivial — each rejection is one line, removed as its step lands.

### D-011 — `transcript.md` carries no frontmatter

Session metadata lives entirely in `meta.yaml`; the transcript is a bare log.

This is what makes intake's flush a `rename` rather than a rewrite (§5.1 step 5). A
rewrite would make the committed transcript a _copy_ of the ground truth and would open a
window in which neither file is whole. §7's "title lives in frontmatter" is read as "in
metadata", which for this layout is `meta.yaml`.

Cost to change: high. It is the reason the commit path is safe.

### D-012 — Groundedness reports are gated on being able to search

An agent with no retrieval may not report a gap at all: the composed `archive_context` says
so outright, rather than letting it report an absence it cannot verify.

§3.1 turns on distinguishing _not in the archive_ from _not found by this query_. An agent
that cannot search has neither claim available. A confident "undocumented" that was really a
missing tool is exactly the failure the section exists to prevent.

Since step 2 the gate is usually open, and the same rule now runs the other way: a report is
permitted only when a search actually came back empty, and it has to carry what was searched.
An archive with no index still gets the original refusal.

Cost to change: none — it is one conditional on whether an index is present.

### D-013 — Retrieval is automatic per turn, not model-invoked

The model is not given tool calling in this build, so the core retrieves before each agent
turn using the user's utterance as the query, and puts the spans and the search record into
`archive_context` (§4.3 stays at five fragments — retrieval is context about the archive).
`session.search` exposes the same tool directly for inspection.

The alternative was waiting for tool calling, which would leave §3.1 unenforceable in the
meantime: an agent that cannot search cannot honestly say what the archive does or does not
hold, so groundedness would stay aspirational through two more build steps.

Retrieved spans are labelled as content, not instruction, and never enter the transcript —
they are derived context, not conversation. The §6.4 rule about fetched content is cheap to
apply here and expensive to retrofit later.

Cost to change: low. When tool calling lands, the automatic pass becomes a fallback or is
dropped; `retrieve` is already gated by `mode.tools`.

### D-014 — The index is rebuilt on demand, not watched

One index per archive, held by a registry. Closing a session marks it stale; the next caller
pays for the rebuild. No file watcher, no background rebuild, no timer.

During a session the only file changing is that session's own transcript, and those turns are
already in the model's context — so a snapshot taken at session start is correct rather than
merely convenient. What does change is that a _finished_ session becomes searchable, which is
what makes §1's "sessions become new archive content" real. Rebuilding in the background at
close would make `session.end` either slow or racy for a benefit nobody can observe.

An edit made to the archive by hand mid-session is therefore invisible until a rebuild;
`index.rebuild` forces one.

Cost to change: low — a watcher would call `markStale`.

---

## Open

Carried forward from spec §11, untouched by this build: STT engine, wake mechanism,
licensing audit, executor isolation depth, spend cap values, confirm channel for
irreversible actions, listener idle behavior.

Raised by this build and needing a decision:

- **The solutions partition is not expressible.** §5.5 requires material flagged
  `contains_solutions` to be unreadable by `tutor` and readable by `review`. Scope is an
  allow-list of globs with no negation, so "everything except this partition" cannot be
  written. Step 4 needs either a `deny` list in the scope shape or a partition directory
  excluded by construction. Until then all four modes ship identical scopes and scope is
  not yet doing discriminating work in production.
- **`session_template` is accepted but unconsumed.** Manifests declare it and the loader
  checks the file exists, but nothing reads it until the derivation pass (step 3). This is
  the one place D-010 was not applied, on the grounds that churning four manifests at step
  3 is worse than an existence-checked forward reference.
- **Tool calling.** `tools` gates core operations invoked over the protocol; the model is
  still not given tool calling. When it is, the gate is already in the right place, but the
  model needs a description of each tool that does not leak into the transcript, and D-013's
  automatic retrieval pass should probably become a fallback rather than the primary path.
- **Semantic retrieval (§8 phase 2) stays deferred**, correctly: structural retrieval has not
  demonstrably failed yet. The trigger §8 names is "what did we say about X" starting to miss,
  and `matchMode: 'any'` in the search record is the signal to watch — a rising rate of
  relaxed matches is structural retrieval running out of road.
- **Retrieval quality is untested against a real archive.** Everything here is measured on
  synthetic prose and small fixtures. Scoring, span boundaries, and the 600-character clip are
  all guesses until they meet a corpus somebody actually wrote.
- **Spec cross-references do not resolve.** The build prompt cites "§12" for open decisions
  (the spec has them at §11) and "§11" for a decision-log format (the spec has none), and
  cites D-001 which appears nowhere in the spec. This file is the assumed answer.
