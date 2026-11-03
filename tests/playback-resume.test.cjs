'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'playback-resume.js'), 'utf8');

async function simulate({ duration = 600, targetDuration = 600,
  position = 187, allow = true, videoReady = true } = {}) {
  const pending = allow ? { position, duration: targetDuration } : null;
  const requests = [];
  const timers = new Map();
  let serial = 0;
  let clock = 100000;
  let mediaTime = 0;
  const video = {
    readyState: videoReady ? 4 : 0,
    duration, videoWidth: 854, videoHeight: 480,
    paused: false, seeking: false,
    get currentTime() { return mediaTime; },
    set currentTime(value) { mediaTime = value; requests.push(['seek', value]); },
    getBoundingClientRect() { return { width: 854, height: 480 }; }
  };
  const ad = { ...video, readyState: 0, videoWidth: 0, videoHeight: 0,
    duration: NaN, currentTime: 0 };
  const context = {
    document: { querySelectorAll: sel => sel === 'video' ? [video, ad] : [] },
    globalThis: {},
    Date: { now: () => clock },
    chrome: { runtime: { sendMessage: async message => {
      requests.push(['message', message.action]);
      if (message.action === 'kinoResumeGetPending') return { ok: Boolean(pending),
        pending };
      if (message.action === 'kinoResumeAcknowledge') return { ok: true };
      return { ok: false };
    } } },
    window: { addEventListener() {} },
    setInterval: callback => { const id = ++serial; timers.set(id, callback);
      return id; },
    clearInterval: id => { timers.delete(id); }
  };
  vm.runInNewContext(script, context);
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  return {
    requests, timers, video,
    get position() { return mediaTime; },
    async tick() {
      clock += 500;
      for (const fn of [...timers.values()]) fn();
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('matching film is sought once and acknowledged only after position matches', async () => {
  const ctx = await simulate();
  assert.equal(ctx.position, 187);
  assert.equal(ctx.requests.filter(x => x[0] === 'seek').length, 1);
  await ctx.tick();
  assert.equal(ctx.requests.filter(x => x[1] === 'kinoResumeAcknowledge').length, 1);
  assert.equal(ctx.timers.size, 0);
});

test('unrelated player edition or empty second video cannot be seeked', async () => {
  const ctx = await simulate({ duration: 1200, targetDuration: 600 });
  assert.equal(ctx.requests.filter(x => x[0] === 'seek').length, 0);
  await ctx.tick();
  assert.equal(ctx.position, 0);
});

test('without a pending user resume request no video is changed', async () => {
  const ctx = await simulate({ allow: false });
  await ctx.tick();
  assert.equal(ctx.requests.filter(x => x[0] === 'seek').length, 0);
  assert.equal(ctx.timers.size, 0);
});

test('unready video is left unchanged', async () => {
  const ctx = await simulate({ videoReady: false });
  await ctx.tick();
  assert.equal(ctx.requests.filter(x => x[0] === 'seek').length, 0);
});
