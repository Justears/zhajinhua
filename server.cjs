'use strict';
// Original application server. The game engine is adapted from 29-Cu/bisca.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const engine = require('./engines/zjh.cjs');
const token = () => crypto.randomBytes(24).toString('hex');
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const bounded = (v, min, max, fallback) => { const n = v === undefined ? fallback : Number(v); if (!Number.isSafeInteger(n) || n < min || n > max) fail(`请输入 ${min}–${max} 之间的整数`); return n; };
const clean = (v, max = 24) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
function listenOptions(env = process.env) {
  const host = env.BIND_ADDRESS || '0.0.0.0', port = Number(env.PORT || 8080);
  if (!net.isIP(host)) throw new Error('BIND_ADDRESS 必须是有效 IP 地址');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数');
  return {host,port};
}
function atomic(file, value) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function createServer(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, {recursive: true});
  const password = options.password || process.env.ROOM_PASSWORD;
  if (typeof password !== 'string' || password.length < 8) throw new Error('请设置至少 8 位的 ROOM_PASSWORD 入场密码');
  const cfgFile = path.join(dataDir, 'config.json');
  const config = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {secret: token()};
  if (!config.secret) throw new Error('config.json 无效，请从备份恢复');
  // Rotating the entry password revokes access, while a correct new login can
  // still recover the seat identified by an authentic older cookie.
  const fingerprint = crypto.createHmac('sha256', config.secret).update(password).digest('hex');
  if (config.passwordFingerprint !== fingerprint || !config.authEpoch) {
    config.passwordFingerprint = fingerprint;
    config.authEpoch = token();
    atomic(cfgFile, config);
  }
  const rooms = new Map(), streams = new Set(), limits = new Map(), seen = new Map();
  const now = options.now || Date.now;
  const startedAt = now();
  const presenceKey = (code, id) => `${code}:${id}`;
  const touch = (r, id) => seen.set(presenceKey(r.code,id),now());
  const hostAwayFor = r => Math.max(0,now()-(seen.get(presenceKey(r.code,r.host)) ?? startedAt));
  const secureCookie = options.secureCookie ?? process.env.COOKIE_SECURE === 'true';
  const originSetting = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  let publicOrigin = '';
  if (originSetting) {
    let parsed; try { parsed = new URL(originSetting); } catch { throw new Error('PUBLIC_ORIGIN 必须是完整的网站地址'); }
    if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('PUBLIC_ORIGIN 只填写协议、域名和端口，不包含路径');
    publicOrigin = parsed.origin;
  }
  const sign = s => crypto.createHmac('sha256', config.secret).update(s).digest('hex');
  const safeEq = (a, b) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); };
  const fileFor = code => path.join(dataDir, `room-${code}.json`);
  for (const f of fs.readdirSync(dataDir).filter(f => /^room-[A-Z0-9]{6}\.json$/.test(f))) {
    // A corrupt file stops startup rather than silently erasing a saved table.
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    if (!r.code || !Array.isArray(r.seats) || !r.rules) throw new Error(`房间存档无效：${f}`);
    if (r.game?.phase === 'betting') { r.deadline = now() + r.turnSeconds * 1000; r.version++; atomic(fileFor(r.code), r); }
    r.actionVersion ??= r.version;
    rooms.set(r.code, r);
  }
  function session(req, recoverSeat = false) {
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('jinhua_session='));
    if (!cookie) return null;
    const parts = cookie.slice(15).split('.');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const [id, expires] = parts, epoch = parts.length === 4 ? parts[2] : null;
    if (!/^[a-f0-9]{48}$/.test(id || '') || !/^\d+$/.test(expires || '') || !Number.isSafeInteger(Number(expires)) || Number(expires) <= now()) return null;
    if (epoch !== null && !/^[a-f0-9]{48}$/.test(epoch)) return null;
    if (!safeEq(sign(parts.slice(0,-1).join('.')), parts.at(-1) || '')) return null;
    if (!recoverSeat && epoch !== config.authEpoch) return null;
    return {id, expires:Number(expires)};
  }
  function json(res, status, body, extra = {}) {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra}); res.end(JSON.stringify(body));
  }
  function rate(key, max, period = 60000) {
    let l = limits.get(key);
    if (!l || l.until <= now()) { l = {count: 0, until: now() + period}; limits.set(key, l); }
    if (++l.count > max) fail('操作太频繁，请稍后再试', 429);
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) fail('请求必须是 JSON', 415);
    const parts = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > 8192) fail('请求内容太大', 413); parts.push(part); }
    const str = Buffer.concat(parts).toString('utf8');
    let value; try { value = JSON.parse(str || '{}'); } catch { fail('请求格式不正确'); }
    if (!value || Array.isArray(value) || typeof value !== 'object') fail('请求格式不正确');
    return value;
  }
  const ownSeat = (r, id) => r.seats.find(s => s.owner === id);
  function summary(r, id) {
    return {code: r.code, name: r.name, count: r.seats.length, capacity: r.capacity, phase: r.game?.phase || 'waiting', mine: !!ownSeat(r,id), round: r.game?.round || 0};
  }
  function payload(r, id) {
    const me = ownSeat(r, id);
    if (!me) fail('你还没有加入这个房间', 403);
    return {
      code: r.code, name: r.name, version: r.version, actionVersion: r.actionVersion ?? r.version, capacity: r.capacity, rules: r.rules,
      turnSeconds: r.turnSeconds, deadline: r.deadline, serverTime: now(), you: me.id, isHost: r.host === id, canClaimHost: r.host !== id && hostAwayFor(r) >= 120000,
      seats: r.seats.map(s => ({id: s.id, name: s.name, isHost: s.owner === r.host, online: now() - (seen.get(presenceKey(r.code,s.owner)) ?? -Infinity) < 35000})),
      game: r.game ? engine.viewFor(r.game, me.id) : null,
      legal: r.game ? engine.legalMoves(r.game, me.id).filter(m => m.type !== 'next_round' || r.host === id) : [],
      chat: r.chat.slice(-60)
    };
  }
  function broadcast(code) {
    for (const s of streams) if (s.code === code) {
      try {
        if (expireStream(s)) continue;
        const r = rooms.get(code);
        if (!r || !ownSeat(r,s.id)) { s.res.write('event: closed\ndata: {}\n\n'); s.res.end(); streams.delete(s); }
        else if (!s.res.write(`data: ${JSON.stringify(payload(r,s.id))}\n\n`)) { s.res.end(); streams.delete(s); }
      } catch { s.res.end(); streams.delete(s); }
    }
  }
  function expireStream(s) {
    if (s.expires > now()) return false;
    s.res.end('event: auth-expired\ndata: {}\n\n'); streams.delete(s); return true;
  }
  function commit(r, gameplay = true) {
    r.actionVersion = (r.actionVersion ?? r.version) + (gameplay ? 1 : 0);
    r.version++;
    r.updatedAt = now();
    if (r.game) { r.game.log = r.game.log.slice(-300); r.game.rounds = r.game.rounds.slice(-50); }
    atomic(fileFor(r.code), r); rooms.set(r.code,r); broadcast(r.code);
  }
  function setDeadline(r, previous, action) {
    if (r.game?.phase !== 'betting') r.deadline = null;
    else if (!previous || previous.current !== r.game.current || action?.type !== 'look') r.deadline = now() + r.turnSeconds * 1000;
  }
  function tick() {
    for (const old of rooms.values()) if (old.game?.phase === 'betting' && old.deadline <= now()) {
      try {
        const r = structuredClone(old);
        const player = r.game.players.find(p => p.id === r.game.current);
        r.game = engine.apply(r.game, player.id, {type:'fold'}).state;
        r.chat.push({id: token(), name:'系统', text:`${player.name} 操作超时，自动弃牌`, time:now()}); r.chat = r.chat.slice(-60);
        setDeadline(r, old.game, {type:'fold'}); commit(r);
      } catch(e) { console.error('保存超时操作失败：',e.message); }
    }
    for (const [k,l] of limits) if (l.until < now()) limits.delete(k);
    for (const [k,t] of seen) if (t + 86400000 < now()) seen.delete(k);
  }
  const timer = setInterval(tick,1000); timer.unref();
  const heartbeat = setInterval(() => {
    for (const s of streams) {
      // Sending a heartbeat is not evidence that the browser is still active.
      if (expireStream(s)) continue;
      if (s.res.destroyed || !s.res.write(': heartbeat\n\n')) { s.res.end(); streams.delete(s); }
    }
  },15000); heartbeat.unref();
  const staticFiles = {'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
  const server = http.createServer(async(req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url,'http://localhost');
      if (req.method === 'GET' && Object.hasOwn(staticFiles,url.pathname)) {
        const f = staticFiles[url.pathname], ext = path.extname(f);
        const content = fs.readFileSync(path.join(__dirname,'public',f));
        res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[ext]+'; charset=utf-8','Cache-Control':'no-cache'}); res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') { json(res,200,{ok:true,version:require('./package.json').version}); return; }
      if (!url.pathname.startsWith('/api/')) fail('页面不存在',404);
      if (publicOrigin && req.headers.host !== new URL(publicOrigin).host) fail('请使用已配置的游戏网址访问',403);
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin) {
          let parsed; try { parsed = new URL(origin); } catch { fail('请在同一个网站内操作',403); }
          const expected = publicOrigin || `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
          if (parsed.origin !== expected || origin !== parsed.origin) fail('请在同一个网站内操作',403);
        }
        if (req.headers['sec-fetch-site'] === 'cross-site') fail('请在同一个网站内操作',403);
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        rate('login:' + req.socket.remoteAddress, 30, 300000);
        const b = await body(req);
        if (!safeEq(String(b.password || ''),password)) fail('入场密码不正确',401);
        const id = session(req,true)?.id || token(), exp = String(now() + 90*86400000);
        const unsigned = `${id}.${exp}.${config.authEpoch}`, value = `${unsigned}.${sign(unsigned)}`;
        json(res,200,{ok:true},{'Set-Cookie':`jinhua_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${secureCookie ? '; Secure' : ''}`}); return;
      }
      const auth = session(req); if (!auth) fail('请重新输入入场密码',401); const id=auth.id;
      if (url.pathname === '/api/me' && req.method === 'GET') { json(res,200,{ok:true}); return; }
      if (url.pathname === '/api/rooms' && req.method === 'GET') { json(res,200,{rooms:[...rooms.values()].map(r=>summary(r,id)).sort((a,b)=>Number(b.mine)-Number(a.mine))}); return; }
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        rate('create:'+id,10);
        const b = await body(req);
        if (rooms.size >= 100) fail('房间已满，请先关闭不用的房间');
        if ([...rooms.values()].filter(r=>r.host===id).length >= 10) fail('你最多同时创建 10 个房间');
        const name = clean(b.nickname); if(!name) fail('请填写昵称');
        const rules = {blind_play: b.blind !== false,special_235: b.special235 === true,base_bet:bounded(b.ante,2,100,10),start_chips:bounded(b.chips,100,100000,1000)};
        if (rules.base_bet % 2) fail('底注请用偶数，方便闷牌半价计算');
        if (rules.start_chips <= rules.base_bet) fail('初始积分必须大于底注，才能在发牌后继续操作');
        rules.max_bet = rules.base_bet * 10;
        let code; do { code = Array.from({length:6},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''); } while(rooms.has(code));
        const r = {code,name:clean(b.name,32)||`${name}的牌桌`,host:id,seats:[{id:token(),owner:id,name}],capacity:bounded(b.capacity,2,8,8),rules,turnSeconds:bounded(b.turnSeconds,20,180,60),game:null,chat:[],version:0,deadline:null,createdAt:now(),receipts:[]};
        touch(r,id); commit(r); json(res,201,payload(r,id)); return;
      }
      const match = /^\/api\/rooms\/([A-Z0-9]{6})(?:\/(events|join|action|start|chat|leave|reset|close|kick|claim-host))?$/.exec(url.pathname);
      if (!match) fail('接口不存在',404);
      const code = match[1], op = match[2];
      let old = rooms.get(code); if(!old) fail('房间不存在或已经关闭',404);
      if (ownSeat(old,id)) touch(old,id);
      if (req.method === 'GET' && !op) { json(res,200,payload(old,id)); return; }
      if (req.method === 'GET' && op === 'events') {
        payload(old,id);
        if ([...streams].filter(s=>s.id===id).length >= 8 || streams.size>=500) fail('打开的牌桌太多，请关闭多余页面',429);
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write(`data: ${JSON.stringify(payload(old,id))}\n\n`);
        const stream={id,code,res,expires:auth.expires}; streams.add(stream); res.on('close',()=>streams.delete(stream)); return;
      }
      if (req.method !== 'POST') fail('不支持此操作',405);
      rate('mutate:'+id,180);
      const b = await body(req);
      // Re-read after awaiting request bytes; no await is allowed inside a mutation.
      old = rooms.get(code); if(!old) fail('房间已经关闭',404);
      // Deadline is authoritative even between the one-second timer ticks.
      if (op === 'action' && old.game?.phase === 'betting' && old.deadline <= now()) { tick(); old = rooms.get(code); }
      if (op==='join' && ownSeat(old,id)) {json(res,200,payload(old,id));return;}
      const r = structuredClone(old);
      if (op === 'join') {
        if (r.game) fail('牌局已开始，请等房主返回候场后再加入',409);
        if (r.seats.length >= r.capacity) fail('这个房间已坐满',409);
        const name=clean(b.nickname); if(!name) fail('请填写昵称');
        if(r.seats.some(s=>s.name===name)) fail('这个昵称已经有人用了');
        r.seats.push({id:token(),owner:id,name}); touch(r,id); commit(r); json(res,200,payload(r,id)); return;
      }
      const me = ownSeat(r,id); if(!me) fail('你还没有入座',403);
      if (['start','reset','close','kick'].includes(op) && r.host!==id) fail('只有房主可以操作',403);
      if (op === 'chat') {
        rate('chat:'+id,20); const text=clean(b.text,200); if(!text) fail('消息不能为空');
        r.chat.push({id:token(),name:me.name,text,time:now()});r.chat=r.chat.slice(-60);commit(r,false);json(res,200,payload(r,id));return;
      }
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(b.requestId||'')) fail('缺少操作编号，请刷新页面');
      if(r.receipts.some(x=>x.id===b.requestId&&x.owner===id)) {json(res,200,payload(r,id));return;}
      if (b.actionVersion !== undefined ? b.actionVersion !== (r.actionVersion ?? r.version) : b.version !== r.version) fail('牌局已经变化，请确认最新画面后重试',409);
      if (op === 'close') { fs.unlinkSync(fileFor(code));rooms.delete(code);broadcast(code);json(res,200,{closed:true});return; }
      if (op === 'leave' || op === 'kick') {
        if(r.game) fail('请先让房主返回候场再调整座位');
        const target = op==='leave' ? me.id : b.playerId;
        if(op==='kick'&&target===me.id) fail('请使用离开房间');
        if(!r.seats.some(s=>s.id===target)) fail('座位不存在');
        r.seats=r.seats.filter(s=>s.id!==target);
        if(!r.seats.length) { fs.unlinkSync(fileFor(code));rooms.delete(code);broadcast(code);json(res,200,{left:true});return; }
        if(r.host===id && op==='leave') r.host=r.seats[0].owner;
      } else if (op === 'claim-host') {
        if (r.host === id) fail('你已经是房主');
        if (hostAwayFor(r) < 120000) fail('房主仍在线，或离线尚未满 2 分钟',409);
        r.host=id;
        r.chat.push({id:token(),name:'系统',text:me.name+' 接任房主',time:now()});r.chat=r.chat.slice(-60);
      } else if (op === 'reset') {
        if(r.game?.phase==='betting') fail('这一局尚未结束，请打完再返回候场');
        r.game=null;r.deadline=null;
      } else if(op === 'start') {
        if(r.game) fail('已经开局了');
        r.game=engine.createGame({players:r.seats.map(s=>({id:s.id,name:s.name})),rules:r.rules,secureRandom:true});setDeadline(r,null);
      } else if(op === 'action') {
        if(!r.game) fail('还没有开局');
        const action=b.action;
        if(!action || !['look','bet','fold','compare','next_round'].includes(action.type)) fail('不支持的游戏动作');
        if(action.type==='next_round'&&r.host!==id) fail('请等待房主开始下一局',403);
        r.game=engine.apply(r.game,me.id,action).state;setDeadline(r,old.game,action);
      } else fail('操作不存在',404);
      r.receipts.push({id:b.requestId,owner:id});r.receipts=r.receipts.slice(-100);commit(r);
      json(res,200,op==='leave'?{left:true}:payload(r,id));
    } catch(e) {
      if(res.headersSent){res.end();return;}
      if(!e.status && /EACCES|ENOSPC|EROFS|EPERM/.test(e.code||'')) {console.error(e);json(res,500,{error:'数据保存失败，请检查群晖目录权限和剩余空间'});}
      else json(res,e.status||400,{error:e.message||'操作失败'});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=16000;
  function shutdown(){clearInterval(timer);clearInterval(heartbeat);for(const s of streams)s.res.end();streams.clear();return new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});}
  return {server,shutdown,tick,rooms};
}
module.exports={createServer,listenOptions};
if(require.main===module){
  const {host,port}=listenOptions(),app=createServer();
  app.server.listen(port,host,()=>console.log(`后周炸炸炸已启动：http://${host.includes(':')?'['+host+']':host}:${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.shutdown().then(()=>process.exit(0)));
}
