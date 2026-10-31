'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const account=require('../stats-account.js');
const page=(url,body='',status=200)=>({url,status,ok:status>=200&&status<300,text:async()=>body});
const loggedHeader='<script>window.getUserId = function () { return 1234567; };</script>';
test('redirect from personal /mykp/ page determines current account',async()=>{
 const seen=[];
 const result=await account.detect(async (url,opts)=>{
   seen.push({url,opts});
   return page('https://www.kinopoisk.ru/user/1234567/');
 });
 assert.equal(result.status,'logged-in');
 assert.equal(result.id,'1234567');
 assert.equal(seen.length,1);
 assert.equal(seen[0].opts.credentials,'include');
 assert.equal(seen[0].opts.cache,'no-store');
});
test('HTML personal account bootstrap is accepted after fallback',async()=>{
 const result=await account.detect(async url=>{
   return url.endsWith('/mykp/')?page(url,'<h1>Мой Кинопоиск</h1>'):
     page(url,loggedHeader);
 });
 assert.equal(result.status,'logged-in');
 assert.equal(result.id,'1234567');
});
test('unrelated public profile or unrelated page cannot impersonate login',async()=>{
 const result=await account.detect(async url=>page(
   'https://www.kinopoisk.ru/user/9999999/movies/voted-watched/',
   loggedHeader));
 assert.notEqual(result.status,'logged-in');
 assert.equal(result.id,'');
});
test('direct profile identity does not work for /mykp/folders/ fallback',()=>{
 assert.equal(account.identityFromResponse(
   '/mykp/folders/1/','https://www.kinopoisk.ru/user/8888888/',''),'');
});
test('Yandex login redirect, captcha and HTTP failures never infer IDs',async()=>{
 const a=await account.detect(async()=>page('https://passport.yandex.ru/auth/'));
 const b=await account.detect(async()=>page('https://www.kinopoisk.ru/showcaptcha'));
 const c=await account.detect(async url=>page(url,'',503));
 assert.equal(a.status,'logged-out');
 assert.notEqual(b.status,'logged-in');
 assert.notEqual(c.status,'logged-in');
});
test('no user ID in a normal page must not guess an account',async()=>{
 const result=await account.detect(async url=>page(url,'<h1>Профиль</h1>'));
 assert.equal(result.status,'unavailable');
 assert.equal(result.id,'');
});
test('personal Id parser requires a recognized Kinopoisk domain',()=>{
 assert.equal(account.identityFromResponse('/mykp/',
   'https://evil.example/user/1234567/',loggedHeader),'');
 assert.equal(account.identityFromResponse('/mykp/',
   'https://www.kinopoisk.ru/mykp/',loggedHeader),'1234567');
});
