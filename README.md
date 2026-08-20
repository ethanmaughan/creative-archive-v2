# Creative Archive v2 — core, text adapter, retrieval

The conversational layer over a local markdown archive: a headless core that owns archive
scoping, modes, identity, and session lifecycle, with adapters attaching over a socket.

**This is not a voice project.** It is v1 plus a transcript writer, with an audio adapter
attached at the edge — later. Everything here works with the microphone unplugged, because
there is no microphone.

Build order §9 **steps 1–2**: core plus the text adapter, and structural retrieval over the
archive. Derivation, ingest, voice, and the executor are not here and are not stubbed.

The design document is [`docs/spec.md`](docs/spec.md). Every `§` reference in this repo —
in the code, the tests, and the commit messages — points into it, and
[`docs/decisions.md`](docs/decisions.md) records where the implementation settled something
the spec left open or deliberately departed from it.

## Running it

Requires node 24.18 (`mise install`) and pnpm 11. There is no build step — node runs the
TypeScript directly by stripping types.

```sh
pnpm install

# 1. Allow an archive. Deliberately manual: nothing in the system can add an entry (§6.0).
#    The archive must also be inside a git working tree (D-008).
mkdir -p ~/Library/Application\ Support/creative-archive
cat > ~/Library/Application\ Support/creative-archive/archives.yaml <<'YAML'
archives:
  - /Users/you/archives/notes
YAML

# 2. Start the core.
pnpm daemon

# 3. Attach a client.
pnpm text --archive ~/archives/notes --mode creative
```

Inside the text adapter: plain text is a turn; `/search <query>`, `/footnote <text>`,
`/end` then `/yes` or `/no`, `/abort`, `/name <x>`, `/personality <x>`, `/modes`, `/index`,
`/reindex`, `/status`, `/quit`.

By default the core talks to a deterministic in-process fake, so starting it reaches
nothing outside the machine. For real replies, point it at a local model:

```sh
CREATIVE_ARCHIVE_MODEL=ollama:llama3.1 pnpm daemon
```

Environment: `CREATIVE_ARCHIVE_STATE_DIR`, `CREATIVE_ARCHIVE_SOCKET`,
`CREATIVE_ARCHIVE_MODEL`, `CREATIVE_ARCHIVE_IDLE_MS` (0 disables the idle prompt),
`OLLAMA_HOST`.

## What a session leaves on disk

```
<archive>/
  .creative-archive/          core state — not in any mode's scope
    identity.yaml             name + personality, per archive (D-003)
    open-session.yaml         crash marker; present only while a session is open
    scratch/                  pre-commit buffers
  sessions/
    2026-08-18T2014Z-4b9f/    immutable id, never renamed (§7)
      transcript.md           append-only ground truth, both sides (D-004)
      meta.yaml               derived metadata; the human-readable title lives here
```

`transcript.md` is the only file here that is not regenerable. Everything else is derived
and safe to correct (§7.1, §10.7).

## Retrieval

Structural only (§8 phase 1), in process, no database (D-005). The index is built from the
files when a client attaches and rebuilt when a session closes — delete nothing, lose
nothing. Notes split into spans at headings; a session's turns are each their own span, with
metadata read from the sibling `meta.yaml`. Searches return **spans with deep links**, never
whole documents.

```
eigenvector tag:linalg after:2026-01 heading:"row reduction" in:session limit:5
```

`tag:` `after:` `before:` `heading:` `mode:` `in:` (`note` or `session`) `limit:`. Keys are
whitelisted, and anything unrecognized comes back reported rather than silently dropped.

Every result carries what was searched — terms, filters, scope, index generation, how many
spans passed the filters — because §3.1 turns on separating _not in the archive_ from _not
found by this query_. Three outcomes stay distinct: filters removed everything, nothing
matched, or only some terms matched (`matchMode: any`, surfaced rather than buried in the
ranking). Mode read scope applies to retrieval before ranking, so an out-of-scope document
can neither take a result slot nor move the scores.

The model has no tool calling yet, so retrieval runs automatically each turn on what you just
said (D-013), and `/search` runs it by hand. Measured cost on a 28.6 MB / 5,500-document
archive: ~2–4 s to build, 153 MB retained, 3–10 ms per query.

## Layout

```
src/
  core/          text in, text out. Knows nothing about adapters — enforced by lint and test.
    archive/     allowlist + git gates
    storage/     append-only log, scope-enforcing file store
    modes/       manifest loading and validation
    identity/    name + personality presets
    prompt/      §4.3 composition
    session/     intake, transcript, meta, recovery
    retrieval/   scanner, in-process index, query language, the retrieve tool
    model/       ModelClient port, scripted fake, Ollama
    daemon/      the socket server
  protocol/      the wire contract, shared by both sides
  adapters/
    text/        the reference client and the test harness
config/          mode manifests, prompt fragments, session templates
docs/decisions.md
```

## The invariants, and where they are tested

| Invariant                                        | Test                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Append-only transcript survives a killed process | `tests/invariants/append-only-survives-kill.spec.ts` — spawns a real process and SIGKILLs it mid-session     |
| A killed session recovers on next launch         | `tests/invariants/session-recovery.spec.ts`                                                                  |
| Personality does not reach the archive layer     | `tests/invariants/personality-invariance.spec.ts` — in the form step 1 can prove; read the note in that file |
| Mode scope prevents out-of-scope writes          | `tests/invariants/mode-scope.spec.ts`                                                                        |
| The core does not depend on any adapter          | `tests/invariants/core-independence.spec.ts`                                                                 |
| Mode scope applies to retrieval, not just files  | `tests/retrieval/retrieve.spec.ts`                                                                           |
| A finished session is searchable in the next one | `tests/daemon/retrieval.spec.ts`                                                                             |

```sh
pnpm verify    # typecheck, lint, test
```

## Reading order

`docs/spec.md` for the design, then `docs/decisions.md` — it records what was settled
during the build, what deviates from the spec and why, and what is still open.
`src/core/session/session.ts` is the centre of the system; the comment above `commit()`
explains why the buffer is renamed rather than rewritten, which is the single most
load-bearing decision in the file.
