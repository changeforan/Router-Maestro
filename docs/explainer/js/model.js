/* model.js: what Router-Maestro actually does to one API request.
 *
 * THIS IS THE LESSON. Everything else in this project is presentation. Every
 * number the panel shows is computed here, from the inputs, on the frame it is
 * shown. There is no table of pre-baked results anywhere in this file.
 *
 * The algorithms below are ports of the real thing, function for function:
 *
 *   token accounting      src/router_maestro/utils/tokens.py
 *                         src/router_maestro/utils/token_config.py
 *   context budget        src/router_maestro/utils/context_window.py
 *   alias resolution      src/router_maestro/utils/model_match.py
 *                         src/router_maestro/utils/model_sort.py
 *   capability ranking    src/router_maestro/routing/capabilities.py
 *   route planning        src/router_maestro/routing/router.py
 *   fallback policy       src/router_maestro/routing/attempts.py
 *                         src/router_maestro/providers/base.py
 *   reasoning tiers       src/router_maestro/utils/reasoning.py
 *   leak guard            src/router_maestro/pipeline/leak_guard.py
 *
 * The honest boundary, restated in the About modal and the README:
 *
 *   Computed    token accounting, the context budget, alias normalisation and
 *               family selection, capability ranking, the route plan, the
 *               fallback decision, the reasoning-tier clamp, the leak scanner.
 *   Scaled      a ten-model catalogue instead of a live one of hundreds;
 *               tokens estimated at 3 characters each (the repo's own
 *               estimate_tokens_from_char_count) instead of a tiktoken BPE;
 *               a stream of a few dozen deltas.
 *   Assumed     every millisecond. Nothing here talks to a network.
 *   Faked       the assistant's reply text, and the upstream failures — those
 *               are dialled in by you rather than observed.
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- constants
   * Copied verbatim from the repo. Where a constant is invented for this
   * explainer it says ASSUMED at the point of definition. */

  /* utils/token_config.py — TokenCountingConfig defaults */
  var TOKENS_PER_MESSAGE = 3;          // <|im_start|>role<|im_sep|>
  var TOKENS_PER_NAME = 1;
  var TOKENS_PER_COMPLETION = 3;       // assistant reply priming
  var BASE_TOOL_TOKENS = 16;           // charged once when any tool is present
  var TOKENS_PER_TOOL = 8;
  var TOOL_DEFINITION_MULTIPLIER = 1.1;
  var CHARS_PER_TOKEN = 3;             // utils/tokens.py, the estimator path

  /* utils/model_match.py */
  var MIN_MATCH_SCORE = 80.0;
  var CONFIDENT_MATCH_SCORE = 85.0;
  var AMBIGUITY_SCORE_MARGIN = 1.0;

  /* utils/reasoning.py */
  var EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  var UPSTREAM_NATIVE_EFFORTS = ['minimal', 'low', 'medium', 'high'];
  var EFFORT_TO_BUDGET = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };

  /* providers/base.py */
  var RETRYABLE_UPSTREAM_STATUSES = [429, 500, 502, 503, 504, 529];

  /* config/priorities.py — RunawayGuardConfig defaults */
  var RUNAWAY_MAX_BYTES = 10000000;
  var RUNAWAY_MAX_DELTAS = 50000;

  /* pipeline/leak_guard.py — the envelopes that abort a stream */
  var CONTROL_TAGS = [
    ['<task-notification', '</task-notification>', 'task-notification'],
    ['<teammate-message', '</teammate-message>', 'teammate-message'],
    ['<channel', '</channel>', 'channel'],
    ['<cross-session-message', '</cross-session-message>', 'cross-session-message'],
    ['<tick>', '</tick>', 'tick']
  ];

  /* ASSUMED: every duration in this file. Router-Maestro does not publish a
     latency budget and this page never touches a network. These are the
     order-of-magnitude costs of the work each station does, chosen so the
     shape of the bill is right: the upstream call dwarfs everything the proxy
     does, and the proxy's own work is dominated by tokenising the prompt. */
  var COST = {
    gateMs: 0.15,                // constant-time API key comparison
    customsPerBlock: 0.12,       // translating one content block
    tokenisePerKTok: 0.55,       // tiktoken over the prompt, per 1000 tokens
    namingMs: 0.35,              // normalise + fuzzy match over the cache
    namingFuzzyMs: 1.2,          // extra when the alias needs the fuzzy path
    inspectMs: 0.08,
    towerMs: 0.05,
    mintMs: 320,                 // GitHub OAuth token → short-lived Copilot token
    codecPerKTok: 0.30,          // serialising the outbound body
    upstreamTtfbMs: 620,         // ASSUMED time to first token
    upstreamTokPerSec: 42,       // ASSUMED generation rate
    upstreamFailMs: 240,         // ASSUMED time for an upstream to refuse
    guardPerKTok: 0.08,          // the bounded prefix matchers, per 1000 tokens
    wirePerKTok: 0.22            // canonical chunks → the client's dialect
  };

  /* ASSUMED: a Copilot token is minted with a short TTL and reused until it
     expires. The real TTL comes back in the token payload. */
  var TOKEN_TTL_SEC = 1500;

  /* ---------------------------------------------------------------- catalogue
   * A real deployment discovers this from each provider at startup and
   * refreshes it on a TTL; every entry has the shape of ModelInfo.
   *
   * SOURCED: the GitHub Copilot prompt and context-window limits are the
   * catalogue values recorded in docs/copilot-context-limits.md (sweep of
   * 2026-04-27). ASSUMED: every max-output figure, the Anthropic / OpenAI /
   * custom limits, and the capability flags.
   *
   * `null` means the provider did not say — a third state the router treats
   * differently from both true and false. */
  var CATALOG = [
    {
      provider: 'github-copilot', id: 'claude-opus-4-6', name: 'Claude Opus 4.6',
      maxPrompt: 168000, maxOutput: 16384, ctxWindow: 200000,
      ops: { chat: true, chat_stream: true, responses: false, native_anthropic: false },
      feats: { tools: true, vision: true, reasoning: true, parallel_tools: true },
      /* 'none' is a Copilot catalogue sentinel, not a request tier. It is kept
         here on purpose: the ladder below drops it, exactly as the repo does. */
      efforts: ['none', 'low', 'medium', 'high'],
      dialect: 'openai'
    },
    {
      provider: 'github-copilot', id: 'claude-opus-4-5', name: 'Claude Opus 4.5',
      maxPrompt: 168000, maxOutput: 16384, ctxWindow: 200000,
      ops: { chat: true, chat_stream: true, responses: false, native_anthropic: false },
      feats: { tools: true, vision: true, reasoning: true, parallel_tools: true },
      efforts: ['low', 'medium', 'high'],
      dialect: 'openai'
    },
    {
      provider: 'github-copilot', id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5',
      maxPrompt: 168000, maxOutput: 16384, ctxWindow: 200000,
      ops: { chat: true, chat_stream: true, responses: false, native_anthropic: false },
      feats: { tools: true, vision: true, reasoning: true, parallel_tools: true },
      efforts: ['low', 'medium', 'high'],
      dialect: 'openai'
    },
    {
      provider: 'github-copilot', id: 'gpt-5.4', name: 'GPT-5.4',
      maxPrompt: 272000, maxOutput: 32000, ctxWindow: 400000,
      ops: { chat: true, chat_stream: true, responses: true, native_anthropic: false },
      feats: { tools: true, vision: true, reasoning: true, parallel_tools: true },
      efforts: ['minimal', 'low', 'medium', 'high'],
      dialect: 'openai'
    },
    {
      provider: 'github-copilot', id: 'gpt-5-mini', name: 'GPT-5 mini',
      maxPrompt: 128000, maxOutput: 16384, ctxWindow: 264000,
      ops: { chat: true, chat_stream: true, responses: true, native_anthropic: false },
      feats: { tools: true, vision: false, reasoning: true, parallel_tools: true },
      efforts: ['minimal', 'low', 'medium'],
      dialect: 'openai'
    },
    {
      provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6',
      maxPrompt: 180000, maxOutput: 32000, ctxWindow: 200000,
      ops: { chat: true, chat_stream: true, responses: false, native_anthropic: true },
      feats: { tools: true, vision: true, reasoning: true, parallel_tools: true },
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      dialect: 'anthropic'
    },
    {
      provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5',
      maxPrompt: 180000, maxOutput: 16000, ctxWindow: 200000,
      ops: { chat: true, chat_stream: true, responses: false, native_anthropic: true },
      feats: { tools: true, vision: true, reasoning: false, parallel_tools: true },
      efforts: [],
      dialect: 'anthropic'
    },
    {
      provider: 'openai', id: 'gpt-5.4', name: 'GPT-5.4',
      maxPrompt: 350000, maxOutput: 100000, ctxWindow: 400000,
      ops: { chat: true, chat_stream: true, responses: true, native_anthropic: false },
      feats: { tools: true, vision: true, reasoning: true, parallel_tools: true },
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      dialect: 'openai'
    },
    {
      /* A custom OpenAI-compatible endpoint. It advertises almost nothing, so
         every capability is UNKNOWN — the state that decides whether an
         unsupported-operation failure is allowed to fall through. */
      provider: 'custom', id: 'llama-3.3-70b', name: 'Llama 3.3 70B (self-hosted)',
      maxPrompt: 100000, maxOutput: 8000, ctxWindow: 128000,
      ops: { chat: true, chat_stream: true, responses: null, native_anthropic: false },
      feats: { tools: null, vision: null, reasoning: null, parallel_tools: null },
      efforts: null,
      dialect: 'openai'
    }
  ];

  /* Copilot's catalogue advertises endpoints, not operations: one
     `/responses` entry in supported_endpoints covers both the buffered and the
     streaming form. The router derives the streaming operation from the same
     flag, so mirror it here rather than repeating it nine times. */
  CATALOG.forEach(function (m) {
    m.ops.responses_stream = m.ops.responses;
  });

  /* config/priorities.py: the ordered list a deployment configures. Highest
     first. Anything authenticated but unlisted is still reachable — it just
     sorts after everything listed. */
  var PRIORITIES = [
    'github-copilot/claude-opus-4-6',
    'github-copilot/gpt-5.4',
    'anthropic/claude-opus-4-6',
    'openai/gpt-5.4',
    'custom/llama-3.3-70b'
  ];

  function qualified(m) { return m.provider + '/' + m.id; }

  function findModel(key) {
    for (var i = 0; i < CATALOG.length; i++) {
      if (qualified(CATALOG[i]) === key) return CATALOG[i];
    }
    return null;
  }

  /* ------------------------------------------------------------ model ids
   * utils/model_sort.py */

  var DATE_DASHED = /-(\d{4})-(\d{2})-(\d{2})$/;
  var DATE_PLAIN = /-(\d{8})$/;

  function stripDateSuffix(id) {
    return id.replace(DATE_DASHED, '').replace(DATE_PLAIN, '');
  }

  function parseModelId(id) {
    var remaining = id, version = 0;
    var m = DATE_DASHED.exec(remaining);
    if (m) {
      version = parseInt(m[1] + m[2] + m[3], 10);
      remaining = remaining.slice(0, m.index);
    } else {
      m = DATE_PLAIN.exec(remaining);
      if (m) {
        version = parseInt(m[1], 10);
        remaining = remaining.slice(0, m.index);
      }
    }
    return { family: remaining, version: version, raw: id };
  }

  /* utils/model_match.py: lowercase, spaces to hyphens, dots to hyphens. The
     identity keeps its date; the family drops it. */
  function normalizeIdentity(id) {
    return id.toLowerCase().split(' ').join('-').split('.').join('-');
  }
  function normalizeModelId(id) {
    return stripDateSuffix(normalizeIdentity(id));
  }

  /* ------------------------------------------------------------ fuzzy score
   * The real router scores with rapidfuzz's WRatio. This is a reimplementation
   * in the same shape: the indel (LCS-based) ratio, the token-sorted ratio,
   * and — once the two strings differ enough in length — a partial ratio,
   * rescaled the way WRatio rescales it. rapidfuzz's partial alignment is
   * cleverer than the sliding window below, so a borderline alias can land a
   * point or two either side of what the server would give it. The thresholds
   * and the ambiguity policy that act on the score are the real ones. */

  function lcsLength(a, b) {
    var la = a.length, lb = b.length;
    if (!la || !lb) return 0;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = 0;
    for (i = 1; i <= la; i++) {
      cur[0] = 0;
      for (j = 1; j <= lb; j++) {
        cur[j] = a.charAt(i - 1) === b.charAt(j - 1)
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
      }
      for (j = 0; j <= lb; j++) prev[j] = cur[j];
    }
    return prev[lb];
  }

  function indelRatio(a, b) {
    var total = a.length + b.length;
    if (!total) return 100;
    return 200 * lcsLength(a, b) / total;
  }

  function tokenSort(s) {
    return s.split('-').filter(Boolean).sort().join('-');
  }

  /* The best indel ratio between the shorter string and any window of the
     longer one the same length. This is what lets "opus-4-6" match
     "claude-opus-4-6" at all: as whole strings they only agree on 75% of their
     characters, but the alias sits inside the family name exactly. */
  function partialRatio(a, b) {
    var shortS = a.length <= b.length ? a : b;
    var longS = a.length <= b.length ? b : a;
    var n = shortS.length;
    if (!n) return 0;
    var best = 0;
    for (var i = 0; i + n <= longS.length; i++) {
      var score = indelRatio(shortS, longS.substr(i, n));
      if (score > best) best = score;
      if (best === 100) break;
    }
    return best;
  }

  function wRatio(a, b) {
    var base = indelRatio(a, b);
    var lenA = a.length || 1, lenB = b.length || 1;
    var lenRatio = Math.max(lenA, lenB) / Math.min(lenA, lenB);
    if (lenRatio < 1.5) {
      return Math.max(base, indelRatio(tokenSort(a), tokenSort(b)) * 0.95);
    }
    var scale = lenRatio < 8 ? 0.9 : 0.6;
    return Math.max(
      base,
      partialRatio(a, b) * scale,
      partialRatio(tokenSort(a), tokenSort(b)) * scale * 0.95
    );
  }

  /* ---------------------------------------------------------- token counting
   * utils/tokens.py. The repo runs tiktoken over every string; in the browser
   * there is no BPE table, so text is costed with the repo's own estimator,
   * estimate_tokens_from_char_count = characters / 3. Every structural
   * constant around it — the per-message overhead, the tool base and the
   * safety multiplier — is the real one. */

  function estimateTokens(text) {
    return Math.floor(String(text).length / CHARS_PER_TOKEN);
  }

  /* utils/tokens.py estimate_tokens_from_char_count. Used for the file
     contents a coding agent pastes into the conversation: hundreds of
     kilobytes of source would be pointless to materialise in a browser, and
     this is the repo's own way of costing a length it has not tokenised. */
  function estimateTokensFromCharCount(chars) {
    return Math.floor(chars / CHARS_PER_TOKEN);
  }

  /* utils/tokens.py calculate_image_token_cost, ported exactly. */
  function imageTokens(width, height, detail) {
    if (detail === 'low') return 85;
    var w = width, h = height, scale;
    if (w > 2048 || h > 2048) {
      scale = 2048 / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    if (Math.min(w, h) > 0) {
      scale = 768 / Math.min(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    var tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
    return tiles * 170 + 85;
  }

  /* ------------------------------------------------------------- the request
   * A scaled-down conversation: one system prompt, then alternating user and
   * assistant turns, each a real string that is really counted. Scaled: a
   * working agent session is hundreds of turns and a system prompt of several
   * thousand tokens. */

  var SYSTEM_PROMPT =
    'You are a coding agent working inside a repository. Prefer small, reviewable ' +
    'diffs. Read a file before you edit it. Never invent an API that you have not ' +
    'seen in the source. When you finish, say plainly what you changed and what you ' +
    'did not verify.';

  var USER_TURNS = [
    'The proxy returns 404 for the alias opus-4-6 but the qualified id works. Why?',
    'Show me where the alias is normalised before the cache lookup.',
    'Now trace what happens when the first provider answers 429.',
    'Does the fallback re-serialise the body for the second provider?',
    'Summarise the ordering rules for the fallback pool.',
    'One more: where is the retry limit frozen, and can it change mid-request?'
  ];

  var ASSISTANT_TURNS = [
    'The cache is keyed both ways: bare ids and provider-qualified ids live in the same map, and only the qualified entry survives a provider filter.',
    'It happens in fuzzy_match_model: identity first, then the date-stripped family, then the scorer.',
    'The attempt is recorded in the ledger, the failure is classified, and the loop asks whether this failure allows the next candidate.',
    'No — each candidate gets its own request built from the snapshot that passed validation.',
    'Supported candidates first, then unknown; unsupported never enter the pool at all.'
  ];

  var TOOL_NAMES = [
    'read_file', 'write_file', 'apply_patch', 'run_command', 'grep',
    'glob', 'list_dir', 'web_fetch', 'todo_write', 'task', 'notebook_edit',
    'git_status', 'git_diff', 'git_commit', 'format_code', 'run_tests',
    'lint', 'type_check', 'open_pr', 'review_diff'
  ];

  /* A tool definition, roughly the size real ones are: a name, a sentence of
     description, and a small JSON schema. Really counted, not assumed. */
  function toolDefinition(name) {
    return {
      name: name,
      description: 'Run the ' + name + ' operation against the workspace and return its ' +
        'result as text. Fails loudly rather than guessing when the target does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the target file.' },
          content: { type: 'string', description: 'Text to write, when writing.' },
          limit: { type: 'integer', description: 'Maximum number of results.' }
        },
        required: ['path']
      }
    };
  }

  /* Build the conversation the client is sending. `turns` counts user turns;
     assistant replies are interleaved between them, and every assistant turn
     drags a tool result behind it — which is where an agent's context actually
     goes. `contextChars` is the total weight of those file excerpts. */
  function buildMessages(turns, hasImage, contextChars) {
    var msgs = [{ role: 'system', text: SYSTEM_PROMPT, blocks: 1 }];
    var results = Math.max(1, turns - 1);
    var perResult = Math.floor((contextChars || 0) / results);
    for (var i = 0; i < turns; i++) {
      var user = { role: 'user', text: USER_TURNS[i % USER_TURNS.length], blocks: 1 };
      if (hasImage && i === turns - 1) {
        user.blocks = 2;
        user.image = { width: 1280, height: 800, detail: 'high' };
      }
      msgs.push(user);
      if (i < turns - 1) {
        msgs.push({
          role: 'assistant',
          text: ASSISTANT_TURNS[i % ASSISTANT_TURNS.length],
          blocks: 1
        });
        if (perResult > 0) {
          msgs.push({
            role: 'tool', name: TOOL_NAMES[i % TOOL_NAMES.length],
            text: '', chars: perResult, blocks: 1,
            label: TOOL_NAMES[i % TOOL_NAMES.length] + ' → ' +
                   Math.round(perResult / 1024) + ' KB of source'
          });
        }
      }
    }
    return msgs;
  }

  /* utils/tokens.py count_*_request_tokens, same shape:
     per-message overhead + content + tool overhead + reply priming. */
  function countRequestTokens(messages, tools) {
    var text = 0, images = 0, i;
    for (i = 0; i < messages.length; i++) {
      text += TOKENS_PER_MESSAGE;
      text += messages[i].chars != null
        ? estimateTokensFromCharCount(messages[i].chars)
        : estimateTokens(messages[i].text);
      if (messages[i].name) text += TOKENS_PER_NAME;
      if (messages[i].image) {
        images += imageTokens(messages[i].image.width, messages[i].image.height,
                              messages[i].image.detail);
      }
    }
    var toolTokens = 0;
    if (tools.length) {
      toolTokens = BASE_TOOL_TOKENS;
      for (i = 0; i < tools.length; i++) {
        toolTokens += TOKENS_PER_TOOL;
        toolTokens += Math.ceil(estimateTokens(JSON.stringify(tools[i])) * TOOL_DEFINITION_MULTIPLIER);
      }
    }
    return {
      messages: text,
      images: images,
      tools: toolTokens,
      completion: TOKENS_PER_COMPLETION,
      total: text + images + toolTokens + TOKENS_PER_COMPLETION
    };
  }

  /* ------------------------------------------------------------ context budget
   * utils/context_window.py calculate_context_budget, ported exactly. The 15%
   * cap is Copilot Chat's own rule, and it is why a 200k-window model will not
   * let you ask for 32k of output. */
  function contextBudget(model) {
    var maxPrompt = model.maxPrompt;
    if (maxPrompt == null) return null;
    var effectiveOutput = Math.min(model.maxOutput || 4096, Math.floor(maxPrompt * 0.15));
    var window = model.ctxWindow || (effectiveOutput + maxPrompt);
    var usable = Math.max(0, Math.min(maxPrompt, window - effectiveOutput));
    return { maxPromptTokens: usable, maxOutputTokens: effectiveOutput, contextWindow: window };
  }

  /* utils/context_window.py normalize_thinking_budget. */
  function normalizeThinkingBudget(budget, maxOutputTokens) {
    if (budget == null) return null;
    var upper = Math.min(EFFORT_TO_BUDGET.max, maxOutputTokens - 1);
    if (upper < 1024) return null;
    return Math.max(1024, Math.min(budget, upper));
  }

  /* ---------------------------------------------------------- reasoning tiers
   * utils/reasoning.py. Values outside the ladder — Copilot's 'none' sentinel,
   * for instance — are filtered out before anything is chosen. */

  function effortIndex(e) { return EFFORT_ORDER.indexOf(e); }

  function pickClosestEffort(desired, allowed) {
    if (effortIndex(desired) < 0) return null;
    var valid = allowed.filter(function (v) { return effortIndex(v) >= 0; });
    if (valid.indexOf(desired) >= 0) return desired;
    var target = effortIndex(desired);
    var lower = valid.filter(function (v) { return effortIndex(v) < target; });
    if (!lower.length) return null;
    return lower.reduce(function (a, b) { return effortIndex(a) > effortIndex(b) ? a : b; });
  }

  function resolveEffortWithinCatalog(desired, allowed) {
    var valid = (allowed || []).filter(function (v) { return effortIndex(v) >= 0; });
    if (!valid.length) return null;
    var atOrBelow = pickClosestEffort(desired, valid);
    if (atOrBelow !== null) return atOrBelow;
    return valid.reduce(function (a, b) { return effortIndex(a) < effortIndex(b) ? a : b; });
  }

  function downgradeForUpstream(effort) {
    if (effort == null) return null;
    return UPSTREAM_NATIVE_EFFORTS.indexOf(effort) >= 0 ? effort : 'high';
  }

  /* ------------------------------------------------------------- capabilities
   * routing/capabilities.py. Three states, not two: a provider that never said
   * whether it supports vision is UNKNOWN, and unknown is allowed to be tried
   * and allowed to fail through to the next candidate. False is not. */

  var SUPPORTED = 'supported', UNSUPPORTED = 'unsupported', UNKNOWN = 'unknown';

  function support(value) {
    if (value === true) return SUPPORTED;
    if (value === false) return UNSUPPORTED;
    return UNKNOWN;
  }

  function requiredFeatures(features) {
    var out = [];
    if (features.tools) out.push('tools');
    if (features.vision) out.push('vision');
    if (features.reasoning) out.push('reasoning');
    if (features.parallel_tools) out.push('parallel_tools');
    return out;
  }

  /* ModelCapabilities.support_for: unsupported wins, then unknown, else
     supported. Evaluated against the operation AND every required feature. */
  function supportFor(model, operation, features) {
    var states = [support(model.ops[operation])];
    var req = requiredFeatures(features);
    for (var i = 0; i < req.length; i++) states.push(support(model.feats[req[i]]));
    if (states.indexOf(UNSUPPORTED) >= 0) return UNSUPPORTED;
    if (states.indexOf(UNKNOWN) >= 0) return UNKNOWN;
    return SUPPORTED;
  }

  function candidateOf(model, operation, features) {
    var s = supportFor(model, operation, features);
    var reasons = [];
    if (support(model.ops[operation]) === UNSUPPORTED) reasons.push('cannot do ' + operation);
    if (support(model.ops[operation]) === UNKNOWN) reasons.push(operation + ' unverified');
    requiredFeatures(features).forEach(function (f) {
      var st = support(model.feats[f]);
      if (st === UNSUPPORTED) reasons.push('no ' + f);
      if (st === UNKNOWN) reasons.push(f + ' unverified');
    });
    return {
      key: qualified(model), model: model, provider: model.provider,
      support: s, reasons: reasons
    };
  }

  /* Router._rank_compatible: supported first, unknown after, unsupported gone.
     Order within each group is preserved, which is what makes the priorities
     list actually mean something. */
  function rankCompatible(candidates) {
    var supported = candidates.filter(function (c) { return c.support === SUPPORTED; });
    var unknown = candidates.filter(function (c) { return c.support === UNKNOWN; });
    return supported.concat(unknown);
  }

  function configuredCandidates(operation, features) {
    var out = [], seen = {};
    PRIORITIES.forEach(function (key) {
      var m = findModel(key);
      if (!m || seen[key]) return;
      seen[key] = 1;
      out.push(candidateOf(m, operation, features));
    });
    return out;
  }

  function allAvailableCandidates(operation, features) {
    var out = [], seen = {};
    CATALOG.forEach(function (m) {
      var key = qualified(m);
      if (seen[key]) return;
      seen[key] = 1;
      out.push(candidateOf(m, operation, features));
    });
    return out;
  }

  /* -------------------------------------------------------- alias resolution
   * utils/model_match.py fuzzy_match_model, with its real decision order:
   * exact identity, then date-stripped family, then the scorer with its two
   * refusals — low confidence, and a tie between families. */

  function resolveAlias(query) {
    var trace = [];
    var providerFilter = null, matchQuery = query;

    if (query.indexOf('/') >= 0) {
      var exact = findModel(query);
      if (exact) {
        trace.push('exact provider-qualified key: no matching needed');
        return { key: query, explicit: true, trace: trace };
      }
      var parts = query.split('/');
      providerFilter = parts[0].toLowerCase();
      matchQuery = parts.slice(1).join('/');
      trace.push('slash means provider boundary → filter to "' + providerFilter + '"');
    }

    var identityQuery = normalizeIdentity(matchQuery);
    if (identityQuery !== matchQuery) {
      trace.push('normalise "' + matchQuery + '" → "' + identityQuery + '" (lowercase, spaces and dots to hyphens)');
    }

    /* identity → concrete catalogue entries with that exact dated id */
    var identityCandidates = {};
    CATALOG.forEach(function (m) {
      if (providerFilter && m.provider.toLowerCase() !== providerFilter) return;
      var identity = normalizeIdentity(m.id);
      (identityCandidates[identity] = identityCandidates[identity] || []).push(m);
    });

    if (identityCandidates[identityQuery]) {
      trace.push('exact identity hit: "' + identityQuery + '"');
      return {
        key: qualified(identityCandidates[identityQuery][0]),
        upstreamId: identityCandidates[identityQuery][0].id,
        explicit: false, trace: trace
      };
    }

    var normalizedQuery = stripDateSuffix(identityQuery);
    if (normalizedQuery !== identityQuery) {
      trace.push('strip the date suffix → family "' + normalizedQuery + '"');
    }

    var families = {};
    Object.keys(identityCandidates).forEach(function (identity) {
      var fam = stripDateSuffix(identity);
      families[fam] = (families[fam] || []).concat(identityCandidates[identity]);
    });

    if (families[normalizedQuery]) {
      var best = selectBest(families[normalizedQuery]);
      trace.push('family "' + normalizedQuery + '" matched exactly → newest concrete version, ' + best.id);
      return { key: qualified(best), upstreamId: best.id, family: normalizedQuery,
               explicit: false, score: 100, trace: trace };
    }

    var scored = Object.keys(families).map(function (fam) {
      return { family: fam, score: wRatio(normalizedQuery, fam) };
    }).sort(function (a, b) { return b.score - a.score; });

    var above = scored.filter(function (s) { return s.score >= MIN_MATCH_SCORE; });
    if (!above.length) {
      trace.push('nothing scores ' + MIN_MATCH_SCORE + ' or better → 404');
      return { error: 'not-found', scored: scored.slice(0, 4), trace: trace };
    }

    var top = above[0];
    trace.push('best family "' + top.family + '" scores ' + top.score.toFixed(1));
    if (top.score < CONFIDENT_MATCH_SCORE) {
      trace.push('below the confidence floor of ' + CONFIDENT_MATCH_SCORE + ' → 400, use provider/model');
      return { error: 'low-confidence', scored: above.slice(0, 4), trace: trace };
    }
    var tied = above.filter(function (s) { return top.score - s.score <= AMBIGUITY_SCORE_MARGIN; });
    if (tied.length > 1) {
      trace.push(tied.length + ' families within ' + AMBIGUITY_SCORE_MARGIN + ' point → ambiguous, 400');
      return { error: 'ambiguous', scored: tied, trace: trace };
    }

    var winner = selectBest(families[top.family]);
    trace.push('one clear family → newest concrete version, ' + winner.id);
    return { key: qualified(winner), upstreamId: winner.id, family: top.family,
             explicit: false, score: top.score, scored: above.slice(0, 4), trace: trace };
  }

  /* model_match._select_best: dated beats undated, newer date beats older,
     catalogue order breaks the remaining ties. */
  function selectBest(hits) {
    var best = hits[0], bestKey = null;
    hits.forEach(function (m) {
      var parsed = parseModelId(m.id);
      var key = [parsed.version > 0 ? 1 : 0, parsed.version];
      if (bestKey === null || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = m; bestKey = key;
      }
    });
    return best;
  }

  /* --------------------------------------------------------------- route plan
   * routing/router.py plan_route + _build_route_plan. Three entry paths —
   * auto-route, a bare alias, and an explicit provider/model — converge on one
   * frozen plan: a primary, an ordered pool, and a retry limit that cannot
   * change once the request is in flight. */

  function planRoute(p) {
    var operation = p.operation;
    var features = p.features;
    var trace = [];
    var explicit = false, primary = null, pool = [], resolution = null;

    if (p.askedModel === 'router-maestro') {
      trace.push('auto-route: the client named no model, so the priorities list decides');
      var configured = configuredCandidates(operation, features);
      if (!configured.length) configured = allAvailableCandidates(operation, features);
      var ranked = rankCompatible(configured);
      if (!ranked.length) {
        return { error: 'no-compatible', operation: operation, trace: trace };
      }
      primary = ranked[0];
      pool = ranked.slice(1);
      resolution = { key: primary.key, auto: true, trace: trace };
    } else {
      resolution = resolveAlias(p.askedModel);
      resolution.trace.forEach(function (t) { trace.push(t); });
      if (resolution.error) {
        return { error: resolution.error, resolution: resolution, operation: operation, trace: trace };
      }
      if (resolution.explicit) {
        explicit = true;
        var model = findModel(resolution.key);
        primary = candidateOf(model, operation, features);
        /* _explicit_fallback_candidates: everything below the primary in the
           priorities list, in that order. */
        var conf = configuredCandidates(operation, features);
        var idx = -1;
        conf.forEach(function (c, i) { if (c.key === primary.key) idx = i; });
        var after = idx >= 0 ? conf.slice(idx + 1) : conf;
        pool = rankCompatible(after.filter(function (c) { return c.key !== primary.key; }));
      } else {
        /* An alias names an upstream id, not a provider. Every provider that
           serves that id is a candidate, ordered by the priorities list first
           and the rest of the catalogue after. */
        var upstreamId = resolution.upstreamId;
        var ordered = configuredCandidates(operation, features)
          .concat(allAvailableCandidates(operation, features));
        var aliasCandidates = [], seen = {};
        ordered.forEach(function (c) {
          if (c.model.id !== upstreamId || seen[c.key]) return;
          seen[c.key] = 1;
          aliasCandidates.push(c);
        });
        var rankedAliases = rankCompatible(aliasCandidates);
        if (!rankedAliases.length) {
          return { error: 'no-compatible', resolution: resolution, operation: operation, trace: trace };
        }
        if (rankedAliases.length > 1) {
          trace.push(rankedAliases.length + ' providers serve "' + upstreamId +
                     '" → priorities order decides which one is primary');
        }
        primary = rankedAliases[0];
        pool = rankedAliases.slice(1);
      }
    }

    /* _build_route_plan: strategy first, then the retry limit. */
    var strategy = p.strategy;
    if (strategy === 'none') {
      trace.push('fallback strategy "none": one attempt, no pool');
      pool = [];
    } else if (strategy === 'same-model') {
      pool = pool.filter(function (c) { return c.model.id === primary.model.id; });
      trace.push('fallback strategy "same-model": only other providers serving ' +
                 primary.model.id + ' stay in the pool');
    }
    pool = rankCompatible(pool.filter(function (c) { return c.key !== primary.key; }));

    var limit = strategy === 'none' ? 0 : p.maxRetries;
    var fallbacks = pool.slice(0, limit);

    /* _validate_plan_primary: an explicitly named model that cannot do the job
       is a 400 against the client, not a silent hop to something else. */
    var rejected = null;
    if (primary.support === UNSUPPORTED) {
      rejected = primary.reasons[0] || 'unsupported';
    }

    return {
      operation: operation,
      features: features,
      explicit: explicit,
      resolution: resolution,
      primary: primary,
      pool: pool,
      fallbacks: fallbacks,
      maxFallbackAttempts: limit,
      candidates: [primary].concat(fallbacks),
      rejected: rejected,
      trace: trace
    };
  }

  /* ------------------------------------------------------------- the attempts
   * providers/base.py classify_upstream_status and routing/attempts.py
   * failure_allows_fallback. This is the whole retry policy: retryable
   * failures walk the pool, everything else stops immediately, and an
   * unsupported-operation failure only falls through when the router was
   * guessing in the first place. */

  function classifyUpstreamStatus(status) {
    var kind;
    if (status === 401 || status === 403) kind = 'authentication';
    else if (status === 429 || status === 529) kind = 'rate_limit';
    else kind = 'upstream_status';
    return { kind: kind, retryable: RETRYABLE_UPSTREAM_STATUSES.indexOf(status) >= 0 };
  }

  function failureAllowsFallback(plan, candidate, failure) {
    if (failure.kind === 'unsupported_operation') {
      return !plan.explicit && candidate.support === UNKNOWN;
    }
    return failure.retryable;
  }

  /* Upstream health is dialled in, not observed. Each scenario is a list of
     statuses applied to attempts in order; 200 means the attempt succeeds. */
  var SCENARIOS = {
    healthy: { label: 'all upstreams healthy', statuses: [200] },
    ratelimited: { label: 'first choice rate-limited', statuses: [429, 200] },
    outage: { label: 'first two choices failing', statuses: [429, 502, 200] },
    expired: { label: 'first choice credentials expired', statuses: [401, 200] },
    badrequest: { label: 'first choice rejects the body', statuses: [400, 200] },
    allDown: { label: 'every upstream failing', statuses: [503, 503, 503, 503, 503] }
  };

  function statusForAttempt(scenario, index) {
    var list = SCENARIOS[scenario] ? SCENARIOS[scenario].statuses : [200];
    return index < list.length ? list[index] : list[list.length - 1];
  }

  function runAttempts(plan, p, promptTokens) {
    var records = [], selected = null, stopped = null;
    for (var i = 0; i < plan.candidates.length; i++) {
      var candidate = plan.candidates[i];
      var status = statusForAttempt(p.scenario, i);
      var why = null;
      /* MODELLED: an oversized prompt comes back as
         model_max_prompt_tokens_exceeded, which is an ordinary 400 — so it is
         classified as not retryable and the walk stops instead of pushing the
         same too-large body at the next provider. In practice the catalogue
         limit is a soft recommendation and several models accept more than
         they advertise; see docs/copilot-context-limits.md. */
      var candidateBudget = contextBudget(candidate.model);
      if (candidateBudget && promptTokens > candidateBudget.maxPromptTokens) {
        status = 400;
        why = 'model_max_prompt_tokens_exceeded (' + fmtTok(promptTokens) + ' > ' +
              fmtTok(candidateBudget.maxPromptTokens) + ')';
      }
      if (status === 200) {
        selected = { index: i, candidate: candidate };
        records.push({ index: i, candidate: candidate, status: 200, decision: 'selected' });
        break;
      }
      var cls = classifyUpstreamStatus(status);
      var failure = { kind: cls.kind, retryable: cls.retryable, status: status };
      var allows = failureAllowsFallback(plan, candidate, failure);
      var hasNext = i < plan.candidates.length - 1;
      var decision = allows ? (hasNext ? 'fallback' : 'exhausted') : 'stop';
      records.push({
        index: i, candidate: candidate, status: status, kind: cls.kind,
        retryable: cls.retryable, decision: decision, why: why
      });
      if (decision !== 'fallback') { stopped = decision; break; }
    }
    return { records: records, selected: selected, stopped: stopped };
  }

  /* ---------------------------------------------------------------- the stream
   * pipeline/leak_guard.py, ported: a bounded prefix matcher per envelope,
   * fed one delta at a time, holding O(tag length) of state rather than the
   * whole response. Control envelopes abort the stream; a leaked <invoke> is
   * recovered into a structured tool call at the end instead. */

  function TagMatcher(openPrefix, closeTag, name) {
    this.open = openPrefix;
    this.close = closeTag;
    this.name = name;
    this.buf = '';
    this.inside = false;
  }

  TagMatcher.prototype.feed = function (text) {
    this.buf += text;
    /* keep only as much as the longest tag needs to survive a chunk boundary */
    var keep = Math.max(this.open.length, this.close.length) + 8;
    if (!this.inside && this.buf.length > keep) this.buf = this.buf.slice(-keep);
    if (!this.inside) {
      var at = this.buf.indexOf(this.open);
      if (at >= 0) { this.inside = true; this.buf = this.buf.slice(at); }
      return null;
    }
    if (this.buf.indexOf(this.close) >= 0) return this.name;
    if (this.buf.length > 512) this.buf = this.buf.slice(-512);
    return null;
  };

  function LeakScanner() {
    this.matchers = CONTROL_TAGS.map(function (t) { return new TagMatcher(t[0], t[1], t[2]); });
    this.text = '';
    this.bytes = 0;
    this.deltas = 0;
    this.abort = null;
  }

  LeakScanner.prototype.feed = function (delta) {
    this.deltas++;
    this.bytes += delta.length;
    this.text += delta;
    if (this.bytes > RUNAWAY_MAX_BYTES) this.abort = this.abort || 'runaway: byte ceiling';
    if (this.deltas > RUNAWAY_MAX_DELTAS) this.abort = this.abort || 'runaway: delta ceiling';
    for (var i = 0; i < this.matchers.length; i++) {
      var hit = this.matchers[i].feed(delta);
      if (hit && !this.abort) this.abort = 'control envelope <' + hit + '>';
    }
    return this.abort;
  };

  /* providers/tool_parsing.recover_invoke_tool_calls, in miniature: at stream
     end, XML that should have been a structured tool call is turned into one
     rather than shown to the user as text. */
  var INVOKE_RE = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  LeakScanner.prototype.finish = function () {
    var out = [], m;
    INVOKE_RE.lastIndex = 0;
    while ((m = INVOKE_RE.exec(this.text)) !== null) out.push({ name: m[1], raw: m[2] });
    return out;
  };

  /* FAKED: the assistant's words. Nothing here ran a model, so the reply is
     canned text. What is real is the scanner that reads it. */
  var REPLY_CLEAN =
    'The alias never reaches the provider. plan_route normalises it, strips the date ' +
    'suffix, and looks the family up in the model cache; only the concrete catalogue ' +
    'entry it lands on is sent upstream. If two providers serve that same id, the ' +
    'priorities list decides which one is primary and the other becomes the first ' +
    'fallback. Nothing about that ordering can change once the plan is frozen.';

  var REPLY_INVOKE = REPLY_CLEAN +
    ' <invoke name="read_file">{"path":"src/router_maestro/routing/router.py"}</invoke>';

  var REPLY_CONTROL =
    'Let me check the router. <task-notification>agent handoff: routing/router.py</task-notification> ' +
    'The alias never reaches the provider.';

  function replyFor(leak) {
    if (leak === 'invoke') return REPLY_INVOKE;
    if (leak === 'control') return REPLY_CONTROL;
    return REPLY_CLEAN;
  }

  /* Split into deltas the way a provider streams them: a few words at a time. */
  function toDeltas(text) {
    var words = text.split(' ');
    var out = [], i;
    for (i = 0; i < words.length; i += 3) {
      out.push((i ? ' ' : '') + words.slice(i, i + 3).join(' '));
    }
    return out;
  }

  function scanStream(leak) {
    var scanner = new LeakScanner();
    var deltas = toDeltas(replyFor(leak));
    var abortedAt = null;
    for (var i = 0; i < deltas.length; i++) {
      if (scanner.feed(deltas[i])) { abortedAt = i + 1; break; }
    }
    return {
      deltas: deltas.length,
      delivered: abortedAt || deltas.length,
      bytes: scanner.bytes,
      abort: scanner.abort,
      recovered: scanner.abort ? [] : scanner.finish(),
      text: scanner.text
    };
  }

  /* ---------------------------------------------------------------- dialects
   * server/translation.py and translation_gemini.py. Every inbound dialect is
   * translated into one canonical ChatRequest before routing; whatever the
   * chosen provider speaks, it is translated again on the way out. The number
   * that matters is how many content blocks had to be rewritten. */

  var DIALECTS = {
    anthropic: {
      label: 'Anthropic Messages', path: 'POST /v1/messages',
      client: 'Claude Code', operation: 'chat_stream', native: 'anthropic'
    },
    'openai-chat': {
      label: 'OpenAI Chat Completions', path: 'POST /api/openai/v1/chat/completions',
      client: 'any OpenAI SDK', operation: 'chat_stream', native: 'openai'
    },
    'openai-responses': {
      label: 'OpenAI Responses', path: 'POST /api/openai/v1/responses',
      client: 'Codex', operation: 'responses_stream', native: 'openai'
    },
    gemini: {
      label: 'Gemini generateContent', path: 'POST /api/gemini/v1beta/models/…:streamGenerateContent',
      client: 'Gemini CLI', operation: 'chat_stream', native: 'gemini'
    }
  };

  function translateInbound(dialect, messages, tools) {
    var d = DIALECTS[dialect];
    var blocks = 0;
    messages.forEach(function (m) { blocks += m.blocks; });
    var rewritten = d.native === 'openai' ? 0 : blocks;
    var notes = [];
    if (dialect === 'anthropic') {
      notes.push('top-level system prompt → a system message');
      notes.push('tool_use / tool_result blocks → tool_calls and tool messages');
      notes.push('thinking config → reasoning_effort or a thinking budget');
    } else if (dialect === 'gemini') {
      notes.push('contents[].parts → messages[].content');
      notes.push('role "model" → role "assistant"');
      notes.push('functionDeclarations → tools[].function');
    } else if (dialect === 'openai-responses') {
      notes.push('input[] items → messages, with reasoning items preserved');
      notes.push('the response is reduced back into Responses events on the way out');
    } else {
      notes.push('already canonical: the body is validated, not rewritten');
    }
    return {
      dialect: d, blocks: blocks, rewritten: rewritten,
      tools: tools.length, notes: notes
    };
  }

  /* Whether the outbound leg needs a second translation, and which codec runs.
     providers/anthropic_codec.py, copilot_support/chat_codec.py. */
  function outboundCodec(dialectKey, model) {
    var inbound = DIALECTS[dialectKey].native;
    var target = model.dialect;
    if (inbound === 'anthropic' && target === 'anthropic') {
      return { name: 'native passthrough', cross: false,
               note: 'Anthropic in, Anthropic out: the body is forwarded close to verbatim.' };
    }
    if (inbound === target) {
      return { name: 'same-family codec', cross: false,
               note: 'Same wire family both sides: only routing fields are rewritten.' };
    }
    return {
      name: inbound + ' → ' + target,
      cross: true,
      note: 'Cross-provider: the canonical request is re-encoded into the ' + target +
            ' wire format, and every streamed chunk is decoded back on the way home.'
    };
  }

  /* ------------------------------------------------------------------ compute
   * One call, everything derived. Called by sim.js on every station and by
   * ui.js on every paint, so a slider moves the whole page at once. */

  function compute(p) {
    var dialect = DIALECTS[p.dialect];
    var operation = dialect.operation;

    var messages = buildMessages(p.turns, p.image, (p.contextKB || 0) * 1024);
    var tools = [];
    for (var i = 0; i < p.tools; i++) tools.push(toolDefinition(TOOL_NAMES[i % TOOL_NAMES.length]));

    var features = {
      tools: tools.length > 0,
      vision: !!p.image,
      reasoning: !!p.effort,
      parallel_tools: false
    };

    var translation = translateInbound(p.dialect, messages, tools);
    var tokens = countRequestTokens(messages, tools);
    var plan = planRoute({
      askedModel: p.askedModel, operation: operation, features: features,
      strategy: p.strategy, maxRetries: p.maxRetries
    });

    var out = {
      dialect: dialect,
      operation: operation,
      features: features,
      messages: messages,
      tools: tools,
      translation: translation,
      tokens: tokens,
      plan: plan,
      apiKeyOk: p.apiKeyOk,
      ms: {},
      total: 0
    };

    /* --- the failures that end the trip before a model is ever chosen --- */
    if (!p.apiKeyOk) {
      out.outcome = { ok: false, status: 401, label: 'invalid API key',
        detail: 'The server key did not match. No routing happens: the request never reaches the model cache.' };
    } else if (plan.error === 'not-found') {
      out.outcome = { ok: false, status: 404, label: 'model not found',
        detail: 'No family in the catalogue scores ' + MIN_MATCH_SCORE + ' or better against "' + p.askedModel + '".' };
    } else if (plan.error === 'ambiguous' || plan.error === 'low-confidence') {
      out.outcome = { ok: false, status: 400, label: 'ambiguous alias',
        detail: 'The alias "' + p.askedModel + '" does not select one identity. Use provider/model.' };
    } else if (plan.error === 'no-compatible') {
      out.outcome = { ok: false, status: 400, label: 'no compatible route',
        detail: 'No authenticated model can perform ' + operation + ' with the features this request asks for.' };
    } else if (plan.rejected) {
      out.outcome = { ok: false, status: 400, label: 'capability refused',
        detail: 'The named model ' + plan.primary.key + ' ' + plan.rejected +
                '. An explicitly named model is never silently swapped for another one.' };
    }

    if (out.outcome) {
      out.ms.gate = COST.gateMs;
      if (p.apiKeyOk) {
        out.ms.customs = translation.blocks * COST.customsPerBlock;
        out.ms.weigh = tokens.total / 1000 * COST.tokenisePerKTok;
        out.ms.naming = COST.namingMs + (plan.error ? COST.namingFuzzyMs : 0);
      }
      out.total = sum(out.ms);
      return out;
    }

    /* --- the chosen model, and what fits inside it --- */
    var primaryModel = plan.primary.model;
    var budget = contextBudget(primaryModel);
    out.budget = budget;
    out.fits = tokens.total <= budget.maxPromptTokens;
    out.promptShare = tokens.total / budget.maxPromptTokens;

    /* reasoning tier, clamped into what this model actually advertises */
    if (p.effort) {
      var allowed = primaryModel.efforts || [];
      var resolved = resolveEffortWithinCatalog(p.effort, allowed);
      out.effort = {
        asked: p.effort,
        allowed: allowed,
        resolved: resolved,
        substituted: resolved !== null && resolved !== p.effort,
        upstream: downgradeForUpstream(resolved),
        budgetTokens: normalizeThinkingBudget(EFFORT_TO_BUDGET[resolved] || null, budget.maxOutputTokens)
      };
    } else {
      out.effort = null;
    }

    out.codec = outboundCodec(p.dialect, primaryModel);
    out.mintNeeded = primaryModel.provider === 'github-copilot' && !p.tokenWarm;
    out.tokenTtl = TOKEN_TTL_SEC;

    /* --- the attempts --- */
    var run = runAttempts(plan, p, tokens.total);
    out.attempts = run.records;
    out.selected = run.selected;

    if (!run.selected) {
      var last = run.records[run.records.length - 1];
      out.outcome = {
        ok: false,
        status: last.kind === 'authentication' ? 401 : last.status,
        label: run.stopped === 'stop' ? 'not retryable — stopped' : 'every candidate exhausted',
        detail: last.why
          ? 'The upstream rejected the body: ' + last.why + '. That is an ordinary 400, and a 400 is not ' +
            'retryable — pushing the same oversized prompt at the next provider would fail the same way, ' +
            'so the router stops and says why.'
          : (run.stopped === 'stop'
            ? 'A ' + last.kind.replace('_', ' ') + ' failure is not retryable, so the router stops rather than ' +
              'sending the same request somewhere else and hiding the reason.'
            : 'All ' + run.records.length + ' planned candidates failed. The client gets the last failure, with the ' +
              'whole attempt ledger attached.')
      };
    }

    /* --- the stream home --- */
    var selectedModel = run.selected ? run.selected.candidate.model : null;
    out.selectedBudget = selectedModel ? contextBudget(selectedModel) : null;
    if (run.selected) {
      var stream = scanStream(p.leak);
      out.stream = stream;
      out.outputTokens = estimateTokens(stream.text);
      if (stream.abort) {
        out.outcome = { ok: false, status: 502, label: 'stream aborted by the guard',
          detail: 'The leak guard saw a ' + stream.abort + ' in the response. That envelope is Claude Code ' +
                  'protocol, not model output, so the stream is cut and the client retries the turn.' };
      } else {
        out.outcome = { ok: true, status: 200, label: 'delivered',
          detail: 'The client got its ' + dialect.label + ' stream, and it came from ' +
                  selectedModel.name + ' on ' + selectedModel.provider + '.' };
      }
    }

    /* --- the bill (every millisecond ASSUMED; see the ledger) --- */
    var kTokIn = tokens.total / 1000;
    out.ms.gate = COST.gateMs;
    out.ms.customs = translation.blocks * COST.customsPerBlock + translation.tools * 0.05;
    out.ms.weigh = kTokIn * COST.tokenisePerKTok;
    out.ms.naming = COST.namingMs + (plan.resolution && plan.resolution.score != null ? COST.namingFuzzyMs : 0);
    out.ms.inspect = COST.inspectMs * (plan.pool.length + 1);
    out.ms.tower = COST.towerMs;
    out.ms.mint = out.mintNeeded ? COST.mintMs : 0;
    out.ms.codec = kTokIn * COST.codecPerKTok * (out.codec.cross ? 1.6 : 1);
    /* Every attempt costs its own upstream round trip. A failure is charged
       the ASSUMED time it takes an upstream to say no; the one that answers is
       charged time-to-first-token plus generation at the assumed rate. */
    out.attempts.forEach(function (a) {
      a.ms = a.status === 200
        ? COST.upstreamTtfbMs + (out.outputTokens / COST.upstreamTokPerSec) * 1000
        : COST.upstreamFailMs;
    });
    out.ms.upstream = out.attempts.reduce(function (t, a) { return t + a.ms; }, 0);
    out.ms.guards = run.selected ? (out.outputTokens / 1000) * COST.guardPerKTok : 0;
    out.ms.wire = run.selected ? (out.outputTokens / 1000) * COST.wirePerKTok : 0;
    out.total = sum(out.ms);
    out.proxyMs = out.total - out.ms.upstream;
    out.proxyShare = out.total ? out.proxyMs / out.total : 0;

    return out;
  }

  function sum(obj) {
    var t = 0;
    Object.keys(obj).forEach(function (k) { t += obj[k]; });
    return t;
  }

  /* ------------------------------------------------------------------ format */

  function fmtMs(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
    if (ms >= 100) return Math.round(ms) + ' ms';
    if (ms >= 1) return (Math.round(ms * 10) / 10) + ' ms';
    return (Math.round(ms * 100) / 100) + ' ms';
  }

  function fmtTok(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  global.RM = {
    /* constants, so the panel can quote them without a second copy */
    TOKENS_PER_MESSAGE: TOKENS_PER_MESSAGE,
    BASE_TOOL_TOKENS: BASE_TOOL_TOKENS,
    TOKENS_PER_TOOL: TOKENS_PER_TOOL,
    TOOL_DEFINITION_MULTIPLIER: TOOL_DEFINITION_MULTIPLIER,
    CHARS_PER_TOKEN: CHARS_PER_TOKEN,
    MIN_MATCH_SCORE: MIN_MATCH_SCORE,
    CONFIDENT_MATCH_SCORE: CONFIDENT_MATCH_SCORE,
    AMBIGUITY_SCORE_MARGIN: AMBIGUITY_SCORE_MARGIN,
    EFFORT_ORDER: EFFORT_ORDER,
    EFFORT_TO_BUDGET: EFFORT_TO_BUDGET,
    RETRYABLE_UPSTREAM_STATUSES: RETRYABLE_UPSTREAM_STATUSES,
    RUNAWAY_MAX_BYTES: RUNAWAY_MAX_BYTES,
    RUNAWAY_MAX_DELTAS: RUNAWAY_MAX_DELTAS,
    TOKEN_TTL_SEC: TOKEN_TTL_SEC,
    CONTROL_TAGS: CONTROL_TAGS,

    COST: COST,
    catalog: CATALOG,
    priorities: PRIORITIES,
    dialects: DIALECTS,
    scenarios: SCENARIOS,

    /* the algorithm, function by function, so a panel can call one step */
    qualified: qualified,
    findModel: findModel,
    stripDateSuffix: stripDateSuffix,
    parseModelId: parseModelId,
    normalizeIdentity: normalizeIdentity,
    normalizeModelId: normalizeModelId,
    wRatio: wRatio,
    estimateTokens: estimateTokens,
    imageTokens: imageTokens,
    countRequestTokens: countRequestTokens,
    contextBudget: contextBudget,
    pickClosestEffort: pickClosestEffort,
    resolveEffortWithinCatalog: resolveEffortWithinCatalog,
    downgradeForUpstream: downgradeForUpstream,
    supportFor: supportFor,
    rankCompatible: rankCompatible,
    resolveAlias: resolveAlias,
    planRoute: planRoute,
    classifyUpstreamStatus: classifyUpstreamStatus,
    failureAllowsFallback: failureAllowsFallback,
    scanStream: scanStream,
    compute: compute,

    fmtMs: fmtMs,
    fmtTok: fmtTok
  };
})(window);
