#!/usr/bin/env node
/* 生成软著登记用的「源程序文档」：前 30 页 + 后 30 页，每页 50 行，页眉含软件名/版本/页码。
   用法：node scripts/gen-softreg-source.js [版本号]
   输出：softreg/源程序-DiskLens盘析软件V{版本}.txt（softreg/ 已 gitignore，仅本地留存）
   中国版权保护中心要求：源程序总量不足 60 页全部提交；超过则前后各连续 30 页。 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const version = process.argv[2] || JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
const NAME = 'DiskLens盘析软件';

// 参与登记的源码文件（按阅读顺序拼接；排除测试/CI/构建配置）
const FILES = [
  'src-tauri/src/lib.rs',
  'src-tauri/src/main.rs',
  'src/main.js',
  'src/treemap.js',
  'src/listview.js',
  'src/migrate.js',
  'src/aiassist.js',
  'src/update.js',
  'src/index.html',
  'src/styles.css',
];

const LINES_PER_PAGE = 50;
const PAGES = 60; // 前 30 + 后 30

let body = '';
for (const f of FILES) {
  let text = readFileSync(f, 'utf8');
  if (!text.endsWith('\n')) text += '\n';
  body += `// ==================== ${f} ====================\n` + text;
}
const allLines = body.split('\n');
// 去掉末尾空行
while (allLines.length && allLines[allLines.length - 1].trim() === '') allLines.pop();

const totalPages = Math.ceil(allLines.length / LINES_PER_PAGE);
if (totalPages <= PAGES) {
  console.error(`源程序共 ${totalPages} 页（不足 ${PAGES} 页）：应全部提交，请调整逻辑后重跑`);
  process.exit(1);
}

const pick = [];
for (let p = 0; p < 30; p++) pick.push(allLines.slice(p * LINES_PER_PAGE, (p + 1) * LINES_PER_PAGE));
for (let p = totalPages - 30; p < totalPages; p++) pick.push(allLines.slice(p * LINES_PER_PAGE, (p + 1) * LINES_PER_PAGE));

let out = '';
let pageNo = 0;
for (const page of pick) {
  pageNo++;
  const header = `${NAME} V${version}    第 ${pageNo} 页 共 ${pick.length} 页`;
  out += header + '\n' + '-'.repeat(66) + '\n';
  // 每页正文补齐 50 行（不足的页用空行占位，页脚随正文走）
  for (let i = 0; i < LINES_PER_PAGE; i++) out += (page[i] ?? '') + '\n';
}

mkdirSync('softreg', { recursive: true });
const file = `softreg/源程序-${NAME}V${version}.txt`;
writeFileSync(file, out, 'utf8');
console.log(`已生成 ${file}`);
console.log(`源程序总量 ${totalPages} 页；提交 前30页+后30页=${pick.length} 页，每页 ${LINES_PER_PAGE} 行`);
