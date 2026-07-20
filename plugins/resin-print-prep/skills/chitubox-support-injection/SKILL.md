---
name: chitubox-support-injection
description: Write native, EDITABLE supports (and raft bridges) directly into CHITUBOX project files (.chitubox) by injecting reverse-engineered support records - so externally generated supports behave exactly like Chitubox's own (selectable, movable, deletable, overlap rules respected). Use whenever the user wants to add/import supports into Chitubox from outside, edit .chitubox files programmatically, understand the .chitubox format, or wire a support generator into a Chitubox workflow. Also use when a new Chitubox version needs the format re-verified.
---

# CHITUBOX Support Injection

STL cannot carry support semantics -- anything imported becomes plain
model geometry. The only way to hand Chitubox supports it will treat AS
supports is to write its own project format. This skill documents that
format (reverse-engineered, CHITUBOX Basic 1.3.0) and provides a
validated injector.

**Read `references/chitubox-format.md` before touching bytes** -- it is
the complete field map, the list of known unknowns, and the validation
history. The injector is `${CLAUDE_PLUGIN_ROOT}/scripts/chitubox_inject.py`
(pure Python + numpy; read its docstring for the API and for which
operations are Chitubox-validated vs merely geometry-verified).

## The workflow

1. The user saves a project in THEIR Chitubox: model placed/oriented/
   lifted, ideally with at least one support and a raft bridge already
   present (templates to clone; also carries placement metadata).
2. Parse with `Project(path)` -- it self-checks record contiguity and
   pointer uniqueness, and refuses on drift.
3. Build new records: `clone_support()` (validated) for translated
   copies; `make_bridge()` (validated) for raft connections between
   feet; from-scratch segment meshes are NOT yet validated -- prefer
   cloning until they are.
4. `write()` to a NEW file (never overwrite the user's project), have
   the user open it and verify: loads, correct support count, new
   supports selectable/movable/deletable, slices.

## Why injection into a Chitubox-written container (design doctrine)

Never author files from scratch: clone + patch means every byte we do
not understand stays exactly as Chitubox wrote it. The pointer graph is
small (one index, one pointer to it); everything else is offset-stable
under append-and-shift. This is what makes the approach robust despite
the format being only partially mapped.

## Format drift protocol (new Chitubox version)

Re-run the specimen ladder from the reference doc: empty project ->
+model -> +1 support -> move that support -> +2nd support (raft appears)
-> magic-support a rotated model. Diff each step. The record magic,
72-byte stride, and index pair are the things to re-locate first; the
`Project` parser's asserts are designed to fail loudly on drift.

## Companion (planned)

A support *placement* skill ("magic support" equivalent: island
detection, density sampling, routing, raft MST) will generate the
support descriptions that this skill injects. Until it exists, this
skill is used with manually specified or cloned support positions.
