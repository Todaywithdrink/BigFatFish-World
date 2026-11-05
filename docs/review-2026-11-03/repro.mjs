// Read-only review of source; all generated state is confined to this review directory.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const OUT = path.dirname(fileURLToPath(import.meta.url));
const { World, pub } = await import(pathToFileURL(ROOT + '/sim/src/world.mjs'));
const { GameMap } = await import(pathToFileURL(ROOT + '/sim/src/map.mjs'));
const { loadTiled } = await import(pathToFileURL(ROOT + '/sim/src/tiledmap.mjs'));
const base = JSON.parse(fs.readFileSync(ROOT + '/sim/data/village.json','utf8'));
const rows = [];
function record(id, reproduced, evidence) { rows.push({id, reproduced, evidence}); console.log(JSON.stringify(rows.at(-1))); }
function fixture() {
 const map=new GameMap({width:24,height:24,legend:structuredClone(base.legend),rows:Array(24).fill('.'.repeat(24)),heights:Array(24).fill('0'.repeat(24)),spawn:{x:10,y:10},homes:[]});
 return new World(map);
}
function at(w,name,x,y,dir=0){const v=w.spawn({name,home:{x,y}});v.dir=dir;return v;}
{
 const w=fixture(),a=at(w,'A',10,10),b=at(w,'B',11,10,Math.PI),c=at(w,'C',12,10,Math.PI);
 w.applyAction(a,{type:'say',to:b.id,private:true,text:'review-only-secret'});
 const e=c.inbox.find(e=>e.type==='heard_muffled');
 record('private-text-in-muffled-event',e?.from?.bubble?.text==='review-only-secret',{type:e?.type,nestedText:e?.from?.bubble?.text});
 w.updatePerception(); const ev=c.inbox.find(e=>e.type==='enter_view'&&e.who.id===a.id);
 record('uid-unmasked-in-events',ev?.who?.uid===a.uid,{masked:w.maskUid(c,a),eventContainsFullUid:ev?.who?.uid===a.uid});
}
{
 const w=fixture(),a=at(w,'A',10,10);w.updateExplored();
 record('rear-terrain-discovered',!w.canSee(a,{x:6.5,y:10.5})&&a.explored.has('6,10'),{visible:w.canSee(a,{x:6.5,y:10.5}),explored:a.explored.has('6,10')});
}
{
 const w=fixture(),a=at(w,'A',10,10);a.inventory.plank=10;a.buildCooldown=100;
 const r=w.applyAction(a,{type:'build',kind:'bench',x:11,y:10});
 record('rejected-build-consumes-materials',!r.ok&&a.inventory.plank===8,{result:r,planksBefore:10,planksAfter:a.inventory.plank});
}
{
 const w=fixture(),a=at(w,'A',10,10);const r=w.applyAction(a,{type:'move',dir:'e',tiles:4});
 const immediateX=a.x;w.map.setKind(12,10,'wall');for(let i=0;i<20;i++)w.step();
 record('move-reports-planned-as-moved',r.moved===4&&immediateX===10.5,{result:r,immediateX});
 record('queued-move-crosses-new-wall',a.x>12.5,{finalX:a.x,wallX:12});
}
{
 const w=fixture(),a=at(w,'A',10,10);a.inventory.plank=8;a.inventory.wood=4;
 const built=w.applyAction(a,{type:'buildHouse',x:8,y:6});
 a.x=10.5;a.y=10.5;const opened=w.applyAction(a,{type:'interact',x:10,y:9});
 const removed=w.applyAction(a,{type:'remove',x:10,y:9});
 record('house-door-not-registered',built.ok&&opened.ok&&!w.map.tile(10,9).walkable,{built:built.ok,openResult:opened,actuallyWalkable:w.map.tile(10,9).walkable,doorRegistered:w.map.doors.has('10,9')});
 record('new-house-not-removable',built.ok&&!removed.ok,{removeResult:removed});
}
{
 const map=new GameMap(loadTiled(ROOT+'/sim/maps/village.tmj'));
 const w=new World(map);let spot;
 for(let y=1;y<map.height-1&&!spot;y++)for(let x=1;x<map.width-1&&!spot;x++)if(map.tile(x,y).kind==='grass'&&map.tile(x+1,y).kind==='grass')spot={x,y};
 const a=at(w,'A',spot.x,spot.y);a.inventory.wood=6;a.inventory.plank=3;
 const r=w.applyAction(a,{type:'build',kind:'bed',x:spot.x+1,y:spot.y});
 record('production-map-missing-kinds',r.ok&&map.tile(spot.x+1,spot.y).kind!=='bed',{missing:['bed','stove','board','stump','crate'].filter(k=>!map.byKind[k]),result:r,actualKind:map.tile(spot.x+1,spot.y).kind,materialsAfter:{wood:a.inventory.wood,plank:a.inventory.plank}});
}
{
 const w=fixture(),a=at(w,'A',10,10);w.map.setKind(11,10,'stove');a.needs.hunger=0;
 const r=w.applyAction(a,{type:'eat'});
 record('eat-with-empty-inventory',r.ok&&a.needs.hunger===40,{result:r,inventory:a.inventory});
 a.needs.hunger=0;for(let i=0;i<6000;i++)w.step();
 record('starvation-has-no-consequence',a.hp===100,{ticks:6000,hunger:a.needs.hunger,hp:a.hp,state:a.state});
}
{
 const w=fixture(),a=at(w,'A',10,10);const built=w.applyAction(a,{type:'build',kind:'flower',x:11,y:10});const f=w.applyAction(a,{type:'forage'});
 record('free-flower-resource-source',built.ok&&a.inventory.flower===1,{build:built,forage:f});
}
{
 const w=fixture(),a=at(w,'A',10,10),b=at(w,'B',11,10,Math.PI);a.inventory.wood=1;b.inventory.plank=1;
 const q=w.applyAction(a,{type:'quote',targetId:b.id,item:'wood',count:1,want:{item:'plank',count:1}});
 const e=b.inbox.find(e=>e.type==='quote_received');
 record('barter-offer-omits-want',q.ok&&!('want' in e),{quoteCreated:q.ok,event:e});
 b.x=20.5;b.y=20.5;const r=w.applyAction(b,{type:'accept',quoteId:q.quoteId});
 record('remote-trade-settles',r.ok,{distance:Math.hypot(b.x-a.x,b.y-a.y),result:r});
}
{
 const w=fixture(),a=at(w,'A',2,2),b=at(w,'B',20,20);a.inventory.wood=1;
 const p=w.applyAction(a,{type:'publish',kind:'auction',item:'wood',count:1,price:100,public:false,to:a.id});
 const r=w.applyAction(b,{type:'placeBid',protocolId:p.protocolId,price:1000});w.applyAction(a,{type:'closeAuction',protocolId:p.protocolId});
 record('uninvited-zero-cash-auction-winner',r.ok&&b.inventory.wood===1&&a.coins===0,{bidResult:r,buyerCoins:b.coins,sellerCoins:a.coins,buyerWood:b.inventory.wood});
}
{
 const w=fixture();w.map.setKind(2,2,'tree');w.map.findNearest('tree',10,10);w.map.setKind(2,2,'grass');
 const n=w.map.findNearest('tree',10,10);
 record('map-kind-cache-stale',!!n&&w.map.tile(n.x,n.y).kind!=='tree',{nearest:n,actual:n?w.map.tile(n.x,n.y).kind:null});
}
const serverText=fs.readFileSync(ROOT+'/sim/server.mjs','utf8');
const pureContext=vm.createContext({pub,CAPABILITIES:[],STATE_VERSION:1});
vm.runInContext(serverText.slice(serverText.indexOf('function serializeWorld('),serverText.indexOf('function maybeExpand(')) + '\n' + serverText.slice(serverText.indexOf('function tileView('),serverText.indexOf('function parseSchedule(')),pureContext);
{
 const w=fixture(),a=at(w,'A',10,10);a.appearance={cloth:{hue:20}};a.lastBed={x:1,y:1};a.debtors={B:3};a.cooldowns.attack=.8;a.state='downed';a.downedUntil=200;
 const s=pureContext.serializeWorld(w).villagers[0];
 const omitted=['talent','appearance','lastBed','state','downedUntil','cooldowns','debtors','inbox'].filter(k=>!(k in s));
 record('save-omits-causal-state',omitted.length===8,{omitted});
 const b=at(w,'B',20,20);a.state='idle';a.inventory.wood=1;w.applyAction(a,{type:'publish',item:'wood',public:false,to:a.id});
 const o=pureContext.observe(w,b);record('observation-includes-private-auction',o.view.protocols.length===1,{count:o.view.protocols.length});
 w.emit(b,{type:'review-event'});const first=pureContext.observe(w,b),second=pureContext.observe(w,b);
 record('observation-consumes-events',first.events.length>0&&second.events.length===0,{firstCount:first.events.length,secondCount:second.events.length});
}
{
 const hosted=fs.readFileSync(ROOT+'/sim/agents/hosted.mjs','utf8');
 const context=vm.createContext({});
 vm.runInContext(hosted.slice(0,hosted.indexOf('function extractActions(')),context);
 const obs={self:{name:'A',x:1,y:1,dir:0,hp:100,needs:{energy:100,hunger:100},state:'idle',inventory:[{id:'wood',count:10}],coins:30},exploredCount:2,view:{entities:[],tiles:['@'],board:[{text:'review-board'}]},events:[{type:'sold',shortfall:20},{type:'quote_received',quoteId:'q1'}]};
 const input=JSON.parse(context.buildMessages(obs,'')[1].content);
 record('hosted-omits-inventory-and-transactions',!input.self.inventory&&!JSON.stringify(input).includes('q1')&&!JSON.stringify(input).includes('shortfall'),{modelUserInput:input});
}
// A minimal local HTTP instance in an isolated copy. No user saves, keys, or model config are copied.
const sandbox=fs.mkdtempSync(path.join(OUT,'sandbox-'));
for(const d of ['src','agents','plugins','maps','data'])fs.mkdirSync(path.join(sandbox,d),{recursive:true});
for(const d of ['src','agents','plugins'])for(const name of fs.readdirSync(path.join(ROOT,'sim',d)))if(name.endsWith('.mjs'))fs.copyFileSync(path.join(ROOT,'sim',d,name),path.join(sandbox,d,name));
for(const name of ['server.mjs','data/village.json','maps/village.tmj'])fs.copyFileSync(path.join(ROOT,'sim',name),path.join(sandbox,name));
const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const endpoint=`http://127.0.0.1:${port}`;
let child;
async function start(){
 child=spawn(process.execPath,[path.join(sandbox,'server.mjs')],{cwd:sandbox,windowsHide:true,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',BRAINS:'0',INVITE_REQUIRED:'0',VILLAGERS:'2',ADMIN_TOKEN:'review-isolated-admin'},stdio:['ignore','pipe','pipe']});
 let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stdout+=b);
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('isolated server exited: '+stdout);try{const r=await fetch(endpoint+'/api/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}
 throw Error('server readiness timeout');
}
async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
async function json(url,body,admin=false){const r=await fetch(endpoint+url,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(admin?{authorization:'Bearer review-isolated-admin'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json()};}
try{
 await start();const before=await json('/api/world');
 record('unauthenticated-full-world',before.status===200&&before.body.map.rows.length>0,{status:before.status,mapWidth:before.body.map.width,entities:before.body.entities.length});
 const grown=await json('/api/admin/grow',{side:'e'},true);const savedMap=JSON.parse(fs.readFileSync(path.join(sandbox,'data/world-map.json'),'utf8'));
 record('map-expansion-written',savedMap.width===before.body.map.width+32,{oldWidth:before.body.map.width,savedWidth:savedMap.width});
 const reg=await json('/api/agents/register',{name:'review-agent',publicView:false,palette:{hair:'#000000',skin:'#eeeeee',dress:'#ff0000'}});
 if(reg.status!==200)throw Error('isolated registration failed');
 const snap=await json('/api/world');const disk=JSON.parse(fs.readFileSync(path.join(sandbox,'data/world-state.json'),'utf8'));const d=disk.villagers.find(v=>v.id===reg.body.villager.id);
 record('private-view-still-public',snap.body.entities.some(e=>e.id===reg.body.villager.id),{publicView:false,exposedInWorld:snap.body.entities.some(e=>e.id===reg.body.villager.id)});
 record('appearance-lost-on-save',!d.appearance,{memoryHasPalette:!!reg.body.villager.appearance.palette,diskHasAppearance:!!d.appearance});
 await stop();await start();const restarted=await json('/api/world');
 record('restart-prefers-template-over-save',restarted.body.map.width===before.body.map.width&&savedMap.width!==restarted.body.map.width,{savedWidth:savedMap.width,restartedWidth:restarted.body.map.width});
}finally{await stop();}
const manifest={};
for(const f of ['sim/server.mjs','sim/src/world.mjs','sim/src/map.mjs','sim/src/tiledmap.mjs','sim/agents/hosted.mjs','sim/agents/brain.mjs','sim/tools/selftest.mjs'])manifest[f]=createHash('sha256').update(fs.readFileSync(path.join(ROOT,f))).digest('hex');
fs.writeFileSync(path.join(OUT,'repro-results.json'),JSON.stringify({at:new Date().toISOString(),node:process.version,source:ROOT,sandbox,manifest,checks:rows,reproduced:rows.filter(r=>r.reproduced).length,total:rows.length},null,2));
console.log(`Reproduced ${rows.filter(r=>r.reproduced).length}/${rows.length}; evidence in repro-results.json`);
