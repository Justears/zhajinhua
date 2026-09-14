'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createServer}=require('../server.cjs'),engine=require('../engines/zjh.cjs');
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jinhua-test-'));let clock=Date.now(),app;
  async function launch(){app=createServer({dataDir:dir,password:'test-password-123',now:()=>clock});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${app.server.address().port}`;}
  let base=await launch();
  t.after(async()=>{await app.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  function client(){return {cookie:'',async req(url,data,extra={}){const res=await fetch(base+url,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'content-type':'application/json'}),...(this.cookie?{cookie:this.cookie}:{}),...extra},body:data===undefined?undefined:JSON.stringify(data)});if(res.headers.get('set-cookie'))this.cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,body:await res.json()};},async login(){const r=await this.req('/api/login',{password:'test-password-123'});assert.equal(r.status,200);return this;},async move(code,op,data={}){const state=await this.req('/api/rooms/'+code);return this.req(`/api/rooms/${code}/${op}`,{version:state.body.version,requestId:crypto.randomUUID(),...data});}};}
  return {client,get app(){return app;},dir,advance(ms,runTick=true){clock+=ms;if(runTick)app.tick();},async restart(){await app.shutdown();base=await launch();}};
}
test('8 人完整 API 对局：权限、隐藏手牌、版本冲突、重复请求、重启续局',async t=>{
  const f=await fixture(t),users=[];for(let i=0;i<9;i++)users.push(await f.client().login());
  const host=users[0];let result=await host.req('/api/rooms',{nickname:'房主',name:'测试牌桌',capacity:8,turnSeconds:30});assert.equal(result.status,201);const code=result.body.code;
  for(let i=1;i<8;i++){const r=await users[i].req(`/api/rooms/${code}/join`,{nickname:'好友'+i});assert.equal(r.status,200);}
  assert.equal((await users[8].req(`/api/rooms/${code}/join`,{nickname:'第九人'})).status,409);
  assert.equal((await users[8].req(`/api/rooms/${code}`)).status,403);
  assert.equal((await users[1].move(code,'start')).status,403);
  result=await host.move(code,'start');assert.equal(result.status,200);assert.equal(result.body.game.players.length,8);
  const map=new Map();for(const user of users.slice(0,8)){const r=await user.req(`/api/rooms/${code}`);map.set(r.body.you,user);assert.ok(r.body.game.players.every(p=>p.cards===null));assert.equal(r.body.game.rngState,undefined);assert.equal(r.body.game.pile,undefined);assert.equal(r.body.seats[0].owner,undefined);}
  let view=result.body,current=map.get(view.game.current);
  const stale=view.version;const looked=await current.move(code,'action',{action:{type:'look'}});assert.equal(looked.status,200);assert.equal(looked.body.game.players.find(p=>p.id===looked.body.you).cards.length,3);
  assert.equal(looked.body.deadline,view.deadline,'看牌不能刷新计时');
  const outsider=[...map.values()].find(u=>u!==current);const other=await outsider.req(`/api/rooms/${code}`);assert.ok(other.body.game.players.every(p=>p.cards===null));
  assert.equal((await current.req(`/api/rooms/${code}/action`,{version:stale,requestId:crypto.randomUUID(),action:{type:'fold'}})).status,409);
  assert.equal((await outsider.move(code,'action',{action:{type:'fold'}})).status,400);
  const bytes={version:looked.body.version,requestId:crypto.randomUUID(),action:{type:'bet',amount:looked.body.game.callCost}};
  const once=await current.req(`/api/rooms/${code}/action`,bytes),twice=await current.req(`/api/rooms/${code}/action`,bytes);assert.equal(once.status,200);assert.equal(twice.status,200);assert.equal(once.body.version,twice.body.version);assert.deepEqual(once.body.game,twice.body.game);
  await f.restart();view=(await current.req(`/api/rooms/${code}`)).body;assert.deepEqual(view.game,once.body.game);
  let turns=0;while(view.game.phase==='betting'&&turns++<20){const actor=map.get(view.game.current);const r=await actor.move(code,'action',{action:{type:'fold'}});assert.equal(r.status,200);view=r.body;}
  assert.equal(view.game.phase,'round_over');assert.equal(view.game.players.reduce((sum,p)=>sum+p.chips,0),8000);
  assert.equal((await users[1].move(code,'action',{action:{type:'next_round'}})).status,403);
  const next=await host.move(code,'action',{action:{type:'next_round'}});assert.equal(next.status,200);assert.equal(next.body.game.round,2);
  assert.equal((await users[1].move(code,'close')).status,403);
});
test('超时弃牌、中文聊天、跨站请求拒绝、候场房主转移',async t=>{
  const f=await fixture(t),a=await f.client().login(),b=await f.client().login();const created=await a.req('/api/rooms',{nickname:'甲',turnSeconds:20});const code=created.body.code;
  assert.equal((await b.req(`/api/rooms/${code}/join`,{nickname:'乙'})).status,200);
  const chat=await a.req(`/api/rooms/${code}/chat`,{text:'你好，🌸 <script>alert(1)</script>'});assert.equal(chat.status,200);assert.equal(chat.body.chat[0].text,'你好，🌸 <script>alert(1)</script>');
  assert.equal((await a.req(`/api/rooms/${code}/chat`,{text:'blocked'},{origin:'https://evil.example'})).status,403);
  const start=await a.move(code,'start');assert.equal(start.status,200);f.advance(21000);const end=await a.req(`/api/rooms/${code}`);assert.equal(end.body.game.phase,'round_over');assert.match(end.body.chat.at(-1).text,/自动弃牌/);
  const reset=await a.move(code,'reset');assert.equal(reset.status,200);assert.equal(reset.body.game,null);
  assert.equal((await a.move(code,'leave')).status,200);assert.equal((await b.req(`/api/rooms/${code}`)).body.isHost,true);
  assert.equal((await b.move(code,'close')).status,200);assert.equal((await b.req(`/api/rooms/${code}`)).status,404);
});
test('登录和数据边界：未登录、伪造 cookie、参数非法、静态文件隔离',async t=>{
  const f=await fixture(t),c=f.client();assert.equal((await c.req('/api/rooms')).status,401);assert.equal((await c.req('/api/login',{password:'wrong'})).status,401);
  c.cookie='jinhua_session='+ 'a'.repeat(48)+'.9999999999999.'+'0'.repeat(64);assert.equal((await c.req('/api/me')).status,401);await c.login();
  for(const args of [{nickname:'x',capacity:9},{nickname:'x',ante:3},{nickname:'x',chips:1},{nickname:'',capacity:8}])assert.equal((await c.req('/api/rooms',args)).status,400);
  assert.equal((await c.req('/data/config.json')).status,404);assert.equal((await c.req('/engines/zjh.cjs')).status,404);
});
test('8 人随机压力测试：500 局、卡牌唯一、积分守恒、无死锁',()=>{
  for(let i=0;i<500;i++){
    let s=engine.createGame({players:Array.from({length:8},(_,j)=>({id:'p'+j})),seed:'stress-'+i,secureRandom:true,rules:{max_bet:100}});
    let step=0;while(s.phase==='betting'&&step++<1500){
      const all=s.players.flatMap(p=>p.cards).concat(s.pile);assert.equal(new Set(all).size,52);assert.equal(all.length,52);
      const choices=engine.legalMoves(s,s.current).filter(a=>a.type!=='look');const action=choices[crypto.randomInt(choices.length)];s=engine.apply(s,s.current,action).state;
      assert.equal(s.players.reduce((n,p)=>n+p.chips,0)+s.pot,8000);assert.ok(s.players.every(p=>p.chips>=0));
    }
    assert.equal(s.phase,'round_over');
  }
});

test('聊天不抢占操作版本，旧牌局动作仍拒绝，重复提交只执行一次',async t=>{
 const f=await fixture(t),a=await f.client().login(),b=await f.client().login();
 const made=await a.req('/api/rooms',{nickname:'甲'}),code=made.body.code;await b.req('/api/rooms/'+code+'/join',{nickname:'乙'});
 const started=await a.move(code,'start');const actor=started.body.game.current===started.body.you?a:b;
 const before=(await actor.req('/api/rooms/'+code)).body;
 await a.req('/api/rooms/'+code+'/chat',{text:'这条消息不应打断出牌'});
 const after=(await actor.req('/api/rooms/'+code)).body;assert.ok(after.version>before.version);assert.equal(after.actionVersion,before.actionVersion);
 const move={version:before.version,actionVersion:before.actionVersion,requestId:crypto.randomUUID(),action:{type:'look'}};
 const looked=await actor.req('/api/rooms/'+code+'/action',move);assert.equal(looked.status,200);
 const duplicate=await actor.req('/api/rooms/'+code+'/action',move);assert.equal(duplicate.body.actionVersion,looked.body.actionVersion);
 const stale=await actor.req('/api/rooms/'+code+'/action',{...move,requestId:crypto.randomUUID(),action:{type:'fold'}});assert.equal(stale.status,409);
 await f.restart();assert.equal((await actor.req('/api/rooms/'+code)).body.actionVersion,looked.body.actionVersion);
});
test('建房拒绝发牌后所有人立即耗尽积分的配置',async t=>{const f=await fixture(t),a=await f.client().login();assert.equal((await a.req('/api/rooms',{nickname:'甲',ante:100,chips:100})).status,400);});

test('截止时间在计时器触发前同样生效',async t=>{const f=await fixture(t),a=await f.client().login(),b=await f.client().login();const made=await a.req('/api/rooms',{nickname:'甲',turnSeconds:20}),code=made.body.code;await b.req('/api/rooms/'+code+'/join',{nickname:'乙'});const start=(await a.move(code,'start')).body;const actor=start.game.current===start.you?a:b;const snap=(await actor.req('/api/rooms/'+code)).body;f.advance(20001,false);const late=await actor.req('/api/rooms/'+code+'/action',{version:snap.version,actionVersion:snap.actionVersion,requestId:crypto.randomUUID(),action:{type:'look'}});assert.equal(late.status,409);assert.equal(late.body.error,'牌局已经变化，请确认最新画面后重试');assert.equal((await actor.req('/api/rooms/'+code)).body.game.phase,'round_over');});
test('房主离线两分钟才能接任，接任后拥有开局权限',async t=>{const f=await fixture(t),a=await f.client().login(),b=await f.client().login();const made=await a.req('/api/rooms',{nickname:'甲'}),code=made.body.code;await b.req('/api/rooms/'+code+'/join',{nickname:'乙'});assert.equal((await b.move(code,'claim-host')).status,409);f.advance(120001);assert.equal((await b.req('/api/rooms/'+code)).body.canClaimHost,true);const claimed=await b.move(code,'claim-host');assert.equal(claimed.status,200);assert.equal(claimed.body.isHost,true);assert.equal((await a.move(code,'start')).status,403);assert.equal((await b.move(code,'start')).status,200);});
