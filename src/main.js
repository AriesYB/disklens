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

// ===== 双口径 / 差额透明化 =====
// s = 逻辑大小（size），al = 磁盘占用（簇对齐/云占位 0/硬链接副本计 0）
var deniedCount = 0;         // 无权限目录数（当前扫描范围）
var deniedSeen = {};         // 去重：同一目录可能收到多次 denied 事件
var volUsed = 0;             // 当前根所在卷的已用空间（list_volumes 的 total-free；0=未知）
var volTotal = 0;            // 同上：卷总容量（0=未知）
var aiSnapReady = false;     // 已向 AI 通道推送过至少一次扫描快照
var aiPushTimer = null;      // 监视模式下周期性重推快照的定时器
// 节点的磁盘占用兜底：老事件/模拟数据没有 al 时回退逻辑大小
function alOf(n) { return (n && n.al != null) ? n.al : (n ? n.s : 0); }

var VIEW_HINTS = {
  treemap: '单击展开/收起 · 双击进入 · 右键更多操作',
  list:    '双击进入目录 · 单击表头排序 · 右键更多操作',
  files:   '双击定位所在目录 · 「定位」在资源管理器中选中 · 顶部可按名称搜索（含目录）',
  types:   '单击类型行 → 查看该扩展名的全部大文件'
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
  n = { n: name, s: 0, al: 0, done: false, p: path, f: false, c: [] };
  store.set(k, n);
  if(pn && !pn.c.includes(n)) pn.c.push(n);
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
  // 标记字段只置位不清除：done 事件晚于占位事件，不能回滚已知的受限/占位状态
  if(ev.dup) n.dup = true;
  if(ev.cloud) n.cloud = true;
  if(ev.denied){
    n.denied = true;
    var dk = ev.path.toLowerCase();
    if(!deniedSeen[dk]){ deniedSeen[dk] = 1; deniedCount++; }
  }
  var idx = ev.path.lastIndexOf('\\');
  var parentPath = idx > 0 ? ev.path.slice(0, idx) : '';
  if(parentPath){
    var pn = store.get(parentPath.toLowerCase());
    if(pn && !pn.c.includes(n)) pn.c.push(n);   // 时序原因成孤儿的自动回挂
  }
  // 监视模式下优先扫描把体积带回来：差值沿祖先传播（子目录 done 只补差值，
  // 级联天然自洽）。扫描期间严禁传播——祖先体积由引擎统一结算
  if(!scanning && watchActive) propDelta(ev.path, (n.s||0) - oldS, n.al - oldAl);
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
  if (!n) return 0;
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
      var rm = removeSubtree(ev.path);
      propDelta(ev.path, -rm.s, -rm.al);   // 未入树的路径合计=0，传播 0 无副作用
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
    feed.watchStart(root);
    // 监视模式：快照周期性重推，AI 拉到的始终接近实时
    if (aiPushTimer) clearInterval(aiPushTimer);
    aiPushTimer = setInterval(pushAiSnapshot, 15000);
  } else {
    watchActive = false;
    priQueue = []; priQueued = {}; priActive = 0; priInflight = [];
    document.body.classList.remove('watching');
    feed.watchStop();
    if (aiPushTimer) { clearInterval(aiPushTimer); aiPushTimer = null; }
  }
}

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
    if ((k.s || 0) >= AI_SNAP_MIN) { if (k.f) fileLeaves.push(k); else dirs.push(k); }
    else { agg.n++; agg.s += k.s || 0; agg.al += alOf(k); }
  }
  dirs.sort(function(a,b){ return b.s-a.s; });
  fileLeaves.sort(function(a,b){ return b.s-a.s; });
  var o = { n: n.n, p: n.p, s: n.s || 0, al: alOf(n) };
  if (n.denied) o.d = true;
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
function buildAiSnapshot(){
  var root = store.get(String(window.ROOT||'').toLowerCase());
  if(!root) return null;   // 扫描早期（s=0）也推：AI 靠 scanning 字段区分进行中/完成
  var denied = [];
  for(var k in deniedSeen){
    var dn = store.get(k);
    if(dn) denied.push({ path:dn.p, s:dn.s||0, al:alOf(dn) });
  }
  var types = (typeof typesPool === 'function') ? typesPool().slice(0, 50) : [];
  aiSnapBudget = 20000;   // 树节点预算：正常盘远用不完，仅防极端结构
  return JSON.stringify({
    app:'disklens', root:String(window.ROOT||''), generatedAt:new Date().toISOString(),
    scanning:scanning, volUsed:volUsed||null, volTotal:volTotal||null,
    gap:(volUsed ? volUsed - alOf(root) : null),
    rootSize:root.s, rootAlloc:alOf(root), deniedCount:deniedCount,
    tree: snapTree(root),      // 树形构成（≥10MB 子项 + 每层 agg 聚合；更细用 /api/tree）
    denied:denied, types:types,
    drill: 'GET /api/tree?path=<dir> 返回任意目录的直接子目录（无大小阈值，基于完整扫描表）'
  });
}
function pushAiSnapshot(){
  var j = null;
  try { j = buildAiSnapshot(); } catch(e) { return; }
  if(!j) return;
  if(feed.aiSnapshot) feed.aiSnapshot(j);
  aiSnapReady = true;
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
  else if(viewMode === 'types') renderTypes();
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
  var cb=document.createElement('b');
  // 目录双口径：逻辑大小 = 展示主口径；占用 = 簇对齐后的真实磁盘占用
  cb.textContent=node.n+' = '+fmt(node.s)+(node.f?'':' · 占用 '+fmt(alOf(node)));
  b.appendChild(cb);
}
function updateSummary(node){
  var root=store.get((window.ROOT||'C:\\').toLowerCase());
  var parts=[];
  if(root&&root.s>0){
    // 双口径：逻辑大小为主展示，磁盘占用（簇对齐/去重后的真实占用）括号补充
    parts.push((scanning?'已扫描 ':'根目录总计 ')+'<b>'+fmt(root.s)+'</b>'+'（占用 '+fmt(alOf(root))+'）');
  }
  if(volUsed) parts.push('卷已用 <b>'+fmt(volUsed)+'</b>');
  // 扫描完成后的差额透明化：扫描器看不到的部分 = 卷已用 - 扫描占用
  // （还原点/NTFS 元数据/无权限目录；负值说明占用估算偏高，如压缩文件近似）
  if(root&&root.done&&volUsed){
    var gap=volUsed-alOf(root);
    if(gap>=100*1024*1024){
      parts.push('<span style="color:var(--amber)" title="扫描器看不到的部分：System Volume Information（还原点）等受保护目录、NTFS 元数据（$MFT/USN 日志）、无权限目录">未计入 '+fmt(gap)+'</span>');
    } else if(gap<=-100*1024*1024){
      parts.push('<span style="color:var(--amber)" title="扫描占用高于卷已用：压缩/稀疏文件按逻辑大小估算偏高">口径高估 '+fmt(-gap)+'</span>');
    }
  }
  if(deniedCount) parts.push('<span id="denied-link" style="color:var(--amber);cursor:pointer;text-decoration:underline dotted" title="这些目录无权限读取，体积只含已读到的部分——点击查看清单">⛔ '+deniedCount+' 个目录无权限</span>');
  if(scanning&&scanT0) parts.push('用时 '+((Date.now()-scanT0)/1000).toFixed(1)+'s');
  if(watchActive) parts.push('<span style="color:var(--green)">⏱ 实时监视中'+(watchChanges?' · 已感知 '+watchChanges+' 项变更':'')+'</span>');
  document.getElementById('summary').innerHTML=parts.join(' · ');
  var st=document.getElementById('foot-stats');
  if(node) st.innerHTML='当前 <b>'+esc(node.n)+'</b> · '+node.c.length+' 项';
}

/* ===== 无权限目录面板 ===== */
function openDeniedPanel(){
  var mask=document.getElementById('denied-mask');
  if(!mask) return;
  var rows=[];
  for(var k in deniedSeen){
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
    var paths=Object.keys(deniedSeen).join('\r\n');
    copyPath(paths,null);
    setStatus('已复制 '+Object.keys(deniedSeen).length+' 条路径','done');
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
  // 扫描状态变化即推快照：AI 能从 /api/status、/api/scan 的 scanning 字段感知进度
  setTimeout(pushAiSnapshot, on ? 600 : 0);   // 开始时稍等首批事件；结束立即推
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
  // AI 经 POST /api/scan 触发扫描（用户按钮路径已自己接管 UI，此处只在空闲态生效）
  window.__TAURI__.event.listen('scan-started', function(ev){
    if (scanning) return;
    var root = ev.payload || '';
    if (!root) return;
    window.rootInput.value = root;
    window.ROOT = root; window.curPath = root;
    store.clear(); fileIndex.clear(); window.divs = {}; window.map.innerHTML = '';
    document.getElementById('list').innerHTML = '';
    document.getElementById('files').innerHTML = '';
    window.expanded = {}; window.stack = []; selectedRow = '';
    deniedCount = 0; deniedSeen = {}; volUsed = 0; volTotal = 0; aiSnapReady = false;
    setScanning(true);
    setStatus('AI 触发扫描中…', 'scanning');
    syncDrivesSelect(); loadDrives();
    render();
  });
  window.__TAURI__.event.listen('scan-finished', function(ev){
    var msg = ev.payload || '完成';
    setStatus(msg, 'done');
    setScanning(false);   // 内部已推完成态快照
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
  // AI 联动通道收到新提案（POST /api/proposal）→ 弹确认面板
  window.__TAURI__.event.listen('ai-proposal', function(ev){
    try { if(typeof showProposal==='function') showProposal(ev.payload); } catch(e){}
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
TauriFeed.prototype.aiProposalResult = function(id, status, results){
  window.__TAURI__.core.invoke('ai_proposal_result', { id: id, status: status, results: results }).catch(function(){});
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
/* AI 联动通道桩：浏览器模式无本地 HTTP 服务，全部 no-op（面板提示不可用） */
MockFeed.prototype.aiSnapshot = function(){};
MockFeed.prototype.aiChannelInfo = function(cb){ cb(null); };
MockFeed.prototype.aiChannelSetEnabled = function(){};
MockFeed.prototype.aiProposalResult = function(){};
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
    if(IN_TAURI){
      // 显示窗口由 Rust 决定焦点策略：--no-focus 启动（更新重启等）不抢前台
      window.__TAURI__.core.invoke('show_window').catch(function(){});
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
  deniedCount = 0; deniedSeen = {}; volUsed = 0; volTotal = 0;   // 新扫描/新根，差额口径重来
  aiSnapReady = false;                                          // 快照待新扫描完成后重推
  fileSearch = '';                                 // 搜索词随扫描重置
  var fsInp = document.getElementById('file-search');
  if(fsInp) fsInp.value = '';
  setScanning(true);
  setStatus('扫描中…', 'scanning');
  syncDrivesSelect();
  loadDrives();   // 重新枚举卷：volUsed 跟随新根所在盘
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
    // 当前根所在卷的已用空间：summary 显示「卷已用 / 未计入」的数据源
    var rootLow = String(window.ROOT || 'C:\\').toLowerCase();
    for (var j = 0; j < list.length; j++) {
      var mnt = list[j].mount.toLowerCase();
      if (rootLow.indexOf(mnt) === 0 || rootLow.slice(0, 3) === mnt.slice(0, 3)) {
        volUsed = (list[j].total_bytes || 0) - (list[j].free_bytes || 0);
        volTotal = list[j].total_bytes || 0;
        break;
      }
    }
    markDirty();   // summary 随下一次渲染刷新
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
