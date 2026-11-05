import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {GameMap}=await import(pathToFileURL(root+'/sim/src/map.mjs'));
const {loadTiled}=await import(pathToFileURL(root+'/sim/src/tiledmap.mjs'));
const {World}=await import(pathToFileURL(root+'/sim/src/world.mjs'));
const output=[];
for(const count of [10,30])for(const layout of ['dense','spread']){
 const map=new GameMap(loadTiled(root+'/sim/maps/village.tmj'));
 const w=new World(map),cells=[];
 for(let y=1;y<map.height-1;y++)for(let x=1;x<map.width-1;x++)if(map.tile(x,y).walkable)cells.push({x,y});
 for(let i=0;i<count;i++){
  const pos=layout==='dense'?{x:32+i%5,y:36+Math.floor(i/5)}:cells[Math.floor(i*cells.length/count)];
  w.spawn({name:'B'+i,home:pos});
 }
 for(let i=0;i<100;i++)w.step();
 const samples=[],started=performance.now();
 for(let i=0;i<1000;i++){
  const t=performance.now();w.step();JSON.stringify(w.snapshot());samples.push(performance.now()-t);
 }
 samples.sort((a,b)=>a-b);
 const bytes=Buffer.byteLength(JSON.stringify(w.snapshot()));
 output.push({count,layout,iterations:1000,averageMs:(performance.now()-started)/1000,p95Ms:samples[950],p99Ms:samples[990],maxMs:samples.at(-1),snapshotBytes:bytes,bytesPerSecondPerViewerAt10Hz:bytes*10});
}
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'benchmark.json'),JSON.stringify({node:process.version,scenario:'headless step + snapshot + stringify only; no model, disk, HTTP, rendering or backpressure',output},null,2));
console.log(JSON.stringify(output,null,2));
