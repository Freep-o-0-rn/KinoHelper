from pathlib import Path

path = Path('filters.js')
text = path.read_text(encoding='utf-8')
start = text.index('  async function extractFilterCatalogFromOpenTab() {')
end = text.index('  function isKinopoiskListsUrl(rawUrl) {', start)

replacement = r'''  async function extractFilterCatalogFromTab(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const targets = [
          { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
          { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
          { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
        ];

        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const visible = element => {
          if (!(element instanceof Element)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
        };

        const exact = text => [...document.querySelectorAll('div, span, button, label, p')]
          .filter(node => clean(node.textContent) === text)
          .sort((a, b) => {
            const av = visible(a) ? 1 : 0;
            const bv = visible(b) ? 1 : 0;
            if (av !== bv) return bv - av;
            return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
          })[0] || null;

        const clickableFor = target => {
          const reset = exact(target.resetLabel);
          if (reset) {
            const clickable = reset.closest(
              'button, a, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
            );
            if (clickable) return clickable;

            let current = reset.parentElement;
            for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
              if (visible(current) && current.getBoundingClientRect().width > 100) return current;
            }
          }

          const heading = exact(target.title);
          let root = heading?.parentElement || null;
          for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
            const nodes = [...root.querySelectorAll(
              'button, a, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
            )].filter(visible);
            const candidate = nodes.find(node => {
              const value = clean(node.textContent);
              return value && value !== target.title && value.length < 80;
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

        const optionUrlFromNode = (node, target) => {
          const attrs = [
            node.getAttribute?.('href'),
            node.getAttribute?.('data-href'),
            node.getAttribute?.('data-url'),
            node.getAttribute?.('data-link')
          ].filter(Boolean);

          for (const raw of attrs) {
            try {
              const url = new URL(raw, location.href);
              if (url.pathname.startsWith('/lists/movies/') &&
                  url.pathname.includes(`${target.key}--`)) {
                return url.href;
              }
            } catch {}
          }

          const html = node.outerHTML || '';
          const escaped = html.replace(/&amp;/g, '&').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
          const pathMatch = escaped.match(new RegExp(
            `(?:https?:\\/\\/(?:www\\.)?kinopoisk\\.ru)?(\\/lists\\/movies\\/[^\"'<>\\s]*${target.key}--[^\"'<>\\s]*)`,
            'i'
          ));
          if (pathMatch) {
            try { return new URL(pathMatch[1], location.href).href; } catch {}
          }

          // Some Kinopoisk dropdown options expose only their actual value in
          // DOM data attributes. The value itself still comes from Kinopoisk;
          // we only place it into the filter path format used by this page.
          const rawValue = node.getAttribute?.('data-value') ||
            node.getAttribute?.('data-id') ||
            node.getAttribute?.('value');
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

        const waitForOptions = async target => {
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const nodes = [...document.querySelectorAll(
              'a[href], [data-href], [data-url], [data-link], [data-value], [data-id], [role="option"], [role="menuitem"], li, button'
            )].filter(visible);
            const found = nodes.filter(node => optionUrlFromNode(node, target));
            if (found.length > 1) return found;
            await delay(100);
          }
          return [];
        };

        const groups = {};

        for (const target of targets) {
          const trigger = clickableFor(target);
          if (!trigger) continue;

          try {
            trigger.click();
            await delay(180);
            const nodes = await waitForOptions(target);
            const options = new Map();

            nodes.forEach(node => {
              const label = clean(
                node.getAttribute?.('aria-label') ||
                node.getAttribute?.('title') ||
                node.textContent
              );
              if (!label || label.length > 70 || label === target.resetLabel) return;

              const url = optionUrlFromNode(node, target);
              if (!url) return;
              options.set(label, { label, url });
            });

            if (options.size) {
              groups[target.key] = {
                key: `path:${target.key}`,
                title: target.title,
                resetLabel: target.resetLabel,
                resetUrl: resetUrlFor(target.key),
                options: [...options.values()]
              };
            }
          } finally {
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape',
              code: 'Escape',
              keyCode: 27,
              which: 27,
              bubbles: true
            }));
            await delay(80);
          }
        }

        return { groups };
      }
    });

    const catalog = results?.[0]?.result;
    if (!catalog?.groups || !Object.keys(catalog.groups).length) {
      throw new Error('Кинопоиск не отдал варианты выпадающих фильтров');
    }

    return {
      fetchedAt: Date.now(),
      groups: catalog.groups
    };
  }

  async function waitForTabComplete(tabId, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete' && /\/lists\/movies\//.test(tab.url || '')) {
        await new Promise(resolve => setTimeout(resolve, 700));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Служебная страница Кинопоиска не успела загрузиться');
  }

  async function extractFilterCatalogFromExistingTab() {
    const tabs = await chrome.tabs.query({
      url: ['https://www.kinopoisk.ru/lists/movies/*', 'https://kinopoisk.ru/lists/movies/*']
    });

    const candidates = tabs.filter(tab => Number.isInteger(tab.id) && !tab.discarded);
    let lastError = null;

    for (const tab of candidates) {
      try {
        return await extractFilterCatalogFromTab(tab.id);
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      candidates.length
        ? `Открытая страница Кинопоиска не подошла: ${lastError?.message || 'ошибка'}`
        : 'Открытой страницы списков Кинопоиска нет'
    );
  }

  async function extractFilterCatalogAutomatically() {
    // If the user already has a suitable Kinopoisk list open, reuse it without
    // changing that tab. Otherwise create a separate minimized, unfocused
    // service window and remove it immediately after the catalog is captured.
    try {
      return await extractFilterCatalogFromExistingTab();
    } catch {
      // Continue with the isolated service window.
    }

    let serviceWindowId = null;
    try {
      const serviceWindow = await chrome.windows.create({
        url: TYPES.all.baseUrl,
        type: 'popup',
        focused: false,
        state: 'minimized',
        width: 520,
        height: 720
      });

      serviceWindowId = serviceWindow.id;
      const serviceTab = serviceWindow.tabs?.[0];
      if (!serviceTab?.id) {
        throw new Error('Не удалось создать служебную вкладку Кинопоиска');
      }

      await waitForTabComplete(serviceTab.id);
      return await extractFilterCatalogFromTab(serviceTab.id);
    } finally {
      if (Number.isInteger(serviceWindowId)) {
        try {
          await chrome.windows.remove(serviceWindowId);
        } catch {}
      }
    }
  }

  async function getFilterCatalog() {
    const stored = await readStoredFilterCatalog();
    if (filterCatalogFresh(stored)) return stored;

    try {
      const freshCatalog = await extractFilterCatalogAutomatically();
      await saveFilterCatalog(freshCatalog);
      return freshCatalog;
    } catch (error) {
      console.warn('[KinoHelper filters] Не удалось обновить каталог dropdown:', error);
      return stored;
    }
  }

'''

text = text[:start] + replacement + text[end:]
path.write_text(text, encoding='utf-8')
