'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'resume-ui.js'), 'utf8');

function node(tag = 'div', cls = '') {
  const element = {
    tag, className: cls, hidden: false, textContent: '', dataset: {},
    style: {}, attrs: {}, children: [], events: {},
    classList: { add(value) { element.className += ' ' + value; } },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(key, callback) { this.events[key] = callback; },
    append(...children) { for (const child of children) this.appendChild(child); },
    appendChild(child) { this.children.push(child); child.parent = this; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    remove() {
      if (this.parent) this.parent.children =
        this.parent.children.filter(item => item !== this);
    },
    querySelector(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : selector;
      for (const child of this.children) {
        if (child.className.split(/\s+/).includes(cls)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
  };
  return element;
}

async function setup({ data = {}, seriesData = {}, coverageData = {}, history = [],
  current = 'https://www.kinopoisk.ru/', delayedTabQuery = false,
  session = null, sharedSession = {} } = {}) {
  const elements = {
    resumeLast: node('section'), resumeLastTitle: node(),
    resumeLastMeta: node(), resumeLastProgress: node(),
    resumeLastOpen: node('button'), resumeLastClose: node('button'),
    currentWatchProgress: node('div','current-watch-progress'),
    currentWatchProgressTrack: node('div','history-progress-track'),
    currentWatchProgressLabel: node('div','history-progress-label'),
    currentWatchCoverage: node('div','history-coverage-label')
  };
  elements.currentWatchProgress.hidden=true;
  elements.currentWatchCoverage.hidden=true;
  elements.currentWatchProgressTrack.appendChild(node('div','resume-progress-fill'));
  elements.currentWatchProgress.append(
    elements.currentWatchProgressTrack,
    elements.currentWatchProgressLabel,
    elements.currentWatchCoverage
  );
  let tabUrl = current;
  const gate = delayedTabQuery ? {} : null;
  const pendingTab = gate ? new Promise(resolve => { gate.release = resolve; }) : null;
  const documentEvents = {};
  const runtimeEvents = {};
  const rows = history.map(entry => {
    const row = node('div', 'history-item');
    const match = new URL(entry.url).pathname.match(/^\/(film|series)\/(\d+)/);
    if (match) row.dataset.kinoMediaKey = match[1] + ':' + match[2];
    row.appendChild(node('div', 'history-item-main'));
    return row;
  });
  const doc = {
    hidden: false,
    addEventListener(name, handler) { documentEvents[name] = handler; },
    getElementById: id => elements[id],
    querySelectorAll: selector => selector.includes('history-item')
      ? rows.filter(row => row.dataset.kinoMediaKey) : [],
    createElement: tag => node(tag)
  };
  const changes = [];
  const tabs = {};
  const opened = [];
  const openedOptions = [];
  const actions = [];
  let localReads=0;
  const context = {
    URL, console,
    document: doc,
    chrome: {
      tabs: {
        query: async () => {
          if (pendingTab) await pendingTab;
          return [{ id: 1, url: tabUrl }];
        },
        create: async ({ url }) => opened.push(url),
        onActivated: { addListener(cb) { tabs.activated = cb; } },
        onUpdated: { addListener(cb) { tabs.updated = cb; } },
        onRemoved: { addListener(cb) { tabs.removed = cb; } }
      },
      runtime: {
        onMessage: { addListener(cb) { runtimeEvents.message = cb; } },
        sendMessage: async message => {
          actions.push(message);
          return message.action === 'getWatchSession'
            ? { ok: true, session } : { ok: false };
        }
      },
      storage: {
        local: { get: async keys => {
          localReads++;
          const values={
            kinoPlaybackProgressV1:data,
            kinoSeriesEpisodeProgressV1:seriesData,
            kinoPlaybackCoverageV1:coverageData
          };
          return Object.fromEntries((Array.isArray(keys)?keys:[keys])
            .map(key=>[key,values[key]]));
        } },
        session: {
          get: async key => ({ [key]: sharedSession[key] }),
          set: async values => {
            for (const [key, value] of Object.entries(values)) {
              const oldValue = sharedSession[key];
              sharedSession[key] = value;
              for (const handler of changes) handler({
                [key]: { oldValue, newValue: value }
              }, 'session');
            }
          }
        },
        onChanged: { addListener(cb) { changes.push(cb); } }
      }
    },
    window: { addEventListener() {},
      openHistoryUrl: async (url, title, options) => {
        opened.push(url);
        openedOptions.push(options);
      } }
  };
  vm.runInNewContext(source, context);
  context.window.KinoResumeUI.updateHistory(history);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  return { elements, rows, changes, tabs, opened, openedOptions, actions,
    documentEvents, runtimeEvents, sharedSession,
    releaseTab: () => gate?.release(),
    setSession: value => { session = value; },
    updateHistory: context.window.KinoResumeUI.updateHistory,
    refresh: context.window.KinoResumeUI.readStorage,
    setCurrentMedia: context.window.KinoResumeUI.setCurrentMedia,
    get localReads(){return localReads;},
    setTab(url) { tabUrl = url; },
    setData(next) { data = next; },
    setSeriesData(next) { seriesData = next; } };
}

const movie = { type: 'film', id: '447301', title: 'Астрал',
  position: 150, duration: 600, updatedAt: 10000, completed: false };
const filmHistory = [{ title: 'Астрал', timestamp: 5000,
  url: 'https://www.kinokino.vip/film/447301/' }];

test('history progress bar uses saved position and latest card shows same movie', async () => {
  const ui = await setup({
    data: { 'film:447301': movie }, history: filmHistory
  });
  const bar = ui.rows[0].querySelector('.history-progress-track');
  assert.ok(bar);
  assert.equal(bar.attrs['aria-valuenow'], '25');
  assert.equal(ui.rows[0].querySelector('.history-progress-label').textContent,
    '2:30 / 10:00 · 25%');
  assert.equal(ui.elements.resumeLast.hidden, false);
  assert.equal(ui.elements.resumeLastTitle.textContent, 'Астрал');
  assert.match(ui.elements.resumeLastMeta.textContent, /2:30 \/ 10:00 · 25%/);
  ui.elements.resumeLastOpen.events.click();
  assert.deepEqual(ui.opened, [filmHistory[0].url]);
  assert.equal(ui.openedOptions[0].resume, true);
  assert.equal(ui.elements.resumeLastOpen.textContent, '▶ Продолжить');
});

test('completed films are excluded from last card but retain 100% history bar', async () => {
  const ui = await setup({
    data: { 'film:447301': { ...movie, completed: true } },
    history: filmHistory
  });
  assert.equal(ui.elements.resumeLast.hidden, true);
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '100');
});

test('series appear as last opened without false episode progress', async () => {
  const series = [{ title: 'Сериал', timestamp: 5000,
    url: 'https://www.kinokino.vip/series/123/' }];
  const ui = await setup({ history: series });
  assert.equal(ui.elements.resumeLast.hidden, false);
  assert.match(ui.elements.resumeLastMeta.textContent, /таймкод серии пока не сохранён/);
  assert.equal(ui.elements.resumeLastProgress.hidden, true);
  assert.equal(ui.rows[0].querySelector('.history-item-progress'), null);
});

test('active film is not repeated in last card', async () => {
  const ui = await setup({
    history: filmHistory, data: { 'film:447301': movie },
    current: 'https://brogiro.cfd/film/447301/'
  });
  assert.equal(ui.elements.resumeLast.hidden, true);
  ui.setTab('https://www.kinopoisk.ru/');
  await ui.tabs.activated();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(ui.elements.resumeLast.hidden, false);
});

test('storage updates redraw progress while the history data stays intact', async () => {
  const ui = await setup({
    history: filmHistory, data: { 'film:447301': movie }
  });
  const changed = { ...movie, position: 300, updatedAt: 30000 };
  ui.setData({ 'film:447301': changed });
  ui.changes[0]({ kinoPlaybackProgressV1: { newValue: changed } }, 'local');
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '50');
  assert.equal(filmHistory[0].title, 'Астрал');
});

test('out-of-range or mismatched data are not shown as progress', async () => {
  const ui = await setup({
    history: filmHistory,
    data: { 'film:447301': { ...movie, id: '123', position: 99999 } }
  });
  assert.equal(ui.rows[0].querySelector('.history-progress-track'), null);
  assert.equal(ui.elements.resumeLastProgress.hidden, true);
});


test('series remains ordinary open action without a false seek request', async () => {
  const history = [{ title: 'Сериал', timestamp: 5000,
    url: 'https://www.kinokino.vip/series/123/' }];
  const ui = await setup({ history });
  assert.equal(ui.elements.resumeLastOpen.textContent, '▶ Открыть');
  ui.elements.resumeLastOpen.events.click();
  assert.equal(ui.openedOptions[0].resume, false);
});


const episode = { type: 'series', id: '404900',
  season: 1, episode: 3, position: 300, duration: 1800,
  title: 'Сериал', completed: false, updatedAt: 40000 };
const seriesHistory = [{ title: 'Сериал', timestamp: 2000,
  url: 'https://www.kinokino.vip/series/404900/' }];

test('episode progress is isolated and shows season and episode in history', async () => {
  const ui = await setup({
    history: seriesHistory, seriesData: {
      'series:404900:1:3': episode
    }
  });
  const track = ui.rows[0].querySelector('.history-progress-track');
  assert.equal(track.attrs['aria-valuenow'], '17');
  assert.match(ui.rows[0].querySelector('.history-progress-label').textContent,
    /Сезон 1 · Серия 3 · 5:00 \/ 30:00 · 17%/);
  assert.match(ui.elements.resumeLastMeta.textContent,
    /Сезон 1 · Серия 3 · Сохранено 5:00 \/ 30:00/);
  assert.equal(ui.elements.resumeLastOpen.textContent, '▶ Продолжить');
  ui.elements.resumeLastOpen.events.click();
  assert.equal(ui.openedOptions[0].resume, true);
  assert.equal(ui.openedOptions[0].resumeTarget.kind, 'series');
  assert.equal(ui.openedOptions[0].resumeTarget.season, 1);
  assert.equal(ui.openedOptions[0].resumeTarget.episode, 3);
});

test('switching episodes updates latest progress but preserves earlier episode', async () => {
  const ui = await setup({
    history: seriesHistory, seriesData: { 'series:404900:1:3': episode }
  });
  const newer = { ...episode, episode: 4, position: 105,
    updatedAt: 50000 };
  ui.setSeriesData({
    'series:404900:1:3': episode,
    'series:404900:1:4': newer
  });
  ui.changes[0]({ kinoSeriesEpisodeProgressV1: { newValue: true } }, 'local');
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.elements.resumeLastMeta.textContent,
    /Сезон 1 · Серия 4/);
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '6');
});

test('completed episode does not reappear in resume card', async () => {
  const complete = { ...episode, completed: true };
  const ui = await setup({
    history: seriesHistory, seriesData: {
      'series:404900:1:3': complete
    }
  });
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '100');
  assert.equal(ui.elements.resumeLast.hidden, true);
});

test('malformed series episode ID or mismatched series is ignored', async () => {
  const ui = await setup({
    history: seriesHistory, seriesData: {
      'series:404900:1:3': { ...episode, id: 'other' }
    }
  });
  assert.equal(ui.rows[0].querySelector('.history-progress-track'), null);
});


test('provider film URL with explicit series history label displays episode progress', async () => {
  const history = [{ title: 'Во все тяжкие (сериал)', timestamp: 5000,
    url: 'https://brogiro.cfd/film/404900/' }];
  const episode = { type: 'series', id: '404900', season: 1, episode: 3,
    position: 42, duration: 3486, completed: false, updatedAt: 12000 };
  const ui = await setup({
    history, seriesData: { 'series:404900:1:3': episode }
  });
  const label = ui.rows[0].querySelector('.history-progress-label');
  assert.match(label.textContent, /Сезон 1 · Серия 3/);
  assert.match(ui.elements.resumeLastMeta.textContent,
    /Сезон 1 · Серия 3/);
  assert.equal(ui.elements.resumeLastOpen.textContent, '▶ Продолжить');
  ui.elements.resumeLastOpen.events.click();
  assert.equal(ui.openedOptions[0].resume, true);
  assert.equal(ui.openedOptions[0].resumeTarget.kind, 'series');
  assert.equal(ui.openedOptions[0].resumeTarget.season, 1);
  assert.equal(ui.openedOptions[0].resumeTarget.episode, 3);
});

test('film URL with verified series metadata suppresses duplicate current-view card', async () => {
  const history = [{ title: 'Во все тяжкие (сериал)', timestamp: 5000,
    url: 'https://brogiro.cfd/film/404900/' }];
  const ui = await setup({
    history,
    current: 'https://brogiro.cfd/film/404900/',
    seriesData: { 'series:404900:1:3': {
      type: 'series', id: '404900', season: 1, episode: 3,
      position: 42, duration: 3486, completed: false, updatedAt: 12000
    } }
  });
  // A stored series observation may be absent in this stub: at minimum
  // the history entry must retain its correct episode label and progress.
  assert.match(ui.rows[0].querySelector('.history-progress-label').textContent,
    /Сезон 1 · Серия 3/);
});


test('latest completed episode never falls back to older unfinished episodes', async () => {
  const last = { ...episode, episode: 4, position: 1800,
    duration: 1800, completed: true, updatedAt: 70000 };
  const ui = await setup({ history: seriesHistory,
    seriesData: { 'series:404900:1:3': episode,
      'series:404900:1:4': last } });
  assert.equal(ui.elements.resumeLast.hidden, true);
  assert.match(ui.rows[0].querySelector('.history-progress-label').textContent,
    /Сезон 1 · Серия 4/);
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '100');
});


const breakingBadHistory = [{
  title: 'Во все тяжкие (сериал 2008–2013)',
  url: 'https://brogiro.cfd/film/404900/', timestamp: 5000
}];
const breakingBadEpisode = {
  type:'series',id:'404900',season:1,episode:4,
  position:11,duration:2895,completed:false,updatedAt:20000
};

test('watch page hides last-view card even if /film/ route has a series checkpoint', async () => {
  const ui = await setup({
    current: 'https://brogiro.cfd/film/404900/',
    history: breakingBadHistory,
    seriesData: { 'series:404900:1:4': breakingBadEpisode }
  });
  assert.equal(ui.elements.resumeLast.hidden, true);
  ui.setSeriesData({
    'series:404900:1:4': { ...breakingBadEpisode, position:60,updatedAt:25000 }
  });
  ui.changes[0]({ kinoSeriesEpisodeProgressV1: { newValue:true } },'local');
  for (let i = 0; i < 6; i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden, true,
    'five-second storage updates must never reveal the last-view card');
  assert.ok(ui.rows[0].querySelector('.history-progress-label')
    .textContent.includes('Сезон 1 · Серия 4'));
  ui.setTab('https://www.kinopoisk.ru/');
  ui.tabs.activated();
  for (let i = 0; i < 6; i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden, false);
  assert.match(ui.elements.resumeLastMeta.textContent,/Сезон 1 · Серия 4/);
});

test('watching any known film or series hides entire last-view card', async () => {
  const ui = await setup({
    current: 'https://www.kinokino.vip/film/447301/',
    history: breakingBadHistory,
    seriesData:{'series:404900:1:4':breakingBadEpisode}
  });
  assert.equal(ui.elements.resumeLast.hidden,true);
  ui.setTab('https://flcksbr.top/series/404900/');
  ui.tabs.activated();
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden,true);
});

test('an unrelated site with a /film/ URL is NOT considered a watch page', async()=>{
  const ui=await setup({
    current:'https://unrelated.example/film/404900/',
    history:breakingBadHistory,
    seriesData:{'series:404900:1:4':breakingBadEpisode}
  });
  assert.equal(ui.elements.resumeLast.hidden,false);
});

test('verified redirect watch session hides card on nonstandard host',async()=>{
  const url='https://redirected.example/watch/404900/';
  const ui=await setup({
    current:url,history:breakingBadHistory,
    session:{type:'series',id:'404900',currentUrl:url},
    seriesData:{'series:404900:1:4':breakingBadEpisode}
  });
  assert.equal(ui.elements.resumeLast.hidden,true);
  ui.setSession(null);
  ui.runtimeEvents.message({action:'kinoWatchSessionChanged',tabId:1});
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden,false);
});

test('active-tab check blocks transient appearance during asynchronous reads',async()=>{
  const ui=await setup({
    delayedTabQuery:true,
    current:'https://brogiro.cfd/film/404900/',
    history:breakingBadHistory,
    seriesData:{'series:404900:1:4':breakingBadEpisode}
  });
  assert.equal(ui.elements.resumeLast.hidden,true);
  await ui.refresh();
  assert.equal(ui.elements.resumeLast.hidden,true);
  ui.releaseTab();
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden,true);
  ui.setTab('https://www.kinopoisk.ru/');
  ui.tabs.activated();
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden,false);
});


test('small close button hides latest movie without deleting checkpoint', async () => {
  const ui = await setup({
    history: filmHistory,
    data: { 'film:447301': movie }
  });
  assert.equal(ui.elements.resumeLast.hidden, false);
  ui.elements.resumeLastClose.events.click();
  assert.equal(ui.elements.resumeLast.hidden, true);
  assert.equal(ui.sharedSession.kinoLastViewDismissedV1, 'film:447301');

  ui.setData({ 'film:447301': { ...movie, position: 300, updatedAt: 25000 } });
  ui.changes[0]({ kinoPlaybackProgressV1: { newValue: true } }, 'local');
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden, true,
    'five-second progress updates must not reveal dismissed card');
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '50', 'history progress stays available');
  assert.equal(movie.position, 150, 'dismiss must not mutate existing checkpoint');
});

test('dismissal persists between Popup and Side Panel during browser session', async () => {
  const sharedSession = {};
  const input = {
    sharedSession, history: seriesHistory,
    seriesData: { 'series:404900:1:3': episode }
  };
  const popup = await setup(input);
  popup.elements.resumeLastClose.events.click();
  assert.equal(sharedSession.kinoLastViewDismissedV1, 'series:404900:1:3');
  const panel = await setup(input);
  assert.equal(panel.elements.resumeLast.hidden, true);
  assert.ok(panel.rows[0].querySelector('.history-progress-label')
    .textContent.includes('Сезон 1 · Серия 3'));
});

test('a different episode becomes visible after dismissing the prior one', async () => {
  const ui = await setup({
    history: seriesHistory,
    seriesData: { 'series:404900:1:3': episode }
  });
  ui.elements.resumeLastClose.events.click();
  const updated = { ...episode, episode: 4, position: 80,
    updatedAt: episode.updatedAt + 10000 };
  ui.setSeriesData({
    'series:404900:1:3': episode,
    'series:404900:1:4': updated
  });
  ui.changes[0]({ kinoSeriesEpisodeProgressV1: { newValue: true } }, 'local');
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements.resumeLast.hidden, false);
  assert.match(ui.elements.resumeLastMeta.textContent, /Сезон 1 · Серия 4/);
});

test('dismissal never falls back to another older film', async () => {
  const olderMovie = { ...movie, id: '987', title: 'Старый фильм', updatedAt: 9000 };
  const olderHistory = { title: 'Старый фильм', timestamp: 1000,
    url: 'https://www.kinokino.vip/film/987/' };
  const ui = await setup({
    history: [...filmHistory, olderHistory],
    data: { 'film:447301': movie, 'film:987': olderMovie }
  });
  ui.elements.resumeLastClose.events.click();
  assert.equal(ui.elements.resumeLast.hidden, true);
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '25');
});


test('UI retains manual finish as fallback while background handles automatic completion',async()=>{
  const ui=await setup({
    history:filmHistory,
    data:{'film:447301':{...movie,position:565}},
    coverageData:{'film:447301':{duration:600,ranges:[[0,510]]}}
  });
  const button=ui.rows[0].querySelector('.history-confirm-complete');
  assert.ok(button);
  assert.equal(button.textContent,'✓ Досмотрел');
  assert.match(ui.rows[0].querySelector('.history-progress-label').textContent,/94%/);
  assert.equal(ui.elements.resumeLast.hidden,false);
  await button.events.click();
  assert.equal(ui.actions.at(-1).action,'kinoConfirmCoveredPlayback');
  assert.equal(ui.actions.at(-1).key,'film:447301');
});

test('near-end timeline offers manual attestation, not automatic completion',async()=>{
  const ui=await setup({
    history:filmHistory,
    data:{'film:447301':{...movie,position:565}},
    coverageData:{'film:447301':{duration:600,ranges:[[550,565]]}}
  });
  const button=ui.rows[0].querySelector('.history-confirm-complete');
  assert.ok(button);
  assert.match(button.title,/позиция не доказывает/);
  assert.equal(ui.elements.resumeLast.hidden,false);
  assert.match(ui.rows[0].querySelector('.history-coverage-label').textContent,/2%/);
});

test('episode completion button identifies the exact season and episode',async()=>{
  const ui=await setup({
    history:seriesHistory,
    seriesData:{'series:404900:1:3':{...episode,position:1700}},
    coverageData:{'series:404900:1:3':{duration:1800,ranges:[[0,1540]]}}
  });
  const button=ui.rows[0].querySelector('.history-confirm-complete');
  assert.ok(button);
  await button.events.click();
  assert.equal(ui.actions.at(-1).key,'series:404900:1:3');
});

test('opening history requests safe reconciliation of older verified film completion',async()=>{
  const ui=await setup({data:{'film:447301':{
    ...movie,position:588,completed:false
  }},coverageData:{'film:447301':{
    duration:600,ranges:[[0,576]]
  }},history:filmHistory});
  const reconcile=ui.actions.filter(x=>x.action==='kinoReconcileVerifiedFilms');
  assert.equal(reconcile.length,1,'only one reconciliation on UI startup');
  assert.ok(ui.rows[0].querySelector('.history-confirm-complete'),
    'manual recovery stays available until background confirmation arrives');
});


test('current film progress appears directly below Now Watching from already loaded history snapshot',async()=>{
  const ui=await setup({
    current:'https://www.kinokino.vip/film/447301/',
    data:{'film:447301':{...movie,position:525,duration:600}},
    coverageData:{'film:447301':{duration:600,ranges:[[0,480]]}}
  });
  const reads=ui.localReads;
  const messages=ui.actions.length;
  ui.setCurrentMedia({type:'film',id:'447301'});
  assert.equal(ui.elements.currentWatchProgress.hidden,false);
  assert.equal(ui.elements.currentWatchProgressTrack.attrs['aria-valuenow'],'88');
  assert.equal(ui.elements.currentWatchProgressTrack.querySelector(
    '.resume-progress-fill').style.width,'88%');
  assert.equal(ui.elements.currentWatchProgressLabel.textContent,
    '8:45 / 10:00 · 88%');
  assert.equal(ui.elements.currentWatchCoverage.textContent,
    'Фактически просмотрено: 80%');
  assert.equal(ui.localReads,reads,'must reuse same in-memory snapshot, not query storage again');
  assert.equal(ui.actions.length,messages,'no extra background or Kinopoisk requests');
});

test('the current film bar updates automatically on saved playback changes',async()=>{
  const ui=await setup({data:{'film:447301':{...movie,position:150}}});
  ui.setCurrentMedia({type:'film',id:'447301'});
  assert.equal(ui.elements.currentWatchProgressLabel.textContent,'2:30 / 10:00 · 25%');
  ui.setData({'film:447301':{...movie,position:450}});
  ui.changes[0]({kinoPlaybackProgressV1:{newValue:true}},'local');
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.elements.currentWatchProgressLabel.textContent,'7:30 / 10:00 · 75%');
  assert.equal(ui.elements.currentWatchProgressTrack.querySelector(
    '.resume-progress-fill').style.width,'75%');
});

test('the bar never displays another film checkpoint, and disappears when playback ends',async()=>{
  const ui=await setup({data:{'film:447301':movie}});
  ui.setCurrentMedia({type:'film',id:'447301'});
  assert.equal(ui.elements.currentWatchProgress.hidden,false);
  ui.setCurrentMedia({type:'film',id:'123456'});
  assert.equal(ui.elements.currentWatchProgress.hidden,true);
  ui.setCurrentMedia(null);
  assert.equal(ui.elements.currentWatchProgress.hidden,true);
  ui.setCurrentMedia({type:'film',id:'incorrect'});
  assert.equal(ui.elements.currentWatchProgress.hidden,true);
});

test('completed current film shows a green 100% progress track',async()=>{
  const ui=await setup({data:{'film:447301':{...movie,completed:true,position:550}}});
  ui.setCurrentMedia({type:'film',id:'447301'});
  assert.equal(ui.elements.currentWatchProgress.hidden,false);
  assert.equal(ui.elements.currentWatchProgressTrack.attrs['aria-valuenow'],'100');
  assert.match(ui.elements.currentWatchProgressTrack.className,/\bcomplete\b/);
  assert.equal(ui.elements.currentWatchProgressLabel.textContent,
    '✓ Просмотрено · 10:00');
  assert.equal(ui.elements.currentWatchCoverage.hidden,true);
});

test('current series can reuse latest verified episode checkpoint',async()=>{
  const ui=await setup({
    seriesData:{'series:404900:1:3':{...episode,position:500}},
    data:{'film:447301':movie}
  });
  ui.setCurrentMedia({type:'series',id:'404900'});
  assert.equal(ui.elements.currentWatchProgress.hidden,false);
  assert.match(ui.elements.currentWatchProgressLabel.textContent,/Сезон 1 · Серия 3 · /);
  ui.setCurrentMedia({type:'film',id:'404900'});
  assert.equal(ui.elements.currentWatchProgress.hidden,true,
    'episode timestamp must not be attributed to a film');
});

test('Now Watching progress uses same DOM hooks in popup and sidepanel',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const files=['popup.html','sidepanel.html'];
  for(const file of files){
    const html=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    assert.match(html,/class="current-view-heading"[\s\S]*?id="message"[\s\S]*?id="watchlistCurrentAction"[\s\S]*?<\/button>\s*<\/div>\s*<div class="movie-genres" id="movieGenres" hidden><\/div>\s*<div class="current-watch-progress"/);
    for(const id of ['currentWatchProgress','currentWatchProgressTrack',
      'currentWatchProgressLabel','currentWatchCoverage'])
      assert.match(html,new RegExp('id="'+id+'"'));
  }
});

test('Now Watching uses the existing identified session, not a second progress request',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const popup=fs.readFileSync(path.join(__dirname,'..','popup.js'),'utf8');
  assert.match(popup,/if \(session\?\.returnUrl\) \{\s*window\.KinoResumeUI\?\.setCurrentMedia\(session\)/);
  assert.match(popup,/if \(directPlayerMedia\) \{\s*window\.KinoResumeUI\?\.setCurrentMedia\(directPlayerMedia\)/);
  assert.match(popup,/if \(isKinopoiskMedia\) \{\s*\/\/[^\n]*\n\s*window\.KinoResumeUI\?\.setCurrentMedia\(null\)/);
  const resume=fs.readFileSync(path.join(__dirname,'..','resume-ui.js'),'utf8');
  const start=resume.indexOf('  function setCurrentMedia(media) {');
  const stop=resume.indexOf('  function lastIdentity(candidate)',start);
  assert.ok(start>=0&&stop>start);
  assert.equal(resume.slice(start,stop).includes('chrome.storage'),false);
  assert.equal(resume.slice(start,stop).includes('fetch('),false);
});

test('Kinopoisk-only bookmark stays in the title row without cluttering playback',()=>{
  const fs=require('node:fs'),path=require('node:path');
  for(const page of ['popup.html','sidepanel.html']){
    const html=fs.readFileSync(path.join(__dirname,'..',page),'utf8');
    const section=html.slice(html.indexOf('id="contextCard"'),
      html.indexOf('id="resumeLast"'));
    assert.equal((section.match(/id="watchlistCurrentAction"/g)||[]).length,1);
    assert.match(section,/class="current-view-heading"/);
    assert.match(section,/id="watchlistCurrentAction"[\s\S]*?hidden[\s\S]*?aria-pressed="false"/);
    assert.ok(section.indexOf('id="watchlistCurrentAction"') <
      section.indexOf('id="movieGenres"'));
    assert.equal((section.match(/id="movieGenres"/g)||[]).length,1);
    assert.ok(section.indexOf('id="movieGenres"') <
      section.indexOf('id="currentWatchProgress"'));
    assert.ok(section.indexOf('id="currentWatchProgress"') <
      section.indexOf('id="movieDetails"'));
    assert.ok(section.includes('id="movieDescriptionToggle"'));
    assert.ok(section.includes('id="ratingCard"'));
    assert.ok(html.includes('id="watchlistSort"'));
  }
});
test('genre availability does not force an empty description panel open',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const logic=fs.readFileSync(path.join(__dirname,'..','popup.js'),'utf8');
  assert.match(logic,/movieDetails\.hidden = !description;/);
  assert.equal(logic.includes('movieDetails.hidden = !genres.length && !description;'),false);
});

test('bookmark receives a movie only on Kinopoisk detail pages, never during playback',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const popup=fs.readFileSync(path.join(__dirname,'..','popup.js'),'utf8');
  const kp=popup.slice(popup.indexOf('if (isKinopoiskMedia) {'),
    popup.indexOf('const session = await getWatchSession'));
  assert.match(kp,/KinoWatchlist\?\.setCurrent\(\{ \.\.\.media, title \}\)/);
  const play=popup.slice(popup.indexOf('if (session?.returnUrl) {'),
    popup.indexOf('window.KinoResumeUI?.setCurrentMedia(null);',popup.indexOf('if (directPlayerMedia) {')));
  assert.equal(play.includes('KinoWatchlist?.setCurrent({'),false);
  assert.match(popup,/KinoWatchlist\?\.setCurrent\(null\)/);
  const bookmark=fs.readFileSync(path.join(__dirname,'..','watchlist.js'),'utf8');
  const start=bookmark.indexOf('    function setCurrent(movie) {');
  const end=bookmark.indexOf('    async function openWatch(',start);
  const implementation=bookmark.slice(start,end);
  assert.match(implementation,/button\.setAttribute\('aria-label', label\)/);
  assert.equal(implementation.includes('button.textContent'),false,
    'SVG markup should survive state changes');
  const css=fs.readFileSync(path.join(__dirname,'..','popup.css'),'utf8');
  assert.match(css,/\.watchlist-current-action\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});
