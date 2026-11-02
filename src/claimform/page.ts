/**
 * TTTFG-5562: the guided claim form's page. One self-contained page, phone first: one topic per screen, known details
 * filled in, tap options, typing or a voice recording for free text, photos at the end. The token is read from the
 * address and everything else comes from /claim-form/<token>/state, so the page's source holds nothing about a client.
 * The design follows the guided form in the claims demo, in TTT's blue with TTT's logo.
 *
 * The page tests a question's conditions itself, so the next question shows on the tap. The server checks every answer
 * again when it's saved (claims package, guided.ts): it decides what counts, not the page.
 */
import type { LinkRefusal } from './links';
import { TTT_BLUE, TTT_LOGO } from './logo';

/** Scripts and styles from the page itself, the Geist font from Google, data only from itself, never framed. */
export const CLAIM_FORM_CSP = [
    "default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
    "style-src 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com', "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

/** The AI disclosure (AC 9). It says who checks the claim, and nothing about whether it is covered. */
export const DISCLOSURE = "Tina is TTT's AI assistant. A person on TTT's insurance team checks your claim before it goes to the insurer. Only the insurer can decide on your claim.";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root { --bg:#fff; --panel:#F7F8FA; --ink:#0B0F14; --text:#3A4450; --muted:#6B7684; --faint:#9AA3AE; --line:#E8EAED; --line-strong:#CDD2D8;
  --accent:${TTT_BLUE}; --accent-deep:#015A8E; --accent-soft:#E9F3FA; --good:#1F7A4D; --good-soft:#EAF5EF; --warn:#A15C07; --warn-soft:#FBF3E6; --rec:#B4483C;
  --sans:"Geist","Segoe UI",system-ui,-apple-system,sans-serif; --mono:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace; color-scheme:light; }
* { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
[hidden] { display:none !important; }
html, body { height:100%; }
body { margin:0; background:var(--panel); color:var(--text); font:15.5px/1.5 var(--sans); -webkit-font-smoothing:antialiased; }
button { font:inherit; color:inherit; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.app { display:flex; flex-direction:column; height:100vh; height:100dvh; background:var(--bg); max-width:520px; margin:0 auto; }
@media (min-width:560px) { body { padding:24px 0; } .app { height:calc(100dvh - 48px); border-radius:20px; overflow:hidden; box-shadow:0 1px 2px rgba(11,15,20,.04),0 12px 32px -12px rgba(11,15,20,.14); } }
.brand { display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--accent); padding:calc(10px + env(safe-area-inset-top,0px)) 18px 10px; color:#fff; }
.brand img { height:24px; width:auto; display:block; }
.brand span { font:500 11px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; opacity:.92; }
.top { padding:12px 18px 10px; border-bottom:1px solid var(--line); display:grid; gap:8px; }
.prog { height:4px; background:var(--line); border-radius:99px; overflow:hidden; }
.prog i { display:block; height:100%; width:0; background:var(--accent); border-radius:99px; transition:width .3s; }
.sec { display:flex; justify-content:space-between; gap:12px; font-size:12px; color:var(--muted); }
.body { flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:20px 18px 28px; display:grid; gap:20px; align-content:start; }
h1 { margin:0; font-size:22px; line-height:1.2; font-weight:500; letter-spacing:-.025em; color:var(--ink); text-wrap:balance; }
.help { margin:0; font-size:14px; color:var(--muted); line-height:1.45; }
.q { display:grid; gap:8px; min-width:0; }
.ql { font-size:14.5px; font-weight:500; color:var(--ink); line-height:1.35; }
.opts { display:flex; flex-wrap:wrap; gap:8px; }
.opt { cursor:pointer; min-height:44px; border:1px solid var(--line-strong); background:var(--bg); border-radius:10px; padding:10px 14px; font-size:15px; color:var(--ink); line-height:1.25; text-align:left; transition:background .12s,border-color .12s; }
.opt[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-deep); font-weight:500; }
.opts.wide { display:grid; }
.opts.wide .opt { width:100%; }
.yn .opt { flex:1 1 0; text-align:center; }
.inp { width:100%; min-height:44px; border:1px solid var(--line-strong); border-radius:10px; padding:10px 12px; font:inherit; font-size:16px; color:var(--ink); background:var(--bg); }
.inp:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:var(--accent); }
.inp[disabled] { background:var(--panel); color:var(--faint); }
textarea.inp { min-height:88px; resize:vertical; line-height:1.45; display:block; }
textarea.inp.long { min-height:128px; }
.say { display:grid; grid-template-columns:minmax(0,1fr) 44px; gap:8px; align-items:start; }
.mic { width:44px; height:44px; border-radius:50%; border:none; background:var(--accent); color:#fff; cursor:pointer; display:grid; place-items:center; }
.mic svg { width:20px; height:20px; }
.mic.rec { background:var(--rec); animation:pulse 1.4s infinite; }
.mic[disabled] { opacity:.5; }
@keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(180,72,60,.45); } 70% { box-shadow:0 0 0 12px rgba(180,72,60,0); } 100% { box-shadow:0 0 0 0 rgba(180,72,60,0); } }
.micnote { font-size:13px; color:var(--muted); min-height:0; }
.dk { justify-self:start; border:none; background:none; padding:4px 0; min-height:32px; font-size:13px; color:var(--muted); text-decoration:underline; text-underline-offset:3px; cursor:pointer; }
.dk[aria-pressed="true"] { color:var(--accent-deep); font-weight:500; text-decoration:none; }
.err { font-size:13.5px; color:var(--warn); background:var(--warn-soft); border-radius:8px; padding:8px 10px; }
.tag { display:inline-flex; align-items:center; gap:6px; font:500 10.5px/1 var(--mono); letter-spacing:.04em; text-transform:uppercase; padding:5px 8px; border-radius:99px; background:var(--good-soft); color:var(--good); width:max-content; max-width:100%; }
.sub { display:grid; gap:14px; padding:14px; border:1px solid var(--line); border-radius:12px; }
.sub .sh { font:500 11px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.card { border:1px solid var(--line); border-radius:12px; padding:2px 14px; background:var(--panel); }
.kv { display:flex; justify-content:space-between; gap:14px; padding:10px 0; font-size:14px; border-bottom:1px solid var(--line); }
.kv:last-child { border-bottom:none; }
.kv span { color:var(--muted); flex:none; }
.kv b { font-weight:500; color:var(--ink); text-align:right; overflow-wrap:anywhere; }
.row { display:grid; gap:6px; padding:12px 0; border-bottom:1px solid var(--line); }
.row:last-child { border-bottom:none; }
.row .rl { display:flex; justify-content:space-between; align-items:baseline; gap:12px; font-size:13px; color:var(--muted); }
.row .rv { font-size:15px; font-weight:500; color:var(--ink); overflow-wrap:anywhere; }
.row .rv.empty { color:var(--faint); font-weight:400; }
.link { border:none; background:none; padding:2px 0 2px 8px; color:var(--accent-deep); font-size:13px; cursor:pointer; min-height:28px; }
.av { width:54px; height:54px; border-radius:50%; background:var(--accent); color:#fff; display:grid; place-items:center; font:500 20px/1 var(--sans); }
.disc { font-size:13px; color:var(--muted); padding:10px 12px; border-radius:10px; background:var(--panel); line-height:1.45; }
.ups { display:grid; gap:10px; }
.up { display:grid; grid-template-columns:40px minmax(0,1fr) auto; gap:12px; align-items:center; padding:12px; border:1px solid var(--line); border-radius:12px; }
.up .ic { width:40px; height:40px; border-radius:10px; background:var(--panel); display:grid; place-items:center; color:var(--muted); }
.up .ic.ok { background:var(--good-soft); color:var(--good); }
.up b { display:block; font-weight:500; font-size:14px; color:var(--ink); line-height:1.3; }
.up small { font-size:12.5px; color:var(--muted); }
.addb { cursor:pointer; min-height:40px; display:inline-flex; align-items:center; border:1px solid var(--line-strong); background:var(--bg); border-radius:99px; padding:6px 14px; font-size:13.5px; color:var(--ink); white-space:nowrap; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
.thumbs { display:flex; gap:6px; flex-wrap:wrap; grid-column:1 / -1; }
.thumbs img { width:58px; height:58px; object-fit:cover; border-radius:8px; border:1px solid var(--line); }
.done-ic { width:64px; height:64px; border-radius:50%; background:var(--good-soft); color:var(--good); display:grid; place-items:center; }
.foot { padding:12px 18px calc(14px + env(safe-area-inset-bottom,0px)); border-top:1px solid var(--line); display:flex; gap:10px; background:var(--bg); }
.foot button, .foot a { flex:1; display:block; text-align:center; text-decoration:none; border-radius:12px; padding:13px; min-height:48px; font-weight:500; font-size:15px; cursor:pointer; border:1px solid var(--line-strong); background:var(--bg); color:var(--ink); }
.foot .go { background:var(--accent); color:#fff; border-color:var(--accent); flex:2.2; }
.foot button:disabled { opacity:.45; cursor:not-allowed; }
.center { text-align:center; padding:48px 18px; display:grid; gap:12px; justify-items:center; }
@media (prefers-reduced-motion:reduce) { * { animation:none !important; transition:none !important; } }
`;

const FONTS = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap">';
const HEAD = (title: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex"><meta name="theme-color" content="${TTT_BLUE}">
<title>${esc(title)}</title>${FONTS}<style>${STYLE}</style>
</head>`;
const BRAND = `<div class="brand"><img src="${TTT_LOGO}" alt="TTT Financial Group"><span>Claims</span></div>`;

/** The page's script. Plain ES5-style, so an older phone's browser runs it; no client data is in it. */
const SCRIPT = String.raw`
(function () {
  var base = location.pathname.replace(/\/$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ICON_OK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_CAM = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  var ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  var LONG = /descri|details|scenario|what happened|additional|explain|circumstance|how did|why /i;

  var V = null, A = {}, NK = {}, here = null, draft = {}, draftNK = {}, errors = {}, checked = {}, busy = false, thumbs = {};

  function api(path, opts) {
    return fetch(base + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (r.status === 410 || r.status === 404) { location.reload(); throw new Error('gone'); }
        if (!r.ok) { var e = new Error(b.message || 'failed'); e.body = b; e.status = r.status; throw e; }
        return b;
      });
    });
  }
  function post(path, body) { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }

  function same(a, b) { return typeof a === 'string' && typeof b === 'string' ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b; }
  function value(key) { return key in draft ? draft[key] : A[key]; }
  function holds(c) {
    var v = value(c.key);
    if (v === undefined || v === null) return false;
    for (var i = 0; i < c.oneOf.length; i++) if (same(v, c.oneOf[i])) return true;
    return false;
  }
  function shows(f) {
    for (var i = 0; i < f.when.length; i++) if (!holds(f.when[i])) return false;
    return true;
  }
  function promptOf(f) {
    if (f.variants) for (var i = 0; i < f.variants.length; i++) if (holds(f.variants[i].when)) return f.variants[i].prompt;
    return f.prompt;
  }
  function visibleScreens() {
    var out = [];
    V.screens.forEach(function (s, i) { if (s.fields.some(shows)) out.push(i); });
    return out;
  }
  function route() {
    var steps = [{ id: 'hello' }, { id: 'details' }];
    visibleScreens().forEach(function (i) { steps.push({ id: 'screen', i: i }); });
    steps.push({ id: 'photos' }, { id: 'review' });
    return steps;
  }
  function same_step(a, b) { return !!a && !!b && a.id === b.id && a.i === b.i; }
  function stepIndex(steps) {
    for (var i = 0; i < steps.length; i++) if (same_step(steps[i], here)) return i;
    return 0;
  }
  function isNotKnown(key) { return key in draftNK ? draftNK[key] : !!NK[key]; }

  // ---- the screens --------------------------------------------------------------------------------------------------
  function fieldHtml(f) {
    var v = value(f.key), nk = isNotKnown(f.key);
    if (v === undefined && f.prefill !== undefined && !(f.key in draft)) v = f.prefill;
    var input = '';
    if (f.type === 'yes/no') {
      input = '<div class="opts yn">' + [[true, 'Yes'], [false, 'No']].map(function (o) {
        return '<button type="button" class="opt" data-k="' + esc(f.key) + '" data-b="' + o[0] + '" aria-pressed="' + (v === o[0]) + '">' + o[1] + '</button>';
      }).join('') + '</div>';
    } else if (f.type === 'choice') {
      var wide = (f.choices || []).some(function (c) { return c.length > 18; });
      input = '<div class="opts' + (wide ? ' wide' : '') + '">' + (f.choices || []).map(function (c) {
        return '<button type="button" class="opt" data-k="' + esc(f.key) + '" data-v="' + esc(c) + '" aria-pressed="' + same(v, c) + '">' + esc(c) + '</button>';
      }).join('') + '</div>';
    } else if (f.type === 'date') {
      input = '<input class="inp" type="date" id="f-' + esc(f.key) + '" data-bind="' + esc(f.key) + '" value="' + esc(typeof v === 'string' ? v.slice(0, 10) : '') + '"' + (nk ? ' disabled' : '') + '>';
    } else if (f.type === 'number') {
      input = '<input class="inp" inputmode="decimal" id="f-' + esc(f.key) + '" data-bind="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '"' + (nk ? ' disabled' : '') + '>';
    } else if (f.keyboard) {
      input = '<input class="inp" type="' + f.keyboard + '" autocomplete="off" id="f-' + esc(f.key) + '" data-bind="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '"' + (nk ? ' disabled' : '') + '>';
    } else {
      var long = LONG.test(f.prompt);
      var box = long
        ? '<textarea class="inp long" id="f-' + esc(f.key) + '" data-bind="' + esc(f.key) + '"' + (nk ? ' disabled' : '') + '>' + esc(v == null ? '' : v) + '</textarea>'
        : '<input class="inp" autocomplete="off" id="f-' + esc(f.key) + '" data-bind="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '"' + (nk ? ' disabled' : '') + '>';
      input = canRecord ? '<div class="say">' + box + '<button type="button" class="mic" data-mic="' + esc(f.key) + '" aria-label="Record your answer" title="Record your answer"' + (nk ? ' disabled' : '') + '>' + ICON_MIC + '</button></div><div class="micnote" id="note-' + esc(f.key) + '" hidden></div>' : box;
    }
    var tag = f.prefill !== undefined && !(f.key in draft) && A[f.key] === undefined ? '<span class="tag">From your last claim</span>' : '';
    var labelFor = f.type === 'yes/no' || f.type === 'choice' ? '<div class="ql">' + esc(promptOf(f)) + '</div>' : '<label class="ql" for="f-' + esc(f.key) + '">' + esc(promptOf(f)) + '</label>';
    return '<div class="q" data-q="' + esc(f.key) + '">' + labelFor + tag + input
      + '<button type="button" class="dk" data-dk="' + esc(f.key) + '" aria-pressed="' + nk + '">' + (nk ? 'I don\'t know yet (tap to answer)' : 'I don\'t know yet') + '</button>'
      + (errors[f.key] ? '<div class="err" role="alert">' + esc(errors[f.key]) + '</div>' : '') + '</div>';
  }
  function screenHtml(s) {
    var html = '<h1>' + esc(s.title) + '</h1>' + (s.help ? '<p class="help">' + esc(s.help) + '</p>' : ''), entry = null, open = false;
    s.fields.forEach(function (f) {
      if (!shows(f)) return;
      var e = f.entry || null;
      if (e !== entry) {
        if (open) { html += '</div>'; open = false; }
        if (e) { html += '<div class="sub"><div class="sh">' + esc(e) + '</div>'; open = true; }
        entry = e;
      }
      html += fieldHtml(f);
    });
    if (open) html += '</div>';
    return html;
  }
  function helloHtml() {
    var name = V.firstName ? 'Hi ' + esc(V.firstName) + ', let\'s get your claim to the insurer.' : 'Let\'s get your claim to the insurer.';
    return '<div class="av">T</div><h1>' + name + '</h1>'
      + '<p class="help">Most answers are a tap, and we\'ve filled in what we already know. It takes about ' + V.minutes + ' minutes, and you can stop and come back with the same link.</p>'
      + '<div class="card"><div class="kv"><span>Claim</span><b>' + esc(V.title) + ' · ' + esc(V.reference) + '</b></div><div class="kv"><span>Insurer</span><b>' + esc(V.insurer) + '</b></div></div>'
      + '<p class="disc">' + esc(DISCLOSURE) + '</p>'
      + '<p class="help">Rather answer on WhatsApp? Just reply "chat" to Tina.</p>';
  }
  function detailsHtml() {
    return '<h1>Are these details still right?</h1><p class="help">From TTT\'s records. Change anything that\'s out of date.</p><span class="tag">Filled from TTT\'s records</span>'
      + V.details.map(function (d) {
        var v = d.key in draft ? draft[d.key] : d.value;
        if (!d.editable) return '<div class="card"><div class="kv"><span>' + esc(d.label) + '</span><b>' + esc(v) + '</b></div></div>';
        var long = /address/i.test(d.label);
        var type = /cellphone|number$/i.test(d.label) && !/policy/i.test(d.label) ? 'tel' : /email/i.test(d.label) ? 'email' : 'text';
        var box = long ? '<textarea class="inp" id="f-' + esc(d.key) + '" data-bind="' + esc(d.key) + '">' + esc(v) + '</textarea>'
          : '<input class="inp" type="' + type + '" autocomplete="off" id="f-' + esc(d.key) + '" data-bind="' + esc(d.key) + '" value="' + esc(v) + '">';
        return '<div class="q"><label class="ql" for="f-' + esc(d.key) + '">' + esc(d.label) + '</label>' + box + (errors[d.key] ? '<div class="err" role="alert">' + esc(errors[d.key]) + '</div>' : '') + '</div>';
      }).join('');
  }
  function photosHtml() {
    var items = V.evidence.filter(shows);
    return '<h1>Add your photos and documents</h1><p class="help">Add what you have now. Tina will ask on WhatsApp for anything still missing.</p><div class="ups">'
      + items.map(function (e) { return upHtml(e.key, e.prompt, e.kind, e.count); }).join('')
      + upHtml('', 'Anything else that may help', 'photo', extra)
      + '</div>' + (errors.photos ? '<div class="err" role="alert">' + esc(errors.photos) + '</div>' : '');
  }
  var extra = 0;
  function upHtml(key, label, kind, count) {
    var accept = kind === 'video' ? 'video/*' : kind === 'document' ? 'image/*,application/pdf' : 'image/*,application/pdf';
    var id = 'up-' + (key || 'other');
    var th = (thumbs[key] || []).map(function (u) { return '<img src="' + u + '" alt="">'; }).join('');
    return '<div class="up"><div class="ic' + (count ? ' ok' : '') + '">' + (count ? ICON_OK : ICON_CAM) + '</div><div><b>' + esc(label) + '</b><small id="st-' + esc(id) + '">' + (count ? count + ' added' : 'Not added yet') + '</small></div>'
      + '<label class="addb" for="' + esc(id) + '">Add</label><input class="sr" type="file" id="' + esc(id) + '" data-up="' + esc(key) + '" accept="' + accept + '" multiple>'
      + (th ? '<div class="thumbs">' + th + '</div>' : '') + '</div>';
  }
  function shown(v, f) {
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    return String(v);
  }
  function reviewHtml() {
    var html = '<h1>Check your claim</h1><p class="help">Tap Change to fix anything. Next, Tina sends your filled-in form to sign on WhatsApp.</p>';
    visibleScreens().forEach(function (i) {
      var s = V.screens[i], rows = '';
      s.fields.forEach(function (f) {
        if (!shows(f)) return;
        var v = A[f.key], nk = !!NK[f.key];
        var text = v !== undefined && v !== null ? esc(shown(v, f)) : nk ? 'To follow' : 'Not answered';
        rows += '<div class="row"><div class="rl"><span>' + esc(promptOf(f)) + '</span></div><div class="rv' + (v === undefined || v === null ? ' empty' : '') + '">' + text + '</div></div>';
      });
      html += '<div class="q"><div class="rl" style="display:flex;justify-content:space-between;align-items:baseline"><div class="ql">' + esc(s.title) + '</div><button type="button" class="link" data-go="' + i + '">Change</button></div><div class="card">' + rows + '</div></div>';
    });
    var count = V.evidence.reduce(function (n, e) { return n + (shows(e) ? e.count : 0); }, 0) + extra;
    html += '<div class="q"><div class="rl" style="display:flex;justify-content:space-between;align-items:baseline"><div class="ql">Photos and documents</div><button type="button" class="link" data-go="photos">Change</button></div><div class="card"><div class="kv"><span>Added</span><b>' + count + '</b></div></div></div>';
    html += '<p class="disc">' + esc(DISCLOSURE) + '</p>' + (errors.submit ? '<div class="err" role="alert">' + esc(errors.submit) + '</div>' : '');
    return html;
  }

  function render(keepScroll) {
    var body = $('body'), top = body.scrollTop;
    var steps = route(), i = stepIndex(steps), step = steps[i];
    here = step;
    var count = steps.length - 1;
    $('prog').style.width = (i === 0 ? 0 : Math.round(i / count * 100)) + '%';
    var title = step.id === 'hello' ? 'Welcome' : step.id === 'details' ? 'Your details' : step.id === 'photos' ? 'Photos' : step.id === 'review' ? 'Check' : V.screens[step.i].title;
    $('sec').textContent = title;
    $('count').textContent = i > 0 ? i + ' of ' + count : '';
    body.innerHTML = step.id === 'hello' ? helloHtml() : step.id === 'details' ? detailsHtml() : step.id === 'photos' ? photosHtml() : step.id === 'review' ? reviewHtml() : screenHtml(V.screens[step.i]);
    $('back').hidden = i === 0;
    $('next').textContent = step.id === 'hello' ? 'Start' : step.id === 'details' ? 'All correct' : step.id === 'review' ? 'Submit claim' : 'Continue';
    $('next').disabled = busy;
    body.scrollTop = keepScroll ? top : 0;
    if (!keepScroll) { var h = body.querySelector('h1'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); h.style.outline = 'none'; } }
  }

  // ---- answers ------------------------------------------------------------------------------------------------------
  var hasRealValue = function (v) { return v !== undefined && v !== null && v !== ''; };
  function collectScreen(s) {
    var answers = [], notKnown = [], cleared = [], missing = [];
    s.fields.forEach(function (f) {
      if (!shows(f)) return;
      var v = value(f.key), nk = isNotKnown(f.key);
      if (v === undefined && f.prefill !== undefined) v = f.prefill;
      if (nk) { notKnown.push(f.key); return; }
      if (hasRealValue(v)) { if (v !== A[f.key]) answers.push({ key: f.key, value: v }); else if (NK[f.key]) answers.push({ key: f.key, value: v }); return; }
      if (A[f.key] !== undefined) cleared.push(f.key);
      if (f.required) missing.push(f.key);
      // An optional question left empty counts as "not yet", so the same link carries on past it.
      else notKnown.push(f.key);
    });
    return { answers: answers, notKnown: notKnown, cleared: cleared, missing: missing };
  }
  function applySaved(r) {
    A = r.answers; NK = {};
    r.notKnown.forEach(function (k) { NK[k] = true; });
    draft = {}; draftNK = {};
  }
  function save(body, done) {
    busy = true; $('next').disabled = true;
    body.checked = Object.keys(checked);
    post('/answers', body).then(function (r) {
      busy = false;
      errors = {};
      if (r.problems && r.problems.length) {
        r.problems.forEach(function (p) { errors[p.key] = p.text; checked[p.key] = true; });
        var keep = draft;
        applySaved(r);
        draft = keep;
        render(true);
        var firstErr = document.querySelector('.err'); if (firstErr) firstErr.scrollIntoView({ block: 'center' });
        return;
      }
      applySaved(r);
      done();
    }).catch(function (e) {
      busy = false;
      if (e.message === 'gone') return;
      errors = { submit: 'No connection. Please try again.', photos: 'No connection. Please try again.' };
      alertBar('No connection. Your answers on this screen aren\'t saved yet. Please try again.');
      $('next').disabled = false;
    });
  }
  function alertBar(text) {
    var b = $('body'), el = document.createElement('div');
    el.className = 'err'; el.setAttribute('role', 'alert'); el.textContent = text;
    b.insertBefore(el, b.firstChild); b.scrollTop = 0;
  }
  function move(by) {
    var steps = route(), i = stepIndex(steps);
    here = steps[Math.max(0, Math.min(steps.length - 1, i + by))];
    errors = {};
    render();
  }
  function next() {
    if (busy) return;
    var step = here;
    if (step.id === 'hello') return move(1);
    if (step.id === 'details') {
      var answers = V.details.filter(function (d) { return d.editable && d.key in draft && draft[d.key].trim() !== d.value; }).map(function (d) { return { key: d.key, value: draft[d.key] }; });
      var changed = {};
      answers.forEach(function (a) { changed[a.key] = a.value; });
      return save({ answers: answers, detailsConfirmed: true }, function () {
        V.details.forEach(function (d) { if (d.key in changed) d.value = changed[d.key]; });
        V.detailsConfirmed = true;
        move(1);
      });
    }
    if (step.id === 'photos') return move(1);
    if (step.id === 'review') return submit();
    var c = collectScreen(V.screens[step.i]);
    if (c.missing.length) {
      errors = {};
      c.missing.forEach(function (k) { errors[k] = 'Please answer this, or tap "I don\'t know yet".'; });
      render(true);
      var q = document.querySelector('[data-q="' + c.missing[0].replace(/"/g, '') + '"]'); if (q) q.scrollIntoView({ block: 'center' });
      return;
    }
    if (!c.answers.length && !c.notKnown.some(function (k) { return !NK[k]; }) && !c.cleared.length) return move(1);
    save({ answers: c.answers, notKnown: c.notKnown, cleared: c.cleared }, function () { move(1); });
  }
  function submit() {
    busy = true; $('next').disabled = true; $('next').textContent = 'Submitting…';
    post('/submit').then(function (r) {
      busy = false;
      if (r.open && r.open.length) {
        var target = null;
        V.screens.forEach(function (s, i) { if (target === null && s.fields.some(function (f) { return r.open.indexOf(f.key) >= 0; })) target = i; });
        errors = {};
        r.open.forEach(function (k) { errors[k] = 'Please answer this, or tap "I don\'t know yet".'; });
        if (target !== null) { here = { id: 'screen', i: target }; var keep = errors; render(); errors = keep; render(true); return; }
      }
      location.reload();
    }).catch(function (e) {
      busy = false;
      if (e.message === 'gone') return;
      errors = { submit: (e.body && e.body.message) || 'No connection. Please try again.' };
      render(true);
    });
  }

  // ---- voice --------------------------------------------------------------------------------------------------------
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var rec = null, recKey = null, recParts = [], recTimer = null;
  function micNote(key, text) { var n = $('note-' + key); if (n) { n.textContent = text; n.hidden = !text; } }
  function mime() {
    var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  function mic(key, btn) {
    if (rec) { if (recKey === key) rec.stop(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var type = mime();
      rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      recKey = key; recParts = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recParts.push(e.data); };
      rec.onstop = function () {
        clearTimeout(recTimer);
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(recParts, { type: rec.mimeType || type || 'audio/webm' }), k = recKey;
        rec = null; recKey = null;
        btn.classList.remove('rec'); btn.innerHTML = ICON_MIC; btn.disabled = true; btn.setAttribute('aria-label', 'Record your answer');
        micNote(k, 'Listening to that…');
        fetch(base + '/voice?key=' + encodeURIComponent(k), { method: 'POST', headers: { 'Content-Type': (blob.type || 'audio/webm').split(';')[0] }, body: blob })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            btn.disabled = false;
            if (j.text) {
              var box = $('f-' + k), before = box ? box.value.trim() : '';
              var text = before ? before + ' ' + j.text : j.text;
              draft[k] = text; if (box) box.value = text;
              micNote(k, 'Please check what I heard. You can change it.');
            } else micNote(k, j.message || 'I couldn\'t make that out. Please try again, or type your answer.');
          })
          .catch(function () { btn.disabled = false; micNote(k, 'No connection. Please try again, or type your answer.'); });
      };
      rec.start();
      btn.classList.add('rec'); btn.innerHTML = ICON_STOP; btn.setAttribute('aria-label', 'Stop recording');
      micNote(key, 'Recording… tap again to stop.');
      recTimer = setTimeout(function () { if (rec) rec.stop(); }, 180000);
    }).catch(function () { micNote(key, 'The microphone isn\'t available. Please type your answer.'); });
  }

  // ---- photos -------------------------------------------------------------------------------------------------------
  function upload(input) {
    var key = input.dataset.up, files = [].slice.call(input.files || []), st = $('st-' + input.id);
    if (!files.length) return;
    var i = 0;
    busy = true; $('next').disabled = true;
    function one() {
      if (i >= files.length) { busy = false; render(true); return; }
      var f = files[i++];
      if (st) st.textContent = 'Adding ' + i + ' of ' + files.length + '…';
      fetch(base + '/file' + (key ? '?item=' + encodeURIComponent(key) : ''), { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name || 'file') }, body: f })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (r) {
          if (!r.ok) { errors.photos = r.j.message || 'That file couldn\'t be added.'; return one(); }
          errors.photos = '';
          if (key) { V.evidence.forEach(function (e) { if (e.key === key) e.count++; }); } else extra++;
          if (f.type && f.type.indexOf('image/') === 0 && f.type !== 'image/heic' && f.type !== 'image/heif') (thumbs[key] = thumbs[key] || []).push(URL.createObjectURL(f));
          one();
        })
        .catch(function () { errors.photos = 'No connection. Please try again.'; busy = false; render(true); });
    }
    one();
  }

  // ---- taps and typing ----------------------------------------------------------------------------------------------
  $('body').addEventListener('click', function (e) {
    var o = e.target.closest('[data-k]');
    if (o) {
      var k = o.dataset.k, v = o.dataset.b !== undefined ? o.dataset.b === 'true' : o.dataset.v;
      draft[k] = v; draftNK[k] = false; delete errors[k];
      render(true);
      return;
    }
    var d = e.target.closest('[data-dk]');
    if (d) {
      var key = d.dataset.dk, now = !isNotKnown(key);
      draftNK[key] = now; delete errors[key];
      if (now) draft[key] = ''; else delete draft[key];
      render(true);
      return;
    }
    var m = e.target.closest('[data-mic]');
    if (m) { mic(m.dataset.mic, m); return; }
    var g = e.target.closest('[data-go]');
    if (g) { here = g.dataset.go === 'photos' ? { id: 'photos' } : { id: 'screen', i: Number(g.dataset.go) }; errors = {}; render(); }
  });
  $('body').addEventListener('input', function (e) {
    var b = e.target.dataset.bind;
    if (b) {
      draft[b] = e.target.value; draftNK[b] = false;
      if (errors[b]) { delete errors[b]; var q = e.target.closest('.q'), er = q && q.querySelector('.err'); if (er) er.remove(); }
      if (checked[b]) delete checked[b];
    }
  });
  $('body').addEventListener('change', function (e) { if (e.target.dataset && e.target.dataset.up !== undefined) upload(e.target); });
  $('next').addEventListener('click', next);
  $('back').addEventListener('click', function () { if (!busy && !rec) move(-1); });

  // ---- open ---------------------------------------------------------------------------------------------------------
  function loadState() {
    api('/state').then(function (s) {
      V = s; A = s.answers; NK = {};
      s.notKnown.forEach(function (k) { NK[k] = true; });
      var started = s.detailsConfirmed;
      if (!started) here = { id: 'hello' };
      else {
        here = s.startAt >= s.screens.length ? { id: 'photos' } : { id: 'screen', i: s.startAt };
        // A screen whose questions don't apply yet isn't on the route: the first that does comes next.
        var steps = route();
        if (!steps.some(function (x) { return same_step(x, here); })) here = { id: 'photos' };
      }
      $('app').hidden = false; $('loading').hidden = true;
      render();
    }).catch(function (e) {
      if (e.message === 'gone') return;
      $('loading').textContent = 'The form could not be loaded. Please check your connection and refresh the page.';
    });
  }
  var DISCLOSURE = ${JSON.stringify(DISCLOSURE)};
  loadState();
})();
`;

/** The page for a link that works. */
export function claimFormPage(): string {
    return `${HEAD('Your claim form')}<body>
<p class="center help" id="loading">Loading your form…</p>
<div class="app" id="app" hidden>
  ${BRAND}
  <div class="top">
    <div class="prog"><i id="prog"></i></div>
    <div class="sec"><span id="sec"></span><span id="count"></span></div>
  </div>
  <main class="body" id="body"></main>
  <div class="foot"><button type="button" id="back">Back</button><button type="button" class="go" id="next">Start</button></div>
</div>
<script>${SCRIPT}</script>
</body></html>`;
}

const REFUSED: Record<LinkRefusal, { title: string; text: string; ok?: boolean }> = {
    'not-found': { title: 'This link does not work', text: 'Please check you opened the whole link, or ask Tina for a new one on WhatsApp.' },
    expired: { title: 'This link has expired', text: 'Links work for 7 days. Reply "chat" to Tina on WhatsApp and she will carry on with you there.' },
    done: { title: 'Claim submitted', text: 'Thank you, we have your answers. Tina will message you on WhatsApp with anything still needed and your form to sign.', ok: true },
    superseded: { title: 'There is a newer link', text: 'Please open the latest link Tina sent you.' },
};

/** The page for a link that's done with, or doesn't work. `whatsApp`: Tina's number, for the way back. */
export function refusedPage(reason: LinkRefusal, whatsApp?: string | null): string {
    const r = REFUSED[reason];
    const back = whatsApp ? `<div class="foot"><a class="go" href="https://wa.me/${esc(whatsApp.replace(/\D/g, ''))}">Back to WhatsApp</a></div>` : '';
    const icon = r.ok ? '<div class="done-ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div>' : '';
    return `${HEAD(r.title)}<body><div class="app">${BRAND}<main class="body"><div class="center">${icon}<h1>${esc(r.title)}</h1><p class="help">${esc(r.text)}</p></div></main>${back}</div></body></html>`;
}
