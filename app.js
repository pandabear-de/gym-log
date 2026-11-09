'use strict';
(() => {
  const STORE_KEY = 'gymlog.v1';
  const APP_VERSION = '1.6.0';
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
      plans: [],
      sessions: [],
      active: null,
      timer: null,
      settings: {
        defaultRest: 90,
        sound: true,
        loudInSilent: false,
        keepAwake: true,
        weightStep: 5,
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
      return migrate({ ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } });
    } catch (e) {
      console.error(e);
      return d;
    }
  }
  // Machines whose note says "je Seite" are trained side by side (left/right alternating)
  function migrate(st) {
    for (const m of st.machines) if (m.sides === undefined && m.kind !== 'cardio' && /je Seite/i.test(m.note || '')) m.sides = true;
    return st;
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
  const planById = (id) => state.plans.find((p) => p.id === id);
  const planMachines = (p) => p.machineIds.map(machineById).filter(Boolean);
  function nextPlanName() {
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!state.plans.some((p) => p.name === 'Plan ' + c)) return 'Plan ' + c;
    return 'Plan';
  }
  function createPlan(machineIds = []) {
    const p = { id: uid(), name: nextPlanName(), machineIds: [...new Set(machineIds)].filter(machineById), created: Date.now() };
    state.plans.push(p);
    save();
    location.hash = '#/plan/' + p.id;
  }
  const findEx = (exId) => state.active?.exercises.find((e) => e.id === exId) || null;
  const findSet = (exId, setId) => {
    const ex = findEx(exId);
    return { ex, set: ex ? ex.sets.find((s) => s.id === setId) || null : null };
  };
  const SIDE_LABEL = { L: 'links', R: 'rechts' };
  const sided = (ex) => !isCardio(ex) && (ex.sides ?? !!machineById(ex.machineId)?.sides);
  const sideOf = (ex, i) => (sided(ex) ? (i % 2 ? 'R' : 'L') : null);
  const localInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
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
    let cardioMin = 0;
    for (const ex of s.exercises) if (isCardio(ex) && ex.cardio?.done) cardioMin += ex.cardio.minutes || 0;
    return { sets, volume, cardioMin };
  }

  const CARDIO_TYPES = {
    laufband: { label: 'Laufband', fields: ['minutes', 'speed', 'incline'] },
    rad: { label: 'Rad / Ergometer', fields: ['minutes', 'level'] },
    stepper: { label: 'Stepper / Crosstrainer', fields: ['minutes', 'level'] },
  };
  const CARDIO_FIELDS = {
    minutes: { label: 'Dauer', unit: 'min', mode: 'decimal' },
    speed: { label: 'Tempo', unit: 'km/h', mode: 'decimal', step: 0.5 },
    incline: { label: 'Steigung', unit: '%', mode: 'decimal', step: 0.5 },
    level: { label: 'Stufe', unit: '', mode: 'decimal', step: 1 },
    watts: { label: 'Leistung', unit: 'W', mode: 'numeric', step: 10 },
  };
  const LOG_FIELDS = ['speed', 'incline', 'level', 'watts'];
  // While cardio runs, every settings change is kept with a timestamp (changes within 20 s are merged)
  function logCardio(c, at = Date.now()) {
    if (!c.startedAt || c.done) return;
    const snap = { at };
    for (const f of LOG_FIELDS) snap[f] = c[f] ?? null;
    c.log = c.log || [];
    const prev = c.log[c.log.length - 1];
    if (prev && LOG_FIELDS.every((f) => prev[f] === snap[f])) return;
    if (prev && at - prev.at < 20000) c.log[c.log.length - 1] = { ...snap, at: prev.at };
    else c.log.push(snap);
  }
  function cardioSegments(c) {
    if (!c || !c.log || c.log.length < 2 || !c.startedAt) return [];
    const end = c.doneAt || Date.now();
    return c.log.map((x, i) => ({ ...x, from: (x.at - c.startedAt) / 60000, to: ((c.log[i + 1]?.at ?? end) - c.startedAt) / 60000 }));
  }
  const EFFORTS = { easy: 'leicht', ok: 'passend', hard: 'schwer' };
  const isCardio = (ex) => ex.kind === 'cardio';
  function cardioSummary(c) {
    if (!c) return '–';
    const parts = [];
    if (c.minutes != null) parts.push(`${fmtNum(c.minutes)} min`);
    if (c.speed != null) parts.push(`${fmtNum(c.speed)} km/h`);
    if (c.incline != null) parts.push(`${fmtNum(c.incline)} %`);
    if (c.level != null) parts.push(`Stufe ${fmtNum(c.level)}`);
    if (c.watts != null) parts.push(`${fmtNum(c.watts)} W`);
    return parts.join(' · ') || '–';
  }
  const exSummary = (ex) => (isCardio(ex) ? cardioSummary(ex.cardio) : setsSummary(ex.sets)) + (ex.effort ? ` (${EFFORTS[ex.effort]})` : '');
  const exDone = (ex) => (isCardio(ex) ? !!ex.cardio?.done : ex.sets.some((s) => s.done));
  const kindSelect = () => `
    <select name="kind" aria-label="Art des Geräts">
      <option value="kraft">Kraftgerät</option>
      ${Object.entries(CARDIO_TYPES).map(([k, t]) => `<option value="${k}">Cardio: ${t.label}</option>`).join('')}
    </select>`;

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
        ? `Nächster: Satz ${ex.sets.indexOf(next) + 1}${sideOf(ex, ex.sets.indexOf(next)) ? ' ' + SIDE_LABEL[sideOf(ex, ex.sets.indexOf(next))] : ''}${next.weight != null ? ` · ${fmtNum(next.weight)} kg × ${next.reps ?? '–'}` : ''}`
        : 'Nächstes Gerät';
    }
    $('#timer-skip').textContent = t.finished ? 'OK' : 'Weiter ›';
  }
  function updateElapsed() {
    const el = $('#elapsed');
    if (el && state.active) el.textContent = fmtDur(Date.now() - state.active.start);
    document.querySelectorAll('.cardio-elapsed').forEach((x) => { x.textContent = mmss((Date.now() - Number(x.dataset.start)) / 1000); });
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
    if (!(r.view === 'verlauf' && r.id === editId)) editId = null;
    let html;
    switch (r.view) {
      case 'geraete': html = r.id ? viewMachine(r.id) : viewMachines(); break;
      case 'verlauf': html = r.id ? viewSessionDetail(r.id) : viewHistory(); break;
      case 'mehr': html = viewSettings(); break;
      case 'plan': html = viewPlan(r.id); break;
      default: html = state.active ? viewSession() : viewStart();
    }
    const key = r.view + '/' + (r.id || '') + (state.active ? '/a' : '');
    const y = window.scrollY;
    $('#app').innerHTML = html;
    if (key === lastRouteKey) window.scrollTo(0, y); else window.scrollTo(0, 0);
    lastRouteKey = key;
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (r.view === 'plan' ? 'training' : r.view)));
    updateTimerUI();
    updateElapsed();
  }

  // Own trainings finished since the last export (imported ones already exist as a file)
  function pendingBackup() {
    const last = state.settings.lastExport || 0;
    const list = state.sessions.filter((s) => s.source !== 'import' && s.end > last);
    return { count: list.length, oldest: list.length ? list[0].end : null };
  }
  function exportReminder() {
    const p = pendingBackup();
    if (!p.count || (p.count < 3 && Date.now() - p.oldest < 7 * DAY)) return '';
    return `<section class="card warn"><span><b>${p.count} ${p.count === 1 ? 'Training' : 'Trainings'} nicht gesichert</b><br><small>Die Daten liegen nur auf diesem iPhone.</small></span><button class="btn small" data-action="export">Sichern</button></section>`;
  }

  function viewStart() {
    const last = state.sessions[state.sessions.length - 1];
    return `
      <h1>Training</h1>
      ${exportReminder()}
      ${state.plans.map((p) => {
        const used = [...state.sessions].reverse().find((x) => x.planId === p.id);
        const n = planMachines(p).length;
        return `
        <section class="card">
          <div class="ex-head"><h2>${esc(p.name)}</h2><a class="btn small" href="#/plan/${p.id}">Ändern</a></div>
          <p class="small muted">${n} ${n === 1 ? 'Gerät' : 'Geräte'}${used ? ' · zuletzt ' + shortDate(used.start) : ''}</p>
          <button class="btn primary block" data-action="start-plan" data-id="${p.id}">${esc(p.name)} starten</button>
        </section>`;
      }).join('')}
      ${last ? `
        <button class="btn ${state.plans.length ? 'block' : 'primary big'}" data-action="repeat-session" data-id="${last.id}">Wie letztes Mal starten</button>
        <p class="small muted center">${last.exercises.length === 1 ? '1 Gerät' : last.exercises.length + ' Geräte'} vom ${shortDate(last.start)}, mit deinen letzten Werten</p>
        <button class="btn block" data-action="start-session">Leeres Training starten</button>` : `<button class="btn ${state.plans.length ? 'block' : 'primary big'}" data-action="start-session">${state.plans.length ? 'Leeres Training starten' : 'Training starten'}</button>`}
      <button class="btn block" data-action="new-plan">+ Neuer Plan (z. B. A und B)</button>
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
        <div><h1>Training</h1><p class="muted">${a.planName ? esc(a.planName) + ' · ' : ''}seit ${fmtTime(a.start)} · <span id="elapsed"></span></p></div>
        <button class="btn" data-action="finish-session">Beenden</button>
      </div>
      ${a.exercises.length ? a.exercises.map(exerciseCard).join('') : '<p class="empty">Noch kein Gerät. Füge das erste hinzu.</p>'}
      <button class="btn primary big" data-action="open-picker">+ Gerät hinzufügen</button>
      <section class="card">
        <label class="setup"><span>Notiz zum Training (optional)</span>
          <textarea data-sessionfield="note" placeholder="z. B. müde, wenig geschlafen, Rücken zwickt">${esc(a.note || '')}</textarea></label>
      </section>
      <button class="btn danger-text" data-action="discard-session">Training verwerfen</button>`;
  }

  function effortRow(ex) {
    return `<div class="effort"><span>Wie war's?</span>${Object.entries(EFFORTS).map(([k, l]) =>
      `<button class="pill ${ex.effort === k ? 'on' : ''}" data-action="effort" data-v="${k}" aria-pressed="${ex.effort === k}">${l}</button>`).join('')}</div>`;
  }
  function progressHint(machineId) {
    const h = machineHistory(machineId).slice(0, 2);
    if (!h.length || h[0].ex.effort !== 'easy') return '';
    const twice = h.length > 1 && h[1].ex.effort === 'easy';
    return `<p class="hint-line">💡 ${twice ? '2× in Folge leicht' : 'Letztes Mal leicht'} – heute steigern?</p>`;
  }
  function cardioCard(ex) {
    const c = ex.cardio;
    const t = CARDIO_TYPES[c.type] || CARDIO_TYPES.stepper;
    const last = lastPerformance(ex.machineId);
    const running = c.startedAt && !c.done;
    const fields = t.fields.map((f) => {
      const d = CARDIO_FIELDS[f];
      const steps = d.step ? `<span class="cstep"><button class="step" data-action="cstep" data-f="${f}" data-delta="-1" aria-label="${d.label} weniger">−</button><button class="step" data-action="cstep" data-f="${f}" data-delta="1" aria-label="${d.label} mehr">+</button></span>` : '';
      return `<div class="cfield"><label><span>${d.label}</span><span class="field"><input type="text" inputmode="${d.mode}" data-cfield="${f}" value="${fmtNum(c[f])}" placeholder="–" aria-label="${d.label}"><span>${d.unit}</span></span></label>${steps}</div>`;
    }).join('');
    const btn = c.done
      ? '<button class="btn block done-btn" data-action="cardio-toggle">✓ Erledigt</button>'
      : running
        ? `<button class="btn primary block" data-action="cardio-toggle">✓ Fertig · <span class="cardio-elapsed" data-start="${c.startedAt}">${mmss((Date.now() - c.startedAt) / 1000)}</span></button>`
        : '<button class="btn primary block" data-action="cardio-start">▶ Start</button>';
    return `
      <section class="card exercise ${c.done ? 'all-done' : ''}" id="ex-${ex.id}" data-ex="${ex.id}">
        <div class="ex-head">
          <h2>${esc(ex.name)}</h2>
          <button class="icon-btn" data-action="remove-exercise" aria-label="${esc(ex.name)} aus Training entfernen">⋯</button>
        </div>
        <p class="small muted">Cardio · ${t.label}${ex.setup ? ' · ' + esc(ex.setup) : ''}</p>
        ${last ? `<p class="last">Letztes Mal (${shortDate(last.date)}): ${esc(exSummary(last.ex))}</p>` : ''}
        ${progressHint(ex.machineId)}
        <div class="cfields">${fields}</div>
        <p class="small muted">${running ? `Einstellung am Gerät geändert? Hier mitändern – die App merkt sich, ab wann welcher Wert galt.${c.log && c.log.length > 1 ? ` (${c.log.length - 1} Änderung${c.log.length > 2 ? 'en' : ''})` : ''}` : 'Startwerte eintragen und „Start“ tippen. Änderungen während des Trainings einfach mitändern. Die Dauer füllt sich bei „Fertig“ selbst aus.'}</p>
        ${btn}
        ${effortRow(ex)}
      </section>`;
  }

  function exerciseCard(ex) {
    if (isCardio(ex)) return cardioCard(ex);
    const last = lastPerformance(ex.machineId);
    const allDone = ex.sets.length && ex.sets.every((s) => s.done);
    const activeId = activeSetId(ex);
    const rows = ex.sets.map((s, i) => `
      <div class="set-row ${s.done ? 'done' : ''} ${s.id === activeId ? 'active' : ''}" data-set="${s.id}">
        <span class="set-no">${i + 1}${sideOf(ex, i) ? `<small>${sideOf(ex, i)}</small>` : ''}</span>
        <label class="field"><input type="text" inputmode="decimal" enterkeyhint="next" data-field="weight" value="${fmtNum(s.weight)}" placeholder="–" aria-label="Gewicht Satz ${i + 1}"><span>kg</span></label>
        <label class="field"><input type="text" inputmode="numeric" enterkeyhint="done" data-field="reps" value="${s.reps ?? ''}" placeholder="–" aria-label="Wiederholungen Satz ${i + 1}"><span>Wdh.</span></label>
        <button class="check" data-action="toggle-set" aria-pressed="${s.done}" aria-label="Satz ${i + 1} erledigt">✓</button>
        <button class="icon-btn" data-action="delete-set" aria-label="Satz ${i + 1} löschen">×</button>
      </div>${s.id === activeId ? stepperBar(s.id) : ''}`).join('');
    return `
      <section class="card exercise ${allDone ? 'all-done' : ''}" id="ex-${ex.id}" data-ex="${ex.id}">
        <div class="ex-head">
          <h2>${esc(ex.name)}</h2>
          <button class="icon-btn" data-action="remove-exercise" aria-label="${esc(ex.name)} aus Training entfernen">⋯</button>
        </div>
        <label class="setup"><span>Einstellung</span>
          <input type="text" data-exfield="setup" value="${esc(ex.setup)}" placeholder="z. B. Sitz 4, Lehne 2" autocomplete="off"></label>
        ${last ? `<p class="last">Letztes Mal (${shortDate(last.date)}): ${esc(exSummary(last.ex))}</p>` : ''}
        ${progressHint(ex.machineId)}
        ${sided(ex) ? '<p class="small muted">L = links, R = rechts, abwechselnd</p>' : ''}
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
        ${effortRow(ex)}
      </section>`;
  }

  // Set with the −/+ bar: the one the user picked, else the first set not yet done
  const selectedByEx = {};
  function activeSetId(ex) {
    const sel = selectedByEx[ex.id];
    if (sel && ex.sets.some((s) => s.id === sel)) return sel;
    return ex.sets.find((s) => !s.done)?.id || null;
  }
  function stepperBar(setId) {
    const step = fmtNum(state.settings.weightStep || 5);
    return `
      <div class="stepper-bar" data-set="${setId}">
        <span></span>
        <div class="step-group">
          <button class="step" data-action="step" data-field="weight" data-delta="-1" aria-label="${step} kg weniger">−${step}</button>
          <button class="step" data-action="step" data-field="weight" data-delta="1" aria-label="${step} kg mehr">+${step}</button>
        </div>
        <div class="step-group">
          <button class="step" data-action="step" data-field="reps" data-delta="-1" aria-label="Eine Wiederholung weniger">−1</button>
          <button class="step" data-action="step" data-field="reps" data-delta="1" aria-label="Eine Wiederholung mehr">+1</button>
        </div>
      </div>`;
  }
  function selectSet(card, row) {
    const exId = card.dataset.ex;
    selectedByEx[exId] = row.dataset.set;
    card.querySelectorAll('.set-row.active').forEach((r) => r.classList.remove('active'));
    row.classList.add('active');
    let bar = card.querySelector('.stepper-bar');
    if (!bar) {
      row.insertAdjacentHTML('afterend', stepperBar(row.dataset.set));
      return;
    }
    bar.dataset.set = row.dataset.set;
    row.after(bar);
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
          ${kindSelect()}
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
        ${m.kind === 'cardio'
          ? `<label>Art<select data-mfield="cardioType">${Object.entries(CARDIO_TYPES).map(([k, t]) => `<option value="${k}" ${k === m.cardioType ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>`
          : `<label>Pause<select data-mfield="rest">${restOptions(m.rest || state.settings.defaultRest)}</select></label>`}
        <label>Notiz<textarea data-mfield="note" placeholder="z. B. Griffposition, Hinweise">${esc(m.note || '')}</textarea></label>
        ${m.kind === 'cardio' ? '' : `<label class="toggle"><span>Seitenweise trainieren<small>Sätze abwechselnd links / rechts beschriften</small></span>
          <input type="checkbox" data-mfield="sides" ${m.sides ? 'checked' : ''}><i></i></label>`}
      </section>
      ${hist.length ? `
        <div class="stats">
          <div><b>${hist.length}</b><span>Trainings</span></div>
          ${m.kind === 'cardio' ? '' : `<div><b>${best != null ? fmtNum(best) + ' kg' : '–'}</b><span>Bestes Gewicht</span></div>`}
          <div><b>${shortDate(hist[0].date)}</b><span>Zuletzt</span></div>
        </div>
        ${machineChart(m, hist)}
        <section class="card"><h2>Verlauf</h2>
          ${hist.slice(0, 20).map((h) => `<div class="hist-row"><span>${shortDate(h.date)}</span><span>${esc(exSummary(h.ex))}</span></div>`).join('')}
        </section>` : '<p class="empty">Noch nicht trainiert.</p>'}
      <button class="btn danger-text" data-action="delete-machine" data-id="${m.id}">Gerät löschen</button>`;
  }

  // Line chart: best weight (or cardio minutes) per training, oldest to newest
  function machineChart(m, hist) {
    const cardio = m.kind === 'cardio';
    const unit = cardio ? 'min' : 'kg';
    const pts = hist.slice(0, 20).reverse().map((h) => {
      let v = null;
      if (cardio) v = h.ex.cardio?.minutes ?? null;
      else for (const s of doneSets(h.ex.sets)) if (s.weight != null && (v == null || s.weight > v)) v = s.weight;
      return { t: h.date, v };
    }).filter((p) => p.v != null);
    if (pts.length < 2) return '';
    const W = 320, H = 150, L = 38, R = 16, T = 24, B = 24;
    const vmin = Math.min(...pts.map((p) => p.v)), vmax = Math.max(...pts.map((p) => p.v));
    const span = vmax - vmin || 10;
    const y0 = vmin - span * 0.2, y1 = vmax + span * 0.2;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const x = (t) => L + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const f = (n) => Math.round(n * 10) / 10;
    const ticks = vmin === vmax ? [vmin] : [vmin, vmax];
    const first = pts[0], lastP = pts[pts.length - 1];
    const diff = Math.round((lastP.v - first.v) * 100) / 100;
    const cap = `${shortDate(first.t)}: ${fmtNum(first.v)} ${unit} → ${shortDate(lastP.t)}: ${fmtNum(lastP.v)} ${unit}${diff ? ` (${diff > 0 ? '+' : '−'}${fmtNum(Math.abs(diff))} ${unit})` : ' (gleich)'}`;
    return `
      <section class="card chart">
        <h2>Entwicklung</h2>
        <p class="small muted">${cardio ? 'Dauer' : 'Höchstes Gewicht'} je Training</p>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cap)}">
          ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${f(y(v))}" y2="${f(y(v))}"/><text class="tick" x="${L - 6}" y="${f(y(v)) + 4}" text-anchor="end">${fmtNum(v)}</text>`).join('')}
          <text class="tick" x="${L}" y="${H - 6}">${shortDate(first.t)}</text>
          <text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${shortDate(lastP.t)}</text>
          <polyline class="line" points="${pts.map((p) => f(x(p.t)) + ',' + f(y(p.v))).join(' ')}"/>
          ${pts.map((p) => `<circle class="pt" cx="${f(x(p.t))}" cy="${f(y(p.v))}" r="4.5"/>`).join('')}
          <text class="val" x="${W - R + 4}" y="${f(y(lastP.v)) - 10}" text-anchor="end">${fmtNum(lastP.v)} ${unit}</text>
          ${pts.map((p) => `<circle class="hit" cx="${f(x(p.t))}" cy="${f(y(p.v))}" r="14" data-action="chart-pt" data-label="${esc(fmtDate(p.t) + ': ' + fmtNum(p.v) + ' ' + unit)}"/>`).join('')}
        </svg>
        <p class="chart-cap" id="chart-cap">${esc(cap)}</p>
      </section>`;
  }

  // Training plan (e.g. A / B): a named, ordered list of machines
  function viewPlan(id) {
    const p = planById(id);
    if (!p) return '<a class="back" href="#/training">‹ Training</a><p class="empty">Plan nicht gefunden.</p>';
    const list = planMachines(p);
    return `
      <a class="back" href="#/training">‹ Training</a>
      <h1>${esc(p.name)}</h1>
      <section class="card form" data-plan="${p.id}">
        <label>Name<input type="text" data-pfield="name" value="${esc(p.name)}" placeholder="z. B. Plan A, Beine, Oberkörper" autocomplete="off"></label>
      </section>
      ${list.length ? `<div class="list">${list.map((m, i) => {
        const last = lastPerformance(m.id);
        return `<div class="list-item plan-row" data-mid="${m.id}">
          <span><b>${i + 1}. ${esc(m.name)}</b><small>${last ? esc(exSummary(last.ex)) : esc(m.setup || 'Noch nicht trainiert')}</small></span>
          <span class="row-btns">
            <button class="icon-btn" data-action="plan-up" ${i === 0 ? 'disabled' : ''} aria-label="${esc(m.name)} nach oben">↑</button>
            <button class="icon-btn" data-action="plan-down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="${esc(m.name)} nach unten">↓</button>
            <button class="icon-btn" data-action="plan-remove" aria-label="${esc(m.name)} aus dem Plan entfernen">×</button>
          </span></div>`;
      }).join('')}</div>` : '<p class="empty">Noch keine Geräte in diesem Plan.</p>'}
      <button class="btn ${list.length ? 'block' : 'primary big'}" data-action="plan-add">Geräte auswählen</button>
      ${list.length && !state.active ? `<button class="btn primary big" data-action="start-plan" data-id="${p.id}">${esc(p.name)} starten</button>` : ''}
      <button class="btn danger-text" data-action="delete-plan">Plan löschen</button>`;
  }

  function viewHistory() {
    if (!state.sessions.length) return '<h1>Verlauf</h1><p class="empty">Noch keine Trainings gespeichert.</p>';
    return `<h1>Verlauf</h1>${exportReminder()}<div class="list">${[...state.sessions].reverse().map((s) => {
      const st = sessionStats(s);
      return `<a class="list-item" href="#/verlauf/${s.id}"><span><b>${fmtDate(s.start)}</b><small>${s.planName ? esc(s.planName) + ' · ' : ''}${fmtTime(s.start)} · ${fmtDur(s.end - s.start)} · ${s.exercises.length} Geräte · ${st.sets} Sätze · ${fmtKg(st.volume)}</small></span><i>›</i></a>`;
    }).join('')}</div>`;
  }

  function viewSessionDetail(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return '<a class="back" href="#/verlauf">‹ Verlauf</a><p class="empty">Training nicht gefunden.</p>';
    if (editId === id) return viewSessionEdit(s);
    const st = sessionStats(s);
    return `
      <a class="back" href="#/verlauf">‹ Verlauf</a>
      <h1>${fmtDate(s.start)}</h1>
      <p class="muted">${s.planName ? esc(s.planName) + ' · ' : ''}${fmtTime(s.start)} – ${fmtTime(s.end)}</p>
      <div class="stats">
        <div><b>${fmtDur(s.end - s.start)}</b><span>Dauer</span></div>
        <div><b>${st.sets}</b><span>Sätze</span></div>
        <div><b>${fmtKg(st.volume)}</b><span>Volumen</span></div>
      </div>
      ${st.cardioMin ? `<p class="muted">Cardio: ${fmtNum(st.cardioMin)} min</p>` : ''}
      ${s.note ? `<section class="card"><h3 style="margin-top:0">Notiz</h3><p>${esc(s.note)}</p></section>` : ''}
      ${s.exercises.map((ex) => isCardio(ex) ? `
        <section class="card">
          <h2>${esc(ex.name)}</h2>
          <p class="muted">Cardio · ${CARDIO_TYPES[ex.cardio?.type]?.label || ''}${ex.effort ? ' · ' + EFFORTS[ex.effort] : ''}</p>
          <p>${esc(cardioSummary(ex.cardio))}</p>
          ${cardioSegments(ex.cardio).length ? `<h3>Verlauf der Einstellungen</h3>${cardioSegments(ex.cardio).map((g) =>
            `<div class="hist-row"><span>${Math.round(g.from)}–${Math.round(g.to)} min</span><span>${esc(cardioSummary(g))}</span></div>`).join('')}` : ''}
        </section>` : `
        <section class="card">
          <h2>${esc(ex.name)}</h2>
          ${ex.setup || ex.effort ? `<p class="muted">${esc(ex.setup || '')}${ex.setup && ex.effort ? ' · ' : ''}${ex.effort ? EFFORTS[ex.effort] : ''}</p>` : ''}
          <table class="sets-table">
            <thead><tr><th>Satz</th><th>Gewicht</th><th>Wdh.</th><th>Pause</th></tr></thead>
            <tbody>${ex.sets.map((x, i) => `<tr><td>${i + 1}${sideOf(ex, i) ? ' · ' + SIDE_LABEL[sideOf(ex, i)] : ''}</td><td>${x.weight != null ? fmtNum(x.weight) + ' kg' : '–'}</td><td>${x.reps ?? '–'}</td><td>${x.restTaken != null ? mmss(x.restTaken) : '–'}</td></tr>`).join('')}</tbody>
          </table>
        </section>`).join('')}
      ${state.active ? '' : `<button class="btn primary block" data-action="repeat-session" data-id="${s.id}">Dieses Training wiederholen</button>`}
      <button class="btn block" data-action="save-plan" data-id="${s.id}">Geräte als Plan speichern</button>
      <button class="btn block" data-action="edit-session" data-id="${s.id}">Bearbeiten</button>
      <button class="btn danger-text" data-action="delete-session" data-id="${s.id}">Training löschen</button>`;
  }

  // Edit a saved training: times, note, sets, machines
  let editId = null;
  function viewSessionEdit(s) {
    return `
      <div class="session-head">
        <div><h1>Bearbeiten</h1><p class="muted">${fmtDate(s.start)}</p></div>
        <button class="btn primary" data-action="edit-done">Fertig</button>
      </div>
      <section class="card form">
        <label>Beginn<input type="datetime-local" data-hfield="start" value="${localInput(s.start)}"></label>
        <label>Ende<input type="datetime-local" data-hfield="end" value="${localInput(s.end)}"></label>
        <label>Notiz<textarea data-hfield="note" placeholder="z. B. müde, wenig geschlafen">${esc(s.note || '')}</textarea></label>
      </section>
      ${s.exercises.map((ex) => `
        <section class="card" data-hex="${ex.id}">
          <div class="ex-head"><h2>${esc(ex.name)}</h2>
            <button class="icon-btn" data-action="h-del-ex" aria-label="${esc(ex.name)} aus diesem Training entfernen">×</button></div>
          ${isCardio(ex) ? `
            <div class="cfields">${(CARDIO_TYPES[ex.cardio?.type] || CARDIO_TYPES.stepper).fields.map((f) => {
              const d = CARDIO_FIELDS[f];
              return `<div class="cfield"><label><span>${d.label}</span><span class="field"><input type="text" inputmode="${d.mode}" data-hcfield="${f}" value="${fmtNum(ex.cardio?.[f])}" placeholder="–" aria-label="${d.label}"><span>${d.unit}</span></span></label></div>`;
            }).join('')}</div>` : `
            <div class="sets">
              ${ex.sets.map((x, i) => `
                <div class="set-row hrow" data-hset="${x.id}">
                  <span class="set-no">${i + 1}${sideOf(ex, i) ? `<small>${sideOf(ex, i)}</small>` : ''}</span>
                  <label class="field"><input type="text" inputmode="decimal" data-hfield="weight" value="${fmtNum(x.weight)}" placeholder="–" aria-label="Gewicht Satz ${i + 1}"><span>kg</span></label>
                  <label class="field"><input type="text" inputmode="numeric" data-hfield="reps" value="${x.reps ?? ''}" placeholder="–" aria-label="Wiederholungen Satz ${i + 1}"><span>Wdh.</span></label>
                  <button class="icon-btn" data-action="h-del-set" aria-label="Satz ${i + 1} löschen">×</button>
                </div>`).join('')}
            </div>
            <div class="ex-foot"><button class="btn small" data-action="h-add-set">+ Satz</button></div>`}
          <div class="effort"><span>Wie war's?</span>${Object.entries(EFFORTS).map(([k, l]) =>
            `<button class="pill ${ex.effort === k ? 'on' : ''}" data-action="h-effort" data-v="${k}" aria-pressed="${ex.effort === k}">${l}</button>`).join('')}</div>
        </section>`).join('')}
      <button class="btn block" data-action="h-add-ex">+ Gerät hinzufügen</button>
      <button class="btn primary big" data-action="edit-done">Fertig</button>`;
  }
  function editCtx(el) {
    const s = state.sessions.find((x) => x.id === editId) || null;
    const card = el.closest('[data-hex]');
    const ex = s && card ? s.exercises.find((x) => x.id === card.dataset.hex) || null : null;
    const row = el.closest('[data-hset]');
    const set = ex && row ? ex.sets.find((x) => x.id === row.dataset.hset) || null : null;
    return { s, ex, set };
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
        <p class="muted">${state.sessions.length} Trainings · ${state.machines.length} Geräte gespeichert.<br>${s.lastExport ? 'Letzter Export: ' + fmtDate(s.lastExport) + ', ' + fmtTime(s.lastExport) : 'Noch nie exportiert.'}${pendingBackup().count ? `<br><b>${pendingBackup().count} ${pendingBackup().count === 1 ? 'Training' : 'Trainings'} noch nicht gesichert.</b>` : ''}</p>
        <button class="btn primary block" data-action="export">Exportieren (JSON)</button>
        <p class="small muted">Im Teilen-Menü „In Dateien sichern“ (iCloud Drive) oder AirDrop an den Mac wählen.</p>
        <label class="btn block file-btn">Backup importieren<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        <p class="small muted">Import ergänzt neue Trainings und Geräte. Trainings, die schon da sind, werden durch die Version aus der Datei ersetzt; deine Geräte-Einstellungen bleiben.</p>
      </section>
      <section class="card">
        <h2>Pause</h2>
        <div class="setting-row"><span>Standard-Pause für neue Geräte</span>
          <select data-setting="defaultRest" data-type="int">${restOptions(s.defaultRest)}</select></div>
        <div class="setting-row"><span>Schrittweite der −/+ Tasten (Gewicht)</span>
          <select data-setting="weightStep" data-type="float">${[1, 2.5, 5].map((v) => `<option value="${v}" ${v === s.weightStep ? 'selected' : ''}>${fmtNum(v)} kg</option>`).join('')}</select></div>
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
    pickerTarget = null;
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

  let pickerTarget = null; // id of the saved training being edited, null = running training
  function openPicker(target = null) {
    pickerTarget = target;
    const plan = target && target.startsWith('plan:') ? planById(target.slice(5)) : null;
    const into = plan ? null : target ? state.sessions.find((x) => x.id === target) : state.active;
    const used = new Set(plan ? plan.machineIds : into.exercises.map((e) => e.machineId));
    const list = [...state.machines].sort((a, b) => lastUsed(b.id) - lastUsed(a.id));
    sheet(`
      <h2>${plan ? 'Geräte für ' + esc(plan.name) : 'Gerät hinzufügen'}</h2>
      ${plan ? '<p class="small muted">Antippen fügt hinzu oder entfernt. Reihenfolge = Reihenfolge des Antippens.</p>' : ''}
      ${list.length > 6 ? '<input type="search" id="picker-search" placeholder="Suchen…" autocomplete="off">' : ''}
      ${list.length ? `<div class="list" id="picker-list">${list.map((m) => `
        <button class="list-item" data-action="pick-machine" data-id="${m.id}" data-name="${esc(m.name.toLowerCase())}">
          <span><b>${esc(m.name)}</b><small>${m.kind === 'cardio' ? 'Cardio · ' + (CARDIO_TYPES[m.cardioType]?.label || '') + (m.setup ? ' · ' : '') : ''}${esc(m.setup || '')}</small></span>${used.has(m.id) ? `<em>${plan ? '✓ im Plan' : 'schon dabei'}</em>` : '<i>+</i>'}
        </button>`).join('')}</div>` : ''}
      <h3>Neues Gerät</h3>
      <form class="inline-form" data-form="new-machine">
        <input type="text" name="name" placeholder="Name, z. B. Beinpresse" required autocomplete="off">
        <input type="text" name="setup" placeholder="Einstellung, z. B. Sitz 4, Lehne 2" autocomplete="off">
        ${kindSelect()}
        <button class="btn primary" type="submit">Anlegen &amp; hinzufügen</button>
      </form>
      ${plan ? '<button class="btn primary big" data-action="close-sheet">Fertig</button>' : ''}`);
  }
  function pickInto(m) {
    const t = pickerTarget;
    if (t && t.startsWith('plan:')) {
      const p = planById(t.slice(5));
      if (!p) return;
      if (p.machineIds.includes(m.id)) p.machineIds = p.machineIds.filter((x) => x !== m.id);
      else p.machineIds.push(m.id);
      save();
      const panel = $('.sheet-panel');
      const y = panel.scrollTop;
      render();
      openPicker(t);
      panel.scrollTop = y;
    } else if (t) addToSession(m, t);
    else if (state.active) addExercise(m);
  }

  function createMachine(name, setup, kind = 'kraft') {
    const existing = state.machines.find((m) => m.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const m = { id: uid(), name, setup, rest: state.settings.defaultRest, note: '', created: Date.now() };
    if (CARDIO_TYPES[kind]) { m.kind = 'cardio'; m.cardioType = kind; }
    state.machines.push(m);
    return m;
  }

  function buildExercise(m, done = false) {
    const last = lastPerformance(m.id);
    const sets = last && last.ex.sets.length
      ? last.ex.sets.map((s) => newSet(s.weight, s.reps))
      : [newSet(), newSet(), newSet()];
    if (done) sets.forEach((x) => { x.done = true; });
    const ex = { id: uid(), machineId: m.id, name: m.name, setup: m.setup || '', rest: m.rest || state.settings.defaultRest, note: '', effort: null, ...(m.sides ? { sides: true } : {}), sets };
    if (m.kind === 'cardio') {
      const lastC = (last && last.ex.cardio) || {};
      const lc = lastC.log && lastC.log.length ? { ...lastC, ...lastC.log[0] } : lastC; // start values of last time
      ex.kind = 'cardio';
      ex.sets = [];
      ex.cardio = { type: m.cardioType || 'stepper', minutes: null, speed: lc.speed ?? null, incline: lc.incline ?? null,
        level: lc.level ?? null, watts: lc.watts ?? null, startedAt: null, doneAt: null, done };
    }
    return ex;
  }
  function addToSession(m, sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    s.exercises.push(buildExercise(m, true));
    save();
    closeSheet();
    render();
  }
  function startSession(fromId = null, planId = null) {
    unlockAudio();
    const src = fromId ? state.sessions.find((x) => x.id === fromId) : null;
    const plan = planById(planId || (src && src.planId)) || null;
    const ids = planId && plan ? plan.machineIds : src ? src.exercises.map((e) => e.machineId) : [];
    state.active = { id: uid(), start: Date.now(), end: null, ...(plan ? { planId: plan.id, planName: plan.name } : {}), exercises: [] };
    state.timer = null;
    let missing = 0;
    for (const id of ids) {
      const m = machineById(id);
      if (m) state.active.exercises.push(buildExercise(m)); else missing++;
    }
    save();
    updateWakeLock();
    if (route().view !== 'training') location.hash = '#/training';
    render();
    if (!ids.length) openPicker();
    else toast(`${plan ? plan.name + ': ' : ''}${state.active.exercises.length === 1 ? '1 Gerät' : state.active.exercises.length + ' Geräte'} geladen${missing ? `, ${missing} gelöscht${missing === 1 ? 'es' : 'e'} übersprungen` : ''}`);
  }
  function addExercise(m) {
    const ex = buildExercise(m);
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
    const doneCount = a.exercises.filter(exDone).length;
    if (!doneCount) {
      if (confirm('Noch kein Satz abgehakt. Training verwerfen?')) { state.active = null; state.timer = null; save(); render(); updateWakeLock(); }
      return;
    }
    if (!confirm('Training beenden und speichern?')) return;
    if (state.timer) finalizeRest(state.timer, 'skipped');
    state.timer = null;
    a.end = Date.now();
    a.exercises = a.exercises
      .map((e) => (isCardio(e) ? e : { ...e, sets: doneSets(e.sets) }))
      .filter(exDone);
    const plan = a.planId ? planById(a.planId) : null;
    if (plan) {
      const extra = [...new Set(a.exercises.map((e) => e.machineId))].filter((id) => machineById(id) && !plan.machineIds.includes(id));
      if (extra.length && confirm(`${extra.length === 1 ? '1 Gerät war' : extra.length + ' Geräte waren'} heute neu dabei. In „${plan.name}“ aufnehmen?`)) plan.machineIds.push(...extra);
    }
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
      ...(s.source ? { source: s.source } : {}),
      ...(s.planId ? { planId: s.planId, plan: s.planName || '' } : {}),
      start: toIso(s.start),
      end: toIso(s.end),
      durationMin: s.end ? Math.round((s.end - s.start) / 60000) : null,
      note: s.note || '',
      exercises: s.exercises.map((e) => ({
        id: e.id,
        machineId: e.machineId,
        machine: e.name,
        kind: e.kind || 'strength',
        setup: e.setup || '',
        restPlannedSec: e.rest,
        effort: e.effort || null,
        note: e.note || '',
        ...(sided(e) ? { sides: true } : {}),
        ...(isCardio(e) && e.cardio ? { cardio: {
          type: e.cardio.type, minutes: e.cardio.minutes, speedKmh: e.cardio.speed, inclinePct: e.cardio.incline,
          level: e.cardio.level, watts: e.cardio.watts, startedAt: toIso(e.cardio.startedAt), doneAt: toIso(e.cardio.doneAt), done: !!e.cardio.done,
          log: (e.cardio.log || []).map((x) => ({ at: toIso(x.at), speedKmh: x.speed, inclinePct: x.incline, level: x.level, watts: x.watts })),
        } } : {}),
        sets: e.sets.map((x, i) => ({
          id: x.id,
          set: i + 1,
          ...(sideOf(e, i) ? { side: sideOf(e, i) } : {}),
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
      ...(s.source ? { source: s.source } : {}),
      ...(s.planId ? { planId: s.planId, planName: s.plan ?? s.planName ?? '' } : {}),
      start: toMs(s.start),
      end: toMs(s.end),
      note: s.note || '',
      exercises: (s.exercises || []).map((e) => ({
        id: e.id || uid(),
        machineId: e.machineId,
        name: e.machine ?? e.name ?? '?',
        ...(e.kind === 'cardio' ? { kind: 'cardio' } : {}),
        setup: e.setup || '',
        rest: e.restPlannedSec ?? e.rest ?? state.settings.defaultRest,
        effort: e.effort || null,
        note: e.note || '',
        ...(e.sides ? { sides: true } : {}),
        ...(e.kind === 'cardio' && e.cardio ? { cardio: {
          type: e.cardio.type || 'stepper', minutes: e.cardio.minutes ?? null, speed: e.cardio.speedKmh ?? e.cardio.speed ?? null,
          incline: e.cardio.inclinePct ?? e.cardio.incline ?? null, level: e.cardio.level ?? null, watts: e.cardio.watts ?? null,
          startedAt: toMs(e.cardio.startedAt), doneAt: toMs(e.cardio.doneAt), done: e.cardio.done ?? true,
          log: (e.cardio.log || []).map((x) => ({ at: toMs(x.at), speed: x.speedKmh ?? x.speed ?? null, incline: x.inclinePct ?? x.incline ?? null, level: x.level ?? null, watts: x.watts ?? null })),
        } } : {}),
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
  const serializeMachine = (m) => ({ id: m.id, name: m.name, kind: m.kind || 'strength', ...(m.kind === 'cardio' ? { cardioType: m.cardioType } : {}),
    setup: m.setup || '', restSec: m.rest, note: m.note || '', ...(m.sides != null ? { sides: !!m.sides } : {}), created: toIso(m.created) });
  const deserializeMachine = (m) => ({ id: m.id, name: m.name, ...(m.kind === 'cardio' ? { kind: 'cardio', cardioType: m.cardioType || 'stepper' } : {}),
    setup: m.setup || '', rest: m.restSec ?? m.rest ?? state.settings.defaultRest, note: m.note || '', ...(m.sides != null ? { sides: !!m.sides } : {}), created: toMs(m.created) });

  async function exportData() {
    const now = Date.now();
    const data = {
      app: 'gym-log',
      schemaVersion: 1,
      appVersion: APP_VERSION,
      exportedAt: toIso(now),
      units: { weight: 'kg', rest: 'seconds', time: 'ISO 8601 UTC' },
      machines: state.machines.map(serializeMachine),
      plans: state.plans.map((p) => ({ id: p.id, name: p.name, machineIds: p.machineIds, created: toIso(p.created) })),
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
      let addM = 0, addS = 0, updS = 0;
      for (const m of data.machines) {
        if (!m || !m.id || !m.name) continue;
        const have = machineById(m.id);
        if (!have) { state.machines.push(deserializeMachine(m)); addM++; }
        else if (!have.note && m.note) have.note = m.note;
      }
      for (const p of Array.isArray(data.plans) ? data.plans : []) {
        if (p && p.id && p.name && !planById(p.id)) state.plans.push({ id: p.id, name: p.name, machineIds: (p.machineIds || []).slice(), created: toMs(p.created) });
      }
      for (const raw of data.sessions) {
        const s = deserializeSession(raw);
        if (!s.start) continue;
        const idx = state.sessions.findIndex((x) => x.id === s.id);
        if (idx < 0) { state.sessions.push(s); addS++; }
        else if (JSON.stringify(state.sessions[idx]) !== JSON.stringify(s)) { state.sessions[idx] = s; updS++; }
      }
      state.sessions.sort((a, b) => a.start - b.start);
      migrate(state);
      save();
      render();
      toast(`Import: ${addS} neue Trainings, ${updS} aktualisiert, ${addM} neue Geräte`);
    } catch (e) {
      toast('Import fehlgeschlagen – keine gültige Gym-Log-Datei');
    }
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      const r = e.target.closest('.set-row');
      const c = r && r.closest('.exercise');
      if (r && c) selectSet(c, r);
      return;
    }
    const action = btn.dataset.action;
    const card = btn.closest('.exercise');
    const ex = card ? findEx(card.dataset.ex) : null;
    const row = btn.closest('.set-row');
    const set = ex && row ? ex.sets.find((s) => s.id === row.dataset.set) : null;

    switch (action) {
      case 'start-session': startSession(); break;
      case 'repeat-session':
        if (state.active) { toast('Es läuft schon ein Training'); return; }
        startSession(btn.dataset.id);
        break;
      case 'start-plan':
        if (state.active) { toast('Es läuft schon ein Training'); return; }
        startSession(null, btn.dataset.id);
        break;
      case 'new-plan': createPlan(); break;
      case 'save-plan': {
        const src = state.sessions.find((x) => x.id === btn.dataset.id);
        if (src) createPlan(src.exercises.map((x) => x.machineId));
        break;
      }
      case 'plan-add': openPicker('plan:' + route().id); break;
      case 'plan-up':
      case 'plan-down':
      case 'plan-remove': {
        const p = planById(route().id);
        const mid = btn.closest('[data-mid]')?.dataset.mid;
        if (!p || !mid) return;
        p.machineIds = p.machineIds.filter(machineById);
        const i = p.machineIds.indexOf(mid);
        const j = action === 'plan-up' ? i - 1 : i + 1;
        if (action === 'plan-remove') p.machineIds.splice(i, 1);
        else if (i >= 0 && j >= 0 && j < p.machineIds.length) [p.machineIds[i], p.machineIds[j]] = [p.machineIds[j], p.machineIds[i]];
        save(); render();
        break;
      }
      case 'delete-plan':
        if (confirm('Plan löschen? Trainings und Geräte bleiben erhalten.')) {
          state.plans = state.plans.filter((p) => p.id !== route().id);
          save(); location.hash = '#/training';
        }
        break;
      case 'edit-session': editId = btn.dataset.id; lastRouteKey = ''; render(); break;
      case 'edit-done': {
        const { s } = editCtx(btn);
        if (s) s.exercises = s.exercises.filter((x) => isCardio(x) || x.sets.length);
        editId = null;
        save(); lastRouteKey = ''; render();
        toast('Änderungen gespeichert');
        break;
      }
      case 'h-add-ex': if (editId) openPicker(editId); break;
      case 'h-del-ex': {
        const { s, ex: hx } = editCtx(btn);
        if (hx && confirm(`„${hx.name}“ aus diesem Training entfernen?`)) {
          s.exercises = s.exercises.filter((x) => x !== hx);
          save(); render();
        }
        break;
      }
      case 'h-add-set': {
        const { ex: hx } = editCtx(btn);
        if (!hx) return;
        const l = hx.sets[hx.sets.length - 1];
        hx.sets.push({ ...newSet(l?.weight ?? null, l?.reps ?? null), done: true });
        save(); render();
        break;
      }
      case 'h-del-set': {
        const { ex: hx, set: hs } = editCtx(btn);
        if (!hs) return;
        hx.sets.splice(hx.sets.indexOf(hs), 1);
        save(); render();
        break;
      }
      case 'h-effort': {
        const { ex: hx } = editCtx(btn);
        if (!hx) return;
        hx.effort = hx.effort === btn.dataset.v ? null : btn.dataset.v;
        save(); render();
        break;
      }
      case 'chart-pt': {
        const cap = $('#chart-cap');
        if (cap) cap.textContent = btn.dataset.label;
        document.querySelectorAll('.chart .pt.sel').forEach((c) => c.classList.remove('sel'));
        const i = [...btn.parentNode.querySelectorAll('.hit')].indexOf(btn);
        btn.parentNode.querySelectorAll('.pt')[i]?.classList.add('sel');
        break;
      }
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
        if (m) pickInto(m);
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
          if (selectedByEx[ex.id] === set.id) delete selectedByEx[ex.id];
        } else {
          selectedByEx[ex.id] = set.id;
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
        if (selectedByEx[ex.id] === set.id) delete selectedByEx[ex.id];
        save(); render();
        break;
      case 'step': {
        const bar = btn.closest('.stepper-bar');
        const target = ex && bar ? ex.sets.find((x) => x.id === bar.dataset.set) : null;
        if (!target) return;
        const r = card.querySelector(`.set-row[data-set="${target.id}"]`);
        if (r) syncRow(r, target);
        const d = Number(btn.dataset.delta);
        let input;
        if (btn.dataset.field === 'weight') {
          const step = state.settings.weightStep || 5;
          target.weight = Math.max(0, Math.round(((target.weight ?? 0) + d * step) * 100) / 100);
          input = r?.querySelector('[data-field=weight]');
          if (input) input.value = fmtNum(target.weight);
        } else {
          target.reps = Math.max(0, (target.reps ?? 0) + d);
          input = r?.querySelector('[data-field=reps]');
          if (input) input.value = target.reps;
        }
        if (input) { input.classList.remove('bump'); void input.offsetWidth; input.classList.add('bump'); }
        save();
        break;
      }
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
      case 'effort':
        if (!ex) return;
        ex.effort = ex.effort === btn.dataset.v ? null : btn.dataset.v;
        save(); render();
        break;
      case 'cardio-start':
        if (!ex) return;
        if (state.timer) { if (!state.timer.finished) finalizeRest(state.timer, 'skipped'); state.timer = null; }
        card.querySelectorAll('[data-cfield]').forEach((inp) => { ex.cardio[inp.dataset.cfield] = num(inp.value); });
        ex.cardio.startedAt = Date.now();
        ex.cardio.log = [];
        logCardio(ex.cardio, ex.cardio.startedAt);
        unlockAudio();
        save(); render();
        break;
      case 'cstep': {
        if (!ex || !ex.cardio) return;
        const f = btn.dataset.f;
        const d = CARDIO_FIELDS[f];
        const c = ex.cardio;
        c[f] = Math.max(0, Math.round(((c[f] ?? 0) + Number(btn.dataset.delta) * d.step) * 10) / 10);
        const input = card.querySelector(`[data-cfield="${f}"]`);
        if (input) { input.value = fmtNum(c[f]); input.classList.remove('bump'); void input.offsetWidth; input.classList.add('bump'); }
        logCardio(c);
        save();
        break;
      }
      case 'cardio-toggle': {
        if (!ex) return;
        const c = ex.cardio;
        card.querySelectorAll('[data-cfield]').forEach((inp) => { c[inp.dataset.cfield] = num(inp.value); });
        if (!c.done) {
          logCardio(c);
          c.done = true;
          c.doneAt = Date.now();
          if (c.minutes == null && c.startedAt) c.minutes = Math.max(1, Math.round((c.doneAt - c.startedAt) / 60000));
        } else {
          c.done = false;
          c.doneAt = null;
        }
        save(); render();
        break;
      }
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
    if (el.dataset.cfield) {
      const ex = findEx(el.closest('.exercise').dataset.ex);
      if (!ex || !ex.cardio) return;
      ex.cardio[el.dataset.cfield] = num(el.value);
      el.value = fmtNum(ex.cardio[el.dataset.cfield]);
      if (el.dataset.cfield !== 'minutes') logCardio(ex.cardio);
      save();
      return;
    }
    if (el.dataset.hfield || el.dataset.hcfield) {
      const { s, ex, set } = editCtx(el);
      if (!s) return;
      const f = el.dataset.hfield;
      if (el.dataset.hcfield) {
        if (!ex || !ex.cardio) return;
        ex.cardio[el.dataset.hcfield] = num(el.value);
        el.value = fmtNum(ex.cardio[el.dataset.hcfield]);
      } else if (set) {
        if (f === 'weight') { set.weight = num(el.value); el.value = fmtNum(set.weight); }
        else { const v = num(el.value); set.reps = v == null ? null : Math.round(v); el.value = set.reps ?? ''; }
      } else if (f === 'note') {
        s.note = el.value.trim();
      } else {
        const t = new Date(el.value).getTime();
        if (!Number.isFinite(t)) { render(); return; }
        if (f === 'start') { s.end = t + (s.end - s.start); s.start = t; } // keep the duration
        else if (t > s.start) s.end = t;
        else toast('Das Ende muss nach dem Beginn liegen');
        state.sessions.sort((a, b) => a.start - b.start);
        save(); render();
        return;
      }
      save();
      return;
    }
    if (el.dataset.pfield) {
      const p = planById(el.closest('[data-plan]').dataset.plan);
      if (!p) return;
      if (el.value.trim()) p.name = el.value.trim();
      save(); render();
      toast('Gespeichert');
      return;
    }
    if (el.dataset.sessionfield && state.active) {
      state.active[el.dataset.sessionfield] = el.value.trim();
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
      else if (f === 'sides') m.sides = el.checked;
      else if (f === 'cardioType') m.cardioType = el.value;
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
      else if (el.dataset.type === 'float') state.settings[k] = parseFloat(el.value);
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

  document.addEventListener('focusin', (e) => {
    if (!e.target.dataset?.field) return;
    const r = e.target.closest('.set-row');
    const c = r && r.closest('.exercise');
    if (r && c && !r.classList.contains('active')) selectSet(c, r);
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
    const m = createMachine(name, setup, String(fd.get('kind') || 'kraft'));
    if (setup && !m.setup) m.setup = setup;
    save();
    if (kind === 'new-machine' && (pickerTarget || state.active)) pickInto(m);
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
