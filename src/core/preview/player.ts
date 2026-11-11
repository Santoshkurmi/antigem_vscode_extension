// The chat's video player (the app's ChatVideoPlayer / VideoOverlay, VideoPlayerUi.kt), as one page the preview
// server sends: first frame + length before it plays; then a round play / pause button with ⟲10 / 10⟳, time and a
// seek bar (buffered part, accent thumb, drag to scrub), double-click left / right to skip 10 s ("10 seconds"
// bubble), controls that hide while playing, a menu (speed, mute, save, open elsewhere) and "full screen" (the
// chat view: VS Code allows no real full screen in a webview). It talks to the chat through postMessage
// ({antigemPlayer: 'full' | 'open' | 'save'}); the chat answers {antigemPlayerFull: boolean}.
// Query: accent (#rrggbb), title, local=1 (a file on this machine: "Open in VS Code"; else "Open in browser").

// Material icons (filled), the shapes the app uses
const ICONS: Record<string, string> = {
  play_arrow: "M8 5v14l11-7z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  replay: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  replay_10: "M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z M10.89 16h-.85v-3.26l-1.01.31v-.69l1.77-.63h.09V16zm4.28-1.76c0 .32-.03.6-.1.82s-.17.42-.29.57-.28.26-.45.33-.37.1-.59.1-.41-.03-.59-.1-.33-.18-.46-.33-.23-.34-.3-.57-.11-.5-.11-.82v-.74c0-.32.03-.6.1-.82s.17-.42.29-.57.28-.26.45-.33.37-.1.59-.1.41.03.59.1.33.18.46.33.23.34.3.57.11.5.11.82v.74zm-.85-.86c0-.19-.01-.35-.04-.48s-.07-.23-.12-.31-.11-.14-.19-.17-.16-.05-.25-.05-.18.02-.25.05-.14.09-.19.17-.09.18-.12.31-.04.29-.04.48v.97c0 .19.01.35.04.48s.07.24.12.32.11.14.19.17.16.05.25.05.18-.02.25-.05.14-.09.19-.17.09-.19.11-.32.04-.29.04-.48v-.97z",
  forward_10: "M18 13c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6v4l5-5-5-5v4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8h-2z M10.86 15.94v-4.27h-.09L9 12.3v.69l1.01-.31v3.26zm1.39-2.5v.74c0 1.9 1.31 1.82 1.44 1.82.14 0 1.44.09 1.44-1.82v-.74c0-1.9-1.31-1.82-1.44-1.82-.14 0-1.44-.09-1.44 1.82zm2.04-.12v.97c0 .77-.21 1.03-.59 1.03s-.6-.26-.6-1.03v-.97c0-.75.22-1.01.59-1.01.38-.01.6.26.6 1.01z",
  fullscreen: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  fullscreen_exit: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  more_vert: "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  speed: "m20.38 8.57-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z",
  volume_up: "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  volume_off: "M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z",
  download: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z",
  open_in_new: "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
  arrow_back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  error_outline: "M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z",
  fast_forward: "m4 18 8.5-6L4 6v12zm9-12v12l8.5-6L13 6z",
  fast_rewind: "M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
};

const svg = (name: string, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

export function playerPage(src: string): string {
  // inside <script>: no "<" (a "</script>" in a URL would end it)
  const js = (x: unknown) => JSON.stringify(x).replace(/</g, '\\u003c');
  const icons = js(Object.fromEntries(Object.keys(ICONS).map((k) => [k, svg(k)])));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,sans-serif;color:#fff;user-select:none;-webkit-user-select:none}
:root{--accent:#8ab4ff}
#wrap{position:fixed;inset:0;cursor:default}
#wrap.hide{cursor:none}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.ic{width:24px;height:24px;fill:currentColor;display:block}
button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;border-radius:50%;transition:background .15s,transform .15s}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ctl{width:40px;height:40px}
.ctl:hover{background:rgba(255,255,255,.14)}
/* overlay: gradients + controls, fades out while playing */
#ui{position:absolute;inset:0;opacity:1;transition:opacity .25s}
#wrap.hide #ui{opacity:0;pointer-events:none}
#ui::before,#ui::after{content:"";position:absolute;left:0;right:0;pointer-events:none}
#ui::before{top:0;height:72px;background:linear-gradient(rgba(0,0,0,.55),transparent)}
#ui::after{bottom:0;height:96px;background:linear-gradient(transparent,rgba(0,0,0,.7))}
#top{position:absolute;top:0;left:0;right:0;display:none;align-items:center;gap:8px;padding:6px 8px;z-index:2}
#wrap.full #top{display:flex}
#title{flex:1;min-width:0;font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#topMore{display:none}
#wrap.full #topMore{display:flex}
#wrap.full #botMore{display:none}
#center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:24px;z-index:2}
#wrap.full #center{gap:40px}
.disc{width:52px;height:52px;background:rgba(0,0,0,.5);backdrop-filter:blur(4px)}
.disc .ic{width:31px;height:31px}
.disc:hover{background:rgba(0,0,0,.66);transform:scale(1.05)}
#wrap.full .disc{width:64px;height:64px}
#wrap.full .disc .ic{width:38px;height:38px}
.skip .ic{width:32px;height:32px}
.skip{width:48px;height:48px}
#bottom{position:absolute;left:0;right:0;bottom:0;padding:0 8px;z-index:2}
#wrap.full #bottom{padding:0 16px 8px}
#row{display:flex;align-items:center;gap:4px;height:36px}
#time{font-size:11px;font-weight:500;padding-left:4px;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,.5)}
#wrap.full #time{font-size:13px}
#rate{display:none;font-size:10.5px;padding:1px 4px;border-radius:4px;background:rgba(255,255,255,.2);margin-left:6px}
.sp{flex:1}
/* seek bar */
#seek{position:relative;height:28px;cursor:pointer;touch-action:none}
#track,#buf,#played{position:absolute;left:0;top:50%;height:3px;border-radius:2px;transform:translateY(-50%);transition:height .12s}
#track{right:0;background:rgba(255,255,255,.28)}
#buf{background:rgba(255,255,255,.45);width:0}
#played{background:var(--accent);width:0}
#thumb{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--accent);left:0;transition:transform .12s;box-shadow:0 0 0 0 rgba(0,0,0,.2)}
#seek:hover #track,#seek:hover #buf,#seek:hover #played,#seek.drag #track,#seek.drag #buf,#seek.drag #played{height:5px}
#seek:hover #thumb,#seek.drag #thumb{transform:scale(1.34)}
#tip{position:absolute;bottom:26px;transform:translateX(-50%);font-size:11px;padding:2px 6px;border-radius:5px;background:rgba(0,0,0,.75);display:none;font-variant-numeric:tabular-nums;white-space:nowrap}
#seek:hover #tip,#seek.drag #tip{display:block}
/* before playing */
#idle{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:3;cursor:pointer}
#wrap.idle #ui{display:none}
#idle .disc{pointer-events:none}
#len{position:absolute;right:8px;bottom:8px;font-size:11.5px;font-weight:500;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.65);display:none}
/* buffering */
#spin{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:sp 0.8s linear infinite;display:none;z-index:3}
@keyframes sp{to{transform:rotate(360deg)}}
#wrap.buffering #spin{display:block}
#wrap.buffering #center{visibility:hidden}
/* double-click skip bubble */
.bubble{position:absolute;top:0;bottom:0;width:34%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:rgba(255,255,255,.12);font-size:11px;font-weight:500;opacity:0;transition:opacity .2s;pointer-events:none;z-index:1}
.bubble .ic{width:26px;height:26px}
#bl{left:0;border-radius:0 50% 50% 0/0 50% 50% 0}
#br{right:0;border-radius:50% 0 0 50%/50% 0 0 50%}
.bubble.on{opacity:1}
/* error */
#err{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;font-size:12.5px;z-index:4;background:#000}
#err .ic{width:30px;height:30px;opacity:.8}
#err .btns{display:flex;gap:8px}
.pill{border-radius:18px;padding:6px 14px;font-size:12.5px;border:1px solid rgba(255,255,255,.4)}
.pill.fill{background:var(--accent);border-color:var(--accent);color:#000}
/* menu */
#menu{position:absolute;right:8px;bottom:64px;min-width:200px;padding:6px 0;border-radius:12px;background:rgba(32,33,36,.96);box-shadow:0 8px 28px rgba(0,0,0,.5);display:none;z-index:5;font-size:13px}
#wrap.full #menu{top:52px;bottom:auto}
#menu.on{display:block}
.mi{all:unset;display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:8px 14px;cursor:pointer;border-radius:0}
.mi:hover{background:rgba(255,255,255,.08)}
.mi .ic{width:20px;height:20px;opacity:.9}
.mi .v{margin-left:auto;opacity:.6;font-size:12px}
.mi .chk{width:20px;display:flex}
.sep{height:1px;background:rgba(255,255,255,.1);margin:4px 0}
</style></head><body>
<div id="wrap" class="idle" tabindex="0">
  <video id="v" preload="metadata" playsinline></video>
  <div class="bubble" id="bl">${svg('fast_rewind')}<span></span></div>
  <div class="bubble" id="br">${svg('fast_forward')}<span></span></div>
  <div id="ui">
    <div id="top"><button class="ctl" id="back" title="Exit full view (Esc)">${svg('arrow_back')}</button><div id="title"></div><button class="ctl" id="topMore" title="More">${svg('more_vert')}</button></div>
    <div id="center">
      <button class="skip" id="rw" title="Back 10 seconds (J)">${svg('replay_10')}</button>
      <button class="disc" id="pp" title="Play (Space)">${svg('play_arrow')}</button>
      <button class="skip" id="fw" title="Forward 10 seconds (L)">${svg('forward_10')}</button>
    </div>
    <div id="bottom">
      <div id="row"><span id="time">0:00 / 0:00</span><span id="rate"></span><span class="sp"></span>
        <button class="ctl" id="botMore" title="More">${svg('more_vert')}</button>
        <button class="ctl" id="fs" title="Full view (F)">${svg('fullscreen')}</button></div>
      <div id="seek"><div id="track"></div><div id="buf"></div><div id="played"></div><div id="thumb"></div><div id="tip">0:00</div></div>
    </div>
  </div>
  <div id="spin"></div>
  <div id="idle"><button class="disc">${svg('play_arrow')}</button><span id="len"></span></div>
  <div id="menu"></div>
  <div id="err">${svg('error_outline')}<div id="errText">Video could not be loaded</div><div class="btns"><button class="pill" id="retry">Retry</button><button class="pill fill" id="elsewhere">Open elsewhere</button></div></div>
</div>
<script>
const I = ${icons};
const q = new URLSearchParams(location.search);
const local = q.get('local') === '1';
const accent = q.get('accent');
if (accent && /^#[0-9a-f]{3,8}$/i.test(accent)) document.documentElement.style.setProperty('--accent', accent);
const title = q.get('title') || '';
const $ = (id) => document.getElementById(id);
const v = $('v'), wrap = $('wrap'), pp = $('pp'), seek = $('seek'), menu = $('menu');
$('title').textContent = title;
document.title = title || 'Video';
$('elsewhere').textContent = local ? 'Open in VS Code' : 'Open in browser';
const SRC = ${js(src)};
v.src = SRC;
const post = (m) => { try { parent.postMessage({ antigemPlayer: m }, '*'); } catch (e) {} };
const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return h ? h + ':' + String(m).padStart(2, '0') + ':' + x : m + ':' + x; };
let started = false, full = false, scrub = null, hideT = 0;

// ---- first frame and length before it plays
v.addEventListener('loadedmetadata', () => {
  if (isFinite(v.duration)) { $('len').textContent = fmt(v.duration); $('len').style.display = 'block'; }
  if (!started && v.currentTime === 0) try { v.currentTime = Math.min(0.1, (v.duration || 1) / 10); } catch (e) {}
  tick();
});
const start = () => { if (started) return; started = true; wrap.classList.remove('idle'); $('idle').style.display = 'none'; try { v.currentTime = 0; } catch (e) {} play(); };
$('idle').addEventListener('click', start);

// ---- play / pause / skip
const play = () => { const p = v.play(); if (p) p.catch(() => {}); };
const toggle = () => { if (!started) return start(); if (v.ended) { v.currentTime = 0; play(); } else if (v.paused) play(); else v.pause(); poke(); };
const skip = (d) => { if (!started) return; v.currentTime = Math.max(0, Math.min((v.duration || 0), v.currentTime + d)); poke(); tick(); };
pp.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
$('rw').addEventListener('click', (e) => { e.stopPropagation(); skip(-10); });
$('fw').addEventListener('click', (e) => { e.stopPropagation(); skip(10); });
const icon = () => { pp.innerHTML = v.ended ? I.replay : v.paused ? I.play_arrow : I.pause; pp.title = v.ended ? 'Replay' : v.paused ? 'Play (Space)' : 'Pause (Space)'; };
['play', 'pause', 'ended'].forEach((ev) => v.addEventListener(ev, () => { icon(); poke(); }));
v.addEventListener('waiting', () => wrap.classList.add('buffering'));
['playing', 'canplay', 'seeked'].forEach((ev) => v.addEventListener(ev, () => wrap.classList.remove('buffering')));

// ---- click: play / pause; double-click on a side: skip 10 s; in the middle: full view
let clickT = 0;
const bubbles = { l: { el: $('bl'), n: 0, t: 0 }, r: { el: $('br'), n: 0, t: 0 } };
$('ui').addEventListener('click', (e) => {
  if (e.target.closest('button,#seek,#menu')) return;
  if (menu.classList.contains('on')) { closeMenu(); return; }
  clearTimeout(clickT);
  clickT = setTimeout(toggle, 230);
});
$('ui').addEventListener('dblclick', (e) => {
  if (e.target.closest('button,#seek,#menu')) return;
  clearTimeout(clickT);
  const x = e.clientX / innerWidth;
  if (x > 0.33 && x < 0.67) { setFull(!full); return; }
  const side = x <= 0.33 ? 'l' : 'r', b = bubbles[side], o = bubbles[side === 'l' ? 'r' : 'l'];
  o.n = 0; o.el.classList.remove('on');
  b.n += 10; b.el.querySelector('span').textContent = b.n + ' seconds'; b.el.classList.add('on');
  clearTimeout(b.t); b.t = setTimeout(() => { b.el.classList.remove('on'); b.n = 0; }, 700);
  skip(side === 'l' ? -10 : 10);
});

// ---- controls hide while playing
const poke = () => { wrap.classList.remove('hide'); clearTimeout(hideT); if (!v.paused && !scrub && !menu.classList.contains('on')) hideT = setTimeout(() => wrap.classList.add('hide'), 2600); };
wrap.addEventListener('mousemove', poke);
wrap.addEventListener('mouseleave', () => { if (!v.paused && !scrub && !menu.classList.contains('on')) wrap.classList.add('hide'); });

// ---- time and seek bar
const tick = () => {
  const d = v.duration || 0, t = scrub != null ? scrub * d : v.currentTime;
  $('time').textContent = fmt(t) + ' / ' + fmt(d);
  const f = d ? Math.min(1, t / d) : 0;
  $('played').style.width = f * 100 + '%'; $('thumb').style.left = f * 100 + '%';
  let b = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) b = Math.max(b, v.buffered.end(i));
  $('buf').style.width = (d ? Math.min(1, b / d) : 0) * 100 + '%';
};
['timeupdate', 'progress', 'durationchange', 'seeking'].forEach((ev) => v.addEventListener(ev, tick));
const frac = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))); };
seek.addEventListener('pointermove', (e) => { const f = frac(e); $('tip').style.left = f * 100 + '%'; $('tip').textContent = fmt(f * (v.duration || 0)); if (scrub != null) { scrub = f; tick(); } });
seek.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (!started) start(); seek.setPointerCapture(e.pointerId); seek.classList.add('drag'); scrub = frac(e); tick(); poke(); });
const endScrub = () => { if (scrub == null) return; v.currentTime = scrub * (v.duration || 0); scrub = null; seek.classList.remove('drag'); tick(); poke(); };
seek.addEventListener('pointerup', endScrub);
seek.addEventListener('pointercancel', endScrub);
seek.addEventListener('click', (e) => e.stopPropagation());

// ---- full view (the chat view; VS Code allows no real full screen in a webview)
const setFull = (on) => { full = on; wrap.classList.toggle('full', on); $('fs').innerHTML = on ? I.fullscreen_exit : I.fullscreen; $('fs').title = on ? 'Exit full view (F)' : 'Full view (F)'; post(on ? 'full' : 'unfull'); poke(); };
$('fs').addEventListener('click', (e) => { e.stopPropagation(); setFull(!full); });
$('back').addEventListener('click', (e) => { e.stopPropagation(); setFull(false); });
addEventListener('message', (e) => { if (e.source === parent && e.data && typeof e.data.antigemPlayerFull === 'boolean' && e.data.antigemPlayerFull !== full) { full = !full; wrap.classList.toggle('full', full); $('fs').innerHTML = full ? I.fullscreen_exit : I.fullscreen; } });

// ---- menu: speed, mute, save, open elsewhere
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const speedLabel = (s) => s + '×';
const closeMenu = () => { menu.classList.remove('on'); poke(); };
const item = (ic, label, val, fn) => { const b = document.createElement('button'); b.className = 'mi'; b.innerHTML = (ic ? I[ic] : '<span class="chk"></span>') + '<span>' + label + '</span>' + (val ? '<span class="v">' + val + '</span>' : ''); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
const showMain = () => {
  menu.innerHTML = '';
  menu.append(item('speed', 'Playback speed', speedLabel(v.playbackRate), showSpeed));
  menu.append(item(v.muted ? 'volume_up' : 'volume_off', v.muted ? 'Unmute' : 'Mute', 'M', () => { v.muted = !v.muted; closeMenu(); }));
  const s = document.createElement('div'); s.className = 'sep'; menu.append(s);
  menu.append(item('download', 'Save a copy…', '', () => { post('save'); closeMenu(); }));
  menu.append(item('open_in_new', local ? 'Open in VS Code' : 'Open in browser', '', () => { v.pause(); post('open'); closeMenu(); }));
};
const showSpeed = () => {
  menu.innerHTML = '';
  for (const sp of SPEEDS) {
    const b = item(null, speedLabel(sp), '', () => { v.playbackRate = sp; $('rate').textContent = speedLabel(sp); $('rate').style.display = sp === 1 ? 'none' : 'inline'; closeMenu(); });
    if (sp === v.playbackRate) b.querySelector('.chk').innerHTML = I.check;
    menu.append(b);
  }
};
const openMenu = (e) => { e.stopPropagation(); if (menu.classList.contains('on')) return closeMenu(); showMain(); menu.classList.add('on'); clearTimeout(hideT); wrap.classList.remove('hide'); };
$('botMore').addEventListener('click', openMenu);
$('topMore').addEventListener('click', openMenu);

// ---- keyboard
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
  else if (k === 'arrowleft') { e.preventDefault(); skip(-5); }
  else if (k === 'arrowright') { e.preventDefault(); skip(5); }
  else if (k === 'j') skip(-10);
  else if (k === 'l') skip(10);
  else if (k === 'f') setFull(!full);
  else if (k === 'm') { v.muted = !v.muted; poke(); }
  else if (k === 'escape') { if (menu.classList.contains('on')) closeMenu(); else if (full) setFull(false); }
});
wrap.addEventListener('pointerdown', () => wrap.focus({ preventScroll: true }));

// ---- errors
v.addEventListener('error', () => {
  const m = v.error && v.error.message ? v.error.message : '';
  $('errText').textContent = 'This video could not be loaded' + (m ? ' (' + m + ')' : '') + '.';
  $('err').style.display = 'flex'; $('idle').style.display = 'none';
});
$('retry').addEventListener('click', () => { $('err').style.display = 'none'; started = false; wrap.classList.add('idle'); $('idle').style.display = 'flex'; v.src = SRC; v.load(); });
$('elsewhere').addEventListener('click', () => post('open'));

if (q.get('autoplay') === '1') start();
icon(); tick();
</script></body></html>`;
}
