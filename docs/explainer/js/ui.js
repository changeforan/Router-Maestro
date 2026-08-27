/* ui.js: DOM panels, controls, narration.
 *
 * The canvas shows the mechanism; this file shows the numbers. Every widget
 * reads Sim.state or calls RM directly — nothing is stored twice, so the panel
 * can never disagree with the map.
 */
(function (global) {
  'use strict';

  var Sim = global.Sim, World = global.World, RM = global.RM;

  var $ = function (id) { return document.getElementById(id); };

  var el = {};
  var activeDistrict = null;
  var pinnedDistrict = null;
  var lastPaint = 0;
  var flyTo = null;
  var sheetOpen = false;

  var STATION_LABEL = {
    depart: 'client', gate: 'api key', customs: 'translate', weigh: 'tokens',
    naming: 'resolve', inspect: 'capability', tower: 'plan', mint: 'credential',
    codec: 'encode', upstream: 'upstream', guards: 'guards', wire: 'reframe',
    deliver: 'delivered', refused: 'refused', done: 'done'
  };

  /* The order the bill is presented in, which is the order the work happens. */
  var COST_ROWS = [
    ['gate', 'API key check'],
    ['customs', 'Dialect translation'],
    ['weigh', 'Token accounting'],
    ['naming', 'Alias resolution'],
    ['inspect', 'Capability ranking'],
    ['tower', 'Route planning'],
    ['mint', 'Credential mint'],
    ['codec', 'Outbound encoding'],
    ['upstream', 'Upstream call'],
    ['guards', 'Stream guards'],
    ['wire', 'Response reframing']
  ];

  /* ------------------------------------------------------------------ init */

  function init() {
    [
      'stage-chip', 'stage-tag', 'stage-name', 'stage-short', 'stage-body',
      'dwell', 'dwell-bar', 'dwell-hint',
      'req-hint', 'sum-dialect', 'sum-op', 'sum-asked', 'sum-resolved', 'sum-features',
      'tok-hint', 'tok-list', 'budget-bar', 'budget-val', 'budget-wrap', 'tok-note',
      'plan-hint', 'plan-list', 'plan-note',
      'ledger-sec', 'ledger-hint', 'ledger-list', 'ledger-note',
      'wf-hint', 'wf-list', 'wf-note',
      'district-chips',
      'hud-phase', 'hud-attempt', 'hud-elapsed', 'hud-carry', 'hud-note',
      'inspector', 'btn-run', 'btn-play', 'play-glyph', 'btn-step', 'btn-reset',
      'speed', 'v-speed', 'turns', 'v-turns', 'context', 'v-context',
      'tools', 'v-tools', 'retries', 'v-retries',
      'dialect', 'asked', 'effort', 'strategy', 'scenario', 'leak',
      'apikey', 'image', 'follow', 'labels',
      'btn-about', 'about', 'about-close', 'btn-panel', 'tooltip',
      'sheet-handle', 'btn-tune', 'dock', 'dock-tune'
    ].forEach(function (id) { el[id] = $(id); });

    buildChips();
    wire();
    applyResponsiveLabels();

    Sim.on(function (name, payload) {
      if (name === 'station') onStation(payload);
      if (name === 'reset') { pinnedDistrict = null; paint(true); }
    });
  }

  function buildChips() {
    World.districts.forEach(function (d) {
      var b = document.createElement('button');
      b.textContent = d.name;
      b.dataset.id = d.id;
      b.addEventListener('click', function () {
        showDistrict(d, true);
        flyTo = { x: d.x, y: d.y };
      });
      el['district-chips'].appendChild(b);
    });
  }

  function wire() {
    el['btn-run'].addEventListener('click', function () { Sim.run(); paint(true); });
    el['btn-play'].addEventListener('click', function () { Sim.toggle(); paint(true); });
    el['btn-step'].addEventListener('click', function () { Sim.step(); });
    /* Run keeps what you have already read; Reset starts the slow tour over. */
    el['btn-reset'].addEventListener('click', function () { Sim.replayTour(); Sim.run(); paint(true); });

    bindRange('speed', 'v-speed', function (v) { Sim.state.speed = v; return v.toFixed(2) + '×'; });
    bindRange('turns', 'v-turns', function (v) { Sim.state.turns = v | 0; return (v | 0) + ''; });
    bindRange('context', 'v-context', function (v) { Sim.state.contextKB = v | 0; return (v | 0) + ' KB'; });
    bindRange('tools', 'v-tools', function (v) { Sim.state.tools = v | 0; return (v | 0) + ''; });
    bindRange('retries', 'v-retries', function (v) { Sim.state.maxRetries = v | 0; return (v | 0) + ''; });

    bindSelect('dialect', function (v) { Sim.state.dialect = v; });
    bindSelect('asked', function (v) { Sim.state.askedModel = v; });
    bindSelect('effort', function (v) { Sim.state.effort = v; });
    bindSelect('strategy', function (v) { Sim.state.strategy = v; });
    bindSelect('scenario', function (v) { Sim.state.scenario = v; });
    bindSelect('leak', function (v) { Sim.state.leak = v; });

    el.apikey.addEventListener('change', function () { Sim.state.apiKeyOk = el.apikey.checked; paint(true); });
    el.image.addEventListener('change', function () { Sim.state.image = el.image.checked; paint(true); });
    el.labels.addEventListener('change', function () { global.Renderer.setLabels(el.labels.checked); });

    el['btn-about'].addEventListener('click', function () { el.about.hidden = false; });
    el['about-close'].addEventListener('click', function () { el.about.hidden = true; });
    el.about.addEventListener('click', function (e) { if (e.target === el.about) el.about.hidden = true; });

    el['btn-panel'].addEventListener('click', function () {
      var hidden = el.inspector.classList.toggle('hidden');
      document.body.classList.toggle('panel-hidden', hidden);
      el['btn-panel'].setAttribute('aria-expanded', String(!hidden));
      applyResponsiveLabels();
    });
    window.addEventListener('resize', applyResponsiveLabels);

    el['sheet-handle'].addEventListener('click', function () { setSheet(!sheetOpen); });

    el['btn-tune'].addEventListener('click', function () {
      var open = el.dock.classList.toggle('tune-open');
      el['btn-tune'].setAttribute('aria-expanded', String(open));
      el['btn-tune'].title = open ? 'Hide settings' : 'Show settings';
    });
  }

  function isMobile() { return window.matchMedia('(max-width: 900px)').matches; }

  function applyResponsiveLabels() {
    var hidden = el.inspector.classList.contains('hidden');
    var narrow = isMobile();
    el['btn-panel'].textContent = narrow ? (hidden ? 'Panel' : 'Hide')
                                         : (hidden ? 'Show panel' : 'Hide panel');
    el['btn-about'].textContent = narrow ? 'About' : 'About & accuracy';
    el['dwell-hint'].innerHTML = narrow
      ? 'reading stop: tap <b>❚❚</b> below to hold it here'
      : 'reading stop: press <kbd>Space</kbd> to hold it here';
  }

  function setSheet(open) {
    sheetOpen = open;
    el.inspector.classList.toggle('open', open);
    el['sheet-handle'].setAttribute('aria-expanded', String(open));
    if (open) el.inspector.scrollTop = 0;
  }

  function bindRange(id, out, fn) {
    var input = el[id];
    var apply = function () { el[out].textContent = fn(parseFloat(input.value)); paint(true); };
    input.addEventListener('input', apply);
    el[out].textContent = fn(parseFloat(input.value));
  }

  function bindSelect(id, fn) {
    var input = el[id];
    var apply = function () { fn(input.value); paint(true); };
    input.addEventListener('change', apply);
    fn(input.value);
  }

  /* -------------------------------------------------------------- narration */

  function onStation(station) {
    var id = station === 'done' ? null : (World.stationToDistrict[station] || station);
    activeDistrict = id;
    if (!pinnedDistrict && id) {
      var d = World.districtById[id];
      if (d) writeCard(d, station);
    }
    if (station === 'done') writeDone();
    paint(true);
  }

  function writeCard(d, station) {
    el['stage-chip'].textContent = STATION_LABEL[station] || d.id;
    el['stage-chip'].style.color = d.color;
    el['stage-chip'].style.background = global.Iso.rgba(d.color, 0.14);
    el['stage-chip'].style.borderColor = global.Iso.rgba(d.color, 0.3);
    el['stage-tag'].textContent = d.tag;
    el['stage-name'].textContent = d.name;
    el['stage-short'].textContent = d.short;
    el['stage-body'].textContent = d.body;
  }

  function writeDone() {
    var s = Sim.state, out = s.outcome || {};
    el['stage-chip'].textContent = out.ok ? 'delivered' : 'failed';
    el['stage-tag'].textContent = out.status + ' ' + (out.label || '');
    el['stage-name'].textContent = out.ok ? 'The client has its stream' : 'The client has an error';
    el['stage-short'].textContent = out.detail || '';
    el['stage-body'].textContent = summarySentence();
  }

  /* One sentence of live interpretation, recomputed from what actually
     happened rather than written in advance. */
  function summarySentence() {
    var s = Sim.state, tr = s.trip;
    if (!tr) return '';
    if (!tr.attempts || !tr.attempts.length) {
      return 'The request was refused before any provider was contacted, which is the cheapest ' +
        'possible failure: ' + RM.fmtMs(s.spentMs) + ' of proxy work and no upstream call at all.';
    }
    var failed = tr.attempts.filter(function (a) { return a.status !== 200; }).length;
    var proxy = Math.round(tr.proxyShare * 100);
    var bits = [];
    bits.push('The proxy\'s own work — translating, counting, resolving, ranking, planning, ' +
      'encoding and reframing — is about ' + proxy + '% of the total; the rest is one provider ' +
      'taking its time.');
    if (failed) {
      bits.push(failed === 1
        ? 'One attempt failed first, and it is in the ledger the client gets back.'
        : failed + ' attempts failed first, and every one of them is in the ledger the ' +
          'client gets back.');
    }
    if (tr.selected && tr.plan.primary && tr.selected.candidate.key !== tr.plan.primary.key) {
      bits.push('The model that answered is not the one that was asked for, which is exactly ' +
        'what a fallback is for — and the client is told which one it was.');
    }
    return bits.join(' ');
  }

  function showDistrict(d, pin) {
    pinnedDistrict = pin ? d.id : null;
    writeCard(d, Sim.state.station);
    if (pin) {
      el['stage-chip'].textContent = 'pinned';
      el['stage-tag'].textContent = d.tag + ' · tap empty ground to resume';
      if (isMobile()) setSheet(true);
    }
    updateChips();
  }

  function updateChips() {
    var kids = el['district-chips'].children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('on', kids[i].dataset.id === (pinnedDistrict || activeDistrict));
    }
  }

  /* ------------------------------------------------------------------ paint */

  function paint(force) {
    var now = performance.now();
    if (!force && now - lastPaint < 90) return;
    lastPaint = now;

    var s = Sim.state;
    var tr = s.trip || Sim.computeNow();

    el['play-glyph'].textContent = s.paused || s.finished ? '▶' : '❚❚';

    el['hud-phase'].textContent = s.station ? (STATION_LABEL[s.station] || s.station) : 'idle';
    el['hud-attempt'].textContent = attemptLabel(s, tr);
    el['hud-elapsed'].textContent = RM.fmtMs(s.spentMs);
    el['hud-carry'].textContent = carryLabel(s, tr);
    el['hud-note'].textContent = hudNote(s, tr);

    var showing = s.reading && s.dwellTotal > 0 && s.dwellLeft > 0;
    el.dwell.hidden = !showing;
    if (showing) {
      el['dwell-bar'].style.width = (s.dwellLeft / s.dwellTotal * 100).toFixed(1) + '%';
    }

    paintRequest(s, tr);
    paintTokens(s, tr);
    paintPlan(s, tr);
    paintLedger(s, tr);
    paintCosts(s, tr);
    updateChips();
  }

  function attemptLabel(s, tr) {
    /* A refused request never becomes an attempt, and saying "1 / 2" while the
       van is reversing down the avenue claims a provider was contacted. */
    if (!tr.plan || tr.plan.error || tr.plan.rejected || s.refusedAt) return 'none made';
    if (!tr.plan.candidates) return '—';
    return (Math.min(s.attemptIdx + 1, tr.plan.candidates.length)) + ' / ' + tr.plan.candidates.length;
  }

  function carryLabel(s, tr) {
    if (!s.known) return '—';
    if (s.known.answered && tr.outputTokens) return RM.fmtTok(tr.outputTokens) + ' out';
    if (s.known.tokens) return RM.fmtTok(tr.tokens.total) + ' in';
    if (s.known.request) return 'an alias and a key';
    return '—';
  }

  function hudNote(s, tr) {
    if (s.finished) return '';
    if (s.reading) return '⏸ holding here so you can read the panel';
    if (!s.running) return 'Press Run to send one request through the yards.';
    if (s.refusedAt) return '↩ refused at the ' + (World.districtById[World.stationToDistrict[s.refusedAt]] || {}).name +
      ': the van reverses down the avenue and the client gets a status code';
    if (s.station === 'upstream') {
      var a = Sim.currentAttempt();
      if (a && a.decision === 'fallback') {
        return '↻ ' + a.status + ' is retryable — round the loop again with the next candidate';
      }
      if (a && a.decision === 'stop') {
        return '⛔ ' + a.status + ' is not retryable — the same body would fail the same way anywhere';
      }
    }
    if (s.fastForward) return '⏩ same road, next candidate: a fallback is one more lap of the attempt loop';
    if (s.tourDone) return '⏩ every district explained, running the rest at speed (drag Speed down to slow it)';
    return '';
  }

  /* "a, b and c" — a comma-joined list of two reads as a mistake. */
  function joinAnd(list) {
    if (list.length < 2) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function paintRequest(s, tr) {
    el['sum-dialect'].textContent = tr.dialect.client;
    el['sum-op'].textContent = tr.operation;
    el['sum-asked'].textContent = s.askedModel;
    el['req-hint'].textContent = tr.dialect.path;

    var resolved = '—';
    if (tr.plan && tr.plan.error) resolved = tr.plan.error;
    else if (s.known && (s.known.resolved || s.known.planned) && tr.plan.primary) {
      var cand = Sim.currentCandidate() || tr.plan.primary;
      resolved = cand.key;
    } else if (tr.plan && tr.plan.primary) resolved = 'decided at the Naming Office';
    el['sum-resolved'].textContent = resolved;

    var feats = [];
    if (tr.features.tools) feats.push(tr.tools.length + ' tools');
    if (tr.features.vision) feats.push('an image');
    if (tr.features.reasoning) feats.push('reasoning');
    var line = feats.length
      ? 'This request uses ' + joinAnd(feats) + ', so every candidate has to support ' +
        (feats.length === 1 ? 'it' : 'all of them') + '.'
      : 'Plain text, no tools: almost anything in the catalogue can serve it.';
    if (tr.effort && tr.effort.resolved) {
      /* The catalogue can carry Copilot's "none" sentinel alongside the real
         tiers. It is capability metadata, not something a client can ask for,
         so the ladder drops it — and so does this sentence. */
      var tiers = tr.effort.allowed.filter(function (v) {
        return RM.EFFORT_ORDER.indexOf(v) >= 0;
      });
      line += ' Reasoning asked for "' + tr.effort.asked + '"; this model advertises ' +
        (tiers.length ? tiers.join(', ') : 'no tier at all') + ', so it goes upstream as "' +
        tr.effort.upstream + '"' +
        (tr.effort.substituted ? ' — the highest tier at or below what was asked, never above it.' : '.');
    }
    el['sum-features'].textContent = line;
  }

  function paintTokens(s, tr) {
    var t = tr.tokens;
    var rows = [
      ['messages', 'Messages', t.messages],
      ['images', 'Image tiles', t.images],
      ['tools', 'Tool schemas', t.tools],
      ['completion', 'Reply priming', t.completion]
    ];
    var max = Math.max(1, t.messages, t.tools, t.images, t.completion);
    el['tok-hint'].textContent = RM.fmtTok(t.total) + ' total';
    el['tok-list'].innerHTML = rows.map(function (r) {
      var zero = r[2] < 1;
      return '<div class="bar' + (zero ? ' cut' : ' paid') + '">' +
        '<span class="lbl">' + r[1] + '</span>' +
        '<span class="track"><span class="fill" style="width:' + (r[2] / max * 100).toFixed(1) + '%"></span></span>' +
        '<span class="val">' + (zero ? '—' : RM.fmtTok(r[2])) + '</span></div>';
    }).join('');

    var cand = Sim.currentCandidate() || (tr.plan && tr.plan.primary);
    var budget = cand ? RM.contextBudget(cand.model) : null;
    if (!budget) {
      el['budget-wrap'].hidden = true;
      el['tok-note'].textContent = 'No model chosen yet, so there is nothing to measure the prompt against.';
      return;
    }
    el['budget-wrap'].hidden = false;
    var share = t.total / budget.maxPromptTokens;
    el['budget-bar'].style.width = Math.min(100, share * 100).toFixed(1) + '%';
    el['budget-bar'].className = share > 1 ? 'over' : share > 0.75 ? 'warn' : '';
    el['budget-val'].textContent = Math.round(share * 100) + '% of ' + RM.fmtTok(budget.maxPromptTokens);
    el['tok-note'].textContent = share > 1
      ? 'Over budget for ' + cand.model.id + '. The upstream answers 400 — and a 400 is not retryable, ' +
        'so the router stops rather than sending the same oversized body to the next provider.'
      : 'Usable prompt space is the context window minus the effective output cap, and that cap is ' +
        'the smaller of the model\'s own limit and 15% of its prompt budget — here ' +
        RM.fmtTok(budget.maxOutputTokens) + ' out of a ' + RM.fmtTok(budget.contextWindow) + ' window.';
  }

  function paintPlan(s, tr) {
    var plan = tr.plan;
    if (!plan || plan.error || !plan.primary) {
      el['plan-hint'].textContent = plan && plan.error ? plan.error : '';
      el['plan-list'].innerHTML = '';
      el['plan-note'].textContent = plan && plan.trace ? plan.trace[plan.trace.length - 1] || '' : '';
      return;
    }
    el['plan-hint'].textContent = s.known && s.known.planned ? 'frozen' : 'projected';
    var cands = plan.candidates;
    el['plan-list'].innerHTML = cands.map(function (c, i) {
      var attempt = tr.attempts && tr.attempts[i];
      var done = i < s.attemptIdx || (attempt && attempt.decision === 'selected' && s.known.answered);
      var cls = i === 0 ? 'primary' : 'fallback';
      if (done && attempt && attempt.status === 200) cls += ' ok';
      else if (done) cls += ' bad';
      return '<div class="row ' + cls + '">' +
        '<span class="idx">' + (i === 0 ? 'primary' : 'fallback ' + i) + '</span>' +
        '<span class="who">' + escapeHtml(c.key) + '</span>' +
        '<span class="badge ' + c.support + '">' + c.support + '</span>' +
        '</div>';
    }).join('');
    var dropped = plan.pool.length - plan.fallbacks.length;
    el['plan-note'].textContent = 'Strategy "' + s.strategy + '", retry limit ' + plan.maxFallbackAttempts + '. ' +
      (dropped > 0
        ? dropped + ' more compatible candidate' + (dropped === 1 ? '' : 's') +
          ' exist but sit outside the limit, and nothing in flight can pull them in.'
        : 'The pool is exactly the retry limit deep; the plan cannot grow once the request is moving.');
  }

  function paintLedger(s, tr) {
    var attempts = (tr.attempts || []).slice(0, Math.max(1, s.attemptIdx + 1));
    var shown = attempts.filter(function (a, i) {
      return i < s.attemptIdx || (s.charged && s.charged.upstream != null);
    });
    if (!shown.length) {
      el['ledger-sec'].hidden = true;
      return;
    }
    el['ledger-sec'].hidden = false;
    el['ledger-hint'].textContent = shown.length + ' attempt' + (shown.length === 1 ? '' : 's');
    el['ledger-list'].innerHTML = shown.map(function (a, i) {
      var ok = a.status === 200;
      return '<div class="row ' + (ok ? 'ok' : 'bad') + '">' +
        '<span class="idx">#' + (i + 1) + '</span>' +
        '<span class="who">' + escapeHtml(a.candidate.key) + '</span>' +
        '<span class="code">' + a.status + '</span>' +
        '<span class="kind">' + (ok ? 'selected' : a.kind + (a.retryable ? ' · retryable' : ' · final')) + '</span>' +
        '</div>' + (a.why ? '<p class="fine why">' + escapeHtml(a.why) + '</p>' : '');
    }).join('');
    var last = shown[shown.length - 1];
    el['ledger-note'].textContent = last.status === 200
      ? 'The ledger travels with the response: the client is told which model actually answered.'
      : 'Retryable statuses are 429, 500, 502, 503, 504 and 529. Everything else stops the walk, ' +
        'because the same request would fail the same way at the next provider.';
  }

  function paintCosts(s, tr) {
    var max = 1;
    COST_ROWS.forEach(function (r) {
      var v = tr.ms[r[0]] || 0;
      if (v > max) max = v;
    });
    var paidCount = s.charged ? Object.keys(s.charged).length : 0;
    el['wf-hint'].textContent = paidCount ? paidCount + ' of ' + COST_ROWS.length + ' paid' : 'projected';

    el['wf-list'].innerHTML = COST_ROWS.map(function (r) {
      var paid = s.charged && s.charged[r[0]] != null;
      var live = s.station === r[0];
      var ms = paid ? s.charged[r[0]] : (tr.ms[r[0]] || 0);
      var zero = ms < 0.005;
      return '<div class="bar' + (paid ? ' paid' : '') + (live ? ' live' : '') + (zero ? ' cut' : '') + '">' +
        '<span class="lbl">' + r[1] + '</span>' +
        '<span class="track"><span class="fill" style="width:' + (ms / max * 100).toFixed(1) + '%"></span></span>' +
        '<span class="val">' + (zero ? '—' : RM.fmtMs(ms)) + '</span></div>';
    }).join('');

    el['wf-note'].textContent = 'Every millisecond on this list is assumed — nothing here touches a ' +
      'network. What is worth reading is the ratio: ' + Math.round((tr.proxyShare || 0) * 100) +
      '% of this request is the proxy thinking and ' + (100 - Math.round((tr.proxyShare || 0) * 100)) +
      '% is one provider generating. Routing is cheap; models are not.';
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------------- exports */

  global.UI = {
    init: init,
    paint: paint,
    run: function () { Sim.run(); paint(true); },
    resetAll: function () { Sim.replayTour(); Sim.run(); paint(true); },
    showDistrict: showDistrict,
    unpin: function () { pinnedDistrict = null; updateChips(); },
    activeDistrict: function () { return pinnedDistrict || activeDistrict; },
    takeFlyTo: function () { var f = flyTo; flyTo = null; return f; },
    el: el
  };
})(window);
