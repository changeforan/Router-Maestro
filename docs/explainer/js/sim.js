/* sim.js: the state machine that walks one request through the town.
 *
 * This is the pacing engine. Three ideas do all the work:
 *
 *   1. The van moves along a route by distance, and a station fires when it
 *      passes one. Stations own the model steps; travel owns nothing.
 *   2. The FIRST time a station fires, the van stops for as long as its
 *      write-up takes to read. Every later visit gets a short beat instead.
 *   3. What the reader has already read (`tour`) lives outside the run state,
 *      so a reset replays the run but not the reading.
 *
 * The one thing here that is not in the template: a request can be refused at
 * a checkpoint, and an attempt can send the van round the loop again. Both
 * live in one place — `jump`, applied by update() right after a station fires.
 */
(function (global) {
  'use strict';

  var RM = global.RM;
  var World = global.World;
  var Iso = global.Iso;

  var BASE_SPEED = 7;        // grid units / second at 1x

  /* Which districts the reader has already had explained. Survives a reset. */
  var tour = { seen: Object.create(null), done: false };

  var state = {
    running: false,
    paused: true,
    finished: false,

    station: null,
    stationT: 0,
    stepMode: false,
    speed: 1,

    /* ---- model inputs, wired to the controls in ui.js ---- */
    dialect: 'anthropic',
    askedModel: 'opus-4-6',
    turns: 6,
    tools: 8,
    contextKB: 60,
    image: false,
    effort: 'high',
    strategy: 'priority',
    maxRetries: 2,
    apiKeyOk: true,
    scenario: 'ratelimited',
    leak: 'none',

    /* ---- model output for the whole trip, recomputed on demand ---- */
    trip: null,

    /* ---- what the van has actually learned so far ---- */
    attemptIdx: 0,
    charged: null,           // station id -> ms actually charged this trip
    spentMs: 0,
    known: null,             // progressive disclosure: what the van carries
    minted: null,            // providers whose credential has been minted
    refusedAt: null,
    outcome: null,

    /* ---- pacing ---- */
    reading: false,
    dwellLeft: 0,
    dwellTotal: 0,
    fastForward: false,
    tourDone: false
  };

  var van = {
    routeName: 'inbound',
    dist: 0,
    dwell: 0,
    stationIdx: 0
  };

  var jump = null;           // set by an op, applied by update()

  var listeners = [];
  function emit(name, payload) {
    for (var i = 0; i < listeners.length; i++) listeners[i](name, payload);
  }

  /* ---- the model ---------------------------------------------------------- */

  /* Recomputed rather than cached, so moving a control mid-trip changes
     everything the van has not yet been charged for. Stations already paid for
     keep the number they were charged. */
  function computeNow() {
    return RM.compute({
      dialect: state.dialect,
      askedModel: state.askedModel,
      turns: state.turns,
      tools: state.tools,
      contextKB: state.contextKB,
      image: state.image,
      effort: state.effort === 'none' ? null : state.effort,
      strategy: state.strategy,
      maxRetries: state.maxRetries,
      apiKeyOk: state.apiKeyOk,
      scenario: state.scenario,
      leak: state.leak,
      tokenWarm: false
    });
  }

  function charge(id, ms) {
    state.trip = computeNow();
    var cost = ms == null ? (state.trip.ms[id] || 0) : ms;
    state.charged[id] = (state.charged[id] || 0) + cost;
    state.spentMs += cost;
    return cost;
  }

  function currentAttempt() {
    var t = state.trip;
    if (!t || !t.attempts) return null;
    return t.attempts[Math.min(state.attemptIdx, t.attempts.length - 1)] || null;
  }

  function currentCandidate() {
    var a = currentAttempt();
    if (a) return a.candidate;
    var t = state.trip;
    if (t && t.plan && t.plan.candidates) {
      return t.plan.candidates[Math.min(state.attemptIdx, t.plan.candidates.length - 1)];
    }
    return null;
  }

  /* ---- lifecycle --------------------------------------------------------- */

  function beginTrip() {
    state.charged = Object.create(null);
    state.spentMs = 0;
    state.station = null;
    state.attemptIdx = 0;
    state.refusedAt = null;
    state.outcome = null;
    state.known = {
      request: false, authed: false, canonical: false, tokens: false,
      resolved: false, inspected: false, planned: false, credential: false,
      encoded: false, answered: false, scanned: false, framed: false
    };
    state.minted = Object.create(null);
    state.fastForward = false;
    state.trip = computeNow();
    van.routeName = 'inbound';
    van.dist = 0;
    van.stationIdx = 0;
    van.dwell = 0;
    jump = null;
  }

  function reset() {
    state.finished = false;
    state.tourDone = tour.done;
    state.reading = false;
    state.dwellLeft = 0;
    state.dwellTotal = 0;
    beginTrip();
  }

  function run() {
    reset();
    state.running = true;
    state.paused = false;
    emit('reset');
  }

  /* ---- per-station work --------------------------------------------------
     This table reads like a summary of the request path, which is the test of
     whether the stations were mapped onto the model properly. */

  function refuse(stationId, x) {
    state.refusedAt = stationId;
    state.outcome = state.trip.outcome;
    jump = { route: 'early', dist: World.earlyJoin(x), stationIdx: 0 };
  }

  var OPS = {
    depart: function () {
      state.known.request = true;
    },

    gate: function () {
      charge('gate');
      state.known.authed = state.apiKeyOk;
      if (!state.apiKeyOk) refuse('gate', 14);
    },

    customs: function () {
      charge('customs');
      state.known.canonical = true;
    },

    weigh: function () {
      charge('weigh');
      state.known.tokens = true;
    },

    naming: function () {
      charge('naming');
      var err = state.trip.plan.error;
      if (err === 'not-found' || err === 'ambiguous' || err === 'low-confidence') {
        refuse('naming', 38);
        return;
      }
      state.known.resolved = true;
    },

    inspect: function () {
      charge('inspect');
      var plan = state.trip.plan;
      if (plan.error === 'no-compatible' || plan.rejected) {
        refuse('inspect', 46);
        return;
      }
      state.known.inspected = true;
    },

    tower: function () {
      charge('tower');
      state.known.planned = true;
    },

    mint: function () {
      /* A credential is per provider, and it is reused for the rest of the
         trip. A fallback to a different provider mints a new one. */
      var candidate = currentCandidate();
      var provider = candidate ? candidate.provider : null;
      var fresh = provider === 'github-copilot' && !state.minted[provider];
      if (provider) state.minted[provider] = true;
      charge('mint', fresh ? RM.COST.mintMs : 0);
      state.known.credential = true;
    },

    codec: function () {
      charge('codec');
      state.known.encoded = true;
    },

    upstream: function () {
      var attempt = currentAttempt();
      charge('upstream', attempt ? attempt.ms : 0);
      if (!attempt) { jump = { route: 'home', dist: 0, stationIdx: 1 }; return; }
      if (attempt.decision === 'selected') {
        state.known.answered = true;
        jump = { route: 'home', dist: 0, stationIdx: 0 };
      } else if (attempt.decision === 'fallback') {
        /* keep driving: the loop itself carries the van back to the tower */
        state.attemptIdx++;
        state.fastForward = true;
      } else {
        state.outcome = state.trip.outcome;
        /* An error is still a response, and it is still translated into the
           client's dialect — but there is no stream, so the guard tunnel has
           nothing to scan and the van drives straight past it. */
        jump = { route: 'home', dist: 0, stationIdx: 1 };
      }
    },

    guards: function () {
      charge('guards');
      state.known.scanned = true;
      if (state.trip.stream && state.trip.stream.abort) state.outcome = state.trip.outcome;
    },

    wire: function () {
      charge('wire');
      state.known.framed = true;
    },

    deliver: function () {
      state.outcome = state.trip.outcome;
      tour.done = allSeen();
      state.tourDone = tour.done;
      emit('trip', state.outcome);
    },

    refused: function () {
      state.outcome = state.trip.outcome;
      tour.done = allSeen();
      state.tourDone = tour.done;
      emit('trip', state.outcome);
    }
  };

  function allSeen() {
    for (var i = 0; i < World.districts.length; i++) {
      if (!tour.seen[World.districts[i].id]) return false;
    }
    return true;
  }

  /* ---- update ------------------------------------------------------------ */

  function routeOf(name) { return World.routes[name]; }

  function travelBoost() {
    return (state.fastForward ? 2.4 : 1) * (state.tourDone ? 3.0 : 1);
  }
  function dwellBoost() {
    return (state.fastForward ? 2.2 : 1) * (state.tourDone ? 1.4 : 1);
  }

  function fire(st) {
    state.station = st.id;
    state.stationT = 0;
    var op = OPS[st.id];
    if (op) op();
    emit('station', st.id);
  }

  function advanceRoute() {
    if (van.routeName === 'attempt') {
      /* Back at the tower with the plan unchanged and the next candidate in
         hand. Same road, different provider — the whole point of the loop. */
      van.routeName = 'attempt';
      van.dist = 0;
      van.stationIdx = 0;
      van.dwell = 0.4;
      return;
    }
    if (van.routeName === 'inbound') {
      van.routeName = 'attempt';
      van.dist = 0;
      van.stationIdx = 0;
      van.dwell = 0.3;
      return;
    }
    /* home and early both end at the desk */
    state.finished = true;
    state.paused = true;
    state.station = 'done';
    emit('station', 'done');
  }

  function update(dt) {
    state.stationT += dt;
    if (!state.running || state.paused || state.finished) return;

    var sdt = dt * state.speed * travelBoost();

    if (van.dwell > 0) {
      /* A stop is measured in reading seconds, so only the speed slider scales
         it; the travel boosts must never cut a first read short. */
      van.dwell -= dt * state.speed;
      state.dwellLeft = Math.max(0, van.dwell);
      if (van.dwell <= 0) { state.reading = false; state.dwellTotal = 0; }
      return;
    }

    var route = routeOf(van.routeName);
    van.dist += BASE_SPEED * sdt;

    var sts = World.stations[van.routeName];
    if (van.stationIdx < sts.length) {
      var st = sts[van.stationIdx];
      if (van.dist >= st.dist) {
        van.dist = st.dist;
        van.stationIdx++;
        /* Keyed by district, not by station: two stations that show the same
           write-up must not charge the reader for a second read. */
        var topic = World.stationToDistrict[st.id] || st.id;
        var firstTime = !tour.seen[topic];
        fire(st);
        tour.seen[topic] = true;
        van.dwell = firstTime ? World.readSeconds(st.id) : st.dwell / dwellBoost();
        state.reading = firstTime;
        state.dwellTotal = van.dwell;
        state.dwellLeft = van.dwell;
        if (jump) {
          van.routeName = jump.route;
          van.dist = jump.dist;
          van.stationIdx = jump.stationIdx;
          jump = null;
        }
        if (state.stepMode) { state.paused = true; state.stepMode = false; }
        return;
      }
    }

    if (van.dist >= route.total) advanceRoute();
  }

  /* ---- queries used by the renderer and the camera ----------------------- */

  function vanPosition() {
    return Iso.smoothAt(routeOf(van.routeName), van.dist, 0.8);
  }

  global.Sim = {
    state: state,
    van: van,
    run: run,
    reset: function () { reset(); emit('reset'); },
    replayTour: function () { tour.seen = Object.create(null); tour.done = false; },
    seen: function (id) { return !!tour.seen[id]; },
    update: update,
    vanPosition: vanPosition,
    computeNow: computeNow,
    currentAttempt: currentAttempt,
    currentCandidate: currentCandidate,
    on: function (fn) { listeners.push(fn); },
    play: function () { if (!state.finished) { state.paused = false; state.running = true; } },
    pause: function () { state.paused = true; },
    toggle: function () { if (state.paused) this.play(); else this.pause(); },
    step: function () {
      if (state.finished) return;
      state.running = true;
      state.stepMode = true;
      state.paused = false;
      if (van.dwell > 0) van.dwell = 0;
    }
  };
})(window);
