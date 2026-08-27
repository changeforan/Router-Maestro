/* render.js: a canvas 2D painter's-algorithm renderer.
 *
 * There is no z-buffer and no 3D library. Everything with a footprint on the
 * ground goes into one list, that list is sorted by x + y (distance from the
 * camera in this projection), and it is painted back to front.
 *
 * Layers, in order: sky, ground, district washes, roads, THE SORTED PASS,
 * then screen-space labels with the world transform removed.
 *
 * Every landmark that shows a number reads it from Sim.state.trip — the model
 * output — rather than keeping its own copy. The blocks on the weighbridge are
 * the token count. The bars on the tower are the route plan.
 */
(function (global) {
  'use strict';

  var Iso = global.Iso, World = global.World, Sim = global.Sim, RM = global.RM;
  var P = Iso.project;

  var cam = null, ctx = null, t = 0;
  var labels = [];
  var showLabels = true;
  var C = World.palette;

  /* ------------------------------------------------------------------ sky */

  function drawSky(w, h) {
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#eef3f6');
    g.addColorStop(0.55, '#e9eef0');
    g.addColorStop(1, '#e3e6e2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /* --------------------------------------------------------------- ground */

  function plate(inset, z) {
    return [
      P(inset, inset, z), P(World.GW - inset, inset, z),
      P(World.GW - inset, World.GH - inset, z), P(inset, World.GH - inset, z)
    ];
  }

  var GRASS = ['#8aa96a', '#93b073', '#83a463', '#9ab77c'];

  function drawGround() {
    ctx.fillStyle = 'rgba(120,124,110,0.30)';
    Iso.poly(ctx, plate(-0.9, -0.35));

    ctx.fillStyle = '#93b073';
    Iso.poly(ctx, plate(0, 0));

    /* Deterministic tufts: hash2, never Math.random(), or the field shimmers
       on every frame. */
    for (var gx = 1; gx < World.GW; gx += 2) {
      for (var gy = 1; gy < World.GH; gy += 2) {
        var n = Iso.hash2(gx, gy, 17);
        if (n < 0.45) continue;
        ctx.fillStyle = GRASS[(n * 4) | 0];
        Iso.disc(ctx, gx + n, gy + (1 - n), 0, 0.7 + n * 0.5);
      }
    }

    ctx.strokeStyle = 'rgba(74,69,64,0.28)';
    ctx.lineWidth = 1.4;
    Iso.polyLine(ctx, plate(0, 0), true);
  }

  function drawZones(activeId) {
    for (var i = 0; i < World.districts.length; i++) {
      var d = World.districts[i];
      var on = d.id === activeId;
      ctx.fillStyle = Iso.rgba(d.color, on ? 0.16 : 0.055);
      Iso.disc(ctx, d.x, d.y, 0.01, d.r);
      if (on) {
        ctx.strokeStyle = Iso.rgba(d.color, 0.5);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        var p = P(d.x, d.y, 0.01);
        ctx.ellipse(p.x, p.y, d.r * Iso.TW * 1.41421, d.r * Iso.TH * 1.41421, 0, 0, 6.2832);
        ctx.stroke();
      }
    }
  }

  /* ---------------------------------------------------------------- roads */

  function roadQuad(a, b, width, dz) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len * width / 2, ny = dx / len * width / 2;
    var za = (a.z || 0) + (dz || 0), zb = (b.z || 0) + (dz || 0);
    Iso.poly(ctx, [
      P(a.x + nx, a.y + ny, za), P(b.x + nx, b.y + ny, zb),
      P(b.x - nx, b.y - ny, zb), P(a.x - nx, a.y - ny, za)
    ]);
  }

  function drawRoute(route, opts) {
    var width = opts.width, i, s;

    ctx.fillStyle = opts.shoulder || C.road;
    for (i = 0; i < route.segs.length; i++) {
      s = route.segs[i];
      roadQuad(s.a, s.b, width + 0.5, 0);
      Iso.disc(ctx, s.a.x, s.a.y, s.a.z || 0, (width + 0.5) / 2);
    }
    var last = route.pts[route.pts.length - 1];
    Iso.disc(ctx, last.x, last.y, last.z || 0, (width + 0.5) / 2);

    ctx.fillStyle = opts.surface || C.roadTop;
    for (i = 0; i < route.segs.length; i++) {
      s = route.segs[i];
      roadQuad(s.a, s.b, width, 0.005);
      Iso.disc(ctx, s.a.x, s.a.y, (s.a.z || 0) + 0.005, width / 2);
    }
    Iso.disc(ctx, last.x, last.y, (last.z || 0) + 0.005, width / 2);

    ctx.strokeStyle = opts.dash || 'rgba(96,90,78,0.35)';
    ctx.lineWidth = 1.3;
    ctx.setLineDash(opts.dashPattern || [6, 7]);
    ctx.beginPath();
    for (i = 0; i < route.pts.length; i++) {
      var p = P(route.pts[i].x, route.pts[i].y, (route.pts[i].z || 0) + 0.01);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawRoads() {
    /* The turn-back road is painted first and narrower: it shares the avenue,
       and it only exists for a request that never gets a model. */
    drawRoute(World.routes.inbound, { width: 2.7 });
    drawRoute(World.routes.attempt, { width: 2.3, surface: '#d5cec0',
      dash: 'rgba(90,111,156,0.5)', dashPattern: [10, 8] });
    drawRoute(World.routes.home, { width: 2.4, surface: '#dcd2c4',
      dash: 'rgba(168,90,68,0.45)' });
  }

  /* ----------------------------------------------------------- landmarks  */

  var FACE_ANG = Math.atan2(Iso.TH, Iso.TW);
  var FACE_U = Math.hypot(Iso.TW, Iso.TH);

  function trip() { return Sim.state.trip; }

  function drawScreen(b) {
    Iso.box(ctx, { x: b.x - 0.9, y: b.y - 0.7, z: 0, w: 1.8, d: 1.4, h: 0.5, color: '#b9b2a2' });
    Iso.box(ctx, { x: b.x - 0.15, y: b.y - 0.1, z: 0.5, w: 0.3, d: 0.3, h: 0.7, color: '#8e8878' });
    Iso.orientedBox(ctx, {
      x: b.x, y: b.y, z: 1.2, hx: 1, hy: -1, len: 2.6, wid: 0.18, h: 1.6, color: '#f4f1e6'
    });
    var s = Sim.state;
    var lit = s.running;
    Iso.orientedBox(ctx, {
      x: b.x, y: b.y, z: 1.35, hx: 1, hy: -1, len: 2.2, wid: 0.06, h: 1.25,
      color: lit ? Iso.mix('#dfe9ef', b.color, 0.45) : '#cfd6d8', edge: false
    });
  }

  /* The gatehouse kiosk: green while the key is good, red the moment it is
     not. The barrier beam drops with it. */
  function drawKeyKiosk(b) {
    Iso.box(ctx, { x: b.x - 0.8, y: b.y - 0.8, z: 0, w: 1.6, d: 1.6, h: 2.2, color: '#e0cda3',
      windows: { cols: 2, seed: 4, color: b.color } });
    var ok = Sim.state.apiKeyOk;
    var p = P(b.x, b.y + 0.8, 1.5);
    ctx.fillStyle = ok ? 'rgba(110,160,96,0.9)' : 'rgba(190,80,70,0.9)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, 6.2832);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,54,44,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawGatePost(b) {
    Iso.box(ctx, { x: b.x - 0.28, y: b.y - 0.28, z: 0, w: 0.56, d: 0.56, h: 3.1, color: b.color });
  }

  function drawGateBeam(b) {
    /* The barrier is down when the key is wrong: the beam sits low across the
       road instead of high above it. */
    var down = !Sim.state.apiKeyOk;
    Iso.box(ctx, {
      x: b.x - 0.3, y: b.y - 1.85, z: down ? 1.1 : 3.1, w: 0.6, d: 3.7, h: 0.42,
      color: down ? '#b8503f' : Iso.mix(b.color, '#ffffff', 0.25)
    });
  }

  /* Three masts, one per inbound dialect. The one the client is speaking flies
     its flag; the others are furled. */
  var MAST_DIALECTS = ['anthropic', 'openai-chat', 'gemini'];
  function drawMasts(b) {
    for (var i = 0; i < 3; i++) {
      var mx = b.x - 1.2 + i * 1.2;
      Iso.cylinder(ctx, { x: mx, y: b.y, z: 0, r: 0.12, h: 3.2, color: '#a9a191' });
      var d = Sim.state.dialect;
      var on = MAST_DIALECTS[i] === d ||
        (i === 1 && d === 'openai-responses');
      var p = P(mx, b.y, 3.2);
      ctx.fillStyle = on ? Iso.rgba(b.color, 0.9) : 'rgba(170,164,150,0.55)';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + (on ? 22 : 8), p.y + 5);
      ctx.lineTo(p.x, p.y + 12);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* The weighbridge deck. The stack on it is the live prompt-token count: one
     block per 2,000 tokens, and the number is printed on the plate. */
  function drawWeighdeck(b) {
    Iso.box(ctx, { x: b.x - 2.0, y: b.y - 1.1, z: 0, w: 4.0, d: 2.2, h: 0.34, color: '#b3c4ad' });
    Iso.box(ctx, { x: b.x - 2.0, y: b.y - 1.1, z: 0.34, w: 4.0, d: 2.2, h: 0.06, color: '#cdd9c8' });

    var s = Sim.state;
    if (!s.known || !s.known.tokens || !trip()) return;
    var total = trip().tokens.total;
    var blocks = Math.min(World.MAX_BLOCKS, Math.max(1, Math.round(total / World.TOKENS_PER_BLOCK)));
    for (var i = 0; i < blocks; i++) {
      var col = i % 3, row = (i / 3) | 0;
      Iso.box(ctx, {
        x: b.x - 1.6 + col * 1.1, y: b.y - 0.6, z: 0.4 + row * 0.34,
        w: 0.9, d: 1.2, h: 0.3,
        color: i % 2 ? '#8fb086' : '#a2c199'
      });
    }
  }

  /* The card index: the candidate families the alias was scored against. */
  function drawCardIndex(b) {
    Iso.box(ctx, { x: b.x - 1.3, y: b.y - 0.9, z: 0, w: 2.6, d: 1.8, h: 1.5, color: '#c9b7d2' });
    Iso.box(ctx, { x: b.x - 1.2, y: b.y - 0.8, z: 1.5, w: 2.4, d: 1.6, h: 0.16, color: '#e0d3e6' });
    var spin = Sim.state.station === 'naming' ? t * 2.2 : 0;
    for (var i = 0; i < 5; i++) {
      var a = spin + i * 1.2566;
      var r = 0.72;
      Iso.orientedBox(ctx, {
        x: b.x + Math.cos(a) * r * 0.25, y: b.y + Math.sin(a) * r * 0.25,
        z: 1.66, hx: Math.cos(a), hy: Math.sin(a), len: 1.3, wid: 0.05, h: 0.5,
        color: i === 0 ? b.color : '#efe8f2', edge: false
      });
    }
  }

  /* The inspection canopy: three lamps, and the count under each is the actual
     number of catalogue candidates in that state for this request. */
  function drawCanopy(b) {
    [-1.7, 1.7].forEach(function (dx) {
      Iso.box(ctx, { x: b.x + dx - 0.2, y: b.y - 1.2, z: 0, w: 0.4, d: 0.4, h: 2.6, color: '#a9bfbd' });
      Iso.box(ctx, { x: b.x + dx - 0.2, y: b.y + 0.9, z: 0, w: 0.4, d: 0.4, h: 2.6, color: '#a9bfbd' });
    });
    Iso.box(ctx, { x: b.x - 2.2, y: b.y - 1.4, z: 2.6, w: 4.4, d: 2.8, h: 0.3, color: '#c6dad7' });

    var counts = candidateCounts();
    var colors = ['rgba(110,160,96,0.95)', 'rgba(205,160,70,0.95)', 'rgba(185,85,72,0.95)'];
    for (var i = 0; i < 3; i++) {
      var p = P(b.x - 1.3 + i * 1.3, b.y + 1.4, 2.5);
      var lit = counts[i] > 0;
      ctx.fillStyle = lit ? colors[i] : 'rgba(160,158,150,0.4)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, lit ? 5.2 : 3.6, 0, 6.2832);
      ctx.fill();
    }
  }

  /* supported / unknown / unsupported across the whole catalogue, for the
     operation and features this request actually asks for. */
  function candidateCounts() {
    var tr = trip();
    if (!tr) return [0, 0, 0];
    var c = [0, 0, 0];
    RM.catalog.forEach(function (m) {
      var s = RM.supportFor(m, tr.operation, tr.features);
      c[s === 'supported' ? 0 : s === 'unknown' ? 1 : 2]++;
    });
    return c;
  }

  /* The dispatch tower. The board on its flank has one bar per planned
     candidate, in plan order: the primary at the top, then the fallbacks that
     survived the retry limit. The bar the van is attempting is lit; a bar that
     has already failed is struck through. */
  function drawTower(b) {
    Iso.box(ctx, { x: b.x - 1.6, y: b.y - 1.6, z: 0, w: 3.2, d: 3.2, h: 5.2, color: '#a8b3d2',
      windows: { cols: 3, seed: 21, color: C.indigo } });
    Iso.box(ctx, { x: b.x - 2.0, y: b.y - 2.0, z: 5.2, w: 4.0, d: 4.0, h: 0.9, color: '#c4cce0' });
    Iso.box(ctx, { x: b.x - 0.3, y: b.y - 0.3, z: 6.1, w: 0.6, d: 0.6, h: 1.4, color: '#8b95af' });
    /* a beacon on the mast, so the tower is findable from across the town */
    var bp = P(b.x, b.y, 7.6);
    ctx.fillStyle = Iso.rgba(C.indigo, 0.55 + 0.35 * Math.abs(Math.sin(t * 1.6)));
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, 4, 0, 6.2832);
    ctx.fill();

    /* the board, on the wall the road runs past */
    var s = Sim.state, tr = trip();
    Iso.box(ctx, { x: b.x - 1.5, y: b.y + 1.55, z: 1.9, w: 3.0, d: 0.12, h: 2.6, color: '#eae7dc' });
    if (!s.known || !s.known.planned || !tr || !tr.plan || !tr.plan.candidates) return;
    var cands = tr.plan.candidates;
    for (var i = 0; i < Math.min(cands.length, 5); i++) {
      var slot = World.planSlotPos(i);
      var attempt = tr.attempts && tr.attempts[i];
      var failed = attempt && attempt.status !== 200 && i < s.attemptIdx;
      var live = i === s.attemptIdx && s.station !== 'done';
      Iso.box(ctx, {
        x: slot.x, y: slot.y, z: slot.z, w: 2.4, d: 0.1, h: 0.42,
        color: failed ? '#b8756a' : live ? '#e6b44a' : '#98a3bd',
        edge: false
      });
    }
  }

  /* The mint: a strongroom whose door turns while a credential is being
     exchanged, and a lamp per provider already carrying one this trip. */
  function drawMint(b) {
    Iso.box(ctx, { x: b.x - 2.0, y: b.y - 1.6, z: 0, w: 3.2, d: 3.2, h: 2.8, color: '#dcc0ca',
      panels: { cols: 4, seed: 6, color: '#f0dde3' } });
    var p = P(b.x - 2.0, b.y + 0.2, 1.4);
    var rx = 1.0 * FACE_U, ry = 1.1 * Iso.TZ;
    ctx.fillStyle = Iso.shade(b.color, 0.95);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rx, ry, FACE_ANG, 0, 6.2832);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,50,58,0.5)';
    ctx.lineWidth = 1.3;
    ctx.stroke();

    var spin = Sim.state.station === 'mint' ? t * 1.4 : 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(FACE_ANG);
    ctx.strokeStyle = 'rgba(70,50,58,0.55)';
    ctx.lineWidth = 1.7;
    for (var i = 0; i < 4; i++) {
      var a = spin + i * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(-Math.cos(a) * rx * 0.7, -Math.sin(a) * ry * 0.7);
      ctx.lineTo(Math.cos(a) * rx * 0.7, Math.sin(a) * ry * 0.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Two arches over the dock road: one stamped with the dialect that came in,
     one with the wire format going out. They differ exactly when the request
     is crossing provider families. */
  function drawCodecArch(b) {
    var cross = trip() && trip().codec ? trip().codec.cross : false;
    [[-1.5, b.color], [1.5, cross ? '#7c9ac0' : b.color]].forEach(function (pair) {
      var ox = pair[0];
      Iso.box(ctx, { x: b.x + ox - 0.22, y: b.y - 1.7, z: 0, w: 0.44, d: 0.44, h: 2.7, color: pair[1] });
      Iso.box(ctx, { x: b.x + ox - 0.22, y: b.y + 1.3, z: 0, w: 0.44, d: 0.44, h: 2.7, color: pair[1] });
      Iso.box(ctx, { x: b.x + ox - 0.26, y: b.y - 1.8, z: 2.7, w: 0.52, d: 3.6, h: 0.34,
        color: Iso.mix(pair[1], '#ffffff', 0.3) });
    });
  }

  /* The two pillars the road runs between at the border. Separate pieces, so
     the near one sorts in front of the van and the far one behind it. */
  function drawGatePillar(b) {
    Iso.box(ctx, { x: b.x - 0.32, y: b.y - 0.32, z: 0, w: 0.64, d: 0.64, h: 2.4, color: b.color });
    Iso.box(ctx, { x: b.x - 0.44, y: b.y - 0.44, z: 2.4, w: 0.88, d: 0.88, h: 0.28,
      color: Iso.mix(b.color, '#ffffff', 0.3) });
  }

  function drawBorderPost(b) {
    Iso.box(ctx, { x: b.x - 1.1, y: b.y - 1.0, z: 0, w: 2.2, d: 2.0, h: 2.4, color: '#d7b2a6',
      windows: { cols: 2, seed: 9, color: b.color } });
    Iso.gableRoof(ctx, { x: b.x - 1.25, y: b.y - 1.15, z: 2.4, w: 2.5, d: 2.3, h: 0.55, color: '#b98d7e' });
  }

  /* One hall per provider. The hall the current attempt is talking to is lit
     and has a dish pointed at it; a hall that already refused this request
     carries the status it returned. */
  function drawProviderHall(b) {
    var hall = World.providerHalls[b.hall];
    var tr = trip();
    var s = Sim.state;
    var active = false, failedStatus = null;
    if (tr && tr.attempts) {
      for (var i = 0; i < tr.attempts.length; i++) {
        var a = tr.attempts[i];
        if (a.candidate.provider !== hall.id) continue;
        if (i === s.attemptIdx && s.known && s.known.planned) active = true;
        if (i < s.attemptIdx && a.status !== 200) failedStatus = a.status;
      }
    }
    var base = active ? Iso.mix('#cfd3cf', hall.color, 0.45) : '#cfd3cf';
    Iso.box(ctx, {
      x: b.x - 2.4, y: b.y - 1.7, z: 0, w: 4.8, d: 3.4, h: 3.0, color: base,
      panels: { cols: 5, seed: 17 + b.hall, color: active ? '#f2ece2' : '#e2e4e0' }
    });
    Iso.box(ctx, { x: b.x - 1.9, y: b.y - 1.2, z: 3.0, w: 3.8, d: 2.4, h: 0.34,
      color: Iso.mix(hall.color, '#ffffff', active ? 0.2 : 0.55) });

    /* the dish, turned toward the gate while this hall is being called */
    Iso.cylinder(ctx, { x: b.x - 2.9, y: b.y - 2.1, z: 0, r: 0.3, h: 1.6, color: '#b6b0a0' });
    var p = P(b.x - 2.9, b.y - 2.1, 1.6);
    ctx.fillStyle = active ? Iso.shade(hall.color, 1.02) : 'rgba(178,174,164,0.85)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - 9, 16, 9, -0.5, 0, 6.2832);
    ctx.fill();
    ctx.strokeStyle = 'rgba(74,69,64,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (failedStatus) {
      var q = P(b.x, b.y - 1.7, 2.2);
      ctx.fillStyle = 'rgba(184,80,63,0.9)';
      ctx.font = '600 12px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(failedStatus), q.x, q.y);
    }
  }

  /* The scanner arch over the home road. Its lamps fill as the stream passes
     through it, and it goes red when the guard aborts. */
  function drawScanBeam(b) {
    var tr = trip();
    var aborted = tr && tr.stream && tr.stream.abort;
    Iso.box(ctx, {
      x: b.x - 0.34, y: b.y - 1.9, z: 3.1, w: 0.68, d: 3.8, h: 0.5,
      color: aborted ? '#b8503f' : Iso.mix(b.color, '#ffffff', 0.3)
    });
    var live = Sim.state.station === 'guards';
    var lamps = 7;
    for (var i = 0; i < lamps; i++) {
      var p = P(b.x, b.y - 1.6 + i * 0.53, 3.05);
      var on = live && (Math.sin(t * 5 - i * 0.7) > 0);
      ctx.fillStyle = aborted ? 'rgba(184,80,63,0.9)'
        : on ? 'rgba(120,170,105,0.95)' : 'rgba(150,160,145,0.45)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, 6.2832);
      ctx.fill();
    }
  }

  /* Reels on the wire room roof, turning while the response is being reframed
     into the client's dialect. */
  function drawReels(b) {
    var spin = Sim.state.station === 'wire' ? t * 3 : t * 0.3;
    for (var i = 0; i < 3; i++) {
      var x = b.x - 1.3 + i * 1.3;
      Iso.cylinder(ctx, { x: x, y: b.y, z: 0, r: 0.22, h: 1.5, color: '#a8a89e' });
      Iso.gear(ctx, x, b.y, 1.6, 0.62, 10, spin + i * 0.5, i % 2 ? '#b9c2c7' : '#cdd4d8');
    }
  }

  function drawBay(b) {
    [-1.5, 1.5].forEach(function (dx) {
      Iso.box(ctx, { x: b.x + dx - 0.18, y: b.y - 1.1, z: 0, w: 0.36, d: 0.36, h: 2.3, color: '#b3c0c8' });
      Iso.box(ctx, { x: b.x + dx - 0.18, y: b.y + 0.9, z: 0, w: 0.36, d: 0.36, h: 2.3, color: '#b3c0c8' });
    });
    Iso.box(ctx, { x: b.x - 2.0, y: b.y - 1.3, z: 2.3, w: 4.0, d: 2.6, h: 0.28, color: '#d3dde2' });
    var out = Sim.state.outcome;
    if (out) {
      var p = P(b.x, b.y - 1.3, 2.0);
      ctx.fillStyle = out.ok ? 'rgba(110,160,96,0.95)' : 'rgba(184,80,63,0.95)';
      ctx.font = '600 13px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(out.status), p.x, p.y);
    }
  }

  function drawRooftop(o) {
    var m = 0.5;
    Iso.box(ctx, {
      x: o.x + m, y: o.y + m, z: o.z + o.h, w: Math.max(0.8, o.w - m * 2),
      d: Math.max(0.8, o.d - m * 2), h: 0.4, color: Iso.mix(o.rooftop, '#ffffff', 0.35)
    });
  }

  var KIND = {
    screen: drawScreen, keyKiosk: drawKeyKiosk, gatePost: drawGatePost,
    gateBeam: drawGateBeam, masts: drawMasts, weighdeck: drawWeighdeck,
    cardIndex: drawCardIndex, canopy: drawCanopy, tower: drawTower,
    mint: drawMint, codecArch: drawCodecArch, borderPost: drawBorderPost,
    gatePillar: drawGatePillar,
    providerHall: drawProviderHall, scanBeam: drawScanBeam, reels: drawReels,
    bay: drawBay
  };

  /* -------------------------------------------------------- small props  */

  function drawLamp(p) {
    Iso.cylinder(ctx, { x: p.x, y: p.y, z: 0, r: 0.13, h: 2.7, color: '#9c968a' });
    Iso.box(ctx, { x: p.x - 0.28, y: p.y - 0.22, z: 2.7, w: 0.56, d: 0.44, h: 0.18, color: '#c8c2b2' });
  }

  function drawTree(p) {
    var n = Iso.hash2(p.x, p.y, p.seed || 1);
    Iso.cylinder(ctx, { x: p.x, y: p.y, z: 0, r: 0.18, h: 0.9 + n * 0.4, color: '#8a7358' });
    var r = 0.85 + n * 0.5;
    ctx.fillStyle = n < 0.5 ? '#5f8a52' : '#6d9068';
    Iso.disc(ctx, p.x, p.y, 1.5 + n * 0.8, r);
    ctx.fillStyle = Iso.rgba('#ffffff', 0.16);
    Iso.disc(ctx, p.x - r * 0.25, p.y - r * 0.25, 1.62 + n * 0.8, r * 0.6);
  }

  /* --------------------------------------------------------------- the van
     The vehicle is carrying the request, not representing it. The gauge on its
     flank is the prompt measured against the chosen model's usable budget. The
     crates are the tokens on the wire — the prompt on the way out, the reply on
     the way home. The three roof lamps are the features the request actually
     uses, which is what the inspection shed will check it against. */

  var CRATE_PER_PROMPT_TOKENS = 4000;   // one crate per 4,000 prompt tokens
  var CRATE_PER_OUTPUT_TOKENS = 25;     // one crate per 25 output tokens

  function drawVan(v) {
    var s = Sim.state, tr = trip();
    var hx = v.dx, hy = v.dy;
    var z = v.z || 0;
    var homeward = s.known && s.known.answered;

    ctx.fillStyle = 'rgba(80,76,66,0.22)';
    Iso.disc(ctx, v.x, v.y, z + 0.01, 1.05);

    Iso.orientedBox(ctx, { x: v.x, y: v.y, z: z + 0.16, hx: hx, hy: hy, len: 2.5, wid: 1.25, h: 0.34, color: '#5c6a72' });
    Iso.orientedBox(ctx, { x: v.x - hx * 0.35, y: v.y - hy * 0.35, z: z + 0.5, hx: hx, hy: hy, len: 1.7, wid: 1.2, h: 1.0, color: '#eae6da' });
    Iso.orientedBox(ctx, {
      x: v.x + hx * 0.85, y: v.y + hy * 0.85, z: z + 0.5, hx: hx, hy: hy, len: 0.85, wid: 1.1, h: 0.76,
      color: s.outcome && !s.outcome.ok ? '#b8503f' : '#4e6a86'
    });

    /* the gauge: prompt tokens against the usable prompt budget of the model
       this lap is attempting. Both numbers come out of model.js. */
    var frac = 0;
    if (s.known && s.known.tokens && tr && tr.tokens) {
      var cand = Sim.currentCandidate();
      var budget = cand ? RM.contextBudget(cand.model) : (tr.budget || null);
      if (budget) frac = Math.min(1.6, tr.tokens.total / budget.maxPromptTokens);
    }
    var px = -hy, py = hx;
    var side = (px + py) > 0 ? 1 : -1;
    var gx = v.x - hx * 0.35 + px * side * 0.63;
    var gy = v.y - hy * 0.35 + py * side * 0.63;
    var GLEN = 1.5;
    Iso.orientedBox(ctx, {
      x: gx, y: gy, z: z + 0.72, hx: hx, hy: hy, len: GLEN, wid: 0.03, h: 0.42,
      color: '#6d675c', edge: false
    });
    if (frac > 0) {
      var shown = Math.min(1, frac);
      Iso.orientedBox(ctx, {
        x: gx - hx * (GLEN * (1 - shown) / 2), y: gy - hy * (GLEN * (1 - shown) / 2),
        z: z + 0.74, hx: hx, hy: hy, len: Math.max(0.07, GLEN * shown - 0.06),
        wid: 0.05, h: 0.34,
        color: frac > 1 ? '#c04a3a' : frac > 0.66 ? '#e4643f' : frac > 0.33 ? '#e8b34a' : '#7fc06a',
        edge: false
      });
    }

    /* the cargo */
    var crates = 0;
    if (homeward && tr && tr.outputTokens) {
      crates = Math.max(1, Math.min(8, Math.round(tr.outputTokens / CRATE_PER_OUTPUT_TOKENS)));
    } else if (s.known && s.known.tokens && tr && tr.tokens) {
      crates = Math.max(1, Math.min(8, Math.round(tr.tokens.total / CRATE_PER_PROMPT_TOKENS)));
    }
    for (var i = 0; i < crates; i++) {
      var row = i % 2, col = (i / 2) | 0;
      Iso.orientedBox(ctx, {
        x: v.x - hx * (0.9 - col * 0.42) + px * (row ? 0.28 : -0.28),
        y: v.y - hy * (0.9 - col * 0.42) + py * (row ? 0.28 : -0.28),
        z: z + 1.5, hx: hx, hy: hy, len: 0.38, wid: 0.4, h: 0.34,
        color: homeward ? (i % 2 ? '#8fb086' : '#a2c199')
                        : (i % 3 === 0 ? '#c2913c' : i % 3 === 1 ? '#a8926a' : '#b8a577')
      });
    }

    /* feature lamps on the cab roof: tools, vision, reasoning */
    if (tr && tr.features) {
      var lamps = [
        [tr.features.tools, '#c2913c'],
        [tr.features.vision, '#3f8a86'],
        [tr.features.reasoning, '#6f63a8']
      ];
      for (var k = 0; k < 3; k++) {
        var lp = P(v.x + hx * 0.85 + px * (k - 1) * 0.34, v.y + hy * 0.85 + py * (k - 1) * 0.34, z + 1.32);
        ctx.fillStyle = lamps[k][0] ? Iso.rgba(lamps[k][1], 0.95) : 'rgba(160,158,150,0.35)';
        ctx.beginPath();
        ctx.arc(lp.x, lp.y, 2.8, 0, 6.2832);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#3f3a34';
    [[0.8, 0.5], [0.8, -0.5], [-0.8, 0.5], [-0.8, -0.5]].forEach(function (o) {
      Iso.disc(ctx, v.x + hx * o[0] + px * o[1], v.y + hy * o[0] + py * o[1], z + 0.14, 0.22);
    });
  }

  /* -------------------------------------------------------------- labels  */

  function drawLabels() {
    /* Screen space, but still dpr-scaled: cam.ox and cam.scale are in CSS
       pixels, so an identity transform would put every plate at half position
       on a 2x display. */
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.textBaseline = 'middle';

    labels.sort(function (a, b) { return (b.pri || 0) - (a.pri || 0); });

    var placed = [];
    var i;
    for (i = 0; i < labels.length; i++) {
      var L = labels[i];
      var p = P(L.x, L.y, L.z);
      L.ax = p.x * cam.scale + cam.ox;
      L.ay = p.y * cam.scale + cam.oy;

      L.px = (L.size || 12) * Math.min(1.15, Math.max(0.92, cam.scale));
      ctx.font = (L.bold ? '600 ' : '') + L.px + 'px ' + fontOf(L);
      var wpx = ctx.measureText(L.text).width;
      var subw = L.sub ? ctx.measureText(L.sub).width * 0.85 : 0;
      L.boxW = Math.max(wpx, subw) + 16;
      L.boxH = L.sub ? L.px * 2.4 : L.px * 1.75;
      L.sy = L.lift ? L.ay - L.lift - L.boxH / 2 : L.ay;

      for (var tries = 0; tries < 10 && overlaps(L, placed); tries++) {
        L.sy -= L.boxH * 0.92;
      }
      placed.push(L);
    }

    for (i = 0; i < labels.length; i++) drawPlate(labels[i]);
  }

  function fontOf(L) {
    return L.mono
      ? 'ui-monospace, Menlo, Consolas, monospace'
      : '"Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif';
  }

  function overlaps(L, placed) {
    for (var i = 0; i < placed.length; i++) {
      var o = placed[i];
      if (Math.abs(L.ax - o.ax) < (L.boxW + o.boxW) / 2 + 2 &&
          Math.abs(L.sy - o.sy) < (L.boxH + o.boxH) / 2 + 2) return true;
    }
    return false;
  }

  function drawPlate(L) {
    var ax = L.ax, ay = L.ay, sy = L.sy, size = L.px;
    var boxW = L.boxW, boxH = L.boxH;
    ctx.textAlign = 'center';
    ctx.font = (L.bold ? '600 ' : '') + size + 'px ' + fontOf(L);

    if (L.lift) {
      ctx.strokeStyle = Iso.rgba(L.tint || '#6e6250', 0.6);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, sy + boxH / 2);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      ctx.fillStyle = Iso.rgba(L.tint || '#6e6250', 0.85);
      ctx.beginPath();
      ctx.arc(ax, ay, 2.4, 0, 6.2832);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(96,84,66,0.26)';
    roundRect(ax - boxW / 2 + 1, sy - boxH / 2 + 2.5, boxW, boxH, 5);
    ctx.fill();

    ctx.fillStyle = L.tint ? Iso.mix('#fffdf7', L.tint, 0.14) : '#fffdf7';
    roundRect(ax - boxW / 2, sy - boxH / 2, boxW, boxH, 5);
    ctx.fill();
    ctx.strokeStyle = Iso.rgba(L.tint || '#6e6250', 0.85);
    ctx.lineWidth = L.bold ? 1.7 : 1.2;
    roundRect(ax - boxW / 2, sy - boxH / 2, boxW, boxH, 5);
    ctx.stroke();

    ctx.fillStyle = L.color || '#3a352e';
    ctx.fillText(L.text, ax, sy + (L.sub ? -size * 0.42 : 0));
    if (L.sub) {
      ctx.font = (size * 0.85) + 'px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = 'rgba(88,80,68,0.75)';
      ctx.fillText(L.sub, ax, sy + size * 0.62);
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------- draw  */

  function key(o) { return o.x + o.y + ((o.w || 0) + (o.d || 0)) * 0.5; }

  /* What each district's plate says once the van has been through it. */
  function districtSub(d, isActive) {
    var s = Sim.state, tr = trip();
    if (!tr) return isActive ? d.tag : null;
    switch (d.id) {
      case 'weigh':
        if (s.known && s.known.tokens) return RM.fmtTok(tr.tokens.total) + ' prompt tokens';
        break;
      case 'naming':
        if (s.known && s.known.resolved && tr.plan.primary) return tr.plan.primary.model.id;
        if (tr.plan.error && s.charged && s.charged.naming != null) return tr.plan.error;
        break;
      case 'inspect':
        var c = candidateCounts();
        if (s.known && s.known.inspected) return c[0] + ' ok · ' + c[1] + ' unknown · ' + c[2] + ' no';
        break;
      case 'tower':
        if (s.known && s.known.planned && tr.plan.candidates) {
          return '1 + ' + (tr.plan.candidates.length - 1) + ' fallback' +
            (tr.plan.candidates.length === 2 ? '' : 's');
        }
        break;
      case 'upstream':
        var a = Sim.currentAttempt();
        if (a && s.charged && s.charged.upstream != null) return a.candidate.provider + ' → ' + a.status;
        break;
      case 'guards':
        if (s.known && s.known.scanned && tr.stream) {
          return tr.stream.abort ? 'aborted' : tr.stream.delivered + ' deltas clean';
        }
        break;
      case 'deliver':
        if (s.outcome) return s.outcome.status + ' ' + s.outcome.label;
        break;
    }
    if (s.charged && s.charged[d.id] != null) return '+' + RM.fmtMs(s.charged[d.id]);
    return isActive ? d.tag : null;
  }

  function draw(canvas, camera, time, activeDistrict, hoverDistrict) {
    ctx = canvas.getContext('2d');
    cam = camera;
    t = time;
    labels.length = 0;

    var w = canvas.width / cam.dpr, h = canvas.height / cam.dpr;
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    drawSky(w, h);

    ctx.setTransform(cam.scale * cam.dpr, 0, 0, cam.scale * cam.dpr,
                     cam.ox * cam.dpr, cam.oy * cam.dpr);

    drawGround();
    drawZones(activeDistrict);
    drawRoads();

    /* ---- one sorted pass over everything with a footprint ---- */
    var items = [];
    var i, s = Sim.state;

    for (i = 0; i < World.buildings.length; i++) {
      var b = World.buildings[i];
      if (b.kind && KIND[b.kind]) items.push({ k: b.x + b.y, f: KIND[b.kind], a: b });
      else items.push({ k: key(b), f: null, a: b });
    }
    for (i = 0; i < World.props.length; i++) {
      var pr = World.props[i];
      items.push({ k: pr.x + pr.y, f: pr.kind === 'tree' ? drawTree : drawLamp, a: pr });
    }
    var v = Sim.vanPosition();
    items.push({ k: v.x + v.y + 0.2, f: drawVan, a: v });

    items.sort(function (p, q) { return p.k - q.k; });
    for (i = 0; i < items.length; i++) {
      if (items[i].f) { items[i].f(items[i].a); continue; }
      var o = items[i].a;
      Iso.box(ctx, o);
      if (o.roof) {
        Iso.gableRoof(ctx, {
          x: o.x - 0.08, y: o.y - 0.08, z: o.z + o.h,
          w: o.w + 0.16, d: o.d + 0.16, h: o.roofH || 0.45, color: o.roof
        });
      } else if (o.rooftop) {
        drawRooftop(o);
      }
    }

    /* ---- district plates ---- */
    if (showLabels) {
      var declutter = cam.scale < 0.34;
      for (i = 0; i < World.districts.length; i++) {
        var d = World.districts[i];
        var isActive = d.id === activeDistrict || d.id === hoverDistrict;
        if (declutter && !isActive) continue;
        labels.push({
          x: d.x, y: d.y, z: 0, lift: isActive ? 34 : 26,
          text: d.name, sub: districtSub(d, isActive),
          color: isActive ? d.color : '#3d3831',
          tint: d.color,
          size: isActive ? 16.5 : 14, bold: isActive,
          pri: isActive ? 2 : 1
        });
      }
      /* the provider compounds, named so the gate means something. Hidden at
         the zoom where the whole town fits, or four plates pile up on four
         halls that are six pixels apart. */
      if (!declutter) {
        for (i = 0; i < World.providerHalls.length; i++) {
          var hh = World.providerHalls[i];
          labels.push({
            x: hh.x, y: hh.y, z: 0, lift: 40, text: hh.label,
            color: '#4a4540', tint: hh.color, size: 12.5, pri: 0
          });
        }
      }
    }

    /* The van's own plate: the one thing on screen that changes every frame,
       so it has the highest priority and the static plates give way to it. */
    if (s.running) {
      var tr = trip();
      var cand = Sim.currentCandidate();
      var sub;
      if (s.known && s.known.answered && tr && tr.outputTokens) {
        sub = RM.fmtTok(tr.outputTokens) + ' out';
      } else if (s.known && s.known.tokens && tr) {
        sub = RM.fmtTok(tr.tokens.total) + ' in';
      } else {
        sub = 'alias: ' + s.askedModel;
      }
      labels.push({
        x: v.x, y: v.y, z: (v.z || 0) + 2.4, lift: 8,
        text: cand && s.known && s.known.resolved ? cand.model.id : RM.fmtMs(s.spentMs),
        sub: sub,
        color: '#3d3831', tint: '#8a8272', size: 13.5, bold: true, mono: true,
        pri: 3
      });
    }

    drawLabels();
  }

  global.Renderer = {
    draw: draw,
    setLabels: function (v) { showLabels = v; }
  };
})(window);
