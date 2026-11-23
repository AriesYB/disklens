/* DiskLens main —— Feed 抽象（Tauri 事件 / 浏览器 Mock）+ 视图调度 + 工具栏。
   全局状态（store/curPath/stack/divs/expanded…）由 treemap.js 声明，本文件只驱动。 */

var feed;
var dirty = false;
var IN_TAURI = !!window.__TAURI__;
var viewMode = 'treemap';
var fileIndex = new Map();   // lower(path) -> 文件节点（供大文件榜使用）
var scanning = false;
var scanPending = false;
var currentScanId = null;
var scanProgress = null;
var localScanning = false;
var localStopPending = false;
var scanT0 = 0;
var watchActive = false;     // 扫描完成后的实时监视（fs-batch 增量应用）
var watchChanges = 0;        // 本次监视会话累计收到的变更条数
var lastScanSecs = 0;        // 最近一次扫描耗时（秒），完成态 summary 展示
var BIG_FILE_MIN = 10 * 1024 * 1024;   // 与后端 MIN_BIG_FILE 一致：小于此值的文件扫描时不入树

/* ===== 诊断日志（问题反馈 / 异常追溯）：关键事件与报错进滚动日志 ===== */
var diagThrottle = 0;
function diagLog(level, msg){
  if (!IN_TAURI || !feed || !feed.appLog) return;
  var now = Date.now();
  if (level !== 'error' && now - diagThrottle < 500) return;   // 非 error 节流
  diagThrottle = now;
  try { feed.appLog(level, msg); } catch (e) {}
}

// ===== 双口径 / 差额透明化 =====
// s = 逻辑大小（size），al = 磁盘占用（簇对齐/云占位 0/硬链接副本计 0）
var deniedSeen = {};         // 无权限目录（会话级累计，展示时按范围过滤；同一目录去重）
var volUsed = 0;             // 当前根所在卷的已用空间（list_volumes 的 total-free；0=未知）
var volTotal = 0;            // 同上：卷总容量（0=未知）

// ===== 多盘齐扫：统一虚拟根模型 =====
// ROOTS = 本次扫描的盘根列表；单盘时 length===1，行为与旧单根完全一致。
// 多盘时引入虚拟根 THISPC（'\'，name「💻 所有磁盘」），children = 各盘根节点。
var ROOTS = [];              // 当前扫描根（如 ['C:\\','D:\\']）
var THISPC = '\\';           // 虚拟根路径（单字符反斜杠，不会与真实路径冲突）
function isMultiRoot(){ return ROOTS.length > 1; }
// 当前展示根的 store 键：多盘=虚拟根，单盘=盘根
function curRootKey(){ return isMultiRoot() ? THISPC.toLowerCase() : String(window.ROOT||'').toLowerCase(); }

// ===== 会话级多范围记忆 =====
// store 键按盘符前缀天然不冲突（'c:\…' vs 'd:\…'），扫过的范围数据留在内存里，
// 切换范围（盘符下拉）时直接展示该范围上次的结果，不自动清空、不自动扫描。
var scopeAt = {};            // scopeKey -> 该范围上次扫描完成时间（启动恢复缓存时也记录）
function scopeKey(roots){    // 范围标识：小写排序后拼接（'d:\' / 'c:\,d:\'）
  return roots.map(function(r){ return String(r).toLowerCase(); })
    .filter(Boolean).sort().join(',');
}
function curScopeKey(){
  return scopeKey(ROOTS.length ? ROOTS : [String(window.ROOT||'C:\\')]);
}
// 当前展示范围的口语名（空态/提示用）：多盘=「💻 所有磁盘」，单盘=盘根
function scopeLabel(){
  return isMultiRoot() ? '💻 所有磁盘' : String(window.ROOT||'');
}
// 路径是否属于当前展示范围：多盘=任一根前缀命中；单盘=该盘前缀
function inScope(p){
  return ROOTS.some(function(root){ return pathWithin(p, root); });
}
function pathWithin(path, root){
  var p = path.toLowerCase(), r = root.toLowerCase();
  return p===r || p.startsWith(r.endsWith('\\') ? r : r+'\\');
}
// 当前范围内的无权限目录数
function deniedInScope(){
  var n = 0;
  for(var k in deniedSeen){ if(inScope(k)) n++; }
  return n;
}
// 时长口语化（「切回上次结果」提示用）
function fmtAge(ms){
  var m = Math.round(ms/60000);
  if(m < 1) return '刚刚';
  if(m < 60) return m + ' 分钟';
  var h = Math.round(m/60);
  if(h < 24) return h + ' 小时';
  return Math.round(h/24) + ' 天';
}

// ===== 会话内存上限 =====
// 多范围记忆让 store/fileIndex 不再随新扫描清空——AI 连续扫多个盘时，
// 每个盘的目录树（几十万节点、数百 MB）会全部堆在 webview 里，内存一路
// 涨到全系统换页抖死（鼠标延迟、任务管理器都打不开）。策略：最多保留
// MAX_SCOPES 个范围（当前 + 最近使用），超出按路径前缀整体丢弃最旧范围。
var scopeOrder = [];        // 最近使用的 scopeKey（尾=最新）
var scopeRoots = {};        // scopeKey -> roots 数组
var MAX_SCOPES = 2;

// 把一组盘根的数据从 store/fileIndex/deniedSeen/expanded 里整体移除
function dropScopeData(roots, keep){
  diagLog('info', '逐出范围数据（内存上限）: ' + roots.join(','));
  var hit = function(p){
    return roots.some(function(root){ return pathWithin(p, root); }) &&
      !keep.some(function(root){ return pathWithin(p, root); });
  };
  var dead = [];
  store.forEach(function(n, k){ if(hit(n.p || k)) dead.push(k); });
  var parents = new Set();
  dead.forEach(function(k){
    var n = store.get(k);
    if(n) delete expanded[n.p];
    var p = parentPathOf(k);
    if(p) parents.add(p);
    store.delete(k);
    fileIndex.delete(k);
  });
  parents.forEach(function(key){
    var node = store.get(key);
    if(node) node.c = node.c.filter(function(child){ return store.has(child.p.toLowerCase()); });
  });
  var deadFiles = [];
  fileIndex.forEach(function(n, k){ if(hit(n.p || k)) deadFiles.push(k); });
  deadFiles.forEach(function(k){ fileIndex.delete(k); });
  for(var k in deniedSeen){ if(hit(k)) delete deniedSeen[k]; }
}

// 记录/刷新当前范围的使用顺序，并逐出超限的最旧范围。
// 扫描进行中只保留当前范围（maxOthers=0）：AI 连续扫不同盘时，上一盘的整棵树
// （几十万节点、数百 MB）不再在扫描期间驻留——扫描期内存峰值约减半，扫完
// 切回上一范围需重扫；空闲态维持 MAX_SCOPES 个范围供秒开切换
function rememberScope(){
  var key = curScopeKey();
  var i = scopeOrder.indexOf(key);
  if(i >= 0) scopeOrder.splice(i, 1);
  scopeOrder.push(key);
  scopeRoots[key] = ROOTS.slice();
  var maxOthers = scanning ? 0 : MAX_SCOPES - 1;
  while(true){
    var others = scopeOrder.filter(function(k){ return k !== key; });
    if(others.length <= maxOthers) break;
    var oldest = others[0];
    scopeOrder.splice(scopeOrder.indexOf(oldest), 1);
    var keep = scopeOrder.flatMap(function(k){ return scopeRoots[k]; });
    dropScopeData(scopeRoots[oldest] || [], keep);
    delete scopeRoots[oldest];
    delete scopeAt[oldest];
  }
}
// 合成根摘要对象（多盘时引擎不更新虚拟根，这里现场聚合各盘根）
function rootsSummary(){
  var s=0, al=0, done=true;
  for(var i=0;i<ROOTS.length;i++){
    var n = store.get(ROOTS[i].toLowerCase());
    if(!n) continue;
    s += n.s||0; al += alOf(n);
    if(!n.done) done = false;
  }
  return { s:s, al:al, done:done };
}
// 构建/刷新虚拟根节点：children = 各盘根节点（引用共享，引擎更新实时可见）
function ensurePcRoot(){
  if(!isMultiRoot()) return;
  var pc = store.get(THISPC.toLowerCase());
  if(!pc){
    pc = { n:'💻 所有磁盘', s:0, al:0, done:false, p:THISPC, f:false, c:[] };
    store.set(THISPC.toLowerCase(), pc);
  }
  pc.c = [];
  for(var i=0;i<ROOTS.length;i++){
    var rn = ensureChain(ROOTS[i]);
    if(!pc.c.includes(rn)) pc.c.push(rn);
  }
}
// 节点的磁盘占用兜底：老事件/模拟数据没有 al 时回退逻辑大小
function alOf(n) { return (n && n.al != null) ? n.al : (n ? n.s : 0); }

var VIEW_HINTS = {
  treemap: '单击展开/收起 · 双击进入 · 右键更多操作',
  list:    '双击进入目录 · 单击表头排序 · 右键更多操作',
  files:   '双击定位所在目录 · 「定位」在资源管理器中选中 · 顶部可按名称搜索（含目录）',
  types:   '单击类型行 → 查看该扩展名的全部大文件',
  diff:    '上次扫描 vs 本次：增长/新增最大的目录（重扫两次后可用）'
};

function markDirty(){ dirty = true; }

function ensureChain(path){
  var k = path.toLowerCase();
  var n = store.get(k);
  if(n) return n;
  var idx = path.lastIndexOf('\\');
  var parent = parentPathOf(path);
  var name = idx > 0 ? path.slice(idx+1) : path;
  if(!name) name = path;                                 // 盘根 'C:\' 的尾反斜杠让末段为空
  var pn = parent ? ensureChain(parent) : null;
  n = { n: name, s: 0, al: 0, done: false, p: path, f: false, c: [] };
  store.set(k, n);
  if(pn) pn.c.push(n);
  return n;
}
function applyEvent(ev){
  var n = ensureChain(ev.path);          // 自身 + 祖先链全部就位（事件乱序到达也健壮）
  if(ev.name) n.n = ev.name;             // 空名（盘根 growth 事件）不覆盖
  n.f = ev.file || n.f;
  var oldS = n.s || 0;
  var oldAl = alOf(n);
  n.s = ev.size;
  n.al = (ev.al != null) ? ev.al : ev.size;
  n.done = ev.done;
  n.summarized = !!ev.summarized;
  // 标记字段只置位不清除：done 事件晚于占位事件，不能回滚已知的受限/占位状态
  if(ev.dup) n.dup = true;
  if(ev.cloud) n.cloud = true;
  if(ev.denied){
    n.denied = true;
    deniedSeen[ev.path.toLowerCase()] = 1;
  }
  // 监视模式下优先扫描把体积带回来：差值沿祖先传播（子目录 done 只补差值，
  // 级联天然自洽）。扫描期间严禁传播——祖先体积由引擎统一结算
  // 汇总明细在父目录结算后补发，其体积已经计入祖先。
  if(!scanning && watchActive && !ev.summarized) propDelta(ev.path, (n.s||0) - oldS, n.al - oldAl);
  if(n.f) fileIndex.set(ev.path.toLowerCase(), n);   // 文件入索引，大文件榜用
  markDirty();
}

/* ===== 实时监视：扫描完成后 fs-batch 增量应用 ===== */
// 父路径解析：'C:\Users'→'C:\'，'C:\a\b'→'C:\a'，'C:\'→''（盘根即顶）。
// 注意 store 键不带尾反斜杠（盘根除外），切完不能再带
function parentPathOf(path) {
  var idx = path.lastIndexOf('\\');
  if (idx <= 0) return '';
  var p = path.slice(0, idx);
  if (p.length <= 3) p += '\\';   // 'C:' → 'C:\'
  return p === path ? '' : p;
}
// 体积差值沿祖先链传播（仅监视模式用；扫描时祖先体积由引擎统一结算，不能传播）。
// 逻辑大小与磁盘占用双口径同步传播
function propDelta(path, delta, deltaAl) {
  if (!delta && !deltaAl) return;
  var p = parentPathOf(path);
  while (p) {
    var pn = store.get(p.toLowerCase());
    if (!pn) break;
    if (delta) pn.s = Math.max(0, pn.s + delta);
    if (deltaAl) pn.al = Math.max(0, alOf(pn) + deltaAl);
    p = parentPathOf(p);
  }
}
// 删除节点及其整个子树（store/fileIndex/expanded），返回被删子树总体积
function removeSubtree(path) {
  var lower = path.toLowerCase();
  var n = store.get(lower);
  if (!n) return { s: 0, al: 0 };
  var total = n.s || 0;
  var totalAl = alOf(n);
  (function walk(x) {
    var kids = x.c || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
    store.delete(x.p.toLowerCase());
    if (x.f) fileIndex.delete(x.p.toLowerCase());
    delete expanded[x.p];
  })(n);
  store.delete(lower);
  fileIndex.delete(lower);
  delete expanded[path];
  var pp = parentPathOf(path);
  var pn = pp && store.get(pp.toLowerCase());
  if (pn) {
    var idx = pn.c.indexOf(n);
    if (idx >= 0) pn.c.splice(idx, 1);
  }
  return { s: total, al: totalAl };   // 目录节点自带整棵子树的合计，直接作差值
}
// 新目录出现：占位（统计中）并排队优先扫描，扫完 done 事件把真实体积带回来
var priQueue = [], priQueued = {}, priInflight = [], PRI_MAX = 1;
function queuePriority(path) {
  var k = path.toLowerCase();
  if (priQueued[k]) return;
  priQueued[k] = 1;
  priQueue.push(path);
  pumpPriority();
}
function pumpPriority() {
  while (priInflight.length < PRI_MAX && priQueue.length) {
    var p = priQueue.shift();
    priInflight.push(p);
    feed.scanPriority(p);
  }
}
// 渲染循环每帧调：在飞的优先扫描对应节点 done 即释放并发额度
function completePriority(path) {
  var key = path.toLowerCase();
  var i = priInflight.findIndex(function(p){ return p.toLowerCase()===key; });
  if(i<0) return;
  delete priQueued[key];
  priInflight.splice(i,1);
  pumpPriority();
}
function applyFsBatch(batch) {
  if (!watchActive || !Array.isArray(batch) || !batch.length) return;
  var changed = 0;
  for (var i = 0; i < batch.length; i++) {
    var ev = batch[i];
    if (!ev || !ev.path) continue;
    var lower = ev.path.toLowerCase();
    if (ev.kind === 'remove') {
      var rm = removeSubtree(ev.path);
      propDelta(ev.path, -rm.s, -rm.al);   // 未入树的路径合计=0，传播 0 无副作用
      changed++;
    } else if (ev.kind === 'upsert') {
      var n = store.get(lower);
      if (ev.is_dir) {
        if (!n) {
          // 新目录先占位，用户进入或展开时再安排局部遍历。
          applyEvent({ path: ev.path, size: 0, done: false, file: false });
          changed++;
        }
      } else {
        // 文件：与扫描同语义，只关心 ≥10MB 的大文件或已在树里的（小文件本就不入树）
        if (!n && ev.size < BIG_FILE_MIN) continue;
        // 体积差值由 applyEvent 统一传播（监视模式下），这里不再手动传播以免重复
        applyEvent({ path: ev.path, size: ev.size, al: ev.al, done: true, file: true });
        changed++;
      }
    }
  }
  if (changed) {
    watchChanges += changed;
    markDirty();
  }
}
function setWatch(on, root) {
  if (on) {
    watchActive = true;
    watchChanges = 0;
    document.body.classList.add('watching');
    // root 兼容单根字符串与多根数组；多盘逐根挂 watcher
    var roots = Array.isArray(root) ? root : [root];
    for(var i=0;i<roots.length;i++) feed.watchStart(roots[i]);
  } else {
    watchActive = false;
    priQueue = []; priQueued = {}; priActive = 0; priInflight = [];
    document.body.classList.remove('watching');
    feed.watchStop();
  }
}

/* 清空各视图的动态列表体。只动 body 类容器：#files/#types/#diff 的操作条
   （搜索框/导出按钮）是静态结构，整体 innerHTML='' 会把大文件榜永久打空 */
function clearViewBodies(){
  window.divs = {}; window.map.innerHTML = '';
  document.getElementById('list').innerHTML = '';
  document.getElementById('files-body').innerHTML = '';
  document.getElementById('types-body').innerHTML = '';
  document.getElementById('diff-body').innerHTML = '';
}

/* 扫描启动的统一 UI 接管：用户点按钮与 AI 触发共用（roots 数组）。
   同范围重扫保留现有数据——重扫事件流会覆盖更新，手动与 AI 触发一致，
   避免清空大文件榜等视图后小目录扫描没有新大文件回流、界面"变空"；
   其他范围的数据空闲态留在内存供秒开，但扫描开始时会整体逐出
   （rememberScope 扫描态只留当前范围，避免扫描期间双树驻留拖垮内存） */
function beginScanUI(roots, full){
  var sameScope = roots.length === ROOTS.length &&
    roots.every(function(r, i){ return String(r).toLowerCase() === String(ROOTS[i]||'').toLowerCase(); });
  var keepData = !full && sameScope && !scanning && store.size > 0;
  ROOTS = roots.map(function(r){ return r; });
  window.ROOT = ROOTS[0];
  if (watchActive) setWatch(false);
  if(full){
    dropScopeData(ROOTS, []);
    delete scopeAt[curScopeKey()];
  }
  if (!keepData) {
    clearViewBodies();
    window.expanded = {}; window.stack = []; selectedRow = '';
    prevCacheLoaded = false; prevCache = null;             // 历史对比基线重置
    fileSearch = '';                                       // 搜索词随扫描重置
    var fsInp = document.getElementById('file-search');
    if(fsInp) fsInp.value = '';
  }
  volUsed = 0; volTotal = 0;
  ensurePcRoot();                              // 多盘时建/刷新虚拟根
  window.curPath = isMultiRoot() ? THISPC : ROOTS[0];
  syncPathControls();
  setScanning(true);
  rememberScope();   // 扫描态下逐出其他范围（scanning=true 时只留当前范围，压内存峰值）
  setStatus('后台扫描中…', 'scanning');
  syncDrivesSelect(); loadDrives();
  render();
}

/* ===== 扫描缓存：启动秒开 + 历史对比 ===== */
// 缓存格式（紧凑，只存重建树所需）：{root, at, volUsed, volTotal, nodes:[[path,name,s,al,done,denied]], files:[[path,name,s,al,cloud,dup]]}
// nodes 含全部 ≥1MB 目录；files 为全部入树大文件。重建走 applyEvent 同款 ensureChain

function buildCacheJson(){
  var sum = isMultiRoot() ? rootsSummary() : null;
  var hasData = isMultiRoot() ? sum.s > 0 : (function(){
    var r = store.get(String(window.ROOT||'').toLowerCase());
    return !!(r && r.s);
  })();
  if(!hasData) return null;
  var nodes = [];
  store.forEach(function(n){
    if(!n.f && n.s >= 1024*1024 && n.p !== THISPC && inScope(n.p))
      nodes.push([n.p, n.n, n.s, alOf(n), n.done?1:0, n.denied?1:0, n.summarized?1:0]);
  });
  var files = [];
  fileIndex.forEach(function(n){
    if(!inScope(n.p)) return;   // 缓存只落当前范围：store 里可能还留着其他范围的数据
    files.push([n.p, n.n, n.s, alOf(n), n.cloud?1:0, n.dup?1:0]);
  });
  return JSON.stringify({
    v:1, root:ROOTS.join(','), at:Date.now(),
    volUsed:volUsed||null, volTotal:volTotal||null,
    deniedCount:deniedInScope(), nodes:nodes, files:files
  });
}
// 扫描完成：写缓存（Rust 轮换 prev 供对比）+ 推 AI 快照
function saveScanCache(){
  var j = null;
  try { j = buildCacheJson(); } catch(e) { return; }
  if(j && feed.writeScanCache) feed.writeScanCache(j);
}
// 启动时读缓存重建树（秒开摘要视图；done=false 的条目标记为陈旧，重扫后覆盖）
function restoreScanCache(cb){
  if(!feed.readScanCache) return cb && cb(null);
  feed.readScanCache('current', function(json){
    if(!json || scanning || scanPending) return cb && cb(null);
    try {
      var d = JSON.parse(json);
      if(!d || !d.nodes) return cb && cb(null);
      for(var i=0;i<d.nodes.length;i++){
        var r = d.nodes[i];
        applyEvent({ path:r[0], name:r[1], size:r[2], al:r[3], done:r[4], file:false, denied:!!r[5], summarized:!!r[6] });
      }
      for(var j=0;j<d.files.length;j++){
        var f = d.files[j];
        applyEvent({ path:f[0], name:f[1], size:f[2], al:f[3], done:true, file:true, cloud:!!f[4], dup:!!f[5] });
      }
      volUsed = d.volUsed||0; volTotal = d.volTotal||0;
      cb && cb({ root:d.root, at:d.at, deniedCount:d.deniedCount||0 });
    } catch(e) { cb && cb(null); }
  });
}

/* Feed 方法（Tauri）：缓存读写 */
TauriFeed.prototype.writeScanCache = function(json){
  window.__TAURI__.core.invoke('write_scan_cache', { json: json }).catch(function(){});
};
TauriFeed.prototype.readScanCache = function(which, cb){
  window.__TAURI__.core.invoke('read_scan_cache', { which: which })
    .then(function(r){ cb(r||null); }).catch(function(){ cb(null); });
};

/* ===== AI 联动通道：扫描快照聚合与推送 ===== */
// 快照树形化：AI 直接看到层级构成（谁在谁下面、目录里哪个文件占大头），
// 不需要自己去 du。节点：{n 名称, p 路径, s 大小, al 占用, d 受限, c 子项, f 文件叶,
// agg 小项聚合}。阈值 10MB 以下的不进树，按层聚进 agg（要看更细用 /api/tree 下钻）
var AI_SNAP_MIN = 10 * 1024 * 1024;
var aiSnapBudget = 0;   // 树节点总量保护：超预算停止展开（该目录标 truncated，AI 用 /api/tree 下钻）
function snapTree(n){
  var dirs = [], fileLeaves = [], agg = { n: 0, s: 0, al: 0 };
  var kids = n.c || [];
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    if (n.p === THISPC || (k.s || 0) >= AI_SNAP_MIN) { if (k.f) fileLeaves.push(k); else dirs.push(k); }
    else { agg.n++; agg.s += k.s || 0; agg.al += alOf(k); }
  }
  dirs.sort(function(a,b){ return b.s-a.s; });
  fileLeaves.sort(function(a,b){ return b.s-a.s; });
  var o = { n: n.n, p: n.p, s: n.s || 0, al: alOf(n) };
  if (n.denied) o.d = true;
  if (n.summarized) o.summarized = true;
  var c = [];
  for (var d = 0; d < dirs.length; d++) {
    if (aiSnapBudget <= 0) { o.truncated = true; break; }
    aiSnapBudget--;
    c.push(snapTree(dirs[d]));
  }
  for (var f = 0; f < fileLeaves.length; f++) {
    if (aiSnapBudget <= 0) { o.truncated = true; break; }
    aiSnapBudget--;
    var fl = fileLeaves[f];
    var fo = { n: fl.n, p: fl.p, s: fl.s, al: alOf(fl), f: true };
    if (fl.cloud) fo.cloud = true;
    if (fl.dup) fo.dup = true;
    c.push(fo);
  }
  if (c.length) o.c = c;
  if (agg.n) o.agg = agg;
  return o;
}
// 快照 = 树形构成 + 卷口径 + 类型分布 + 受限目录。
// Rust 侧原样存取（零解析），HTTP GET /api/scan 直接回传
function buildAiSnapshot(scannedAt, scanId){
  var root = isMultiRoot() ? store.get(THISPC.toLowerCase()) : store.get(String(window.ROOT||'').toLowerCase());
  if(!root) return null;   // 扫描早期（s=0）也推：AI 靠 scanning 字段区分进行中/完成
  var denied = [];
  for(var k in deniedSeen){
    if(!inScope(k)) continue;   // 只报当前扫描范围的受限目录
    var dn = store.get(k);
    if(dn) denied.push({ path:dn.p, s:dn.s||0, al:alOf(dn) });
  }
  var types = (typeof typesPool === 'function') ? typesPool().slice(0, 50) : [];
  aiSnapBudget = 6000;
  var sum = isMultiRoot() ? rootsSummary() : { s:root.s, al:alOf(root) };
  return JSON.stringify({
    app:'disklens', root:ROOTS.join(','), scanId:scanId||null, scannedAtMs:scannedAt, volUsed:volUsed||null, volTotal:volTotal||null,
    gap:(volUsed ? volUsed - sum.al : null),
    rootSize:sum.s, rootAlloc:sum.al, deniedCount:deniedInScope(),
    tree: snapTree(root),      // 树形构成（多盘=虚拟根下各盘一棵；≥10MB 子项 + 每层 agg）
    denied:denied, types:types,
    drill: 'GET /api/tree?path=<dir>&depth=<1..=8,默认3>&min=<字节或 100MB/1GB,默认10MB> 一次返回多层（目录+大文件，<min 聚合进 agg，预算截断标 truncated）；找大头加 &flat=1 直接返回按大小降序的文本清单（每行「大小MB D|F 路径」，零解析）；无需逐层探索'
  });
}
function pushAiSnapshot(scannedAt, scanId){
  if(scanning || !scannedAt || !feed.aiSnapshot) return;
  var j = null;
  try { j = buildAiSnapshot(scannedAt,scanId); } catch(e) { return; }
  if(!j) return;
  feed.aiSnapshot(j);
}
var lastAutoRender = 0;   // 监视模式渲染合流的时间戳
(function loop(){
  if(dirty){
    var now = Date.now();
    // 监视模式合流：文件事件高频到达时 120ms 全量重排会让方块带着 0.35s
    // 过渡持续漂移+闪烁（用户反馈"屏幕一直闪"）。合并到至多 ~1.3 次/秒，
    // 变化攒着一步到位；手动操作（navigate/render 直调）不受影响
    if((!scanning && !localScanning && !watchActive) || now - lastAutoRender >= 800){
      dirty = false;
      lastAutoRender = now;
      try { render(); }
      catch(e){
        window.__errs = window.__errs || [];
        window.__errs.push('render: ' + e.message);
        try { setStatus('渲染异常：' + e.message, 'err'); } catch(_) {}
      }
    }
  }
  setTimeout(loop, 120);
})();

/* ===== 视图调度 ===== */
function render(){
  if(!curPath) return;
  if(curPath !== pathInControls) syncPathControls();
  var node = store.get(curPath.toLowerCase());
  if(!node){
    // 该范围还没有数据（切到没扫过的盘）：不用转圈 spinner（会被误读成正在扫描），
    // 静态空态 + 清掉上一范围残留的面包屑/摘要/底栏，口径统一指向新范围
    var b=document.getElementById('bar');
    if(b) b.innerHTML='<b>'+esc(scopeLabel())+' · 尚未扫描</b>';
    var sm=document.getElementById('summary');
    if(sm){
      var parts=[];
      if(volTotal) parts.push('卷总容量 <b>'+fmt(volTotal)+'</b>');
      if(volUsed) parts.push('卷已用 <b>'+fmt(volUsed)+'</b>');
      parts.push('<span style="color:var(--muted,#9a9a9a)">尚未扫描 · 点「开始扫描」开始</span>');
      sm.innerHTML=parts.join(' · ');
    }
    var st=document.getElementById('foot-stats');
    if(st){
      st.title = scopeLabel();
      st.innerHTML='当前 <b>'+esc(scopeLabel())+'</b> · 尚未扫描';
    }
    var wt = document.getElementById('wait');
    if(wt){ wt.style.display='flex';
      wt.innerHTML='<div><div style="font-size:46px;margin-bottom:14px">🗂️</div>'+
        '<div style="color:#9a9a9a">'+esc(scopeLabel())+' 还没有扫描记录 —— 点上方「开始扫描」开始</div></div>'; }
    return;
  }
  updateCrumb(node);
  var wt2 = document.getElementById('wait');
  if(wt2) wt2.style.display = 'none';   // 节点已就位：撤掉"尚未扫描"等待遮罩（treemap 视图按需自行重挂）
  if(viewMode === 'treemap') renderTreemap();
  else if(viewMode === 'list') renderList(node);
  else if(viewMode === 'types') renderTypes();
  else if(viewMode === 'diff') renderDiff();
  else renderFiles();
  updateSummary(node);
}
function setView(m){
  viewMode = m;
  document.body.dataset.view = m;
  var segs = document.querySelectorAll('#views .seg');
  for(var i=0;i<segs.length;i++) segs[i].classList.toggle('active', segs[i].dataset.view===m);
  document.getElementById('wait').style.display = 'none';
  document.getElementById('foot-hint').textContent = VIEW_HINTS[m] || '';
  render();
}
function scanDisplayTotals(node){
  if(node && node.p===THISPC){
    return scanning && scanProgress
      ? {s:scanProgress.bytesScanned, al:scanProgress.allocatedBytes, done:false}
      : rootsSummary();
  }
  if(scanning && scanProgress && node){
    var live = scanProgress.roots.find(function(root){ return root.path.toLowerCase()===node.p.toLowerCase(); });
    if(live) return {s:live.bytesScanned, al:live.allocatedBytes, done:live.done};
  }
  return node;
}

function updateCrumb(node){
  var b=document.getElementById('bar'); b.innerHTML='';
  if(stack.length){
    var bk=document.createElement('span'); bk.className='crumb'; bk.textContent='⬅ 返回';
    bk.onclick=function(){ goUp(); }; b.appendChild(bk);
    b.appendChild(sep());
  }
  function sep(){ var s=document.createElement('span'); s.className='sep'; s.textContent='\\'; return s; }
  function mk(label,p){ var s=document.createElement('span'); s.className='crumb'; s.textContent=label;
    s.onclick=(function(pp){ return function(){ navigate(pp,false); }; })(p); b.appendChild(s); }
  var acc = isMultiRoot() ? THISPC : ROOT;
  if(stack.length){
    // stack[0] 若就是根自身则不重复渲染根面包屑
    var start=0;
    if(stack[0].path.toLowerCase()===String(acc).toLowerCase()){ acc=stack[0].path; start=1; }
    else mk(acc,acc);
    for(var i=start;i<stack.length;i++){ acc=stack[i].path;
      b.appendChild(sep()); mk(stack[i].name,acc); }
    b.appendChild(sep());
  }
  var cb=document.createElement('b');
  // 目录双口径：逻辑大小 = 展示主口径；占用 = 簇对齐后的真实磁盘占用
  var totals = scanDisplayTotals(node);
  cb.textContent=node.n+' = '+fmt(totals.s)+(node.f?'':' · 占用 '+fmt(alOf(totals)));
  b.appendChild(cb);
}
function updateSummary(node){
  // 多盘：聚合各盘根（引擎不更新虚拟根，这里现场求和）
  var root = scanDisplayTotals(store.get(curRootKey()));
  var parts=[];
  if(node.summarized) parts.push('<span title="可对当前目录开始扫描，展开更多明细">部分明细已聚合</span>');
  if(root&&root.s>0){
    // 双口径：逻辑大小为主展示，磁盘占用（簇对齐/去重后的真实占用）括号补充
    parts.push((scanning?'已扫描 ':'根目录总计 ')+'<b>'+fmt(root.s)+'</b>'+'（占用 '+fmt(alOf(root))+'）');
  }
  if(volUsed) parts.push('卷已用 <b>'+fmt(volUsed)+'</b>');
  if(scanning && scanProgress){
    parts.push('已访问 '+scanProgress.directoriesVisited.toLocaleString()+' 个目录、'+
      scanProgress.filesVisited.toLocaleString()+' 个文件');
    if(scanProgress.rootsTotal>1)
      parts.push('已完成 '+scanProgress.rootsDone+'/'+scanProgress.rootsTotal+' 个扫描根');
  }
  // 扫描完成后的差额透明化：扫描器看不到的部分 = 卷已用 - 扫描占用
  // （还原点/NTFS 元数据/无权限目录；负值说明占用估算偏高，如压缩文件近似）
  if(!scanning&&root&&root.done&&volUsed&&(isMultiRoot() || /^[a-z]:\\$/i.test(window.ROOT))){
    var gap=volUsed-alOf(root);
    if(gap>=100*1024*1024){
      parts.push('<span style="color:var(--amber)" title="扫描器看不到的部分：System Volume Information（还原点）等受保护目录、NTFS 元数据（$MFT/USN 日志）、无权限目录">未计入 '+fmt(gap)+'</span>');
    } else if(gap<=-100*1024*1024){
      parts.push('<span style="color:var(--amber)" title="扫描占用高于卷已用：压缩/稀疏文件按逻辑大小估算偏高">口径高估 '+fmt(-gap)+'</span>');
    }
  }
  var dCnt = deniedInScope();
  if(dCnt) parts.push('<span id="denied-link" style="color:var(--amber);cursor:pointer;text-decoration:underline dotted" title="这些目录无权限读取，体积只含已读到的部分——点击查看清单">⛔ '+dCnt+' 个目录无权限</span>');
  // AI 提案待确认入口已改为右下角固定悬浮角标（#prop-fab，见 aiassist.js）：
  // 不随摘要文字流布局，小窗也不会被挤没/截断
  if(scanning&&scanT0) parts.push('用时 '+((Date.now()-scanT0)/1000).toFixed(1)+'s');
  else if(lastScanSecs) parts.push('用时 '+lastScanSecs.toFixed(1)+'s');   // 完成态保留耗时
  if(watchActive) parts.push('<span style="color:var(--green)">⏱ 实时监视中'+(watchChanges?' · 已感知 '+watchChanges+' 项变更':'')+'</span>');
  document.getElementById('summary').innerHTML=parts.join(' · ');
  var st=document.getElementById('foot-stats');
  if(node){
    var location = curPath===THISPC ? scopeLabel() : curPath;
    st.title = location;
    st.innerHTML='当前 <b>'+esc(location)+'</b> · '+node.c.length+' 项';
  }
}

/* ===== 无权限目录面板 ===== */
function openDeniedPanel(){
  var mask=document.getElementById('denied-mask');
  if(!mask) return;
  var rows=[];
  for(var k in deniedSeen){
    if(!inScope(k)) continue;   // 只列当前扫描范围的受限目录
    var n=store.get(k);
    if(n) rows.push(n);
  }
  rows.sort(function(a,b){ return (b.s||0)-(a.s||0); });
  document.getElementById('denied-n').textContent='（'+rows.length+'）';
  var list=document.getElementById('denied-list');
  if(!rows.length){
    list.innerHTML='<div class="d-empty">当前扫描没有受限目录</div>';
  } else {
    var html='';
    for(var i=0;i<rows.length;i++){
      var n=rows[i];
      html+='<div class="d-row" data-path="'+escAttr(n.p)+'">'+
        '<div class="d-path" title="'+escAttr(n.p)+'">📁 '+esc(n.p)+'</div>'+
        '<div class="d-size">'+fmt(n.s||0)+'</div>'+
        '<div class="d-al">'+fmt(alOf(n))+'</div>'+
        '<div class="d-act"><button class="d-open">📂 定位</button><button class="d-go">进入</button></div></div>';
    }
    list.innerHTML=html;
  }
  mask.style.display='flex';
}
(function initDeniedPanel(){
  document.addEventListener('click',function(ev){
    // summary 的 ⛔ 链接（updateSummary 重建 innerHTML，用委托）
    if(ev.target.closest && ev.target.closest('#denied-link')){ openDeniedPanel(); return; }
    var mask=document.getElementById('denied-mask');
    if(!mask||mask.style.display==='none') return;
    if(ev.target===mask || ev.target.closest('#denied-close') || ev.target.closest('#denied-cancel')){
      mask.style.display='none'; return;
    }
    var row=ev.target.closest && ev.target.closest('.d-row');
    if(!row) return;
    var p=row.dataset.path;
    var b=ev.target.closest('button');
    if(b&&b.classList.contains('d-open')){ feed.open(p,false); return; }
    if(b&&b.classList.contains('d-go')){
      mask.style.display='none';
      setView('treemap'); navigate(p);
    }
  });
  var cp=document.getElementById('denied-copy');
  if(cp) cp.addEventListener('click',function(){
    var paths=[];
    for(var k in deniedSeen){ if(inScope(k)) paths.push(k); }
    copyPath(paths.join('\r\n'),null);
    setStatus('已复制 '+paths.length+' 条路径','done');
  });
})();

/* ===== CSV 导出（Tauri：原生保存对话框 + save_text_file；浏览器：剪贴板回退） ===== */
function csvEsc(v){
  v=String(v);
  if(/[",\r\n]/.test(v)) v='"'+v.replace(/"/g,'""')+'"';
  return v;
}
function exportCSV(defaultName, header, rows){
  var csv='\uFEFF'+header.map(csvEsc).join(',')+'\r\n'+
    rows.map(function(r){ return r.map(csvEsc).join(','); }).join('\r\n');
  if(!IN_TAURI || !window.__TAURI__.dialog || !window.__TAURI__.dialog.save){
    // 浏览器模式：CSV 进剪贴板（clipboard API 失败回退 execCommand），粘贴进 Excel 即可
    function fallback(){
      var t=document.createElement('textarea'); t.value=csv;
      document.body.appendChild(t); t.select();
      var done=false; try{ done=document.execCommand('copy'); }catch(e){}
      document.body.removeChild(t);
      setStatus(done?'已复制 CSV 到剪贴板（浏览器模式）':'剪贴板不可用，浏览器模式请在客户端内导出', done?'done':'err');
    }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(csv).then(function(){
        setStatus('已复制 CSV 到剪贴板（浏览器模式）','done');
      },fallback);
    } else fallback();
    return;
  }
  window.__TAURI__.dialog.save({
    defaultPath: defaultName,
    filters: [{ name:'CSV 表格', extensions:['csv'] }]
  }).then(function(path){
    if(!path) return;   // 用户取消
    window.__TAURI__.core.invoke('save_text_file', { path: path, contents: csv })
      .then(function(){ setStatus('已导出：'+path,'done'); })
      .catch(function(e){ setStatus('导出失败：'+e,'err'); });
  }).catch(function(){});
}
// 大文件榜（含当前搜索结果；导出全量，不受 500 行显示限制）
function exportFilesCSV(){
  var arr=filesPool();
  var rows=arr.map(function(n,i){
    return [i+1, n.p, n.n, n.f?'文件':'目录', n.s, alOf(n), fmt(n.s)];
  });
  exportCSV('disklens-files.csv',
    ['排名','完整路径','名称','类型','大小(字节)','占用(字节)','大小(可读)'], rows);
}
function exportTypesCSV(){
  var arr=typesPool();
  var rows=arr.map(function(t){ return [t.ext, t.n, t.s, t.al, fmt(t.s)]; });
  exportCSV('disklens-types.csv',
    ['扩展名','文件数','大小(字节)','占用(字节)','大小(可读)'], rows);
}

/* ===== 工具栏 ===== */
var lastStatusMsg = '', lastStatusCls = '';   // 状态记忆：临时提示（如更新检查）可回放
function setStatus(s, cls){
  lastStatusMsg = s; lastStatusCls = cls || '';
  var el = document.getElementById('status');
  if(el) el.textContent = s;
  document.body.classList.remove('scanning','done','err');
  if(cls) document.body.classList.add(cls);
  if(cls === 'err') diagLog('error', s);   // 报错进诊断日志（反馈/追溯用）
}
function setScanning(on){
  scanning = on;
  if(on){ scanT0 = Date.now(); }
  else if(scanT0){ lastScanSecs = (Date.now()-scanT0)/1000; }   // 记录本次扫描耗时（完成态 summary 用）
  syncScanButtons();
  document.body.classList.toggle('scanning', on);
  if(!on) document.body.classList.remove('scanning');
  markDirty();
}

function syncScanButtons(){
  var busy = scanning || localScanning || scanPending;
  document.getElementById('scan-btn').disabled = busy;
  document.getElementById('stop-btn').disabled = !busy;
}

/* 沿"单一大子目录"链钻取展开：把 start 的子目录展开后，若其下只有一条
   有内容的子目录链（如 C:\Users → 唯一用户目录），继续向下展开，
   直到出现多样内容为止——保证展开在视觉上可见，让用户感知到内部在展开 */
function drillExpand(startPth, maxDepth){
  var pth = startPth;
  var node = store.get(pth.toLowerCase());
  if(!node) return;
  (node.c||[]).forEach(function(ch){ if(!ch.f && ch.s>0) expanded[ch.p]=1; });
  for(var d=0; d<maxDepth; d++){
    var kids = (node.c||[]).filter(function(k){ return !k.f && k.s>0; });
    var tot = 0; kids.forEach(function(k){ tot += k.s; });
    var dominant = null;
    if(kids.length===1){ dominant = kids[0]; }
    else {
      for(var i=0;i<kids.length;i++){ if(kids[i].s >= tot*0.85) { dominant = kids[i]; break; } }
    }
    if(!dominant) break;
    node = store.get(dominant.p.toLowerCase());
    if(!node) break;
    (node.c||[]).forEach(function(ch){ if(!ch.f && ch.s>0) expanded[ch.p]=1; });
  }
}

/* 扫描完成后自动展开：按估算渲染面积逐层下钻——块还大到足以看清内部
   （≥EXPAND_MIN_AREA，且确有子目录）就继续展开；小到阈值以下或到达层深
   上限就停。大目录的内部构成一眼可见，小块保持收起、单击即展开 */
var EXPAND_MIN_AREA = 6400;    // ≈80×80 px，低于此面积内部已不可读，不再展开
var EXPAND_PCT = 0.10;         // 占比阈值（0=不限）：子目录占父目录 ≥ 此比例才自动展开
var EXPAND_MAX_DEPTH = 3;      // 深度上限（0=不限）：超过此层数不再自动展开
                               // 两个条件可独立关闭；同时启用时需都满足（且）
function autoExpandView(){
  var node = store.get(curPath.toLowerCase());
  if(!node) return;
  var full = (map.clientWidth||800) * (map.clientHeight||500);
  function walk(n, area, depth, tot){
    expanded[n.p] = 1;
    if(EXPAND_MAX_DEPTH > 0 && depth >= EXPAND_MAX_DEPTH) return;   // 0=深度不限
    var kids = n.c || [];
    if(tot <= 0) return;
    for(var j=0;j<kids.length;j++){
      var k = kids[j];
      if(k.f || !k.c || !k.c.length) continue;   // 文件/尚无已知子项的不展开
      var frac = k.s / tot;
      // 每层标题条+内边距约吃掉两成可用面积，估算时先打八折
      var ka = area * frac * 0.8;
      // 占比阈值（0=不限）：只有相对父目录足够大的子目录才自动展开（突出主要目标）
      if((EXPAND_PCT <= 0 || frac >= EXPAND_PCT) && ka >= EXPAND_MIN_AREA) walk(k, ka, depth+1, tot*frac);
    }
  }
  var kids = node.c || [];
  var tot = 0; for(var q=0;q<kids.length;q++) tot += kids[q].s;
  if(tot > 0){
    for(var w=0;w<kids.length;w++){
      var ch = kids[w];
      if(ch.f || !ch.c || !ch.c.length) continue;
      var ca = (ch.s / tot) * full;
      if((EXPAND_PCT <= 0 || (ch.s/tot) >= EXPAND_PCT) && ca >= EXPAND_MIN_AREA) walk(ch, ca, 0, tot);
    }
  }
  markDirty();
}
/* 展开控制控件：改设置即按新阈值重算（清掉旧展开标记，突出主要目标）。
   占比/深度均可选「不限」；两个都启用时是且关系 */
function applyExpandSettings(){
  var p = document.getElementById('expand-pct');
  var d = document.getElementById('expand-depth');
  if(p) EXPAND_PCT = (p.value === '') ? 0 : (parseFloat(p.value) || 0);
  if(d) EXPAND_MAX_DEPTH = (d.value === '') ? 0 : (parseInt(d.value, 10) || 0);
  expanded = {};
  if(!scanning && viewMode === 'treemap') autoExpandView();
  render();
}

/* ===== Tauri Feed：invoke 扫描命令 + 监听事件流 ===== */
function TauriFeed(){
  window.__TAURI__.event.listen('scan-started', function(ev){
    scanPending = false;
    currentScanId = ev.payload.scanId;
    scanProgress = null;
    beginScanUI(ev.payload.roots, ev.payload.full);
    if(ev.payload.byAi) setStatus('AI 发起的后台扫描中…', 'scanning');
  });
  window.__TAURI__.event.listen('scan-progress', function(ev){
    if(!scanning || currentScanId!==ev.payload.scanId) return;
    scanProgress = ev.payload.progress;
    markDirty();
  });
  // 主扫描与局部扫描共用批量事件。
  window.__TAURI__.event.listen('scan-batch', function(ev){
    var arr = ev.payload || [];
    for(var i=0;i<arr.length;i++) applyEvent(arr[i]);
  });
  window.__TAURI__.event.listen('scan-finished', function(ev){
    var msg = ev.payload || '完成';
    var completed = msg.indexOf('扫描完成') === 0;
    setStatus(msg, completed ? 'done' : 'err');
    setScanning(false);
    if(!completed) return;
    autoExpandView();
    prevCacheLoaded = false; prevCache = null;   // prev 缓存已轮换，历史对比下次进视图重读
    var key = curScopeKey(), at = Date.now(), scanId = currentScanId;
    scopeAt[key] = at;
    function sameScan(){ return !scanning && currentScanId===scanId && curScopeKey()===key && scopeAt[key]===at; }
    setTimeout(function(){ if(sameScan()) pushAiSnapshot(at,scanId); }, 300);
    setTimeout(function(){ if(sameScan()) saveScanCache(); }, 1200);
    diagLog('info', String(msg) + '（roots=' + ROOTS.join(',') + '）');
    // 完整扫描结束后进入实时监视：文件增删改即时反映到视图（多盘逐根挂 watcher）
    if (!watchActive && ROOTS.length) {
      setWatch(true, ROOTS);
    }
  });
  window.__TAURI__.event.listen('scan-refresh-finished', function(ev){
    var result = ev.payload;
    if(result[1]) setStatus(result[1], result[1].startsWith('目录刷新完成') ? 'done' : 'err');
    completePriority(result[0]);
  });
  window.__TAURI__.event.listen('scan-refresh-running', function(ev){
    localScanning = !!ev.payload;
    syncScanButtons();
    if(localScanning){
      setStatus('后台刷新目录中…', 'scanning');
    } else if(localStopPending){
      localStopPending = false;
      setStatus('目录刷新已停止', 'done');
    } else if(!scanning && lastStatusCls==='scanning'){
      setStatus('目录刷新结束', 'done');
    }
  });
  window.__TAURI__.event.listen('fs-batch', function(ev){
    try { applyFsBatch(ev.payload); } catch(e) {
      window.__errs = window.__errs || [];
      window.__errs.push('fs-batch: ' + e.message);
    }
  });
  window.__TAURI__.event.listen('migrate-update', function(ev){
    if(window.__migHandler) window.__migHandler(ev.payload);
  });
  // AI 联动通道收到新提案（POST /api/proposal）→ 弹确认面板
  window.__TAURI__.event.listen('ai-proposal', function(ev){
    try { if(typeof showProposal==='function') showProposal(ev.payload); } catch(e){}
  });
  window.__migHandler = null;   // migrate.js 对话框打开时接管
}
TauriFeed.prototype.start = function(roots, full){
  var self = this;
  self.stopping = false;
  scanPending = true;
  syncScanButtons();
  setStatus('准备后台扫描…', 'scanning');
  var arr = Array.isArray(roots) ? roots : [roots];
  window.__TAURI__.core.invoke('scan_start', { roots: arr, full: !!full }).then(function(){
    if(self.stopping && (scanning || scanPending)) self.stop();
  }).catch(function(e){
    scanPending = false;
    syncScanButtons();
    if(!scanning) setStatus(String(e), 'err');
  });
};
TauriFeed.prototype.stop = function(){
  this.stopping = true;
  window.__TAURI__.core.invoke('scan_stop').catch(function(){});
};
TauriFeed.prototype.open = function(p, sel){
  window.__TAURI__.core.invoke('open_in_explorer', { path: p, select: !!sel }).catch(function(e){
    setStatus(String(e), 'err');
  });
};
/* 调出资源管理器的原生右键菜单（shell IContextMenu 托管，菜单出现在光标处） */
TauriFeed.prototype.shellContextMenu = function(p){
  window.__TAURI__.core.invoke('shell_context_menu', { path: p }).catch(function(e){
    setStatus('调出系统右键菜单失败：' + String(e).slice(0, 80), 'err');
  });
};
TauriFeed.prototype.listVolumes = function(cb){
  window.__TAURI__.core.invoke('list_volumes').then(cb).catch(function(){ cb([]); });
};
/* AI 联动通道：快照推送 / 端点信息 / 开关 / 提案结果回写 */
TauriFeed.prototype.aiSnapshot = function(json){
  window.__TAURI__.core.invoke('ai_snapshot', { json: json }).catch(function(){});
};
TauriFeed.prototype.aiChannelInfo = function(cb){
  window.__TAURI__.core.invoke('ai_channel_info').then(cb).catch(function(){ cb(null); });
};
TauriFeed.prototype.aiChannelSetEnabled = function(enabled){
  window.__TAURI__.core.invoke('ai_channel_set_enabled', { enabled: !!enabled }).catch(function(){});
};
/* 轮换联动令牌：新生成并写盘，旧令牌立即失效 */
TauriFeed.prototype.aiChannelRotateToken = function(cb){
  window.__TAURI__.core.invoke('ai_channel_reset_token')
    .then(function(){ cb && cb(); }).catch(function(){ cb && cb(); });
};
TauriFeed.prototype.aiProposalResult = function(id, status, results){
  window.__TAURI__.core.invoke('ai_proposal_result', { id: id, status: status, results: results }).catch(function(){});
};
/* 启动恢复：拉取上次会话遗留的提案（pending 的重新弹确认面板） */
TauriFeed.prototype.aiProposalGet = function(cb){
  window.__TAURI__.core.invoke('ai_proposal_get')
    .then(function(r){ cb(r||null); }).catch(function(){ cb(null); });
};
TauriFeed.prototype.migrateCheck = function(src, destRoot, cb){
  window.__TAURI__.core.invoke('migrate_check', { src: src, destRoot: destRoot }).then(cb).catch(function(e){
    setStatus(String(e), 'err'); cb(null);
  });
};
TauriFeed.prototype.migrateStart = function(src, destRoot){
  window.__TAURI__.core.invoke('migrate_start', { src: src, destRoot: destRoot }).catch(function(e){
    if(window.__migHandler) window.__migHandler({ stage:'error', message:String(e), locked:[], bytes_done:0, bytes_total:0, files_done:0, files_total:0, current:'' });
  });
};
TauriFeed.prototype.migrateStop = function(){
  window.__TAURI__.core.invoke('migrate_stop').catch(function(){});
};
TauriFeed.prototype.scanPriority = function(p){
  window.__TAURI__.core.invoke('scan_priority', { path: p }).catch(function(){ completePriority(p); });
};
/* 强制重扫子树（右键「重新扫描此目录」/ 提案执行后的局部刷新） */
TauriFeed.prototype.scanRefresh = function(p){
  window.__TAURI__.core.invoke('scan_refresh', { path: p }).catch(function(e){ setStatus(String(e),'err'); });
};
/* 清理类操作：移入回收站（可还原）。cb(failedPaths) */
TauriFeed.prototype.recycleDelete = function(paths, cb, onProgress){
  var core = window.__TAURI__.core;
  var progress = new core.Channel(onProgress || function(){});
  core.invoke('recycle_delete', { paths: paths, progress: progress }).then(
    function(f){ cb(f||[]); }, function(){ cb(paths); }
  );
};
/* 撤销迁移：删 junction + 数据回原位；进度/结果经 migrate-update 事件流（__migHandler） */
TauriFeed.prototype.migrateUndo = function(src, destRoot){
  window.__TAURI__.core.invoke('migrate_undo', { src: src, destRoot: destRoot }).catch(function(e){
    if(window.__migHandler) window.__migHandler({ stage:'error', message:String(e), locked:[], bytes_done:0, bytes_total:0, files_done:0, files_total:0, current:'' });
  });
};
TauriFeed.prototype.watchStart = function(root){
  window.__TAURI__.core.invoke('watch_start', { root: root }).catch(function(e){
    // 监视失败不打扰（如网络盘不支持），只把状态回退
    watchActive = false;
    document.body.classList.remove('watching');
  });
};
TauriFeed.prototype.watchStop = function(){
  window.__TAURI__.core.invoke('watch_stop').catch(function(){});
};
/* 诊断日志与报告（问题反馈 / 异常追溯） */
TauriFeed.prototype.appLog = function(level, msg){
  window.__TAURI__.core.invoke('app_log', { level: level, msg: msg }).catch(function(){});
};
TauriFeed.prototype.diagReport = function(cb){
  window.__TAURI__.core.invoke('diag_report').then(function(r){ cb(r||null); }).catch(function(){ cb(null); });
};

/* ===== Mock Feed：浏览器直接打开时的合成数据（UI 开发 / 演示用） ===== */
function MockFeed(){ this.timers = []; }
MockFeed.prototype._clear = function(){ this.timers.forEach(clearTimeout); this.timers = []; };
MockFeed.prototype.start = function(roots, onDone){
  var root = Array.isArray(roots) ? (roots[0] || 'C:\\') : (roots || 'C:\\');
  var self = this;
  this._clear();
  this.onDone = onDone;
  var GB = 1073741824;
  var dirs = [
    ['C:\\Users', 'C:\\', 'Users'],
    ['C:\\Users\\Demo', 'C:\\Users', 'Demo'],
    ['C:\\Users\\Demo\\AppData', 'C:\\Users\\Demo', 'AppData'],
    ['C:\\Program Files', 'C:\\', 'Program Files'],
    ['C:\\ProgramData', 'C:\\', 'ProgramData'],
    ['C:\\Windows', 'C:\\', 'Windows']
  ];
  var files = [
    ['C:\\pagefile.sys', 'C:\\', 'pagefile.sys', 25.5],
    ['C:\\hiberfil.sys', 'C:\\', 'hiberfil.sys', 6.2],
    ['C:\\Users\\Demo\\Downloads\\ubuntu-24.04.1-desktop-amd64.iso', 'C:\\Users\\Demo\\Downloads', 'ubuntu-24.04.1-desktop-amd64.iso', 5.8],
    ['C:\\Users\\Demo\\AppData\\Local\\Docker\\ext4.vhdx', 'C:\\Users\\Demo\\AppData\\Local\\Docker', 'ext4.vhdx', 12.4],
    ['C:\\Users\\Demo\\Videos\\meeting-recording.mp4', 'C:\\Users\\Demo\\Videos', 'meeting-recording.mp4', 2.3],
    ['C:\\Program Files\\SomeApp\\runtime-win.dat', 'C:\\Program Files\\SomeApp', 'runtime-win.dat', 1.6],
    ['C:\\Windows\\Installer\\feature-pack.msi', 'C:\\Windows\\Installer', 'feature-pack.msi', 1.2],
    // 常见扩展名样本：类型统计视图有东西可看
    ['C:\\Users\\Demo\\Downloads\\dev-setup.zip', 'C:\\Users\\Demo\\Downloads', 'dev-setup.zip', 0.83],
    ['C:\\Users\\Demo\\Pictures\\IMG_2046.jpg', 'C:\\Users\\Demo\\Pictures', 'IMG_2046.jpg', 0.012],
    ['C:\\Users\\Demo\\Documents\\annual-report.pdf', 'C:\\Users\\Demo\\Documents', 'annual-report.pdf', 0.024]
  ];
  dirs.forEach(function(d, i){
    self.timers.push(setTimeout(function(){
      applyEvent({ path:d[0], parent:d[1], name:d[2], size:0, done:false, file:false });
    }, i*350));
  });
  files.forEach(function(f, i){
    self.timers.push(setTimeout(function(){
      applyEvent({ path:f[0], parent:f[1], name:f[2], size:Math.round(f[3]*GB), done:true, file:true });
    }, 700+i*250));
  });
  // 云占位演示（OneDrive 按需文件）：逻辑大小在，本地不占磁盘（占用口径为 0）。
  // 时机放在 Documents 占位（10800ms）之后，保证挂进真实目录而不是 ensureChain 的影子链
  self.timers.push(setTimeout(function(){
    applyEvent({ path:'C:\\Users\\Demo\\Documents\\cloud-archive.pst', parent:'C:\\Users\\Demo\\Documents',
                 name:'cloud-archive.pst', size:Math.round(2.2*GB), al:0, done:true, file:true, cloud:true });
  }, 11600));
  var growth = { 'C:\\Users':59.5, 'C:\\Users\\Demo':58.4, 'C:\\Users\\Demo\\AppData':34.8,
                 'C:\\Program Files':7.85, 'C:\\ProgramData':5.39, 'C:\\Windows':21.3, 'C:\\':140 };
  var ticks = 12;
  for(var t = 1; t <= ticks; t++){
    (function(frac){
      self.timers.push(setTimeout(function(){
        for(var p in growth){
          var target = growth[p]*GB;
          var base = p === 'C:\\' ? 31.7*GB : target*0.06;
          var parts = p.split('\\');
          applyEvent({ path:p, parent:parts.slice(0,-1).join('\\'), name:parts[parts.length-1],
                       size:Math.round(base+(target-base)*frac/ticks), done:false, file:false });
        }
      }, 800+t*420));
    })(t);
  }
  // 第二波：深层目录"晚些才被扫到"并渐进生长（模拟真实 DFS 越扫越深，下钻有东西可看）
  var late = [
    ['C:\\Users\\Demo\\AppData\\Local', 'C:\\Users\\Demo\\AppData', 'Local', 25.2, 9200],
    ['C:\\Users\\Demo\\AppData\\LocalLow', 'C:\\Users\\Demo\\AppData', 'LocalLow', 0.8, 9600],
    ['C:\\Users\\Demo\\AppData\\Roaming', 'C:\\Users\\Demo\\AppData', 'Roaming', 8.1, 10000],
    ['C:\\Users\\Demo\\Desktop', 'C:\\Users\\Demo', 'Desktop', 6.0, 10400],
    ['C:\\Users\\Demo\\Documents', 'C:\\Users\\Demo', 'Documents', 3.5, 10800],
    ['C:\\Users\\Demo\\Downloads', 'C:\\Users\\Demo', 'Downloads', 26.1, 11200],
    ['C:\\Users\\Demo\\.vscode', 'C:\\Users\\Demo', '.vscode', 2.0, 11600],
    ['C:\\Program Files\\Windows Apps', 'C:\\Program Files', 'Windows Apps', 4.2, 12000],
    ['C:\\ProgramData\\Microsoft', 'C:\\ProgramData', 'Microsoft', 3.1, 12400],
    ['C:\\Windows\\System32', 'C:\\Windows', 'System32', 6.1, 12800]
  ];
  var growth2 = {
    'C:\\Users\\Demo\\AppData\\Local':25.2, 'C:\\Users\\Demo\\AppData\\Roaming':8.1,
    'C:\\Users\\Demo\\AppData\\LocalLow':0.8, 'C:\\Users\\Demo\\Desktop':6.0,
    'C:\\Users\\Demo\\Documents':3.5, 'C:\\Users\\Demo\\Downloads':26.1,
    'C:\\Users\\Demo\\.vscode':2.0, 'C:\\Program Files\\Windows Apps':4.2,
    'C:\\ProgramData\\Microsoft':3.1, 'C:\\Windows\\System32':6.1
  };
  late.forEach(function(d){
    self.timers.push(setTimeout(function(){
      applyEvent({ path:d[0], parent:d[1], name:d[2], size:0, done:false, file:false });
    }, d[4]));
  });
  var ticks2 = 9;
  for(var t2 = 1; t2 <= ticks2; t2++){
    (function(frac){
      self.timers.push(setTimeout(function(){
        for(var p in growth2){
          var target = growth2[p]*GB;
          var parts = p.split('\\');
          applyEvent({ path:p, parent:parts.slice(0,-1).join('\\'), name:parts[parts.length-1],
                       size:Math.round(target*frac/ticks2), done:false, file:false });
        }
      }, 13200+t2*620));
    })(t2);
  }
  var allPaths = {};
  for(var gp in growth) allPaths[gp] = growth[gp];
  for(var gp2 in growth2) allPaths[gp2] = growth2[gp2];
  self.timers.push(setTimeout(function(){
    for(var p in allPaths){
      var parts = p.split('\\');
      // Windows Apps 是真实的 ACL 受限目录案例：体积为已读到的部分（演示 ⛔ 标记）
      var denied = p === 'C:\\Program Files\\Windows Apps';
      applyEvent({ path:p, parent:parts.slice(0,-1).join('\\'), name:parts[parts.length-1],
                   size:Math.round(allPaths[p]*GB), done:true, file:false, denied:denied });
    }
    var msg = '模拟扫描完成';
    if(self.onDone) self.onDone(msg);
    else { setStatus(msg, 'done'); setScanning(false); autoExpandView(); }
  }, 13200+(ticks2+1)*620));
};
MockFeed.prototype.stop = function(){
  this._clear(); setStatus('已停止','done'); setScanning(false);
};
MockFeed.prototype.open = function(p){
  setStatus('浏览器模式：打开文件夹需在 Tauri 客户端内使用','err');
};
MockFeed.prototype.shellContextMenu = function(){
  setStatus('浏览器模式：调出系统右键菜单需在 Tauri 客户端内使用','err');
};

/* ===== Mock 迁移：模拟三阶段事务事件流（浏览器演示用） ===== */
MockFeed.prototype.listVolumes = function(cb){
  setTimeout(function(){
    cb([
      { mount:'C:\\', label:'System', fs:'NTFS', free_bytes:21953699840, total_bytes:215047204864 },
      { mount:'D:\\', label:'Data',   fs:'NTFS', free_bytes:28901150720, total_bytes:273803112448 },
      { mount:'E:\\', label:'Archive',fs:'NTFS', free_bytes:505385566208, total_bytes:1000186310656 }
    ]);
  }, 150);
};
/* AI 联动通道桩：浏览器模式无本地 HTTP 服务，全部 no-op（面板提示不可用） */
MockFeed.prototype.aiSnapshot = function(){};
MockFeed.prototype.aiChannelInfo = function(cb){ cb(null); };
MockFeed.prototype.aiChannelSetEnabled = function(){};
MockFeed.prototype.aiChannelRotateToken = function(cb){ cb && cb(); };
MockFeed.prototype.aiProposalResult = function(){};
MockFeed.prototype.aiProposalGet = function(cb){ cb(null); };
MockFeed.prototype.migrateCheck = function(src, destRoot, cb){
  setTimeout(function(){
    var node = store.get(src.toLowerCase());
    var bytes = node ? node.s : 6 * 1073741824;
    if (/\\windows(\\|$)/i.test(src)) {
      cb({ ok:false, blockers:['系统目录（C:\\Windows）不可迁移'], warnings:['开始迁移前请关闭正在使用该目录的程序'],
           src_bytes:bytes, src_files:12345, dest_path:destRoot+'\\'+src.split('\\').pop(),
           dest_free:28901150720, same_volume:false });
    } else {
      cb({ ok:true, blockers:[], warnings:['（模拟）开始迁移前请关闭正在使用该目录的程序'],
           src_bytes:bytes, src_files:8642, dest_path:destRoot+'\\'+src.split('\\').pop(),
           dest_free:505385566208, same_volume:false });
    }
  }, 400);
};
MockFeed.prototype.migrateStart = function(src, destRoot){
  var self = this;
  this._clear();
  this._migStopped = false;
  var node = store.get(src.toLowerCase());
  var total = node ? node.s : 6 * 1073741824;
  var files = 8642;
  var handler = window.__migHandler || function(){};
  var ticks = 12, t = 0;
  function tick(){
    if (self._migStopped) { self._migStopped = false; handler({ stage:'aborted', message:'已停止：已完成部分保留，重新发起会自动续传', locked:[], bytes_done:0, bytes_total:0, files_done:0, files_total:0, current:'' }); return; }
    t++;
    if (t <= ticks) {
      handler({ stage:'copy', message:'复制中…', locked:[], bytes_done:Math.round(total*t/ticks), bytes_total:total,
                files_done:Math.round(files*t/ticks), files_total:files, current:src+'\\file-'+t+'.dat' });
      self.timers.push(setTimeout(tick, 280));
    } else if (t === ticks+1) {
      handler({ stage:'verify', message:'校验中…', locked:[], bytes_done:total, bytes_total:total, files_done:files, files_total:files, current:'' });
      self.timers.push(setTimeout(tick, 500));
    } else if (t === ticks+2) {
      handler({ stage:'switch', message:'切换中：删除源目录内容…', locked:[], bytes_done:total, bytes_total:total, files_done:files, files_total:files, current:'' });
      self.timers.push(setTimeout(tick, 400));
    } else {
      handler({ stage:'done', message:'（模拟）迁移完成：原路径已是指向新位置的 junction', locked:[], bytes_done:total, bytes_total:total, files_done:files, files_total:files, current:'' });
    }
  }
  self.timers.push(setTimeout(tick, 200));
};
MockFeed.prototype.migrateStop = function(){ this._migStopped = true; };
/* Mock 优先扫描：600ms 后把该目录补成 done 并造几个子项，让"优先调度"在浏览器里可演示 */
MockFeed.prototype.scanRefresh = function(){};
MockFeed.prototype.recycleDelete = function(paths, cb, onProgress){
  if(onProgress) setTimeout(function(){
    onProgress({current:paths[0], done:1, total:2});
  }, 100);
  setTimeout(function(){ cb([]); }, 300);
};
MockFeed.prototype.migrateUndo = function(src, destRoot){
  // 模拟撤销：switch（删链接）→ done，走 __migHandler 事件流
  var handler = window.__migHandler || function(){};
  setTimeout(function(){ handler({ stage:'switch', message:'已移除 junction，正在恢复原目录…', current:'', bytes_done:0, bytes_total:0, files_done:0, files_total:0, locked:[] }); }, 200);
  setTimeout(function(){ handler({ stage:'done', message:'撤销完成：数据已回到原位', current:'', bytes_done:0, bytes_total:0, files_done:0, files_total:0, locked:[] }); }, 700);
};
MockFeed.prototype.scanPriority = function(p){
  this.timers.push(setTimeout(function(){
    var n = store.get(p.toLowerCase());
    completePriority(p);
    if(!n || n.done || n.f) return;
    var GB = 1073741824;
    var base = Math.max(n.s, 3*GB);
    var root = p.replace(/\\+$/,'');
    var kids = [['alpha-data',0.42],['cache-store',0.27],['logs-archive',0.11]];
    kids.forEach(function(k,i){
      applyEvent({ path:root+'\\'+k[0], parent:root, name:k[0],
                   size:Math.round(base*k[1]), done:true, file:false });
    });
    applyEvent({ path:p, name:n.n, size:Math.round(base*1.08), done:true, file:false });
  }, 600));
};
/* 浏览器模式无文件系统监视：no-op（模拟扫描完成不触发 setWatch） */
MockFeed.prototype.watchStart = function(){};
MockFeed.prototype.watchStop = function(){};
MockFeed.prototype.appLog = function(){};
MockFeed.prototype.diagReport = function(cb){ cb(null); };

/* 启动屏淡出 + 原生窗口显示（窗口配置为启动时隐藏，页面就绪后才出现，避免白屏） */
function hideSplash(){
  var sp = document.getElementById('splash');
  if(sp && !sp.classList.contains('hide')){
    var h = document.getElementById('sp-hint');
    if(h) h.textContent = '就绪';
    sp.classList.add('hide');
    setTimeout(function(){ if(sp.parentNode) sp.parentNode.removeChild(sp); }, 500);
  }
  try{
    if(IN_TAURI){
      // 显示窗口由 Rust 决定焦点策略：--no-focus 启动（更新重启等）不抢前台
      window.__TAURI__.core.invoke('show_window').catch(function(){});
    }
  }catch(e){}
}

/* ===== 启动 ===== */
window.addEventListener('DOMContentLoaded', function(){
  // 全局 JS 异常捕获 → 诊断日志（反馈/追溯用）
  window.addEventListener('error', function(ev){
    diagLog('error', 'JS 异常: ' + (ev.message||'') + ' @ ' + (ev.filename||'?') + ':' + (ev.lineno||0));
  });
  window.addEventListener('unhandledrejection', function(ev){
    var r = ev.reason;
    diagLog('error', '未处理的 Promise 拒绝: ' + (r && (r.stack || r.message) || String(r)).slice(0, 300));
  });

  window.map = document.getElementById('map');
  window.rootInput = document.getElementById('root-input');
  window.statusEl = document.getElementById('status');
  ROOTS = ['C:\\'];
  window.ROOT = ROOTS[0];
  window.curPath = window.ROOT;
  feed = IN_TAURI ? new TauriFeed() : new MockFeed();
  setView('treemap');
  if(IN_TAURI){
    diagLog('info', '启动');
    // 上次会话异常退出 → 提示用户可在「关于」里带日志反馈
    feed.diagReport(function(d){
      if(d && d.lastAbnormal){
        window.__diagAbnormal = true;
        diagLog('warn', '检测到上次会话异常退出（panic ' + (d.panics||0) + ' 次）');
        setTimeout(function(){
          setStatus('⚠ 上次会话异常退出——可在「关于」面板带日志反馈', 'err');
        }, 2600);
      }
    });
    // 启动秒开：恢复上次扫描摘要（数据可能过期，重扫一次即刷新并落入历史对比）
    restoreScanCache(function(meta){
      if(meta && meta.root){
        ROOTS = meta.root.split(',').filter(Boolean);
        window.ROOT = ROOTS[0];
        window.curPath = isMultiRoot() ? THISPC : ROOTS[0];
        ensurePcRoot();
        scopeAt[scopeKey(ROOTS)] = meta.at;   // 该范围完成时间（切走再切回时提示用）
        rememberScope();
        var restored = scopeKey(ROOTS);
        setTimeout(function(){
          if(!scanning && curScopeKey()===restored && scopeAt[restored]===meta.at) pushAiSnapshot(meta.at);
        }, 300);
        setStatus('已恢复上次扫描结果（' + Math.max(1, Math.round((Date.now()-meta.at)/3600000)) + ' 小时前）· 建议重新扫描刷新', 'done');
        markDirty();
      }
    });
    // 上次会话遗留的待确认提案：落盘恢复（多盘可并存），弹最新一条（误关/重启都不丢）
    if(feed.aiProposalGet) feed.aiProposalGet(function(list){
      if(typeof restoreProposals === 'function'){
        setTimeout(function(){ restoreProposals(list||[]); }, 600);   // 等首帧渲染完再弹
      }
    });
  }
  if(!IN_TAURI){
    // 浏览器模式：自动跑一轮合成扫描，打开页面即可看到完整交互
    ROOTS = [window.ROOT];
    setScanning(true);
    setStatus('浏览器模式（合成数据）');
    render();
    feed.start(window.ROOT);
  }

  document.getElementById('views').addEventListener('click', function(ev){
    var seg = ev.target.closest('.seg');
    if(seg) setView(seg.dataset.view);
  });
  document.getElementById('expand-pct').addEventListener('change', applyExpandSettings);
  document.getElementById('expand-depth').addEventListener('change', applyExpandSettings);
  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('stop-btn').addEventListener('click', function(){
    setStatus('正在停止扫描…', 'scanning');
    if(localScanning){
      localStopPending = true;
      priQueue = []; priQueued = {}; priInflight = [];
    }
    feed.stop();
  });

  /* 盘符下拉：列出本地卷，选中只切换展示范围（上次结果秒开），不自动扫描 */
  var drivesSel = document.getElementById('root-drives');
  drivesSel.addEventListener('change', function(){
    if(!this.value) return;
    if (scanning) {
      // 扫描进行中切换范围会与引擎状态错位——先恢复选中项再提示
      setStatus('扫描进行中——请先「停止」再切换扫描范围', 'err');
      syncPathControls();
      return;
    }
    switchScope(this.value);
  });
  window.rootInput.addEventListener('change', commitPathInput);
  window.rootInput.addEventListener('keydown', function(ev){
    if(ev.key==='Enter'){ ev.preventDefault(); commitPathInput(); }
  });
  window.addEventListener('focus', loadDrives);   // 插拔 U 盘等场景重新枚举
  loadDrives();

  // 页面与首帧渲染就绪：淡出启动屏、显示原生窗口
  setTimeout(hideSplash, 350);
});

/* ===== 切换展示范围（盘符下拉）：只切视图，不自动扫描 =====
   该范围扫过（本会话内存或启动缓存恢复）→ 秒开上次结果并提示多久前；
   没扫过 → 清掉上一范围画面，提示点「开始扫描」。其他范围的数据原样留在
   store/fileIndex 里（键按盘符前缀不冲突），大文件榜/类型统计按范围过滤展示 */
function switchScope(picked){
  if (watchActive) setWatch(false);   // 监视挂在原扫描范围上，切走就停，避免摘要误报
  var roots = picked === THISPC
    ? drivesCache.map(function(v){ return v.mount; })
    : [picked];
  if(!roots.length) roots = ['C:\\'];
  ROOTS = roots;
  window.ROOT = ROOTS[0];
  window.curPath = isMultiRoot() ? THISPC : ROOTS[0];
  rememberScope();                    // 刷新使用顺序并逐出超限的最旧范围（内存上限）
  clearViewBodies();                  // 丢弃上一范围的渲染块（数据仍在，切回即重绘）
  window.expanded = {}; window.stack = []; selectedRow = '';
  fileSearch = '';
  var fsInp = document.getElementById('file-search');
  if(fsInp) fsInp.value = '';
  prevCacheLoaded = false; prevCache = null;   // 历史对比基线按新范围重读
  ensurePcRoot();
  syncPathControls();
  volUsed = 0; volTotal = 0;
  loadDrives();                        // 卷已用/容量跟随新范围
  var rootKey = String(window.ROOT).toLowerCase();
  var rootNode = store.get(rootKey);
  var hasData = isMultiRoot()
    ? ROOTS.every(function(root){ var n = store.get(root.toLowerCase()); return n && n.done; })
    : !!(rootNode && rootNode.done);
  var place = isMultiRoot() ? '全部磁盘' : String(window.ROOT);
  var at = scopeAt[curScopeKey()];
  if(hasData){
    setStatus('已切换到 ' + place + ' · 显示上次扫描结果' + (at ? '（' + fmtAge(Date.now() - at) + '前）' : '') + ' · 点「开始扫描」刷新', 'done');
  } else {
    setStatus('已切换到 ' + place + ' · 该范围尚未扫描，点「开始扫描」开始', '');
  }
  syncDrivesSelect();
  markDirty();
}

/* ===== 开始扫描：输入框/盘符下拉/「全部磁盘」共用 ===== */
var drivesCache = [];   // loadDrives 枚举的卷列表（「全部磁盘」的 roots 来源）
var pathInControls;

function pathFromControls(){
  var mount = document.getElementById('root-drives').value;
  if(mount===THISPC) return THISPC;
  var input = window.rootInput.value.trim().replace(/\//g,'\\');
  var absolute = input.match(/^[a-z]:(?:\\|$)/i);
  if(absolute){
    mount = input.slice(0,2).toUpperCase()+'\\';
    input = input.slice(2);
  }
  if(!mount || input.startsWith('\\\\') || /[:*?"<>|\x00-\x1f]/.test(input)) return null;
  var segments = [];
  for(var part of input.split('\\')){
    if(!part || part==='.') continue;
    if(part==='..'){
      if(!segments.length) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return mount+segments.join('\\');
}

function commitPathInput(){
  if(scanning){ syncPathControls(); return; }
  var path = pathFromControls();
  if(!path){ setStatus('请输入有效的盘内路径', 'err'); return; }
  if(path.toLowerCase()===curPath.toLowerCase()){
    syncPathControls();
  } else if(path!==THISPC && inScope(path) && store.has(path.toLowerCase())){
    var node = store.get(path.toLowerCase());
    if(node.f){ setStatus('请输入文件夹路径', 'err'); return; }
    navigate(node.p);
  } else {
    switchScope(path);
  }
}

function startScan(){
  if (scanning) { setStatus('扫描进行中——请先「停止」再切换扫描范围', 'err'); return; }
  var picked = pathFromControls();
  if(!picked){ setStatus('请输入有效的盘内路径', 'err'); return; }
  var roots;
  if (picked === THISPC) {
    roots = drivesCache.map(function(v){ return v.mount; });
    if(!roots.length) roots = ['C:\\'];
  } else {
    roots = [picked];
  }
  startScanRoots(roots, needsDetailedScan(roots));
}

function needsDetailedScan(roots){
  return roots.some(function(path){
    var node = store.get(path.toLowerCase());
    return node && node.summarized;
  });
}

function startScanRoots(roots, full){
  if(scanning || localScanning || scanPending){
    setStatus('已有扫描在进行，请先等它结束或点击「停止」', 'scanning');
    return;
  }
  if(!IN_TAURI) beginScanUI(roots, full);
  feed.start(roots, full);
  diagLog('info', '开始扫描: ' + roots.join(','));
}

/* ===== 盘符下拉：枚举本地卷（复用迁移对话框的 list_volumes） ===== */
function loadDrives(){
  feed.listVolumes(function (vols) {
    var sel = document.getElementById('root-drives');
    if(!sel) return;
    var list = (vols || []).filter(function (v) { return v.mount && v.mount.length >= 3; });
    if(!list.length) return;
    drivesCache = list;
    var html = '';
    if (IN_TAURI && list.length > 1) {
      var totFree = 0, totAll = 0;
      for (var q = 0; q < list.length; q++) { totFree += list[q].free_bytes||0; totAll += list[q].total_bytes||0; }
      html += '<option value="' + escAttr(THISPC) + '">💻 全部磁盘（' + list.length + ' 个 · 剩余 ' + fmt(totFree) + ' / ' + fmt(totAll) + '）</option>';
    }
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      html += '<option value="' + escAttr(v.mount) + '">' + esc(v.mount + (v.label ? ' ' + v.label : '') +
        ' · 剩余 ' + fmt(v.free_bytes)) + '</option>';
    }
    sel.innerHTML = html;
    syncDrivesSelect();
    // 扫描范围内卷的已用/总容量合计：summary「卷已用 / 未计入」的数据源
    var used = 0, total = 0, hit = false;
    var scope = isMultiRoot() ? ROOTS.map(function(r){ return r.toLowerCase(); }) : [String(window.ROOT||'C:\\').toLowerCase()];
    for (var j = 0; j < list.length; j++) {
      var mnt = list[j].mount.toLowerCase();
      for (var s = 0; s < scope.length; s++) {
        var rl = scope[s];
        if (rl.indexOf(mnt) === 0 || rl.slice(0, 3) === mnt.slice(0, 3)) {
          used += (list[j].total_bytes||0) - (list[j].free_bytes||0);
          total += list[j].total_bytes||0;
          hit = true;
          break;
        }
      }
    }
    if (hit) { volUsed = used; volTotal = total; }
    markDirty();   // summary 随下一次渲染刷新
  });
}

function syncDrivesSelect(){
  var sel = document.getElementById('root-drives');
  var mount = curPath===THISPC ? THISPC : String(curPath||window.ROOT).slice(0,3).toUpperCase();
  var option = Array.from(sel.options).find(function(o){ return o.value.toUpperCase()===mount; });
  if(!option){
    option = new Option(mount===THISPC ? '全部磁盘' : mount, mount);
    sel.add(option);
  }
  sel.value = option.value;
}

function syncPathControls(){
  pathInControls = curPath;
  syncDrivesSelect();
  window.rootInput.disabled = curPath===THISPC;
  window.rootInput.value = curPath===THISPC ? '' : curPath.slice(3);
  window.rootInput.title = curPath===THISPC ? '全部磁盘' : curPath;
}
