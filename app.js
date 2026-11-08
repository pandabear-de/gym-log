'use strict';
(() => {
  const STORE_KEY = 'gymlog.v1';
  const APP_VERSION = '1.0.0';
  const DAY = 86400000;

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => {
    if (v === '' || v == null) return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const fmtNum = (n) => (n == null ? '' : String(n).replace('.', ','));
  const mmss = (sec) => {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  const shortDate = (ts) => new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtDur = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  };
  const fmtKg = (v) => (v >= 10000 ? (v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' t' : Math.round(v).toLocaleString('de-DE') + ' kg');
  const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v) || null);
  const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

  // ---------- state ----------
  function defaults() {
    return {
      schemaVersion: 1,
      machines: [],
      sessions: [],
      active: null,
      timer: null,
      settings: {
        defaultRest: 90,
        sound: true,
        loudInSilent: false,
        keepAwake: true,
        watchShortcut: false,
        shortcutName: 'Gym Pause',
        lastExport: null,
      },
    };
  }
  function load() {
    const d = defaults();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return d;
      const s = JSON.parse(raw);
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    } catch (e) {
      console.error(e);
      return d;
    }
  }
  let state = load();
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Speichern fehlgeschlagen!');
    }
  }
  try { navigator.storage?.persist?.(); } catch (e) { /* ignore */ }

  const machineById = (id) => state.machines.find((m) => m.id === id);
  const findEx = (exId) => state.active?.exercises.find((e) => e.id === exId) || null;
  const findSet = (exId, setId) => {
    const ex = findEx(exId);
    return { ex, set: ex ? ex.sets.find((s) => s.id === setId) || null : null };
  };
  const newSet = (weight = null, reps = null) => ({ id: uid(), weight, reps, done: false, doneAt: null, restPlanned: null, restTaken: null });

  function machineHistory(machineId) {
    const out = [];
    for (let i = state.sessions.length - 1; i >= 0; i--) {
      const s = state.sessions[i];
      for (const ex of s.exercises) if (ex.machineId === machineId) out.push({ date: s.start, ex });
    }
    return out;
  }
  const lastPerformance = (machineId) => machineHistory(machineId)[0] || null;

  const doneSets = (sets) => sets.filter((s) => s.done);
  function setsSummary(sets) {
    const list = doneSets(sets).length ? doneSets(sets) : sets;
    if (!list.length) return '–';
    const same = list.every((s) => s.weight === list[0].weight && s.reps === list[0].reps);
    const one = (s) => `${s.weight != null ? fmtNum(s.weight) + ' kg' : '–'} × ${s.reps ?? '–'}`;
    if (same && list.length > 1) return `${list.length} Sätze à ${one(list[0])}`;
    return list.map(one).join(' · ');
  }
  function sessionStats(s) {
    let sets = 0, volume = 0;
    for (const ex of s.exercises) for (const x of doneSets(ex.sets)) {
      sets++;
      volume += (x.weight || 0) * (x.reps || 0);
    }
    return { sets, volume };
  }

  // ---------- audio ----------
  let actx = null;
  function setAudioSession(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* ignore */ }
  }
  function unlockAudio() {
    try {
      setAudioSession('ambient');
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const b = actx.createBuffer(1, 1, 22050);
      const src = actx.createBufferSource();
      src.buffer = b;
      src.connect(actx.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
  }
  function beep(freq = 880, dur = 0.15, when = 0, vol = 0.6) {
    if (!actx) return;
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime + when;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  function beepTick() { beep(660, 0.1, 0, 0.35); }
  function beepDone() {
    if (state.settings.loudInSilent) {
      setAudioSession('playback');
      setTimeout(() => setAudioSession('ambient'), 1600);
    }
    beep(880, 0.16, 0);
    beep(880, 0.16, 0.24);
    beep(1320, 0.4, 0.48);
  }
  function buzz(pattern) { try { navigator.vibrate?.(pattern); } catch (e) { /* ignore */ } }

  // ---------- wake lock ----------
  let wakeLock = null;
  async function updateWakeLock() {
    const want = !!state.active && state.settings.keepAwake && document.visibilityState === 'visible';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- rest timer ----------
  function startRest(ex, set) {
    if (state.timer) finalizeRest(state.timer, 'skipped');
    const now = Date.now();
    state.timer = { exId: ex.id, setId: set.id, total: ex.rest, startedAt: now, endsAt: now + ex.rest * 1000, beeped: {}, finished: false, finishedAt: null };
    set.restPlanned = ex.rest;
    unlockAudio();
    if (state.settings.watchShortcut) {
      const name = state.settings.shortcutName || 'Gym Pause';
      const url = `shortcuts://run-shortcut?name=${encodeURIComponent(name)}&input=text&text=${ex.rest}`;
      setTimeout(() => { window.location.href = url; }, 200);
    }
  }
  function finalizeRest(t, how) {
    if (t.finalized) return;
    t.finalized = true;
    const { set } = findSet(t.exId, t.setId);
    if (!set) return;
    const end = how === 'finished' ? t.endsAt : Date.now();
    set.restTaken = Math.max(0, Math.round((end - t.startedAt) / 1000));
    set.restPlanned = t.total;
  }
  function clearTimer() { state.timer = null; save(); updateTimerUI(); }

  function tick() {
    updateElapsed();
    const t = state.timer;
    if (!t) return;
    const rem = (t.endsAt - Date.now()) / 1000;
    if (!t.finished && state.settings.sound) {
      for (const s of [3, 2, 1]) {
        if (rem <= s && rem > s - 1 && !t.beeped[s]) { t.beeped[s] = 1; beepTick(); }
      }
    }
    if (!t.finished && rem <= 0) {
      t.finished = true;
      t.finishedAt = Date.now();
      if (rem > -5) {
        if (state.settings.sound) beepDone();
        buzz([200, 100, 200, 100, 400]);
      }
      finalizeRest(t, 'finished');
      save();
    }
    if (t.finished && Date.now() - t.finishedAt > 8000) { clearTimer(); return; }
    updateTimerUI();
  }

  const RING_C = 2 * Math.PI * 44;
  function updateTimerUI() {
    const el = $('#timer');
    const t = state.timer;
    const show = !!t && !!state.active && route().view === 'training';
    el.hidden = !show;
    document.body.classList.toggle('has-timer', show);
    if (!show) return;
    const rem = Math.max(0, (t.endsAt - Date.now()) / 1000);
    const frac = t.total > 0 ? Math.min(1, rem / t.total) : 0;
    const fg = $('#ring-fg');
    fg.style.strokeDasharray = RING_C;
    fg.style.strokeDashoffset = RING_C * (1 - frac);
    el.classList.toggle('finished', t.finished);
    el.classList.toggle('ending', !t.finished && rem <= 10);
    $('#timer-time').textContent = t.finished ? 'Los!' : mmss(rem);
    const { ex, set } = findSet(t.exId, t.setId);
    if (ex && set) {
      const idx = ex.sets.indexOf(set);
      $('#timer-label').textContent = t.finished ? 'Pause vorbei' : `Pause · ${ex.name}`;
      const next = ex.sets.slice(idx + 1).find((s) => !s.done);
      $('#timer-next').textContent = next
        ? `Nächster: Satz ${ex.sets.indexOf(next) + 1}${next.weight != null ? ` · ${fmtNum(next.weight)} kg × ${next.reps ?? '–'}` : ''}`
        : 'Nächstes Gerät';
    }
    $('#timer-skip').textContent = t.finished ? 'OK' : 'Weiter ›';
  }
  function updateElapsed() {
    const el = $('#elapsed');
    if (el && state.active) el.textContent = fmtDur(Date.now() - state.active.start);
  }

  // ---------- routing / rendering ----------
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [view, id] = h.split('/');
    return { view: view || 'training', id: id ? decodeURIComponent(id) : null };
  }
  let lastRouteKey = '';
  function render() {
    const r = route();
    let html;
    switch (r.view) {
      case 'geraete': html = r.id ? viewMachine(r.id) : viewMachines(); break;
      case 'verlauf': html = r.id ? viewSessionDetail(r.id) : viewHistory(); break;
      case 'mehr': html = viewSettings(); break;
      default: html = state.active ? viewSession() : viewStart();
    }
    const key = r.view + '/' + (r.id || '') + (state.active ? '/a' : '');
    const y = window.scrollY;
    $('#app').innerHTML = html;
    if (key === lastRouteKey) window.scrollTo(0, y); else window.scrollTo(0, 0);
    lastRouteKey = key;
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === r.view));
    updateTimerUI();
    updateElapsed();
  }

  function exportReminder() {
    const last = state.settings.lastExport || 0;
    const pending = state.sessions.filter((s) => s.end > last).length;
    if (!pending || Date.now() - last < 14 * DAY) return '';
    return `<section class="card warn"><span>${pending} ${pending === 1 ? 'Training' : 'Trainings'} noch nicht exportiert</span><button class="btn small" data-action="export">Export</button></section>`;
  }

  function viewStart() {
    const last = state.sessions[state.sessions.length - 1];
    return `
      <h1>Training</h1>
      ${exportReminder()}
      <button class="btn primary big" data-action="start-session">Training starten</button>
      ${last ? `
        <section class="card">
          <h3 style="margin-top:0">Letztes Training</h3>
          <a class="list-item" href="#/verlauf/${last.id}" style="border:none;padding:0;min-height:0">
            <span><b>${fmtDate(last.start)}</b><small>${fmtDur(last.end - last.start)} · ${last.exercises.length} Geräte · ${sessionStats(last).sets} Sätze</small></span><i>›</i>
          </a>
        </section>` : `
        <section class="card">
          <h2>So funktioniert's</h2>
          <ol>
            <li>Training starten und Gerät hinzufügen</li>
            <li>Einstellung, Gewicht und Wiederholungen eintragen</li>
            <li>Nach jedem Satz auf <b>✓</b> tippen – die Pause läuft automatisch</li>
            <li>Beim nächsten Mal sind deine letzten Werte schon eingetragen</li>
          </ol>
        </section>`}`;
  }

  function viewSession() {
    const a = state.active;
    return `
      <div class="session-head">
        <div><h1>Training</h1><p class="muted">seit ${fmtTime(a.start)} · <span id="elapsed"></span></p></div>
        <button class="btn" data-action="finish-session">Beenden</button>
      </div>
      ${a.exercises.length ? a.exercises.map(exerciseCard).join('') : '<p class="empty">Noch kein Gerät. Füge das erste hinzu.</p>'}
      <button class="btn primary big" data-action="open-picker">+ Gerät hinzufügen</button>
      <button class="btn danger-text" data-action="discard-session">Training verwerfen</button>`;
  }

  function exerciseCard(ex) {
    const last = lastPerformance(ex.machineId);
    const allDone = ex.sets.length && ex.sets.every((s) => s.done);
    const rows = ex.sets.map((s, i) => `
      <div class="set-row ${s.done ? 'done' : ''}" data-set="${s.id}">
        <span class="set-no">${i + 1}</span>
        <label class="field"><input type="text" inputmode="decimal" enterkeyhint="next" data-field="weight" value="${fmtNum(s.weight)}" placeholder="–" aria-label="Gewicht Satz ${i + 1}"><span>kg</span></label>
        <label class="field"><input type="text" inputmode="numeric" enterkeyhint="done" data-field="reps" value="${s.reps ?? ''}" placeholder="–" aria-label="Wiederholungen Satz ${i + 1}"><span>Wdh.</span></label>
        <button class="check" data-action="toggle-set" aria-pressed="${s.done}" aria-label="Satz ${i + 1} erledigt">✓</button>
        <button class="icon-btn" data-action="delete-set" aria-label="Satz ${i + 1} löschen">×</button>
      </div>`).join('');
    return `
      <section class="card exercise ${allDone ? 'all-done' : ''}" id="ex-${ex.id}" data-ex="${ex.id}">
        <div class="ex-head">
          <h2>${esc(ex.name)}</h2>
          <button class="icon-btn" data-action="remove-exercise" aria-label="${esc(ex.name)} aus Training entfernen">⋯</button>
        </div>
        <label class="setup"><span>Einstellung</span>
          <input type="text" data-exfield="setup" value="${esc(ex.setup)}" placeholder="z. B. Sitz 4, Lehne 2" autocomplete="off"></label>
        ${last ? `<p class="last">Letztes Mal (${shortDate(last.date)}): ${esc(setsSummary(last.ex.sets))}</p>` : ''}
        <div class="sets">
          <div class="sets-head"><span></span><span>Gewicht</span><span>Wdh.</span><span>Fertig</span><span></span></div>
          ${rows}
        </div>
        <div class="ex-foot">
          <button class="btn small" data-action="add-set">+ Satz</button>
          <div class="rest-stepper"><span>Pause</span>
            <button class="icon-btn" data-action="rest-minus" aria-label="Pause kürzer">−</button>
            <b>${mmss(ex.rest)}</b>
            <button class="icon-btn" data-action="rest-plus" aria-label="Pause länger">+</button>
          </div>
        </div>
      </section>`;
  }

  function restOptions(selected) {
    const vals = [];
    for (let v = 30; v <= 300; v += 15) vals.push(v);
    if (!vals.includes(selected)) vals.push(selected);
    return vals.sort((a, b) => a - b).map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${mmss(v)} min</option>`).join('');
  }

  function viewMachines() {
    const list = [...state.machines].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return `
      <h1>Geräte</h1>
      <section class="card">
        <form class="inline-form" data-form="add-machine">
          <input type="text" name="name" placeholder="Neues Gerät, z. B. Beinpresse" required autocomplete="off">
          <input type="text" name="setup" placeholder="Einstellung (optional)" autocomplete="off">
          <button class="btn primary" type="submit">Gerät anlegen</button>
        </form>
      </section>
      ${list.length ? `<div class="list">${list.map((m) => {
        const last = lastPerformance(m.id);
        return `<a class="list-item" href="#/geraete/${m.id}"><span><b>${esc(m.name)}</b><small>${esc(m.setup || 'Keine Einstellung')}${last ? ' · zuletzt ' + shortDate(last.date) : ''}</small></span><i>›</i></a>`;
      }).join('')}</div>` : '<p class="empty">Noch keine Geräte. Du kannst sie auch direkt im Training anlegen.</p>'}`;
  }

  function viewMachine(id) {
    const m = machineById(id);
    if (!m) return '<a class="back" href="#/geraete">‹ Geräte</a><p class="empty">Gerät nicht gefunden.</p>';
    const hist = machineHistory(id);
    let best = null;
    for (const h of hist) for (const s of doneSets(h.ex.sets)) if (s.weight != null && (best == null || s.weight > best)) best = s.weight;
    return `
      <a class="back" href="#/geraete">‹ Geräte</a>
      <h1>${esc(m.name)}</h1>
      <section class="card form" data-machine="${m.id}">
        <label>Name<input type="text" data-mfield="name" value="${esc(m.name)}" autocomplete="off"></label>
        <label>Einstellung<input type="text" data-mfield="setup" value="${esc(m.setup || '')}" placeholder="z. B. Sitz 4, Lehne 2" autocomplete="off"></label>
        <label>Pause<select data-mfield="rest">${restOptions(m.rest || state.settings.defaultRest)}</select></label>
        <label>Notiz<textarea data-mfield="note" placeholder="z. B. Griffposition, Hinweise">${esc(m.note || '')}</textarea></label>
      </section>
      ${hist.length ? `
        <div class="stats">
          <div><b>${hist.length}</b><span>Trainings</span></div>
          <div><b>${best != null ? fmtNum(best) + ' kg' : '–'}</b><span>Bestes Gewicht</span></div>
          <div><b>${shortDate(hist[0].date)}</b><span>Zuletzt</span></div>
        </div>
        <section class="card"><h2>Verlauf</h2>
          ${hist.slice(0, 20).map((h) => `<div class="hist-row"><span>${shortDate(h.date)}</span><span>${esc(setsSummary(h.ex.sets))}</span></div>`).join('')}
        </section>` : '<p class="empty">Noch nicht trainiert.</p>'}
      <button class="btn danger-text" data-action="delete-machine" data-id="${m.id}">Gerät löschen</button>`;
  }

  function viewHistory() {
    if (!state.sessions.length) return '<h1>Verlauf</h1><p class="empty">Noch keine Trainings gespeichert.</p>';
    return `<h1>Verlauf</h1>${exportReminder()}<div class="list">${[...state.sessions].reverse().map((s) => {
      const st = sessionStats(s);
      return `<a class="list-item" href="#/verlauf/${s.id}"><span><b>${fmtDate(s.start)}</b><small>${fmtTime(s.start)} · ${fmtDur(s.end - s.start)} · ${s.exercises.length} Geräte · ${st.sets} Sätze · ${fmtKg(st.volume)}</small></span><i>›</i></a>`;
    }).join('')}</div>`;
  }

  function viewSessionDetail(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return '<a class="back" href="#/verlauf">‹ Verlauf</a><p class="empty">Training nicht gefunden.</p>';
    const st = sessionStats(s);
    return `
      <a class="back" href="#/verlauf">‹ Verlauf</a>
      <h1>${fmtDate(s.start)}</h1>
      <p class="muted">${fmtTime(s.start)} – ${fmtTime(s.end)}</p>
      <div class="stats">
        <div><b>${fmtDur(s.end - s.start)}</b><span>Dauer</span></div>
        <div><b>${st.sets}</b><span>Sätze</span></div>
        <div><b>${fmtKg(st.volume)}</b><span>Volumen</span></div>
      </div>
      ${s.exercises.map((ex) => `
        <section class="card">
          <h2>${esc(ex.name)}</h2>
          ${ex.setup ? `<p class="muted">${esc(ex.setup)}</p>` : ''}
          <table class="sets-table">
            <thead><tr><th>Satz</th><th>Gewicht</th><th>Wdh.</th><th>Pause</th></tr></thead>
            <tbody>${ex.sets.map((x, i) => `<tr><td>${i + 1}</td><td>${x.weight != null ? fmtNum(x.weight) + ' kg' : '–'}</td><td>${x.reps ?? '–'}</td><td>${x.restTaken != null ? mmss(x.restTaken) : '–'}</td></tr>`).join('')}</tbody>
          </table>
        </section>`).join('')}
      <button class="btn danger-text" data-action="delete-session" data-id="${s.id}">Training löschen</button>`;
  }

  const toggle = (key, label, sub = '') => `
    <label class="toggle"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span>
      <input type="checkbox" data-setting="${key}" ${state.settings[key] ? 'checked' : ''}><i></i></label>`;

  function viewSettings() {
    const s = state.settings;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    return `
      <h1>Export &amp; Einstellungen</h1>
      ${!standalone ? `
        <section class="card hint">
          <h2>Als App installieren</h2>
          <p>In Safari unten auf <b>Teilen</b> tippen → <b>Zum Home-Bildschirm</b>. Danach startet Gym Log im Vollbild und funktioniert offline.</p>
          <p class="small">Wichtig: erst installieren, dann benutzen – die Home-Bildschirm-App hat einen eigenen Speicher, getrennt von Safari.</p>
        </section>` : ''}
      <section class="card">
        <h2>Daten exportieren</h2>
        <p class="muted">${state.sessions.length} Trainings · ${state.machines.length} Geräte gespeichert.<br>${s.lastExport ? 'Letzter Export: ' + fmtDate(s.lastExport) + ', ' + fmtTime(s.lastExport) : 'Noch nie exportiert.'}</p>
        <button class="btn primary block" data-action="export">Exportieren (JSON)</button>
        <p class="small muted">Im Teilen-Menü „In Dateien sichern“ (iCloud Drive) oder AirDrop an den Mac wählen.</p>
        <label class="btn block file-btn">Backup importieren<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        <p class="small muted">Import ergänzt nur fehlende Trainings und Geräte, nichts wird überschrieben.</p>
      </section>
      <section class="card">
        <h2>Pause</h2>
        <div class="setting-row"><span>Standard-Pause für neue Geräte</span>
          <select data-setting="defaultRest" data-type="int">${restOptions(s.defaultRest)}</select></div>
        ${toggle('sound', 'Ton am Ende der Pause', 'Piept 3-2-1 und am Ende – auch über Kopfhörer')}
        ${toggle('loudInSilent', 'Ton auch im Lautlos-Modus', 'Kann laufende Musik kurz unterbrechen')}
        ${toggle('keepAwake', 'Bildschirm im Training anlassen', 'Damit Timer und Ton zuverlässig laufen')}
        <button class="btn small" data-action="test-sound">Ton testen</button>
      </section>
      <section class="card">
        <h2>Apple Watch</h2>
        ${toggle('watchShortcut', 'Pause auch als iOS-Timer starten', 'Dann vibriert die Watch am Ende der Pause')}
        <div class="setting-row"><span>Name des Kurzbefehls</span>
          <input type="text" data-setting="shortcutName" value="${esc(s.shortcutName)}" style="max-width:170px" autocomplete="off"></div>
        <details>
          <summary>Einmalig einrichten</summary>
          <ol>
            <li>App <b>Kurzbefehle</b> öffnen → <b>+</b> (neuer Kurzbefehl)</li>
            <li>Aktion <b>„Timer starten“</b> hinzufügen</li>
            <li>Bei der Dauer die Variable <b>„Kurzbefehleingabe“</b> einsetzen, Einheit <b>Sekunden</b></li>
            <li>Kurzbefehl <b>„${esc(s.shortcutName)}“</b> nennen</li>
          </ol>
          <p class="small muted">Nach dem Tippen auf ✓ springt das iPhone kurz in die Kurzbefehle-App und startet den Timer. Wische dann zurück zu Gym Log. Der iOS-Timer klingelt und vibriert auch auf der Watch.</p>
        </details>
      </section>
      <section class="card">
        <h2>Datenschutz</h2>
        <p class="muted">Alle Daten bleiben auf diesem iPhone. Es wird nichts an einen Server gesendet. Daten verlassen das Gerät nur über „Exportieren“.</p>
        <p class="small muted">Gym Log ${APP_VERSION}</p>
      </section>`;
  }

  // ---------- sheet & toast ----------
  function sheet(html) {
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false;
    document.body.classList.add('sheet-open');
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    document.body.classList.remove('sheet-open');
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function lastUsed(machineId) { return lastPerformance(machineId)?.date || machineById(machineId)?.created || 0; }

  function openPicker() {
    const used = new Set(state.active.exercises.map((e) => e.machineId));
    const list = [...state.machines].sort((a, b) => lastUsed(b.id) - lastUsed(a.id));
    sheet(`
      <h2>Gerät hinzufügen</h2>
      ${list.length > 6 ? '<input type="search" id="picker-search" placeholder="Suchen…" autocomplete="off">' : ''}
      ${list.length ? `<div class="list" id="picker-list">${list.map((m) => `
        <button class="list-item" data-action="pick-machine" data-id="${m.id}" data-name="${esc(m.name.toLowerCase())}">
          <span><b>${esc(m.name)}</b><small>${esc(m.setup || '')}</small></span>${used.has(m.id) ? '<em>schon dabei</em>' : '<i>+</i>'}
        </button>`).join('')}</div>` : ''}
      <h3>Neues Gerät</h3>
      <form class="inline-form" data-form="new-machine">
        <input type="text" name="name" placeholder="Name, z. B. Beinpresse" required autocomplete="off">
        <input type="text" name="setup" placeholder="Einstellung, z. B. Sitz 4, Lehne 2" autocomplete="off">
        <button class="btn primary" type="submit">Anlegen &amp; hinzufügen</button>
      </form>`);
  }

  function createMachine(name, setup) {
    const existing = state.machines.find((m) => m.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const m = { id: uid(), name, setup, rest: state.settings.defaultRest, note: '', created: Date.now() };
    state.machines.push(m);
    return m;
  }

  function addExercise(m) {
    const last = lastPerformance(m.id);
    const sets = last && last.ex.sets.length
      ? last.ex.sets.map((s) => newSet(s.weight, s.reps))
      : [newSet(), newSet(), newSet()];
    const ex = { id: uid(), machineId: m.id, name: m.name, setup: m.setup || '', rest: m.rest || state.settings.defaultRest, note: '', sets };
    state.active.exercises.push(ex);
    save();
    closeSheet();
    render();
    requestAnimationFrame(() => document.getElementById('ex-' + ex.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function syncRow(row, set) {
    const w = row.querySelector('[data-field=weight]');
    const r = row.querySelector('[data-field=reps]');
    if (w) set.weight = num(w.value);
    if (r) { const v = num(r.value); set.reps = v == null ? null : Math.round(v); }
  }

  function finishSession() {
    const a = state.active;
    const doneCount = a.exercises.reduce((n, e) => n + doneSets(e.sets).length, 0);
    if (!doneCount) {
      if (confirm('Noch kein Satz abgehakt. Training verwerfen?')) { state.active = null; state.timer = null; save(); render(); updateWakeLock(); }
      return;
    }
    if (!confirm('Training beenden und speichern?')) return;
    if (state.timer) finalizeRest(state.timer, 'skipped');
    state.timer = null;
    a.end = Date.now();
    a.exercises = a.exercises
      .map((e) => ({ ...e, sets: doneSets(e.sets) }))
      .filter((e) => e.sets.length);
    state.sessions.push(a);
    state.sessions.sort((x, y) => x.start - y.start);
    state.active = null;
    save();
    updateWakeLock();
    location.hash = '#/verlauf/' + a.id;
    render();
    toast('Training gespeichert 💪');
  }

  // ---------- export / import ----------
  function serializeSession(s) {
    return {
      id: s.id,
      start: toIso(s.start),
      end: toIso(s.end),
      durationMin: s.end ? Math.round((s.end - s.start) / 60000) : null,
      exercises: s.exercises.map((e) => ({
        id: e.id,
        machineId: e.machineId,
        machine: e.name,
        setup: e.setup || '',
        restPlannedSec: e.rest,
        note: e.note || '',
        sets: e.sets.map((x, i) => ({
          id: x.id,
          set: i + 1,
          weightKg: x.weight,
          reps: x.reps,
          done: !!x.done,
          doneAt: toIso(x.doneAt),
          restPlannedSec: x.restPlanned,
          restTakenSec: x.restTaken,
        })),
      })),
    };
  }
  function deserializeSession(s) {
    return {
      id: s.id || uid(),
      start: toMs(s.start),
      end: toMs(s.end),
      exercises: (s.exercises || []).map((e) => ({
        id: e.id || uid(),
        machineId: e.machineId,
        name: e.machine ?? e.name ?? '?',
        setup: e.setup || '',
        rest: e.restPlannedSec ?? e.rest ?? state.settings.defaultRest,
        note: e.note || '',
        sets: (e.sets || []).map((x) => ({
          id: x.id || uid(),
          weight: x.weightKg ?? x.weight ?? null,
          reps: x.reps ?? null,
          done: x.done ?? true,
          doneAt: toMs(x.doneAt),
          restPlanned: x.restPlannedSec ?? x.restPlanned ?? null,
          restTaken: x.restTakenSec ?? x.restTaken ?? null,
        })),
      })),
    };
  }
  const serializeMachine = (m) => ({ id: m.id, name: m.name, setup: m.setup || '', restSec: m.rest, note: m.note || '', created: toIso(m.created) });
  const deserializeMachine = (m) => ({ id: m.id, name: m.name, setup: m.setup || '', rest: m.restSec ?? m.rest ?? state.settings.defaultRest, note: m.note || '', created: toMs(m.created) });

  async function exportData() {
    const now = Date.now();
    const data = {
      app: 'gym-log',
      schemaVersion: 1,
      appVersion: APP_VERSION,
      exportedAt: toIso(now),
      units: { weight: 'kg', rest: 'seconds', time: 'ISO 8601 UTC' },
      machines: state.machines.map(serializeMachine),
      sessions: state.sessions.map(serializeSession),
      activeSession: state.active ? serializeSession(state.active) : null,
    };
    const json = JSON.stringify(data, null, 2);
    const d = new Date(now);
    const name = `gymlog-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
    const mark = () => { state.settings.lastExport = now; save(); render(); toast('Export erstellt'); };
    for (const type of ['application/json', 'text/plain']) {
      const file = new File([json], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
          mark();
        } catch (e) {
          if (e.name !== 'AbortError') toast('Teilen fehlgeschlagen');
        }
        return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    mark();
  }

  async function importFile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.sessions) || !Array.isArray(data.machines)) throw new Error('format');
      let addM = 0, addS = 0;
      for (const m of data.machines) {
        if (m && m.id && m.name && !machineById(m.id)) { state.machines.push(deserializeMachine(m)); addM++; }
      }
      for (const raw of data.sessions) {
        const s = deserializeSession(raw);
        if (s.start && !state.sessions.some((x) => x.id === s.id)) { state.sessions.push(s); addS++; }
      }
      state.sessions.sort((a, b) => a.start - b.start);
      save();
      render();
      toast(`Importiert: ${addS} Trainings, ${addM} Geräte`);
    } catch (e) {
      toast('Import fehlgeschlagen – keine gültige Gym-Log-Datei');
    }
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const card = btn.closest('.exercise');
    const ex = card ? findEx(card.dataset.ex) : null;
    const row = btn.closest('.set-row');
    const set = ex && row ? ex.sets.find((s) => s.id === row.dataset.set) : null;

    switch (action) {
      case 'start-session':
        unlockAudio();
        state.active = { id: uid(), start: Date.now(), end: null, exercises: [] };
        state.timer = null;
        save();
        updateWakeLock();
        if (route().view !== 'training') location.hash = '#/training';
        render();
        openPicker();
        break;
      case 'finish-session': finishSession(); break;
      case 'discard-session':
        if (confirm('Training verwerfen? Alle Einträge dieses Trainings gehen verloren.')) {
          state.active = null; state.timer = null; save(); updateWakeLock(); render();
        }
        break;
      case 'open-picker': openPicker(); break;
      case 'close-sheet': closeSheet(); break;
      case 'pick-machine': {
        const m = machineById(btn.dataset.id);
        if (m) addExercise(m);
        break;
      }
      case 'toggle-set': {
        if (!set) return;
        syncRow(row, set);
        if (!set.done) {
          set.done = true;
          set.doneAt = Date.now();
          const idx = ex.sets.indexOf(set);
          const next = ex.sets[idx + 1];
          if (next && !next.done) {
            if (next.weight == null) next.weight = set.weight;
            if (next.reps == null) next.reps = set.reps;
          }
          startRest(ex, set);
        } else {
          set.done = false;
          set.doneAt = null;
          set.restTaken = null;
          set.restPlanned = null;
          if (state.timer && state.timer.setId === set.id) state.timer = null;
        }
        save();
        render();
        break;
      }
      case 'delete-set':
        if (!set) return;
        if (state.timer && state.timer.setId === set.id) state.timer = null;
        ex.sets.splice(ex.sets.indexOf(set), 1);
        save(); render();
        break;
      case 'add-set': {
        const lastSet = ex.sets[ex.sets.length - 1];
        ex.sets.push(newSet(lastSet?.weight ?? null, lastSet?.reps ?? null));
        save(); render();
        break;
      }
      case 'remove-exercise':
        if (confirm(`„${ex.name}“ aus diesem Training entfernen?`)) {
          if (state.timer && state.timer.exId === ex.id) state.timer = null;
          state.active.exercises = state.active.exercises.filter((x) => x !== ex);
          save(); render();
        }
        break;
      case 'rest-minus':
      case 'rest-plus': {
        ex.rest = Math.min(600, Math.max(15, ex.rest + (action === 'rest-plus' ? 15 : -15)));
        const m = machineById(ex.machineId);
        if (m) m.rest = ex.rest;
        save(); render();
        break;
      }
      case 'timer-minus':
      case 'timer-plus': {
        const t = state.timer;
        if (!t || t.finished) return;
        const delta = action === 'timer-plus' ? 15 : -15;
        const now = Date.now();
        t.endsAt = Math.max(now, t.endsAt + delta * 1000);
        t.total = Math.max(1, t.total + delta);
        t.beeped = {};
        save(); tick();
        break;
      }
      case 'timer-skip':
        if (state.timer && !state.timer.finished) finalizeRest(state.timer, 'skipped');
        clearTimer();
        save(); render();
        break;
      case 'export': exportData(); break;
      case 'test-sound': unlockAudio(); setTimeout(beepDone, 120); break;
      case 'delete-session':
        if (confirm('Dieses Training endgültig löschen?')) {
          state.sessions = state.sessions.filter((s) => s.id !== btn.dataset.id);
          save(); location.hash = '#/verlauf';
        }
        break;
      case 'delete-machine':
        if (confirm('Gerät löschen? Bisherige Trainings bleiben im Verlauf erhalten.')) {
          state.machines = state.machines.filter((m) => m.id !== btn.dataset.id);
          save(); location.hash = '#/geraete';
        }
        break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.field) {
      const row = el.closest('.set-row');
      const card = el.closest('.exercise');
      const { set } = findSet(card.dataset.ex, row.dataset.set);
      if (!set) return;
      syncRow(row, set);
      el.value = el.dataset.field === 'weight' ? fmtNum(set.weight) : set.reps ?? '';
      save();
      return;
    }
    if (el.dataset.exfield) {
      const ex = findEx(el.closest('.exercise').dataset.ex);
      if (!ex) return;
      ex[el.dataset.exfield] = el.value.trim();
      if (el.dataset.exfield === 'setup') {
        const m = machineById(ex.machineId);
        if (m) m.setup = ex.setup;
      }
      save();
      return;
    }
    if (el.dataset.mfield) {
      const m = machineById(el.closest('[data-machine]').dataset.machine);
      if (!m) return;
      const f = el.dataset.mfield;
      if (f === 'rest') m.rest = parseInt(el.value, 10);
      else if (f === 'name') { if (el.value.trim()) m.name = el.value.trim(); }
      else m[f] = el.value.trim();
      save();
      toast('Gespeichert');
      if (f === 'name') render();
      return;
    }
    if (el.dataset.setting) {
      const k = el.dataset.setting;
      if (el.type === 'checkbox') state.settings[k] = el.checked;
      else if (el.dataset.type === 'int') state.settings[k] = parseInt(el.value, 10);
      else state.settings[k] = el.value.trim();
      save();
      if (k === 'keepAwake') updateWakeLock();
      if (k === 'sound' && el.checked) unlockAudio();
      if (k === 'shortcutName') render();
      return;
    }
    if (el.id === 'import-file' && el.files[0]) {
      importFile(el.files[0]);
      el.value = '';
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'picker-search') return;
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#picker-list .list-item').forEach((b) => { b.hidden = q && !b.dataset.name.includes(q); });
  });

  document.addEventListener('submit', (e) => {
    const f = e.target;
    const kind = f.dataset.form;
    if (!kind) return;
    e.preventDefault();
    const fd = new FormData(f);
    const name = String(fd.get('name') || '').trim();
    const setup = String(fd.get('setup') || '').trim();
    if (!name) return;
    const m = createMachine(name, setup);
    if (setup && !m.setup) m.setup = setup;
    save();
    if (kind === 'new-machine' && state.active) addExercise(m);
    else { render(); toast(`„${m.name}“ angelegt`); }
  });

  // Enter on weight jumps to reps
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.dataset?.field) return;
    e.preventDefault();
    if (e.target.dataset.field === 'weight') e.target.closest('.set-row').querySelector('[data-field=reps]')?.focus();
    else e.target.blur();
  });

  // Unlock audio on any first touch (iOS requires a user gesture)
  document.addEventListener('pointerdown', () => { if (!actx) unlockAudio(); }, { once: true, capture: true });

  window.addEventListener('hashchange', () => { closeSheet(); render(); });
  document.addEventListener('visibilitychange', () => { updateWakeLock(); tick(); });
  setInterval(tick, 250);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Drop a long-expired timer from a previous run
  if (state.timer && (!state.active || Date.now() - state.timer.endsAt > 60000)) state.timer = null;
  render();
  updateWakeLock();
})();
