/**
 * TTTFG-5562: the guided claim form's page. One self-contained page, phone first: one topic per screen, known details filled
 * in, and tapping wherever it can be tapped: options, sliders, dates and times to pick. A box only where the client has to
 * give a name or a number, and a recording only for their own words. A blank is an answer: it says they don't know. A step
 * doesn't scroll: the page measures the phone's screen and shows the questions that fit, and the rest are the next step. Only
 * the summary at the end may scroll. The
 * token is read from the address and everything else comes from /claim-form/<token>/state, so the page's source holds
 * nothing about a client. The design follows the guided form in the claims demo, in TTT's blue with TTT's logo.
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
.app { position:relative; display:flex; flex-direction:column; height:100vh; height:100dvh; background:var(--bg); max-width:520px; margin:0 auto; }
@media (min-width:560px) { body { padding:24px 0; } .app { height:calc(100dvh - 48px); border-radius:20px; overflow:hidden; box-shadow:0 1px 2px rgba(11,15,20,.04),0 12px 32px -12px rgba(11,15,20,.14); } }
.brand { display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--accent); padding:calc(10px + env(safe-area-inset-top,0px)) 18px 10px; color:#fff; }
.brand img { height:24px; width:auto; display:block; }
.brand span { font:500 11px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; opacity:.92; }
.top { padding:10px 18px 10px; border-bottom:1px solid var(--line); display:grid; gap:8px; }
.prog { height:4px; background:var(--line); border-radius:99px; overflow:hidden; }
.prog i { display:block; height:100%; width:0; background:var(--accent); border-radius:99px; transition:width .3s; }
.sec { font-size:18px; line-height:1.2; font-weight:500; letter-spacing:-.02em; color:var(--ink); }
.body { flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:16px 18px; display:grid; gap:16px; align-content:start; }
h1 { margin:0; font-size:21px; line-height:1.2; font-weight:500; letter-spacing:-.025em; color:var(--ink); text-wrap:balance; }
.help { margin:0; font-size:13.5px; color:var(--muted); line-height:1.45; }
.q { display:grid; gap:7px; min-width:0; }
.ql { font-size:14px; font-weight:500; color:var(--ink); line-height:1.35; }
.opts { display:flex; flex-wrap:wrap; gap:8px; }
.opt { cursor:pointer; min-height:42px; border:1px solid var(--line-strong); background:var(--bg); border-radius:10px; padding:9px 13px; font-size:14px; color:var(--ink); line-height:1.25; text-align:left; transition:background .12s,border-color .12s; }
.opt[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-deep); font-weight:500; }
.inp { width:100%; min-height:44px; border:1px solid var(--line-strong); border-radius:10px; padding:10px 12px; font:inherit; font-size:16px; color:var(--ink); background:var(--bg); }
.inp:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:var(--accent); }
textarea.inp { min-height:96px; resize:vertical; line-height:1.45; display:block; }
.row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.opts.tight { gap:6px; }
.opts.tight .opt { min-height:36px; padding:7px 11px; font-size:13.5px; }
.tiles { display:grid; gap:8px; grid-template-columns:1fr 1fr; }
.tiles.t3 { grid-template-columns:.75fr 1.1fr 1fr; }
.tiles.t1 { grid-template-columns:1fr; }
.tile { display:grid; gap:3px; align-content:center; text-align:left; min-height:54px; padding:8px 12px; border:1px solid var(--line-strong); border-radius:12px; background:var(--bg); cursor:pointer; transition:background .12s,border-color .12s; }
.tile small { font:500 10.5px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.tile b { font-size:16px; line-height:1.2; font-weight:400; color:var(--faint); }
.tile.on { border-color:var(--accent); background:var(--accent-soft); }
.tile.on small { color:var(--accent-deep); }
.tile.on b { color:var(--accent-deep); font-weight:500; }
.sheet { position:absolute; inset:0; z-index:5; display:flex; flex-direction:column; justify-content:flex-end; }
.scrim { position:absolute; inset:0; background:rgba(11,15,20,.38); }
.panel { position:relative; display:grid; gap:14px; grid-template-rows:auto minmax(0,1fr); max-height:72%; padding:16px 18px calc(18px + env(safe-area-inset-bottom,0px)); background:var(--bg); border-radius:20px 20px 0 0; box-shadow:0 -8px 28px rgba(11,15,20,.14); animation:rise .18s ease; }
@keyframes rise { from { transform:translateY(24px); opacity:.6; } to { transform:none; opacity:1; } }
.panel-head { display:flex; justify-content:space-between; align-items:center; font-size:16px; font-weight:500; color:var(--ink); }
.panel-head button { width:32px; height:32px; border:none; border-radius:50%; background:var(--panel); color:var(--muted); cursor:pointer; font-size:14px; }
.grid { display:grid; gap:8px; overflow-y:auto; -webkit-overflow-scrolling:touch; }
.grid.g7 { grid-template-columns:repeat(7,minmax(0,1fr)); gap:6px; }
.grid.g6 { grid-template-columns:repeat(6,minmax(0,1fr)); gap:6px; }
.grid.g4 { grid-template-columns:repeat(4,minmax(0,1fr)); }
.grid.g3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
.grid.g1 .cell { text-align:left; padding:10px 12px; font-size:14px; line-height:1.3; }
.cell { min-height:44px; border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--ink); font-size:15px; font-variant-numeric:tabular-nums; cursor:pointer; }
.cell.on { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:500; }
.say { display:grid; grid-template-columns:minmax(0,1fr) 44px; gap:8px; align-items:start; }
.mic { width:44px; height:44px; border-radius:50%; border:none; background:var(--accent); color:#fff; cursor:pointer; display:grid; place-items:center; }
.mic svg { width:20px; height:20px; }
.mic.rec { background:var(--rec); animation:pulse 1.4s infinite; }
.mic[disabled] { opacity:.5; }
@keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(180,72,60,.45); } 70% { box-shadow:0 0 0 12px rgba(180,72,60,0); } 100% { box-shadow:0 0 0 0 rgba(180,72,60,0); } }
.micnote { font-size:13px; color:var(--muted); }
.range { display:grid; gap:6px; }
.range input { width:100%; height:28px; accent-color:var(--accent); }
.rv { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
.rv b { color:var(--ink); font-weight:500; font-variant-numeric:tabular-nums; flex:none; font-size:14px; }
.rv b.unset { color:var(--faint); font-weight:400; }
.step-n { display:flex; align-items:center; gap:14px; }
.step-n button { width:44px; height:44px; border-radius:50%; border:1px solid var(--line-strong); background:var(--bg); cursor:pointer; font-size:20px; color:var(--ink); }
.step-n b { font:400 26px/1 var(--sans); color:var(--ink); min-width:22px; text-align:center; font-variant-numeric:tabular-nums; }
.amt { position:relative; }
.amt span { position:absolute; left:12px; top:11px; color:var(--muted); font-size:16px; }
.amt .inp { padding-left:28px; }
.err { font-size:13.5px; color:var(--warn); background:var(--warn-soft); border-radius:8px; padding:8px 10px; }
.sub { display:grid; gap:12px; padding:14px; border:1px solid var(--line); border-radius:12px; }
.sub .sh { font:500 11px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.card { border:1px solid var(--line); border-radius:12px; padding:2px 14px; background:var(--panel); }
.kv { display:flex; justify-content:space-between; align-items:baseline; gap:14px; width:100%; min-height:40px; padding:9px 0; font-size:14px; border:none; border-bottom:1px solid var(--line); background:none; cursor:pointer; text-align:left; }
.kv.fixed { cursor:default; }
.kv:last-child { border-bottom:none; }
.kv span { color:var(--muted); flex:none; }
.kv b { font-weight:500; color:var(--ink); text-align:right; overflow-wrap:anywhere; }
.ups { display:grid; gap:10px; }
.row { display:grid; gap:3px; padding:9px 0; border-bottom:1px solid var(--line); }
.row:last-child { border-bottom:none; }
.row .rl { font-size:12.5px; color:var(--muted); line-height:1.35; }
.row .rv2 { font-size:14.5px; font-weight:500; color:var(--ink); overflow-wrap:anywhere; }
.row .rv2.empty { color:var(--faint); font-weight:400; }
.head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
.link { border:none; background:none; padding:2px 0 2px 8px; color:var(--accent-deep); font-size:13px; cursor:pointer; min-height:28px; }
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
const BRAND = (right = 'Claims') => `<div class="brand"><img src="${TTT_LOGO}" alt="TTT Financial Group"><span id="brandTitle">${esc(right)}</span></div>`;

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
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var THIS_YEAR = new Date().getFullYear();

  var V = null, A = {}, NK = {}, here = null, draft = {}, errors = {}, checked = {}, busy = false, thumbs = {}, extra = 0;
  /** Which "Other" box is open, which "Earlier" date picker is open, and part-picked dates and times. */
  var otherOpen = {}, earlierOpen = {}, parts = {}, FIELD = {}, PRE = {}, editing = {};
  /** What's on the page now, whether more of this step comes after it, and the height a step has to fit in. */
  var page = [], morePages = false, pageH = 0;

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

  function same(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
  function sameStrict(a, b) { return typeof a === typeof b ? (typeof a === 'string' ? same(a, b) : a === b) : false; }
  // A value from the client's last claim counts until they change it, so the question after it shows straight away.
  function value(key) { return key in draft ? draft[key] : A[key] !== undefined ? A[key] : NK[key] ? undefined : PRE[key]; }
  function filled(v) { return v !== undefined && v !== null && v !== ''; }
  function holds(c) {
    var v = value(c.key);
    if (!filled(v)) return false;
    for (var i = 0; i < c.oneOf.length; i++) if (sameStrict(v, c.oneOf[i])) return true;
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
    V.screens.forEach(function (s, i) { if (s.fields.some(function (f) { return shows(f) && !f.hidden; })) out.push(i); });
    return out;
  }
  function route() {
    var steps = [{ id: 'hello' }, { id: 'details' }];
    visibleScreens().forEach(function (i) { steps.push({ id: 'screen', i: i }); });
    steps.push({ id: 'photos' }, { id: 'review' });
    return steps;
  }
  function sameStep(a, b) { return !!a && !!b && a.id === b.id && a.i === b.i; }
  function stepIndex(steps) {
    for (var i = 0; i < steps.length; i++) if (sameStep(steps[i], here)) return i;
    return 0;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return isoOf(d); }

  // ---- one question ------------------------------------------------------------------------------------------------
  function q(key) { return esc(key); }
  function optBtn(attrs, label, on) { return '<button type="button" class="opt" ' + attrs + ' aria-pressed="' + !!on + '">' + esc(label) + '</button>'; }
  function box(f, v, o) {
    o = o || {};
    var val = v === undefined || v === null ? '' : v;
    var ph = o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '';
    var attr = o.attr || ('data-bind="' + q(f.key) + '"');
    return '<input class="inp" type="' + (f.keyboard || 'text') + '" autocomplete="off" id="f-' + q(f.key) + '"' + (o.mode ? ' inputmode="' + o.mode + '"' : '') + ' ' + attr + ph + ' value="' + esc(val) + '">';
  }
  function micHtml(key) {
    if (!canRecord) return '';
    var on = recKey === key;
    return '<button type="button" class="mic' + (on ? ' rec' : '') + '" data-mic="' + q(key) + '" aria-label="' + (on ? 'Stop recording' : 'Record your answer') + '" title="Record your answer">' + (on ? ICON_STOP : ICON_MIC) + '</button>';
  }
  function longBox(key, v, attr, placeholder) {
    var ta = '<textarea class="inp" id="f-' + q(key) + '" ' + attr + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + '>' + esc(v == null ? '' : v) + '</textarea>';
    return canRecord ? '<div class="say">' + ta + micHtml(key) + '</div><div class="micnote" id="note-' + q(key) + '" hidden></div>' : ta;
  }
  function range(from, to) { var out = []; for (var i = from; from <= to ? i <= to : i >= to; i += from <= to ? 1 : -1) out.push(i); return out; }
  function dateParts(key, v) {
    var p = parts[key] || {};
    var s = typeof v === 'string' ? v : '';
    return { y: p.y !== undefined ? p.y : s.slice(0, 4), m: p.m !== undefined ? p.m : s.slice(5, 7), d: p.d !== undefined ? p.d : s.slice(8, 10), h: p.h !== undefined ? p.h : s.slice(11, 13), i: p.i !== undefined ? p.i : s.slice(14, 16) };
  }
  function tile(key, part, label, text) {
    return '<button type="button" class="tile' + (text ? ' on' : '') + '" data-tile="' + q(key) + '" data-part="' + part + '"><small>' + esc(label) + '</small><b>' + esc(text || 'Select') + '</b></button>';
  }
  function dateTiles(key, c, v) {
    var p = dateParts(key, v), month = p.m ? MONTHS[Number(p.m) - 1] : '';
    if (c.month) return '<div class="tiles">' + tile(key, 'm', 'Month', month) + tile(key, 'y', 'Year', p.y) + '</div>';
    return '<div class="tiles t3">' + tile(key, 'd', 'Day', p.d ? String(Number(p.d)) : '') + tile(key, 'm', 'Month', month) + tile(key, 'y', 'Year', p.y) + '</div>';
  }
  function timeTiles(key, v, isTime) {
    var s = typeof v === 'string' ? v : '', own = parts[key] || {};
    var p = isTime ? { h: own.h !== undefined ? own.h : s.slice(0, 2), i: own.i !== undefined ? own.i : s.slice(3, 5) } : dateParts(key, v);
    return '<div class="tiles">' + tile(key, 'h', 'Hour', p.h) + tile(key, 'i', 'Minute', p.i) + '</div>';
  }
  // ---- picking a date or a time: a grid to tap, on a sheet over the page ---------------------------------------------
  var SHEET = { d: ['Day', 'g7'], m: ['Month', 'g3'], y: ['Year', 'g4'], v: ['Year', 'g4'], h: ['Hour', 'g6'], i: ['Minute', 'g4'], o: ['Choose one', 'g1'] };
  var picking = null;
  function sheetOptions(key, part) {
    var c = FIELD[key].control, p = dateParts(key, value(key));
    if (part === 'o') return c.options.map(function (o) { return [esc(o), esc(o)]; });
    if (part === 'm') return MONTHS.map(function (m, i) { return [pad(i + 1), m]; });
    if (part === 'd') {
      var days = p.m ? new Date(Number(p.y) || 2024, Number(p.m), 0).getDate() : 31;
      return range(1, days).map(function (x) { return [pad(x), x]; });
    }
    if (part === 'h') return range(0, 23).map(function (x) { return [pad(x), pad(x)]; });
    if (part === 'i') return range(0, 11).map(function (x) { return [pad(x * 5), pad(x * 5)]; });
    var years = part === 'v' ? range(THIS_YEAR + 1, THIS_YEAR - 45) : c.recent ? range(THIS_YEAR, THIS_YEAR - 2) : range(THIS_YEAR, THIS_YEAR - 60);
    return years.map(function (y) { return [y, y]; });
  }
  function currentPart(key, part) {
    var v = value(key), c = FIELD[key].control;
    if (part === 'v' || part === 'o') return filled(v) ? esc(String(v)) : '';
    if (c.kind === 'time') { var s = typeof v === 'string' ? v : '', own = parts[key] || {}; return part === 'h' ? (own.h !== undefined ? own.h : s.slice(0, 2)) : (own.i !== undefined ? own.i : s.slice(3, 5)); }
    return dateParts(key, v)[part];
  }
  function openSheet(key, part) {
    picking = { key: key, part: part };
    $('sheetTitle').textContent = SHEET[part][0];
    var cur = currentPart(key, part), grid = $('sheetGrid');
    grid.className = 'grid ' + SHEET[part][1];
    grid.innerHTML = sheetOptions(key, part).map(function (o) {
      return '<button type="button" class="cell' + (String(o[0]) === String(cur) ? ' on' : '') + '" data-cell="' + o[0] + '">' + o[1] + '</button>';
    }).join('');
    $('sheet').hidden = false;
    grid.scrollTop = 0;
  }
  function closeSheet() { picking = null; $('sheet').hidden = true; render(); }
  /** The next part still to pick of this date or time, so a whole date takes three taps. */
  function nextPart(key, part) {
    var c = FIELD[key].control;
    var order = part === 'h' || part === 'i' ? ['h', 'i'] : c.kind === 'year' ? [] : c.month ? ['m', 'y'] : ['d', 'm', 'y'];
    for (var i = order.indexOf(part) + 1; i > 0 && i < order.length; i++) if (!currentPart(key, order[i])) return order[i];
    return null;
  }
  function fmtNumber(n) { return Number(n).toLocaleString('en-ZA'); }
  function sliderShown(c, v) { return filled(v) ? fmtNumber(v) + ' ' + c.unit : 'Not set'; }
  function stepCount(f, c) {
    if (value(f.key) !== true) return 0;
    var n = 1;
    while (value(c.group + '.more.' + n) === true) n++;
    return n;
  }
  function stepMax(c) { var n = 1; V.screens.forEach(function (s) { s.fields.forEach(function (x) { if (x.key.indexOf(c.group + '.more.') === 0) n++; }); }); return n; }
  function pillBase(c, v) { var s = filled(v) ? String(v) : ''; return c.detail ? s.split(c.detail.joiner)[0] : s; }
  function isOption(c, s) { return (c.options || []).some(function (o) { return same(o, s); }); }

  function controlHtml(f) {
    var c = f.control, v = value(f.key), k = f.key;
    switch (c.kind) {
      case 'yes-no':
        return '<div class="opts">' + optBtn('data-k="' + q(k) + '" data-b="true"', 'Yes', v === true) + optBtn('data-k="' + q(k) + '" data-b="false"', 'No', v === false) + '</div>';
      case 'pills': {
        // Long sentences don't fit as pills on one screen: they're a list to pick from, on the sheet.
        if (c.options.join('').length > 200 || c.options.some(function (o) { return o.length > 42; })) {
          return '<div class="tiles t1">' + tile(k, 'o', 'Choose one', filled(v) ? String(v) : '') + '</div>';
        }
        var b = pillBase(c, v), other = otherOpen[k] || (filled(b) && !isOption(c, b));
        var html = '<div class="opts' + (c.options.length > 6 ? ' tight' : '') + '">' + c.options.map(function (o) { return optBtn('data-k="' + q(k) + '" data-v="' + esc(o) + '"', o, !other && same(b, o)); }).join('')
          + (c.other ? optBtn('data-other="' + q(k) + '"', 'Other', other) : '') + '</div>';
        if (other) html += box(f, filled(v) ? String(v) : '', { placeholder: 'Please tell us' });
        else if (c.detail && filled(b)) {
          var rest = String(v).split(c.detail.joiner)[1] || '';
          html += '<input class="inp" autocomplete="off" data-detail="' + q(k) + '" placeholder="' + esc(c.detail.placeholder) + '" value="' + esc(rest) + '">';
        }
        return html;
      }
      case 'multi': {
        var picked = filled(v) ? String(v).split(', ') : [];
        var known = picked.filter(function (p) { return isOption(c, p); });
        var more = picked.filter(function (p) { return !isOption(c, p); }).join(', ');
        var on = otherOpen[k] || !!more;
        return '<div class="opts' + (c.options.length > 6 ? ' tight' : '') + '">' + c.options.map(function (o) { return optBtn('data-m="' + q(k) + '" data-v="' + esc(o) + '"', o, known.some(function (p) { return same(p, o); })); }).join('')
          + (c.other ? optBtn('data-other="' + q(k) + '" data-multi="1"', 'Other', on) : '') + '</div>'
          + (on ? '<input class="inp" autocomplete="off" data-mother="' + q(k) + '" placeholder="Please tell us" value="' + esc(more) + '">' : '');
      }
      case 'yes-text': {
        var no = c.no || 'No', isNo = filled(v) && same(v, no), isYes = filled(v) && !isNo, text = isYes && !same(v, 'Yes') ? v : '';
        var then = '';
        if (isYes) then = c.long ? longBox(k, text, 'data-yt="' + q(k) + '"', c.then) : '<input class="inp" autocomplete="off" id="f-' + q(k) + '" data-yt="' + q(k) + '" placeholder="' + esc(c.then) + '" value="' + esc(text) + '">';
        return '<div class="opts">' + optBtn('data-ytb="' + q(k) + '" data-v="yes"', 'Yes', isYes) + optBtn('data-ytb="' + q(k) + '" data-v="no"', 'No', isNo) + '</div>' + then;
      }
      case 'slider':
        return '<div class="range"><div class="rv">' + (c.bare ? '<span class="ql">' + esc(promptOf(f)) + '</span>' : '<label class="ql" for="f-' + q(k) + '">' + esc(promptOf(f)) + '</label>')
          + '<b id="rv-' + q(k) + '"' + (filled(v) ? '' : ' class="unset"') + '>' + esc(sliderShown(c, v)) + '</b></div>'
          + '<input type="range" id="f-' + q(k) + '" data-range="' + q(k) + '" min="' + c.min + '" max="' + c.max + '" step="' + c.step + '" value="' + (filled(v) ? Number(v) : c.min) + '"></div>';
      case 'date': {
        if (!c.recent) return dateTiles(k, c, v);
        var today = daysAgo(0), yest = daysAgo(1), early = earlierOpen[k] || (filled(v) && v !== today && v !== yest);
        return '<div class="opts">' + optBtn('data-day="' + q(k) + '" data-v="' + today + '"', 'Today', !early && v === today) + optBtn('data-day="' + q(k) + '" data-v="' + yest + '"', 'Yesterday', !early && v === yest)
          + optBtn('data-day="' + q(k) + '" data-v="earlier"', 'Earlier', early) + '</div>' + (early ? dateTiles(k, c, v) : '');
      }
      case 'time': return timeTiles(k, v, true);
      case 'datetime': return dateTiles(k, c, v) + timeTiles(k, v, false);
      case 'year':
        return '<div class="tiles">' + tile(k, 'v', 'Year', filled(v) ? String(v) : '') + '</div>';
      case 'stepper': {
        var n = stepCount(f, c);
        return '<div class="step-n"><button type="button" data-step="' + q(k) + '" data-d="-1" aria-label="Fewer">−</button><b>' + n + '</b><button type="button" data-step="' + q(k) + '" data-d="1" aria-label="More">+</button><span class="help">' + esc(n === 0 ? c.none : n === 1 ? c.one : c.many) + '</span></div>';
      }
      case 'amount':
        return '<div class="amt"><span>R</span>' + box(f, v, { mode: 'numeric', placeholder: c.placeholder }) + '</div>';
      case 'number': return box(f, v, { mode: 'decimal', placeholder: f.hint });
      case 'long': return longBox(k, v, 'data-bind="' + q(k) + '"');
      default: return box(f, v, { placeholder: c.placeholder || f.hint });
    }
  }
  function labelHtml(f) {
    var c = f.control;
    if (c.bare || c.kind === 'slider') return '';
    var text = c.kind === 'stepper' ? c.label : promptOf(f);
    var tappable = ['yes-no', 'pills', 'multi', 'yes-text', 'date', 'time', 'datetime', 'year', 'stepper'].indexOf(c.kind) >= 0;
    return tappable ? '<div class="ql">' + esc(text) + '</div>' : '<label class="ql" for="f-' + q(f.key) + '">' + esc(text) + '</label>';
  }
  function fieldHtml(f) {
    return '<div class="q" data-q="' + q(f.key) + '">' + labelHtml(f) + controlHtml(f) + (errors[f.key] ? '<div class="err" role="alert">' + esc(errors[f.key]) + '</div>' : '') + '</div>';
  }
  // ---- a step shows what fits ---------------------------------------------------------------------------------------
  function err(k) { return errors[k] ? '<div class="err" role="alert">' + esc(errors[k]) + '</div>' : ''; }
  /** What can't be split across steps: one question, or two half-width boxes that share a row. */
  function blocksOf(fields) {
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], g = fields[i + 1];
      if (f.control.half && g && g.control.half && f.entry === g.entry) { out.push({ key: f.key, fields: [f, g], entry: f.entry || null }); i++; }
      else out.push({ key: f.key, fields: [f], entry: f.entry || null });
    }
    return out;
  }
  function visibleBlocks(step) {
    if (step.id === 'photos') {
      return V.evidence.filter(shows).map(function (e) { return { key: e.key, ev: e }; })
        .concat([{ key: '__other', ev: { key: '', prompt: 'Anything else that may help', kind: 'photo', count: extra } }]);
    }
    return blocksOf(V.screens[step.i].fields.filter(function (f) { return shows(f) && !f.hidden; }));
  }
  function blockHtml(b) {
    if (b.fields.length === 1) return fieldHtml(b.fields[0]);
    return '<div class="q" data-q="' + q(b.key) + '">' + labelHtml(b.fields[0]) + '<div class="row2">' + controlHtml(b.fields[0]) + controlHtml(b.fields[1]) + '</div>' + err(b.fields[0].key) + err(b.fields[1].key) + '</div>';
  }
  function stepHtml(step, blocks) {
    if (step.id === 'photos') {
      return '<div class="ups">' + blocks.map(function (b) { return upHtml(b.ev.key, b.ev.prompt, b.ev.kind, b.ev.key ? b.ev.count : extra); }).join('') + '</div>' + err('photos');
    }
    var s = V.screens[step.i], html = s.help ? '<p class="help">' + esc(s.help) + '</p>' : '', entry = null, run = '';
    function flush() {
      if (!run) return;
      html += entry ? '<div class="sub"><div class="sh">' + esc(entry) + '</div>' + run + '</div>' : run;
      run = '';
    }
    blocks.forEach(function (b) {
      if (b.entry !== entry) { flush(); entry = b.entry; }
      run += blockHtml(b);
    });
    flush();
    return html;
  }
  function typing() { var a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }
  function overflows(body) { return body.scrollHeight > pageH + 1; }
  /** Puts as many of the blocks on the page as fit, and says how many. One that can't fit alone still shows, and scrolls. */
  function fit(step, blocks) {
    var body = $('body'), n = blocks.length;
    body.innerHTML = stepHtml(step, blocks);
    if (!overflows(body)) return n;
    var limit = body.getBoundingClientRect().top + pageH, els = body.querySelectorAll('[data-q]');
    for (var i = 0; i < els.length; i++) if (els[i].getBoundingClientRect().bottom > limit) { n = Math.max(1, i); break; }
    body.innerHTML = stepHtml(step, blocks.slice(0, n));
    while (n > 1 && overflows(body)) { n--; body.innerHTML = stepHtml(step, blocks.slice(0, n)); }
    return n;
  }
  /** Where each page of a step starts, up to (not including) the page that starts at stopKey. */
  function pageStarts(step, stopKey) {
    var all = visibleBlocks(step), starts = [], start = 0, stop = -1;
    all.forEach(function (b, i) { if (b.key === stopKey) stop = i; });
    while (start < all.length && !(stop >= 0 && start >= stop)) {
      starts.push(all[start].key);
      start += fit(step, all.slice(start));
    }
    return starts;
  }
  function helloHtml() {
    return '<h1>Fill out this form to submit your claim as fast as possible.</h1><p class="help">If you don\'t know something, just leave it blank.</p>';
  }
  function detailsHtml() {
    return '<p class="help">Tap anything that\'s out of date to change it.</p><div class="card">'
      + V.details.map(function (d) {
        var v = d.key in draft ? draft[d.key] : d.value;
        if (!d.editable) return '<div class="kv fixed"><span>' + esc(d.label) + '</span><b>' + esc(v) + '</b></div>';
        if (!editing[d.key]) return '<button type="button" class="kv" data-edit="' + q(d.key) + '"><span>' + esc(d.label) + '</span><b>' + (esc(v) || 'Add') + '</b></button>';
        var type = /cellphone|number$/i.test(d.label) && !/policy/i.test(d.label) ? 'tel' : /email/i.test(d.label) ? 'email' : 'text';
        return '<div class="q" style="padding:10px 0"><label class="ql" for="f-' + q(d.key) + '">' + esc(d.label) + '</label><input class="inp" type="' + type + '" autocomplete="off" id="f-' + q(d.key) + '" data-bind="' + q(d.key) + '" value="' + esc(v) + '">' + err(d.key) + '</div>';
      }).join('') + '</div>';
  }
  function upHtml(key, label, kind, count) {
    var accept = kind === 'video' ? 'video/*' : 'image/*,application/pdf';
    var id = 'up-' + (key || 'other');
    var th = (thumbs[key] || []).map(function (u) { return '<img src="' + u + '" alt="">'; }).join('');
    return '<div class="up" data-q="' + q(id) + '"><div class="ic' + (count ? ' ok' : '') + '">' + (count ? ICON_OK : ICON_CAM) + '</div><div><b>' + esc(label) + '</b><small id="st-' + q(id) + '">' + (count ? count + ' added' : 'Not added yet') + '</small></div>'
      + '<label class="addb" for="' + q(id) + '">Add</label><input class="sr" type="file" id="' + q(id) + '" data-up="' + q(key) + '" accept="' + accept + '" multiple>'
      + (th ? '<div class="thumbs">' + th + '</div>' : '') + '</div>';
  }
  function shown(f, v) {
    var c = f.control;
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    if (c.kind === 'slider') return fmtNumber(v) + ' ' + c.unit;
    if (c.kind === 'amount') return 'R ' + fmtNumber(v);
    if (c.kind === 'date' || c.kind === 'datetime') {
      var s = String(v), m = MONTHS[Number(s.slice(5, 7)) - 1];
      if (!m) return s;
      return (s.length >= 10 ? Number(s.slice(8, 10)) + ' ' : '') + m + ' ' + s.slice(0, 4) + (s.length > 10 ? ' at ' + s.slice(11, 16) : '');
    }
    return String(v);
  }
  /** The summary: the one step that may scroll. */
  function reviewHtml() {
    var html = '<p class="help">Tap Change to fix anything. Next, Tina sends your form to sign on WhatsApp.</p>';
    visibleScreens().forEach(function (i) {
      var s = V.screens[i], rows = '';
      s.fields.forEach(function (f) {
        if (!shows(f) || f.hidden) return;
        var v = A[f.key], has = filled(v), step = f.control.kind === 'stepper';
        var text = step ? String(stepCount(f, f.control)) : has ? esc(shown(f, v)) : 'Left blank';
        rows += '<div class="row"><div class="rl">' + (f.entry ? esc(f.entry) + ': ' : '') + esc(step ? f.control.label : promptOf(f)) + '</div><div class="rv2' + (has || step ? '' : ' empty') + '">' + text + '</div></div>';
      });
      html += '<div class="q"><div class="head"><div class="ql">' + esc(s.title) + '</div><button type="button" class="link" data-go="' + i + '">Change</button></div><div class="card">' + rows + '</div></div>';
    });
    var count = V.evidence.reduce(function (n, e) { return n + (shows(e) ? e.count : 0); }, 0) + extra;
    html += '<div class="q"><div class="head"><div class="ql">Photos and documents</div><button type="button" class="link" data-go="photos">Change</button></div><div class="card"><div class="kv fixed"><span>Added</span><b>' + count + '</b></div></div></div>';
    return html + err('submit');
  }

  function render() {
    var body = $('body');
    var steps = route(), i = stepIndex(steps), step = steps[i], anchor = here && here.anchor;
    here = { id: step.id, i: step.i, anchor: anchor };
    $('sec').textContent = step.id === 'hello' ? '' : step.id === 'details' ? 'Are these details still right?' : step.id === 'photos' ? 'Add your photos and documents' : step.id === 'review' ? 'Check your claim' : V.screens[step.i].title;
    $('sec').hidden = step.id === 'hello';
    $('back').hidden = i === 0;
    // The height to fit is the page without the phone's keyboard open.
    if (!typing() || !pageH) { body.innerHTML = ''; pageH = body.clientHeight; }
    var part = 0;
    page = []; morePages = false;
    if (step.id === 'screen' || step.id === 'photos') {
      var all = visibleBlocks(step), from = 0;
      all.forEach(function (b, x) { if (b.key === anchor) from = x; });
      var rest = all.slice(from), n = fit(step, rest);
      page = rest.slice(0, n);
      morePages = n < rest.length;
      part = all.length ? from / all.length : 0;
    } else body.innerHTML = step.id === 'hello' ? helloHtml() : step.id === 'review' ? reviewHtml() : detailsHtml();
    body.scrollTop = 0;
    $('prog').style.width = Math.round((i + part) / Math.max(1, steps.length - 1) * 100) + '%';
    $('next').textContent = step.id === 'hello' ? 'Start' : step.id === 'details' ? 'All correct' : step.id === 'review' ? 'Submit claim' : 'Continue';
    $('next').disabled = busy;
  }

  // ---- saving: a blank says "I don't know" -------------------------------------------------------------------------
  function collect(blocks) {
    var answers = [], notKnown = [], cleared = [];
    blocks.forEach(function (b) {
      b.fields.forEach(function (f) {
        var v = value(f.key);
        if (f.control.kind === 'stepper') {
          // Passing the count with nobody added says there was nobody. "Is there another?" goes with it.
          if (!filled(v)) v = false;
          Object.keys(draft).forEach(function (k) {
            if (k.indexOf(f.control.group + '.more.') !== 0) return;
            if (filled(draft[k])) answers.push({ key: k, value: draft[k] });
            else if (A[k] !== undefined) cleared.push(k);
          });
        }
        if (filled(v)) {
          if (v !== A[f.key] || NK[f.key]) answers.push({ key: f.key, value: v });
          return;
        }
        if (A[f.key] !== undefined) cleared.push(f.key);
        if (!NK[f.key] || A[f.key] !== undefined) notKnown.push(f.key);
      });
    });
    return { answers: answers, notKnown: notKnown, cleared: cleared };
  }
  function applySaved(r, keys) {
    A = r.answers; NK = {};
    r.notKnown.forEach(function (k) { NK[k] = true; });
    (keys || []).forEach(function (k) { delete draft[k]; });
  }
  function alertBar(text) {
    var b = $('body'), el = document.createElement('div');
    el.className = 'err'; el.setAttribute('role', 'alert'); el.textContent = text;
    b.insertBefore(el, b.firstChild); b.scrollTop = 0;
  }
  function save(body, done) {
    busy = true; $('next').disabled = true;
    body.checked = Object.keys(checked);
    var keys = (body.answers || []).map(function (a) { return a.key; }).concat(body.notKnown || [], body.cleared || []);
    post('/answers', body).then(function (r) {
      busy = false;
      errors = {};
      if (r.problems && r.problems.length) {
        r.problems.forEach(function (p) { errors[p.key] = p.text; checked[p.key] = true; });
        applySaved(r);
        render();
        return;
      }
      applySaved(r, keys);
      done(r);
    }).catch(function (e) {
      busy = false;
      if (e.message === 'gone') return;
      alertBar('No connection. Your answers aren\'t saved yet. Please try again.');
      $('next').disabled = false;
    });
  }
  function move(by) {
    var steps = route(), i = stepIndex(steps), t = steps[Math.max(0, Math.min(steps.length - 1, i + by))];
    here = { id: t.id, i: t.i, anchor: null };
    errors = {};
    // Going back lands on the last page of that step.
    if (by < 0 && (t.id === 'screen' || t.id === 'photos')) here.anchor = pageStarts(t).pop() || null;
    render();
  }
  function back() {
    if (busy || rec) return;
    if ((here.id === 'screen' || here.id === 'photos') && here.anchor) {
      var earlier = pageStarts(here, here.anchor);
      if (earlier.length) { here.anchor = earlier.pop(); errors = {}; return render(); }
    }
    move(-1);
  }
  /** On from the page that ended at lastKey: the rest of this step, or the next step. */
  function advance(lastKey) {
    var all = visibleBlocks(here), at = -1;
    all.forEach(function (b, i) { if (b.key === lastKey) at = i; });
    if (at >= 0 && at + 1 < all.length) { here.anchor = all[at + 1].key; errors = {}; return render(); }
    // The question it ended at has gone (the SAPS case number, now on the claim): what the answers opened comes next.
    if (at < 0 && here.id === 'screen') {
      var open = all.filter(function (b) { return b.fields.some(function (f) { return A[f.key] === undefined && !NK[f.key]; }); })[0];
      if (open) { here.anchor = open.key; errors = {}; return render(); }
    }
    move(1);
  }
  // An answer can open a question only the server knows about: a SAPS case number means the police were involved, which
  // the form's conditions read from the claim. When one is open that the page doesn't hold, it reads the form again.
  function holdsKey(key) { return V.screens.some(function (s) { return s.fields.some(function (f) { return f.key === key; }); }); }
  function adopt(s) {
    // Answers can add or drop a topic, so the step is found again by what it is, not where it was.
    var at = here && here.id === 'screen' && V.screens[here.i] ? V.screens[here.i].id : null;
    if (at !== null) {
      var moved = -1;
      s.screens.forEach(function (x, i) { if (x.id === at) moved = i; });
      if (moved >= 0) here.i = moved; else here = { id: 'photos', anchor: null };
    }
    V.screens = s.screens; V.evidence = s.evidence; A = s.answers; NK = {}; FIELD = {};
    s.notKnown.forEach(function (k) { NK[k] = true; });
    s.screens.forEach(function (x) { x.fields.forEach(function (f) { FIELD[f.key] = f; if (f.prefill !== undefined) PRE[f.key] = f.prefill; }); });
  }
  function freshen(open, then) {
    if (!open || open.every(holdsKey)) return then();
    busy = true;
    api('/state').then(function (s) { busy = false; adopt(s); then(); }).catch(function () { busy = false; then(); });
  }
  /** The page a question is on: it starts at that question, so the client lands right on it. */
  function anchorFor(i, test) {
    var hit = null;
    blocksOf(V.screens[i].fields.filter(function (f) { return shows(f) && !f.hidden; })).forEach(function (b) { if (!hit && b.fields.some(test)) hit = b.key; });
    return hit;
  }
  function next() {
    if (busy) return;
    var step = here;
    if (step.id === 'hello') return move(1);
    if (step.id === 'details') {
      var answers = V.details.filter(function (d) { return d.editable && d.key in draft && String(draft[d.key]).trim() !== d.value; }).map(function (d) { return { key: d.key, value: draft[d.key] }; });
      var changed = {};
      answers.forEach(function (a) { changed[a.key] = a.value; });
      return save({ answers: answers, detailsConfirmed: true }, function () {
        V.details.forEach(function (d) { if (d.key in changed) d.value = changed[d.key]; delete draft[d.key]; });
        V.detailsConfirmed = true;
        editing = {};
        move(1);
      });
    }
    var last = page.length ? page[page.length - 1].key : null;
    if (step.id === 'review') return submit();
    if (step.id === 'photos') return morePages ? advance(last) : move(1);
    var c = collect(page);
    if (!c.answers.length && !c.notKnown.length && !c.cleared.length) return advance(last);
    save({ answers: c.answers, notKnown: c.notKnown, cleared: c.cleared }, function (r) {
      freshen(r.open, function () { advance(last); });
    });
  }
  function submit() {
    busy = true; $('next').disabled = true; $('next').textContent = 'Submitting…';
    post('/submit').then(function (r) {
      busy = false;
      if (r.open && r.open.length) {
        freshen(r.open, function () {
          var target = null;
          V.screens.forEach(function (s, i) { if (target === null && s.fields.some(function (f) { return shows(f) && !f.hidden && r.open.indexOf(f.key) >= 0; })) target = i; });
          if (target === null) return location.reload();
          here = { id: 'screen', i: target, anchor: anchorFor(target, function (f) { return r.open.indexOf(f.key) >= 0; }) };
          errors = {};
          render();
        });
        return;
      }
      location.reload();
    }).catch(function (e) {
      busy = false;
      if (e.message === 'gone') return;
      errors = { submit: (e.body && e.body.message) || 'No connection. Please try again.' };
      render();
    });
  }

  // ---- voice: only for the client's own words ----------------------------------------------------------------------
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var rec = null, recKey = null, recParts = [], recTimer = null, micStarting = false;
  function micNote(key, text) { var n = $('note-' + key); if (n) { n.textContent = text; n.hidden = !text; } }
  function mime() {
    var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  function micBtn(key) { return document.querySelector('[data-mic="' + key.replace(/"/g, '') + '"]') || document.createElement('button'); }
  function mic(key) {
    if (rec) { if (recKey === key) rec.stop(); return; }
    if (micStarting) return;
    micStarting = true;
    micNote(key, 'Starting the microphone…');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micStarting = false;
      var type = mime();
      rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      recKey = key; recParts = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recParts.push(e.data); };
      rec.onstop = function () {
        clearTimeout(recTimer);
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(recParts, { type: rec.mimeType || type || 'audio/webm' }), k = recKey;
        rec = null; recKey = null;
        var btn = micBtn(k);
        btn.classList.remove('rec'); btn.innerHTML = ICON_MIC; btn.disabled = true; btn.setAttribute('aria-label', 'Record your answer');
        micNote(k, 'Listening to that…');
        fetch(base + '/voice?key=' + encodeURIComponent(k), { method: 'POST', headers: { 'Content-Type': (blob.type || 'audio/webm').split(';')[0] }, body: blob })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            micBtn(k).disabled = false;
            if (j.text) {
              var input = $('f-' + k), before = input ? input.value.trim() : '';
              var text = before ? before + ' ' + j.text : j.text;
              draft[k] = text; if (input) input.value = text;
              micNote(k, 'Please check what I heard. You can change it.');
            } else micNote(k, j.message || 'I couldn\'t make that out. Please try again, or type your answer.');
          })
          .catch(function () { micBtn(k).disabled = false; micNote(k, 'No connection. Please try again, or type your answer.'); });
      };
      rec.start();
      var btn = micBtn(key);
      btn.classList.add('rec'); btn.innerHTML = ICON_STOP; btn.setAttribute('aria-label', 'Stop recording');
      micNote(key, 'Recording… tap again to stop.');
      recTimer = setTimeout(function () { if (rec) rec.stop(); }, 180000);
    }).catch(function () { micStarting = false; micNote(key, 'The microphone isn\'t available. Please type your answer.'); });
  }

  // ---- photos ------------------------------------------------------------------------------------------------------
  function upload(input) {
    var key = input.dataset.up, files = [].slice.call(input.files || []), st = $('st-' + input.id);
    if (!files.length) return;
    var i = 0;
    busy = true; $('next').disabled = true;
    function one() {
      if (i >= files.length) { busy = false; render(); return; }
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
        .catch(function () { errors.photos = 'No connection. Please try again.'; busy = false; render(); });
    }
    one();
  }

  // ---- taps and typing ---------------------------------------------------------------------------------------------
  function setCount(f, c, n) {
    var max = stepMax(c);
    n = Math.max(0, Math.min(max, n));
    draft[f.key] = n > 0;
    for (var k = 1; k < max; k++) draft[c.group + '.more.' + k] = k < n ? true : k === n ? false : '';
  }
  function joinMulti(key, c) {
    var el = document.querySelector('[data-mother="' + key.replace(/"/g, '') + '"]');
    return el ? el.value.trim() : '';
  }
  function pickChanged(key, part, val) {
    var f = FIELD[key], c = f.control;
    var p = parts[key] || {};
    p[part] = val; parts[key] = p;
    var v = value(key);
    if (c.kind === 'time') {
      var s0 = typeof v === 'string' ? v : '';
      var h = p.h !== undefined ? p.h : s0.slice(0, 2), mi = p.i !== undefined ? p.i : s0.slice(3, 5);
      draft[key] = h && mi ? h + ':' + mi : '';
      return;
    }
    var d = dateParts(key, v);
    if (c.month) { draft[key] = d.y && d.m ? d.y + '-' + d.m : ''; return; }
    if (d.y && d.m && d.d) {
      // There's no 31 February: the day is brought back to the end of the month.
      var last = new Date(Number(d.y), Number(d.m), 0).getDate();
      if (Number(d.d) > last) { d.d = pad(last); p.d = d.d; }
      var date = d.y + '-' + d.m + '-' + d.d;
      draft[key] = c.kind === 'datetime' && d.h && d.i ? date + ' ' + d.h + ':' + d.i : date;
    } else draft[key] = '';
  }
  $('body').addEventListener('click', function (e) {
    var o = e.target.closest('[data-k]');
    if (o) {
      var k = o.dataset.k, v = o.dataset.b !== undefined ? o.dataset.b === 'true' : o.dataset.v;
      // Tapping it again takes it back: a blank says "I don't know".
      var cur = FIELD[k] && FIELD[k].control.kind === 'pills' ? pillBase(FIELD[k].control, value(k)) : value(k);
      draft[k] = filled(cur) && sameStrict(typeof v === 'string' ? String(cur) : cur, v) ? '' : v;
      delete otherOpen[k]; delete errors[k];
      return render();
    }
    var other = e.target.closest('[data-other]');
    if (other) {
      var ok = other.dataset.other, f = FIELD[ok];
      var open = !(otherOpen[ok] || (f.control.kind === 'pills' && filled(pillBase(f.control, value(ok))) && !isOption(f.control, pillBase(f.control, value(ok)))));
      otherOpen[ok] = open;
      if (f.control.kind === 'pills') draft[ok] = '';
      else if (!open) draft[ok] = (filled(value(ok)) ? String(value(ok)).split(', ') : []).filter(function (p) { return isOption(f.control, p); }).join(', ');
      return render();
    }
    var m = e.target.closest('[data-m]');
    if (m) {
      var mk = m.dataset.m, mf = FIELD[mk], list = filled(value(mk)) ? String(value(mk)).split(', ') : [], opt = m.dataset.v;
      var has = list.some(function (p) { return same(p, opt); });
      draft[mk] = (has ? list.filter(function (p) { return !same(p, opt); }) : list.concat(opt)).join(', ');
      if (mf) delete errors[mk];
      return render();
    }
    var yt = e.target.closest('[data-ytb]');
    if (yt) {
      var yk = yt.dataset.ytb, yc = FIELD[yk].control, no = yc.no || 'No', now = value(yk), isNo = filled(now) && same(now, no), isYes = filled(now) && !isNo;
      draft[yk] = yt.dataset.v === 'no' ? (isNo ? '' : no) : (isYes ? '' : 'Yes');
      return render();
    }
    var dy = e.target.closest('[data-day]');
    if (dy) {
      var dk = dy.dataset.day, dv = dy.dataset.v;
      if (dv === 'earlier') { earlierOpen[dk] = !earlierOpen[dk]; draft[dk] = ''; delete parts[dk]; }
      else { delete earlierOpen[dk]; delete parts[dk]; draft[dk] = value(dk) === dv ? '' : dv; }
      return render();
    }
    var st = e.target.closest('[data-step]');
    if (st) {
      var sf = FIELD[st.dataset.step];
      setCount(sf, sf.control, stepCount(sf, sf.control) + Number(st.dataset.d));
      return render();
    }
    var mc = e.target.closest('[data-mic]');
    if (mc) { mic(mc.dataset.mic); return; }
    var t = e.target.closest('[data-tile]');
    if (t) return openSheet(t.dataset.tile, t.dataset.part);
    var g = e.target.closest('[data-go]');
    if (g) { here = g.dataset.go === 'photos' ? { id: 'photos', anchor: null } : { id: 'screen', i: Number(g.dataset.go), anchor: null }; errors = {}; return render(); }
    var ed = e.target.closest('[data-edit]');
    if (ed) {
      editing[ed.dataset.edit] = true;
      render();
      var input = $('f-' + ed.dataset.edit);
      if (input) input.focus();
    }
  });
  $('body').addEventListener('input', function (e) {
    var t = e.target, d = t.dataset;
    if (d.bind) {
      draft[d.bind] = t.value;
      if (errors[d.bind]) { delete errors[d.bind]; var q0 = t.closest('.q'), er = q0 && q0.querySelector('.err'); if (er) er.remove(); }
      if (checked[d.bind]) delete checked[d.bind];
    } else if (d.detail) {
      var c = FIELD[d.detail].control, b = pillBase(c, value(d.detail));
      draft[d.detail] = t.value.trim() ? b + c.detail.joiner + t.value : b;
    } else if (d.mother) {
      var mc2 = FIELD[d.mother].control, cur = filled(value(d.mother)) ? String(value(d.mother)).split(', ').filter(function (p) { return isOption(mc2, p); }) : [];
      if (t.value.trim()) cur = cur.concat(t.value.trim());
      draft[d.mother] = cur.join(', ');
    } else if (d.yt) {
      draft[d.yt] = t.value.trim() ? t.value : 'Yes';
    } else if (d.range) {
      var f = FIELD[d.range];
      draft[d.range] = Number(t.value);
      var rv = $('rv-' + d.range); if (rv) { rv.textContent = sliderShown(f.control, draft[d.range]); rv.className = ''; }
    }
  });
  $('body').addEventListener('change', function (e) {
    var d = e.target.dataset;
    if (!d) return;
    if (d.up !== undefined) return upload(e.target);
  });
  $('sheet').addEventListener('click', function (e) {
    if (e.target.closest('[data-sheet-close]')) return closeSheet();
    var cell = e.target.closest('[data-cell]');
    if (!cell || !picking) return;
    var key = picking.key, part = picking.part, val = cell.dataset.cell;
    if (part === 'v') draft[key] = Number(val);
    else if (part === 'o') draft[key] = val;
    else pickChanged(key, part, val);
    var then = nextPart(key, part);
    return then ? openSheet(key, then) : closeSheet();
  });
  $('next').addEventListener('click', next);
  $('back').addEventListener('click', back);
  // Turning the phone changes what fits. The keyboard opening doesn't: typing never moves a question to another step.
  window.addEventListener('resize', function () { if (V && !typing()) render(); });

  // ---- open --------------------------------------------------------------------------------------------------------
  api('/state').then(function (s) {
    V = s;
    adopt(s);
    if ($('brandTitle')) $('brandTitle').textContent = s.title;
    if (!s.detailsConfirmed) here = { id: 'hello' };
    else {
      here = s.startAt >= s.screens.length ? { id: 'photos' } : { id: 'screen', i: s.startAt, anchor: anchorFor(s.startAt, function (f) { return A[f.key] === undefined && !NK[f.key]; }) };
      if (!route().some(function (x) { return sameStep(x, here); })) here = { id: 'photos' };
    }
    $('app').hidden = false; $('loading').hidden = true;
    render();
  }).catch(function (e) {
    if (e.message === 'gone') return;
    $('loading').textContent = 'The form could not be loaded. Please check your connection and refresh the page.';
  });
})();
`;

/** The page for a link that works. */
export function claimFormPage(): string {
    return `${HEAD('Your claim form')}<body>
<p class="center help" id="loading">Loading your form…</p>
<div class="app" id="app" hidden>
  ${BRAND()}
  <div class="top">
    <div class="prog"><i id="prog"></i></div>
    <div class="sec" id="sec"></div>
  </div>
  <main class="body" id="body"></main>
  <div class="foot"><button type="button" id="back">Back</button><button type="button" class="go" id="next">Start</button></div>
  <div class="sheet" id="sheet" hidden>
    <div class="scrim" data-sheet-close></div>
    <div class="panel" role="dialog" aria-labelledby="sheetTitle">
      <div class="panel-head"><span id="sheetTitle"></span><button type="button" data-sheet-close aria-label="Close">✕</button></div>
      <div class="grid" id="sheetGrid"></div>
    </div>
  </div>
</div>
<script>${SCRIPT}</script>
</body></html>`;
}

const REFUSED: Record<LinkRefusal, { title: string; text: string; ok?: boolean }> = {
    'not-found': { title: 'This link does not work', text: 'Please check you opened the whole link, or ask Tina for a new one on WhatsApp.' },
    expired: { title: 'This link has expired', text: 'Links work for 7 days. Reply to Tina on WhatsApp and she will help you carry on.' },
    done: { title: 'Claim submitted', text: 'Thank you, we have your answers. Tina will message you on WhatsApp with anything still needed and your form to sign.', ok: true },
    superseded: { title: 'There is a newer link', text: 'Please open the latest link Tina sent you.' },
};

/** The page for a link that's done with, or doesn't work. `whatsApp`: Tina's number, for the way back. */
export function refusedPage(reason: LinkRefusal, whatsApp?: string | null): string {
    const r = REFUSED[reason];
    const back = whatsApp ? `<div class="foot"><a class="go" href="https://wa.me/${esc(whatsApp.replace(/\D/g, ''))}">Back to WhatsApp</a></div>` : '';
    const icon = r.ok ? '<div class="done-ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div>' : '';
    return `${HEAD(r.title)}<body><div class="app">${BRAND()}<main class="body"><div class="center">${icon}<h1>${esc(r.title)}</h1><p class="help">${esc(r.text)}</p></div></main>${back}</div></body></html>`;
}
