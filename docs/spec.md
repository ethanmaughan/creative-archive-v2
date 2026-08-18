# Creative Archive v2.0 — Architecture Spec

Status: draft
Supersedes: Creative Archive v1 (markdown knowledge system)

---

## 1. What v2 adds

v1 is a local-first markdown knowledge system you read and write by hand.

v2 keeps that substrate unchanged and adds a **conversational layer**: a voice-capable
agent that can be toggled on, scoped to an archive, and used to work *through* the
archive rather than *in* it. Sessions become new archive content, so the system feeds
itself.

Core principle: **this is not a voice project.** It is v1 plus a transcript writer, with
an audio adapter attached at the edge. Every capability must work with the microphone
unplugged.

---

## 2. Architecture

```
                 ┌─────────────────────────────┐
   text CLI ────▶│                             │
   voice    ────▶│           CORE              │────▶ archive (markdown, on disk)
   phone    ────▶│  retrieval · tools · modes  │
                 └─────────────────────────────┘
```

### 2.1 Core

Text in, text out. Owns:

- archive scoping (which archive, which folders are readable/writable)
- retrieval over the archive
- tool layer (file read/write, footnote, session lifecycle)
- mode + identity composition into the system prompt
- session state

Has no knowledge of audio. Fully testable headlessly.

### 2.2 Adapters

Thin translators to the core. Each is independently attachable.

| Adapter | Transport | Notes |
|---|---|---|
| `text` | stdin / TUI | reference adapter; the test harness |
| `voice` | local mic + speakers | STT → core → TTS |
| `phone` | SIP | later; deferred |

**The "toggle the AI assistant" gesture = attaching the voice adapter.** It is not a
mode inside the assistant. The distinction matters: it keeps the core's behavior
identical across entry points.

### 2.3 Voice adapter internals

Two tiers, deliberately separated:

**Tier 0 — deterministic phrase layer (no LLM).**
Always-on keyword spotting against a registry of code phrases. Fires named sequences
directly. Sub-second, reproducible, testable. Handles: session start, session end,
explicit footnote, any user-defined macro.

**Tier 1 — conversational layer.**
VAD → streaming STT → core → streaming TTS. Cascaded and pipelined; do not use a
native speech-to-speech model (time-to-first-audio is far too high for conversation).

Every Tier 0 sequence is classified:

- `safe` — idempotent, fires immediately
- `confirm` — requires spoken confirmation before executing

Session end is `confirm`. Any sequence that deletes or overwrites is `confirm`.

---

## 3. Modes

A mode is a config file, not code. Adding a mode is a commit.

```yaml
# modes/tutor.yaml
id: tutor
label: Tutor
prompt_fragment: prompts/modes/tutor.md
scope:
  read:  ["**"]
  write: ["sessions/**"]
tools: [retrieve, footnote, session_end]
session_template: templates/tutor-session.md
```

Initial set: `study-partner`, `tutor`, `creative`, `review`.

Mode controls **scope, tools, and output shape.** Nothing else.

### 3.1 Groundedness reporting (all modes)

When a response would rest on material the archive does not contain, the agent says so
explicitly rather than filling the gap from general knowledge. Phrasing is
mode-appropriate but the mechanism is one:

| Mode | Report |
|---|---|
| `tutor` | concept not covered in your notes — further study required |
| `creative` | no prior thread on this exists in the archive |
| `review` | this decision was never recorded |
| `study-partner` | nothing captured on this |

This makes the archive's edges visible everywhere, not only when studying. A gap you can
see is a gap you can close.

**Distinguish absence from retrieval failure.** *Not in the archive* and *not found by
this query* are different claims, and only the first is true. Every groundedness report
carries what was searched — scope, query terms, index generation. A confident
"undocumented" on a retrieval miss sends you off to re-learn something you already
captured; surfacing the search makes a bad index diagnosable instead of authoritative.

Reports append to open threads (§5.4).

### 3.2 Tutor mode contract

Tutor mode is defined by three rules, enforced in its prompt fragment and testable
independently of the medium.

**1. No solutions.** It may ask questions, name the concept in play, check a single
stated step, and identify where reasoning broke. It may not produce the final result.

Do not rely on voice to enforce this. "The answer is 4" is one second of audio — and a
spoken answer is absorbed more passively than a written one, with none of the friction of
a worked page you could have covered up. The constraint is a mode property, not a
property of the interface.

**2. Redirect to sources of truth.** When the response would be an answer, it instead
points back to the material where the answer is derivable: your lecture notes, your own
write-up of the concept, the textbook example. The response is a citation, which means it
either has grounding or visibly does not.

**Retrieval precedence for tutor mode:**

1. your own notes and prior sessions
2. ingested `reference` material
3. — no third tier —

Your phrasing of a concept beats the textbook's for recall. Falling through to tier 2 is
itself a signal that your capture on that topic is thin.

**3. Hard stop when ungrounded.** If neither tier yields the concept, the agent reports
the gap (§3.1) and stops. **No fallback to general explanation**, and none available on
request within tutor mode. Explanation of uncovered material is a different activity and
belongs in a different mode with its ungrounded status marked.

**Reveal-after-commit.** A tutor that can never confirm anything gets abandoned. The
escape hatch is a Tier 0 sequence: state your answer aloud, then the unlock phrase.
Confirmation unlocks only after commitment. Asking cold remains blocked — committing then
checking is legitimate practice; the sequence enforces the ordering.

---

## 4. Agent identity (new in v2)

Two independent fields, persisted **per archive** — the agent working your novel archive
can differ from the one working the QA archive.

### 4.1 Name

Free-text. Used for:

- self-reference in conversation
- attribution in session frontmatter
- session file signing

**Not** used as a wake word. Wake activation is a separate, fixed mechanism
(push-to-talk, or one trained wake phrase). Custom wake-word training per name is a
deferred power-user feature — it requires ~5–10 minutes of recorded samples per phrase
and cannot be produced from a text field at runtime.

### 4.2 Personality

Dropdown, selecting a prompt fragment. Personality controls **tone and register only.**

Proposed axes (pick one preset, each a point in this space):

| Preset | Register | Verbosity |
|---|---|---|
| `plain` | neutral | terse |
| `warm` | encouraging | moderate |
| `dry` | wry, understated | terse |
| `socratic` | question-forward | moderate |
| `expansive` | discursive, associative | high |

**Invariant across all presets:** willingness to disagree, correct, and push back.
A purely agreeable preset would make `tutor` and `study-partner` worthless — the value
in those modes is being told you're wrong. Personality changes *how* that lands, never
*whether* it happens.

### 4.3 Prompt composition

```
system_prompt = base
              + mode.prompt_fragment
              + personality.prompt_fragment
              + identity_block(name)
              + archive_context
```

Four separate files, composed. No hand-written mode×personality combinations.

### 4.4 Hard boundary

Identity and personality affect **conversation only.** They never reach:

- the raw transcript (verbatim, unstyled)
- the derived structure (headings, tags, summary, index)

Rationale: derived structure is regenerable. If personality bled into it, re-running the
post-session pass a year from now under a different preset would produce a different
index, and the archive would drift in ways no amount of reprocessing could correct.
Name is recorded as frontmatter metadata — a fact about the session, not a style applied
to it.

---

## 5. Session lifecycle

### 5.1 Entry

Entry point is friction — the user opens this *because* they're stuck. Intake must not
feel like a form.

1. Toggle on. **Buffering begins immediately**, to a scratch file.
2. Greeting. Single open prompt.
3. **Parse the first utterance for intent.** It usually carries archive, specificity,
   and subject already ("I'm stuck on the Act II mission chapters"). Extract what's
   present.
4. Ask only for what is genuinely missing. Questions are fallback, not protocol.
5. Once scope resolves, commit: create session folder, flush buffer into it, write
   frontmatter, surface deep links to related prior sessions.

If the user aborts before commit, discard the buffer.

The frustrated preamble captured in step 1 is frequently the most diagnostic content in
the session. It must not be lost to intake.

### 5.2 During

- Transcript appends to disk **continuously.** Never held in memory pending a final
  write. A ninety-minute session lost to a crashed process is the failure that gets the
  tool abandoned.
- Explicit footnote (Tier 0 phrase) → written to transcript at timestamp, deterministic.
- Ambient "highlight" → **not** decided live. Deferred to §5.4.

### 5.3 Exit — three paths

| Path | Trigger | Behavior |
|---|---|---|
| Phrase | end-phrase registry hit | prompt to confirm, then close |
| Idle | silence beyond threshold | prompt to confirm, then close |
| Crash | process death | transcript already on disk; recovered on next launch |

Phrase-based end **always** confirms. An end-phrase library will eventually fire
mid-sentence.

### 5.4 Post-session pass

Runs over the committed transcript. Produces the derived layer:

- cleanup (ASR disfluencies, punctuation, misheard proper nouns)
- headings and section boundaries
- topic tags, summary, frontmatter enrichment
- **proposed highlights** — the ambient "verses of note"
- **open threads** — questions raised and not resolved, concepts applied inconsistently,
  points where the conversation stalled

All of this is **regenerable.** Re-runnable across the entire historical archive when the
prompts improve.

**Derivation yields to markers.** Markers (§5.6) are the primary annotation mechanism;
derivation is the fallback. The pass still runs over the entire transcript — but where a
marker covers a span, derivation output for that span is discarded, and where none does,
output is proposed at low confidence and queued for review.

Running everywhere is deliberate. A marker you forgot to say is indistinguishable from
nothing worth marking, so a pass that only ran over unmarked-and-declared-interesting
regions could never catch the session where you got tired and stopped tagging. Yielding
gives you markers as ground truth without losing the net.

Open threads are the tutor's working memory across sessions. A tutor that resumes where
the syllabus says you should be is not much use; one that resumes where you actually
stalled is. Same structure as the error index produced from ingested work (§5.5) — they
are one index, written from three sources: markers, derivation, and ingest.

### 5.5 Ingest — externally authored material

Notes, worked problems, code, and reference material brought in from outside a session.
A third content type: not transcript, not derived. Immutable, authored elsewhere.

```
<archive>/
  ingest/
    2026-08-17-linalg-pset4/
      source/            ← original file, never modified
      meta.yaml          ← declared type, date authored, subject, session links
      parsed.md          ← derived: extraction + error index
```

**Type is declared by the user at ingest, never inferred by the system.** See §10.1.

Rationale: a worked problem set and a set of reference notes are the same shape to a
classifier and completely different to a tutor. One is evidence of your understanding at
a moment in time; the other is material to learn from. Guessing wrong is silent and
produces a tutor working from a false model of what you know. Declaration costs one field
and removes the failure mode entirely.

Ingested material carries provenance marking through retrieval, so it never surfaces as
though it were something concluded in conversation.

**Parse output depends on declared type.** For `worked-problem`, the useful extraction is
not a summary — it is the **error index**: where the reasoning broke, which step was
skipped, which concept was applied correctly in one place and not another. That feeds
directly into the open-threads structure from §5.4.

**Scanned handwriting requires a verification step before parse output is trusted.** OCR
on handwritten math is unreliable, and a misread exponent produces a tutor confidently
teaching a correction to an error you did not make. Typed work, code files, and text
documents bypass this.

**Solutions partition.** Textbook material frequently ships with its answers — keys in
the back, fully worked examples, a solutions manual. Ingested as plain `reference`, that
material is retrievable by tutor mode, which then leaks answers neither of you intended.

Ingest therefore carries a `contains_solutions` flag. Flagged material lands in a
retrieval partition that `tutor` cannot read and `review` can. Set it at ingest (§10.1);
when unsure, set it — a false positive costs one retrieval tier, a false negative
defeats the entire tutor contract.

For mixed documents, split at ingest rather than flagging the whole file: chapters into
`reference`, the answer appendix into the partition.

### 5.6 Markers and the legend

Spoken annotations made **during** thinking rather than inferred from it afterward. A
derivation pass guessing "he sounded unsure here" is soft; you saying `known error` is
ground truth. Markers therefore write to the append-only transcript layer, not the
regenerable one.

Markers are the **default** annotation mechanism. Derivation is the fallback (§5.4).

**Two namespaces, kept distinct.**

| Namespace | Purpose | Shape | Effect |
|---|---|---|---|
| control | session lifecycle, macros | imperative — sounds like a command | *does* something (Tier 0, §2.3) |
| tag | annotation | labeled — sounds like a label | *records* something |

Distinct phrase shapes matter because a misfire across namespaces behaves like the wrong
kind of thing entirely. Tags also fire silently and are never confirmed, so they carry a
distinctive leading particle (`mark:` or similar) to survive ordinary speech — you will
eventually say "that's a known error in the compiler" and mean it descriptively.

**Span behavior: markers scope forward.** A tag opens a span; the next utterance boundary
closes it. Paired open/close markers exist for longer stretches. Backward-scoping would
require inferring where the relevant passage began, which reintroduces exactly the
guessing markers exist to remove.

**The legend is one versioned file.**

```yaml
# legend.yaml
- phrase: "mark known error"
  namespace: tag
  id: known-error
  span: forward
  writes: [transcript, error-index]
```

Both you and the agent read the same file. That is what makes "we understand each other"
a property of the system rather than an assumption — and it means the language you are
inventing survives your forgetting it.

**Start small.** Five or six tags you will actually remember beats twenty you will not.
Suggested initial set: `known-error`, `confusion`, `insight`, `resolved`, `revisit`. The
archive will tell you what is missing — if you keep reaching for a marker that does not
exist, add it then.

### 5.7 Clarification behavior

When the agent cannot resolve something, it asks. This substitutes for elaborate marker
taxonomy: two-way conversation is already available, and using it is cheaper than
encoding every case in the legend.

Timing is split by cost, because the session was opened to think and interruption is
expensive:

| Ambiguity | Timing | Rationale |
|---|---|---|
| Span or scope of a marker | **ask immediately** | one word resolves it; deferring means reconstructing where you were |
| Meaning, topic, or intent | **defer to end-of-session queue** | interrupting to ask *what did you mean* breaks the thinking |
| Which archive or mode | ask at intake (§5.1) | already part of scoping |

Deferred questions surface in the post-session review alongside proposed derivation
output, so both get answered in one pass.

---

## 6. Capabilities, privilege, and trust boundaries

The agent runs on a single fixed home device. It is intended to be resident, and over
time to hold real capability on that machine — file generation, code execution, model
calls, web reads.

Those two properties are in tension. This section is how they are reconciled: capability
is **requested upward and expires**, never held resident.

### 6.0 Device scope

Home device only. Never a portable device, never a work-issued device.

This is enforced structurally rather than by habit:

- No work repositories, customer data, or employer-internal material inside any archive
  the agent can scope to.
- The archive root allowlist is explicit. There is no "scope to arbitrary directory"
  path.

Making it structural means it never becomes a question of remembering at 11pm.

### 6.1 Process split by privilege

Three processes, not one. The always-on component is deliberately the least capable
thing in the system.

| Process | Lifetime | Capability |
|---|---|---|
| **Listener** | resident, always on | mic, VAD, wake/phrase detection. **No filesystem write. No network.** |
| **Core** | per session | archive read/write within mode scope (§3). No execution. |
| **Executor** | per task, dies on completion | code execution, shell, model calls, web fetch — each individually granted |

A resident process holding full system capability is a large surface for both attack and
accident. Splitting it means the 24/7 attack surface is a microphone listener that can
only emit an event.

Escalation is one-directional: Listener wakes Core; Core spawns Executor with an
explicit, narrow grant; Executor exits. No process retains a capability it is not
currently using.

### 6.2 Gate on reversibility, not sensitivity

Per-action yes/no prompts are a failure mode, not a safeguard. Fifty prompts a week
produces reflexive approval, and the gate becomes theater at exactly the moment it
matters.

Classify by whether the action can be undone:

| Class | Examples | Gate |
|---|---|---|
| Reversible | read in scope; write inside a git working tree | none — the diff *is* the undo |
| Bounded | model call within remaining budget; web fetch (read-only) | none, but logged and metered |
| Irreversible | deletion outside archive; network write/publish; package install; git history rewrite; anything spending money past cap | **explicit confirm** |

**Corollary: put every path the agent can write to under git.** Most of the frightening
category then collapses into the reversible one. Same mechanism as the Alena memory
repo, with a larger payoff here.

**Hard spend cap on API calls.** Money is the one action with no undo whatsoever. Cap is
a hard stop, not a warning — per-session and per-day, both enforced in the Executor, both
requiring an out-of-band change to raise.

### 6.3 Capabilities are declared, not negotiated

Capability grants live in the mode manifest (§3), scoped to paths. Extending the earlier
example:

```yaml
# modes/code.yaml
id: code
capabilities:
  fs_read:    ["~/projects/creative-archive/**"]
  fs_write:   ["~/projects/creative-archive/**"]   # git-tracked
  execute:    { cwd: "~/projects/creative-archive", network: false }
  model_call: { budget_usd_session: 2.00 }
  web_fetch:  false
```

```yaml
# modes/creative.yaml
id: creative
capabilities:
  fs_read:    ["<archive>/**"]
  fs_write:   ["<archive>/sessions/**"]
  execute:    false
  model_call: { budget_usd_session: 1.00 }
  web_fetch:  { read_only: true }
```

Declared capability requires no prompt. Prompts are reserved for genuinely out-of-scope
requests, which keeps them rare enough to actually be read. That rarity is the whole
point of the design.

### 6.4 The web-access boundary

The dangerous combination is a single session holding all three of:

1. the private archive,
2. fetched untrusted content,
3. execution or network-write capability.

Fetched pages can contain text shaped like instructions, and an agent with execution
rights may act on it. Mitigations, in order of importance:

- **Fetched content is data, never instruction.** It enters context clearly delimited and
  labeled as untrusted. It cannot introduce or modify tool calls.
- **`web_fetch` and `execute` are never granted to the same Executor instance.** If a
  task needs both, it is two tasks with a human-visible handoff between them.
- **`web_fetch` and network-write are never co-granted.** Read the web or write to the
  network, not both.

Designing this in now is far cheaper than retrofitting it after the executor exists.

### 6.5 Audit trail

Every capability exercise appends to a session-scoped, append-only log: timestamp,
process, capability, arguments, outcome, spend. Same discipline as the transcript —
ground truth, never edited.

This is what makes an incident diagnosable rather than mysterious, and it is a
prerequisite for granting any new capability, not a follow-up to it.

### 6.6 On "fully automated"

Worth stating the intended reading explicitly, because the phrase can mean two different
things.

**Automate the mechanism:** scoping, retrieval, transcript capture, derivation, tool
orchestration, session lifecycle. All of it, with no human in the loop. This is the bulk
of the work and where nearly all the time savings live.

**Keep the human at irreversible boundaries.** Not as a concession, and not as
incomplete automation — the confirm step costs seconds and is precisely what makes it
reasonable to hand the system real capability in the first place. An agent you trust with
`rm` unsupervised is an agent you will eventually stop running.

---

## 7. Storage

```
<archive>/
  sessions/
    2026-08-17T1432Z-a7f3/          ← immutable ID, never renamed
      transcript.md                 ← append-only, ground truth
      session.md                    ← derived: structure, summary, highlights
      footnotes.md                  ← explicit marks
      meta.yaml                     ← mode, agent name, personality, links
```

**Folder names are timestamp IDs, not subjects.** Human-readable title lives in
frontmatter. If the folder name were the subject, renaming one would break every deep
link pointing at it.

### 7.1 The episodic/derived split

- `transcript.md` — append-only, never edited. Ground truth.
- everything else — derived, disposable, regenerable.

This is the same split as the three-tier memory model in the Alena design, and it exists
for the same reason: it lets the processing layer improve without ever putting the source
at risk.

---

## 8. Retrieval

Start structural. Add semantic only when structural demonstrably fails.

**Phase 1 — structural (build this first):**

- SQLite FTS5 over the markdown corpus
- frontmatter index: date, mode, agent, tags, headings
- supports: exact date ranges, heading lookup, tag filter, full-text

Covers "by date and time" and "by subject and heading" completely, with no ML, no
embedding drift, and — critically — **debuggable results.** When a query returns the
wrong thing you can see exactly why.

**Phase 2 — semantic (deferred):**

Second retrieval path, not a replacement. Added only when "what did we say about X"
starts failing structurally.

**Constraint:** "general question → search the whole archive" means *retrieve top-ranked
spans across the archive*, never *load the archive*. Return spans with deep links. An
hour of speech is a large amount of text; a long session in a mature archive will
otherwise exhaust context.

---

## 9. Build order

1. Core + text adapter. Modes, identity composition, session lifecycle, storage.
2. Structural retrieval (FTS5 + frontmatter index).
3. Post-session derivation pass.
4. Ingest path (§5.5) + declared-type manifest.
5. Voice adapter — Tier 1 (VAD/STT/TTS) only.
6. Voice adapter — Tier 0 phrase registry.
7. Backfill: re-run derivation across v1 archive content.
8. Process split (§6.1) + capability manifests. **Before** any executor capability ships.
9. Executor: file generation, then code execution, then web read. One at a time, each
   with its audit trail working before the next is added.

Steps 1–4 are the product. Steps 5–6 are an interface to it. Steps 8–9 are where the
risk lives, and they come last for that reason — not because they matter least, but
because the containment has to exist before the capability does.

---

## 10. Usage contract — the human's responsibilities

Some things this system needs cannot be inferred, and should not be. This section is the
operating manual for the person using it. It is not implementation guidance; it is the
set of rules that make the implementation correct.

Design stance: **where a wrong guess would be silent, require a declaration instead.** A
misclassification the user never sees is worse than a field the user has to fill in.

### 10.1 Declare the type of anything you ingest

Every ingested item requires a declared type. The system will not classify it.

| Type | Meaning | Parse behavior |
|---|---|---|
| `worked-problem` | Work you attempted. Evidence of your current understanding. | error index — where reasoning broke |
| `reference` | Material authored by someone else, to learn from. | extraction + indexing, no error analysis |
| `notes` | Your own notes, not attempted work. | extraction + indexing |
| `artifact` | Code, drafts, outputs. Subject of discussion, not evidence. | structural summary only |

Also declare: **date authored** (not date uploaded — they are frequently far apart and
the tutor reasons over the former), and **subject**.

If you don't know the type, it is `notes`. Never guess upward into `worked-problem`;
that is the type that changes what the tutor believes about you.

**Flag anything containing solutions.** Answer keys, worked examples, solutions manuals —
set `contains_solutions` at ingest. Tutor mode cannot read the partition it routes to;
review mode can. When unsure, set the flag: a false positive costs one retrieval tier, a
false negative quietly defeats the no-solutions contract (§3.2). Split mixed documents at
ingest rather than flagging the whole file.

### 10.2 Verify OCR on anything handwritten

Scanned handwriting gets a verification pass before its parse output enters the archive.
Read the extraction, correct it, then commit. Skipping this produces a tutor teaching
corrections to errors you did not make — and because the mistake lives in the archive,
it compounds across sessions.

Typed work, code, and text documents skip this.

### 10.3 Occasionally ingest the work you avoided

The error index is built from what you upload, and you will naturally upload what you
finished. Problems you bounced off entirely never enter the archive, so the index
systematically under-represents your actual gaps — and the tutor's model of you drifts
optimistic.

This is not fixable in software. The compensation is deliberate: periodically ingest
abandoned attempts, blank pages, and the assignment you skipped, marked
`worked-problem`. It is precisely the material you will not feel like uploading, which
is why it is a documented rule rather than an intention.

### 10.4 Mark as you go

Markers are the primary annotation mechanism (§5.6), which makes them your job. The
system's derivation fallback exists for the session you were tired, not as the normal
path — if it becomes the normal path, annotation quality drops to whatever a model can
infer from a transcript, which is materially worse than what you know while speaking.

Know your own legend. It is one file, it is short, and you wrote it.

### 10.5 Confirm irreversible actions attentively

The gate design in §6.2 depends on prompts being rare. If confirmation becomes
reflexive, the safety property is gone and nothing in the code will tell you. If you
notice yourself approving without reading, that is a signal the capability scopes in
§6.3 are too narrow — widen the declared scope rather than absorbing the prompts.

### 10.6 Keep work material out

No employer repositories, customer data, or internal material in any archive scope
(§6.0). This is a rule about what you put in, not something the system can enforce for
you.

### 10.7 Correct the archive when it is wrong

Derived content is regenerable and safe to fix. Transcripts and ingested sources are
ground truth and never edited — if a transcript is wrong, annotate it, don't rewrite it.
The distinction is what makes reprocessing safe years from now.

---

## 11. Open decisions

- **Runtime.** Tauri desktop app (consistent with the manuscript feedback tool) vs.
  headless daemon + thin clients. Daemon is more composable; Tauri is one artifact.
- **STT engine.** Streaming-capable and local — Parakeet TDT, faster-whisper, or
  sherpa-onnx. Decide after measuring on your own audio, not on leaderboard WER.
- **Wake mechanism.** Push-to-talk vs. one fixed trained wake phrase.
- **Cleanup pass model.** Local vs. hosted. Hosted is better at proper nouns; local
  keeps the archive sealed.
- **Personality persistence granularity.** Per archive (proposed) vs. per mode vs. per
  session.
- **Licensing.** Component licenses vary and matter if any of this ships commercially.
  sherpa-onnx and LiveKit Agents are Apache-2.0; Piper's maintained fork is GPL. Audit
  before distribution.
- **Executor isolation depth.** Subprocess with a restricted user vs. container. Container
  is stronger and slower to start; subprocess is likely sufficient given single-device,
  single-user scope.
- **Spend cap values.** Per-session and per-day figures, and what the out-of-band raise
  procedure is.
- **Confirm channel for irreversible actions.** Spoken confirm is convenient but shares a
  failure mode with the end-phrase problem (§5.3) — misrecognition. A typed or physical
  confirm may be warranted specifically for the irreversible class.
- **Idle behavior of the Listener.** Fully resident vs. scheduled active windows. Active
  windows reduce the always-on surface further at some cost to spontaneity.
