/* DiskLens main —— Feed 抽象（Tauri 事件 / 浏览器 Mock）+ 视图调度 + 工具栏。
   全局状态（store/curPath/stack/divs/expanded…）由 treemap.js 声明，本文件只驱动。 */

var feed;
var dirty = false;
var IN_TAURI = !!window.__TAURI__;
var viewMode = 'treemap';
var fileIndex = new Map();   // lower(path) -> 文件节点（供大文件榜使用）
var scanning = false;
var scanT0 = 0;
var watchActive = false;     // 扫描完成后的实时监视（fs-batch 增量应用）
var watchChanges = 0;        // 本次监视会话累计收到的变更条数
var BIG_FILE_MIN = 10 * 1024 * 1024;   // 与后端 MIN_BIG_FILE 一致：小于此值的文件扫描时不入树

var VIEW_HINTS = {
  treemap: '单击展开/收起 · 双击进入 · 右键更多操作',
  list:    '双击进入目录 · 单击表头排序 · 右键更多操作',
  files:   '双击定位所在目录 · 「定位」在资源管理器中选中'
};

function markDirty(){ dirty = true; }

function ensureChain(path){
  var k = path.toLowerCase();
  var n = store.get(k);
  if(n) return n;
  var idx = path.lastIndexOf('\\');
  var parent = idx > 0 ? path.slice(0, idx + 1) : '';   // 含反斜杠：'C:\Users'→'C:\'
  if(parent === path) parent = '';                       // 盘根自身即顶，无上级
  var name = idx > 0 ? path.slice(idx+1) : path;
  if(!name) name = path;                                 // 盘根 'C:\' 的尾反斜杠让末段为空
  var pn = parent ? ensureChain(parent) : null;
  n = { n: name, s: 0, done: false, p: path, f: false, c: [] };
  store.set(k, n);
  if(pn && !pn.c.includes(n)) pn.c.push(n);
  return n;
}
function applyEvent(ev){
  var n = ensureChain(ev.path);          // 自身 + 祖先链全部就位（事件乱序到达也健壮）
  if(ev.name) n.n = ev.name;             // 空名（盘根 growth 事件）不覆盖
  n.f = ev.file || n.f;
  var oldS = n.s || 0;
  n.s = ev.size;
  n.done = ev.done;
  var idx = ev.path.lastIndexOf('\\');
  var parentPath = idx > 0 ? ev.path.slice(0, idx) : '';
  if(parentPath){
    var pn = store.get(parentPath.toLowerCase());
    if(pn && !pn.c.includes(n)) pn.c.push(n);   // 时序原因成孤儿的自动回挂
  }
  // 监视模式下优先扫描把体积带回来：差值沿祖先传播（子目录 done 只补差值，
  // 级联天然自洽）。扫描期间严禁传播——祖先体积由引擎统一结算
  if(!scanning && watchActive) propDelta(ev.path, (n.s||0) - oldS);
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
// 体积差值沿祖先链传播（仅监视模式用；扫描时祖先体积由引擎统一结算，不能传播）
function propDelta(path, delta) {
  if (!delta) return;
  var p = parentPathOf(path);
  while (p) {
    var pn = store.get(p.toLowerCase());
    if (!pn) break;
    pn.s = Math.max(0, pn.s + delta);
    p = parentPathOf(p);
  }
}
// 删除节点及其整个子树（store/fileIndex/expanded），返回被删子树总体积
function removeSubtree(path) {
  var lower = path.toLowerCase();
  var n = store.get(lower);
  if (!n) return 0;
  var total = n.s || 0;
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
  return total;
}
// 新目录出现：占位（统计中）并排队优先扫描，扫完 done 事件把真实体积带回来
var priQueue = [], priQueued = {}, priInflight = [], PRI_MAX = 2;
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
function checkPriorityDone() {
  for (var i = 0; i < priInflight.length; i++) {
    var n = store.get(priInflight[i].toLowerCase());
    if (n && n.done) {
      delete priQueued[priInflight[i].toLowerCase()];
      priInflight.splice(i, 1);
      i--;
      pumpPriority();
    }
  }
}
function applyFsBatch(batch) {
  if (!watchActive || !Array.isArray(batch) || !batch.length) return;
  var changed = 0;
  for (var i = 0; i < batch.length; i++) {
    var ev = batch[i];
    if (!ev || !ev.path) continue;
    var lower = ev.path.toLowerCase();
    if (ev.kind === 'remove') {
      var total = removeSubtree(ev.path);
      propDelta(ev.path, -total);   // 未入树的路径 total=0，传播 0 无副作用
      changed++;
    } else if (ev.kind === 'upsert') {
      var n = store.get(lower);
      if (ev.is_dir) {
        if (!n) {
          // 新目录：入树占位（统计中），祖先体积不变（其内容体积随后由优先扫描结算）
          applyEvent({ path: ev.path, size: 0, done: false, file: false });
          queuePriority(ev.path);
          changed++;
        } else if (!n.done) {
          queuePriority(ev.path);   // 之前占位还没扫完（或上次队列没轮到），再排一次
        }
      } else {
        // 文件：与扫描同语义，只关心 ≥10MB 的大文件或已在树里的（小文件本就不入树）
        if (!n && ev.size < BIG_FILE_MIN) continue;
        // 体积差值由 applyEvent 统一传播（监视模式下），这里不再手动传播以免重复
        applyEvent({ path: ev.path, size: ev.size, done: true, file: true });
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
    feed.watchStart(root);
  } else {
    watchActive = false;
    priQueue = []; priQueued = {}; priActive = 0; priInflight = [];
    document.body.classList.remove('watching');
    feed.watchStop();
  }
}
(function loop(){
  if(dirty){
    dirty = false;
    try { render(); }
    catch(e){
      window.__errs = window.__errs || [];
      window.__errs.push('render: ' + e.message);
      try { setStatus('渲染异常：' + e.message, 'err'); } catch(_) {}
    }
  }
  try { checkPriorityDone(); } catch(_) {}
  setTimeout(loop, 120);
})();

/* ===== 视图调度 ===== */
function render(){
  if(!curPath) return;
  var node = store.get(curPath.toLowerCase());
  if(!node) return;
  updateCrumb(node);
  if(viewMode === 'treemap') renderTreemap();
  else if(viewMode === 'list') renderList(node);
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
  var acc=ROOT;
  if(stack.length){
    // stack[0] 若就是根自身则不重复渲染根面包屑
    var start=0;
    if(stack[0].path.toLowerCase()===String(ROOT).toLowerCase()){ acc=stack[0].path; start=1; }
    else mk(ROOT,ROOT);
    for(var i=start;i<stack.length;i++){ acc=stack[i].path;
      b.appendChild(sep()); mk(stack[i].name,acc); }
    b.appendChild(sep());
  }
  var cb=document.createElement('b'); cb.textContent=node.n+' = '+fmt(node.s); b.appendChild(cb);
}
function updateSummary(node){
  var root=store.get((window.ROOT||'C:\\').toLowerCase());
  var parts=[];
  if(root&&root.s>0) parts.push((scanning?'已扫描 ':'根目录总计 ')+'<b>'+fmt(root.s)+'</b>');
  if(scanning&&scanT0) parts.push('用时 '+((Date.now()-scanT0)/1000).toFixed(1)+'s');
  if(watchActive) parts.push('<span style="color:var(--green)">⏱ 实时监视中'+(watchChanges?' · 已感知 '+watchChanges+' 项变更':'')+'</span>');
  document.getElementById('summary').innerHTML=parts.join(' · ');
  var st=document.getElementById('foot-stats');
  if(node) st.innerHTML='当前 <b>'+esc(node.n)+'</b> · '+node.c.length+' 项';
}

/* ===== 工具栏 ===== */
function setStatus(s, cls){
  var el = document.getElementById('status');
  if(el) el.textContent = s;
  document.body.classList.remove('scanning','done','err');
  if(cls) document.body.classList.add(cls);
}
function setScanning(on){
  scanning = on;
  if(on) scanT0 = Date.now();
  document.getElementById('scan-btn').disabled = on;
  document.getElementById('stop-btn').disabled = !on;
  document.body.classList.toggle('scanning', on);
  if(!on) document.body.classList.remove('scanning');
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
var EXPAND_MAX_DEPTH = 3;      // 自动下钻层数上限（再深留给用户单击）
function autoExpandView(){
  var node = store.get(curPath.toLowerCase());
  if(!node) return;
  var full = (map.clientWidth||800) * (map.clientHeight||500);
  function walk(n, area, depth){
    expanded[n.p] = 1;
    if(depth >= EXPAND_MAX_DEPTH) return;
    var kids = n.c || [];
    var tot = 0; for(var i=0;i<kids.length;i++) tot += kids[i].s;
    if(tot <= 0) return;
    for(var j=0;j<kids.length;j++){
      var k = kids[j];
      if(k.f || !k.c || !k.c.length) continue;   // 文件/尚无已知子项的不展开
      // 每层标题条+内边距约吃掉两成可用面积，估算时先打八折
      var ka = area * (k.s / tot) * 0.8;
      if(ka >= EXPAND_MIN_AREA) walk(k, ka, depth+1);
    }
  }
  var kids = node.c || [];
  var tot = 0; for(var q=0;q<kids.length;q++) tot += kids[q].s;
  if(tot > 0){
    for(var w=0;w<kids.length;w++){
      var ch = kids[w];
      if(ch.f || !ch.c || !ch.c.length) continue;
      var ca = (ch.s / tot) * full;
      if(ca >= EXPAND_MIN_AREA) walk(ch, ca, 0);
    }
  }
  markDirty();
}

/* ===== Tauri Feed：invoke 扫描命令 + 监听事件流 ===== */
function TauriFeed(){
  window.__TAURI__.event.listen('scan-update', function(ev){ applyEvent(ev.payload); });
  // 并行引擎的批量事件：一批最多 256 条，一次 IPC 应用整批
  window.__TAURI__.event.listen('scan-batch', function(ev){
    var arr = ev.payload || [];
    for(var i=0;i<arr.length;i++) applyEvent(arr[i]);
  });
  window.__TAURI__.event.listen('scan-finished', function(ev){
    var msg = ev.payload || '完成';
    setStatus(msg, 'done');
    setScanning(false);
    autoExpandView();
    // 完整扫描结束后进入实时监视：文件增删改即时反映到视图
    if (!watchActive && String(msg).indexOf('扫描完成') >= 0 && window.ROOT) {
      setWatch(true, window.ROOT);
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
  window.__migHandler = null;   // migrate.js 对话框打开时接管
}
TauriFeed.prototype.start = function(root){
  setStatus('扫描中…', 'scanning');
  window.__TAURI__.core.invoke('scan_start', { root: root }).catch(function(e){
    setStatus(String(e), 'err');
    setScanning(false);
  });
};
TauriFeed.prototype.stop = function(){
  window.__TAURI__.core.invoke('scan_stop').catch(function(){});
};
TauriFeed.prototype.open = function(p, sel){
  window.__TAURI__.core.invoke('open_in_explorer', { path: p, select: !!sel }).catch(function(e){
    setStatus(String(e), 'err');
  });
};
TauriFeed.prototype.listVolumes = function(cb){
  window.__TAURI__.core.invoke('list_volumes').then(cb).catch(function(){ cb([]); });
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
  window.__TAURI__.core.invoke('scan_priority', { path: p }).catch(function(){});
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

/* ===== Mock Feed：浏览器直接打开时的合成数据（UI 开发 / 演示用） ===== */
function MockFeed(){ this.timers = []; }
MockFeed.prototype._clear = function(){ this.timers.forEach(clearTimeout); this.timers = []; };
MockFeed.prototype.start = function(root, onDone){
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
    ['C:\\Windows\\Installer\\feature-pack.msi', 'C:\\Windows\\Installer', 'feature-pack.msi', 1.2]
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
      applyEvent({ path:p, parent:parts.slice(0,-1).join('\\'), name:parts[parts.length-1],
                   size:Math.round(allPaths[p]*GB), done:true, file:false });
    }
    var msg = '模拟扫描完成';
    if(self.onDone) self.onDone(msg);
    else { setStatus(msg, 'done'); setScanning(false); autoExpandView(); }
  }, 13200+(ticks2+1)*620));
};
MockFeed.prototype.stop = function(){ this._clear(); setStatus('已停止','done'); setScanning(false); };
MockFeed.prototype.open = function(p){
  setStatus('浏览器模式：打开文件夹需在 Tauri 客户端内使用','err');
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
MockFeed.prototype.scanPriority = function(p){
  var self = this;
  this.timers.push(setTimeout(function(){
    var n = store.get(p.toLowerCase());
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
    if(IN_TAURI && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow){
      window.__TAURI__.window.getCurrentWindow().show();
    }
  }catch(e){}
}

/* ===== 启动 ===== */
window.addEventListener('DOMContentLoaded', function(){
  window.map = document.getElementById('map');
  window.rootInput = document.getElementById('root-input');
  window.statusEl = document.getElementById('status');
  window.ROOT = window.rootInput.value || 'C:\\';
  window.curPath = window.ROOT;
  feed = IN_TAURI ? new TauriFeed() : new MockFeed();
  setView('treemap');
  if(!IN_TAURI){
    // 浏览器模式：自动跑一轮合成扫描，打开页面即可看到完整交互
    setScanning(true);
    setStatus('浏览器模式（合成数据）');
    render();
    feed.start(window.ROOT);
  }

  document.getElementById('views').addEventListener('click', function(ev){
    var seg = ev.target.closest('.seg');
    if(seg) setView(seg.dataset.view);
  });
  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('stop-btn').addEventListener('click', function(){ feed.stop(); });

  /* 盘符下拉：列出本地卷，选中即填入输入框并直接开始扫描 */
  var drivesSel = document.getElementById('root-drives');
  drivesSel.addEventListener('change', function(){
    if(!this.value) return;
    window.rootInput.value = this.value;
    startScan();
  });
  window.addEventListener('focus', loadDrives);   // 插拔 U 盘等场景重新枚举
  loadDrives();

  // 页面与首帧渲染就绪：淡出启动屏、显示原生窗口
  setTimeout(hideSplash, 350);
});

/* ===== 开始扫描：输入框/盘符下拉共用 ===== */
function startScan(){
  window.ROOT = window.rootInput.value || 'C:\\';
  window.curPath = window.ROOT;
  if (watchActive) setWatch(false);   // 换盘重扫前先停掉旧根的监视
  store.clear(); fileIndex.clear(); window.divs = {}; window.map.innerHTML = '';
  document.getElementById('list').innerHTML = '';
  document.getElementById('files').innerHTML = '';
  window.expanded = {}; window.stack = []; selectedRow = '';
  setScanning(true);
  setStatus('扫描中…', 'scanning');
  syncDrivesSelect();
  render();
  feed.start(window.ROOT);
}

/* ===== 盘符下拉：枚举本地卷（复用迁移对话框的 list_volumes） ===== */
function loadDrives(){
  feed.listVolumes(function (vols) {
    var sel = document.getElementById('root-drives');
    if(!sel) return;
    var list = (vols || []).filter(function (v) { return v.mount && v.mount.length >= 3; });
    if(!list.length){ sel.style.display = 'none'; return; }   // 枚举失败则隐藏，不占顶栏位置
    var html = '<option value="">磁盘…</option>';
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      html += '<option value="' + escAttr(v.mount) + '">' + esc(v.mount + (v.label ? ' ' + v.label : '') +
        ' · 剩余 ' + fmt(v.free_bytes)) + '</option>';
    }
    sel.innerHTML = html;
    syncDrivesSelect();
  });
}

/* 输入框路径与下拉选中项保持一致；自定义路径时回落到占位项 */
function syncDrivesSelect(){
  var sel = document.getElementById('root-drives');
  if(!sel || sel.style.display === 'none') return;
  var cur = (window.ROOT || '').toUpperCase();
  sel.selectedIndex = 0;
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value.toUpperCase() === cur) { sel.selectedIndex = i; break; }
  }
}
