from pathlib import Path

bg_path = Path('background.js')
text = bg_path.read_text(encoding='utf-8')
start = text.index('async function scrapeFilterPage(tabId) {')
end = text.index('async function fetchFilterPage(url) {', start)

new_func = r'''async function scrapeFilterPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

      const targets = [
        { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
        { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
        { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
      ];

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

      const buildUrlFromValue = (target, value) => {
        if (value == null || value === '') return null;
        const raw = String(value).trim();
        if (!raw || raw.length > 80) return null;

        if (target.key === 'country' && !/^\d+$/.test(raw)) return null;
        if (target.key === 'genre' && !/^[a-z0-9_-]+$/i.test(raw)) return null;
        if (target.key === 'year' && !/^\d{4}(?:[-_]\d{4})?$/.test(raw)) return null;

        const url = new URL(resetUrlFor(target.key));
        const segments = url.pathname
          .slice('/lists/movies/'.length)
          .split('/')
          .filter(Boolean)
          .filter(segment => !segment.startsWith(`${target.key}--`));
        segments.push(`${target.key}--${raw}`);
        url.pathname = `/lists/movies/${segments.join('/')}/`;
        return url.href;
      };

      const normalizeFilterUrl = (raw, target) => {
        if (typeof raw !== 'string' || !raw) return null;
        const cleaned = raw
          .replace(/\\u002F/gi, '/')
          .replace(/\\\//g, '/')
          .replace(/&amp;/g, '&');
        try {
          const url = new URL(cleaned, location.href);
          if (!/^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname)) return null;
          if (!url.pathname.startsWith('/lists/movies/')) return null;
          if (!url.pathname.includes(`${target.key}--`)) return null;
          url.protocol = 'https:';
          url.hostname = 'www.kinopoisk.ru';
          url.hash = '';
          url.searchParams.delete('page');
          return url.href;
        } catch {
          return null;
        }
      };

      const reactRoots = (...nodes) => {
        const roots = [];
        const seen = new Set();
        for (const node of nodes.filter(Boolean)) {
          let current = node;
          for (let up = 0; current && up < 3; up += 1, current = current.parentElement) {
            for (const propName of Object.getOwnPropertyNames(current)) {
              if (!propName.startsWith('__reactProps$') && !propName.startsWith('__reactFiber$')) continue;
              let value;
              try { value = current[propName]; } catch { continue; }
              if (value && !seen.has(value)) {
                seen.add(value);
                roots.push(value);
              }
            }
          }
        }
        return roots;
      };

      const findDirectUrl = (root, target, maxDepth = 9) => {
        const seen = new Set();
        let visited = 0;
        const walk = (value, depth) => {
          if (value == null || depth > maxDepth || visited > 30000) return null;
          visited += 1;
          if (typeof value === 'string') return normalizeFilterUrl(value, target);
          if (typeof value !== 'object' && typeof value !== 'function') return null;
          if (seen.has(value)) return null;
          seen.add(value);
          let keys;
          try { keys = Object.keys(value).slice(0, 120); } catch { return null; }
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch { continue; }
            const found = walk(child, depth + 1);
            if (found) return found;
          }
          return null;
        };
        return walk(root, 0);
      };

      const valueScore = (key, value, target) => {
        const name = String(key || '').toLowerCase();
        const raw = String(value ?? '').trim();
        if (!raw) return -1;

        if (target.key === 'country') {
          if (!/^\d+$/.test(raw)) return -1;
          if (name === 'countryid' || name === 'country_id') return 120;
          if (name === 'value') return 110;
          if (name === 'id') return 90;
          if (name.includes('country')) return 80;
          return -1;
        }

        if (target.key === 'genre') {
          if (!/^[a-z0-9_-]+$/i.test(raw)) return -1;
          if (name === 'slug') return 120;
          if (name === 'value') return 110;
          if (name === 'genre') return 105;
          if (name === 'genreid' || name === 'genre_id') return 100;
          if (name === 'code') return 90;
          return -1;
        }

        if (target.key === 'year') {
          if (!/^\d{4}(?:[-_]\d{4})?$/.test(raw)) return -1;
          if (name === 'year') return 120;
          if (name === 'value') return 110;
          if (name === 'id') return 80;
          return -1;
        }
        return -1;
      };

      const findValueNearLabel = (roots, label, target) => {
        let best = null;
        const seen = new Set();
        let visited = 0;

        const walk = (value, depth) => {
          if (value == null || depth > 10 || visited > 50000) return;
          visited += 1;
          if (typeof value !== 'object' && typeof value !== 'function') return;
          if (seen.has(value)) return;
          seen.add(value);

          let keys;
          try { keys = Object.keys(value).slice(0, 140); } catch { return; }
          const entries = [];
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch { continue; }
            entries.push([key, child]);
          }

          const hasLabel = entries.some(([, child]) =>
            typeof child === 'string' && clean(child) === label
          );

          if (hasLabel) {
            for (const [key, child] of entries) {
              if (typeof child !== 'string' && typeof child !== 'number') continue;
              const score = valueScore(key, child, target);
              if (score >= 0 && (!best || score > best.score)) {
                best = { score, value: String(child) };
              }
            }
            const direct = findDirectUrl(value, target, 4);
            if (direct) best = { score: 1000, url: direct };
          }

          for (const [, child] of entries) {
            if (child && (typeof child === 'object' || typeof child === 'function')) {
              walk(child, depth + 1);
            }
          }
        };

        roots.forEach(root => walk(root, 0));
        return best;
      };

      const resolveOptionUrl = (option, menu, trigger, target, label) => {
        if (label === target.resetLabel) return resetUrlFor(target.key);

        const roots = reactRoots(option, menu, trigger);
        for (const root of roots) {
          const direct = findDirectUrl(root, target);
          if (direct) return direct;
        }

        const matched = findValueNearLabel(roots, label, target);
        if (matched?.url) return matched.url;
        if (matched?.value) return buildUrlFromValue(target, matched.value);
        return null;
      };

      const waitForListbox = async trigger => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const controlledId = trigger.getAttribute('aria-controls');
          const byId = controlledId ? document.getElementById(controlledId) : null;
          const byLabel = document.querySelector(
            `[role="listbox"][aria-label="${CSS.escape(trigger.getAttribute('aria-label') || '')}"]`
          );
          const listbox = byId || byLabel;
          if (listbox && listbox.querySelector('[role="option"]')) return listbox;
          await delay(100);
        }
        return null;
      };

      const groups = {};
      const diagnostics = {};

      for (const target of targets) {
        const trigger = document.querySelector(
          `button[role="combobox"][aria-label="${CSS.escape(target.title)}"]`
        );

        if (!trigger) {
          diagnostics[target.key] = { error: 'combobox not found' };
          continue;
        }

        let openedByUs = false;
        try {
          if (trigger.getAttribute('aria-expanded') !== 'true') {
            trigger.click();
            openedByUs = true;
          }

          const listbox = await waitForListbox(trigger);
          if (!listbox) {
            diagnostics[target.key] = { error: 'listbox not found' };
            continue;
          }

          const optionNodes = [...listbox.querySelectorAll('[role="option"]')];
          const options = [];
          const unresolved = [];

          for (const option of optionNodes) {
            const label = clean(option.getAttribute('aria-label') || option.textContent);
            if (!label || label.length > 80) continue;
            const url = resolveOptionUrl(option, listbox, trigger, target, label);
            if (!url) {
              unresolved.push(label);
              continue;
            }
            options.push({
              label,
              url,
              selected: option.getAttribute('aria-selected') === 'true'
            });
          }

          diagnostics[target.key] = {
            total: optionNodes.length,
            resolved: options.length,
            unresolved: unresolved.slice(0, 12)
          };

          if (options.length) {
            groups[target.key] = {
              key: `path:${target.key}`,
              title: target.title,
              resetLabel: target.resetLabel,
              resetUrl: resetUrlFor(target.key),
              options: options.filter(option => option.label !== target.resetLabel)
            };
          }
        } finally {
          if (openedByUs && trigger.getAttribute('aria-expanded') === 'true') {
            try { trigger.click(); } catch {}
            await delay(80);
          }
        }
      }

      return {
        html: document.documentElement.outerHTML,
        url: location.href,
        groups,
        diagnostics
      };
    }
  });

  const page = results?.[0]?.result;
  if (!page?.html || !page?.url) throw new Error('Не удалось прочитать DOM Кинопоиска');
  console.log('[KinoHelper filters] listbox scrape:', page.diagnostics || {});
  return page;
}

'''

text = text[:start] + new_func + text[end:]
bg_path.write_text(text, encoding='utf-8')

filters_path = Path('filters.js')
filters = filters_path.read_text(encoding='utf-8')
filters = filters.replace("const CACHE_KEY = 'kinopoiskDynamicFilterCacheV4';", "const CACHE_KEY = 'kinopoiskDynamicFilterCacheV5';")
filters = filters.replace("const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV3';", "const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV4';")
filters_path.write_text(filters, encoding='utf-8')
