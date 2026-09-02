from pathlib import Path

p = Path('filters.js')
s = p.read_text(encoding='utf-8')

# Make URL equality insensitive to query-param order, including repeated b= values.
old = '''  function urlsEqual(left, right) {\n    try {\n      const a = new URL(left);\n      const b = new URL(right);\n      a.hash = '';\n      b.hash = '';\n      a.searchParams.delete('page');\n      b.searchParams.delete('page');\n      return a.href === b.href;\n    } catch {\n      return left === right;\n    }\n  }\n'''
new = '''  function comparableUrl(rawUrl) {\n    const url = new URL(rawUrl);\n    url.hash = '';\n    url.searchParams.delete('page');\n    url.searchParams.delete('ysclid');\n\n    const entries = [...url.searchParams.entries()]\n      .filter(([key]) => !/^utm_/i.test(key))\n      .sort(([keyA, valueA], [keyB, valueB]) =>\n        keyA.localeCompare(keyB) || valueA.localeCompare(valueB)\n      );\n\n    url.search = '';\n    entries.forEach(([key, value]) => url.searchParams.append(key, value));\n    return url.href;\n  }\n\n  function urlsEqual(left, right) {\n    try {\n      return comparableUrl(left) === comparableUrl(right);\n    } catch {\n      return left === right;\n    }\n  }\n\n  function queryValues(rawUrl, key) {\n    try {\n      return new URL(rawUrl).searchParams.getAll(key).slice().sort();\n    } catch {\n      return [];\n    }\n  }\n\n  function multisetContains(container, subset) {\n    const remaining = [...container];\n    for (const value of subset) {\n      const index = remaining.indexOf(value);\n      if (index < 0) return false;\n      remaining.splice(index, 1);\n    }\n    return true;\n  }\n\n  // Kinopoisk's active quick-filter chip normally links to the URL that\n  // DISABLES that filter. Therefore an active chip has fewer b= values in its\n  // target than in the current source URL.\n  function isActiveQueryToggle(sourceUrl, targetUrl, key) {\n    const sourceValues = queryValues(sourceUrl, key);\n    const targetValues = queryValues(targetUrl, key);\n    return sourceValues.length > targetValues.length &&\n      multisetContains(sourceValues, targetValues);\n  }\n'''
assert old in s, 'urlsEqual block not found'
s = s.replace(old, new, 1)

# Mark query:b quick filters semantically selected.
old = '''      if (changes.length === 1 && changes[0] === 'query:b') {\n        actions.push(candidate);\n        return;\n      }\n'''
new = '''      if (changes.length === 1 && changes[0] === 'query:b') {\n        candidate.selected = Boolean(\n          candidate.selected ||\n          isActiveQueryToggle(normalizedSourceUrl, candidate.url, 'b')\n        );\n        actions.push(candidate);\n        return;\n      }\n'''
assert old in s, 'query:b action block not found'
s = s.replace(old, new, 1)

# Requested Kinopoisk filter URL is authoritative. It comes from Kinopoisk's own
# sidebar and must not be discarded if response.url is canonicalized/reordered.
old = '''    return buildModel(doc, page.url || sourceUrl, contentType);\n'''
new = '''    return buildModel(doc, normalizeStateUrl(sourceUrl, contentType), contentType);\n'''
assert old in s, 'fetchModel return not found'
s = s.replace(old, new, 1)

# Keep the exact requested normalized state after successful apply.
old = '''      try {\n        const model = await fetchModel(targetUrl, type);\n        activeTypeState().sourceUrl = model.sourceUrl;\n\n        if (meta.groupKey && meta.label) {\n'''
new = '''      try {\n        const requestedUrl = normalizeStateUrl(targetUrl, type);\n        const model = await fetchModel(requestedUrl, type);\n        model.sourceUrl = requestedUrl;\n        activeTypeState().sourceUrl = requestedUrl;\n\n        if (meta.groupKey && meta.label) {\n'''
assert old in s, 'applyUrl block not found'
s = s.replace(old, new, 1)

# Ensure buildUrl always exposes normalized active filter state to Random.
old = '''    function buildUrl() {\n      const active = activeTypeState();\n      return {\n        url: active.sourceUrl,\n        contentType: TYPES[state.contentType].randomType\n      };\n    }\n'''
new = '''    function buildUrl() {\n      const active = activeTypeState();\n      const url = normalizeStateUrl(active.sourceUrl, state.contentType);\n      return {\n        url,\n        contentType: TYPES[state.contentType].randomType\n      };\n    }\n'''
assert old in s, 'buildUrl block not found'
s = s.replace(old, new, 1)

assert 'isActiveQueryToggle' in s
assert 'model.sourceUrl = requestedUrl' in s
assert 'return comparableUrl(left) === comparableUrl(right)' in s
p.write_text(s, encoding='utf-8')
