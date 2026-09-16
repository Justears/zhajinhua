'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createServer,listenOptions}=require('../server.cjs');
async function setup(t,settings={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'houzhou-security-'));
  let clock=Date.now(),password='friends-password-123',app,base;
  async function start(){app=createServer({dataDir:dir,password,now:()=>clock,...settings});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;}
  await start();t.after(async()=>{await app.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  async function req(url,data,cookie='',headers={}){return new Promise((resolve,reject)=>{
    const request=require('node:http').request(base+url,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'content-type':'application/json'}),cookie,...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('error',reject);res.on('end',()=>{
        try{resolve({status:res.statusCode,body:JSON.parse(text),cookie:res.headers['set-cookie']?.[0].split(';')[0],headers:{get:name=>res.headers[name]?.toString()}});}catch(e){reject(e);}
      });
    });request.on('error',reject);request.end(data===undefined?undefined:JSON.stringify(data));
  });}
  return {req,dir,get base(){return base;},get app(){return app;},advance(ms){clock+=ms;app.tick();},async restart(next=password){await app.shutdown();password=next;await start();},async login(cookie=''){const r=await req('/api/login',{password},cookie);assert.equal(r.status,200);return r.cookie;}};
}
test('修改入场密码撤销旧登录，新密码验证后恢复原房间和座位',async t=>{
  const f=await setup(t),cookie=await f.login();
  const made=await f.req('/api/rooms',{nickname:'原房主'},cookie),before=made.body;
  await f.restart();assert.equal((await f.req('/api/me',undefined,cookie)).status,200);
  await f.restart('new-friends-password');assert.equal((await f.req('/api/me',undefined,cookie)).status,401);
  assert.equal((await f.req('/api/login',{password:'friends-password-123'},cookie)).status,401);
  const renewed=await f.login(cookie);assert.notEqual(renewed,cookie);
  const restored=await f.req('/api/rooms/'+before.code,undefined,renewed);
  assert.equal(restored.body.you,before.you);assert.equal(restored.body.isHost,true);
  await f.restart('friends-password-123');assert.equal((await f.req('/api/me',undefined,cookie)).status,401,'改回旧密码也不能复活最初的凭证');
});
test('v1.1.1 旧签名仅能在重新验证入场密码后恢复座位',async t=>{
  const f=await setup(t),cookie=await f.login(),made=await f.req('/api/rooms',{nickname:'旧用户'},cookie);
  const [id,expires]=cookie.split('=')[1].split('.'),config=JSON.parse(fs.readFileSync(path.join(f.dir,'config.json'),'utf8'));
  const sig=crypto.createHmac('sha256',config.secret).update(`${id}.${expires}`).digest('hex');
  const legacy=`jinhua_session=${id}.${expires}.${sig}`;
  assert.equal((await f.req('/api/me',undefined,legacy)).status,401);
  const fresh=await f.login(legacy);
  assert.equal((await f.req('/api/rooms/'+made.body.code,undefined,fresh)).body.you,made.body.you);
  assert.equal((await f.req('/api/me',undefined,cookie+'.extra')).status,401);
});
test('到期的实时连接在下一次广播时停止返回牌桌数据',async t=>{
  const f=await setup(t),oldCookie=await f.login(),made=await f.req('/api/rooms',{nickname:'甲'},oldCookie),code=made.body.code;
  const stream=await fetch(f.base+`/api/rooms/${code}/events`,{headers:{cookie:oldCookie}}),reader=stream.body.getReader();
  t.after(()=>reader.cancel());await reader.read();
  f.advance(89*86400000);const fresh=await f.login(oldCookie);f.advance(2*86400000);
  assert.equal((await f.req('/api/me',undefined,oldCookie)).status,401);
  await f.req(`/api/rooms/${code}/chat`,{text:'不应发给旧连接'},fresh);
  const data=await reader.read();assert.match(new TextDecoder().decode(data.value),/event: auth-expired/);
  assert.doesNotMatch(new TextDecoder().decode(data.value),/不应发给旧连接/);
});
test('房主在另一桌活动不会阻止本桌接任',async t=>{
  const f=await setup(t),a=await f.login(),b=await f.login();
  const first=(await f.req('/api/rooms',{nickname:'甲'},a)).body;
  await f.req(`/api/rooms/${first.code}/join`,{nickname:'乙'},b);
  const second=(await f.req('/api/rooms',{nickname:'甲'},a)).body;
  f.advance(120001);await f.req(`/api/rooms/${second.code}`,undefined,a);
  const view=(await f.req(`/api/rooms/${first.code}`,undefined,b)).body;
  assert.equal(view.canClaimHost,true);assert.equal(view.seats.find(s=>s.isHost).online,false);
  const claimed=await f.req(`/api/rooms/${first.code}/claim-host`,{version:view.version,requestId:crypto.randomUUID()},b);
  assert.equal(claimed.status,200);assert.equal(claimed.body.isHost,true);
});
test('HTTPS 入口拒绝降级来源、其他域名和伪造代理头',async t=>{
  const f=await setup(t,{publicOrigin:'https://game.example:5588',secureCookie:true});
  const headers={host:'game.example:5588',origin:'https://game.example:5588'};
  const ok=await f.req('/api/login',{password:'friends-password-123'},'',headers);
  assert.equal(ok.status,200);assert.match(ok.headers.get('set-cookie'),/; Secure/);
  for(const origin of ['http://game.example:5588','https://other.example','null','not a URL']) {
    assert.equal((await f.req('/api/login',{password:'friends-password-123'},'',{...headers,origin})).status,403);
  }
  assert.equal((await f.req('/api/me',undefined,ok.cookie,{'x-forwarded-host':'game.example:5588'})).status,403);
  assert.equal((await f.req('/health')).status,200,'本机健康检查不受网站域名限制');
});
test('静态路径中的原型属性按不存在处理',async t=>{
  const f=await setup(t);
  for(const route of ['/constructor','/__proto__','/toString'])assert.equal((await f.req(route)).status,404);
});
test('监听设置支持本机地址，拒绝无效端口及地址',()=>{
  assert.deepEqual(listenOptions({BIND_ADDRESS:'127.0.0.1',PORT:'8899'}),{host:'127.0.0.1',port:8899});
  assert.deepEqual(listenOptions({}),{host:'0.0.0.0',port:8080});
  for(const PORT of ['0','65536','-1','abc','1.5'])assert.throws(()=>listenOptions({PORT}),/PORT/);
  assert.throws(()=>listenOptions({BIND_ADDRESS:'invalid'}),/BIND_ADDRESS/);
});
