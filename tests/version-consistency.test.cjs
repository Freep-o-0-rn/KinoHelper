'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const read=file=>readFileSync(path.join(__dirname,'..',file),'utf8');
const manifest=JSON.parse(read('manifest.json'));

test('every UI and backup uses manifest.json as the version source',()=>{
  assert.match(manifest.version,/^\d+\.\d+\.\d+$|^\d+\.\d+$/);
  const dashboard=read('stats.js');
  assert.match(dashboard,/chrome\.runtime\.getManifest\?\.\(\)\.version/);
  for(const view of ['popup.html','sidepanel.html'])
    assert.match(read(view),/id="appVersion"/);
  assert.match(read('data-backup.js'),
    /extensionVersion:\s*root\.chrome\.runtime\.getManifest\(\)\.version/);
});

test('current test release is documented and all views have matching version',()=>{
  assert.equal(manifest.version,'1.594');
  assert.match(read('README.md'),/Актуальная тестовая версия — 1\.594/);
  assert.ok(read('README.md').includes('manifest.json'));
});
