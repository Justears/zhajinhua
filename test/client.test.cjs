'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function client() {
  const elements=new Map();
  function element(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:true,open:false,isConnected:true,className:'',focus(){},setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];},querySelector(){return null;},close(){this.open=false;},showModal(){this.open=true;},querySelectorAll(){return[];}});return elements.get(id);}
  const context=vm.createContext({document:{getElementById:element,addEventListener(){},hidden:false,title:''},window:{addEventListener(){},scrollTo(){}},location:{search:'',origin:'https://game.example'},history:{pushState(){}},localStorage:{getItem(){return'';},setItem(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},URLSearchParams,AbortController,Date,console});
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

test('房间加载断网保留邀请地址，并显示可重试页面',async()=>{
  const c=client(),paths=[];c.context.history.pushState=(_,__,url)=>paths.push(url);
  c.run(`api=async()=>{throw new Error('offline');};`);
  await c.run(`openRoom('ABCDEF');`);
  assert.equal(c.run('mode'),'unavailable');assert.deepEqual(paths,[]);
  assert.match(c.element('app').innerHTML,/重新连接/);
});

test('旧登录的成功响应不会把已切换的页面重新导航',async()=>{
  const c=client(),button={disabled:false,isConnected:true};
  c.element('login-form').querySelector=()=>button;
  c.run(`login();var finishLogin,routes=0;api=()=>new Promise(resolve=>finishLogin=resolve);route=async()=>{routes++;};`);
  c.element('password').value='test-password';
  const pending=c.element('login-form').onsubmit({preventDefault(){},target:c.element('login-form')});
  c.run(`navigationEpoch++;mode='room';finishLogin({ok:true});`);await pending;
  assert.equal(c.run('routes'),0);assert.equal(c.run('mode'),'room');
});

test('旧登录的失败响应不会污染新登录表单',async()=>{
  const c=client(),button={disabled:false,isConnected:true};
  c.element('login-form').querySelector=()=>button;
  c.run(`login();var failLogin;api=()=>new Promise((resolve,reject)=>failLogin=reject);`);
  c.element('password').value='test-password';
  const pending=c.element('login-form').onsubmit({preventDefault(){},target:c.element('login-form')});
  c.run(`navigationEpoch++;mode='login';failLogin(new Error('old error'));`);await pending;
  assert.equal(c.element('login-error').textContent,'');
});

test('离开再回同桌，旧聊天响应不能覆盖新页面',async()=>{
  const c=client(),button={disabled:false,isConnected:true};
  c.element('chat-form').querySelector=()=>button;
  c.run(`roomShell();activeCode='ABCDEF';room={code:'ABCDEF',version:1};renderRoom=()=>{};var finishChat;api=()=>new Promise(resolve=>finishChat=resolve);`);
  c.element('chat-input').value='旧消息';
  const pending=c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  c.run(`navigationEpoch++;room={code:'ABCDEF',version:2};finishChat({code:'ABCDEF',version:3,serverTime:100});`);await pending;
  assert.equal(c.run('room.version'),2);
});

test('聊天登录失效立即返回登录并保留尚未发送的消息',async()=>{
  const c=client(),button={disabled:false,isConnected:true};
  c.element('chat-form').querySelector=()=>button;
  c.run(`roomShell();activeCode='ABCDEF';room={code:'ABCDEF',version:1};api=async()=>{throw Object.assign(new Error('请重新登录'),{status:401});};`);
  c.element('chat-input').value='稍后再发';
  await c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  assert.equal(c.run('mode'),'login');
  c.element('chat-input').value='';
  c.run(`activeCode='ABCDEF';roomShell();`);
  assert.equal(c.element('chat-input').value,'稍后再发');
  c.run(`activeCode='GHIJKL';roomShell();`);
  assert.equal(c.element('chat-input').value,'','草稿不能串到其他房间');
});

test('房间尚未加载时提交聊天不会抛错或丢掉输入',async()=>{
  const c=client(),button={disabled:false,isConnected:true};
  c.element('chat-form').querySelector=()=>button;
  c.run(`roomShell();room=null;var calls=0;api=async()=>{calls++;};`);
  c.element('chat-input').value='你好';
  await c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  assert.equal(c.run('calls'),0);assert.equal(c.element('chat-input').value,'你好');
});

test('旧聊天失败不弹出错误、不覆盖新页面正在编辑的消息',async()=>{
  const c=client(),button={disabled:false,isConnected:true};c.element('chat-form').querySelector=()=>button;
  c.run(`roomShell();activeCode='ABCDEF';room={code:'ABCDEF',version:1};var rejectChat;api=()=>new Promise((resolve,reject)=>rejectChat=reject);`);
  c.element('chat-input').value='旧消息';
  const pending=c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  c.run(`navigationEpoch++;mode='room';room={code:'ABCDEF',version:2};`);
  c.element('chat-input').value='新消息';c.run(`rejectChat(Object.assign(new Error('expired'),{status:401}));`);await pending;
  assert.equal(c.run('mode'),'room');assert.equal(c.element('chat-input').value,'新消息');assert.equal(c.element('toast').hidden,true);
});

test('聊天请求期间的新草稿不会被失败的旧消息替换',async()=>{
  const c=client(),button={disabled:false,isConnected:true};c.element('chat-form').querySelector=()=>button;
  c.run(`roomShell();activeCode='ABCDEF';room={code:'ABCDEF',version:1};var rejectChat;api=()=>new Promise((resolve,reject)=>rejectChat=reject);`);
  c.element('chat-input').value='第一条';
  const pending=c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  c.element('chat-input').value='第二条';c.run(`rejectChat(new Error('offline'));`);await pending;
  assert.equal(c.element('chat-input').value,'第二条');assert.equal(button.disabled,false);
});

test('重新连接成功后回到原房间，并恢复实时连接',async()=>{
  const c=client();c.context.location.search='?room=ABCDEF';
  c.element('chat-form').querySelector=()=>({disabled:true});
  c.run(`connectionError();var connected='',calls=[];api=async url=>{calls.push(url);return url==='/me'?{ok:true}:{code:'ABCDEF',version:1,serverTime:1,you:'me'};};renderRoom=()=>{};connect=code=>{connected=code;};`);
  await c.run('route()');
  assert.equal(c.run('mode'),'room');assert.equal(c.run('connected'),'ABCDEF');
  assert.deepEqual(Array.from(c.run('calls')),['/me','/rooms/ABCDEF']);assert.equal(c.element('chat-input').disabled,false);
});

test('未加载完成的房间不能生成空邀请链接',()=>{
  const c=client();c.run(`mode='room';room=null;share();`);
  assert.equal(c.element('dialog').open,false);
});


test('切换到牌桌和登录页时回到顶部并把键盘焦点移入主要内容',()=>{
  const c=client(),positions=[];let focused=0;c.element('app').focus=()=>focused++;c.context.window.scrollTo=p=>positions.push(p.top);
  c.run('roomShell();login();');
  assert.equal(focused,2);assert.deepEqual(positions,[0,0]);
});

test('显示密码可来回切换，登录提交按钮保持独立',async()=>{
  const c=client(),submit={disabled:false,isConnected:true};
  c.element('login-form').querySelector=selector=>{assert.equal(selector,'button[type=submit]');return submit;};
  c.run('login();');c.element('password').type='password';
  c.element('password-toggle').onclick();assert.equal(c.element('password').type,'text');assert.equal(c.element('password-toggle')['aria-pressed'],'true');
  c.element('password-toggle').onclick();assert.equal(c.element('password').type,'password');
  c.run('api=async()=>({ok:true});route=async()=>{};');
  await c.element('login-form').onsubmit({preventDefault(){},target:c.element('login-form')});
  assert.equal(submit.disabled,false);
});

test('操作返回登录过期时立即退出牌桌，不等待正在进行的轮询',async()=>{
  const c=client();c.run("mode='room';activeCode='ABCDEF';room={code:'ABCDEF',version:1};roomLoad=navigationEpoch;renderActions=()=>{};api=async()=>{throw Object.assign(new Error('登录到期'),{status:401});};");
  await c.run("mutate('action',{action:{type:'fold'}})");
  assert.equal(c.run('mode'),'login');assert.equal(c.run('room'),null);
});

for(const variant of ['raise','compare'])test(variant+' 使用全部积分必须先明确确认全押',()=>{
  const c=client();c.run("mode='room';activeCode='ABCDEF';room={code:'ABCDEF',version:1,you:'me',game:{phase:'betting',current:'me',players:[{id:'me',chips:20}]},legal:[{type:'bet',kind:'raise_allin',amount:20,stake:40},{type:'compare',target:'other',targetName:'好友',cost:20}]};var choice,confirm,played=0,choiceLabel='';choices=(title,actions,label,fn)=>{choiceLabel=label(actions[0]);choice=()=>fn(actions[0]);};confirmAction=(title,description,fn)=>{confirm=fn;};mutate=()=>played++;renderActions();");
  c.element(variant).onclick();assert.match(c.run('choiceLabel'),/全押/);c.run('choice()');assert.equal(c.run('played'),0);c.run('confirm()');assert.equal(c.run('played'),1);
});

test('读取旧牌局动态时，轮询与新动态不会把阅读位置拉到底部',()=>{
  const c=client(),logs=c.element('log-feed');logs.scrollTop=10;logs.scrollHeight=500;logs.clientHeight=100;
  c.run("room={code:'ABCDEF',name:'测试桌',seats:[],capacity:2,rules:{start_chips:1000,base_bet:10},turnSeconds:60,chat:[],game:{phase:'betting',round:1,rules:{base_bet:10},players:[],log:[{text:'新动态'}],rounds:[]}};renderActions=()=>{};renderRoom();");
  assert.equal(logs.scrollTop,10);
  c.run('renderRoom()');assert.equal(logs.scrollTop,10);
});
