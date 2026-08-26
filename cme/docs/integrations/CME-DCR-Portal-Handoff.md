# CME → DCR Portal — Promotion Log

## 2026-08-26 · domain layer promoted, UI layer partial

**CME source:** `construction-modeling-engine` folder handed over 2026-08-26,
327 tests passing, production build passing.
**Portal destination:** commits `51c32db`, `a0fc612`, `7cd5568` on `main`.
**Portal state before:** `19bd23a` (branch `cme-pre-merge-backup` preserves it).
**Result:** 175 Portal tests passing.

### The thing that governed every decision

The handed-over folder is **not a newer copy** of the Portal's CME. It is a
branch *of* it, taken at a point and developed further while the Portal was
also developed further. Its `framing-standard.js` still carries the Portal's
own comments verbatim.

So each side held work the other lacked, and copying either direction would
have destroyed shipped features silently. A parallel diff of the eight shared
modules confirmed the direction: **start from the Portal and graft upstream's
additions in.** The reverse was attempted first and kept surfacing losses one
at a time — that is how most of the "preserved" list below was found: by
reading both files, not by waiting for a crash.

### Adopted from CME

| Area | What |
|---|---|
| New modules | `joist-blocking`, `ledger`, `rim-joist`, `stair-framing` |
| Standards | California deck beam/joist span tables, `DCR_DEFAULT_POST_BASE` |
| Annotations | `core/annotations/framing-layer.js` |
| Framing | Beams and joists planned in **commercial stock**; post locations deduplicated on a 1-inch grid, so a drawn post on a beam end is one post |
| Railing | Wild Hog track as a 6 ft **kit** (one per panel); handrail planned per run so joints land at posts; shared angled corner defaults to one post |
| Takeoff | `consolidateTakeoffLines` — a purchasing view grouping identical stock across construction roles |
| Schema | Edge properties → v2, `attachments.ledger` / `rimJoist` defaulting to `null` so existing House Attachment edges keep behaving as before |

### Preserved in the Portal — CME has none of it

`symbols` (count pins, gates, doors, windows) · stick-built and Trex railing ·
gate netting that shortens a Wild Hog run · the two-note model
(`calculationNote` + stored `notes`) · cut-from-stock `yieldLine` ·
editable line descriptions · the fascia waste rate · the deck-screw recipe ·
the richer length parser (fractions) · the Sales Hub origin allowlist ·
`construction.deckLevelInches` · the whole portal seam
(`boot.js`, `portal-bridge.js`, `cme.html`, `cme-launcher.js`).

### Regressions introduced by the merge, and fixed

- **Beams double-counted.** Upstream moved stock planning into `beam.js` while
  the Portal still had it in `framing-standard.js`. Both ran: a 24 ft run
  ordered four 12 ft boards. `framing-standard` is retired from the takeoff.
- **Ledger fasteners vanished.** Upstream's ledger module plans the board and
  stops; the SDWS screws and J flashing lived in the retired
  `framing-standard`. Restored, and no longer gated behind a deck level being
  set — that gate meant any drawing without one ordered zero fasteners.

### Deliberately NOT promoted

**`stairs/stair.js` stays on the Portal version.** Upstream's stops a hosted
stair deforming its Deck Boundary, which is the better model, but it also:

1. drops the stair footprint out of `deckSF` — and that figure is multiplied by
   a historical dollar-per-square-foot rate calibrated on **gross** areas, so
   taking it would quietly reprice every job; and
2. stops a railing hosted on a stair opening from billing at all.

Both are money decisions, not merge mechanics. They need an owner's answer.

**The UI layer is not merged.** Upstream's `app.js` is 4402 lines against the
Portal's 4126 with both sides changed, and the handoff is explicit that Portal
UI is *adapted*, never copied. Promoted so far: the detailed/consolidated
takeoff switch. Still to adapt: Joist Field editing and Rim/Flush controls, the
manual Post/Footing tool, selectable railing posts and the double-post corner,
and CRC beam profiles with live post spacing.

### Intentional differences

- Two Portal tests were retired where `framing-takeoff.test.mjs` covers the
  same ground against the new contract.
- The L-corner test now expects **five** posts, not six, per the handoff's
  stated rule: a shared angled corner is one post unless Double post corner is
  chosen.
- `portal-merge.test.mjs` was added: eight tests pinning the seams above, each
  covering something that was silently dropped during this integration.
