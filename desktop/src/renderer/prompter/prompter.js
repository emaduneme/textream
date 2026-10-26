'use strict';

(() => {
  const api = window.textream;
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') || 'pinned';
  const capture = params.get('capture') === '1';
  const big = kind === 'fullscreen' || kind === 'external' || kind === 'mirror';
  const interactive = kind !== 'external' && kind !== 'mirror';

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const root = document.documentElement;
  const viewport = $('viewport');
  const wordsEl = $('words');
  const flip = $('flip');
  const marker = $('marker');

  body.classList.add(`kind-${kind}`);
  if (big) body.classList.add('big');

  let content = { active: false, items: [], words: [], totalCharCount: 0 };
  let tick = { charCount: 0, wordProgress: 0, levels: [] };
  let style = {};
  let platform = '';
  let spans = [];
  let letterCounts = [];
  let lines = [];
  let lineOfWord = [];
  let lineHeight = 28;
  let lastColored = -1;
  let lastTarget = null;
  let raf = 0;

  const LETTER = /[\p{L}\p{N}]/u;
  const FONTS = { sans: 'var(--font-sans)', serif: 'var(--font-serif)', mono: 'var(--font-mono)', dyslexia: 'var(--font-dyslexia)' };
  const AXES = { horizontal: [-1, 1], vertical: [1, -1], both: [-1, -1] };

  function parseColor(c) {
    if (!c) return [255, 255, 255];
    if (c[0] === '#') {
      const v = c.length === 4 ? [c[1] + c[1], c[2] + c[2], c[3] + c[3]] : [c.slice(1, 3), c.slice(3, 5), c.slice(5, 7)];
      return v.map((h) => parseInt(h, 16));
    }
    const m = c.match(/\d+/g);
    return m ? m.slice(0, 3).map(Number) : [255, 255, 255];
  }
  const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

  // ---------------------------------------------------------------- style

  function applyStyle(next) {
    style = next || style;
    const size = big ? Math.round(style.fontSize * (style.fullscreenFontScale || 2.5)) : style.fontSize;
    root.style.setProperty('--font-size', `${size}px`);
    root.style.setProperty('--font', FONTS[style.fontFamily] || FONTS.sans);
    root.style.setProperty('--ink', style.fontColor || '#fff');
    root.style.setProperty('--cue', style.cueColor || '#fff');
    root.style.setProperty('--glass-tint', String(style.glassOpacity ?? 0.15));
    body.classList.toggle('glass', kind === 'floating' && !!style.glass);
    body.classList.toggle('no-blur', platform === 'linux');
    if (kind === 'pinned' && style.transparency) {
      root.style.setProperty('--panel', `rgba(0,0,0,${Math.max(0.2, 1 - (style.transparencyOpacity ?? 0.5))})`);
    } else {
      root.style.removeProperty('--panel');
    }
    $('elapsed').hidden = !style.showElapsedTime;
    const [sx, sy] = kind === 'mirror' ? AXES[style.mirrorAxis] || AXES.horizontal : [1, 1];
    flip.style.transform = `scale(${sx}, ${sy})`;
    buildWords();
  }

  // ---------------------------------------------------------------- words

  function buildWords() {
    wordsEl.textContent = '';
    spans = [];
    letterCounts = [];
    lastColored = -1;
    lastTarget = null;
    wordsEl.dir = content.direction === 'rtl' ? 'rtl' : 'ltr';
    const frag = document.createDocumentFragment();
    (content.items || []).forEach((item, i) => {
      if (style.showParagraphDividers && item.paragraphBreak && i > 0) {
        const d = document.createElement('span');
        d.className = 'divider';
        frag.appendChild(d);
      }
      const s = document.createElement('span');
      s.className = item.isAnnotation ? 'w ann' : 'w';
      s.dataset.i = String(i);
      s.textContent = `${item.word} `;
      frag.appendChild(s);
      spans.push(s);
      let n = 0;
      for (const ch of item.word) if (LETTER.test(ch)) n++;
      letterCounts.push(Math.max(1, n));
    });
    wordsEl.appendChild(frag);
    measure();
    colorize(true);
    position(true);
  }

  function measure() {
    lines = [];
    lineOfWord = new Array(spans.length);
    const probe = spans[0];
    lineHeight = probe ? probe.offsetHeight || parseFloat(getComputedStyle(wordsEl).lineHeight) || 28 : 28;
    let current = null;
    spans.forEach((s, i) => {
      const top = s.offsetTop;
      if (!current || Math.abs(top - current.top) > lineHeight / 2) {
        current = { top, height: s.offsetHeight || lineHeight, first: i, last: i };
        lines.push(current);
      } else {
        current.last = i;
      }
      lineOfWord[i] = lines.length - 1;
    });
  }

  /// The word the reader is on: the first spoken word not fully lit.
  function activeWordIndex(charCount) {
    const items = content.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].isAnnotation) continue;
      const lit = Math.max(0, Math.min(items[i].word.length, charCount - items[i].charOffset));
      if (lit < letterCounts[i]) return i;
    }
    return items.length - 1;
  }

  function colorize(force) {
    const charCount = tick.charCount || 0;
    if (!force && charCount === lastColored) return;
    lastColored = charCount;
    const ink = parseColor(style.fontColor);
    const cue = parseColor(style.cueColor);
    const items = content.items || [];
    const highlight = !!content.highlightWords;
    const next = highlight ? activeWordIndex(charCount) : -1;
    for (let i = 0; i < spans.length; i++) {
      const item = items[i];
      const s = spans[i];
      let color;
      let current = false;
      if (!highlight) {
        color = item.isAnnotation ? rgba(cue, style.cueUnreadOpacity) : style.fontColor;
      } else {
        const into = charCount - item.charOffset;
        const lit = Math.max(0, Math.min(item.word.length, into));
        const fullyLit = lit >= letterCounts[i];
        if (item.isAnnotation) {
          color = rgba(cue, fullyLit ? style.cueReadOpacity : style.cueUnreadOpacity);
        } else {
          current = i === next || (into >= 0 && !fullyLit);
          color = fullyLit ? rgba(ink, 0.3) : current ? rgba(ink, 0.6) : style.fontColor;
        }
      }
      if (s.__color !== color) {
        s.style.color = color;
        s.__color = color;
      }
      if (s.__cur !== current) {
        s.classList.toggle('cur', current);
        s.__cur = current;
      }
    }
  }

  function readingY() {
    const h = viewport.clientHeight;
    if (style.readingPosition === 'nearTop') return big ? h * 0.3 : Math.min(h * 0.5, lineHeight * 1.5 + 4);
    return h * 0.5;
  }

  /// Content y of the reading point for a fractional word index: moves
  /// steadily through each line instead of jumping line by line.
  function yForProgress(p) {
    if (!lines.length) return 0;
    const i = Math.max(0, Math.min(spans.length - 1, Math.floor(p)));
    const line = lines[lineOfWord[i]];
    const count = line.last - line.first + 1;
    const f = Math.max(0, Math.min(1, (p - line.first) / count));
    return line.top + f * line.height + line.height / 2;
  }

  function position(instant) {
    if (!spans.length) {
      wordsEl.style.transform = 'translate3d(0,0,0)';
      return;
    }
    const y = readingY();
    marker.style.top = `${y}px`;
    let target;
    if (content.highlightWords) {
      const line = lines[lineOfWord[activeWordIndex(tick.charCount || 0)]];
      target = line ? line.top + line.height / 2 : 0;
      wordsEl.classList.toggle('track', !instant);
    } else {
      let p = tick.wordProgress || 0;
      if (tick.advancing) p += (tick.wordsPerSecond || 0) * Math.max(0, Date.now() - tick.at) / 1000;
      target = yForProgress(Math.min(p, spans.length));
      wordsEl.classList.remove('track');
    }
    if (target === lastTarget && !instant) return;
    lastTarget = target;
    wordsEl.style.transform = `translate3d(0, ${Math.round((y - target) * 10) / 10}px, 0)`;
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!content.highlightWords) position(false);
    pollGamepads(now || performance.now());
  }

  // ---------------------------------------------------------------- chrome

  function fmt(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  const waveBars = [];
  for (let i = 0; i < 30; i++) {
    const b = document.createElement('i');
    $('wave').appendChild(b);
    waveBars.push(b);
  }

  function renderChrome() {
    const voice = content.mode !== 'classic';
    body.classList.toggle('mode-classic', content.mode === 'classic');
    body.classList.toggle('voice', voice);
    body.classList.toggle('paused', !!tick.paused);
    body.classList.toggle('muted', !!tick.muted);
    $('pause').title = content.mode === 'classic' ? (tick.paused ? 'Play (Space)' : 'Pause (Space)') : (tick.muted ? 'Unmute (Space)' : 'Mute (Space)');

    const pct = tick.totalCharCount > 0 ? tick.charCount / tick.totalCharCount : 0;
    const levels = tick.levels || [];
    const maxH = big ? 32 : 24;
    waveBars.forEach((b, i) => {
      const level = levels[i] || 0;
      const lit = (waveBars.length > 1 ? i / (waveBars.length - 1) : 0) <= pct && pct > 0;
      b.style.height = `${Math.max(3, level * maxH)}px`;
      b.style.background = lit ? 'rgba(250,204,21,0.9)' : 'rgba(255,255,255,0.15)';
    });

    const status = $('status');
    status.classList.toggle('error', !!tick.error);
    if (tick.error) {
      status.textContent = tick.error;
      status.title = tick.error;
    } else {
      let text = '';
      if (tick.speechLoading) text = 'Loading speech model…';
      else if (tick.muted) text = 'Microphone muted';
      else if (content.mode === 'classic' && tick.paused) text = 'Paused';
      else if (content.mode === 'wordTracking' && style.showLastSpokenWords) {
        text = (tick.lastSpokenText || '').toLowerCase().split(' ').slice(-3).join(' ');
      } else if (content.mode === 'silencePaused' && !tick.isListening) text = 'Waiting for microphone…';
      const bdi = document.createElement('bdi');
      bdi.textContent = text;
      status.replaceChildren(bdi);
      status.title = '';
    }

    $('prev').hidden = !content.hasPreviousPage;
    $('next').hidden = !content.hasNextPage;
    $('page-label').textContent = content.pageCount > 1 ? `Page ${content.pageIndex + 1} of ${content.pageCount}` : '';

    const done = !!tick.isDone;
    $('done').hidden = !done || tick.countdown > 0;
    $('done-next').hidden = !(done && tick.hasNextPage && interactive);
    $('done-label').textContent = tick.hasNextPage ? 'Page done' : 'Done!';
    $('countdown').hidden = !(tick.countdown > 0);
    $('countdown').textContent = tick.countdown > 0 ? String(tick.countdown) : '';
    $('waiting').hidden = content.active;
    $('speed').textContent = `${Number(tick.wordsPerSecond || 0).toFixed(1)} w/s`;
  }

  setInterval(() => {
    if (tick.startedAt) $('elapsed').textContent = fmt(Date.now() - tick.startedAt);
  }, 500);

  // ---------------------------------------------------------------- remote

  const perLine = () => Math.max(1, Math.round(lines.length ? spans.length / lines.length : 6));

  /// Remote buttons: forward and back move one line; the rest go to main.
  function remote(cmd) {
    if (cmd === 'forward') api.control('scrollBy', perLine());
    else if (cmd === 'back') api.control('scrollBy', -perLine());
    else api.control('remote', cmd);
    showHud();
  }
  api.onRemote(remote);

  // Bluetooth remotes in game mode show up as gamepads. Only the overlay
  // (the window that also captures audio) polls, so a second display never
  // handles the same press twice. Standard mapping: A or Start pauses,
  // B goes back a line, X and Y change page, the stick or D-pad moves by
  // line (left/right) and changes speed (up/down).
  const PAD_BUTTONS = { 0: 'toggle', 9: 'toggle', 1: 'back', 2: 'previousPage', 3: 'nextPage', 12: 'faster', 13: 'slower', 14: 'back', 15: 'forward' };
  const padState = new Map();
  let remoteEnabled = true;

  function pollGamepads(now) {
    if (!capture || !remoteEnabled || !navigator.getGamepads) return;
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected) continue;
      const state = padState.get(pad.index) || { buttons: [], axis: null, axisAt: 0 };
      pad.buttons.forEach((b, i) => {
        const pressed = !!(b && b.pressed);
        if (pressed && !state.buttons[i] && PAD_BUTTONS[i]) remote(PAD_BUTTONS[i]);
        state.buttons[i] = pressed;
      });
      const [x = 0, y = 0] = pad.axes;
      let dir = null;
      if (Math.abs(x) > 0.6 && Math.abs(x) >= Math.abs(y)) dir = x > 0 ? 'forward' : 'back';
      else if (Math.abs(y) > 0.6) dir = y < 0 ? 'faster' : 'slower';
      // Fire on push, then repeat while held.
      if (dir && (dir !== state.axis || now - state.axisAt > 350)) {
        remote(dir);
        state.axisAt = now;
      }
      state.axis = dir;
      padState.set(pad.index, state);
    }
  }

  // ---------------------------------------------------------------- input

  if (interactive) {
    wordsEl.addEventListener('click', (e) => {
      const s = e.target.closest('.w');
      if (!s) return;
      const item = content.items[Number(s.dataset.i)];
      if (item) api.control('jumpTo', item.charOffset);
    });

    let wheelWords = 0;
    let wheelTimer = 0;
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const perLine = lines.length ? spans.length / lines.length : 6;
      wheelWords += (e.deltaY / lineHeight) * perLine * (e.deltaMode === 1 ? lineHeight / 3 : 1);
      if (wheelTimer) return;
      wheelTimer = setTimeout(() => {
        wheelTimer = 0;
        const step = content.highlightWords ? Math.trunc(wheelWords / perLine) * Math.round(perLine) : wheelWords;
        if (step) {
          api.control('scrollBy', step);
          wheelWords -= step;
        }
        if (content.highlightWords) wheelWords *= 0.5;
        else wheelWords = 0;
      }, 50);
    }, { passive: false });

    $('pause').addEventListener('click', () => api.control('togglePause'));
    $('stop').addEventListener('click', () => api.control('stop'));
    $('prev').addEventListener('click', () => api.control('previousPage'));
    $('next').addEventListener('click', () => api.control('nextPage'));
    $('done-next').addEventListener('click', () => api.control('nextPage'));
    $('slower').addEventListener('click', () => api.control('speed', -0.5));
    $('faster').addEventListener('click', () => api.control('speed', 0.5));
    $('restart').addEventListener('click', () => api.control('restartPage'));

    document.addEventListener('keydown', (e) => {
      const k = e.key;
      let handled = true;
      // Enter covers remotes in key mode, whose main button sends it.
      if (k === ' ' || k === 'MediaPlayPause' || (k === 'Enter' && !e.target.closest('button'))) api.control('togglePause');
      else if (k === 'Escape') api.control('stop');
      else if (k === 'ArrowUp') api.control('speed', 0.5);
      else if (k === 'ArrowDown') api.control('speed', -0.5);
      else if (k === 'ArrowRight' || k === 'PageDown') remote('forward');
      else if (k === 'ArrowLeft' || k === 'PageUp') remote('back');
      else if (k === 'Home') api.control('restartPage');
      else if (k === ']') api.control('nextPage');
      else if (k === '[') api.control('previousPage');
      else handled = false;
      if (handled) {
        e.preventDefault();
        showHud();
      }
    });
  }

  // Full-display HUD hides itself while reading.
  let hudTimer = 0;
  function showHud() {
    if (!big) return;
    body.classList.remove('hud-hidden');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      if (!$('controls').matches(':hover')) body.classList.add('hud-hidden');
    }, 2500);
  }
  if (big) {
    document.addEventListener('mousemove', showHud);
    showHud();
  }

  // ---------------------------------------------------------------- audio

  let audio = null;

  async function startCapture(micId) {
    if (audio || !capture) return;
    audio = { starting: true };
    let stream;
    const constraints = (id) => ({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(micId));
    } catch (e) {
      try {
        // The saved microphone may be unplugged; fall back to the default.
        stream = micId ? await navigator.mediaDevices.getUserMedia(constraints('')) : null;
      } catch (e2) {
        stream = null;
      }
      if (!stream) {
        audio = null;
        api.micError(`Microphone unavailable: ${e.message || e.name}`);
        return;
      }
    }
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('capture-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'textream-capture', { numberOfOutputs: 1 });
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      node.port.onmessage = (e) => {
        api.sendAudio(e.data.level, content.wantsSamples ? e.data.samples : null);
      };
      audio = { ctx, stream, node };
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      audio = null;
      api.micError(`Could not start audio: ${e.message || e.name}`);
    }
  }

  function stopCapture() {
    if (!audio || audio.starting) return;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
  }

  // ---------------------------------------------------------------- wiring

  function onContent(next) {
    content = next;
    buildWords();
    renderChrome();
    if (content.active && content.needsMicrophone) startCapture(micIdSetting);
    else stopCapture();
  }

  function onTick(next) {
    tick = next;
    colorize(false);
    if (content.highlightWords) position(false);
    renderChrome();
  }

  let micIdSetting = '';
  api.onContent(onContent);
  api.onTick(onTick);
  api.onStyle((s) => applyStyle(s));

  // Re-flow when the view changes size: window resizes, and the pinned
  // island growing out of its notch-sized pill.
  let resizeRaf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      measure();
      position(true);
    });
  }).observe($('column'));
  if (document.fonts) document.fonts.ready.then(() => { measure(); position(true); });

  api.initPrompter().then((init) => {
    platform = init.platform;
    micIdSetting = init.settings.selectedMicId || '';
    remoteEnabled = init.settings.remoteControl !== false;
    style = init.style;
    tick = init.tick;
    onContent(init.content);
    applyStyle(init.style);
    loop();
    requestAnimationFrame(() => body.classList.add('open'));
  });
})();
