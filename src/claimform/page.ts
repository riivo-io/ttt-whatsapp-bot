/**
 * TTTFG-5562: the guided claim form's page. One self-contained page, phone first: one topic per screen, known details filled
 * in, and tapping wherever it can be tapped: options, sliders, dates and times to pick. A box only where the client has to
 * give a name or a number, and a recording only for their own words. A blank is an answer: it says they don't know. A step
 * doesn't scroll: the page measures the phone's screen and shows the questions that fit, and the rest are the next step. Only
 * the summary and a count of people's cards may scroll. It never waits: a step moves on at the tap, and the answers save behind
 * it, in order, trying again until they're in. The
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
.req { display:inline-block; margin-left:6px; padding:1px 8px; border-radius:99px; background:var(--warn-soft); color:var(--warn); font:600 11px/1.6 var(--sans); vertical-align:1px; white-space:nowrap; }
.up.need { border-color:#E2BC85; background:#FFFBF4; }
.up-acts { display:grid; gap:6px; justify-items:stretch; }
.up-acts .addb { justify-content:center; }
.addb.draw { background:var(--accent); border-color:var(--accent); color:#fff; }
.thumb { position:relative; width:58px; height:58px; border-radius:8px; overflow:hidden; border:1px solid var(--line); background:var(--panel); display:grid; place-items:center; font-size:10.5px; color:var(--muted); padding:0; }
.thumb img { width:100%; height:100%; object-fit:cover; display:block; border:0; border-radius:0; }
.thumb .cover { position:absolute; inset:0; display:grid; place-items:center; background:rgba(11,15,20,.42); }
.thumb.fail .cover { background:rgba(180,72,60,.85); color:#fff; font-size:11px; font-weight:500; }
.spin { width:22px; height:22px; border-radius:50%; border:2.5px solid rgba(255,255,255,.4); border-top-color:#fff; animation:spin .7s linear infinite; }
.spin.dark { border-color:var(--line-strong); border-top-color:var(--accent); width:14px; height:14px; border-width:2px; display:inline-block; vertical-align:-2px; margin-right:6px; }
.foot .spin { width:15px; height:15px; border-width:2px; display:inline-block; vertical-align:-2px; margin-right:8px; }
@keyframes spin { to { transform:rotate(360deg); } }
.notice { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:8px 18px; background:var(--warn-soft); color:var(--warn); font-size:13px; line-height:1.35; }
.notice button { flex:none; border:none; background:none; color:var(--accent-deep); font-weight:500; font-size:13px; cursor:pointer; padding:4px 0 4px 8px; }
.need-box { border:1px solid #E2BC85; background:#FFFBF4; border-radius:12px; padding:10px 14px; display:grid; gap:4px; font-size:13.5px; color:var(--text); }
.need-box b { color:var(--warn); font-weight:600; }
.need-box ul { margin:0; padding-left:18px; }
.panel.auto { grid-template-rows:auto auto auto; max-height:88%; }
.terms { display:grid; gap:10px; font-size:14.5px; color:var(--text); line-height:1.45; }
.terms p { margin:0; }
.panel .go { width:100%; min-height:48px; border-radius:12px; border:1px solid var(--accent); background:var(--accent); color:#fff; font-weight:500; font-size:15px; cursor:pointer; }
.wlabels { display:flex; gap:4px; font:500 10.5px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--muted); text-align:center; }
.wlabels span { flex:1; }
.wheels { position:relative; display:flex; gap:4px; height:200px; }
.wband { position:absolute; left:0; right:0; top:80px; height:40px; border-radius:10px; background:var(--accent-soft); pointer-events:none; }
.wheel { position:relative; flex:1; min-width:0; height:200px; overflow-y:scroll; scroll-snap-type:y mandatory; -webkit-overflow-scrolling:touch; scrollbar-width:none; overscroll-behavior:contain; -webkit-mask-image:linear-gradient(transparent,#000 32%,#000 68%,transparent); mask-image:linear-gradient(transparent,#000 32%,#000 68%,transparent); }
.wheel::-webkit-scrollbar { display:none; }
.wpad { height:80px; }
.wi { display:block; width:100%; height:40px; border:0; background:none; padding:0; font-size:19px; color:var(--muted); scroll-snap-align:center; font-variant-numeric:tabular-nums; cursor:pointer; }
.wi.on { color:var(--accent-deep); font-weight:500; }
.wfoot { display:grid; grid-template-columns:1fr 2.2fr; gap:10px; }
.wfoot button { min-height:48px; border-radius:12px; font-weight:500; font-size:15px; cursor:pointer; border:1px solid var(--line-strong); background:var(--bg); color:var(--ink); }
.wfoot .go { border-color:var(--accent); background:var(--accent); color:#fff; }
.panel.full { height:100%; max-height:100%; border-radius:0; grid-template-rows:auto auto minmax(0,1fr); padding-top:calc(14px + env(safe-area-inset-top,0px)); animation:none; }
.list { overflow-y:auto; -webkit-overflow-scrolling:touch; padding-bottom:45vh; }
.li { display:block; width:100%; text-align:left; min-height:48px; padding:12px 4px; border:0; border-bottom:1px solid var(--line); background:none; font-size:16px; color:var(--ink); cursor:pointer; }
.li.use { color:var(--accent-deep); font-weight:500; }
.draw-area { position:relative; min-height:0; }
.draw-area canvas { position:absolute; inset:0; width:100%; height:100%; touch-action:none; background:#fff; border:1px solid var(--line-strong); border-radius:12px; }
.draw-hint { position:absolute; inset:0; display:grid; place-items:center; padding:24px; text-align:center; color:var(--faint); font-size:14px; pointer-events:none; }
.panel.drawing { grid-template-rows:auto minmax(0,1fr) auto; }
.draw-foot { display:grid; grid-template-columns:1fr 1fr 2fr; gap:8px; }
.draw-foot button { min-height:46px; border-radius:12px; font-weight:500; font-size:14px; cursor:pointer; border:1px solid var(--line-strong); background:var(--bg); color:var(--ink); }
.draw-foot .go { border-color:var(--accent); background:var(--accent); color:#fff; }
.draw-foot button:disabled { opacity:.45; }
textarea.live { background:var(--accent-soft); }
.sk { height:14px; border-radius:6px; background:linear-gradient(90deg,var(--panel),#E9ECEF,var(--panel)); background-size:200% 100%; animation:shim 1.1s linear infinite; }
.sk.tall { height:44px; border-radius:10px; }
@keyframes shim { from { background-position:200% 0; } to { background-position:-200% 0; } }
@media (prefers-reduced-motion:reduce) { * { animation:none !important; transition:none !important; } }
`;

// The font never holds up the first paint: the page shows in the phone's own font until it's in.
const FONTS = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" media="print" onload="this.media=\'all\'" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap">';
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

  var V = null, A = {}, NK = {}, here = null, draft = {}, errors = {}, checked = {}, busy = false, extra = 0;
  /** Which "Other" box is open, which "Earlier" date picker is open. */
  var otherOpen = {}, earlierOpen = {}, FIELD = {}, PRE = {}, editing = {};
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
    // A case number says the police were involved, before anyone asks.
    if (c.key === 'saps' && filled(value('sapsCaseNumber'))) v = true;
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
    var steps = [{ id: 'details' }];
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
  function tile(key, label, text, attrs) {
    return '<button type="button" class="tile' + (text ? ' on' : '') + '" ' + attrs + '><small>' + esc(label) + '</small><b>' + esc(text || 'Select') + '</b></button>';
  }
  function whenText(c, v) {
    if (!filled(v)) return '';
    if (c.kind === 'year' || c.kind === 'time') return String(v);
    var s = String(v), m = MONTHS[Number(s.slice(5, 7)) - 1];
    if (!m) return s;
    return (s.length >= 10 ? Number(s.slice(8, 10)) + ' ' : '') + m + ' ' + s.slice(0, 4) + (s.length > 10 ? ', ' + s.slice(11, 16) : '');
  }
  function whenLabel(c) { return c.kind === 'time' ? 'Time' : c.kind === 'datetime' ? 'Date and time' : c.kind === 'year' ? 'Year' : c.month ? 'Month' : 'Date'; }
  function whenTile(key, c, v) { return '<div class="tiles t1">' + tile(key, whenLabel(c), whenText(c, v), 'data-wheel="' + q(key) + '"') + '</div>'; }

  // ---- picking a date or a time: wheels to spin, one sheet for the lot ------------------------------------------------
  var ROW = 40, wheel = null, wheelTimer = null;
  function wheelCols(c) {
    if (c.kind === 'time') return ['h', 'i'];
    if (c.kind === 'datetime') return ['m', 'd', 'h', 'i'];
    if (c.kind === 'year') return ['y'];
    return c.month ? ['m', 'y'] : ['m', 'd', 'y'];
  }
  var WLABEL = { m: 'Month', d: 'Day', y: 'Year', h: 'Hour', i: 'Minute' };
  function daysIn(v) { return new Date(Number(v.y) || THIS_YEAR, Number(v.m) || 1, 0).getDate(); }
  function wheelOptions(col) {
    var c = wheel.c;
    if (col === 'm') return MONTHS.map(function (m, i) { return [pad(i + 1), m]; });
    if (col === 'd') return range(1, daysIn(wheel.vals)).map(function (x) { return [pad(x), String(x)]; });
    if (col === 'h') return range(0, 23).map(function (x) { return [pad(x), pad(x)]; });
    if (col === 'i') return range(0, 11).map(function (x) { return [pad(x * 5), pad(x * 5)]; });
    var years = c.kind === 'year' ? range(THIS_YEAR - 45, THIS_YEAR + 1) : c.recent ? range(THIS_YEAR - 2, THIS_YEAR) : range(THIS_YEAR - 60, THIS_YEAR);
    return years.map(function (y) { return [String(y), String(y)]; });
  }
  /** What the wheels open on: the answer so far, else now. */
  function wheelStart(c, v) {
    var now = new Date(), s = filled(v) ? String(v) : '';
    var at = { y: String(now.getFullYear()), m: pad(now.getMonth() + 1), d: pad(now.getDate()), h: pad(now.getHours()), i: pad(Math.floor(now.getMinutes() / 5) * 5) };
    if (!s) return at;
    if (c.kind === 'year') { at.y = s; return at; }
    if (c.kind === 'time') { at.h = s.slice(0, 2); at.i = pad(Math.round(Number(s.slice(3, 5)) / 5) * 5 % 60); return at; }
    at.y = s.slice(0, 4); at.m = s.slice(5, 7);
    if (s.length >= 10) at.d = s.slice(8, 10);
    if (s.length > 10) { at.h = s.slice(11, 13); at.i = pad(Math.round(Number(s.slice(14, 16)) / 5) * 5 % 60); }
    return at;
  }
  function colHtml(col) {
    return '<div class="wpad"></div>' + wheelOptions(col).map(function (o, i) { return '<button type="button" class="wi" data-wi="' + i + '" tabindex="-1">' + esc(o[1]) + '</button>'; }).join('') + '<div class="wpad"></div>';
  }
  function colEl(col) { return document.querySelector('[data-col="' + col + '"]'); }
  function colIndex(el) { return Math.max(0, Math.round(el.scrollTop / ROW)); }
  function markCol(el) {
    var at = colIndex(el), rows = el.querySelectorAll('.wi');
    for (var i = 0; i < rows.length; i++) rows[i].className = i === at ? 'wi on' : 'wi';
  }
  function placeCol(col) {
    var el = colEl(col), opts = wheelOptions(col), at = 0;
    opts.forEach(function (o, i) { if (o[0] === wheel.vals[col]) at = i; });
    el.scrollTop = at * ROW;
    markCol(el);
  }
  function readWheels() {
    wheel.cols.forEach(function (col) {
      var el = colEl(col), opts = wheelOptions(col);
      wheel.vals[col] = opts[Math.min(opts.length - 1, colIndex(el))][0];
    });
  }
  /** A month with fewer days: the day wheel follows, and the day comes back to the end of the month. */
  function settleDays() {
    readWheels();
    var el = colEl('d');
    if (!el) return;
    var days = daysIn(wheel.vals);
    if (el.querySelectorAll('.wi').length === days) return;
    if (Number(wheel.vals.d) > days) wheel.vals.d = pad(days);
    el.innerHTML = colHtml('d');
    placeCol('d');
  }
  function openWheel(key) {
    var c = FIELD[key].control;
    wheel = { key: key, c: c, cols: wheelCols(c), vals: wheelStart(c, value(key)) };
    $('wheelTitle').textContent = promptOf(FIELD[key]);
    $('wheelLabels').innerHTML = wheel.cols.map(function (col) { return '<span>' + WLABEL[col] + '</span>'; }).join('');
    $('wheels').innerHTML = '<div class="wband"></div>' + wheel.cols.map(function (col) { return '<div class="wheel" data-col="' + col + '">' + colHtml(col) + '</div>'; }).join('');
    $('wheelSheet').hidden = false;
    wheel.cols.forEach(placeCol);
    wheel.cols.forEach(function (col) {
      colEl(col).addEventListener('scroll', function () {
        markCol(this);
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(function () { if (wheel) settleDays(); }, 120);
      });
    });
  }
  function closeWheel() { wheel = null; $('wheelSheet').hidden = true; render(); }
  /** What the wheels say, as the question saves it. The year of a date and time: the last time that day has come round. */
  function wheelValue() {
    var c = wheel.c, v = wheel.vals;
    if (c.kind === 'time') return v.h + ':' + v.i;
    if (c.kind === 'year') return Number(v.y);
    if (c.month) return v.y + '-' + v.m;
    if (c.kind === 'datetime') {
      // The year it already holds stays, unless that's still to come.
      var y = Number(v.y);
      if (new Date(y, Number(v.m) - 1, Number(v.d), Number(v.h), Number(v.i)) > new Date()) y--;
      return y + '-' + v.m + '-' + v.d + ' ' + v.h + ':' + v.i;
    }
    var date = v.y + '-' + v.m + '-' + v.d;
    return c.recent && date > daysAgo(0) ? daysAgo(0) : date;
  }
  // ---- a list of known names: a dropdown to type into ------------------------------------------------------------------
  var listSheet = null;
  function comboMatches(c, typed) {
    var t = typed.toLowerCase();
    if (!t) return c.options;
    var starts = [], inside = [];
    c.options.forEach(function (o) { var at = o.toLowerCase().indexOf(t); if (at === 0) starts.push(o); else if (at > 0) inside.push(o); });
    return starts.concat(inside);
  }
  function drawCombo() {
    var c = FIELD[listSheet].control, typed = $('comboInput').value.trim(), list = comboMatches(c, typed), exact = list.some(function (o) { return same(o, typed); });
    var html = list.map(function (o) { return '<button type="button" class="li" data-co="' + esc(o) + '">' + esc(o) + '</button>'; }).join('');
    if (typed && c.free && !exact) html += '<button type="button" class="li use" data-co="' + esc(typed) + '">Use "' + esc(typed) + '"</button>';
    $('comboList').innerHTML = html;
    $('comboList').scrollTop = 0;
  }
  function openCombo(key) {
    listSheet = key;
    $('comboTitle').textContent = promptOf(FIELD[key]);
    $('comboInput').value = '';
    $('comboInput').placeholder = FIELD[key].control.placeholder || 'Start typing';
    drawCombo();
    $('comboSheet').hidden = false;
    $('comboInput').focus();
  }
  function closeCombo() { listSheet = null; $('comboInput').blur(); $('comboSheet').hidden = true; render(); }
  function pickCombo(name) {
    var k = listSheet, c = FIELD[k].control, rest = detailOf(c, value(k));
    draft[k] = name + (rest ? c.detail.joiner + rest : '');
    delete errors[k];
    closeCombo();
  }
  // ---- a long list of sentences: one to pick, on a sheet ----------------------------------------------------------------
  var picking = null;
  function openSheet(key) {
    picking = key;
    $('sheetTitle').textContent = 'Choose one';
    var cur = filled(value(key)) ? String(value(key)) : '', grid = $('sheetGrid');
    grid.className = 'grid g1';
    grid.innerHTML = FIELD[key].control.options.map(function (o) {
      return '<button type="button" class="cell' + (o === cur ? ' on' : '') + '" data-cell="' + esc(o) + '">' + esc(o) + '</button>';
    }).join('');
    $('sheet').hidden = false;
    grid.scrollTop = 0;
  }
  function closeSheet() { picking = null; $('sheet').hidden = true; render(); }
  function fmtNumber(n) { return Number(n).toLocaleString('en-ZA'); }
  function sliderShown(c, v) { return filled(v) ? fmtNumber(v) + ' ' + c.unit : 'Not set'; }
  function stepCount(f, c) {
    if (value(f.key) !== true) return 0;
    var n = 1;
    while (value(c.group + '.more.' + n) === true) n++;
    return n;
  }
  function stepMax(c) { var n = 1; V.screens.forEach(function (s) { s.fields.forEach(function (x) { if (x.key.indexOf(c.group + '.more.') === 0) n++; }); }); return n; }
  /** Splits "Land Rover Defender" at the option it starts with, so a name with a space in it stays whole. */
  function pillBase(c, v) {
    var s = filled(v) ? String(v) : '';
    if (!c.detail) return s;
    var hit = null;
    (c.options || []).forEach(function (o) { if ((same(s, o) || s.toLowerCase().indexOf(o.toLowerCase() + c.detail.joiner.toLowerCase()) === 0) && (hit === null || o.length > hit.length)) hit = o; });
    return hit !== null ? s.slice(0, hit.length) : s.split(c.detail.joiner)[0];
  }
  function detailOf(c, v) {
    if (!c.detail || !filled(v)) return '';
    return String(v).slice(pillBase(c, v).length + c.detail.joiner.length);
  }
  function isOption(c, s) { return (c.options || []).some(function (o) { return same(o, s); }); }

  function controlHtml(f) {
    var c = f.control, v = value(f.key), k = f.key;
    switch (c.kind) {
      case 'yes-no':
        return '<div class="opts">' + optBtn('data-k="' + q(k) + '" data-b="true"', 'Yes', v === true) + optBtn('data-k="' + q(k) + '" data-b="false"', 'No', v === false) + '</div>';
      case 'pills': {
        // Long sentences don't fit as pills on one screen: they're a list to pick from, on the sheet.
        if (c.options.join('').length > 200 || c.options.some(function (o) { return o.length > 42; })) {
          return '<div class="tiles t1">' + tile(k, 'Choose one', filled(v) ? String(v) : '', 'data-pick="' + q(k) + '"') + '</div>';
        }
        var b = pillBase(c, v), other = otherOpen[k] || (filled(b) && !isOption(c, b));
        var html = '<div class="opts' + (c.options.length > 6 ? ' tight' : '') + '">' + c.options.map(function (o) { return optBtn('data-k="' + q(k) + '" data-v="' + esc(o) + '"', o, !other && same(b, o)); }).join('')
          + (c.other ? optBtn('data-other="' + q(k) + '"', 'Other', other) : '') + '</div>';
        if (other) html += box(f, filled(v) ? String(v) : '', { placeholder: 'Please tell us' });
        else if (c.detail && filled(b)) {
          var rest = detailOf(c, v);
          html += '<input class="inp" autocomplete="off" data-detail="' + q(k) + '" placeholder="' + esc(c.detail.placeholder) + '" value="' + esc(rest) + '">';
        }
        return html;
      }
      case 'combo': {
        var base = pillBase(c, v), then2 = c.detail && filled(base) ? '<input class="inp" autocomplete="off" data-detail="' + q(k) + '" placeholder="' + esc(c.detail.placeholder) + '" value="' + esc(detailOf(c, v)) + '">' : '';
        return '<div class="tiles t1">' + tile(k, 'Tap to choose or type', base, 'data-combo="' + q(k) + '"') + '</div>' + then2;
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
        if (!c.recent) return whenTile(k, c, v);
        var today = daysAgo(0), yest = daysAgo(1), early = earlierOpen[k] || (filled(v) && v !== today && v !== yest);
        return '<div class="opts">' + optBtn('data-day="' + q(k) + '" data-v="' + today + '"', 'Today', !early && v === today) + optBtn('data-day="' + q(k) + '" data-v="' + yest + '"', 'Yesterday', !early && v === yest)
          + optBtn('data-day="' + q(k) + '" data-v="earlier"', 'Earlier', early) + '</div>' + (early ? whenTile(k, c, v) : '');
      }
      case 'time': case 'datetime': case 'year': return whenTile(k, c, v);
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
    var tappable = ['yes-no', 'pills', 'combo', 'multi', 'yes-text', 'date', 'time', 'datetime', 'year', 'stepper'].indexOf(c.kind) >= 0;
    var need = f.required && c.kind !== 'stepper' ? '<span class="req">Required</span>' : '';
    return tappable ? '<div class="ql">' + esc(text) + need + '</div>' : '<label class="ql" for="f-' + q(f.key) + '">' + esc(text) + need + '</label>';
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
      var people = f.control.kind === 'stepper' || !!f.counted;
      if (f.control.half && g && g.control.half && f.entry === g.entry) { out.push({ key: f.key, fields: [f, g], entry: f.entry || null, people: people }); i++; }
      else out.push({ key: f.key, fields: [f], entry: f.entry || null, people: people });
    }
    return out;
  }
  function visibleBlocks(step) {
    if (step.id === 'photos') {
      return V.evidence.filter(shows).map(function (e) { return { key: e.key, ev: e }; })
        .concat([{ key: '__other', ev: { key: '', prompt: 'Anything else that may help', kind: 'photo', count: extra, required: false } }]);
    }
    return blocksOf(V.screens[step.i].fields.filter(function (f) { return shows(f) && !f.hidden; }));
  }
  function blockHtml(b) {
    if (b.fields.length === 1) return fieldHtml(b.fields[0]);
    return '<div class="q" data-q="' + q(b.key) + '">' + labelHtml(b.fields[0]) + '<div class="row2">' + controlHtml(b.fields[0]) + controlHtml(b.fields[1]) + '</div>' + err(b.fields[0].key) + err(b.fields[1].key) + '</div>';
  }
  function stepHtml(step, blocks) {
    if (step.id === 'photos') {
      return '<div class="ups">' + blocks.map(function (b) { return upHtml(b.ev); }).join('') + '</div>' + err('photos');
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
  /**
   * Puts as many of the blocks on the page as fit, and says how many. One that can't fit alone still shows, and scrolls.
   * A count of people and their cards stay together on a step of their own: it may scroll, however many there are.
   */
  function fit(step, blocks) {
    var body = $('body'), run = 0;
    while (run < blocks.length && blocks[run].people) run++;
    if (run) { body.innerHTML = stepHtml(step, blocks.slice(0, run)); return run; }
    var cut = 0;
    while (cut < blocks.length && !blocks[cut].people) cut++;
    blocks = blocks.slice(0, cut);
    var n = blocks.length;
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
  function thumbHtml(u) {
    var inner = u.url ? '<img src="' + u.url + '" alt="">' : esc((u.name.split('.').pop() || 'file').toUpperCase());
    if (u.state === 'up') return '<div class="thumb" role="status" aria-label="Uploading">' + inner + '<div class="cover"><div class="spin"></div></div></div>';
    if (u.state === 'fail') return '<button type="button" class="thumb fail" data-retry="' + u.id + '" aria-label="Try that upload again">' + inner + '<div class="cover">Retry</div></button>';
    return '<div class="thumb">' + inner + '</div>';
  }
  function upHtml(e) {
    var key = e.key, count = key ? e.count : extra, id = 'up-' + (key || 'other'), accept = e.kind === 'video' ? 'video/*' : 'image/*,application/pdf';
    var mine = uploads.filter(function (u) { return u.key === key; }), going = mine.filter(function (u) { return u.state === 'up'; }).length;
    var need = e.required && !count && !going;
    var note = going ? '<span class="spin dark"></span>Uploading ' + going + (going === 1 ? ' file…' : ' files…') : count ? count + ' added' : need ? 'We need this for your claim. No problem if you don\'t have it now: you can add it later.' : 'Not added yet';
    return '<div class="up' + (need ? ' need' : '') + '" data-q="' + q(id) + '"><div class="ic' + (count ? ' ok' : '') + '">' + (count ? ICON_OK : ICON_CAM) + '</div><div><b>' + esc(e.prompt) + (e.required && !count ? '<span class="req">Required</span>' : '') + '</b><small id="st-' + q(id) + '">' + note + '</small></div>'
      + '<div class="up-acts">' + (e.draw ? '<button type="button" class="addb draw" data-draw="' + q(key) + '">Draw</button>' : '') + '<label class="addb" for="' + q(id) + '">' + (e.draw ? 'Photo' : 'Add') + '</label></div><input class="sr" type="file" id="' + q(id) + '" data-up="' + q(key) + '" accept="' + accept + '" multiple>'
      + (mine.length ? '<div class="thumbs">' + mine.map(thumbHtml).join('') + '</div>' : '') + '</div>';
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
    var html = '<p class="help">Tap Change to fix anything. Next, ' + (V.emailed ? 'we email you your form to sign' : 'Tina sends your form to sign on WhatsApp') + '.</p>';
    var missing = V.evidence.filter(function (e) { return shows(e) && e.required && !e.count && !uploads.some(function (u) { return u.key === e.key && u.state === 'up'; }); }).map(function (e) { return e.prompt; });
    visibleScreens().forEach(function (i) { V.screens[i].fields.forEach(function (f) { if (f.required && shows(f) && !f.hidden && !filled(A[f.key]) && f.control.kind !== 'stepper') missing.push(promptOf(f)); }); });
    if (missing.length) html += '<div class="need-box"><b>Still required</b><ul>' + missing.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul><span>You can submit now and send these later. Tina or your broker will follow up.</span></div>';
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
    var count = V.evidence.reduce(function (n, e) { return n + (shows(e) ? e.count : 0); }, 0) + extra + uploads.filter(function (u) { return u.state === 'up'; }).length;
    html += '<div class="q"><div class="head"><div class="ql">Photos and documents</div><button type="button" class="link" data-go="photos">Change</button></div><div class="card"><div class="kv fixed"><span>Added</span><b>' + count + '</b></div></div></div>';
    return html + err('submit');
  }

  var drawnAt = null;
  function render() {
    var body = $('body');
    var steps = route(), i = stepIndex(steps), step = steps[i], anchor = here && here.anchor;
    here = { id: step.id, i: step.i, anchor: anchor };
    $('sec').textContent = step.id === 'details' ? 'Are these details still right?' : step.id === 'photos' ? 'Add your photos and documents' : step.id === 'review' ? 'Check your claim' : V.screens[step.i].title;
    $('back').hidden = i === 0;
    // The height to fit is the page without the phone's keyboard open.
    if (!typing() || !pageH) pageH = body.clientHeight;
    // A tap on this step keeps its place; a new step opens at the top.
    var again = drawnAt && sameStep(drawnAt, here) && drawnAt.anchor === here.anchor, top = again ? body.scrollTop : 0;
    var part = 0;
    page = []; morePages = false;
    if (step.id === 'screen' || step.id === 'photos') {
      var all = visibleBlocks(step), from = 0;
      all.forEach(function (b, x) { if (b.key === anchor) from = x; });
      var rest = all.slice(from), n = fit(step, rest);
      page = rest.slice(0, n);
      morePages = n < rest.length;
      part = all.length ? from / all.length : 0;
    } else body.innerHTML = step.id === 'review' ? reviewHtml() : detailsHtml();
    body.scrollTop = top;
    drawnAt = { id: here.id, i: here.i, anchor: here.anchor };
    $('prog').style.width = Math.round((i + part) / Math.max(1, steps.length - 1) * 100) + '%';
    if (!submitting) { $('next').textContent = step.id === 'details' ? 'All correct' : step.id === 'review' ? 'Submit claim' : 'Continue'; }
    $('next').disabled = busy;
    drawNotice();
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
          // The count the client sees is their answer, even untouched: "1" came from what they told Tina, so the
          // "is there another?" after the last card is a no. Without it the server holds that question open and
          // Submit keeps sending them back to this step.
          var n = stepCount(f, f.control), last = f.control.group + '.more.' + n;
          if (v === true && n < stepMax(f.control) && !filled(value(last))) answers.push({ key: last, value: false });
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
  // ---- saving behind the page: in order, one at a time, trying again until it's in ---------------------------------------
  var queue = [], sending = false, failures = 0, refused = 0, lost = false, problems = {}, waiters = [], submitting = false;
  function idle() { return !queue.length && !sending && !hearing && !uploads.some(function (u) { return u.state === 'up'; }); }
  function whenIdle(fn) { if (idle()) return fn(); waiters.push(fn); }
  function checkIdle() { if (!idle()) return; var w = waiters; waiters = []; w.forEach(function (f) { f(); }); }
  /** What this save says, on what the page holds, so the page is right before the server has answered. */
  function overlay(b) {
    (b.cleared || []).forEach(function (k) { delete A[k]; });
    (b.notKnown || []).forEach(function (k) { delete A[k]; NK[k] = true; });
    (b.answers || []).forEach(function (a) { A[a.key] = a.value; delete NK[a.key]; });
  }
  function mergeInto(to, b) {
    var keys = {};
    (b.answers || []).forEach(function (a) { keys[a.key] = 1; });
    (b.notKnown || []).forEach(function (k) { keys[k] = 1; });
    (b.cleared || []).forEach(function (k) { keys[k] = 1; });
    var keep = function (k) { return !keys[k]; };
    to.answers = (to.answers || []).filter(function (a) { return keep(a.key); }).concat(b.answers || []);
    to.notKnown = (to.notKnown || []).filter(keep).concat(b.notKnown || []);
    to.cleared = (to.cleared || []).filter(keep).concat(b.cleared || []);
    if (b.detailsConfirmed) to.detailsConfirmed = true;
    if (b.termsAccepted) to.termsAccepted = true;
  }
  function enqueue(b) {
    overlay(b);
    var open = queue.length - (sending ? 1 : 0);
    if (open > 0) mergeInto(queue[queue.length - 1], b); else queue.push(b);
    pump();
  }
  function pump() {
    if (sending || !queue.length) return checkIdle();
    sending = true;
    var body = queue[0];
    body.checked = Object.keys(checked);
    var text = JSON.stringify(body);
    // keepalive: an answer still goes through if the client closes the page straight after the tap.
    fetch(base + '/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: text.length < 60000 }).then(function (r) {
      if (r.status === 410 || r.status === 404) { location.reload(); throw new Error('gone'); }
      if (!r.ok) {
        // The server answered and won't take it. A few more tries for a passing fault, then it's let go, so nothing waits behind it.
        refused = r.status < 500 ? 5 : refused + 1;
        throw new Error('failed');
      }
      refused = 0;
      return r.json();
    }).then(function (r) {
      sending = false; failures = 0;
      queue.shift();
      absorb(r, body);
      drawNotice();
      pump();
    }).catch(function (e) {
      sending = false;
      if (e.message === 'gone') return;
      if (refused >= 5) {
        refused = 0; failures = 0;
        queue.shift();
        lost = true;
        drawNotice();
        // What the server really holds, so the client sees which answers to give again.
        api('/state').then(function (s) { adopt(s); queue.forEach(overlay); if (!typing() && !sheetOpen()) render(); }).catch(function () {});
        return pump();
      }
      failures++;
      drawNotice();
      setTimeout(pump, Math.min(15000, 1000 * Math.pow(2, failures)));
    });
  }
  /** What the server holds now, with what's still on its way on top. */
  function absorb(r, sent) {
    A = r.answers; NK = {};
    r.notKnown.forEach(function (k) { NK[k] = true; });
    queue.forEach(overlay);
    var redraw = false;
    (r.problems || []).forEach(function (p) {
      (sent.answers || []).forEach(function (a) { if (a.key === p.key) draft[p.key] = a.value; });
      V.details.forEach(function (d) { if (d.key === p.key && d.was !== undefined) { d.value = d.was; editing[d.key] = true; } });
      problems[p.key] = p.text; errors[p.key] = p.text; checked[p.key] = true;
      redraw = true;
    });
    // An answer can open a question only the server knows about. It's read in behind the page.
    if (r.open && !r.open.every(holdsKey)) api('/state').then(function (s) { adopt(s); queue.forEach(overlay); if (!typing() && !sheetOpen()) render(); }).catch(function () {});
    if (redraw && !typing() && !sheetOpen()) render();
  }
  function sheetOpen() { return !!(rec || hearing || wheel || picking || listSheet || drawing || !$('terms').hidden); }
  function labelFor(key) {
    var d = V.details.filter(function (x) { return x.key === key; })[0];
    if (d) return d.label + ':';
    return FIELD[key] ? promptOf(FIELD[key]) : 'One answer:';
  }
  function onPage(key) { return page.some(function (b) { return (b.fields || []).some(function (f) { return f.key === key; }); }) || (here && here.id === 'details' && V.details.some(function (d) { return d.key === key; })); }
  /** A slim bar over the step: no connection, or an answer the client has moved past that needs another look. */
  function drawNotice() {
    var el = $('notice'), html = '', keys = Object.keys(problems).filter(function (k) { return !onPage(k); });
    if (lost) html = '<span>Some answers could not be saved. Please go back and check them, or ask Tina for help.</span>';
    else if (failures >= 2) html = '<span>No connection. Your answers are safe here and save when you\'re back online.</span>';
    else if (keys.length) html = '<span>' + esc(labelFor(keys[0])) + ' ' + esc(problems[keys[0]]) + '</span><button type="button" data-fix="' + q(keys[0]) + '">Fix</button>';
    el.innerHTML = html;
    el.hidden = !html;
  }
  function goFix(key) {
    errors[key] = problems[key];
    if (V.details.some(function (d) { return d.key === key; })) { here = { id: 'details', anchor: null }; editing[key] = true; return render(); }
    var at = -1;
    V.screens.forEach(function (s, i) { if (at < 0 && s.fields.some(function (f) { return f.key === key; })) at = i; });
    if (at < 0) { delete problems[key]; return render(); }
    here = { id: 'screen', i: at, anchor: anchorFor(at, function (f) { return f.key === key; }) };
    render();
  }
  function forgetSaved(keys) { keys.forEach(function (k) { delete draft[k]; delete problems[k]; }); }
  function move(by) {
    var steps = route(), i = stepIndex(steps), t = steps[Math.max(0, Math.min(steps.length - 1, i + by))];
    here = { id: t.id, i: t.i, anchor: null };
    errors = {};
    // Going back lands on the last page of that step.
    if (by < 0 && (t.id === 'screen' || t.id === 'photos')) here.anchor = pageStarts(t).pop() || null;
    render();
  }
  function back() {
    if (busy || rec || hearing) return;
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
  /** The page a question is on: it starts at that question, so the client lands right on it. */
  function anchorFor(i, test) {
    var hit = null;
    blocksOf(V.screens[i].fields.filter(function (f) { return shows(f) && !f.hidden; })).forEach(function (b) { if (!hit && b.fields.some(test)) hit = b.key; });
    return hit;
  }
  function next() {
    if (busy || rec || hearing) return;
    var step = here;
    if (step.id === 'details') {
      var answers = V.details.filter(function (d) { return d.editable && d.key in draft && String(draft[d.key]).trim() !== d.value; }).map(function (d) { return { key: d.key, value: draft[d.key] }; });
      answers.forEach(function (a) { V.details.forEach(function (d) { if (d.key === a.key) { d.was = d.value; d.value = String(a.value).trim(); } }); delete problems[a.key]; });
      V.details.forEach(function (d) { delete draft[d.key]; });
      V.detailsConfirmed = true;
      editing = {};
      enqueue({ answers: answers, detailsConfirmed: true });
      return move(1);
    }
    var last = page.length ? page[page.length - 1].key : null;
    if (step.id === 'review') return submit();
    if (step.id === 'photos') return morePages ? advance(last) : move(1);
    var c = collect(page);
    if (c.answers.length || c.notKnown.length || c.cleared.length) {
      forgetSaved(c.answers.map(function (a) { return a.key; }).concat(c.notKnown, c.cleared));
      enqueue(c);
    }
    advance(last);
  }
  function submit() {
    busy = true; submitting = true; $('next').disabled = true;
    $('next').innerHTML = '<span class="spin"></span>' + (uploads.some(function (u) { return u.state === 'up'; }) ? 'Uploading your photos…' : 'Submitting…');
    whenIdle(function () {
      // A problem on a question that no longer shows (the second person's phone, after the count went back to one) has
      // nothing to fix: the server dropped that answer. Kept, it would send the client to that step on every Submit.
      Object.keys(problems).forEach(function (k) {
        var f = FIELD[k];
        if (f && (f.hidden || !shows(f))) { delete problems[k]; delete errors[k]; }
      });
      drawNotice();
      var open = Object.keys(problems);
      if (open.length) { busy = false; submitting = false; goFix(open[0]); return; }
      $('next').innerHTML = '<span class="spin"></span>Submitting…';
      post('/submit').then(function (r) {
        busy = false; submitting = false;
        if (r.open && r.open.length) {
          var go = function () {
            var target = null;
            // A hidden "is there another?" is answered by the count of people above the cards, so that's where they go.
            var asks = function (f) {
              return r.open.indexOf(f.key) >= 0 || (f.control.kind === 'stepper' && r.open.some(function (k) { return k.indexOf(f.control.group + '.more.') === 0; }));
            };
            V.screens.forEach(function (s, i) { if (target === null && s.fields.some(function (f) { return shows(f) && !f.hidden && asks(f); })) target = i; });
            // Nothing on the page asks it: reloading would only land on the same step again, so it says so instead.
            if (target === null) { errors = { submit: 'Something on the form still needs an answer. Please ask ' + (V.emailed ? 'your broker' : 'Tina') + ' for help.' }; return render(); }
            here = { id: 'screen', i: target, anchor: anchorFor(target, asks) };
            errors = {};
            render();
          };
          if (r.open.every(holdsKey)) return go();
          return api('/state').then(function (s) { adopt(s); go(); }).catch(go);
        }
        // Nothing more to wait for: the same page the link now shows.
        $('foot').hidden = true; $('notice').hidden = true;
        $('sec').textContent = '';
        $('prog').style.width = '100%';
        $('body').innerHTML = '<div class="center"><div class="done-ic">' + ICON_OK + '</div><h1>Claim submitted</h1><p class="help">Thank you, we have your answers. ' + (V.emailed ? 'We will email you with anything still needed and your form to sign.' : 'Tina will message you on WhatsApp with anything still needed and your form to sign.') + '</p></div>';
      }).catch(function (e) {
        busy = false; submitting = false;
        if (e.message === 'gone') return;
        errors = { submit: (e.body && e.body.message) || 'No connection. Please try again.' };
        render();
      });
    });
  }

  // ---- voice: only for the client's own words ----------------------------------------------------------------------
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var rec = null, recKey = null, recParts = [], recTimer = null, micStarting = false, hearing = false, liveTimer = null, liveBusy = false, liveRun = 0;
  function micNote(key, text) { var n = $('note-' + key); if (n) { n.textContent = text; n.hidden = !text; } }
  function mime() {
    var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  function micBtn(key) { return document.querySelector('[data-mic="' + key.replace(/"/g, '') + '"]') || document.createElement('button'); }
  function heard(blob, key) {
    return fetch(base + '/voice?key=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': (blob.type || 'audio/webm').split(';')[0] }, body: blob }).then(function (r) { return r.json(); });
  }
  function mic(key) {
    if (rec) { if (recKey === key) rec.stop(); return; }
    if (micStarting || hearing) return;
    micStarting = true;
    micNote(key, 'Starting the microphone…');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micStarting = false;
      var type = mime(), run = ++liveRun, startedAt = Date.now(), input = $('f-' + key), before = input ? input.value.trim() : '';
      var withWords = function (words) { return before ? before + ' ' + words : words; };
      rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      recKey = key; recParts = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recParts.push(e.data); };
      // While they talk: what's been said so far goes to be read, one at a time, and the box shows it. The longer the
      // recording, the less often, because each read is of the whole recording so far.
      var listen = function () {
        if (run !== liveRun || !rec) return;
        if (liveBusy || !recParts.length) { liveTimer = setTimeout(listen, 500); return; }
        liveBusy = true;
        var seen = new Blob(recParts, { type: rec.mimeType || type || 'audio/webm' });
        heard(seen, key).then(function (j) {
          if (run !== liveRun || !rec || !j.text) return;
          var box = $('f-' + key);
          if (box) { box.value = withWords(j.text); box.scrollTop = box.scrollHeight; }
        }).catch(function () {}).then(function () {
          liveBusy = false;
          if (run === liveRun && rec) liveTimer = setTimeout(listen, Math.max(1500, (Date.now() - startedAt) / 12));
        });
      };
      rec.onstop = function () {
        clearTimeout(recTimer); clearTimeout(liveTimer);
        liveRun++;
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(recParts, { type: rec.mimeType || type || 'audio/webm' }), k = recKey;
        rec = null; recKey = null; liveBusy = false; hearing = true;
        var btn = micBtn(k), box = $('f-' + k);
        btn.classList.remove('rec'); btn.innerHTML = ICON_MIC; btn.disabled = true; btn.setAttribute('aria-label', 'Record your answer');
        micNote(k, 'Just finishing that…');
        var finish = function (note, text) {
          hearing = false;
          micBtn(k).disabled = false;
          var b = $('f-' + k);
          if (b) { b.readOnly = false; b.classList.remove('live'); }
          if (text !== null) { draft[k] = text; if (b) b.value = text; }
          micNote(k, note);
          checkIdle();
        };
        var soFar = function () { return box && box.value.trim() !== before ? box.value : null; };
        heard(blob, k).then(function (j) {
          if (j.text) finish('Please check what I heard. You can change it.', withWords(j.text));
          else finish(j.message || 'I couldn\'t make that out. Please try again, or type your answer.', soFar());
        }).catch(function () { finish('No connection. Please try again, or type your answer.', soFar()); });
      };
      rec.start(1000);
      if (input) { input.readOnly = true; input.classList.add('live'); }
      var btn = micBtn(key);
      btn.classList.add('rec'); btn.innerHTML = ICON_STOP; btn.setAttribute('aria-label', 'Stop recording');
      micNote(key, 'Listening… your words show here as you talk. Tap again to stop.');
      liveTimer = setTimeout(listen, 2000);
      recTimer = setTimeout(function () { if (rec) rec.stop(); }, 180000);
    }).catch(function () { micStarting = false; micNote(key, 'The microphone isn\'t available. Please type your answer.'); });
  }

  // ---- photos ------------------------------------------------------------------------------------------------------
  var uploads = [], upSeq = 0, upActive = 0;
  /** A picture to show at once, where the browser can show it. */
  function previewOf(f) { return f.type && f.type.indexOf('image/') === 0 && f.type !== 'image/heic' && f.type !== 'image/heif' ? URL.createObjectURL(f) : null; }
  function addUpload(key, file) {
    uploads.push({ id: ++upSeq, key: key, file: file, name: file.name || 'file', url: previewOf(file), state: 'up', started: false });
    pumpUploads();
  }
  function pumpUploads() {
    while (upActive < 2) {
      var u = uploads.filter(function (x) { return x.state === 'up' && !x.started; })[0];
      if (!u) break;
      u.started = true; upActive++;
      sendUpload(u);
    }
  }
  function sendUpload(u) {
    var finish = function (message) {
      upActive--;
      if (message === null) {
        u.state = 'ok';
        if (u.key) V.evidence.forEach(function (e) { if (e.key === u.key) e.count++; }); else extra++;
      } else { u.state = 'fail'; errors.photos = message; }
      if (here && here.id === 'photos' && !sheetOpen()) render();
      pumpUploads();
      checkIdle();
    };
    fetch(base + '/file' + (u.key ? '?item=' + encodeURIComponent(u.key) : ''), { method: 'POST', headers: { 'Content-Type': u.file.type || 'application/octet-stream' }, body: u.file })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) { finish(r.ok ? null : r.j.message || 'That file couldn\'t be added. Tap it to try again.'); })
      .catch(function () { finish('No connection. Tap the photo to try again.'); });
  }
  function upload(input) {
    var key = input.dataset.up, files = [].slice.call(input.files || []);
    if (!files.length) return;
    delete errors.photos;
    files.forEach(function (f) { addUpload(key, f); });
    input.value = '';
    render();
  }

  // ---- a drawing of the accident: with a finger, like signing ------------------------------------------------------------
  var drawing = null, strokes = [], stroke = null;
  function paint() {
    var cv = $('drawCanvas'), g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.lineWidth = 3 * (window.devicePixelRatio || 1); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#0B0F14';
    strokes.forEach(function (s) {
      g.beginPath(); g.moveTo(s[0][0], s[0][1]);
      if (s.length === 1) g.lineTo(s[0][0] + 0.1, s[0][1]);
      for (var i = 1; i < s.length; i++) g.lineTo(s[i][0], s[i][1]);
      g.stroke();
    });
    $('drawHint').hidden = strokes.length > 0;
    $('drawSave').disabled = !strokes.length;
    $('drawUndo').disabled = !strokes.length;
  }
  function openDraw(key) {
    drawing = key; strokes = []; stroke = null;
    $('drawTitle').textContent = 'Draw the accident';
    $('drawHint').textContent = 'Use your finger. Show where the cars hit each other, with arrows for the way each car was going.';
    $('drawSheet').hidden = false;
    var cv = $('drawCanvas'), dpr = window.devicePixelRatio || 1, box = cv.getBoundingClientRect();
    cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr);
    paint();
  }
  function closeDraw() { drawing = null; $('drawSheet').hidden = true; render(); }
  function drawPoint(e) {
    var cv = $('drawCanvas'), box = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    return [(e.clientX - box.left) * dpr, (e.clientY - box.top) * dpr];
  }
  $('drawCanvas').addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (this.setPointerCapture) this.setPointerCapture(e.pointerId);
    stroke = [drawPoint(e)]; strokes.push(stroke);
    paint();
  });
  $('drawCanvas').addEventListener('pointermove', function (e) {
    if (!stroke) return;
    e.preventDefault();
    var to = drawPoint(e), from = stroke[stroke.length - 1], g = this.getContext('2d');
    stroke.push(to);
    g.beginPath(); g.moveTo(from[0], from[1]); g.lineTo(to[0], to[1]); g.stroke();
  });
  var endStroke = function () { stroke = null; };
  $('drawCanvas').addEventListener('pointerup', endStroke);
  $('drawCanvas').addEventListener('pointercancel', endStroke);
  $('drawSheet').addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'drawClose') return closeDraw();
    if (t.id === 'drawUndo') { strokes.pop(); return paint(); }
    if (t.id === 'drawClear') { strokes = []; return paint(); }
    if (t.id === 'drawSave') {
      var key = drawing;
      $('drawCanvas').toBlob(function (blob) {
        if (!blob) return;
        addUpload(key, blob);
        closeDraw();
      }, 'image/png');
    }
  });

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
      if (dv === 'earlier') { earlierOpen[dk] = !earlierOpen[dk]; draft[dk] = ''; render(); if (earlierOpen[dk]) openWheel(dk); return; }
      delete earlierOpen[dk]; draft[dk] = value(dk) === dv ? '' : dv;
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
    var wh = e.target.closest('[data-wheel]');
    if (wh) return openWheel(wh.dataset.wheel);
    var co = e.target.closest('[data-combo]');
    if (co) return openCombo(co.dataset.combo);
    var pk = e.target.closest('[data-pick]');
    if (pk) return openSheet(pk.dataset.pick);
    var dw = e.target.closest('[data-draw]');
    if (dw) return openDraw(dw.dataset.draw);
    var rt = e.target.closest('[data-retry]');
    if (rt) {
      uploads.forEach(function (u) { if (String(u.id) === rt.dataset.retry) { u.state = 'up'; u.started = false; } });
      delete errors.photos;
      pumpUploads();
      return render();
    }
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
      delete problems[d.bind];
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
    draft[picking] = cell.dataset.cell;
    closeSheet();
  });
  $('wheelSheet').addEventListener('click', function (e) {
    if (e.target.closest('[data-wheel-close]')) return closeWheel();
    if (!wheel) return;
    var row = e.target.closest('[data-wi]');
    if (row) { row.parentNode.scrollTo({ top: Number(row.dataset.wi) * ROW, behavior: 'smooth' }); return; }
    if (e.target.closest('[data-wheel-clear]')) { draft[wheel.key] = ''; delete errors[wheel.key]; return closeWheel(); }
    if (e.target.closest('[data-wheel-done]')) { readWheels(); draft[wheel.key] = wheelValue(); delete errors[wheel.key]; closeWheel(); }
  });
  $('comboSheet').addEventListener('click', function (e) {
    if (e.target.closest('[data-combo-close]')) return closeCombo();
    var row = e.target.closest('[data-co]');
    if (row) pickCombo(row.dataset.co);
  });
  $('comboInput').addEventListener('input', drawCombo);
  $('comboInput').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var first = $('comboList').querySelector('[data-co]');
    if (first) pickCombo(first.dataset.co);
  });
  $('terms').addEventListener('click', function (e) {
    if (!e.target.closest('[data-agree]')) return;
    $('terms').hidden = true;
    V.terms = null;
    enqueue({ termsAccepted: true });
  });
  $('notice').addEventListener('click', function (e) { var b = e.target.closest('[data-fix]'); if (b) goFix(b.dataset.fix); });
  $('next').addEventListener('click', next);
  $('back').addEventListener('click', back);
  // Turning the phone changes what fits. The keyboard opening doesn't: typing never moves a question to another step.
  window.addEventListener('resize', function () { if (V && !typing() && !sheetOpen()) { pageH = 0; render(); } });

  // ---- open --------------------------------------------------------------------------------------------------------
  api('/state').then(function (s) {
    V = s;
    adopt(s);
    if ($('brandTitle')) $('brandTitle').textContent = s.title;
    if (!s.detailsConfirmed) here = { id: 'details' };
    else {
      here = s.startAt >= s.screens.length ? { id: 'photos' } : { id: 'screen', i: s.startAt, anchor: anchorFor(s.startAt, function (f) { return A[f.key] === undefined && !NK[f.key]; }) };
      if (!route().some(function (x) { return sameStep(x, here); })) here = { id: 'photos' };
    }
    $('foot').hidden = false;
    render();
    // What opens the form: read once, one tap, and straight on.
    if (s.terms) {
      $('termsTitle').textContent = s.terms.title;
      $('termsBody').innerHTML = s.terms.lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('');
      $('termsAgree').textContent = s.terms.agree;
      $('terms').hidden = false;
    }
  }).catch(function (e) {
    if (e.message === 'gone') return;
    $('body').innerHTML = '<p class="center help">The form could not be loaded. Please check your connection and refresh the page.</p>';
  });
})();
`;

/** The page for a link that works. */
export function claimFormPage(): string {
    return `${HEAD('Your claim form')}<body>
<div class="app" id="app">
  ${BRAND()}
  <div class="top">
    <div class="prog"><i id="prog"></i></div>
    <div class="sec" id="sec"></div>
  </div>
  <div class="notice" id="notice" role="status" hidden></div>
  <main class="body" id="body"><div class="sk" style="width:62%"></div><div class="sk tall"></div><div class="sk tall"></div><div class="sk tall"></div><div class="sk" style="width:44%"></div></main>
  <div class="foot" id="foot" hidden><button type="button" id="back">Back</button><button type="button" class="go" id="next">Continue</button></div>
  <div class="sheet" id="sheet" hidden>
    <div class="scrim" data-sheet-close></div>
    <div class="panel" role="dialog" aria-labelledby="sheetTitle">
      <div class="panel-head"><span id="sheetTitle"></span><button type="button" data-sheet-close aria-label="Close">✕</button></div>
      <div class="grid" id="sheetGrid"></div>
    </div>
  </div>
  <div class="sheet" id="wheelSheet" hidden>
    <div class="scrim" data-wheel-close></div>
    <div class="panel auto" role="dialog" aria-labelledby="wheelTitle">
      <div class="panel-head"><span id="wheelTitle"></span><button type="button" data-wheel-close aria-label="Close">✕</button></div>
      <div style="display:grid;gap:8px"><div class="wlabels" id="wheelLabels"></div><div class="wheels" id="wheels"></div></div>
      <div class="wfoot"><button type="button" data-wheel-clear>Clear</button><button type="button" class="go" data-wheel-done>Done</button></div>
    </div>
  </div>
  <div class="sheet" id="comboSheet" hidden>
    <div class="panel full" role="dialog" aria-labelledby="comboTitle">
      <div class="panel-head"><span id="comboTitle"></span><button type="button" data-combo-close aria-label="Close">✕</button></div>
      <input class="inp" id="comboInput" autocomplete="off" autocapitalize="words">
      <div class="list" id="comboList"></div>
    </div>
  </div>
  <div class="sheet" id="drawSheet" hidden>
    <div class="panel full drawing" role="dialog" aria-labelledby="drawTitle">
      <div class="panel-head"><span id="drawTitle"></span><button type="button" id="drawClose" aria-label="Close">✕</button></div>
      <div class="draw-area"><canvas id="drawCanvas"></canvas><div class="draw-hint" id="drawHint"></div></div>
      <div class="draw-foot"><button type="button" id="drawUndo">Undo</button><button type="button" id="drawClear">Clear</button><button type="button" class="go" id="drawSave">Use this drawing</button></div>
    </div>
  </div>
  <div class="sheet" id="terms" hidden>
    <div class="scrim"></div>
    <div class="panel auto" role="dialog" aria-labelledby="termsTitle">
      <div class="panel-head"><span id="termsTitle"></span></div>
      <div class="terms" id="termsBody"></div>
      <button type="button" class="go" id="termsAgree" data-agree></button>
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

/** TTTFG-5188: the same, for a link that went by email. */
const REFUSED_EMAILED: Partial<Record<LinkRefusal, { title: string; text: string; ok?: boolean }>> = {
    expired: { title: 'This link has expired', text: 'Links work for 7 days. Reply to our email and we will send you a new one.' },
    done: { title: 'Claim submitted', text: 'Thank you, we have your answers. We will email you with anything still needed and your form to sign.', ok: true },
    superseded: { title: 'There is a newer link', text: 'Please open the link in our latest email.' },
};

/** The page for a link that's done with, or doesn't work. `whatsApp`: Tina's number, for the way back. */
export function refusedPage(reason: LinkRefusal, whatsApp?: string | null, emailed?: boolean): string {
    const r: { title: string; text: string; ok?: boolean } = (emailed && REFUSED_EMAILED[reason]) || REFUSED[reason];
    const back = whatsApp && !emailed ? `<div class="foot"><a class="go" href="https://wa.me/${esc(whatsApp.replace(/\D/g, ''))}">Back to WhatsApp</a></div>` : '';
    const icon = r.ok ? '<div class="done-ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div>' : '';
    return `${HEAD(r.title)}<body><div class="app">${BRAND()}<main class="body"><div class="center">${icon}<h1>${esc(r.title)}</h1><p class="help">${esc(r.text)}</p></div></main>${back}</div></body></html>`;
}
