'use strict';

(() => {
  const api = window.textream;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  };

  let state = null;
  let s = {};
  let doc = { pages: [''], currentPageIndex: 0 };
  let reading = { active: false };
  let activeTab = 'guidance';
  let mics = [];
  let downloadErrors = {};
  try { activeTab = localStorage.getItem('textream.tab') || activeTab; } catch (e) { /* storage blocked */ }

  const COLORS = {
    white: '#ffffff', yellow: 'rgb(255,214,10)', green: 'rgb(51,214,74)',
    blue: 'rgb(79,140,255)', pink: 'rgb(255,97,145)', orange: 'rgb(255,158,10)',
  };
  const MODE_NOTES = {
    wordTracking: 'Follows your voice and highlights each word as you say it. Runs offline on this computer.',
    classic: 'Scrolls at a steady speed. No microphone needed.',
    silencePaused: 'Scrolls while you speak and pauses when you go quiet.',
  };
  const OVERLAY_NOTES = {
    pinned: 'A Dynamic Island–style bar at the top centre of your screen, right under the webcam. Stays above all apps.',
    floating: 'A window you can drag anywhere. Always on top.',
    fullscreen: 'Fills the chosen display. Press Esc to stop.',
  };

  // ---------------------------------------------------------------- settings schema

  const displayOptions = (autoLabel) => [[0, autoLabel], ...(state ? state.displays.map((d) => [d.id, d.label]) : [])];

  const TABS = [
    { id: 'guidance', label: 'Guidance', fields: [
      { key: 'listeningMode', type: 'seg', label: 'Guidance mode', options: [['wordTracking', 'Word Tracking'], ['classic', 'Classic'], ['silencePaused', 'Voice-Activated']], note: (v) => MODE_NOTES[v] },
      { key: 'scrollSpeed', type: 'range', label: 'Scroll speed', min: 0.5, max: 8, step: 0.5, fmt: (v) => `${v.toFixed(1)} words/s`, show: () => s.listeningMode !== 'wordTracking' },
      { custom: 'model', show: () => s.listeningMode === 'wordTracking' },
      { custom: 'mic', show: () => s.listeningMode !== 'classic' },
      { key: 'autoNextPage', type: 'check', label: 'Go to the next page automatically' },
      { key: 'autoNextPageDelay', type: 'seg', label: 'Countdown before the next page', options: [[0, 'None'], [1, '1 s'], [3, '3 s'], [5, '5 s']], show: () => s.autoNextPage },
    ] },
    { id: 'overlay', label: 'Overlay', fields: [
      { key: 'overlayMode', type: 'seg', label: 'Show the prompter as', options: [['pinned', 'Pinned to top'], ['floating', 'Floating'], ['fullscreen', 'Fullscreen']], note: (v) => OVERLAY_NOTES[v] },
      { key: 'notchDisplayMode', type: 'seg', label: 'Which screen', options: [['followMouse', 'Follow mouse'], ['fixedDisplay', 'Fixed display']], show: () => s.overlayMode === 'pinned' },
      { key: 'pinnedScreenID', type: 'select', label: 'Display', options: () => displayOptions('Main display'), show: () => s.overlayMode === 'pinned' && s.notchDisplayMode === 'fixedDisplay' },
      { key: 'overlayTransparency', type: 'check', label: 'See-through background', show: () => s.overlayMode === 'pinned' },
      { key: 'overlayTransparencyOpacity', type: 'range', label: 'Transparency', min: 0, max: 0.8, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`, show: () => s.overlayMode === 'pinned' && s.overlayTransparency },
      { key: 'floatingGlassEffect', type: 'check', label: 'Glass effect', show: () => s.overlayMode === 'floating' },
      { key: 'glassOpacity', type: 'range', label: 'Glass tint', min: 0, max: 0.6, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`, show: () => s.overlayMode === 'floating' && s.floatingGlassEffect },
      { key: 'followCursorWhenUndocked', type: 'check', label: 'Follow the mouse pointer', note: () => 'The window moves with your pointer and ignores clicks. Stop with Ctrl+Shift+. (period). Pages advance by themselves.', show: () => s.overlayMode === 'floating' },
      { key: 'fullscreenScreenID', type: 'select', label: 'Display', options: () => displayOptions('Display under the mouse'), show: () => s.overlayMode === 'fullscreen' },
      { key: 'notchWidth', type: 'range', label: 'Width', min: 310, max: 500, step: 5, fmt: (v) => `${Math.round(v)} px`, show: () => s.overlayMode !== 'fullscreen' },
      { key: 'textAreaHeight', type: 'range', label: 'Text height', min: 100, max: 400, step: 5, fmt: (v) => `${Math.round(v)} px`, show: () => s.overlayMode !== 'fullscreen' },
      { key: 'hideFromScreenShare', type: 'check', label: 'Hide from screen sharing and recordings', note: () => 'Keeps the prompter out of Zoom, Teams, OBS and screenshots on Windows 10 2004+ and macOS.' },
      { key: 'keepScreenAwake', type: 'check', label: 'Keep the screen awake while reading' },
    ] },
    { id: 'type', label: 'Type', fields: [
      { key: 'fontFamilyPreset', type: 'seg', label: 'Typeface', options: [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono'], ['dyslexia', 'Dyslexia']] },
      { key: 'fontSizePreset', type: 'seg', label: 'Text size', options: [['xs', 'XS'], ['sm', 'SM'], ['lg', 'LG'], ['xl', 'XL']] },
      { key: 'fontColorPreset', type: 'swatches', label: 'Highlight color' },
      { key: 'cueColorPreset', type: 'swatches', label: 'Cue color' },
      { key: 'cueBrightness', type: 'seg', label: 'Cue brightness', options: [['dim', 'Dim'], ['low', 'Low'], ['medium', 'Medium'], ['bright', 'Bright']] },
      { key: 'readingPosition', type: 'seg', label: 'Reading line', options: [['centered', 'Centered'], ['nearTop', 'Near top']] },
      { key: 'fullscreenFontScale', type: 'range', label: 'Fullscreen text scale', min: 1, max: 4, step: 0.25, fmt: (v) => `${v.toFixed(2)}×` },
      { key: 'showParagraphDividers', type: 'check', label: 'Show paragraph dividers' },
      { key: 'showLastSpokenWords', type: 'check', label: 'Show the last words heard', show: () => s.listeningMode === 'wordTracking' },
      { key: 'showElapsedTime', type: 'check', label: 'Show elapsed time' },
    ] },
    { id: 'displays', label: 'Displays', fields: [
      { key: 'externalDisplayMode', type: 'seg', label: 'Second display or teleprompter rig', options: [['off', 'Off'], ['teleprompter', 'Teleprompter'], ['mirror', 'Mirror']], note: (v) => ({ off: 'No second-screen output.', teleprompter: 'A fullscreen prompter on the display you pick.', mirror: 'Flipped for teleprompter glass.' })[v] },
      { key: 'externalScreenID', type: 'select', label: 'Target display', options: () => displayOptions('First other display'), show: () => s.externalDisplayMode !== 'off' },
      { key: 'mirrorAxis', type: 'seg', label: 'Mirror axis', options: [['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['both', 'Both']], show: () => s.externalDisplayMode === 'mirror', note: (v) => ({ horizontal: 'Left to right. The standard for mirror rigs.', vertical: 'Top to bottom.', both: 'Both axes (rotated 180°).' })[v] },
      { custom: 'displaysNote' },
    ] },
    { id: 'remote', label: 'Remote', fields: [
      { custom: 'remote' },
      { custom: 'director' },
    ] },
  ];

  // ---------------------------------------------------------------- render settings

  function set(patch) {
    Object.assign(s, patch);
    api.setSettings(patch);
    renderPanels();
  }

  function seg(field) {
    const name = `f-${field.key}`;
    const box = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': field.label });
    for (const [value, label] of field.options) {
      const input = el('input', { type: 'radio', name, value: String(value) });
      input.checked = String(s[field.key]) === String(value);
      input.addEventListener('change', () => set({ [field.key]: typeof value === 'number' ? Number(value) : value }));
      box.append(el('label', {}, [input, el('span', { text: label })]));
    }
    return box;
  }

  function swatches(field) {
    const box = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': field.label });
    for (const [value, css] of Object.entries(COLORS)) {
      const input = el('input', { type: 'radio', name: `f-${field.key}`, value, 'aria-label': value });
      input.checked = s[field.key] === value;
      input.addEventListener('change', () => set({ [field.key]: value }));
      const dot = el('span');
      dot.style.setProperty('--sw', css);
      box.append(el('label', { title: value[0].toUpperCase() + value.slice(1) }, [input, dot]));
    }
    return box;
  }

  function range(field) {
    const out = el('span', { class: 'readout', text: field.fmt(Number(s[field.key])) });
    const input = el('input', { type: 'range', min: field.min, max: field.max, step: field.step, 'aria-label': field.label });
    input.value = s[field.key];
    input.addEventListener('input', () => {
      out.textContent = field.fmt(Number(input.value));
      s[field.key] = Number(input.value);
      api.setSettings({ [field.key]: Number(input.value) });
    });
    return [el('div', { class: 'field-row' }, [el('span', { class: 'field-name', text: field.label }), out]), input];
  }

  function select(field) {
    const input = el('select', { 'aria-label': field.label });
    let found = false;
    for (const [value, label] of field.options()) {
      const o = el('option', { value: String(value), text: label });
      if (String(value) === String(s[field.key])) { o.selected = true; found = true; }
      input.append(o);
    }
    if (!found) {
      input.prepend(el('option', { value: String(s[field.key]), text: 'Disconnected display' }));
      input.value = String(s[field.key]);
    }
    input.addEventListener('change', () => set({ [field.key]: Number(input.value) }));
    return input;
  }

  function check(field) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!s[field.key];
    input.addEventListener('change', () => set({ [field.key]: input.checked }));
    return el('label', { class: 'check' }, [input, el('span', { text: field.label })]);
  }

  function fieldNode(field) {
    if (field.custom) return CUSTOM[field.custom]();
    const parts = [];
    if (field.type === 'check') parts.push(check(field));
    else if (field.type === 'range') parts.push(...range(field));
    else {
      parts.push(el('span', { class: 'field-name', text: field.label }));
      if (field.type === 'seg') parts.push(seg(field));
      if (field.type === 'swatches') parts.push(swatches(field));
      if (field.type === 'select') parts.push(select(field));
    }
    if (field.note) {
      const text = field.note(s[field.key]);
      if (text) parts.push(el('p', { class: 'note', text }));
    }
    return el('div', { class: 'field' }, parts);
  }

  const CUSTOM = {
    model() {
      const models = state.models;
      const current = models.find((m) => m.id === s.speechModel) || models[0];
      const box = el('div', { class: 'field' });
      box.append(el('span', { class: 'field-name', text: 'Speech model' }));
      const pick = el('select', { 'aria-label': 'Speech model' });
      for (const m of models) {
        const o = el('option', { value: m.id, text: `${m.label}${m.installed ? ' ✓' : ''}` });
        o.selected = m.id === current.id;
        pick.append(o);
      }
      pick.addEventListener('change', () => set({ speechModel: pick.value }));
      box.append(pick);
      const row = el('div', { class: 'model-row' });
      if (current.downloading !== null && current.downloading !== undefined) {
        const bar = el('i');
        bar.style.width = `${Math.round(current.downloading * 100)}%`;
        row.append(el('div', { class: 'meter' }, bar), el('span', { class: 'readout', text: `${Math.round(current.downloading * 100)}%` }));
      } else if (current.installed) {
        row.append(el('span', { class: 'note ok', text: 'Installed. Works offline.' }));
        row.append(el('button', { class: 'small danger', type: 'button', text: 'Remove', onclick: () => api.removeModel(current.id) }));
      } else {
        row.append(el('span', { class: 'note', text: 'Not downloaded yet.' }));
        row.append(el('button', { class: 'small accent', type: 'button', text: 'Download', onclick: () => download(current.id) }));
      }
      box.append(row);
      if (downloadErrors[current.id]) box.append(el('p', { class: 'note error', text: downloadErrors[current.id] }));
      box.append(el('p', { class: 'note', text: 'Downloaded once from the sherpa-onnx project on GitHub. Recognition then runs on this computer; audio never leaves it.' }));
      return box;
    },
    mic() {
      const box = el('div', { class: 'field' });
      box.append(el('span', { class: 'field-name', text: 'Microphone' }));
      const pick = el('select', { 'aria-label': 'Microphone' });
      pick.append(el('option', { value: '', text: 'System default' }));
      mics.forEach((m, i) => {
        const o = el('option', { value: m.deviceId, text: m.label || `Microphone ${i + 1}` });
        pick.append(o);
      });
      pick.value = mics.some((m) => m.deviceId === s.selectedMicId) ? s.selectedMicId : '';
      pick.addEventListener('change', () => set({ selectedMicId: pick.value }));
      pick.addEventListener('focus', refreshMics);
      box.append(pick);
      return box;
    },
    displaysNote() {
      const n = state.displays.length;
      return el('p', { class: 'note', text: n > 1 ? `${n} displays connected. iPads work too: use Remote, or Windows' wireless display / Sidecar on a Mac.` : 'Only one display is connected. To use an iPad or phone as the prompter screen, turn on Remote.' });
    },
    remote() {
      const r = state.lan.remote || {};
      const group = el('div', { class: 'group' });
      group.append(el('span', { class: 'label', text: 'Remote connection' }));
      group.append(check({ key: 'browserServerEnabled', label: 'Show the prompter on phones, tablets and other computers' }));
      group.append(el('p', { class: 'note', text: 'Open the link in any browser on the same Wi-Fi. Words, progress and the waveform follow in real time. No app needed.' }));
      if (r.running) {
        group.append(el('div', { class: 'qr-pair' }, [
          el('figure', { class: 'qr' }, [el('img', { src: r.qr, alt: 'QR code for the remote prompter' }), el('figcaption', { text: 'Normal' })]),
          el('figure', { class: 'qr' }, [el('img', { src: r.mirrorQr, alt: 'QR code for the mirrored remote prompter' }), el('figcaption', { text: 'Mirrored for glass' })]),
        ]));
        group.append(el('code', { text: r.url }));
      } else if (r.error) {
        group.append(el('p', { class: 'note error', text: r.error }));
      }
      group.append(portField('browserServerPort', 'Port'));
      return group;
    },
    director() {
      const d = state.lan.director || {};
      const group = el('div', { class: 'group' });
      group.append(el('span', { class: 'label', text: 'Director mode' }));
      group.append(check({ key: 'directorModeEnabled', label: 'Let someone else write and start the script from a browser' }));
      group.append(el('p', { class: 'note', text: 'The director edits live. Text you already read is locked; the rest stays editable. Use only on networks you trust: traffic is not encrypted.' }));
      if (d.running) {
        group.append(el('figure', { class: 'qr' }, [el('img', { src: d.qr, alt: 'QR code for the director page' })]));
        group.append(el('code', { text: d.url }));
      } else if (d.error) {
        group.append(el('p', { class: 'note error', text: d.error }));
      }
      group.append(portField('directorServerPort', 'Port'));
      return group;
    },
  };

  function portField(key, label) {
    const input = el('input', { type: 'number', min: 1024, max: 65534, 'aria-label': label });
    input.value = s[key];
    input.addEventListener('change', () => set({ [key]: Number(input.value) }));
    return el('div', { class: 'field' }, [
      el('div', { class: 'field-row' }, [el('span', { class: 'field-name', text: label }), el('span', { class: 'readout', text: `WebSocket ${Number(s[key]) + 1}` })]),
      input,
    ]);
  }

  function renderTabs() {
    const tabs = $('tabs');
    tabs.replaceChildren(...TABS.map((t) => el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(t.id === activeTab),
      text: t.label,
      onclick: () => {
        activeTab = t.id;
        try { localStorage.setItem('textream.tab', activeTab); } catch (e) { /* storage blocked */ }
        renderTabs();
        renderPanels();
      },
    })));
  }

  function renderPanels() {
    if (!state) return;
    const scroll = $('panels').scrollTop;
    const tab = TABS.find((t) => t.id === activeTab) || TABS[0];
    const group = el('div', { class: 'panel' });
    let card = el('div', { class: 'group' });
    for (const field of tab.fields) {
      if (field.show && !field.show()) continue;
      const node = fieldNode(field);
      if (node.classList.contains('group')) {
        if (card.childElementCount) group.append(card);
        group.append(node);
        card = el('div', { class: 'group' });
      } else {
        card.append(node);
      }
    }
    if (card.childElementCount) group.append(card);
    $('panels').replaceChildren(group);
    $('panels').scrollTop = scroll;
  }

  async function refreshMics() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const next = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const changed = JSON.stringify(next.map((d) => [d.deviceId, d.label])) !== JSON.stringify(mics.map((d) => [d.deviceId, d.label]));
      mics = next;
      if (changed && document.activeElement?.getAttribute('aria-label') !== 'Microphone') renderPanels();
    } catch (e) {
      mics = [];
    }
  }

  async function download(id) {
    delete downloadErrors[id];
    const result = await api.downloadModel(id);
    if (!result.ok) downloadErrors[id] = result.error;
    hideBanner();
    renderPanels();
    return result.ok;
  }

  // ---------------------------------------------------------------- document

  function wordCount(text) {
    const m = text.replace(/\[[^\]]*\]/g, ' ').match(/\S+/g);
    return m ? m.length : 0;
  }
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function renderStats() {
    const page = doc.pages[doc.currentPageIndex] || '';
    const n = wordCount(page);
    const all = doc.pages.reduce((sum, p) => sum + wordCount(p), 0);
    let text = n ? `${n} words · about ${fmt((n / 150) * 60)} at 150 wpm` : 'This page is empty';
    if (doc.pages.length > 1) text += ` · ${all} words in all`;
    $('stats').textContent = text;
    $('btn-start').disabled = !reading.active && !n;
    $('btn-all').disabled = reading.active || !all;
  }

  function renderPages() {
    const list = $('page-list');
    list.replaceChildren(...doc.pages.map((text, i) => {
      const first = text.trim().split('\n')[0] || 'Empty';
      const li = el('li', { class: `page-item${i === doc.currentPageIndex ? ' active' : ''}${reading.active && reading.pageIndex === i && !reading.directorMode ? ' reading' : ''}` });
      li.append(el('button', {
        class: 'page',
        type: 'button',
        onclick: () => {
          doc.currentPageIndex = i;
          api.updateDoc({ currentPageIndex: i });
          renderDoc();
          $('script').focus();
        },
      }, [el('b', { text: String(i + 1) }), el('span', { text: first })]));
      if (doc.pages.length > 1) {
        li.append(el('button', {
          class: 'del',
          type: 'button',
          title: 'Delete page',
          'aria-label': `Delete page ${i + 1}`,
          text: '×',
          onclick: () => {
            doc.pages.splice(i, 1);
            if (doc.currentPageIndex >= doc.pages.length) doc.currentPageIndex = doc.pages.length - 1;
            else if (doc.currentPageIndex > i) doc.currentPageIndex -= 1;
            api.updateDoc({ pages: doc.pages, currentPageIndex: doc.currentPageIndex });
            renderDoc();
          },
        }));
      }
      return li;
    }));
    $('script-label').textContent = doc.pages.length > 1 ? `Page ${doc.currentPageIndex + 1}` : 'Script';
  }

  function renderDoc() {
    const area = $('script');
    const value = doc.pages[doc.currentPageIndex] || '';
    if (area.value !== value) area.value = value;
    $('file-name').textContent = doc.fileName || 'Untitled';
    $('file-name').classList.toggle('dirty', !!doc.dirty);
    renderPages();
    renderStats();
  }

  let editTimer = 0;
  $('script').addEventListener('input', () => {
    doc.pages[doc.currentPageIndex] = $('script').value;
    renderStats();
    clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      api.updateDoc({ pages: doc.pages });
      renderPages();
    }, 150);
  });

  $('add-page').addEventListener('click', () => {
    doc.pages.push('');
    doc.currentPageIndex = doc.pages.length - 1;
    api.updateDoc({ pages: doc.pages, currentPageIndex: doc.currentPageIndex });
    renderDoc();
    $('script').focus();
  });

  $('btn-new').addEventListener('click', () => api.newFile());
  $('btn-open').addEventListener('click', () => api.openFile());
  $('btn-save').addEventListener('click', () => api.saveFile());

  // ---------------------------------------------------------------- reading

  function flushEdits() {
    clearTimeout(editTimer);
    api.updateDoc({ pages: doc.pages });
  }

  async function start(index) {
    if (reading.active) {
      api.stop();
      return;
    }
    flushEdits();
    if (s.listeningMode === 'wordTracking') {
      const model = state.models.find((m) => m.id === s.speechModel);
      if (!model || !model.installed) {
        showBanner({
          text: 'Word tracking needs its speech model, a one-time download. Or read now with Classic scrolling.',
          primary: model && model.downloading != null ? 'Downloading…' : 'Download model',
          onPrimary: async () => {
            $('banner-primary').textContent = 'Downloading…';
            $('banner-primary').disabled = true;
            if (await download(s.speechModel)) api.start(index);
            else showBanner({ text: downloadErrors[s.speechModel] || 'The download failed.', error: true });
          },
          secondary: 'Use Classic',
          onSecondary: () => {
            set({ listeningMode: 'classic' });
            hideBanner();
            api.start(index);
          },
        });
        return;
      }
    }
    hideBanner();
    api.start(index);
  }

  $('btn-start').addEventListener('click', () => start(doc.currentPageIndex));
  $('btn-all').addEventListener('click', () => start(0));

  function renderReading() {
    document.body.classList.toggle('reading', !!reading.active);
    $('start-label').textContent = reading.active ? 'Stop reading' : 'Start reading';
    renderPages();
    renderStats();
  }

  // ---------------------------------------------------------------- banner

  let bannerHandlers = {};
  function showBanner({ text, primary, onPrimary, secondary, onSecondary, error }) {
    bannerHandlers = { onPrimary, onSecondary };
    $('banner').hidden = false;
    $('banner').classList.toggle('error', !!error);
    $('banner-text').textContent = text;
    $('banner-primary').hidden = !primary;
    $('banner-primary').disabled = false;
    $('banner-primary').textContent = primary || '';
    $('banner-secondary').hidden = !secondary;
    $('banner-secondary').textContent = secondary || '';
  }
  function hideBanner() {
    $('banner').hidden = true;
  }
  $('banner-primary').addEventListener('click', () => bannerHandlers.onPrimary && bannerHandlers.onPrimary());
  $('banner-secondary').addEventListener('click', () => bannerHandlers.onSecondary && bannerHandlers.onSecondary());
  $('banner-close').addEventListener('click', hideBanner);

  // ---------------------------------------------------------------- director cover

  function renderDirector() {
    const d = state.lan.director || {};
    const on = !!(s.directorModeEnabled && d.running);
    $('director-cover').hidden = !on;
    $('script').disabled = on;
    $('btn-start').hidden = on;
    $('btn-all').hidden = on;
    if (on) {
      $('director-qr').src = d.qr || '';
      $('director-url').textContent = d.url || '';
    }
  }
  $('director-off').addEventListener('click', () => set({ directorModeEnabled: false }));

  // ---------------------------------------------------------------- drag and drop

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    drop.classList.add('over');
    $('drop-hint').hidden = false;
  });
  drop.addEventListener('dragleave', (e) => {
    if (drop.contains(e.relatedTarget)) return;
    drop.classList.remove('over');
    $('drop-hint').hidden = true;
  });
  drop.addEventListener('drop', (e) => {
    drop.classList.remove('over');
    $('drop-hint').hidden = true;
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    const p = api.pathForFile(file);
    if (p) api.openPath(p);
  });

  // ---------------------------------------------------------------- boot

  api.onDoc((next) => {
    doc = next;
    renderDoc();
  });
  api.onDocMeta((meta) => {
    doc.fileName = meta.fileName;
    doc.dirty = meta.dirty;
    $('file-name').textContent = doc.fileName || 'Untitled';
    $('file-name').classList.toggle('dirty', !!doc.dirty);
  });
  api.onSettings((next) => {
    const modelChanged = next.speechModel !== s.speechModel;
    s = next;
    if (state) state.settings = next;
    if (modelChanged || document.activeElement?.type !== 'range') renderPanels();
    renderDirector();
  });
  api.onModels((models) => {
    state.models = models;
    renderPanels();
  });
  api.onLan((lan) => {
    state.lan = lan;
    renderPanels();
    renderDirector();
  });
  api.onDisplays((displays) => {
    state.displays = displays;
    renderPanels();
  });
  api.onSession((next) => {
    reading = next;
    renderReading();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);

  api.getState().then((initial) => {
    state = initial;
    s = initial.settings;
    doc = initial.doc;
    reading = initial.session;
    document.body.classList.add(`platform-${initial.platform}`);
    renderTabs();
    renderDoc();
    renderPanels();
    renderReading();
    renderDirector();
    refreshMics();
    $('script').focus();
  });
})();
