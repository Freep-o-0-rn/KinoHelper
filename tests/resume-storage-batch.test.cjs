'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','resume-ui.js'),'utf8');

function extractReader(chrome){
 const start=source.indexOf('  async function readStorage() {');
 const end=source.indexOf('\n  async function updateActive()',start);
 assert.ok(start>=0 && end>start);
 const body=source.slice(start,end);
 const setup='const PROGRESS_KEY="kinoPlaybackProgressV1";'+
   'const SERIES_KEY="kinoSeriesEpisodeProgressV1";'+
   'const COVERAGE_KEY="kinoPlaybackCoverageV1";'+
   'let storageReadSequence=0;'+
   'let progress={},episodeProgress={},coverage={};'+
   'let renders=0;const render=()=>{renders++;};';
 const expose='return {readStorage,get progress(){return progress;},'+
   'get episodeProgress(){return episodeProgress;},'+
   'get coverage(){return coverage;},get renders(){return renders;}};';
 return new Function('chrome','console',setup+body+expose)(chrome,console);
}

test('resume checkpoint refresh uses one local storage call with all keys',async()=>{
 let calls=0,keys=[];
 const chrome={storage:{local:{async get(request){
   calls++;keys=request;
   return {
     kinoPlaybackProgressV1:{'film:1':{position:100}},
     kinoSeriesEpisodeProgressV1:{'series:2:1:3':{position:200}},
     kinoPlaybackCoverageV1:{'film:1':{ranges:[[0,90]]}}
   };
 }}}};
 const ui=extractReader(chrome);
 await ui.readStorage();
 assert.equal(calls,1);
 assert.deepEqual(keys,[
   'kinoPlaybackProgressV1',
   'kinoSeriesEpisodeProgressV1',
   'kinoPlaybackCoverageV1'
 ]);
 assert.equal(ui.progress['film:1'].position,100);
 assert.equal(ui.episodeProgress['series:2:1:3'].position,200);
 assert.equal(ui.coverage['film:1'].ranges[0][1],90);
 assert.equal(ui.renders,1);
});

test('resume storage error clears all related progress together',async()=>{
 let calls=0;
 const chrome={storage:{local:{async get(){calls++;throw Error('Disk busy');}}}};
 const ui=extractReader(chrome);
 await ui.readStorage();
 assert.equal(calls,1);
 assert.deepEqual(Object.keys(ui.progress),[]);
 assert.deepEqual(Object.keys(ui.episodeProgress),[]);
 assert.deepEqual(Object.keys(ui.coverage),[]);
 assert.equal(ui.renders,1);
});
