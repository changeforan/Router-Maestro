# Maestro Yards — Router-Maestro's request lifecycle, drawn as a town

An isometric, self-narrating explorable of what happens to a single inbound API
request between the moment a client posts it and the moment the last byte of the
response goes back out. One dependency-free static page: open `index.html` in a
browser. No build step, no network calls, no framework.

The subject is the **inbound request lifecycle** — auth gate, protocol dialect,
model resolution, capability-aware route planning, the provider attempt loop
with fallback, and the guarded stream out. That is Router-Maestro's actual
function; the `web_search` loop and the admin surface are deliberately out of
scope.

## Running it

```
open index.html                     # file:// works — there are no fetches
python3 -m http.server 8000         # or serve it, if you prefer
```

Headless check, from a scratch directory with `playwright` installed
(`npm i playwright && npx playwright install chromium`):

```
node /path/to/docs/explainer/smoke.mjs http://localhost:8000/
```

It fails on any console or page error, drives the van through every station on
both the delivered and the refused path, and writes two screenshots. A canvas
app fails silently — an exception in the frame loop leaves an empty canvas on a
page that still looks perfectly fine — so this is the only cheap way to know the
page works.

## The town

The road is the code path. The avenue west to east is everything the proxy does
before it will name a model; the ring road east of the Dispatch Tower is one
attempt at one provider, and a retryable failure sends the van round it again
with the next candidate. The response comes home on its own road along the
south. A request refused at a checkpoint reverses down the avenue it came up.

| # | Station | What it is | Source |
|---|---------|-----------|--------|
| 1 | Client Desk | The request is composed: dialect, model asked for, turns, tools, file context, image | — |
| 2 | Gatehouse | `verify_api_key` — every router is mounted behind it; a bad key is a 401 and nothing else happens | `server/app.py:214-221` |
| 3 | Customs House | The client's dialect (OpenAI chat, Codex `/responses`, Anthropic Messages, Gemini) is translated into one canonical request, and the `Operation` is fixed | `server/translation.py`, `routing/capabilities.py` |
| 4 | Weighbridge | Token accounting: per-message overhead, tool schemas with their safety margin, image tiles, reply priming | `utils/tokens.py`, `utils/token_config.py:33` |
| 5 | Naming Office | Alias → concrete `provider/model`: normalisation, date-suffix stripping, `WRatio` scoring, family selection, newest-version tiebreak, ambiguity check | `utils/model_match.py`, `utils/model_sort.py` |
| 6 | Inspection Shed | Three-valued capability support per candidate; `[*supported, *unknown]`, unsupported dropped | `routing/router.py:1033` `_rank_compatible` |
| 7 | Dispatch Tower | The frozen route plan: primary + `pool[:maxRetries]`, under the chosen fallback strategy | `routing/router.py:1077,1138` |
| 8 | Key Mint | The upstream credential for the chosen provider | `providers/*.py` |
| 9 | Codec Dock | The canonical request is re-encoded into the *provider's* dialect — which may be a different one from the client's | `server/translation.py`, `providers/base.py` |
| 10 | Upstream Gate | The one call that costs real time. The status is classified; retryable or not decides the next move | `providers/base.py:559-596`, `routing/attempts.py:61` |
| 11 | Guard Tunnel | The leak guard's bounded prefix matchers read the stream delta by delta: abort tags abort, `<invoke>` is recovered into a tool call | `pipeline/leak_guard.py` |
| 12 | Wire Room | The provider's stream is reduced back into the client's dialect | `server/routes/*.py` |
| 13 | Delivery Bay | What the client actually got, with the whole attempt ledger | — |
| — | Turned Back | The lay-by a refused request ends at, sharing the Delivery Bay's write-up | — |

## Fidelity ledger

For every number on screen you should be able to answer "where does that come
from?" with a file and a line. This is that answer. The same ledger is in the
page's **About & accuracy** modal.

### Genuinely computed

Live, in your browser, in `js/model.js`, ported function for function from the
repository:

- **Token accounting** — three tokens of overhead per message, one for a name,
  sixteen flat for having tools plus eight per tool and a 1.1× safety margin on
  every schema, three for reply priming (`utils/token_config.py`).
- **Image tile cost** (`utils/tokens.py`).
- **The context budget formula** (`utils/context_window.py`), including the rule
  that caps effective output at 15% of the prompt budget.
- **Alias resolution** — normalisation, date-suffix stripping, family selection
  and the newest-version tiebreak (`utils/model_match.py`, `utils/model_sort.py`),
  with the real thresholds: 80 to be considered, 85 to be confident, and two
  families within one point of each other is ambiguous rather than a guess.
  `WRatio`'s partial-ratio branch is implemented, not approximated — without it
  `opus-4-6` scores 75 against `claude-opus-4-6` and 404s.
- **Capability ranking** — three-valued support, `[*supported, *unknown]`
  (`routing/capabilities.py`, `routing/router.py:1033`).
- **The route plan**, the fallback strategies and the frozen retry limit
  (`routing/router.py:1077`, `routing/route_plan.py`, `config/priorities.py`).
- **Upstream status classification** — `{429, 500, 502, 503, 504, 529}` retryable,
  everything else not — and the fallback decision, including the
  `UNSUPPORTED_OPERATION`-on-`UNKNOWN` special case (`providers/base.py:578`,
  `routing/attempts.py:61`).
- **The reasoning-tier ladder** and its highest-at-or-below-you clamp
  (`utils/reasoning.py`).
- **The leak guard's** bounded prefix matchers, which really do scan the streamed
  text delta by delta and really do recover `<invoke>` into a structured tool
  call (`pipeline/leak_guard.py`).

`model.js` is a plain IIFE, so the whole lesson is testable without a browser:

```
node -e 'global.window = global; require("./js/model.js");
         console.log(RM.resolveAlias("opus-4-6"));'
```

### Scaled down

A nine-model catalogue instead of a live one of hundreds; a conversation of a
few turns instead of a few hundred; a response of about twenty deltas. Text is
costed at three characters per token — the repository's own
`estimate_tokens_from_char_count` — because there is no tiktoken BPE table in a
browser, so **every token figure here is an estimate of an estimate**. The file
context you dial in is costed by character count rather than by materialising
half a megabyte of source. The blocks on the weighbridge are one per 2,000
tokens; the crates on the van are one per 4,000 prompt tokens outbound and one
per 25 output tokens on the way home. Both crate scales are printed on the van's
plate, because two scales is a compromise.

### Sourced

The GitHub Copilot prompt and context-window limits are the catalogue figures
recorded in `docs/copilot-context-limits.md` (sweep of 2026-04-27). That document
also notes that the catalogue number is a soft recommendation several models
exceed in practice.

### Assumed / modelled

**Every millisecond.** Nothing here touches a network. The station costs are
order-of-magnitude figures chosen so the *shape* of the bill is right — the
upstream call dwarfs everything the proxy does, and the proxy's own time is
dominated by tokenising the prompt. With a default request the proxy's own work
is under a tenth of the total, and that ratio is the point of the latency panel,
not the magnitudes.

An oversized prompt is **modelled** as a 400 from the upstream. Router-Maestro
does not itself pre-reject an over-budget prompt (`calculate_context_budget` is
not called in the request path); modelling it upstream is what makes the reader
see a non-retryable failure stop the router dead with a healthy candidate
sitting right behind it. The capability flags, the max-output figures and the
non-Copilot limits are plausible, not fetched.

### Deliberately faked

The assistant's reply text is canned — nothing here ran a model — and the
upstream failures are dialled in by you rather than observed. What *is* real is
the scanner that reads that text and the policy that reads those statuses. Treat
the reply as scenery; treat the routing as the lesson.

### Known simplification

`_execute_stream_attempts` (`routing/router.py:1564`) pulls the **first chunk**
from a candidate before committing it to the client, so a dead provider is
swapped before the client sees a byte — and once the first byte is out, fallback
is impossible. `model.js` does not model that priming step: an attempt here
succeeds or fails atomically. The behaviour is described in the Upstream Gate's
write-up instead of being animated.

## File map

| File | Owner | What it is |
|------|-------|-----------|
| `index.html` | this project | Markup, HUD, dock controls, the About modal |
| `css/styles.css` | template + this project | The template's chrome, plus the panel widgets (`.plan`, `.ledger`, `.budget`, `.field.pick`) |
| `js/iso.js` | skill engine, unchanged | Isometric projection, solids, roads |
| `js/model.js` | this project | **The lesson.** ~1,300 lines of ported algorithm. `RM.compute(params)` returns one whole trip; every individual function is also exported so a panel never re-implements one |
| `js/world.js` | this project | The static place: 4 routes, 14 stations, 13 narrated districts, landmarks, scenery |
| `js/sim.js` | rewritten from the template | The state machine. Keeps the template's pacing engine verbatim; adds route control through a single `jump` variable |
| `js/render.js` | this project | One painter's pass sorted on `x + y`, then a label pass |
| `js/ui.js` | this project | The DOM panel. Reads `Sim.state` and `RM.*` only — no number is stored twice |
| `js/main.js` | skill engine, unchanged | Camera, input, frame loop |
| `smoke.mjs` | adapted from the skill | Headless check |

Scripts load in that order; each is an IIFE hanging one global off `window`.

## Things worth trying

Each of these makes one routing rule visible with a single control change.

- **Model asked for → `claude`.** Four families score within a point of each
  other, so it is a 400 rather than a guess, and the van turns back at the
  Naming Office.
- **`haiku` with reasoning above none.** The only model serving that id has said
  it cannot reason, so there is no compatible route at all.
- **File context past 500 KB.** The prompt outgrows the model's budget, the
  upstream returns 400, and because a 400 is not retryable the router stops
  instead of pushing the same oversized body at the next provider.
- **Upstream health → "first choice 401".** The same road, the opposite decision
  from a 429.
- **Fallback → `none`, or Max retries → 0.** The plan board loses its spare bars
  before the request ever leaves the tower.
- **Response contains → a control envelope.** The Guard Tunnel cuts the stream
  part-way and the client is told to retry the turn.

Built with the `isometric-explainer` skill.
