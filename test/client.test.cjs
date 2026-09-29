'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function client() {
  const elements=new Map();
  function element(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:true,open:false,isConnected:true,className:'',focus(){},contains(){return false;},setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];},querySelector(){return null;},close(){this.open=false;},showModal(){this.open=true;},querySelectorAll(){return[];}});return elements.get(id);}
  const context=vm.createContext({document:{getElementById:element,addEventListener(){},hidden:false,title:''},window:{addEventListener(){},scrollTo(){}},location:{search:'',origin:'https://game.example'},history:{pushState(){}},localStorage:{getItem(){return'';},setItem(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},URLSearchParams,AbortController,Date,console});
  // Unit-test the navigation controller without starting its automatic request.
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8').replace(/route\(\);\s*$/,'');
  vm.runInContext(source,context);
  return {context,element,run:code=>vm.runInContext(code,context)};
}
for(const failure of [undefined,500,401])test(`聊天 ${failure||'网络中断'} 后手动重试复用编号，成功后再发相同文本使用新编号`,async()=>{
  const c=client(),button={disabled:false,isConnected:true};c.element('chat-form').querySelector=()=>button;
  c.run("roomShell();activeCode='ABCDEF';room={code:'ABCDEF',version:1};renderRoom=()=>{};var sent=[];api=async(url,data)=>{sent.push({...data});if(sent.length===1)throw Object.assign(new Error('发送失败'),{status:"+JSON.stringify(failure)+"});return {code:'ABCDEF',version:sent.length,serverTime:Date.now(),you:'me'};};");
  c.element('chat-input').value='同一句招呼';
  const submit=()=>c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  await submit();
  if(failure===401)c.run("activeCode='ABCDEF';roomShell();room={code:'ABCDEF',version:1};");
  assert.equal(c.element('chat-input').value,'同一句招呼');
  await submit();
  c.element('chat-input').value='同一句招呼';await submit();
  const ids=Array.from(c.run('sent.map(message=>message.requestId)'));
  assert.match(ids[0]||'',/^[a-zA-Z0-9_-]{8,100}$/);
  assert.equal(ids[1],ids[0],'人工重试未确认的消息应复用编号');
  assert.notEqual(ids[2],ids[1],'已成功后再次发送相同内容应成为新消息');
});

test('同一句聊天在不同牌桌使用不同编号，返回原桌仍可重试原消息',async()=>{
  const c=client(),button={disabled:false,isConnected:true};c.element('chat-form').querySelector=()=>button;
  c.run("roomShell();activeCode='ABCDEF';room={code:'ABCDEF',version:1};renderRoom=()=>{};var sent=[];api=async(url,data)=>{sent.push({url,...data});if(sent.length===1)throw new Error('网络中断');return {code:url.split('/')[2],version:sent.length,serverTime:Date.now(),you:'me'};};");
  const submit=()=>c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  c.element('chat-input').value='你好';await submit();
  c.run("stop();activeCode='GHIJKL';roomShell();room={code:'GHIJKL',version:1};");
  c.element('chat-input').value='你好';await submit();
  c.run("stop();activeCode='ABCDEF';roomShell();room={code:'ABCDEF',version:1};");
  await submit();
  const ids=Array.from(c.run('sent.map(message=>message.requestId)'));
  assert.match(ids[0]||'',/^[a-zA-Z0-9_-]{8,100}$/);
  assert.notEqual(ids[1],ids[0]);assert.equal(ids[2],ids[0]);
});

test('失败后改写聊天内容不会复用旧消息的编号',async()=>{
  const c=client(),button={disabled:false,isConnected:true};c.element('chat-form').querySelector=()=>button;
  c.run("roomShell();activeCode='ABCDEF';room={code:'ABCDEF',version:1};renderRoom=()=>{};var sent=[];api=async(url,data)=>{sent.push({...data});if(sent.length===1)throw new Error('网络中断');return {code:'ABCDEF',version:2,serverTime:Date.now(),you:'me'};};");
  const submit=()=>c.element('chat-form').onsubmit({preventDefault(){},target:c.element('chat-form')});
  c.element('chat-input').value='原消息';await submit();c.element('chat-input').value='修改过的消息';await submit();
  const ids=Array.from(c.run('sent.map(message=>message.requestId)'));
  assert.match(ids[0]||'',/^[a-zA-Z0-9_-]{8,100}$/);assert.notEqual(ids[1],ids[0]);
});

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

test('大厅轮询相同座位状态时保留房间按钮，避免中断键盘选择',async()=>{
  const c=client(),list=c.element('room-list');let replacements=0,html='';
  Object.defineProperty(list,'innerHTML',{get(){return html;},set(value){replacements++;html=value.replace(/ disabled /g,' disabled="" ');}});
  c.run("mode='lobby';api=async()=>({rooms:[{code:'ABCDEF',name:'朋友桌',mine:false,phase:'betting',count:2,capacity:2}]});");
  await c.run('loadRooms()');await c.run('loadRooms()');
  assert.equal(replacements,1,'原生浏览器会规范化 disabled 属性，不能因此反复重建按钮');
});

test('候场轮询不会重建开始发牌和移出按钮',()=>{
  const c=client(),replacements={};
  for(const id of ['seat-grid','table-center']){let html='';replacements[id]=0;Object.defineProperty(c.element(id),'innerHTML',{get(){return html;},set(value){replacements[id]++;html=value;}});}
  c.run("room={code:'ABCDEF',name:'朋友桌',you:'me',isHost:true,seats:[{id:'me',name:'房主',online:true},{id:'friend',name:'朋友',online:true}],capacity:2,rules:{start_chips:1000,base_bet:10},turnSeconds:60,chat:[],game:null};renderRoom();renderRoom();");
  assert.deepEqual(replacements,{'seat-grid':1,'table-center':1});
});

test('房间人数变化重绘列表后，键盘焦点仍留在原来选择的牌桌',async()=>{
  const c=client(),list=c.element('room-list'),oldButton={dataset:{code:'ABCDEF'}},newButton={dataset:{code:'ABCDEF'},focus(){c.context.document.activeElement=this;}};
  c.context.document.activeElement=oldButton;list.contains=element=>element===oldButton;
  list.querySelectorAll=()=>[newButton];
  Object.defineProperty(list,'innerHTML',{get(){return '';},set(){c.context.document.activeElement=null;}});
  c.run("mode='lobby';api=async()=>({rooms:[{code:'ABCDEF',name:'朋友桌',mine:true,phase:'waiting',count:3,capacity:8}]});");
  await c.run('loadRooms()');
  assert.equal(c.context.document.activeElement,newButton);
});

test('缓存操作按钮仍更新禁用状态和最新牌局版本',()=>{
  const c=client(),actions=c.element('actions'),call=c.element('call');let replacements=0,html='';
  actions.querySelectorAll=()=>[call];
  Object.defineProperty(actions,'innerHTML',{get(){return html;},set(value){replacements++;html=value;}});
  c.run("room={code:'ABCDEF',version:1,actionVersion:1,you:'me',game:{phase:'betting',current:'me',players:[{id:'me',chips:100}]},legal:[{type:'bet',kind:'call',amount:10}]};var submittedVersion;mutate=(op,data,expected)=>submittedVersion=expected;renderActions();busy=true;renderActions();");
  assert.equal(call.disabled,true);
  c.run('busy=false;room.actionVersion=2;renderActions();');
  assert.equal(call.disabled,false);call.onclick();
  assert.equal(c.run('submittedVersion'),2);assert.equal(replacements,1);
});

test('复制邀请的成功提示位于模态框内，读屏用户无需离开弹窗',async()=>{
  const c=client();c.context.navigator={clipboard:{async writeText(){}}};c.context.window.isSecureContext=true;
  c.element('share-url').select=()=>{};
  c.run("mode='room';activeCode='ABCDEF';room={code:'ABCDEF'};share();");
  await c.element('copy').onclick();
  assert.match(c.element('dialog-content').innerHTML,/id="share-status"[^>]*role="status"/);
  assert.equal(c.element('share-status').textContent,'邀请链接已复制');
  assert.equal(c.element('copy').textContent,'已复制');
});

test('复制邀请等待授权时不重复提交，关闭弹窗后不弹出迟到的失败提示',async()=>{
  const c=client();let requests=0;const rejections=[];
  c.context.navigator={clipboard:{writeText(){requests++;return new Promise((resolve,reject)=>{rejections.push(reject);});}}};c.context.window.isSecureContext=true;
  c.element('share-url').select=()=>{};
  c.run("mode='room';activeCode='ABCDEF';room={code:'ABCDEF'};share();");
  const pending=c.element('copy').onclick(),duplicate=c.element('copy').onclick();
  const count=requests;c.element('dialog').close();rejections.forEach(reject=>reject(new Error('denied')));await Promise.all([pending,duplicate]);
  assert.equal(count,1);
  assert.equal(c.element('toast').hidden,true);
  assert.equal(c.element('copy').disabled,false);
});

test('HTTP访问无法自动复制时，在邀请弹窗内提示手动复制且可重试',async()=>{
  const c=client();let selected=false;c.context.navigator={};c.context.window.isSecureContext=false;c.context.document.execCommand=()=>false;
  c.element('share-url').select=()=>{selected=true;};
  c.run("mode='room';activeCode='ABCDEF';room={code:'ABCDEF'};share();");
  await c.element('copy').onclick();
  assert.equal(selected,true);assert.equal(c.element('copy').disabled,false);
  assert.equal(c.element('share-status').textContent,'链接已选中，请长按或手动复制');
  assert.equal(c.element('toast').hidden,true);
});
