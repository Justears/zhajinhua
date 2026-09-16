'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function client() {
  const elements=new Map();
  function element(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:true,open:false,isConnected:true,className:'',close(){this.open=false;},showModal(){this.open=true;},querySelectorAll(){return[];}});return elements.get(id);}
  const context=vm.createContext({document:{getElementById:element,addEventListener(){},hidden:false,title:''},window:{addEventListener(){}},location:{search:'',origin:'https://game.example'},history:{pushState(){}},localStorage:{getItem(){return'';},setItem(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},URLSearchParams,AbortController,Date,console});
  // Unit-test the navigation controller without starting its automatic request.
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8').replace(/route\(\);\s*$/,'');
  vm.runInContext(source,context);
  return {context,element,run:code=>vm.runInContext(code,context)};
}
test('旧的同版本响应不能倒退倒计时或房主在线状态',()=>{
  const c=client();c.run(`mode='room';activeCode='ABCDEF';room={code:'ABCDEF',version:5,serverTime:200,you:'me',canClaimHost:true};renderRoom=()=>{};`);
  c.run(`receive({code:'ABCDEF',version:5,serverTime:100,you:'me',canClaimHost:false});`);
  assert.equal(c.run('room.serverTime'),200);assert.equal(c.run('room.canClaimHost'),true);
});
test('轮到自己时，轮询刷新不会清掉标题提醒',()=>{
  const c=client();c.run(`mode='room';activeCode='ABCDEF';room={code:'ABCDEF',version:5,serverTime:100,you:'me',game:{phase:'betting',current:'me',round:1}};renderRoom=()=>{};receive({...room,serverTime:200});`);
  assert.equal(c.context.document.title,'轮到你了 · 后周炸炸炸');
});
test('离开又回到同一房间时，旧请求的 401 不能踢走新页面',async()=>{
  const c=client();c.run(`mode='room';activeCode='ABCDEF';room={code:'ABCDEF'};var rejectOld;api=()=>new Promise((resolve,reject)=>{rejectOld=reject;});var oldRequest=refreshRoom();navigationEpoch++;mode='room';activeCode='ABCDEF';room={code:'ABCDEF',version:8};`);
  c.run(`rejectOld(Object.assign(new Error('expired'),{status:401}));`);await c.run('oldRequest');
  assert.equal(c.run('mode'),'room');assert.equal(c.run('room.version'),8);
});
test('慢网络下房间刷新只保留一个请求，失败后可再次刷新',async()=>{
  const c=client();c.run(`mode='room';activeCode='ABCDEF';room={code:'ABCDEF'};var calls=0,failRequest;api=()=>{calls++;return new Promise((resolve,reject)=>{failRequest=reject;});};var firstRefresh=refreshRoom();refreshRoom();refreshRoom();`);
  assert.equal(c.run('calls'),1);c.run(`failRequest(new Error('offline'));`);await c.run('firstRefresh');assert.equal(c.run('roomLoad'),null);
  c.run(`var secondRefresh=refreshRoom();`);assert.equal(c.run('calls'),2);c.run(`failRequest(new Error('offline'));`);await c.run('secondRefresh');
});
test('旧大厅请求失败不能影响重新进入的大厅',async()=>{
  const c=client();c.run(`mode='lobby';var rejectLobby;api=()=>new Promise((resolve,reject)=>{rejectLobby=reject;});var oldLobby=loadRooms();navigationEpoch++;mode='lobby';`);
  c.run(`rejectLobby(Object.assign(new Error('expired'),{status:401}));`);await c.run('oldLobby');assert.equal(c.run('mode'),'lobby');
});
