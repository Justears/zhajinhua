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
  fs.writeFileSync(path.join(out,'release-notes.md'),`下载附件 **${archiveName}**，适用于群晖 DS923+ 的 Container Manager，含 AMD64 离线镜像、源码、配置与安装说明。\n\n- 修复上传请求期间登录到期后仍能修改存档的问题。\n- 修复登录和聊天的迟到响应干扰新页面的问题。\n- 断网时保留房间地址，重连回原桌；改善加载期间的邀请与聊天按钮。\n- 登录失效时保留当前标签页内的聊天草稿，不自动重发。\n\n完整测试、Linux Docker 启动、健康检查和登录验证通过：[查看发布验证](${runURL})。尚未在群晖或真实手机上完成本轮验证。\n\n升级前备份并保留 data 和 .env，保持原端口，导入 jinhua-friends:${version} 后重新创建容器。v1.2.0 升级不需要迁移存档。反向代理配置单独使用，详见 README 与 SECURITY.md。\n\n本安装包由 Docker 重新构建，与早先本地预备包的校验值不同；请使用本 Release 的 SHA256SUMS.txt 校验 ZIP，镜像校验值在 ZIP 内。\n`);
  console.log(JSON.stringify({archive:archiveName,files:entries.length,bytes:archive.length,sha256:sha(archive)}));
}
