'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'release-artifacts');
const version=require('../package.json').version;
assert.match(version,/^\d+\.\d+\.\d+$/);
const archiveName=`houzhou-zhazhazha-v${version}-amd64.zip`;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(process.argv.includes('--verify-upload')){
  const release=JSON.parse(fs.readFileSync(path.join(out,'uploaded-release.json'),'utf8'));
  assert.equal(release.tag_name,`v${version}`);assert.equal(release.draft,true);
  for(const name of [archiveName,'SHA256SUMS.txt']){
    const asset=release.assets.find(a=>a.name===name),bytes=fs.readFileSync(path.join(out,name));
    assert.ok(asset,`Missing asset: ${name}`);assert.equal(asset.state,'uploaded');assert.equal(asset.size,bytes.length);
    assert.equal(asset.digest,'sha256:'+sha(bytes),`Uploaded asset digest: ${name}`);
  }
  console.log('Release asset sizes and SHA256 digests verified');
}else{
  const sources=['.dockerignore','.env.example','.gitignore','Dockerfile','docker-compose.yml','docker-compose.online.yml','docker-compose.proxy.yml','package.json','server.cjs','README.md','SECURITY.md','LICENSE-BISCA.txt','THIRD_PARTY_NOTICES.md','验证记录.md'];
  function list(sub){for(const entry of fs.readdirSync(path.join(root,sub),{withFileTypes:true})){const rel=sub+'/'+entry.name;if(entry.isDirectory())list(rel);else sources.push(rel);}}
  for(const sub of ['engines','public','test','scripts','.github'])list(sub);
  const entries=sources.map(rel=>['jinhua/'+rel,fs.readFileSync(path.join(root,rel))]);
  entries.push(['jinhua/data/.keep',Buffer.alloc(0)]);
  const image=fs.readFileSync(path.join(out,'jinhua-amd64.tar'));
  const imageChecksum=sha(image)+'  jinhua-amd64.tar\n';
  entries.push(['jinhua/jinhua-amd64.tar',image],['jinhua/SHA256SUMS.txt',Buffer.from(imageChecksum)]);
  const runURL=`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  entries.push(['jinhua/发布验证.md',Buffer.from(`# v${version} 发布验证\n\n发布提交：${process.env.GITHUB_SHA}\n\n${runURL}\n\n该安装包由 GitHub Actions 构建。发布前已执行完整测试，以及只读文件系统、移除 Linux capabilities、限制内存与进程数条件下的 Docker 启动、健康检查及登录检查。此验证发生在 Linux CI 主机上，不代表群晖实机安装已验证。镜像 SHA256 见包内 SHA256SUMS.txt。\n`)]);
  const crcTable=Array.from({length:256},(_,i)=>{for(let k=0;k<8;k++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
  const crc32=bytes=>{let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;};
  const local=[],central=[];let offset=0;
  for(const [name,bytes] of entries.sort((a,b)=>a[0].localeCompare(b[0]))){
    assert.ok(!/\/\.env$|room-[A-Z0-9]{6}\.json$|\/config\.json$/.test(name));
    const n=Buffer.from(name),packed=zlib.deflateRawSync(bytes,{level:6}),crc=crc32(bytes),h=Buffer.alloc(30),c=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(33,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(packed.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(33,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(h,n,packed);central.push(c,n);offset+=h.length+n.length+packed.length;
    assert.deepEqual(zlib.inflateRawSync(packed),bytes);
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  const archive=Buffer.concat([...local,directory,end]);fs.writeFileSync(path.join(out,archiveName),archive);
  fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),sha(archive)+'  '+archiveName+'\n');
  fs.writeFileSync(path.join(out,'release-notes.md'),"下载附件 **houzhou-zhazhazha-vRELEASE_VERSION-amd64.zip**，适用于群晖 DS923+ 的 Container Manager，包含 AMD64 离线镜像、源码、配置与说明。\n\n- 自动刷新时保持按钮和键盘焦点，减少操作中断。\n- 邀请复制在弹窗内显示反馈，支持手动复制，避免重复请求及迟到提示。\n- 聊天超时后手动重试可防重复，服务重启后回执仍有效；失败存档不会吞掉后续补发。\n- 修复连续对局日志编号重复或倒退。\n- 98 项自动测试通过，含 8 人 500 局检查。\n\n完整测试、Linux Docker 启动、健康检查和登录验证通过：[查看发布验证](RELEASE_RUN_URL)。本轮前端状态采用模拟 DOM 检查，尚未重新执行浏览器渲染、真实手机或群晖实机测试。\n\n升级前备份并保留 data 和 .env，结束正在进行的牌局，保持原端口，导入 jinhua-friends:RELEASE_VERSION 后重新创建容器。v1.2.2 存档无需手工迁移。聊天重试记录只在当前标签页保留；服务端保留每桌最近 100 条带编号消息的回执，不自动重发消息。\n\n使用本 Release 的 SHA256SUMS.txt 校验 ZIP；镜像校验值在 ZIP 内。\n".replaceAll('RELEASE_VERSION',version).replaceAll('RELEASE_RUN_URL',runURL));
  console.log(JSON.stringify({archive:archiveName,files:entries.length,bytes:archive.length,sha256:sha(archive)}));
}
