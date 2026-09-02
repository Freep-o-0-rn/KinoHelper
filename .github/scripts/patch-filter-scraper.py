from pathlib import Path
import re

repo = Path('.')
filters_path = repo / 'filters.js'
bg_path = repo / 'background.js'

filters = filters_path.read_text(encoding='utf-8')
bg = bg_path.read_text(encoding='utf-8')

# Invalidate incomplete per-URL models from the previous extractor.
filters = filters.replace("const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV2';", "const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV3';")

new_fetch_model = r'''  async function fetchModel(sourceUrl, contentType) {
    const requestedUrl = normalizeStateUrl(sourceUrl, contentType);
    const response = await chrome.runtime.sendMessage({
      action: 'fetchFilterPage',
      payload: { url: requestedUrl }
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Не удалось получить страницу фильтров Кинопоиска');
    }

    const page = response.page;
    if (!page?.html || !page?.url) {
      throw new Error('Service worker не вернул страницу Кинопоиска');
    }

    const doc = new DOMParser().parseFromString(page.html, 'text/html');
    if (!doc.querySelector('h1') && !doc.body?.textContent?.includes('Кинопоиск')) {
      throw new Error('Получена некорректная страница Кинопоиска');
    }

    const model = buildModel(doc, requestedUrl, contentType);
    model.sourceUrl = requestedUrl;
    model.fetchedAt = Date.now();

    return enrichModelWithCatalog(model, {
      fetchedAt: Date.now(),
      groups: page.groups || {}
    });
  }

'''

pattern = re.compile(r"  async function fetchModel\(sourceUrl, contentType\) \{.*?\n  \}\n\n  function create\(options\) \{", re.S)
match = pattern.search(filters)
if not match:
    raise SystemExit('fetchModel block not found')
filters = filters[:match.start()] + new_fetch_model + "  function create(options) {" + filters[match.end():]

# Background-only filter page capture. It intentionally does not touch watch-session code.
insert_marker = "chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {"
if insert_marker not in bg:
    raise SystemExit('background message listener not found')

helper = r'''
function comparableFilterUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.searchParams.delete('page');
    url.searchParams.delete('ysclid');
    [...url.searchParams.keys()].forEach(key => {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    });
    const entries = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
      ak.localeCompare(bk) || av.localeCompare(bv)
    );
    url.search = '';
    entries.forEach(([key, value]) => url.searchParams.append(key, value));
    return url.href;
  } catch {
    return String(rawUrl || '');
  }
}

async function waitForFilterTab(tabId, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && /\/lists\/movies\//.test(tab.url || '')) {
      await new Promise(resolve => setTimeout(resolve, 700));
      return tab;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Служебная вкладка Кинопоиска не успела загрузиться');
}

async function scrapeFilterPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const visible = element => {
        if (!(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };

      const targets = [
        { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
        { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
        { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
      ];

      const exactVisible = text => [...document.querySelectorAll('div, span, button, label, p, a')]
        .filter(node => visible(node) && clean(node.textContent) === text)
        .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] || null;

      const clickableFor = target => {
        const reset = exactVisible(target.resetLabel);
        if (reset) {
          const clickable = reset.closest(
            'button, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
          );
          if (clickable) return clickable;
          let current = reset.parentElement;
          for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
            if (visible(current) && current.getBoundingClientRect().width > 120) return current;
          }
        }

        const heading = exactVisible(target.title);
        let root = heading?.parentElement || null;
        for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
          const candidate = [...root.querySelectorAll(
            'button, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
          )].filter(visible).find(node => {
            const text = clean(node.textContent);
            return text && text !== target.title && text.length < 80;
          });
          if (candidate) return candidate;
        }
        return null;
      };

      const resetUrlFor = key => {
        const url = new URL(location.href);
        const parts = url.pathname
          .slice('/lists/movies/'.length)
          .split('/')
          .filter(Boolean)
          .filter(segment => !segment.startsWith(`${key}--`));
        url.pathname = `/lists/movies/${parts.length ? `${parts.join('/')}/` : ''}`;
        url.searchParams.delete('page');
        url.hash = '';
        return url.href;
      };

      const findStringDeep = (value, predicate, depth = 0, seen = new Set()) => {
        if (depth > 5 || value == null) return null;
        if (typeof value === 'string') return predicate(value) ? value : null;
        if (typeof value !== 'object' && typeof value !== 'function') return null;
        if (seen.has(value)) return null;
        seen.add(value);
        let keys;
        try { keys = Object.keys(value).slice(0, 80); } catch { return null; }
        for (const key of keys) {
          let child;
          try { child = value[key]; } catch { continue; }
          const found = findStringDeep(child, predicate, depth + 1, seen);
          if (found) return found;
        }
        return null;
      };

      const optionUrlFromNode = (node, target) => {
        const candidates = [node, node.closest?.('a'), node.querySelector?.('a')].filter(Boolean);
        for (const element of candidates) {
          const attrs = [
            element.getAttribute?.('href'),
            element.getAttribute?.('data-href'),
            element.getAttribute?.('data-url'),
            element.getAttribute?.('data-link')
          ].filter(Boolean);
          for (const raw of attrs) {
            try {
              const url = new URL(raw, location.href);
              if (url.pathname.startsWith('/lists/movies/') && url.pathname.includes(`${target.key}--`)) {
                return url.href;
              }
            } catch {}
          }
        }

        // React props often keep the destination even when the visible option is a div/li.
        for (const owner of candidates) {
          for (const propName of Object.getOwnPropertyNames(owner)) {
            if (!propName.startsWith('__reactProps$') && !propName.startsWith('__reactFiber$')) continue;
            let root;
            try { root = owner[propName]; } catch { continue; }
            const raw = findStringDeep(root, text =>
              text.includes('/lists/movies/') && text.includes(`${target.key}--`)
            );
            if (raw) {
              try { return new URL(raw, location.href).href; } catch {}
            }
          }
        }

        const rawValue = node.getAttribute?.('data-value') ||
          node.getAttribute?.('data-id') || node.getAttribute?.('value');
        if (rawValue && /^[\w-]+$/u.test(rawValue)) {
          const url = new URL(resetUrlFor(target.key));
          const segments = url.pathname
            .slice('/lists/movies/'.length)
            .split('/')
            .filter(Boolean)
            .filter(segment => !segment.startsWith(`${target.key}--`));
          segments.push(`${target.key}--${rawValue}`);
          url.pathname = `/lists/movies/${segments.join('/')}/`;
          return url.href;
        }
        return null;
      };

      const menuFor = (trigger, target) => {
        const controlledId = trigger.getAttribute?.('aria-controls');
        if (controlledId) {
          const controlled = document.getElementById(controlledId);
          if (controlled && visible(controlled)) return controlled;
        }

        const listboxes = [...document.querySelectorAll('[role="listbox"], [role="menu"], ul')]
          .filter(visible)
          .filter(node => clean(node.textContent).includes(target.resetLabel));
        if (listboxes.length) {
          return listboxes.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
        }

        const reset = exactVisible(target.resetLabel);
        if (!reset) return null;
        let current = reset.parentElement;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          if (!visible(current)) continue;
          const rect = current.getBoundingClientRect();
          const optionCount = current.querySelectorAll(
            '[role="option"], [role="menuitem"], li, a, button, [data-value], [data-id]'
          ).length;
          if (rect.height >= 70 && optionCount >= 2) return current;
        }
        return null;
      };

      const collectMenuOptions = (menu, target) => {
        const nodes = [...menu.querySelectorAll(
          '[role="option"], [role="menuitem"], li, a, button, [data-value], [data-id]'
        )].filter(visible);
        const result = new Map();

        for (const node of nodes) {
          const label = clean(node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.textContent);
          if (!label || label === target.resetLabel || label.length > 70) continue;
          // Ignore wrapper nodes containing several visible option rows.
          const childRows = [...node.querySelectorAll('[role="option"], [role="menuitem"], li')]
            .filter(child => child !== node && visible(child));
          if (childRows.length > 1) continue;

          const url = optionUrlFromNode(node, target);
          if (!url) continue;
          result.set(label, { label, url });
        }
        return [...result.values()];
      };

      const groups = {};
      for (const target of targets) {
        const trigger = clickableFor(target);
        if (!trigger) continue;
        let opened = false;
        try {
          trigger.click();
          opened = true;
          await delay(250);

          let menu = null;
          for (let attempt = 0; attempt < 12 && !menu; attempt += 1) {
            menu = menuFor(trigger, target);
            if (!menu) await delay(100);
          }
          if (!menu) continue;

          const options = collectMenuOptions(menu, target);
          if (options.length) {
            groups[target.key] = {
              key: `path:${target.key}`,
              title: target.title,
              resetLabel: target.resetLabel,
              resetUrl: resetUrlFor(target.key),
              options
            };
          }
        } finally {
          if (opened) {
            try { trigger.click(); } catch {}
            await delay(80);
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true
            }));
            await delay(80);
          }
        }
      }

      return {
        html: document.documentElement.outerHTML,
        url: location.href,
        groups
      };
    }
  });

  const page = results?.[0]?.result;
  if (!page?.html || !page?.url) throw new Error('Не удалось прочитать DOM Кинопоиска');
  return page;
}

async function fetchFilterPage(url) {
  const requestedUrl = String(url || '');
  if (!requestedUrl.startsWith('https://www.kinopoisk.ru/lists/movies/')) {
    throw new Error('Недопустимый URL фильтров');
  }

  const existing = await chrome.tabs.query({
    url: ['https://www.kinopoisk.ru/lists/movies/*', 'https://kinopoisk.ru/lists/movies/*']
  });
  const matching = existing.find(tab => Number.isInteger(tab.id) && !tab.discarded && tab.url &&
    comparableFilterUrl(tab.url) === comparableFilterUrl(requestedUrl));

  let tabId = matching?.id ?? null;
  let created = false;
  try {
    if (!Number.isInteger(tabId)) {
      const tab = await chrome.tabs.create({ url: requestedUrl, active: false });
      tabId = tab.id;
      created = true;
    }
    if (!Number.isInteger(tabId)) throw new Error('Не удалось создать служебную вкладку');
    await waitForFilterTab(tabId);
    return await scrapeFilterPage(tabId);
  } finally {
    if (created && Number.isInteger(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }
}

'''

# Avoid duplicate helper on rerun.
if 'async function fetchFilterPage(url)' not in bg:
    bg = bg.replace(insert_marker, helper + insert_marker)

# Add message branch without touching watch-session branches.
needle = "  if (message.action === \"startWatchSession\") {"
branch = '''  if (message.action === "fetchFilterPage") {
    fetchFilterPage(message.payload?.url)
      .then(page => sendResponse({ ok: true, page }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

'''
if branch.strip() not in bg:
    bg = bg.replace(needle, branch + needle)

filters_path.write_text(filters, encoding='utf-8')
bg_path.write_text(bg, encoding='utf-8')
