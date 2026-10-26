/**
 * TTTFG-5196: the signing page's HTML. One self-contained page: the PDF drawn page by page with pdf.js (cdnjs), and a
 * signature pad that stays off until the client has scrolled to the end of the last page. The token is read from the address,
 * the PDF from /sign/<token>/document, and the signature posted to /sign/<token> as a PNG trimmed to the ink.
 */
import type { Refusal } from './signing';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
/** cdnjs's published hash of pdf.min.js 3.11.174: the browser refuses the script if the CDN serves anything else. */
const PDFJS_SRI = 'sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==';

/**
 * The page's Content-Security-Policy: scripts only from itself and cdnjs (pdf.js runs its worker from a blob), data
 * only from itself, never framed.
 */
export const SIGNING_PAGE_CSP = [
    "default-src 'none'", "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com", 'worker-src blob: https://cdnjs.cloudflare.com',
    "connect-src 'self' https://cdnjs.cloudflare.com", "img-src 'self' data: blob:", "style-src 'unsafe-inline'", 'font-src data:',
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root { --ink: #1c2434; --muted: #5b6475; --line: #d9dde5; --bg: #f4f5f8; --card: #ffffff; --accent: #0f6e6a; --accent-ink: #ffffff; --warn: #8a4b00; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header { background: var(--card); border-bottom: 1px solid var(--line); padding: 14px 16px; position: sticky; top: 0; z-index: 2; }
header h1 { font-size: 17px; margin: 0; }
header p { margin: 2px 0 0; color: var(--muted); font-size: 14px; }
main { max-width: 860px; margin: 0 auto; padding: 16px; }
.pages canvas { display: block; width: 100%; height: auto; background: #fff; margin: 0 0 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.note { color: var(--muted); font-size: 14px; margin: 0 0 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 8px 0 24px; }
.card h2 { font-size: 17px; margin: 0 0 6px; }
#pad { display: block; width: 100%; height: 180px; border: 2px dashed var(--line); border-radius: 8px; background: #fff; touch-action: none; }
#pad.on { border-color: var(--accent); }
.row { display: flex; gap: 10px; margin-top: 12px; }
button { font: inherit; border-radius: 8px; padding: 12px 18px; border: 1px solid var(--line); background: #fff; color: var(--ink); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); flex: 1; font-weight: 600; }
button:disabled { opacity: .45; }
.msg { font-size: 15px; margin-top: 10px; min-height: 1em; }
.msg.warn { color: var(--warn); }
.done { text-align: center; padding: 40px 16px; }
.done h2 { font-size: 20px; }
`;

/** The page for a link that works. */
export function signingPage(title: string): string {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sign your form</title><style>${STYLE}</style>
</head><body>
<header><h1>${esc(title)}</h1><p>Please read the whole form. You can sign at the end.</p></header>
<main>
  <p class="note" id="loading">Loading the form…</p>
  <div class="pages" id="pages"></div>
  <section class="card" id="sign">
    <h2>Your signature</h2>
    <p class="note" id="hint">Scroll to the end of the form to sign.</p>
    <canvas id="pad" aria-label="Signature pad"></canvas>
    <div class="row"><button id="clear" type="button" disabled>Clear</button><button id="submit" class="primary" type="button" disabled>Sign the form</button></div>
    <p class="msg" id="msg"></p>
  </section>
</main>
<script src="${PDFJS}/pdf.min.js" integrity="${PDFJS_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
(function () {
  var token = location.pathname.split('/').filter(Boolean).pop();
  var pagesEl = document.getElementById('pages'), pad = document.getElementById('pad'), hint = document.getElementById('hint');
  var clearBtn = document.getElementById('clear'), submit = document.getElementById('submit'), msg = document.getElementById('msg');
  var enabled = false, inked = false, drawing = false, last = null;
  var ctx = pad.getContext('2d');

  function sizePad() {
    var r = window.devicePixelRatio || 1, w = pad.clientWidth, h = pad.clientHeight;
    pad.width = w * r; pad.height = h * r;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#13213f';
    inked = false; submit.disabled = true;
  }
  function enable() {
    if (enabled) return;
    enabled = true; pad.classList.add('on'); clearBtn.disabled = false;
    hint.textContent = 'Draw your signature in the box with your finger, then tap Sign the form.';
  }
  function point(e) { var b = pad.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
  pad.addEventListener('pointerdown', function (e) { if (!enabled) return; drawing = true; last = point(e); pad.setPointerCapture(e.pointerId); e.preventDefault(); });
  pad.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    var p = point(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; inked = true; submit.disabled = false; e.preventDefault();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { pad.addEventListener(t, function () { drawing = false; }); });
  clearBtn.addEventListener('click', function () { ctx.clearRect(0, 0, pad.width, pad.height); inked = false; submit.disabled = true; msg.textContent = ''; });

  // The signature as a PNG, cut to the ink so it fills the box on the form.
  function trimmed() {
    var w = pad.width, h = pad.height, d = ctx.getImageData(0, 0, w, h).data, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    var m = 6, c = document.createElement('canvas');
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
    c.getContext('2d').drawImage(pad, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  submit.addEventListener('click', function () {
    var png = inked && trimmed();
    if (!png) { msg.className = 'msg warn'; msg.textContent = 'Please draw your signature first.'; return; }
    submit.disabled = true; clearBtn.disabled = true; msg.className = 'msg'; msg.textContent = 'Signing…';
    fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature: png }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) {
        if (r.body && r.body.ok) {
          document.querySelector('main').innerHTML = '<div class="done"><h2>Thank you, your form is signed.</h2><p class="note">We have it. You can close this page.</p></div>';
          document.querySelector('header p').textContent = 'Signed.';
          window.scrollTo(0, 0);
        } else {
          msg.className = 'msg warn'; msg.textContent = (r.body && r.body.message) || 'Something went wrong. Please try again.';
          if (r.status >= 500) { submit.disabled = false; clearBtn.disabled = false; }
        }
      })
      .catch(function () { msg.className = 'msg warn'; msg.textContent = 'No connection. Please try again.'; submit.disabled = false; clearBtn.disabled = false; });
  });

  sizePad();
  window.addEventListener('resize', function () { if (!inked) sizePad(); });

  pdfjsLib.GlobalWorkerOptions.workerSrc = '${PDFJS}/pdf.worker.min.js';
  // isEvalSupported off: a crafted font can't run script (CVE-2024-4367).
  pdfjsLib.getDocument({ url: location.pathname + '/document', isEvalSupported: false }).promise.then(function (pdf) {
    var chain = Promise.resolve(), canvases = [];
    for (var i = 1; i <= pdf.numPages; i++) (function (n) {
      chain = chain.then(function () { return pdf.getPage(n); }).then(function (page) {
        var width = pagesEl.clientWidth || 600, base = page.getViewport({ scale: 1 });
        var scale = (width / base.width) * Math.min(2, window.devicePixelRatio || 1), vp = page.getViewport({ scale: scale });
        var c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.setAttribute('aria-label', 'Page ' + n);
        pagesEl.appendChild(c); canvases.push(c);
        return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      });
    })(i);
    return chain.then(function () {
      document.getElementById('loading').textContent = pdf.numPages > 1 ? 'The form has ' + pdf.numPages + ' pages.' : '';
      // The pad switches on once the end of the last page has been on screen.
      var end = document.createElement('div'); end.id = 'end'; end.style.height = '1px'; pagesEl.appendChild(end);
      new IntersectionObserver(function (es, o) { if (es.some(function (e) { return e.isIntersecting; })) { enable(); o.disconnect(); } }).observe(end);
    });
  }).catch(function () { document.getElementById('loading').textContent = 'The form could not be loaded. Please refresh the page.'; });
})();
</script>
</body></html>`;
}

const REFUSED: Record<Refusal | 'changed', { title: string; text: string }> = {
    'not-found': { title: 'This link does not work', text: 'Please check you opened the whole link, or ask us for a new one.' },
    expired: { title: 'This link has expired', text: 'Links work for 7 days. Please ask us for a new one.' },
    used: { title: 'This form has already been signed', text: 'Thank you, we have it. There is nothing more to do here.' },
    superseded: { title: 'There is a newer version of this form', text: 'Please open the latest link we sent you.' },
    changed: { title: 'This form has changed', text: 'Please ask us for a new link.' },
};

export const refusalMessage = (reason: Refusal | 'changed') => REFUSED[reason];

/** The page for a link that's refused. */
export function refusedPage(reason: Refusal | 'changed'): string {
    const r = REFUSED[reason];
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(r.title)}</title><style>${STYLE}</style>
</head><body><main><div class="done"><h2>${esc(r.title)}</h2><p class="note">${esc(r.text)}</p></div></main></body></html>`;
}
