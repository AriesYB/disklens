#!/usr/bin/env node
/* 从签名构建产物生成 updater 清单 dist/latest.json。
   用法：签名构建完成后，在仓库根目录执行
     node scripts/gen-updater-manifest.mjs "本次更新说明（可省略）"
   然后把 dist/latest.json 同时上传到：
     1) 服务器 /usr/share/nginx/ikanp-home/downloads/disklens/latest.json（第一优先源）
     2) GitHub Release 附件（回退源，固定链接 releases/latest/download/latest.json）
   注意：signature 字段必须是 .sig 文件的内容本身，不能是路径或 URL。 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const notes = process.argv[2] || '';
const nsisDir = 'src-tauri/target/release/bundle/nsis';

const files = readdirSync(nsisDir);
const setup = files.find(f => f.endsWith('-setup.exe') && !f.endsWith('.sig') && f.includes(version));
if (!setup) {
  console.error(`未找到 v${version} 的安装包，请先带签名环境变量执行 npm run build`);
  process.exit(1);
}
const sig = readFileSync(join(nsisDir, setup + '.sig'), 'utf8').trim();
const url = `https://github.com/AriesYB/disklens/releases/download/v${version}/${encodeURIComponent(setup)}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature: sig, url }
  }
};
mkdirSync('dist', { recursive: true });
writeFileSync('dist/latest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`已生成 dist/latest.json（v${version}）`);
console.log('安装包下载地址: ' + url);
console.log('清单上传位置 1: ikanp.top:/usr/share/nginx/ikanp-home/downloads/disklens/latest.json');
console.log('清单上传位置 2: GitHub Release v' + version + ' 附件');
