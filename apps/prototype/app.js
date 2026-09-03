/* GDPRcompliant.eu — prototype (X-01..X-09)
   Non-functional. No network, no storage, no model calls. Every screen reads
   window.PROTO_DATA, which is fixtures/companies/eksempelbutik.json.
   Vanilla on purpose: the design system and copy port to the real app at F-01;
   the framework glue does not, so there is no point importing one here. */

(function () {
  'use strict';
  var D = window.PROTO_DATA;
  var app = document.getElementById('app');

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var SCREENS = [
    { id: 'front',      label: 'Front door',   note: 'The whole entry surface.' },
    { id: 'scanning',   label: 'Scanning',     note: 'The three passes, running.' },
    { id: 'case',       label: 'Case',         note: 'Switch between the three ages of a case, above right.' },
    { id: 'finding',    label: 'Finding',      note: 'Evidence, and the remedy.' },
    { id: 'questions',  label: 'Questions',    note: 'One question at a time.' },
    { id: 'colleagues', label: 'Colleagues',   note: 'Four role lists, and the invitation.' },
    { id: 'supply',     label: 'Supply chain', note: 'Three levels deep.' },
    { id: 'artefact',   label: 'Artefact',     note: 'A generated processing agreement, and the sign-off.' },
    { id: 'trust',      label: 'Trust page',   note: 'Public, opt-in, dated.' },
    { id: 'report',     label: 'Report',       note: 'The PDF, at any point. Status matrix, actions, law in full.' },
    { id: 'advisor',    label: 'Advisor',      note: 'Knows the law and this case, and can compare them.' },
    { id: 'internal',   label: 'Internal',     note: 'What we see.' }
  ];

  var state = { screen: 'front', caseAge: 'working', finding: 'CNS-02', qIndex: 0, scanStep: 0, scanOutcome: 'clean' };
  var timer = null;

  /* ── derived data ────────────────────────────────────────────────── */

  function isClosed(f) {
    if (!f.closesIn) return false;
    if (state.caseAge === 'fresh') return false;
    if (state.caseAge === 'working') return f.closesIn === 'working';
    return true; // watched
  }
  function findings() {
    var list = D.findings.slice();
    if (state.caseAge === 'watched') list.push(D.newInWatch);
    return list;
  }
  function openFindings() { return findings().filter(function (f) { return !isClosed(f); }); }
  function timeline() {
    var order = { fresh: 0, working: 1, watched: 2 };
    return D.timeline.filter(function (e) { return order[e.state] <= order[state.caseAge]; });
  }
  function countBy(sev) { return openFindings().filter(function (f) { return f.severity === sev; }).length; }
  function findingById(id) {
    var all = D.findings.concat([D.newInWatch]);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return D.findings[0];
  }

  /* ── small pieces ────────────────────────────────────────────────── */

  function sevBadge(f) {
    if (isClosed(f)) return '<span class="sev sev-closed">Closed</span>';
    return '<span class="sev sev-' + f.severity + '">' + esc(f.severity) + '</span>';
  }
  function remedyTag(r) {
    var label = { self_fix: 'free fix', generated_artefact: 'one click', our_product: 'our product', partner_alternative: 'alternatives', no_solution: 'no answer yet' }[r.kind];
    return '<span class="tag t-' + r.kind + '">' + esc(label) + '</span>';
  }

  /* ── screens ─────────────────────────────────────────────────────── */

  var render = {};

  render.front = function () {
    return '<div class="screen"><div class="fd">' +
      '<div>' +
        '<p class="eyebrow">Free · no account · about 40 seconds</p>' +
        '<h1>Is your website GDPR compliant?</h1>' +
        '<p class="sub">Every problem comes with the fix.</p>' +
      '</div>' +
      '<form onsubmit="return PROTO.go(\'scanning\')">' +
        '<input type="text" value="eksempelbutik.dk" aria-label="Your website address" spellcheck="false">' +
        '<button class="btn" type="submit">Run the free test</button>' +
      '</form>' +
      '</div></div>';
  };

  var SCAN_STEPS = [
    ['Opening the page with a clean browser', 'pass A'],
    ['Recording what loads before you agree', 'pass A'],
    ['Finding the consent banner', 'pass B'],
    ['Clicking through to a real refusal', 'pass B'],
    ['Recording what still loads after refusing', 'pass B'],
    ['Accepting everything, for comparison', 'pass C'],
    ['Reading your privacy policy', 'notice'],
    ['Identifying who receives the data', 'recipients'],
    ['Checking the security a visitor can see', 'security'],
    ['Writing up what we found', '']
  ];

  render.scanning = function () {
    var out = state.scanOutcome === 'clean' ? null : D.scanOutcomes[state.scanOutcome];
    var ov = (out && out.overrides) || {};
    var firstOv = Object.keys(ov).map(Number).sort(function (a, b) { return a - b; })[0];
    var pct = Math.round((state.scanStep / SCAN_STEPS.length) * 100);

    var rows = SCAN_STEPS.map(function (s, i) {
      var reached = i < state.scanStep;
      var cls;
      if (ov[i] && reached) cls = ov[i];
      else if (out && out.skipRest && reached && i > firstOv) cls = 'skip';
      else cls = reached ? 'ok' : i === state.scanStep ? 'on' : 'todo';
      var mark = { undet: 'could not tell', skip: 'skipped', na: 'not needed', fail: 'no response' }[cls] || s[1];
      return '<div class="scan-step ' + cls + '"><span class="dot"></span><span class="t">' + esc(s[0]) + '</span><span class="n">' + esc(mark) + '</span></div>';
    }).join('');

    var done = state.scanStep >= SCAN_STEPS.length;
    var tail;
    if (!done) {
      tail = '<p class="muted" style="margin-top:22px;font-size:13.5px">This normally takes about 40 seconds.</p>';
    } else if (out) {
      tail = '<div class="scan-out' + (out.clean ? ' good' : '') + '">' +
        '<h3>' + esc(out.headline) + '</h3>' +
        '<p>' + esc(out.body) + '</p>' +
        (out.consequence ? '<p class="cons">' + esc(out.consequence) + '</p>' : '') +
        '<button class="btn" onclick="PROTO.go(\'' + (state.scanOutcome === 'unreachable' ? 'front' : 'case') + '\')">' + esc(out.cta) + '</button>' +
      '</div>';
    } else {
      tail = '<div style="margin-top:26px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn" onclick="PROTO.go(\'case\')">See what to do about it</button>' +
        '<span class="muted" style="font-size:13.5px">12 things to fix · grouped into 7 steps</span></div>';
    }

    return '<div class="screen"><div class="scan">' +
      '<p class="eyebrow">Checking</p>' +
      '<h2>' + esc(D.company.domain) + '</h2>' +
      '<div class="scan-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="scan-steps">' + rows + '</div>' + tail +
      '</div></div>';
  };

  // The case page is a plan, not a triage board. One expanded step at a time,
  // everything finished collapsed above it, everything ahead previewed below.
  function planSteps() {
    var list = D.steps.map(function (s) {
      var done = state.caseAge === 'fresh' ? false
        : state.caseAge === 'working' ? s.doneIn === 'working'
        : true;
      return { s: s, done: done };
    });
    if (state.caseAge === 'watched') list.push({ s: D.watchStep, done: false });
    return list;
  }

  function stepMinutes(s) { return s.minutesLabel || ('about ' + s.minutes + ' minutes'); }

  function stepFindingRows(s) {
    if (!s.findings.length) return '';
    return '<div class="step-items">' + s.findings.map(function (id) {
      var f = findingById(id);
      return '<button class="step-item" onclick="PROTO.openFinding(\'' + f.id + '\')">' +
        '<span class="si-t">' + esc(f.title) + '</span>' +
        '<span class="si-r">' + esc(f.remedy.title) + '</span>' +
        '<span class="go">›</span></button>';
    }).join('') + '</div>';
  }

  render.case = function () {
    var plan = planSteps();
    var doneN = plan.filter(function (p) { return p.done; }).length;
    var current = plan.filter(function (p) { return !p.done; })[0];
    var left = plan.filter(function (p) { return !p.done; })
                   .reduce(function (a, p) { return a + (p.s.minutes || 0); }, 0);
    var pct = Math.round((doneN / plan.length) * 100);

    var lead, sub;
    if (state.caseAge === 'fresh') {
      lead = 'We found 12 things to fix. Here they are as ' + plan.length + ' steps.';
      sub = '';
    } else if (state.caseAge === 'working') {
      lead = 'Four steps down, three to go.';
      sub = 'What is left needs answers from you, and one decision.';
    } else {
      lead = 'You finished all seven — then something changed.';
      sub = 'We check every week.';
    }

    var body = plan.map(function (p) {
      var s = p.s;
      if (p.done) {
        return '<div class="step done">' +
          '<span class="step-n">✓</span>' +
          '<div class="step-body"><h3>' + esc(s.title) + '</h3>' +
          '<span class="step-meta">Done ' + esc(s.doneOn || '') + '</span></div></div>';
      }
      if (current && current.s === s) {
        return '<div class="step now">' +
          '<span class="step-n">' + s.n + '</span>' +
          '<div class="step-body">' +
            '<p class="step-kick">Your next step</p>' +
            '<h3>' + esc(s.title) + '</h3>' +
            '<p class="step-plain">' + esc(s.plain) + '</p>' +
            stepFindingRows(s) +
            '<div class="step-act">' +
              '<button class="btn" onclick="PROTO.startStep(' + s.n + ')">' + esc(s.action) + '</button>' +
              '<span class="step-meta">' + esc(stepMinutes(s)) + ' · ' + esc(s.who) + '</span>' +
            '</div>' +
            (s.invite ? '<p class="step-hand">' + esc(s.invite) + ' — <button class="lnk" onclick="PROTO.go(\'colleagues\')">pass this on</button></p>' : '') +
          '</div></div>';
      }
      return '<div class="step next">' +
        '<span class="step-n">' + s.n + '</span>' +
        '<div class="step-body"><h3>' + esc(s.title) + '</h3>' +
        '<span class="step-meta">' + esc(stepMinutes(s)) + '</span></div></div>';
    }).join('');

    var tl = timeline().slice().reverse().map(function (e) {
      return '<li><time>' + esc(e.at) + '</time><span>' +
        '<b class="' + (e.alert ? 'alert' : e.closed ? 'ok-t' : '') + '">' + esc(e.text) + '</b>' +
        '<span class="d">' + esc(e.detail) + '</span></span></li>';
    }).join('');

    return '<div class="screen narrow">' +
      '<div class="plan-top">' +
        '<span class="caseid">' + esc(D.case.id) + '</span>' +
        '<span class="plan-dom">' + esc(D.company.domain) + '</span>' +
        '<span class="plan-saved">Saved automatically · come back any time</span>' +
      '</div>' +

      '<h2 class="plan-lead">' + esc(lead) + '</h2>' +
      (sub ? '<p class="plan-sub">' + esc(sub) + '</p>' : '') +

      '<div class="plan-prog">' +
        '<div class="pp-bar"><i style="width:' + pct + '%"></i></div>' +
        '<span class="pp-txt">' + doneN + ' of ' + plan.length + ' done' +
        (left ? ' · about ' + left + ' minutes left' : '') + '</span>' +
      '</div>' +

      '<div class="steps">' + body + '</div>' +

      '<div class="plan-foot">' +
        '<details class="drawer"><summary>Two things we could not work out on our own</summary><div class="body">' +
          D.undetermined.concat([{
            id: 'VND-11', title: findingById('VND-11').title,
            reason: findingById('VND-11').remedy.detail, resolve: 'Nobody has a good answer to this yet'
          }]).map(function (u) {
            return '<div class="und"><b>' + esc(u.title) + '</b><p>' + esc(u.reason) + '</p>' +
              '<span class="mono">' + esc(u.resolve) + '</span></div>';
          }).join('') +
        '</div></details>' +
        '<details class="drawer"><summary>Everything that has happened (' + timeline().length + ')</summary><div class="body">' +
          '<ul class="tl">' + tl + '</ul>' +
        '</div></details>' +
        '<p class="plan-own">Owned by ' + esc(D.company.legalName) + ' · ' + esc(D.case.participants) +
          ' people have access · <button class="lnk" onclick="PROTO.noop(this)">export everything</button> · ' +
          '<button class="lnk" onclick="PROTO.noop(this)">delete the case and its evidence</button></p>' +
      '</div></div>';
  };

  render.finding = function () {
    var f = findingById(state.finding);
    var r = f.remedy;
    var closed = isClosed(f);

    var ev = '';
    if (f.evidence.kind === 'diff') {
      ev = '<table class="ev-tbl"><thead><tr><th>Host</th><th>Reject all</th><th>Accept all</th><th>Verdict</th></tr></thead><tbody>' +
        f.evidence.rows.map(function (row) {
          return '<tr><td>' + esc(row[0]) + '</td><td>' + esc(row[1]) + '</td><td>' + esc(row[2]) + '</td>' +
            '<td class="' + (row[3] === 'identical' ? 'same' : '') + '">' + esc(row[3]) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } else {
      ev = '<pre class="pre">' + f.evidence.lines.map(esc).join('\n') + '</pre>';
    }

    var acts = '';
    if (closed) {
      acts = '<span class="verified">✓ Closed and verified by re-scan</span>';
    } else if (r.kind === 'no_solution') {
      acts = '<button class="btn btn-2" onclick="PROTO.noop(this)">' + esc(r.askLabel) + '</button>' +
             '<span class="muted" style="font-size:13px">Logged to the demand ledger · seen 1,847 times</span>';
    } else {
      acts = '<button class="btn" onclick="PROTO.noop(this)">' + esc(r.cta || 'Show me how') + '</button>' +
             (r.verifyLabel ? '<button class="btn btn-2" onclick="PROTO.verify(this)">' + esc(r.verifyLabel) + '</button>' : '');
    }

    return '<div class="screen narrow">' +
      '<button class="btn btn-2 btn-sm" onclick="PROTO.go(\'case\')" style="margin-bottom:22px">‹ Back to case ' + esc(D.case.id) + '</button>' +
      '<div class="fd-head"><span class="fid mono muted">' + esc(f.id) + '</span>' + sevBadge(f) + '<span class="muted" style="font-size:13px">' + esc(f.area) + '</span></div>' +
      '<h2 class="fd-title h-serif">' + esc(f.title) + '</h2>' +
      '<p class="why">' + esc(f.why) + '</p>' +
      (f.citations.length
        ? '<div class="cites">' + f.citations.map(function (c) {
            return '<span class="cite">' + esc(c.instrument) + ' ' + esc(c.ref) + ' <em>· ' + esc(c.note) + '</em></span>';
          }).join('') + '</div>'
        : '<div class="cites"><span class="cite" style="color:var(--ink-3);background:transparent;border-style:dashed">No legal claim — an observation</span></div>') +
      '<details class="drawer card" open><summary>The evidence behind this</summary><div class="body">' +
        '<p class="ev-cap">' + esc(f.evidence.caption) + '</p>' + ev +
      '</div></details>' +
      '<div class="rem-card k-' + r.kind + '">' +
        '<div class="rem-h"><h3>' + esc(r.title) + '</h3>' + remedyTag(r) + '<span class="muted mono" style="font-size:11.5px;margin-left:auto">' + esc(r.effort) + '</span></div>' +
        '<p>' + esc(r.detail) + '</p>' +
        (r.options ? '<ul class="rem-opts">' + r.options.map(function (o) { return '<li>' + esc(o) + '</li>'; }).join('') + '</ul>' : '') +
        (r.snippet ? '<pre class="pre">' + esc(r.snippet) + '</pre>' : '') +
        (r.alternativeNote ? '<p class="muted" style="font-size:13.5px">' + esc(r.alternativeNote) + '</p>' : '') +
        '<div class="rem-acts">' + acts + '</div>' +
      '</div></div>';
  };

  render.questions = function () {
    var qs = D.questions;
    if (state.qIndex >= qs.length) {
      return '<div class="screen"><div class="q-wrap q-done">' +
        '<div class="big">That is everything we need for now.</div>' +
        '<p class="muted">Nine new checks opened and eleven rows of your processing register filled.</p>' +
        '<div style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
        '<button class="btn" onclick="PROTO.go(\'case\')">Back to the case</button>' +
        '<button class="btn btn-2" onclick="PROTO.resetQ()">Run through again</button></div>' +
      '</div></div>';
    }
    var q = qs[state.qIndex];
    var prog = qs.map(function (_, i) { return '<i class="' + (i <= state.qIndex ? 'on' : '') + '"></i>'; }).join('');
    var opts = q.options.map(function (o) {
      var isCheck = /check it for me|not sure|don't know/i.test(o);
      return '<button class="q-opt' + (isCheck ? ' check' : '') + '" onclick="PROTO.answer()">' + esc(o) +
        (isCheck ? '<span class="k">we go and look</span>' : '') + '</button>';
    }).join('');
    return '<div class="screen"><div class="q-wrap">' +
      '<div class="q-prog">' + prog + '</div>' +
      '<p class="eyebrow">Question ' + (state.qIndex + 1) + ' of ' + qs.length + '</p>' +
      (q.context ? '<p class="q-context">' + esc(q.context) + '</p>' : '') +
      '<h2 class="q-text">' + esc(q.text) + '</h2>' +
      '<p class="q-why">' + esc(q.why) + '</p>' +
      '<p class="q-unlock">Answering this unlocks ' + esc(q.unlocks) + '</p>' +
      '<div class="q-opts">' + opts + '</div>' +
    '</div></div>';
  };

  render.colleagues = function () {
    var roles = D.roles.map(function (r) {
      var items = r.items.map(function (it) {
        return '<li class="' + (it.done ? 'done' : '') + '"><span class="bx">✓</span><span>' + esc(it.text) + '</span></li>';
      }).join('');
      return '<div class="role">' +
        '<div class="who">' + esc(r.who) + '</div>' +
        '<h4>' + esc(r.person) + '</h4>' +
        '<ul class="items">' + items + '</ul>' +
        '<div class="foot">' + r.items.length + ' items · ' + esc(r.eta) + ' · ' + r.done + ' done · ' + r.auto + ' we can do for you</div>' +
      '</div>';
    }).join('');

    return '<div class="screen">' +
      '<p class="eyebrow">Share inward</p>' +
      '<h2 class="h-serif" style="font-size:clamp(24px,3.6vw,34px);margin-bottom:10px">Four people, twenty minutes each</h2>' +
      '<div class="roles" style="margin-top:24px">' + roles + '</div>' +
      '<div class="invite">' +
        '<div class="mailmock">' +
          '<div class="hdr"><span>From: <b>Mette Sørensen</b> &lt;mette@eksempelbutik.dk&gt;</span><span>To: hr@eksempelbutik.dk</span><span>Subject: 4 things for HR — 20 minutes</span></div>' +
          '<p style="margin:0 0 10px">Hi — we\'re fixing our GDPR situation and there are four things only you can answer. Two of them are already drafted, you just approve.</p>' +
          '<p style="margin:0 0 14px"><a href="#" onclick="return false" style="color:var(--eu)">Open my four items →</a></p>' +
          '<p class="muted" style="margin:0;font-size:13px">No account needed. You\'ll see only your part.</p>' +
        '</div>' +
        '<div>' +
          '<h4 style="font-size:16px;margin-bottom:12px">Still waiting on</h4>' +
          '<ul class="waiting">' +
            '<li><span class="w-who">HR</span><span class="w-st">Not invited</span>' +
              '<button class="btn btn-2 btn-sm" onclick="PROTO.noop(this)">Invite</button></li>' +
            '<li><span class="w-who">Lars · IT</span><span class="w-st">2 of 4 · last opened 3 days ago</span>' +
              '<button class="btn btn-2 btn-sm" onclick="PROTO.noop(this)">Remind</button></li>' +
            '<li><span class="w-who">Sofie · Finance</span><span class="w-st">2 of 4 · last opened yesterday</span>' +
              '<button class="btn btn-2 btn-sm" onclick="PROTO.noop(this)">Remind</button></li>' +
          '</ul>' +
        '</div>' +
      '</div></div>';
  };

  render.supply = function () {
    var sc = D.supplyChain;
    var levels = [0, 1, 2, 3].map(function (lv) {
      var nodes = sc.nodes.filter(function (n) { return n.level === lv; }).map(function (n) {
        var outside = n.juris && ['US', 'CA'].indexOf(n.juris) >= 0;
        var flag = n.parent ? n.juris + ' · parent ' + n.parent : n.juris;
        return '<div class="node' + (lv === 0 ? ' you' : '') + (outside || n.parent ? ' out' : '') + '">' +
          '<span>' + esc(n.label) + '</span><span class="j">' + esc(flag) + '</span></div>';
      }).join('');
      return '<div class="sc-lvl"><div class="lb">' + esc(sc.levels[lv]) + '</div><div class="sc-nodes">' + nodes + '</div></div>';
    }).join('');

    return '<div class="screen">' +
      '<p class="eyebrow">Mapped from published documents · 3 September</p>' +
      '<h2 class="h-serif" style="font-size:clamp(24px,3.6vw,34px);margin-bottom:10px">Who else touches your customers\' data</h2>' +
      '<p class="muted" style="max-width:64ch;font-size:15.5px">Read from your vendors\' own processing agreements and sub-processor lists, and then from theirs.</p>' +
      '<div class="card pad sc" style="margin-top:22px">' + levels + '</div>' +
      '<div style="margin-top:18px;display:flex;gap:22px;flex-wrap:wrap;font-size:13.5px" class="muted">' +
        '<span><b style="color:var(--ink)">21</b> sub-processors</span>' +
        '<span><b style="color:var(--ink)">9</b> established outside the EEA</span>' +
        '<span><b style="color:var(--ink)">3</b> levels deep</span>' +
      '</div>' +
      '<div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn" onclick="PROTO.go(\'artefact\')">Publish this as your sub-processor list</button>' +
        '<button class="btn btn-2" onclick="PROTO.noop(this)">Export as PDF</button>' +
      '</div></div>';
  };

  render.artefact = function () {
    var a = D.artefact;
    return '<div class="screen narrow">' +
      '<p class="eyebrow">Generated artefact · preview before anything is published</p>' +
      '<h2 class="h-serif" style="font-size:clamp(24px,3.6vw,32px);margin-bottom:8px">This describes what you actually do</h2>' +
      '<div class="doc">' +
        '<div class="doc-h"><h3>' + esc(a.title) + '</h3><div class="sub">' + esc(a.subtitle) + '</div>' +
          '<div class="from">Generated from ' + esc(a.generatedFrom) + '</div></div>' +
        a.sections.map(function (s) {
          return '<div class="doc-s"><h4>' + esc(s.h) + '</h4><p>' + esc(s.body) + '</p><div class="tr">traces to: ' + esc(s.traces) + '</div></div>';
        }).join('') +
        a.gaps.map(function (g) { return '<div class="doc-gap">⚠ ' + esc(g) + '</div>'; }).join('') +
        '<div class="doc-sign">' +
          '<button class="btn" onclick="PROTO.noop(this)">Sign as ' + esc(a.signoff.who) + '</button>' +
          '<span class="note">' + esc(a.signoff.note) + '</span>' +
        '</div>' +
      '</div></div>';
  };

  render.trust = function () {
    var t = D.trust;
    return '<div class="screen"><div class="trust">' +
      '<p class="eyebrow" style="text-align:center;margin-bottom:14px">eksempelbutik.dk/privatliv</p>' +
      '<div class="trust-card">' +
        '<div class="trust-h"><h2>' + esc(t.headline) + '</h2>' +
          '<div class="meta"><span>Last checked ' + esc(t.updated) + '</span><span>Case ' + esc(t.caseRef) + '</span><span>Checked by GDPRcompliant.eu</span></div></div>' +
        '<div class="trust-st">' + esc(t.statement) + '</div>' +
        '<ul class="trust-list">' + t.closed.map(function (c) {
          return '<li><span class="tick">✓</span><span>' + esc(c.text) + '</span><time>' + esc(c.on) + '</time></li>';
        }).join('') + '</ul>' +
        '<div class="trust-f">' +
          '<span class="open">' + esc(t.openNote) + '</span>' +
          '<button class="btn" onclick="PROTO.go(\'front\')">' + esc(t.cta) + '</button>' +
        '</div>' +
      '</div>' +
      '<p class="muted" style="font-size:13px;margin-top:16px;text-align:center">' +
        '<button class="lnk" onclick="PROTO.noop(this)">Unpublish this page</button></p>' +
    '</div></div>';
  };

  render.internal = function () {
    var b = D.internal.brief;
    var sig = b.signals.map(function (s) {
      return '<tr><td>' + esc(s[0]) + '</td><td>' + esc(s[1]) + '</td></tr>';
    }).join('');
    var rows = D.internal.queue.map(function (q) {
      return '<tr>' +
        '<td class="cs">' + esc(q.case) + '</td>' +
        '<td class="co">' + esc(q.company) + '<div class="muted" style="font-weight:400;font-size:12.5px">' + esc(q.why) + '</div></td>' +
        '<td><span class="lane lane-' + esc(q.lane.replace(' ', '-')) + '">' + esc(q.lane) + '</span></td>' +
        '<td class="sc-n">' + q.score + '</td>' +
        '<td class="sc-n">' + q.open + '</td>' +
        '<td>' + esc(q.hook) + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="screen">' +
      '<p class="eyebrow">Internal · consultant view of the customer\'s own case</p>' +
      '<h2 class="h-serif" style="font-size:clamp(24px,3.6vw,32px);margin-bottom:16px">Already briefed, before hello</h2>' +
      '<div class="brief">' +
        '<div class="card pad">' +
          '<div class="sec-t"><h3 style="font-size:18px">' + esc(b.headline) + '</h3>' +
            '<span class="lane lane-Self-serve" style="margin-left:auto">' + esc(b.lane) + ' · ' + b.score + '</span></div>' +
          '<table class="sig"><tbody>' + sig + '</tbody></table>' +
        '</div>' +
        '<div class="card pad">' +
          '<h3 style="font-family:var(--serif);font-weight:500;font-size:18px;margin-bottom:10px">The read</h3>' +
          '<p style="font-size:14.5px;color:var(--ink-2)">' + esc(b.read) + '</p>' +
          '<div class="dont" style="margin-top:14px">' + esc(b.visible) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sec-t"><h3>Commercial queue</h3><span class="n">ranked by signal × severity × how much we can solve</span></div>' +
      '<div class="card scroll-x"><table class="qtbl"><thead><tr>' +
        '<th>Case</th><th>Company</th><th>Lane</th><th>Signal</th><th>Open</th><th>What to open the call with</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="muted" style="font-size:13.5px;margin-top:16px;max-width:66ch">Lane decides whether a person reaches out. It never changes what the customer receives.</p>' +
    '</div></div>';
  };

  render.report = function () {
    var r = D.report;
    var stateLabel = { done: 'In order', open: 'Open', undetermined: 'Not determined', na: 'Not applicable' };

    var matrix = r.matrix.map(function (m) {
      return '<tr><td class="m-area">' + esc(m.area) + '</td>' +
        '<td><span class="m-state m-' + m.state + '">' + esc(stateLabel[m.state]) + '</span></td>' +
        '<td class="m-note">' + esc(m.note) + '</td></tr>';
    }).join('');

    var actions = r.actions.map(function (a) {
      return '<tr><td class="a-n">' + a.n + '</td><td class="a-w">' + esc(a.what) +
        '<span class="a-ref">' + esc(a.ref) + '</span></td>' +
        '<td>' + esc(a.who) + '</td><td class="a-when">' + esc(a.when) + '</td></tr>';
    }).join('');

    var articles = r.articlesUsed.map(function (k) {
      var a = D.articles[k];
      return '<div class="law"><div class="law-ref">' + esc(a.ref) + '</div>' +
        '<blockquote>' + esc(a.text) + '</blockquote></div>';
    }).join('');

    return '<div class="screen narrow">' +
      '<div class="rep-bar">' +
        '<span class="muted">Generated ' + esc(r.generated) + '</span>' +
        '<button class="btn" onclick="PROTO.noop(this)">Download PDF</button>' +
        '<button class="btn btn-2" onclick="PROTO.noop(this)">Email to a colleague</button>' +
      '</div>' +

      '<div class="paper">' +
        '<div class="paper-head">' +
          '<div>' +
            '<p class="eyebrow">' + esc(r.caseRef) + '</p>' +
            '<h2>' + esc(r.title) + '</h2>' +
            '<p class="p-sub">' + esc(r.subject) + '</p>' +
          '</div>' +
          '<div class="p-meta"><span>' + esc(r.generated) + '</span><span>' + esc(r.standing) + '</span></div>' +
        '</div>' +

        '<div class="paper-s">' +
          '<h3>Where things stand</h3>' +
          '<p class="p-lead">' + esc(r.summary) + '</p>' +
          '<table class="matrix"><thead><tr><th>Area</th><th>Status</th><th>Latest</th></tr></thead>' +
            '<tbody>' + matrix + '</tbody></table>' +
        '</div>' +

        '<div class="paper-s">' +
          '<h3>What needs doing</h3>' +
          '<table class="acts"><thead><tr><th></th><th>Action</th><th>Who</th><th>Effort</th></tr></thead>' +
            '<tbody>' + actions + '</tbody></table>' +
        '</div>' +

        '<div class="paper-s">' +
          '<h3>The law this report refers to</h3>' +
          '<p class="p-lead">Quoted in full, as written.</p>' +
          articles +
        '</div>' +

        '<div class="paper-foot">' +
          '<p class="disc">' + esc(r.disclaimer) + '</p>' +
          '<p class="src">' + esc(r.footer) + ' · gdprcompliant.eu</p>' +
        '</div>' +
      '</div></div>';
  };

  render.advisor = function () {
    var a = D.advisor;

    var thread = a.thread.map(function (m) {
      if (m.role === 'user') return '<div class="msg-u"><div class="bub">' + esc(m.text) + '</div></div>';

      var law = D.articles[m.law];
      return '<div class="msg-a">' +
        '<p class="ans">' + esc(m.answer) + '</p>' +

        '<div class="ground">' +
          '<div class="g-h">' + esc(m.grounded.title) + '</div>' +
          '<table class="g-t"><tbody>' + m.grounded.rows.map(function (row) {
            return '<tr><td>' + esc(row[0]) + '</td><td>' + esc(row[1]) + '</td></tr>';
          }).join('') + '</tbody></table>' +
          '<p class="g-n">' + esc(m.grounded.note) + '</p>' +
        '</div>' +

        '<div class="law">' +
          '<div class="law-ref">' + esc(law.ref) + '</div>' +
          '<blockquote>' + esc(law.text) + '</blockquote>' +
          '<p class="law-n">' + esc(m.lawNote) + '</p>' +
        '</div>' +

        '<div class="msg-acts">' + m.actions.map(function (x) {
          return '<button class="btn btn-2 btn-sm" onclick="PROTO.noop(this)">' + esc(x) + '</button>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');

    return '<div class="screen narrow">' +
      '<div class="adv-head">' +
        '<h2 class="h-serif" style="font-size:clamp(22px,3.4vw,30px)">Ask about your own situation</h2>' +
        '<p class="adv-g">' + esc(a.grounding) + '</p>' +
      '</div>' +
      '<div class="thread">' + thread + '</div>' +
      '<div class="ask">' +
        '<input type="text" placeholder="Ask anything about your case or the law" aria-label="Ask a question">' +
        '<button class="btn" onclick="PROTO.noop(this)">Ask</button>' +
      '</div>' +
      '<div class="sugg">' + a.suggestions.map(function (s) {
        return '<button class="s-chip" onclick="PROTO.noop(this)">' + esc(s) + '</button>';
      }).join('') + '</div>' +
      '<p class="adv-disc">' + esc(a.disclaimer) + '</p>' +
      '<div style="margin-top:20px"><button class="btn btn-2 btn-sm" onclick="PROTO.go(\'report\')">Turn this into a report</button></div>' +
    '</div>';
  };

  /* ── chrome and routing ──────────────────────────────────────────── */

  function chrome() {
    var nav = SCREENS.map(function (s) {
      return '<button onclick="PROTO.go(\'' + s.id + '\')" aria-current="' + (state.screen === s.id) + '">' + esc(s.label) + '</button>';
    }).join('');
    var meta = SCREENS.filter(function (s) { return s.id === state.screen; })[0];
    var toggle = '';
    if (state.screen === 'case') {
      toggle = '<span class="proto-toggle">Age of case:' +
        ['fresh', 'working', 'watched'].map(function (a) {
          return '<button class="btn btn-2 btn-sm" style="' + (state.caseAge === a ? 'border-color:var(--gold);background:var(--gold-soft)' : '') + '" onclick="PROTO.age(\'' + a + '\')">' +
            (a === 'fresh' ? 'Day one' : a === 'working' ? 'Week one' : 'Under watch') + '</button>';
        }).join('') + '</span>';
    } else if (state.screen === 'scanning') {
      var outs = [['clean', 'Typical site'], ['noBannerNeeded', 'No banner, none needed'], ['noRefusal', 'No way to refuse'], ['unreachable', 'Unreachable']];
      toggle = '<span class="proto-toggle">Outcome:' +
        outs.map(function (o) {
          return '<button class="btn btn-2 btn-sm" style="' + (state.scanOutcome === o[0] ? 'border-color:var(--gold);background:var(--gold-soft)' : '') + '" onclick="PROTO.outcome(\'' + o[0] + '\')">' + esc(o[1]) + '</button>';
        }).join('') + '</span>';
    }
    var ageToggle = toggle;
    return '<div class="proto-bar">' +
        '<span class="proto-badge">Prototype · nothing behind it</span>' +
        '<span class="proto-name"><b>GDPRcompliant.eu</b> · X-01…X-09</span>' +
        '<nav class="proto-nav">' + nav + '</nav>' +
      '</div>' +
      '<div class="proto-note"><b>Showing</b><span>' + esc(meta ? meta.note : '') + '</span>' + ageToggle + '</div>';
  }

  function draw() {
    app.innerHTML = chrome() + (render[state.screen] || render.front)();
    window.scrollTo(0, 0);
    if (state.screen === 'scanning') startScan(); else stopScan();
  }

  function startScan() {
    stopScan();
    if (state.scanStep >= SCAN_STEPS.length) return;
    timer = setInterval(function () {
      state.scanStep++;
      if (state.scanStep >= SCAN_STEPS.length) stopScan();
      if (state.screen === 'scanning') draw();
    }, 700);
  }
  function stopScan() { if (timer) { clearInterval(timer); timer = null; } }

  // Sandboxed embeds can refuse history writes. Deep links are a convenience,
  // not a requirement — never let one break the app.
  function setHash(v) { try { location.hash = v; } catch (e) { /* ignore */ } }

  window.PROTO = {
    go: function (id) {
      if (id === 'scanning') state.scanStep = 0;
      state.screen = id;
      setHash('#/' + id);
      draw();
      return false;
    },
    openFinding: function (id) { state.finding = id; state.screen = 'finding'; setHash('#/finding'); draw(); },
    startStep: function (n) {
      var all = D.steps.concat([D.watchStep]);
      var s = all.filter(function (x) { return x.n === n; })[0];
      if (!s) return;
      if (s.goTo) return this.go(s.goTo);
      if (s.findings.length) return this.openFinding(s.findings[0]);
      this.go('case');
    },
    age: function (a) { state.caseAge = a; draw(); },
    outcome: function (o) { state.scanOutcome = o; state.scanStep = 0; draw(); },
    answer: function () { state.qIndex++; draw(); },
    resetQ: function () { state.qIndex = 0; draw(); },
    tick: function () { if (state.scanStep < SCAN_STEPS.length) state.scanStep++; draw(); },
    verify: function (btn) {
      btn.outerHTML = '<span class="verified">✓ Re-checked — this finding is now closed</span>';
    },
    noop: function (btn) {
      var t = btn.textContent;
      btn.textContent = 'Not wired up — prototype';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = t; btn.disabled = false; }, 1400);
    }
  };

  var fromHash = '';
  try { fromHash = (location.hash || '').replace('#/', ''); } catch (e) { /* ignore */ }
  if (render[fromHash]) state.screen = fromHash;
  draw();
})();
