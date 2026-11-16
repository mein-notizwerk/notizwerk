'use strict';
/* Notizwerk – Erweiterungen: Rückgängig, Versionen, PDF-Folien, Texterkennung, Anhänge,
   Tonaufnahmen, Formeln, Web-Clipper, Teilen, Unterabschnitte und Abschnittssperre. */

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/';
const scripts = {};
const loadScript = url => scripts[url] ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = () => { delete scripts[url]; rej(new Error('offline')); }; document.head.append(s); });
function progress(text) { // Hinweis, der stehen bleibt, bis er geschlossen wird
  const t = h('<div class="toast"><span></span></div>'); t.firstChild.textContent = text; $('#toasts').append(t);
  return { set: x => t.firstChild.textContent = x, done: () => t.remove() };
}
const fmtSize = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const lockedNow = () => document.body.classList.contains('locked') && (toast('Dieser Abschnitt ist gesperrt.'), true);

// ---------- Rückgängig / Wiederholen ----------
// Jeder Schritt hält die Struktur (Notizbücher → Abschnitte → Seiten, flach kopiert) und den Inhalt der gerade gezeigten Seite.
const Hist = (() => {
  let stack = [], idx = -1, t = null, busy = false, last = null;
  const snapPage = p => ({ ref: p, id: p.id, title: p.title, paper: p.paper, blocks: p.blocks.map(b => ({ ...b })), strokes: p.strokes.slice() });
  const samePage = (a, b) => a.ref === b.ref && a.title === b.title && a.paper === b.paper && a.blocks.length === b.blocks.length && a.strokes.length === b.strokes.length
    && a.strokes.every((s, i) => s === b.strokes[i]) && a.blocks.every((x, i) => { const y = b.blocks[i]; return x.id === y.id && x.x === y.x && x.y === y.y && x.w === y.w && x.html === y.html; });
  function take(page) {
    const struct = state.notebooks.map(n => ({ n, name: n.name, color: n.color, secs: n.sections.map(s => ({ s, name: s.name, color: s.color, lvl: s.lvl || 0, lock: s.lock || '', pages: s.pages.slice(), lvls: s.pages.map(p => p.lvl || 0) })) }));
    const key = JSON.stringify([struct.map(x => [x.n.id, x.name, x.color, x.secs.map(y => [y.s.id, y.name, y.color, y.lvl, y.lock, y.pages.map(p => p.id), y.lvls])]), state.trash.map(x => x.page.id)]);
    return { page: snapPage(page), struct, key, trash: state.trash.slice(), ui: { nb: state.ui.nb, sec: state.ui.sec, page: state.ui.page } };
  }
  function commit() {
    clearTimeout(t); t = null; if (busy || !state) return;
    const s = take(last || pageOf()), prev = stack[idx];
    if (prev && prev.key === s.key && samePage(prev.page, s.page)) return;
    if (prev && prev.key === s.key && prev.page.ref !== s.page.ref) s.nav = true;       // nur die Seite gewechselt
    if (prev && prev.page.ref === s.page.ref && !samePage(prev.page, s.page)) Versions.note(prev.page);
    stack.length = idx + 1; stack.push(s); if (stack.length > 150) stack.shift(); idx = stack.length - 1;
  }
  function apply(s) {
    busy = true; clearTimeout(t); t = null;
    const stay = state.ui.page === s.ui.page, sl = scroller.scrollLeft, st = scroller.scrollTop;
    state.notebooks = s.struct.map(x => {
      x.n.name = x.name; x.n.color = x.color;
      x.n.sections = x.secs.map(y => { Object.assign(y.s, { name: y.name, color: y.color, lvl: y.lvl, lock: y.lock, pages: y.pages.slice() }); y.s.pages.forEach((p, i) => p.lvl = y.lvls[i]); return y.s; });
      return x.n;
    });
    state.trash = s.trash.slice();
    const p = s.page.ref;
    if (!samePage(snapPage(p), s.page)) Object.assign(p, { title: s.page.title, paper: s.page.paper, blocks: s.page.blocks.map(b => ({ ...b })), strokes: s.page.strokes.slice(), updated: Date.now() });
    Object.assign(state.ui, s.ui);
    last = null; render(); if (stay) scroller.scrollTo(sl, st); save();
    busy = false; last = pageOf();
  }
  return {
    mark() { if (busy) return; clearTimeout(t); t = setTimeout(commit, 350); },
    flush: commit,
    leave() { if (t) commit(); },
    enter() { last = pageOf(); commit(); },
    reset() { clearTimeout(t); t = null; stack = []; idx = -1; last = null; if (state) commit(); },
    undo() { commit(); if (idx <= 0) return toast('Nichts mehr rückgängig zu machen.'); idx--; while (idx > 0 && stack[idx + 1].nav) idx--; apply(stack[idx]); },
    redo() { commit(); if (idx >= stack.length - 1) return toast('Nichts zu wiederholen.'); idx++; apply(stack[idx]); }
  };
})();
function pageLeaving() { Hist.leave(); }
function pageShown() { setSel(null); Hist.enter(); }

// ---------- Versionsverlauf (pro Gerät) ----------
// Bevor eine Seite geändert wird, wird ihr alter Stand aufgehoben – höchstens alle 10 Minuten einer.
const Versions = {
  lastAt: {},
  async note(snap) {
    const now = Date.now(), id = snap.id;
    if (now - (this.lastAt[id] || 0) < 10 * 60e3 || (!snap.title && !snap.blocks.length && !snap.strokes.length)) return;
    this.lastAt[id] = now;
    try {
      let list = (await DB.get('ver:' + id)) || [];
      if (list.length && now - list[list.length - 1].at < 10 * 60e3) return;
      const size = snap.blocks.reduce((n, b) => n + b.html.length, 0) + snap.strokes.reduce((n, s) => n + s.p.length * 6, 0);
      list.push({ at: now, title: snap.title, paper: snap.paper, blocks: snap.blocks, strokes: snap.strokes });
      list = list.slice(size > 2e6 ? -3 : -15);     // große Seiten (PDF-Folien): nur wenige Stände
      await DB.set('ver:' + id, list);
    } catch (e) { console.warn('Version nicht gespeichert', e); }
  },
  async show() {
    if (lockedNow()) return;
    const p = pageOf(), list = ((await DB.get('ver:' + p.id)) || []).slice().reverse();
    const box = h('<div class="modal"><h3>Frühere Versionen dieser Seite</h3><div class="vers"></div><p>Aufgehoben wird der Stand vor einer Änderung, höchstens alle 10 Minuten – nur auf diesem Gerät.</p><div class="row"><button class="primary">Fertig</button></div></div>');
    $('.vers', box).innerHTML = list.length ? list.map((v, i) => {
      const text = v.blocks.map(b => parser.parseFromString(b.html, 'text/html').body.textContent).join(' ').replace(/\s+/g, ' ').trim();
      return `<div class="tr"><div><b>Stand vom ${fmtDate(v.at)}</b><small>${esc(v.title || 'Unbenannte Seite')} · ${esc(text.slice(0, 80)) || (v.strokes.length ? 'Zeichnung' : 'leer')}</small></div><button class="ghost" data-i="${i}">Wiederherstellen</button></div>`;
    }).join('') : '<p>Für diese Seite gibt es noch keine früheren Versionen.</p>';
    box.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const v = b.dataset.i && list[+b.dataset.i]; closeOverlay(); if (!v) return;
      Hist.flush();
      Object.assign(p, { title: v.title || '', paper: v.paper || 'blank', blocks: v.blocks.map(x => ({ ...x, html: sanitize(String(x.html || '')) })), strokes: v.strokes.slice() });
      touch(p); render(); toast('Version wiederhergestellt', 'Rückgängig', () => Hist.undo());
    });
    openOverlay(box);
  }
};

// ---------- Einfügen an der Schreibmarke ----------
function htmlOf(bb) { // gespeichert wird die Formel als LaTeX-Text, nicht das gerenderte Bild
  let root = bb;
  if (bb.querySelector('.math,img[data-att]')) {
    root = bb.cloneNode(true); for (const m of $$('.math', root)) m.textContent = m.dataset.tex || '';
    for (const i of $$('img[data-att]', root)) { i.removeAttribute('src'); i.removeAttribute('style'); i.removeAttribute('class'); }
  }
  return root.innerHTML.replace(/cloze revealed/g, 'cloze');
}
function placer(w = 460) { // merkt sich die Schreibmarke; fügt später dort ein oder legt einen neuen Kasten an
  const bb = activeBB(), sl = getSelection(), range = bb && sl.rangeCount ? sl.getRangeAt(0).cloneRange() : null;
  return html => {
    if (bb && bb.isConnected && range) { bb.focus(); sl.removeAllRanges(); sl.addRange(range); exec('insertHTML', html); decorate(bb); syncBlock(bb); return; }
    const [x, y] = viewPos(); newBlock(x, y, `<div>${html}</div><div><br></div>`, w); touch(pageOf()); fitCanvas();
  };
}

// ---------- Formeln (LaTeX, dargestellt mit KaTeX als MathML) ----------
const KATEX = CDN + 'KaTeX/0.16.9/katex.min.js';
function renderMath(m) {
  const done = () => { try { m.innerHTML = katex.renderToString(m.dataset.tex || '', { output: 'mathml', throwOnError: false }); } catch { m.textContent = m.dataset.tex || ''; } };
  if (window.katex) done(); else loadScript(KATEX).then(done, () => { });
}
function decorate(el) { for (const m of $$('.math', el)) renderMath(m); for (const i of $$('img[data-att]', el)) { if (i.dataset.ar) i.style.aspectRatio = i.dataset.ar; i.style.width = '100%'; lazy.observe(i); } }

// ---------- PDF-Folien als Hintergrund ----------
const PDFJS = CDN + 'pdf.js/3.11.174/';
async function pdfLib() { await loadScript(PDFJS + 'pdf.min.js'); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; }
// Ausdruck: Auf der Notizseite steht pro PDF-Seite nur ein Verweis (Datei + Seitenzahl + erkannter Text).
// Das PDF selbst liegt einmal als Anhang vor; jedes Gerät zeichnet die Seiten daraus selbst.
async function insertPdf(file) {
  if (lockedNow()) return;
  const note = progress('PDF wird gelesen …');
  try {
    await pdfLib();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise, n = pdf.numPages, W = 720, id = uid();
    await DB.set('att:' + id, { name: file.name, type: 'application/pdf', size: file.size, blob: file });
    pdfs.set(id, Promise.resolve(pdf));
    const page = pageOf(); if (!page.title) page.title = file.name.replace(/\.pdf$/i, '');
    let y = 24;
    for (const b of page.blocks) { const el = $(`.block[data-id="${b.id}"]`, canvas); y = Math.max(y, b.y + (el ? el.offsetHeight : 60) + 28); }
    for (const s of page.strokes) for (let i = 1; i < s.p.length; i += 2) y = Math.max(y, s.p[i] + 28);
    for (let i = 1; i <= n; i++) {
      if (i % 10 === 0) note.set(`PDF wird eingefügt … Seite ${i} von ${n}`);
      const pg = await pdf.getPage(i), vp = pg.getViewport({ scale: 1 }), ar = r2(vp.width / vp.height);
      const text = (await pg.getTextContent()).items.map(t => t.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      page.blocks.push({ id: uid(), x: 40, y, w: W, html: `<div><img data-att="${id}" data-pg="${i}" data-ar="${ar}" alt="${esc(text)}"></div>` });
      y += Math.round((W - 22) / ar) + 30;
    }
    page.updated = Date.now(); save(); if (pageOf() === page) renderPage(); renderNav(); Files.queue(id, file.size);
    toast(`${n} ${n === 1 ? 'Seite' : 'Seiten'} eingefügt – im Reiter „Zeichnen“ kannst du darauf schreiben`);
  } catch (e) { console.error(e); toast(e.message === 'offline' ? 'Für PDFs wird beim ersten Mal eine Internetverbindung gebraucht.' : 'Das PDF konnte nicht gelesen werden.'); }
  note.done();
}
$('#pdfFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) insertPdf(f); };

// ---------- Texterkennung in Bildern (läuft auf dem Gerät) ----------
async function ocrPage() {
  if (lockedNow()) return;
  await Promise.all($$('.bb img[data-att]', canvas).map(showImg));
  const imgs = $$('.bb img', canvas).filter(i => !i.alt && i.src); if (!imgs.length) return toast('Auf dieser Seite gibt es kein Bild ohne erkannten Text.');
  const note = progress('Texterkennung wird geladen …'); let found = 0;
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    const worker = await Tesseract.createWorker(['deu', 'eng']);
    for (let i = 0; i < imgs.length; i++) {
      note.set(`Text wird erkannt … Bild ${i + 1} von ${imgs.length}`);
      const text = (await worker.recognize(imgs[i].src)).data.text.replace(/\s+/g, ' ').trim().slice(0, 5000);
      if (text && imgs[i].isConnected) { imgs[i].alt = text; found++; syncBlock(imgs[i].closest('.bb')); }
    }
    await worker.terminate();
    toast(found ? `Text in ${found} ${found === 1 ? 'Bild' : 'Bildern'} erkannt – die Suche findet ihn jetzt.` : 'In den Bildern wurde kein Text gefunden.');
  } catch (e) { console.error(e); toast('Die Texterkennung konnte nicht geladen werden (Internet nötig).'); }
  note.done();
}

// ---------- Google Drive als Ablage ----------
// Die Verbindung gilt für das Konto, nicht für das Gerät: Das Dauer-Token liegt in Supabase (Tabelle nw_google),
// die Edge-Function "gdrive" tauscht es gegen kurzlebige Zugriffstoken. Die App sieht nur Dateien, die sie selbst angelegt hat.
const Drive = (() => {
  const cfg = () => window.NOTIZWERK_GOOGLE || {}, api = () => localStorage.getItem('nw:gapi') || 'https://www.googleapis.com';
  // immer dieselbe Rücksprung-Adresse – auch wenn die App über …/index.html (Dock, Home-Bildschirm) geöffnet wurde
  const here = () => location.origin + location.pathname.replace(/index\.html$/, '');
  let tok = null, folderId = null;
  const on = () => localStorage.getItem('nw:gdrive') === '1';
  const setOn = v => { v ? localStorage.setItem('nw:gdrive', '1') : localStorage.removeItem('nw:gdrive'); if (!v) { tok = null; folderId = null; } };
  async function token() {
    if (tok && tok.exp - Date.now() > 60e3) return tok.t;
    const j = await Sync.fn('gdrive', { action: 'token' }); if (j === null) return null;        // nicht angemeldet
    if (!j.access_token) { setOn(false); return null; }
    tok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; setOn(true); return tok.t;
  }
  async function g(path, opt = {}) {
    const t = await token(); if (!t) return null;
    const r = await fetch(path.startsWith('http') ? path : api() + path, { ...opt, headers: { Authorization: 'Bearer ' + t, ...(opt.headers || {}) } });
    if (r.status === 401) tok = null;
    if (!r.ok) throw new Error('Google Drive: HTTP ' + r.status);
    return r;
  }
  const list = async q => { const r = await g('/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q + ' and trashed=false')); return r ? (await r.json()).files || [] : null; };
  const find = async id => { const f = await list(`appProperties has { key='nwid' and value='${id}' }`); return f && f[0] ? f[0].id : null; };
  async function folder() {
    if (folderId) return folderId;
    const f = await list("appProperties has { key='nw' and value='root' } and mimeType='application/vnd.google-apps.folder'");
    if (f && f[0]) return folderId = f[0].id;
    const r = await g('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Notizwerk', mimeType: 'application/vnd.google-apps.folder', appProperties: { nw: 'root' } }) });
    return folderId = (await r.json()).id;
  }
  async function put(id, blob, name) { // true = liegt in Drive, null = nicht verbunden
    if (!await token()) return null;
    if (await find(id)) return true;
    const type = blob.type || 'application/octet-stream', meta = JSON.stringify({ name: name || id, parents: [await folder()], appProperties: { nwid: id } });
    if (blob.size <= 4e6) { // klein: ein einziger Aufruf
      const b = 'nw' + uid() + uid(), body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`]);
      await g('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
    } else {                // groß: erst anmelden, dann die Daten schicken
      const r = await g('/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type }, body: meta });
      const loc = r.headers.get('Location'); if (!loc) throw new Error('Google Drive: keine Upload-Adresse');
      await g(loc, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
    }
    return true;
  }
  async function get(id) { const fid = await find(id); if (!fid) return null; return (await g(`/drive/v3/files/${fid}?alt=media`)).blob(); }
  function connect() {
    if (!cfg().clientId) return toast('Google Drive ist noch nicht eingerichtet.');
    const state = uid() + uid(); localStorage.setItem('nw:gstate', state);
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: cfg().clientId, redirect_uri: here(), response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent', state });
  }
  async function finish(code, state) { // Rückkehr von Google: Code gegen Token tauschen (macht die Edge-Function)
    if (state !== localStorage.getItem('nw:gstate')) return toast('Die Verbindung mit Google Drive wurde abgebrochen.');
    localStorage.removeItem('nw:gstate');
    try {
      const j = await Sync.fn('gdrive', { action: 'connect', code, redirect_uri: here() });
      if (!j?.access_token) throw new Error(j === null ? 'Bitte zuerst bei Notizwerk-Sync anmelden.' : 'keine Antwort');
      tok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; setOn(true);
      toast('Google Drive ist verbunden – Dateien, Fotos und PDFs liegen ab jetzt dort.'); Files.run();
    } catch (e) { console.warn(e); toast('Google Drive konnte nicht verbunden werden: ' + e.message); }
  }
  async function start() {
    const q = new URLSearchParams(location.search);
    if (q.get('code') || q.get('error')) { history.replaceState(null, '', location.pathname); if (q.get('code')) return finish(q.get('code'), q.get('state')); toast('Die Verbindung mit Google Drive wurde abgebrochen' + (q.get('error') === 'access_denied' ? '.' : ': ' + q.get('error'))); }
    if (cfg().clientId && Sync.loggedIn) token().catch(() => { }); // ist das Konto (vielleicht auf einem anderen Gerät) schon verbunden?
  }
  function panel(el) {
    if (!cfg().clientId) { el.innerHTML = '<p style="font-size:12px"><b>Google Drive:</b> noch nicht eingerichtet. Dateien liegen im Supabase-Speicher.</p>'; return; }
    el.innerHTML = on()
      ? '<p style="font-size:12px"><b>Google Drive: verbunden.</b> Dateien, Fotos und PDFs liegen im Drive-Ordner „Notizwerk“. <button type="button" class="ghost" data-g="off" style="padding:2px 8px">Trennen</button></p>'
      : '<p style="font-size:12px"><b>Google Drive: nicht verbunden.</b> Verbinde es einmal – das gilt dann für alle deine Geräte. <button type="button" class="ghost" data-g="on" style="padding:2px 8px">Verbinden</button></p>';
    el.onclick = async e => {
      const b = e.target.closest('[data-g]'); if (!b) return;
      if (b.dataset.g === 'on') return connect();
      if (!await confirmBox('Google Drive trennen?', 'Die Dateien bleiben in deinem Drive. Fotos und PDFs, die dort liegen, lassen sich danach aber nur noch auf Geräten öffnen, die sie schon geladen haben.', 'Trennen')) return;
      try { await Sync.fn('gdrive', { action: 'disconnect' }); } catch (e) { console.warn(e); }
      setOn(false); toast('Google Drive getrennt.');
    };
  }
  return { on, put, get, start, panel, token };
})();
// Ablage: Google Drive, wenn verbunden – sonst der Supabase-Speicher (bis 50 MB je Datei).
const Store = {
  async put(id, blob, name) { if (Drive.on()) return Drive.put(id, blob, name); return blob.size > Files.MAX ? true : Sync.file(id, blob); },
  async get(id) { let b = null; if (Drive.on()) b = await Drive.get(id).catch(e => (console.warn(e), null)); return b || Sync.file(id); }
};

// ---------- Ausgelagerte Bilder und PDF-Seiten anzeigen ----------
// <img data-att="ID"> = Foto, <img data-att="ID" data-pg="3"> = Seite 3 eines PDFs. Das Bild entsteht erst auf dem Gerät.
const blobs = new Map(), urls = new Map(), pdfs = new Map();
function attBlob(id) { // lokal vorhanden? sonst aus der Ablage holen und hier aufheben
  if (!blobs.has(id)) blobs.set(id, (async () => {
    const r = await DB.get('att:' + id).catch(() => null); if (r?.blob) return r.blob;
    const b = await Store.get(id).catch(() => null);
    if (b) DB.set('att:' + id, { name: '', type: b.type, size: b.size, blob: b }).catch(() => { }); else blobs.delete(id);
    return b;
  })());
  return blobs.get(id);
}
async function pdfPage(id, blob, n) {
  await pdfLib();
  if (!pdfs.has(id)) pdfs.set(id, blob.arrayBuffer().then(d => pdfjsLib.getDocument({ data: d }).promise));
  const pg = await (await pdfs.get(id)).getPage(n), vp = pg.getViewport({ scale: 1400 / pg.getViewport({ scale: 1 }).width }), c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', .85)); c.width = c.height = 0; return URL.createObjectURL(out);
}
function showImg(img) {
  const id = img.dataset.att, pg = +img.dataset.pg || 0, key = id + ':' + pg;
  if (!urls.has(key)) urls.set(key, attBlob(id).then(b => b ? (pg ? pdfPage(id, b, pg) : URL.createObjectURL(b)) : null).catch(e => (console.warn(e), null)).then(u => { if (!u) urls.delete(key); return u; }));
  return urls.get(key).then(u => { img.classList.toggle('missing', !u); if (u && img.src !== u) img.src = u; return !!u; });
}
const lazy = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { lazy.unobserve(e.target); showImg(e.target); } }, { root: scroller, rootMargin: '1200px' });
canvas.addEventListener('click', async e => { // fehlendes Bild antippen = noch einmal versuchen
  const i = e.target.closest?.('img.missing'); if (!i) return;
  if (!await showImg(i)) toast(navigator.onLine ? 'Dieses Bild liegt noch nicht in der Ablage – es wird vom anderen Gerät noch hochgeladen.' : 'Ohne Internet kann das Bild nicht geladen werden.');
});
// Neues Foto: mit Google Drive wird es ausgelagert, sonst steht es wie bisher direkt in der Notiz.
async function imgHtml(dataUrl) {
  if (!Drive.on()) return `<img src="${dataUrl}">`;
  const blob = await (await fetch(dataUrl)).blob(), im = new Image(); im.src = dataUrl; await im.decode();
  const id = uid(); await DB.set('att:' + id, { name: 'Bild ' + fmtDate(Date.now()).replace(/[.:]/g, '-') + '.' + (blob.type.split('/')[1] || 'jpg'), type: blob.type, size: blob.size, blob });
  Files.queue(id, blob.size);
  return `<img data-att="${id}" data-ar="${r2(im.width / im.height)}">`;
}

// ---------- Dateianhänge und Tonaufnahmen ----------
// Die Datei liegt lokal in IndexedDB (att:<id>) und wird zusätzlich in den Cloud-Speicher hochgeladen.
// Andere Geräte laden sie beim ersten Öffnen herunter.
const Files = {
  MAX: 50e6, busy: false,
  async queue(id, size) {
    if (size > this.MAX && !Drive.on()) return toast('Größer als 50 MB – ohne Google Drive bleibt diese Datei nur auf diesem Gerät.');
    await DB.set('att-pending', [...((await DB.get('att-pending')) || []), id]); this.run();
  },
  async run() { // lädt alles hoch, was noch aussteht; bricht ab, wenn nicht angemeldet oder offline
    if (this.busy || !navigator.onLine || typeof Sync === 'undefined') return; this.busy = true;
    try {
      if (!await DB.get('att-migrated')) { // einmalig: Anhänge aus der Zeit vor der Synchronisation nachreichen
        const ids = new Set(); for (const { page } of allPages()) for (const b of page.blocks) for (const m of b.html.matchAll(/data-att="([a-z0-9]+)"/gi)) ids.add(m[1]);
        const have = []; for (const id of ids) { const r = await DB.get('att:' + id); if (r?.blob && (r.size <= this.MAX || Drive.on())) have.push(id); }
        await DB.set('att-pending', [...new Set([...((await DB.get('att-pending')) || []), ...have])]); await DB.set('att-migrated', true);
      }
      for (const id of (await DB.get('att-pending')) || []) {
        const r = await DB.get('att:' + id);
        if (r?.blob && !await Store.put(id, r.blob, r.name)) break;
        await DB.set('att-pending', ((await DB.get('att-pending')) || []).filter(x => x !== id));
      }
    } catch (e) { console.warn('Anhang-Upload:', e); }
    this.busy = false;
  }
};
setInterval(() => Files.run(), 60e3); addEventListener('online', () => Files.run()); setTimeout(() => Files.run(), 4000);
const attHtml = (id, label) => `<span class="att" data-att="${id}" contenteditable="false">${esc(label)}</span>&nbsp;`;
function pick(title, opts) { // Auswahl-Dialog; liefert den Schlüssel der gewählten Möglichkeit oder null
  return new Promise(res => {
    let done = false; const fin = v => { if (done) return; done = true; res(v); closeOverlay(); };
    const box = h(`<div class="modal"><h3>${esc(title)}</h3>${opts.map(o => `<button class="choice" data-k="${o.k}"><b>${esc(o.label)}</b><small>${esc(o.text)}</small></button>`).join('')}<div class="row"><button class="ghost">Abbrechen</button></div></div>`);
    box.onclick = e => { const b = e.target.closest('button'); if (b) fin(b.dataset.k || null); };
    openOverlay(box, () => fin(null));
  });
}
// Fragt bei PDFs und Fotos, ob der Inhalt sichtbar auf die Seite soll oder nur ein Link zur Datei.
async function addFiles(files, put = placer()) {
  if (lockedNow()) return;
  for (const f of files) {
    if (f.size > 300e6) { toast(`„${f.name}“ ist zu groß (höchstens 300 MB).`); continue; }
    const head = `„${f.name}“ (${fmtSize(f.size)}) einfügen`, local = f.size > Files.MAX && !Drive.on() ? ' Über 50 MB: bleibt ohne Google Drive nur auf diesem Gerät.' : '';
    let how = 'att';
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) how = await pick(head, [
      { k: 'print', label: 'Als Ausdruck', text: 'Jede Seite ist auf der Notizseite zu sehen. Du kannst darauf schreiben, der Text ist durchsuchbar. Gespeichert wird nur das PDF selbst, einmal.' + local },
      { k: 'att', label: 'Nur als Link', text: 'In der Notiz steht ein kleiner Eintrag, das PDF öffnet sich beim Antippen. Die Notiz bleibt klein und schnell.' + local }]);
    else if (/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) how = await pick(head, [
      { k: 'img', label: 'Als Bild anzeigen', text: 'Das Foto ist direkt in der Notiz sichtbar. Es wird dafür verkleinert, meist auf 0,1–0,5 MB.' },
      { k: 'att', label: 'Nur als Link', text: 'In der Notiz steht ein kleiner Eintrag, das Foto bleibt in Originalgröße erhalten und öffnet sich beim Antippen.' + local }]);
    if (!how) continue;
    if (how === 'print') { await insertPdf(f); continue; }
    if (how === 'img') { await insertImage(f); continue; }
    const id = uid();
    try { await DB.set('att:' + id, { name: f.name, type: f.type, size: f.size, blob: f }); } catch { toast('Die Datei konnte nicht gespeichert werden.'); continue; }
    put(attHtml(id, `📎 ${f.name} (${fmtSize(f.size)})`)); Files.queue(id, f.size);
  }
}
$('#anyFile').onchange = e => { const files = [...e.target.files], put = placer(); e.target.value = ''; addFiles(files, put); };
let rec = null;
async function toggleRecording(b) {
  if (rec) return rec.mr.stop();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Dieser Browser kann keine Tonaufnahmen machen.');
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Kein Zugriff auf das Mikrofon.'); }
  const mr = new MediaRecorder(stream, { audioBitsPerSecond: 32000 }), chunks = [], // Sprachqualität: 90 Minuten ≈ 22 MB
     t0 = Date.now(), mm = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    clearInterval(rec.tick); rec = null; stream.getTracks().forEach(t => t.stop()); b.textContent = '● Aufnahme'; b.classList.remove('on');
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/mp4' }), id = uid(), secs = Math.round((Date.now() - t0) / 1000);
    try { await DB.set('att:' + id, { name: `Aufnahme ${fmtDate(t0)}`, audio: true, type: blob.type, size: blob.size, blob }); } catch { return toast('Die Aufnahme konnte nicht gespeichert werden.'); }
    placer()(attHtml(id, `🎙 Aufnahme ${fmtDate(t0)} · ${mm(secs)}`)); Files.queue(id, blob.size);
  };
  mr.start(5000); b.classList.add('on');
  rec = { mr, tick: setInterval(() => b.textContent = '■ Stopp ' + mm(Math.round((Date.now() - t0) / 1000)), 500) };
  toast('Aufnahme läuft – zum Beenden noch einmal auf den Knopf tippen.');
}
addEventListener('beforeunload', e => { if (rec) { e.preventDefault(); e.returnValue = ''; } });
async function openAtt(id, label = '') {
  let r = null; try { r = await DB.get('att:' + id); } catch { }
  if (!r?.blob) { // auf diesem Gerät noch nicht vorhanden → aus der Cloud holen und hier aufheben
    const note = progress('Datei wird geladen …'); let blob = null;
    try { blob = await Store.get(id); } catch (e) { console.warn(e); }
    note.done();
    if (!blob) return toast(navigator.onLine ? 'Diese Datei ist (noch) nicht in der Cloud – sie liegt nur auf dem Gerät, auf dem sie eingefügt wurde.' : 'Ohne Internet kann die Datei nicht geladen werden.');
    r = { name: label.replace(/^\S+\s/, '').replace(/\s\([\d,]+ (MB|KB)\)$/, '') || 'Datei', audio: label.startsWith('🎙'), type: blob.type, size: blob.size, blob };
    try { await DB.set('att:' + id, r); } catch { }
  }
  const url = URL.createObjectURL(r.blob);
  if (r.audio || /^audio\//.test(r.type)) {
    $('#player')?.remove();
    const box = h('<div id="player"><audio controls autoplay></audio><button title="Schließen">✕</button></div>');
    $('audio', box).src = url; $('button', box).onclick = () => { box.remove(); URL.revokeObjectURL(url); };
    document.body.append(box); return;
  }
  const a = document.createElement('a'); a.href = url; a.download = r.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30e3);
}
canvas.addEventListener('click', async e => {
  const att = e.target.closest('.att'); if (att) { e.preventDefault(); return openAtt(att.dataset.att, att.textContent); }
  const m = e.target.closest('.math'); if (!m || study) return;
  const bb = m.closest('.bb'), tex = await ask('Formel bearbeiten (LaTeX) – leer lassen zum Entfernen', m.dataset.tex || '', 'Übernehmen'); if (tex === null) return;
  if (tex) { m.dataset.tex = tex; renderMath(m); } else m.remove();
  syncBlock(bb);
});

// ---------- Web-Clipper: Lesezeichen, das Titel, Adresse und markierten Text als neue Seite ablegt ----------
function handleClip() {
  if (!location.hash.startsWith('#clip=')) return;
  let c; try { c = JSON.parse(decodeURIComponent(location.hash.slice(6))); } catch { return; }
  history.replaceState(null, '', location.pathname + location.search);
  const p = addPage(String(c.t || 'Web-Notiz').slice(0, 200)), url = String(c.u || '');
  const text = String(c.s || '').slice(0, 20000).split(/\n+/).filter(l => l.trim()).map(l => `<div>${esc(l)}</div>`).join('');
  p.blocks.push({ id: uid(), x: 48, y: 30, w: 640, html: (/^https?:/i.test(url) ? `<div><a href="${esc(url)}">${esc(url)}</a></div><div><br></div>` : '') + (text || '<div><br></div>') });
  go(p.id); toast('Web-Notiz als neue Seite angelegt');
}
addEventListener('hashchange', () => state && handleClip());
function clipperDialog() {
  const app = location.origin + location.pathname;
  const js = `javascript:(()=>{const s=String(getSelection()).slice(0,6000);open(${JSON.stringify(app)}+'#clip='+encodeURIComponent(JSON.stringify({t:document.title,u:location.href,s})))})()`;
  const box = h('<div class="modal"><h3>Web-Clipper</h3><p>Ziehe diesen Knopf in die Lesezeichenleiste deines Browsers. Auf einer Webseite markierst du dann Text und klickst das Lesezeichen – Notizwerk legt daraus eine neue Seite mit Titel, Adresse und Text an.</p><a class="clip">＋ In Notizwerk merken</a><p>Auf iPhone und iPad ist das umständlich. Dort einfach Text kopieren und in eine Seite einfügen.</p><div class="row"><button class="primary">Fertig</button></div></div>');
  const a = $('.clip', box); a.href = js; a.onclick = e => { e.preventDefault(); toast('Nicht klicken, sondern in die Lesezeichenleiste ziehen.'); };
  $('.primary', box).onclick = closeOverlay; openOverlay(box);
}

// ---------- Teilen: die Seite als eigenständige Datei weitergeben ----------
async function sharePage() {
  if (lockedNow()) return;
  const p = pageOf(), title = p.title || 'Unbenannte Seite';
  // ausgelagerte Bilder und PDF-Seiten werden für die Datei fest eingebettet
  await Promise.all($$('.bb img[data-att]', canvas).map(i => showImg(i).then(() => i.decode()).catch(() => { })));
  const blocks = p.blocks.map(b => {
    const bb = $(`.block[data-id="${b.id}"] .bb`, canvas); if (!bb || !bb.querySelector('img[data-att]')) return `<div class="b" style="left:${b.x}px;top:${b.y}px;width:${b.w}px">${b.html}</div>`;
    const c = bb.cloneNode(true), live = $$('img[data-att]', bb);
    $$('img[data-att]', c).forEach((im, k) => {
      const src = live[k]; im.removeAttribute('class'); if (!src.naturalWidth) return;
      const cv = document.createElement('canvas'), f = Math.min(1, 1400 / src.naturalWidth); cv.width = src.naturalWidth * f; cv.height = src.naturalHeight * f;
      cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height); im.src = cv.toDataURL('image/jpeg', .8);
    });
    for (const m of $$('.math', c)) m.textContent = m.dataset.tex || '';
    return `<div class="b" style="left:${b.x}px;top:${b.y}px;width:${b.w}px">${c.innerHTML}</div>`;
  }).join('');
  const html = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;margin:24px;color:#1f2328}h1.t{font-weight:400;margin:0 0 4px}small.t{color:#6b7280}.pg{position:relative;margin-top:18px;width:${canvas.offsetWidth}px;height:${canvas.offsetHeight}px}.b{position:absolute;padding:4px 10px}.b img{max-width:100%}
.b table{border-collapse:collapse;width:100%}.b td,.b th{border:1px solid #ddd;padding:4px 8px}.b ul.todo{list-style:none;padding-left:0}.b ul.todo li::before{content:"☐ "}.b ul.todo li.done::before{content:"☑ "}.b .att{background:#eee;border-radius:6px;padding:1px 8px}
svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;color:#1f2328;pointer-events:none}svg path{fill:none;stroke-linecap:round;stroke-linejoin:round}</style>
<h1 class="t">${esc(title)}</h1><small class="t">Aus Notizwerk · ${fmtDate(Date.now())}</small><div class="pg">${blocks}<svg>${p.strokes.map(s => strokeEl(s).outerHTML).join('')}</svg></div></html>`;
  const name = title.replace(/[\\/:*?"<>|]/g, '_') + '.html', file = new File([html], name, { type: 'text/html' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title }); } catch { } }
  else { download(name, html, 'text/html'); toast('Seite als Datei gespeichert – die kannst du verschicken.'); }
}

// ---------- Unterabschnitte und Abschnittssperre ----------
async function pwHash(salt, pw) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + pw)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function unlockSection(s) {
  const pw = await ask(`Passwort für „${s.name}“`, '', 'Entsperren', 'password'); if (pw === null) return false;
  const [salt, hash] = s.lock.split(':');
  if (await pwHash(salt, pw) !== hash) { toast('Falsches Passwort.'); return false; }
  unlocked.add(s.id); render(); return true;
}
function secExtra(s) {
  const secs = nbOf().sections, i = secs.indexOf(s), setLvl = v => { s.lvl = v; renderNav(); save(); };
  return [
    !s.lvl && i > 0 && { label: 'Zum Unterabschnitt machen →', fn: () => setLvl(1) },
    !!s.lvl && { label: '← Höher stufen', fn: () => setLvl(0) },
    !s.lock && { label: 'Mit Passwort sperren …', fn: async () => {
      if (!crypto?.subtle) return toast('Die Sperre braucht eine sichere Verbindung (https).');
      const pw = await ask('Neues Passwort für diesen Abschnitt', '', 'Weiter', 'password'); if (!pw) return;
      if (await ask('Passwort wiederholen', '', 'Sperren', 'password') !== pw) return toast('Die Passwörter stimmen nicht überein.');
      const salt = uid(); s.lock = salt + ':' + await pwHash(salt, pw); render(); save();
      toast('Abschnitt gesperrt. Achtung: Das ist ein Sichtschutz, keine Verschlüsselung.');
    } },
    !!s.lock && isLocked(s) && { label: 'Entsperren …', fn: () => unlockSection(s) },
    !!s.lock && !isLocked(s) && { label: 'Jetzt sperren', fn: () => { unlocked.delete(s.id); render(); } },
    !!s.lock && { label: 'Sperre entfernen …', fn: async () => { if (isLocked(s) && !await unlockSection(s)) return; s.lock = ''; unlocked.delete(s.id); render(); save(); toast('Sperre entfernt'); } }
  ];
}
$('#unlockBtn').onclick = () => unlockSection(secOf());

// ---------- Menüs ----------
Object.assign(ACT, {
  pdf: () => $('#pdfFile').click(),
  attach: () => lockedNow() || $('#anyFile').click(),
  audio: b => lockedNow() || toggleRecording(b),
  ocr: ocrPage,
  formula: async () => {
    if (lockedNow()) return;
    const put = placer(), tex = await ask('Formel in LaTeX-Schreibweise, z. B. \\frac{a}{b} oder x^2', '', 'Einfügen'); if (!tex) return;
    put(`<span class="math" data-tex="${esc(tex)}" contenteditable="false">${esc(tex)}</span>&nbsp;`);
  },
  file: b => menu(b, [
    { label: 'Seite teilen …', fn: sharePage },
    { label: 'Seite als Markdown exportieren', fn: () => lockedNow() || exportMd() },
    { label: 'Drucken / als PDF sichern', fn: () => print() },
    '-',
    { label: 'Frühere Versionen dieser Seite …', fn: () => Versions.show() },
    { label: `Papierkorb (${state.trash.length})`, fn: showTrash },
    '-',
    { label: 'Backup speichern (alle Notizen)', fn: () => download(`notizwerk-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state), 'application/json') },
    { label: 'Backup laden …', fn: () => $('#jsonFile').click() },
    '-',
    { label: 'Web-Clipper einrichten …', fn: clipperDialog }
  ])
});
