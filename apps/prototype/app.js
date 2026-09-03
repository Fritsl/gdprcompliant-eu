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
    { id: 'front',      label: 'Front door',   note: 'One field, one button, no account. The whole entry surface.' },
    { id: 'scanning',   label: 'Scanning',     note: 'The three passes, running. Real stage names, not a fake spinner.' },
    { id: 'case',       label: 'Case',         note: 'The centrepiece. Switch between the three ages of a case above.' },
    { id: 'finding',    label: 'Finding',      note: 'Evidence and the remedy. Pick any finding from the case page.' },
    { id: 'questions',  label: 'Questions',    note: 'One at a time. Yes / No / Check it for me — never a form.' },
    { id: 'colleagues', label: 'Colleagues',   note: 'Four role lists and the invitation that comes from a colleague.' },
    { id: 'supply',     label: 'Supply chain', note: 'Mapped from published documents, three levels deep.' },
    { id: 'artefact',   label: 'Artefact',     note: 'A generated processing agreement, with the sign-off step.' },
    { id: 'trust',      label: 'Trust page',   note: 'Public, opt-in. Dated work in progress — never a seal.' },
    { id: 'internal',   label: 'Internal',     note: 'What we see. Nothing here is hidden from the customer.' }
  ];

  var state = { screen: 'front', caseAge: 'working', finding: 'CNS-02', qIndex: 0, scanStep: 0 };
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
  function caseHeader() {
    var open = openFindings().length;
    return '' +
      '<div class="case-head">' +
        '<span class="caseid">' + esc(D.case.id) + '</span>' +
        '<div class="dom"><span>Case subject</span>' + esc(D.company.domain) + '</div>' +
        '<div class="fixes"><b>' + open + '</b><i>' + (open === 1 ? 'fix ready' : 'fixes ready') + '</i></div>' +
        '<div class="counts">' +
          (countBy('blocking') ? '<span class="chip c-blocking">' + countBy('blocking') + ' blocking</span>' : '') +
          (countBy('serious') ? '<span class="chip c-serious">' + countBy('serious') + ' serious</span>' : '') +
          (countBy('advisory') ? '<span class="chip c-advisory">' + countBy('advisory') + ' advisory</span>' : '') +
          '<span class="chip c-ok">' + D.checks.passed + ' passed</span>' +
          '<span class="chip c-eu">' + D.questions.filter(function (q) { return !q.answered; }).length + ' questions for you</span>' +
        '</div>' +
      '</div>';
  }

  /* ── screens ─────────────────────────────────────────────────────── */

  var render = {};

  render.front = function () {
    return '<div class="screen"><div class="fd">' +
      '<div>' +
        '<h1>Does your website actually respect a&nbsp;"no"?</h1>' +
        '<p class="sub">Most don\'t. We check in under a minute, show you the evidence, and give you the fix. Free, no account, nothing to install.</p>' +
      '</div>' +
      '<form onsubmit="return PROTO.go(\'scanning\')">' +
        '<input type="text" value="eksempelbutik.dk" aria-label="Your website address" spellcheck="false">' +
        '<button class="btn" type="submit">Check my site</button>' +
      '</form>' +
      '<p class="fine">We only look at what any visitor\'s browser can see.</p>' +
      '<div class="fd-trust">' +
        '<span>Runs in about 40 seconds</span>' +
        '<span>Hosted in the EU</span>' +
        '<span>Every finding comes with a fix</span>' +
      '</div>' +
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
    var pct = Math.round((state.scanStep / SCAN_STEPS.length) * 100);
    var rows = SCAN_STEPS.map(function (s, i) {
      var cls = i < state.scanStep ? 'ok' : i === state.scanStep ? 'on' : 'todo';
      return '<div class="scan-step ' + cls + '"><span class="dot"></span><span class="t">' + esc(s[0]) + '</span><span class="n">' + esc(s[1]) + '</span></div>';
    }).join('');
    var done = state.scanStep >= SCAN_STEPS.length;
    return '<div class="screen"><div class="scan">' +
      '<p class="eyebrow">Checking</p>' +
      '<h2>' + esc(D.company.domain) + '</h2>' +
      '<p class="muted" style="font-size:14.5px">We load your front page three times — once ignoring the banner, once refusing everything, once accepting — and compare what happens.</p>' +
      '<div class="scan-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="scan-steps">' + rows + '</div>' +
      (done
        ? '<div style="margin-top:26px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
            '<button class="btn" onclick="PROTO.go(\'case\')">Open case ' + esc(D.case.id) + '</button>' +
            '<span class="muted" style="font-size:13.5px">12 findings · 12 fixes ready</span></div>'
        : '<p class="muted" style="margin-top:22px;font-size:13.5px">This normally takes about 40 seconds.</p>') +
      '</div></div>';
  };

  render.case = function () {
    var order = { fresh: 0, working: 1, watched: 2 };
    var trackHtml = D.track.map(function (t, i) {
      var reached = i <= (state.caseAge === 'fresh' ? 1 : state.caseAge === 'working' ? 2 : 4);
      var current = (state.caseAge === 'fresh' && i === 1) || (state.caseAge === 'working' && i === 2) || (state.caseAge === 'watched' && i === 4);
      var sub = t.sub;
      if (t.key === 'working') sub = (findings().length - openFindings().length) + ' of ' + findings().length + ' closed';
      return '<div class="' + (current ? 'now' : reached ? 'on' : '') + '">' + esc(t.label) + '<em>' + esc(sub) + '</em></div>';
    }).join('');

    var list = findings().sort(function (a, b) {
      var w = { blocking: 0, serious: 1, advisory: 2 };
      return (isClosed(a) - isClosed(b)) || (w[a.severity] - w[b.severity]);
    }).map(function (f) {
      return '<button class="f-row' + (isClosed(f) ? ' closed' : '') + '" onclick="PROTO.openFinding(\'' + f.id + '\')">' +
        '<span class="fid">' + esc(f.id) + '</span>' +
        '<span class="ft">' + esc(f.title) + '</span>' +
        '<span class="go">›</span>' +
        '<span class="fr">' + sevBadge(f) + (isClosed(f) ? '' : remedyTag(f.remedy) + '<span>' + esc(f.remedy.title) + '</span>') + '</span>' +
      '</button>';
    }).join('');

    var tl = timeline().slice().reverse().map(function (e) {
      return '<li><time>' + esc(e.at) + '</time><span>' +
        '<b class="' + (e.alert ? 'alert' : e.closed ? 'ok-t' : '') + '">' + esc(e.text) + '</b>' +
        '<span class="d">' + esc(e.detail) + '</span></span></li>';
    }).join('');

    return '<div class="screen">' + caseHeader() +
      '<div class="track">' + trackHtml + '</div>' +
      '<div class="case-grid">' +
        '<div>' +
          '<div class="sec-t"><h3>What we found</h3><span class="n">' + findings().length + ' findings · every one with a fix</span></div>' +
          '<div class="f-list">' + list + '</div>' +
          '<div class="sec-t" style="margin-top:28px"><h3>What we could not determine</h3><span class="n">' + D.undetermined.length + ' open questions</span></div>' +
          '<div class="f-list">' + D.undetermined.map(function (u) {
            return '<div class="f-row" style="cursor:default;grid-template-columns:auto 1fr">' +
              '<span class="fid">' + esc(u.id) + '</span>' +
              '<span class="ft">' + esc(u.title) + '</span>' +
              '<span class="fr" style="grid-column:2"><span class="tag t-no_solution">not determined</span>' +
              '<span style="flex:1 1 100%;line-height:1.45;margin-top:2px">' + esc(u.reason) + '</span>' +
              '<span class="mono" style="font-size:11.5px;color:var(--eu)">→ ' + esc(u.resolve) + '</span></span>' +
            '</div>';
          }).join('') + '</div>' +
          '<p class="muted" style="margin-top:16px;font-size:14px">' +
            (state.caseAge === 'fresh' ? 'Four more things we could only check with your permission. ' : 'These resolve as you answer. ') +
            '<button class="btn btn-2 btn-sm" onclick="PROTO.go(\'questions\')">Go deeper — still free</button></p>' +
        '</div>' +
        '<div>' +
          '<div class="sec-t"><h3>What has happened</h3><span class="n">' + timeline().length + ' entries</span></div>' +
          '<div class="card"><ul class="tl">' + tl + '</ul>' +
            '<p class="own" style="margin:0">This case belongs to ' + esc(D.company.legalName) + '. ' + esc(D.case.participants) + ' people can see it. ' +
            'You can export or delete all of it at any time — including the evidence we stored.</p></div>' +
          '<div style="margin-top:20px;display:flex;gap:9px;flex-wrap:wrap">' +
            '<button class="btn btn-2 btn-sm" onclick="PROTO.go(\'colleagues\')">Share inward</button>' +
            '<button class="btn btn-2 btn-sm" onclick="PROTO.go(\'trust\')">Share outward</button>' +
            '<button class="btn btn-2 btn-sm" onclick="PROTO.go(\'supply\')">Supply chain</button>' +
          '</div>' +
        '</div>' +
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
        : '<div class="cites"><span class="cite" style="color:var(--ink-3);background:transparent;border-style:dashed">No legal claim made — this is an observation</span></div>') +
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
        '<p class="muted">Four answers opened nine new checks and filled eleven rows of your processing register. ' +
        'We will come back to you when something needs a decision.</p>' +
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
      '<h2 class="q-text">' + esc(q.text) + '</h2>' +
      '<p class="q-why">' + esc(q.why) + '</p>' +
      '<p class="q-unlock">Answering this unlocks ' + esc(q.unlocks) + '</p>' +
      '<div class="q-opts">' + opts + '</div>' +
      '<p class="muted" style="margin-top:22px;font-size:13px">We only ask what we cannot work out ourselves, and only when the answer changes something.</p>' +
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
      '<p class="muted" style="max-width:62ch;font-size:15.5px">Nobody receives a questionnaire. Each person gets a short list of things they actually control, with a button on every one, and an option to say "I don\'t know, check for me".</p>' +
      '<div class="roles" style="margin-top:24px">' + roles + '</div>' +
      '<div class="invite">' +
        '<div class="mailmock">' +
          '<div class="hdr"><span>From: <b>Mette Sørensen</b> &lt;mette@eksempelbutik.dk&gt;</span><span>To: hr@eksempelbutik.dk</span><span>Subject: 4 things for HR — 20 minutes</span></div>' +
          '<p style="margin:0 0 10px">Hi — we\'re fixing our GDPR situation and there are four things only you can answer. Two of them are already drafted, you just approve.</p>' +
          '<p style="margin:0 0 14px"><a href="#" onclick="return false" style="color:var(--eu)">Open my four items →</a></p>' +
          '<p class="muted" style="margin:0;font-size:13px">No account needed. You\'ll see only your part.</p>' +
        '</div>' +
        '<div>' +
          '<h4 style="font-size:16px;margin-bottom:8px">Why it comes from Mette</h4>' +
          '<p class="muted" style="font-size:14.5px">An invitation from a colleague gets opened. An invitation from a vendor nobody has heard of gets deleted. The case sends it in her name, and she can see who hasn\'t finished.</p>' +
          '<div class="dont">We never email their colleagues on our own initiative, and the invitation link is single-purpose, expiring and revocable.</div>' +
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
      '<p class="muted" style="max-width:64ch;font-size:15.5px">We read your vendors\' own processing agreements and sub-processor lists, then read theirs. Nobody at ' + esc(D.company.legalName) + ' has ever seen this list in full — and neither had your vendors\' own customers.</p>' +
      '<div class="card pad sc" style="margin-top:22px">' + levels + '</div>' +
      '<div style="margin-top:18px;display:flex;gap:22px;flex-wrap:wrap;font-size:13.5px" class="muted">' +
        '<span><b style="color:var(--ink)">21</b> sub-processors</span>' +
        '<span><b style="color:var(--ink)">9</b> established outside the EEA</span>' +
        '<span><b style="color:var(--ink)">3</b> levels deep</span>' +
        '<span>Every edge carries the document and date it came from</span>' +
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
      '<p class="muted" style="max-width:62ch;font-size:15.5px">Every clause traces to something in your case. Where the register has a gap, it says so instead of inventing text.</p>' +
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
      '<p class="eyebrow" style="text-align:center;margin-bottom:14px">What their customers see · published by them, not by us</p>' +
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
      '<p class="muted" style="font-size:13px;margin-top:16px;text-align:center;max-width:58ch;margin-inline:auto">' +
        'Off by default. Publishing is an explicit, reversible act recorded on the timeline. It never says approved, certified or compliant — and it never lists what is still open.</p>' +
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
      '<p class="muted" style="font-size:13.5px;margin-top:16px;max-width:66ch">Lane changes nothing about what the customer receives — it only decides whether a person reaches out. ' +
      'Small companies get the entire automated product; larger ones get the entire automated product plus a consultant.</p>' +
    '</div></div>';
  };

  /* ── chrome and routing ──────────────────────────────────────────── */

  function chrome() {
    var nav = SCREENS.map(function (s) {
      return '<button onclick="PROTO.go(\'' + s.id + '\')" aria-current="' + (state.screen === s.id) + '">' + esc(s.label) + '</button>';
    }).join('');
    var meta = SCREENS.filter(function (s) { return s.id === state.screen; })[0];
    var ageToggle = state.screen === 'case'
      ? '<span style="margin-left:auto;display:flex;gap:6px;align-items:center">Age of case:' +
        ['fresh', 'working', 'watched'].map(function (a) {
          return '<button class="btn btn-2 btn-sm" style="' + (state.caseAge === a ? 'border-color:var(--gold);background:var(--gold-soft)' : '') + '" onclick="PROTO.age(\'' + a + '\')">' +
            (a === 'fresh' ? 'Day one' : a === 'working' ? 'Week one' : 'Under watch') + '</button>';
        }).join('') + '</span>'
      : '';
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
    age: function (a) { state.caseAge = a; draw(); },
    answer: function () { state.qIndex++; draw(); },
    resetQ: function () { state.qIndex = 0; draw(); },
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
