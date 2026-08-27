/* world.js: the static place — routes, stations, districts, buildings, props.
 *
 * Nothing here animates and nothing here computes the lesson. This file only
 * answers "where is everything, and what does each place mean".
 *
 * The shape of the town is the shape of the request path:
 *
 *   the inbound avenue   one straight road, one station per pipeline stage,
 *                        because the front half of a request is a queue of
 *                        checks that either all pass or stop the request dead
 *   the attempt loop     a ring road off the Dispatch Tower. One lap is one
 *                        provider attempt. A fallback is literally another lap
 *   the home road        a different road, because the response is a different
 *                        journey with different work done to it
 *   the turn-back        the avenue driven in reverse: a request refused at a
 *                        checkpoint never reaches a model at all
 */
(function (global) {
  'use strict';

  var Iso = global.Iso;
  var makeRoute = Iso.makeRoute;

  /* ---- routes ------------------------------------------------------------ */

  /* The inbound avenue. Every checkpoint the proxy runs before it is willing
     to name a model, in the order it runs them. */
  var IN = makeRoute([
    [6, 9],        // 0 client desk
    [14, 9],       // 1 gatehouse — the API key
    [22, 9],       // 2 customs house — dialect translation
    [30, 9],       // 3 weighbridge — token accounting
    [38, 9],       // 4 naming office — alias resolution
    [46, 9],       // 5 inspection shed — capabilities
    [54, 9]        // 6 dispatch tower — the route plan
  ]);

  /* One lap of this ring is one attempt against one provider. A fallback sends
     the van round again with the next candidate; nothing else about the town
     changes, which is the point. */
  var ATTEMPT = makeRoute([
    [54, 9],       // 0 leaving the tower
    [62, 10],      // 1 corner
    [62, 17],      // 2 key mint — the upstream credential
    [62, 24],      // 3 corner
    [56, 28],      // 4 codec dock — the outbound wire format
    [49, 28],      // 5 upstream gate — the provider call itself
    [44, 24],      // 6 corner, heading back for another candidate
    [44, 15],      // 7 corner
    [49, 11],      // 8 corner
    [54, 9]        // 9 back at the tower
  ]);

  /* The response comes home on its own road, south of the loop. */
  var HOME = makeRoute([
    [49, 28],      // 0 the gate, holding a stream
    [49, 33],      // 1 corner
    [40, 33],      // 2 guard tunnel — the stream is scanned as it passes
    [26, 33],      // 3 wire room — canonical chunks become the client's dialect
    [16, 33],      // 4 corner
    [11, 27],      // 5 corner
    [11, 16],      // 6 delivery bay — what the client actually receives
    [8, 13],       // 7 corner
    [6, 9]         // 8 back at the desk
  ]);

  /* Refused at a checkpoint: the van reverses down the avenue it came up, and
     the client gets a status code instead of a model. Same road, driven the
     other way, because that is exactly what has happened. */
  var EARLY = makeRoute([
    [54, 9],
    [46, 9],
    [38, 9],
    [30, 9],
    [22, 9],
    [15, 9],
    [12, 11],
    [11, 16],      // 7 delivery bay — the error is a delivery too
    [8, 13],
    [6, 9]
  ]);

  /* Where a request refused at station x joins the turn-back road. The avenue
     and the turn-back share a y, so the van never jumps sideways: it simply
     starts driving the other way from exactly where it stopped. */
  function earlyJoin(x) { return Math.max(0, 54 - x); }

  /* `dwell` is how long the van waits once the reader has already read this
     district. The much longer first-visit stop is derived from the length of
     the write-up; see readSeconds() below. */
  function station(route, idx, id, dwell) {
    return { dist: route.cum[idx], id: id, dwell: dwell == null ? 0.9 : dwell };
  }

  var STATIONS = {
    inbound: [
      station(IN, 0, 'depart', 1.2),
      station(IN, 1, 'gate', 1.2),
      station(IN, 2, 'customs', 1.4),
      station(IN, 3, 'weigh', 1.6),
      station(IN, 4, 'naming', 1.6),
      station(IN, 5, 'inspect', 1.4),
      station(IN, 6, 'tower', 1.8)
    ],
    attempt: [
      station(ATTEMPT, 2, 'mint', 1.2),
      station(ATTEMPT, 4, 'codec', 1.4),
      station(ATTEMPT, 5, 'upstream', 1.8)
    ],
    home: [
      station(HOME, 2, 'guards', 1.4),
      station(HOME, 3, 'wire', 1.4),
      station(HOME, 6, 'deliver', 1.8)
    ],
    early: [
      station(EARLY, 7, 'refused', 1.8)
    ]
  };

  /* Several model steps can share one write-up. `depart` and the two arrival
     stations are the same place seen twice; `refused` and `deliver` are the
     same bay, so a reader who has had the delivery explained is not charged a
     second reading stop for the error version of it. */
  var STATION_TO_DISTRICT = {
    depart: 'client', gate: 'gate', customs: 'customs', weigh: 'weigh',
    naming: 'naming', inspect: 'inspect', tower: 'tower',
    mint: 'mint', codec: 'codec', upstream: 'upstream',
    guards: 'guards', wire: 'wire', deliver: 'deliver', refused: 'deliver'
  };

  /* ---- palette ----------------------------------------------------------- */

  var C = {
    steel:  '#4a7a9b',
    violet: '#6f63a8',
    ochre:  '#c2913c',
    stone:  '#7d8b96',
    rose:   '#b05470',
    sage:   '#6d9068',
    teal:   '#3f8a86',
    orange: '#c07a3c',
    brick:  '#a85a44',
    moss:   '#5f8a52',
    plum:   '#8b5f96',
    indigo: '#5a6f9c',
    ink:    '#4a4540',
    paper:  '#e5e1d5',
    road:   '#c9c4b6',
    roadTop:'#d8d3c6'
  };

  /* ---- districts (clickable, narrated) ----------------------------------- */

  var DISTRICTS = [
    {
      id: 'client', name: 'Client Desk', x: 6, y: 9, r: 3.4, color: C.steel,
      tag: 'One request leaves',
      short: 'Claude Code, Codex and the Gemini CLI all speak different dialects, and none of them speak to a model directly.',
      body: 'The van leaves carrying a body in whichever dialect its client speaks, an alias for the model it wants — often not a real model id — and a server key. Router-Maestro accepts 4 inbound dialects and can answer from any of 4 provider families, so the interesting work is all in the middle. Everything downstream exists to turn those three things into a stream of tokens from something that will actually answer.'
    },
    {
      id: 'gate', name: 'Gatehouse', x: 14, y: 9, r: 3.8, color: C.ochre,
      tag: 'One key, this server',
      short: 'The barrier checks one thing: does this client hold the key to this Router-Maestro?',
      body: 'The key is the server\'s own, generated on first start and shaped sk-rm-…. It is not an OpenAI, Anthropic or GitHub token — the provider credentials live further up the road and the client never sees them. All 8 routers are mounted behind this one dependency, so a wrong key stops here with a 401: no routing, no model cache, no upstream call. Turn the Valid key toggle off and watch the van reverse before it has been weighed.'
    },
    {
      id: 'customs', name: 'Customs House', x: 22, y: 9, r: 4.0, color: C.violet,
      tag: 'Three dialects, one form',
      short: 'Every inbound dialect is rewritten into one canonical request before anything is decided about it.',
      body: 'Anthropic\'s system prompt becomes a system message; tool_use and tool_result blocks become tool calls and tool messages; Gemini\'s contents and parts become messages and content; role "model" becomes "assistant". 4 dialects collapse into 1 canonical shape here, and the operation is fixed at the same moment — one of 5, because a streaming call and a blocking call are different capabilities. From here on the router only handles that one shape, which is why any client can reach any provider.'
    },
    {
      id: 'weigh', name: 'Weighbridge', x: 30, y: 9, r: 4.0, color: C.sage,
      tag: 'What does it weigh?',
      short: 'The load is counted before anyone decides where to send it — and tool schemas weigh more than you think.',
      body: 'Three tokens of overhead per message, then the content, then a flat 16 for having any tools at all plus 8 per tool and a 10% safety margin on every schema. Images are charged by 512-pixel tile. The blocks stacked on the weighbridge are that count, not a picture of it — 1 block per 2,000 tokens. Push File context to 500 KB and watch the stack outgrow the model it was headed for.'
    },
    {
      id: 'naming', name: 'Naming Office', x: 38, y: 9, r: 4.0, color: C.plum,
      tag: 'Alias → identity',
      short: '"Opus 4.6" is not a model id. Something has to turn it into one, deterministically.',
      body: 'Lowercase, spaces and dots to hyphens, then look for an exact identity. Failing that, strip the date suffix and match the family, and take its newest concrete version. Only then does a fuzzy score run — and it refuses at two points: below 85 it is not confident enough, and two families within a point of each other are ambiguous. Both are 400s, not a guess.'
    },
    {
      id: 'inspect', name: 'Inspection Shed', x: 46, y: 9, r: 3.8, color: C.teal,
      tag: 'Supported, unknown, no',
      short: 'Capabilities are three-valued, and the third value is what makes fallback safe.',
      body: 'Every candidate is checked against the operation and the 3 features this request uses — tools, vision, reasoning. Support is 3-valued: supported models sort first, unknown ones after, and a model that has said no is not in the list at all. Unknown is not optimism but honesty about a catalogue that does not always say. A model you named explicitly that cannot do the job gets a 400: it is never quietly swapped.'
    },
    {
      id: 'tower', name: 'Dispatch Tower', x: 54, y: 9, r: 4.2, color: C.indigo,
      tag: 'The plan is frozen',
      short: 'One primary, an ordered pool behind it, and a retry limit that cannot change once the request is moving.',
      body: 'The priorities list decides the order; the fallback strategy decides who is even eligible — the next model down, only the same model on another provider, or nobody at all. The pool is then cut to the retry limit, 2 by default, so a plan is at most 3 stops however many models are compatible. The board is written once and frozen. Nothing later in the request can add a candidate, reorder the pool or raise the limit. Drop Max retries to 0 and the spares vanish from the board.'
    },
    {
      id: 'mint', name: 'Key Mint', x: 62, y: 17, r: 4.0, color: C.rose,
      tag: 'Borrowed, briefly',
      short: 'The credential that goes upstream is not the one on disk, and it is minted per provider.',
      body: 'A GitHub OAuth token is exchanged for a short-lived Copilot token, cached, and reused until it is within 5 minutes of expiry; an API-key provider just carries its key. Every one of the up-to-3 attempts asks for its credential first, so a fallback to a second provider means a different credential as well as a different address — which is exactly why an expired key produces a 401 the router refuses to retry elsewhere.'
    },
    {
      id: 'codec', name: 'Codec Dock', x: 56, y: 28, r: 4.2, color: C.orange,
      tag: 'Repacked for the buyer',
      short: 'The canonical request is re-encoded into whatever wire format the chosen provider actually speaks.',
      body: 'Anthropic-native goes out close to verbatim; anything crossing families is re-encoded, and every streamed chunk is decoded back on the way home. This is also where the request meets the model\'s real limits: the output cap is trimmed to 15% of the prompt budget, and a thinking budget is clamped into 1,024–32,768 — or thinking is switched off entirely rather than sent as an invalid number. The two arches are the dialect in and the dialect out.'
    },
    {
      id: 'upstream', name: 'Upstream Gate', x: 49, y: 28, r: 4.4, color: C.brick,
      tag: 'The one call that costs',
      short: 'Everything so far has cost microseconds. This is where the milliseconds are.',
      body: 'The response is what it is; what matters here is how a failure is read. 429, 500, 502, 503, 504 and 529 are retryable, so the van goes back round the loop for the next candidate. 400 and 401 are not: the same body would fail the same way anywhere, so the router stops and hands back the real reason with the whole attempt ledger.'
    },
    {
      id: 'guards', name: 'Guard Tunnel', x: 40, y: 33, r: 4.2, color: C.moss,
      tag: 'Scanned in flight',
      short: 'The stream is read as it passes, with a fixed amount of memory rather than a copy of the response.',
      body: 'Bounded prefix matchers watch for control envelopes a model should never emit — 5 of them, including task-notification and tick. One aborts the stream mid-flight so the client retries the turn. A tool call leaked as XML is recovered into a structured call at the end instead of being shown to you as text. The window is 512 bytes wide: the cost is fixed memory, not a copy of the response. Set Response contains to either kind and watch the tunnel act.'
    },
    {
      id: 'wire', name: 'Wire Room', x: 26, y: 33, r: 4.2, color: C.stone,
      tag: 'Back into your dialect',
      short: 'Canonical chunks are reassembled into the exact event stream the client is waiting for.',
      body: 'An Anthropic client gets message_start, content_block_delta and message_stop; an OpenAI client gets chat completion chunks; a Codex client gets Responses events reduced from the same 1 canonical stream. A keepalive goes out every 5 seconds so a slow first token does not look like a dead connection. The client cannot tell which of the 4 provider families answered, which is the whole point of the building.'
    },
    {
      id: 'deliver', name: 'Delivery Bay', x: 11, y: 16, r: 3.6, color: C.steel,
      tag: 'What you actually got',
      short: 'A status code, a usage count, and — if it went wrong — which candidates were tried and why it stopped.',
      body: 'A success carries the model that answered, which is not always the one asked for. A failure carries the ledger: each attempt, its provider, its status and whether that status was retryable. That ledger is the difference between "the proxy broke" and "your first choice was rate-limited and the second refused the body". Note how little of the total went on the proxy itself: the bill in the panel breaks it down, and the upstream call is nearly all of it.'
    }
  ];

  var DISTRICT_BY_ID = {};
  DISTRICTS.forEach(function (d) { DISTRICT_BY_ID[d.id] = d; });

  /* First-visit stop, in seconds, scaled to how much there is to read. */
  function readSeconds(stationId) {
    var d = DISTRICT_BY_ID[STATION_TO_DISTRICT[stationId] || stationId];
    if (!d) return 9;
    var words = (d.short + ' ' + d.body).split(/\s+/).length;
    return Math.min(26, Math.max(9, words / 3.8 + 3.5));
  }

  /* ---- fixed positions the renderer needs ------------------------------- */

  /* The four provider compounds beyond the gate. Order matches the order they
     appear in the catalogue, and the renderer lights whichever one the current
     attempt is talking to. */
  var PROVIDER_HALLS = [
    { id: 'github-copilot', label: 'GitHub Copilot', x: 55.5, y: 32.5, color: C.brick },
    { id: 'anthropic', label: 'Anthropic', x: 62.5, y: 32.5, color: C.orange },
    { id: 'openai', label: 'OpenAI', x: 55.5, y: 38.5, color: C.teal },
    { id: 'custom', label: 'custom endpoint', x: 62.5, y: 38.5, color: C.stone }
  ];

  /* One block per 2,000 prompt tokens on the weighbridge, capped so a huge
     context does not build a tower off the top of the screen. */
  var TOKENS_PER_BLOCK = 2000;
  var MAX_BLOCKS = 26;
  function tokenBlockPos(i) {
    var col = i % 2, row = (i / 2) | 0;
    return { x: 29.4 + col * 1.15, y: 11.1 + row * 0.0, z: row * 0.42 };
  }

  /* The departures board on the tower's road-facing wall: one row per planned
     candidate, primary at the top. The renderer fills it from the route plan. */
  function planSlotPos(i) {
    return { x: 53.5, y: 6.45, z: 4.05 - i * 0.62 };
  }

  /* ---- buildings and props ----------------------------------------------- */

  var buildings = [];
  var props = [];

  function put(o) { buildings.push(o); return o; }

  function block(x, y, o) {
    put({
      x: x, y: y, z: 0, w: o.w, d: o.d, h: o.h, color: o.color,
      roof: o.roof, roofH: o.roofH,
      windows: { cols: o.cols || 3, seed: Math.round(x * 7 + y * 13), color: o.lit }
    });
  }

  function distToRoutes(x, y) {
    var best = 1e9;
    [IN, ATTEMPT, HOME, EARLY].forEach(function (r) {
      r.segs.forEach(function (s) {
        var vx = s.b.x - s.a.x, vy = s.b.y - s.a.y;
        var t = ((x - s.a.x) * vx + (y - s.a.y) * vy) / (vx * vx + vy * vy);
        t = Math.max(0, Math.min(1, t));
        var d = Math.hypot(x - (s.a.x + vx * t), y - (s.a.y + vy * t));
        if (d < best) best = d;
      });
    });
    return best;
  }

  function build() {
    if (buildings.length) return;

    /* -- Client Desk: a workstation with a screen, and two client huts ----- */
    put({ kind: 'screen', x: 6.4, y: 5.6, color: C.steel });
    block(2.6, 4.2, { w: 2.6, d: 2.2, h: 2.2, color: '#c3d0d9', cols: 3, lit: C.steel, roof: '#9aa8b2', roofH: 0.6 });
    block(2.8, 11.0, { w: 3.0, d: 2.4, h: 1.9, color: '#b9c9d4', cols: 3, lit: C.steel, roof: '#9aa8b2', roofH: 0.55 });

    /* -- Gatehouse: the road runs under a barrier. Registered as three
          separate pieces so the near post sorts in front of the van and the
          far post behind it. ---------------------------------------------- */
    put({ kind: 'gatePost', x: 14.0, y: 7.3, color: C.ochre });
    put({ kind: 'gateBeam', x: 14.0, y: 9.0, color: C.ochre });
    put({ kind: 'gatePost', x: 14.0, y: 10.7, color: C.ochre });
    put({ kind: 'keyKiosk', x: 16.6, y: 6.0, color: C.ochre });
    block(11.4, 11.4, { w: 2.4, d: 2.0, h: 1.8, color: '#ddc79a', cols: 3, lit: C.ochre });

    /* -- Customs House: a hall with three masts, one per inbound dialect --- */
    put({
      x: 20.2, y: 4.0, z: 0, w: 4.4, d: 3.0, h: 2.8, color: '#c4bedb',
      panels: { cols: 5, seed: 3, color: '#e0d9ee' }, rooftop: C.violet
    });
    put({ kind: 'masts', x: 24.4, y: 11.6, color: C.violet });
    block(19.6, 11.4, { w: 2.4, d: 2.0, h: 1.7, color: '#cec9e0', cols: 3, lit: C.violet });

    /* -- Weighbridge: a low platform beside the road. The stack of blocks on
          it is drawn from the live token count, not from this file. -------- */
    put({ kind: 'weighdeck', x: 30.0, y: 11.4, color: C.sage });
    block(28.4, 4.2, { w: 3.2, d: 2.4, h: 2.4, color: '#b9cdb4', cols: 3, lit: C.sage, roof: '#9ab094', roofH: 0.6 });
    block(33.4, 11.6, { w: 2.2, d: 2.0, h: 1.6, color: '#c3d4bd', cols: 2, lit: C.sage });

    /* -- Naming Office: a filing tower, set well back from the road ------- */
    put({
      x: 36.4, y: 3.4, z: 0, w: 3.4, d: 3.0, h: 5.0, color: '#cbb6d3',
      windows: { cols: 3, seed: 11, color: C.plum }, rooftop: C.plum
    });
    put({ kind: 'cardIndex', x: 40.8, y: 11.8, color: C.plum });
    block(34.6, 11.8, { w: 2.2, d: 2.0, h: 1.6, color: '#d5c3da', cols: 2, lit: C.plum });

    /* -- Inspection Shed: an open canopy with three lamps ----------------- */
    put({ kind: 'canopy', x: 46.0, y: 5.4, color: C.teal });
    block(43.0, 11.8, { w: 2.4, d: 2.0, h: 1.7, color: '#b6cdcb', cols: 3, lit: C.teal });

    /* -- Dispatch Tower: the board on its flank is the actual route plan --- */
    put({ kind: 'tower', x: 54.6, y: 4.6, color: C.indigo });

    /* -- Key Mint: a strongroom with a safe door ------------------------- */
    put({ kind: 'mint', x: 65.2, y: 17.0, color: C.rose });
    block(58.6, 15.4, { w: 2.2, d: 2.2, h: 2.0, color: '#d8bcc6', cols: 2, lit: C.rose });

    /* -- Codec Dock: two gantries, one per wire format ------------------- */
    put({
      x: 55.0, y: 30.6, z: 0, w: 4.6, d: 2.8, h: 2.4, color: '#d9b491',
      panels: { cols: 5, seed: 7, color: '#eed7bd' }, rooftop: C.orange
    });
    put({ kind: 'codecArch', x: 56.6, y: 26.0, color: C.orange });

    /* -- Upstream Gate: a border post, two pillars the road runs between, and
          the provider compounds beyond them. The post sits clear of the point
          the van stops at, or the station's own label plate hides it. ------ */
    put({ kind: 'borderPost', x: 45.8, y: 31.0, color: C.brick });
    put({ kind: 'gatePillar', x: 49.0, y: 26.4, color: C.brick });
    put({ kind: 'gatePillar', x: 49.0, y: 29.6, color: C.brick });
    PROVIDER_HALLS.forEach(function (h, i) {
      put({ kind: 'providerHall', x: h.x, y: h.y, color: h.color, hall: i });
    });

    /* -- Guard Tunnel: the road passes through it. Three pieces again. ---- */
    put({ kind: 'gatePost', x: 40.0, y: 31.3, color: C.moss });
    put({ kind: 'scanBeam', x: 40.0, y: 33.0, color: C.moss });
    put({ kind: 'gatePost', x: 40.0, y: 34.7, color: C.moss });
    block(43.4, 35.4, { w: 2.4, d: 2.0, h: 1.8, color: '#bcd0b4', cols: 3, lit: C.moss });

    /* -- Wire Room: a switchboard hall with reels on the roof ------------- */
    put({
      x: 24.4, y: 35.4, z: 0, w: 4.2, d: 2.8, h: 2.6, color: '#c2c8cc',
      panels: { cols: 5, seed: 13, color: '#dfe4e7' }, rooftop: C.stone
    });
    put({ kind: 'reels', x: 28.8, y: 30.6, color: C.stone });

    /* -- Delivery Bay: a small canopy where the response is handed over --- */
    put({ kind: 'bay', x: 13.8, y: 17.6, color: C.steel });
    block(8.0, 19.6, { w: 2.4, d: 2.2, h: 1.8, color: '#c8d3da', cols: 2, lit: C.steel });

    /* -- scenery ---------------------------------------------------------- */
    var spots = [
      [10, 4], [18, 3], [26, 15], [34, 16], [42, 3], [50, 4], [58, 6],
      [20, 20], [28, 22], [36, 24], [44, 34], [52, 20], [58, 24], [66, 12],
      [16, 24], [10, 27], [20, 38], [30, 39], [38, 39], [14, 38], [6, 33],
      [66, 28], [68, 20], [50, 40], [24, 27], [32, 30], [46, 18], [40, 20],
      /* the band between the avenue and the home road would otherwise read as
         a field with a request driving round it */
      [15, 17], [19, 14], [23, 18], [27, 25], [31, 20], [35, 28], [39, 16],
      [17, 30], [22, 33], [13, 21], [8, 24], [43, 30], [12, 15], [26, 36],
      [33, 36], [46, 38], [54, 16], [60, 6], [64, 34], [68, 40], [4, 17]
    ];
    spots.forEach(function (s, i) {
      if (distToRoutes(s[0], s[1]) < 2.8) return;
      var n = Iso.hash2(s[0], s[1], 3);
      if (n < 0.32) {
        block(s[0], s[1], {
          w: 1.8 + n * 1.6, d: 1.6 + n, h: 1.4 + n * 1.8,
          color: n < 0.16 ? '#d8cfbe' : '#cfc7b6', cols: 2, lit: '#8b9aa4',
          roof: '#b09a86', roofH: 0.5
        });
      } else {
        props.push({ kind: n < 0.7 ? 'tree' : 'lamp', x: s[0], y: s[1], seed: i });
      }
    });
    for (var k = 0; k < 6; k++) {
      var lx = 10 + k * 8;
      props.push({ kind: 'lamp', x: lx, y: k % 2 ? 11.2 : 6.8, seed: lx });
    }
  }

  global.World = {
    GW: 70, GH: 44,
    routes: { inbound: IN, attempt: ATTEMPT, home: HOME, early: EARLY },
    stations: STATIONS,
    districts: DISTRICTS,
    districtById: DISTRICT_BY_ID,
    stationToDistrict: STATION_TO_DISTRICT,
    readSeconds: readSeconds,
    earlyJoin: earlyJoin,
    buildings: buildings,
    props: props,
    palette: C,
    providerHalls: PROVIDER_HALLS,
    tokenBlockPos: tokenBlockPos,
    planSlotPos: planSlotPos,
    TOKENS_PER_BLOCK: TOKENS_PER_BLOCK,
    MAX_BLOCKS: MAX_BLOCKS,
    distToRoutes: distToRoutes,
    build: build
  };
})(window);
