// KinoHelper 1.551 — temporary read-only diagnostic for upper-left series controls.
// Two manual snapshots, no auto-clicking, no seeking, no persistent diagnostic data.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const beforeBtn = $('seriesProbeBefore');
  const afterBtn = $('seriesProbeAfter');
  const copyBtn = $('seriesProbeCopy');
  const clearBtn = $('seriesProbeClear');
  const status = $('seriesProbeStatus');
  const output = $('seriesProbeReport');
  if (![beforeBtn, afterBtn, copyBtn, clearBtn, status, output].every(Boolean)) return;

  let before = null;
  let after = null;
  let report = '';
  let busy = false;

  // Serialized by chrome.scripting.executeScript: no references to this outer scope.
  // Return only short labels that resemble episode/season controls, limited class
  // hints and numeric selection attributes. Never read URLs, HTML or media src.
  function inspectFrame() {
    const limit = 90;
    const selectedAttrs = ['aria-selected', 'aria-current', 'aria-pressed',
      'aria-expanded', 'data-selected', 'data-active',
      'data-season', 'data-episode', 'data-seria'];
    const roots = [document];
    const entries = [];
    const seen = new Set();
    let inspected = 0;

    function safeClass(el) {
      const names = String(el.getAttribute?.('class') || '').split(/\s+/);
      return names.filter(x => /season|episode|series|seria|sezon|seriya|active|selected|current|dropdown|switch|tab|item|list/i.test(x))
        .filter(x => /^[a-zA-Z0-9_-]{1,32}$/.test(x)).slice(0, 5).join('.');
    }
    function safeText(value) {
      const s = String(value || '').replace(/\s+/g, ' ').trim();
      if (!s || s.length > 64) return '';
      const hint = /(?:сезон|серия|серии|эпизод|season|episode|series|^s\d{1,3}e\d{1,3}$|^\d{1,3}\s*[xх×]\s*\d{1,3}$|^\d{1,3}$)/i;
      return hint.test(s) ? s : '';
    }

    const selectors = [
      'button', 'select', '[role="button"]', '[role="tab"]', '[role="option"]',
      '[aria-selected]', '[aria-expanded]', '[aria-current]', '[data-selected]',
      '[data-season]', '[data-episode]', '[data-seria]',
      '[class*="season" i]', '[class*="episode" i]',
      '[class*="series" i]', '[class*="seria" i]',
      '[class*="active" i]', '[class*="selected" i]',
      '[class*="dropdown" i]'
    ].join(',');

    for (let r = 0; r < roots.length && r < 12; r++) {
      const root = roots[r];
      const elements = root.querySelectorAll(selectors);
      for (const el of elements) {
        if (++inspected > 1800 || entries.length >= limit) break;
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') continue;
        const rect = el.getBoundingClientRect?.();
        if (rect && (rect.width < 4 || rect.height < 4)) continue;
        const vwidth = Math.max(1, window.innerWidth || 1);
        const vheight = Math.max(1, window.innerHeight || 1);
        const upperLeft = Boolean(rect && rect.left < vwidth * 0.65 &&
          rect.top < vheight * 0.55 && rect.bottom > 0 && rect.right > 0);
        const classes = safeClass(el);
        const parent = safeClass(el.parentElement || {});
        const attrs = {};
        for (const k of selectedAttrs) {
          const raw = el.getAttribute?.(k);
          if (raw != null && /^(true|false|page|step|\d{1,3})$/i.test(String(raw))) {
            attrs[k] = String(raw);
          }
        }
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        const text = safeText(el.getAttribute?.('aria-label')) ||
          safeText(el.getAttribute?.('title')) ||
          safeText(el.textContent);
        const selected = el.tagName === 'SELECT'
          ? (safeText(el.selectedOptions?.[0]?.textContent) ||
              (/^\d{1,3}$/.test(el.value || '') ? el.value : ''))
          : '';
        const hasHint = Boolean(text || selected ||
          /season|episode|series|seria|sezon|seriya/i.test(classes + ' ' + parent));
        const selectedState = /(?:^|\.)active|selected|current/i.test(classes) ||
          ['true', 'step', 'page'].some(v =>
            Object.values(attrs).includes(v));
        if (!hasHint && !upperLeft && !selectedState) continue;
        // Avoid arbitrary unlabeled navigation controls outside episode menu.
        if (!hasHint && !selectedState && !upperLeft) continue;
        if (!hasHint && !selectedState && !text) continue;
        const location = rect ? [
          Math.round(rect.left / vwidth * 100),
          Math.round(rect.top / vheight * 100)
        ] : [];
        entries.push({
          tag: String(el.tagName || '').toLowerCase().slice(0, 12),
          role: ['button','tab','option','menuitem','listbox','combobox'].includes(role) ? role : '',
          text, selected, classes, parent, attrs, xy: location
        });
      }
      if (inspected > 1800 || entries.length >= limit) break;
      const descendants = root.querySelectorAll('*');
      for (let i = 0; i < descendants.length && i < 1400 && roots.length < 12; i++) {
        if (descendants[i].shadowRoot) roots.push(descendants[i].shadowRoot);
      }
    }

    const videos = [...document.querySelectorAll('video')].slice(0, 4).map(v => ({
      at: Number.isFinite(v.currentTime) ? Math.floor(v.currentTime) : null,
      duration: Number.isFinite(v.duration) ? Math.floor(v.duration) : null,
      ready: Number(v.readyState) || 0
    }));
    return {
      candidates: entries, inspected,
      videoCount: document.querySelectorAll('video').length,
      iframeCount: document.querySelectorAll('iframe').length,
      videos
    };
  }

  function host(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' ? u.hostname.toLowerCase() : 'other';
    } catch { return 'unknown'; }
  }
  function media(raw) {
    try {
      const match = new URL(raw).pathname.match(/^\/(film|series)\/([1-9]\d{0,12})(?:\/|$)/);
      return match ? { kind: match[1], id: match[2] } : null;
    } catch { return null; }
  }
  async function capture() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw Error('Сначала открой сериал в активной вкладке.');
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    if (!Array.isArray(frames) || !frames.length) throw Error('Chrome не вернул фреймы.');

    const supported = frames.filter(frame =>
      ['brogiro.cfd', 'theatre.stravers.live'].includes(host(frame.url))).slice(0, 12);
    const frameResult = await Promise.all(supported.map(async frame => {
      try {
        const response = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frame.frameId] },
          world: 'ISOLATED', func: inspectFrame
        });
        return { id: frame.frameId, host: host(frame.url), data: response?.[0]?.result || null };
      } catch {
        return { id: frame.frameId, host: host(frame.url), error: 'нет доступа' };
      }
    }));

    let sessionType = 'нет';
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getWatchSession', tabId: tab.id
      });
      if (response?.ok && ['film', 'series'].includes(response.session?.type)) {
        sessionType = response.session.type;
      }
    } catch { /* no session */ }

    const parsed = media(tab.url);
    let filmSaved = false;
    let seriesSaved = false;
    if (parsed) {
      try {
        const r = await chrome.storage.local.get('kinoPlaybackProgressV1');
        const store = r.kinoPlaybackProgressV1 || {};
        filmSaved = Boolean(store['film:' + parsed.id]);
        seriesSaved = Boolean(store['series:' + parsed.id]);
      } catch { /* storage unavailable */ }
    }
    return {
      pageHost: host(tab.url), pageType: parsed?.kind || 'не определён',
      mediaId: parsed?.id || 'нет', sessionType,
      filmSaved, seriesSaved,
      totalFrames: frames.length, frames: frameResult
    };
  }

  function signature(item) {
    return [item.tag, item.role, item.text, item.selected,
      item.classes, item.parent,
      ...Object.entries(item.attrs).sort(([a],[b]) =>
        a.localeCompare(b)).map(([k, v]) => k + ':' + v)
    ].join(' | ');
  }
  function formatFrame(frame) {
    if (!frame.data) return 'Фрейм ' + frame.id + ' (' + frame.host + '): ' + (frame.error || 'нет данных');
    const f = frame.data;
    const lines = [
      'Фрейм ' + frame.id + ' (' + frame.host + ')',
      '  Видео: ' + f.videoCount + ' · iframe: ' + f.iframeCount +
        ' · элементов проверено: ' + f.inspected,
      '  Плееры: ' + f.videos.map(v => [v.at ?? '—',v.duration ?? '—','ready='+v.ready].join('/')).join('; '),
      '  Элементы выбора (' + f.candidates.length + '):'
    ];
    for (const [i, c] of f.candidates.slice(0, 38).entries()) {
      lines.push('    ' + (i + 1) + '. ' + signature(c) +
        (c.xy?.length ? ' · x/y ' + c.xy.join('%/') + '%' : ''));
    }
    return lines.join('\n');
  }
  function differences(a, b) {
    const key = f => f.host + ':' + f.id;
    const left = new Map(a.frames.map(f => [key(f), f.data?.candidates.map(signature) || []]));
    const right = new Map(b.frames.map(f => [key(f), f.data?.candidates.map(signature) || []]));
    const diffs = [];
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const prev = left.get(name) || [], next = right.get(name) || [];
      const removed = prev.filter(v => !next.includes(v)).slice(0, 14);
      const added = next.filter(v => !prev.includes(v)).slice(0, 14);
      if (!removed.length && !added.length) continue;
      diffs.push(name);
      for (const item of removed) diffs.push('  Было: ' + item);
      for (const item of added) diffs.push('  Стало: ' + item);
    }
    return diffs.length ? diffs.join('\n') :
      'Явных изменений элементов не найдено (возможно, плеер перезагрузил iframe).';
  }
  function draw() {
    if (!before) {
      report = ''; output.hidden = true; output.textContent = '';
      copyBtn.hidden = true; return;
    }
    const lines = [
      'KinoHelper — диагностика сезонов и серий (1.551)',
      'Режим: только чтение, управление плеером отключено',
      'Страница: ' + before.pageHost,
      'Тип по адресу: ' + before.pageType + ' · ID: ' + before.mediaId,
      'Тип сессии: ' + before.sessionType,
      'Есть сохранение как фильм: ' + before.filmSaved,
      'Есть сохранение как сериал: ' + before.seriesSaved,
      'Фреймы: ' + before.frames.length + '/' + before.totalFrames,
      '', 'ДО ПЕРЕКЛЮЧЕНИЯ:', ...before.frames.map(formatFrame)
    ];
    if (after) {
      lines.push('', 'ПОСЛЕ ПЕРЕКЛЮЧЕНИЯ:', ...after.frames.map(formatFrame),
        '', 'ИЗМЕНИВШИЕСЯ ЭЛЕМЕНТЫ:', differences(before, after));
    }
    report = lines.join('\n');
    output.textContent = report; output.hidden = false;
    copyBtn.hidden = false;
  }
  async function take(isAfter) {
    if (busy) return;
    busy = true;
    beforeBtn.disabled = afterBtn.disabled = true;
    status.textContent = 'Читаю элементы переключателя в доступных фреймах…';
    try {
      const value = await capture();
      if (isAfter) {
        if (!before) throw Error('Сначала сделай первый снимок.');
        after = value;
        status.textContent = 'Готово. Скопируй отчёт и пришли его сюда.';
      } else {
        before = value;
        after = null;
        status.textContent = 'Первый снимок готов. Переключи серию вручную и сделай второй.';
      }
      draw();
    } catch (error) {
      status.textContent = 'Не удалось получить данные: ' + (error.message || error);
    } finally {
      busy = false;
      beforeBtn.disabled = afterBtn.disabled = false;
    }
  }

  beforeBtn.addEventListener('click', () => void take(false));
  afterBtn.addEventListener('click', () => void take(true));
  clearBtn.addEventListener('click', () => {
    before = after = null; report = '';
    status.textContent = 'Снимки очищены.';
    draw();
  });
  copyBtn.addEventListener('click', async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      status.textContent = 'Отчёт скопирован. В нём нет адресов плеера и ссылок на потоки.';
    } catch {
      status.textContent = 'Копирование недоступно. Выдели текст отчёта вручную.';
    }
  });
})();
