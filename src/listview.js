// DiskLens 列表视图 + 大文件榜 —— 与 treemap 视图共享 store / 导航 / 右键菜单。
// 列表视图：当前目录子项，名称/大小可排序（点击表头切换升降序），占比条实时反映父目录构成。
// 大文件榜：全扫描范围内的大文件（≥1MB；真实扫描中后端仅上报 ≥10MB 文件），
//           扫描过程中实时更新，双击定位所在目录，可一键在资源管理器中选中。

/* ===== 全局状态 ===== */
var BIG_FILE_MIN = 1024 * 1024;          // 大文件榜阈值 1MB
var FILES_MAX_ROWS = 500;                // 榜单上限，防止超大盘卡顿
var listSort = { key:'size', dir:-1 };   // 列表排序：默认大小降序
var selectedRow = '';                    // 列表视图当前选中行路径

/* ===== 列表视图 ===== */
function renderList(node){
  var box=document.getElementById('list');
  if(!box) return;
  var html='';
  if(stack.length){
    html+='<div class="l-up" id="l-up">⬅ 返回上一级（'+esc(stack[stack.length-1].name)+'）</div>';
  }
  var items=(node.c||[]).slice();
  if(!items.length){
    html+='<div class="empty"><div class="e-ic">🗂️</div><div>'+
      (node.done?'空目录，没有子项':'正在统计子项…')+'</div></div>';
    box.innerHTML=html;
    return;
  }
  var tot=0; for(var i=0;i<items.length;i++) tot+=items[i].s;
  var key=listSort.key, dir=listSort.dir;
  items.sort(function(a,b){
    var r=(key==='name')
      ? a.n.localeCompare(b.n,'zh-Hans-CN',{numeric:true})
      : (a.s||0)-(b.s||0);
    return r*dir;
  });
  html+='<div class="l-head">'+
    '<div class="th" data-sort="name">名称'+sortArrow('name')+'</div>'+
    '<div class="th rt" data-sort="size">大小'+sortArrow('size')+'</div>'+
    '<div class="th rt">占用</div>'+
    '<div class="th">占比</div>'+
    '<div class="th">状态</div></div>';
  for(var j=0;j<items.length;j++){
    var it=items[j];
    var pct=(tot>0&&it.s>0)?(it.s/tot*100):0;
    // 状态列：受限目录 / 云占位 / 硬链接副本优先于普通就绪标记
    var st = !it.done ? '⟳ 统计中'
      : it.denied ? '⛔ 受限'
      : it.cloud ? '☁ 云端'
      : it.dup ? '⛓ 硬链接'
      : '✓ 就绪';
    var stColor = it.denied ? 'var(--amber)' : it.cloud ? '#7fc7ff' : '';
    html+='<div class="l-row'+(it.done?' done':' counting')+(selectedRow===it.p?' sel':'')+'"'+
      ' data-path="'+escAttr(it.p)+'" data-kind="'+(it.f?'file':'dir')+'">'+
      '<div class="l-name"><span class="ic '+(it.f?'ic-file">📄':'ic-dir">📁')+'</span>'+
      '<span class="nm" title="'+escAttr(it.p)+'">'+esc(it.n)+'</span></div>'+
      '<div class="l-size">'+fmt(it.s)+'</div>'+
      '<div class="l-al" title="磁盘占用：簇对齐后的实际占用；云占位文件为 0，硬链接副本不重复计">'+fmt(alOf(it))+'</div>'+
      '<div class="l-pct"><div class="l-track"><div class="l-fill" style="width:'+
        Math.min(100,pct).toFixed(1)+'%"></div></div>'+
      '<span class="pv">'+(pct>0?pct.toFixed(1):'0')+'%</span></div>'+
      '<div class="l-st"'+(stColor?' style="color:'+stColor+'"':'')+'>'+st+'</div></div>';
  }
  box.innerHTML=html;
}
function sortArrow(key){
  if(listSort.key!==key) return '';
  return '<span class="arr">'+(listSort.dir<0?'▼':'▲')+'</span>';
}
function escAttr(s){ return esc(s).replace(/"/g,'&quot;'); }

(function initListView(){
  var box=document.getElementById('list');
  box.addEventListener('click',function(ev){
    var up=ev.target.closest('.l-up');
    if(up){ goUp(); return; }
    var th=ev.target.closest('.th[data-sort]');
    if(th){
      var k=th.dataset.sort;
      if(listSort.key===k) listSort.dir*=-1;
      else { listSort.key=k; listSort.dir=(k==='name')?1:-1; }
      render();
      return;
    }
    var row=ev.target.closest('.l-row');
    if(row){
      selectedRow=row.dataset.path;
      var rows=box.querySelectorAll('.l-row');
      for(var i=0;i<rows.length;i++) rows[i].classList.toggle('sel',rows[i].dataset.path===selectedRow);
    }
  });
  box.addEventListener('dblclick',function(ev){
    var row=ev.target.closest('.l-row');
    if(!row||row.dataset.kind!=='dir') return;
    navigate(row.dataset.path);
  });
  box.addEventListener('contextmenu',function(ev){
    var row=ev.target.closest('.l-row');
    if(!row) return;
    ev.preventDefault();
    openContextMenu(ev,row.dataset.path,row.dataset.kind==='file');
  });
})();

/* ===== 大文件榜（含名称搜索：无通配符=子串匹配；* ? 通配；搜索时目录名也参与） ===== */
var fileSearch = '';       // 当前搜索词（'' = 不过滤，纯大文件榜）
var fileSearchTimer = null;

// 名称匹配：不含 * ? → 子串不区分大小写；含则按通配转正则
function nameMatches(q, name){
  var n = name.toLowerCase(), p = q.toLowerCase();
  if(q.indexOf('*')<0 && q.indexOf('?')<0) return n.indexOf(p)>=0;
  var rx = new RegExp('^'+p.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$');
  return rx.test(n);
}

// 当前榜单数据集：无搜索 = 当前范围全部 ≥1MB 大文件；有搜索 = 命中的大文件 + 命中的目录（按大小降序）
// 会话级多范围：store/fileIndex 里可能留着其他盘扫过的数据，按当前范围前缀过滤防串盘
function filesPool(){
  var arr=[];
  fileIndex.forEach(function(n){
    if(n.s<BIG_FILE_MIN || !inScope(n.p)) return;
    arr.push(n);
  });
  if(fileSearch){
    var out=arr.filter(function(n){ return nameMatches(fileSearch, n.n); });
    store.forEach(function(n){
      if(!n.f && n.s>0 && inScope(n.p) && nameMatches(fileSearch, n.n)) out.push(n);   // 目录也参与：node_modules 猎手
    });
    arr=out;
  }
  arr.sort(function(a,b){ return b.s-a.s; });
  return arr;
}

function renderFiles(){
  var box=document.getElementById('files-body');
  if(!box) return;
  var arr=filesPool();
  var cnt=document.getElementById('file-search-count');
  if(cnt) cnt.textContent = fileSearch
    ? '匹配 '+arr.length+' 项'+(scanning?' · 实时更新中':'')
    : '共 '+arr.length+' 个 ≥1MB 大文件'+(scanning?' · 实时更新中':'');
  var html='<div class="f-meta">'+(fileSearch
    ? '搜索「'+esc(fileSearch)+'」命中 <b>'+arr.length+'</b> 项（大文件 + 目录名匹配）'
    : '共 <b>'+arr.length+'</b> 个 ≥1MB 的大文件')+'</div>';
  if(!arr.length){
    html+='<div class="empty"><div class="e-ic">📦</div><div>'+
      (fileSearch?'没有匹配「'+esc(fileSearch)+'」的文件或目录（搜索范围：已入索引的大文件与全部目录）'
      :(scanning?'扫描中，发现大文件后自动上榜':'本次扫描未发现 ≥1MB 的大文件'))+'</div></div>';
    box.innerHTML=html;
    return;
  }
  var shown=arr.slice(0,FILES_MAX_ROWS);
  html+='<div class="f-head"><div>#</div><div>名称</div><div class="f-fsize" style="text-align:right">大小</div>'+
    '<div>所在位置</div><div></div></div>';
  for(var i=0;i<shown.length;i++){
    var n=shown[i];
    var isDir=!n.f;
    var loc=parentPathOf(n.p);
    html+='<div class="f-row'+(i<3?' r'+(i+1):'')+'" data-path="'+escAttr(n.p)+'" data-parent="'+escAttr(loc)+'"'+
      ' data-kind="'+(isDir?'dir':'file')+'">'+
      '<div class="f-rank">'+(i+1)+'</div>'+
      '<div class="f-file"><span class="ic '+(isDir?'ic-dir">📁':'ic-file">📄')+'</span>'+
      '<span class="nm" title="'+escAttr(n.p)+'">'+esc(n.n)+'</span></div>'+
      '<div class="f-fsize">'+fmt(n.s)+'</div>'+
      '<div class="f-dir" title="'+escAttr(n.p)+'">'+esc(loc)+'</div>'+
      '<div class="f-act"><button class="icon-btn act-open">📂 定位</button>'+
      '<button class="icon-btn act-copy">📋 复制</button></div></div>';
  }
  if(arr.length>shown.length){
    html+='<div class="f-meta">（仅显示前 '+FILES_MAX_ROWS+' 个，其余 '+
      (arr.length-shown.length)+' 个已省略，导出 CSV 含全部结果）</div>';
  }
  box.innerHTML=html;
}
function parentPathOf(p){
  var idx=p.lastIndexOf('\\');
  if(idx<=0) return p;
  return idx===2 ? p.slice(0,3) : p.slice(0,idx);   // 'C:\x' 的父是 'C:\'
}

/* 设置搜索词（类型视图钻取联动用）并刷新 */
function setFileSearch(q){
  fileSearch=q||'';
  var inp=document.getElementById('file-search');
  if(inp && inp.value!==fileSearch) inp.value=fileSearch;
  renderFiles();
}

(function initFilesView(){
  var box=document.getElementById('files');
  // 搜索框：150ms 防抖（静态 DOM 不随榜单重渲染重建，焦点不丢）
  var inp=document.getElementById('file-search');
  if(inp) inp.addEventListener('input',function(){
    clearTimeout(fileSearchTimer);
    var v=this.value.trim();
    fileSearchTimer=setTimeout(function(){ fileSearch=v; renderFiles(); },150);
  });
  var exp=document.getElementById('files-export');
  if(exp) exp.addEventListener('click',function(){ exportFilesCSV(); });   // 定义在 main.js，运行时解析
  box.addEventListener('click',function(ev){
    var row=ev.target.closest('.f-row');
    if(!row) return;
    var p=row.dataset.path;
    var b=ev.target.closest('button');
    if(b&&b.classList.contains('act-open')){ feed.open(p,true); return; }
    if(b&&b.classList.contains('act-copy')){ copyPath(p,b); return; }
  });
  box.addEventListener('dblclick',function(ev){
    var row=ev.target.closest('.f-row');
    if(!row) return;
    if(row.dataset.kind==='dir'){ navigate(row.dataset.path); return; }   // 目录行：进入
    var parent=row.dataset.parent;
    if(parent){ setView('list'); navigate(parent); }
  });
  box.addEventListener('contextmenu',function(ev){
    var row=ev.target.closest('.f-row');
    if(!row) return;
    ev.preventDefault();
    openContextMenu(ev,row.dataset.path,row.dataset.kind!=='dir');
  });
})();

/* ===== 类型统计视图：扩展名聚合（数据源 = 大文件榜同一索引；真实扫描口径 ≥10MB） ===== */
function extOf(name){
  var idx=name.lastIndexOf('.');
  if(idx<=0||idx===name.length-1) return '';
  return name.slice(idx+1).toLowerCase();
}
function typesPool(){
  var m=new Map();   // ext -> {ext,n,s,al}
  fileIndex.forEach(function(f){
    if(f.s<BIG_FILE_MIN || !inScope(f.p)) return;   // 与大文件榜同口径：只聚合当前范围
    var e=extOf(f.n)||'（无扩展名）';
    var t=m.get(e);
    if(!t){ t={ext:e,n:0,s:0,al:0}; m.set(e,t); }
    t.n++; t.s+=f.s; t.al+=alOf(f);
  });
  var arr=[];
  m.forEach(function(t){ arr.push(t); });
  arr.sort(function(a,b){ return b.s-a.s; });
  return arr;
}
function renderTypes(){
  var box=document.getElementById('types-body');
  if(!box) return;
  var arr=typesPool();
  var meta=document.getElementById('types-meta');
  if(meta) meta.innerHTML = arr.length
    ? '<b>'+arr.length+'</b> 种类型 · <b>'+arr.reduce(function(a,t){return a+t.n;},0).toLocaleString()+'</b> 个文件 · 单击行查看该类型文件'
    : '暂无类型数据（扫描开始后自动聚合）';
  if(!arr.length){
    box.innerHTML='<div class="t-empty">'+(scanning?'扫描中…':'先扫描，类型分布自动聚合')+'</div>';
    return;
  }
  var tot=0; for(var q=0;q<arr.length;q++) tot+=arr[q].s;
  var html='<div class="t-head"><div>类型</div><div class="rt">文件数</div>'+
    '<div class="rt">大小</div><div class="rt">占用</div><div>占比</div></div>';
  for(var i=0;i<arr.length;i++){
    var t=arr[i];
    var pct=tot>0?(t.s/tot*100):0;
    html+='<div class="t-row" data-ext="'+escAttr(t.ext)+'">'+
      '<div class="t-ext"><span class="sw" style="background:'+colors(i)+'"></span>'+esc(t.ext)+'</div>'+
      '<div class="t-num">'+t.n.toLocaleString()+'</div>'+
      '<div class="t-num">'+fmt(t.s)+'</div>'+
      '<div class="t-num">'+fmt(t.al)+'</div>'+
      '<div class="l-pct"><div class="l-track"><div class="l-fill" style="width:'+
        Math.min(100,pct).toFixed(1)+'%"></div></div>'+
      '<span class="pv">'+(pct>0?pct.toFixed(1):'0')+'%</span></div></div>';
  }
  box.innerHTML=html;
}

(function initTypesView(){
  var box=document.getElementById('types-body');
  box.addEventListener('click',function(ev){
    var row=ev.target.closest('.t-row');
    if(!row) return;
    var e=row.dataset.ext;
    if(!e) return;
    if(e==='（无扩展名）'){ setView('files'); setFileSearch(''); return; }
    // 类型 → 文件联动：预填 *.ext 搜索并切到大文件榜
    setView('files');
    setFileSearch('*.'+e);
  });
  var exp=document.getElementById('types-export');
  if(exp) exp.addEventListener('click',function(){ exportTypesCSV(); });
})();

/* ===== 历史对比视图：上次扫描 vs 本次（目录级增量） ===== */
// 数据源：scan-cache.prev.json（上次）vs 内存 store（本次，≥1MB 目录）。
// prev 异步读一次后缓存到 prevCache；重扫完成自动 markDirty 刷新
var prevCache = null;      // {at, root, m: Map(lower->s)}
var prevCacheLoaded = false;

function loadPrevCache(cb){
  if(prevCacheLoaded) return cb(prevCache);
  if(!feed.readScanCache) { prevCacheLoaded = true; return cb(null); }
  feed.readScanCache('prev', function(json){
    if(!json){ prevCacheLoaded = true; return cb(null); }
    try {
      var d = JSON.parse(json);
      var m = new Map();
      (d.nodes||[]).forEach(function(r){ m.set(r[0].toLowerCase(), r[2]); });
      prevCache = { at:d.at||0, root:d.root||'', m:m };
    } catch(e) { prevCache = null; }
    prevCacheLoaded = true;
    cb(prevCache);
  });
}

function renderDiff(){
  var box=document.getElementById('diff-body');
  if(!box) return;
  var meta=document.getElementById('diff-meta');
  loadPrevCache(function(prev){
    if(!prev || !prev.m.size){
      if(meta) meta.innerHTML='暂无历史数据——连续完成两次扫描后，这里显示「上次 vs 本次」的目录级增减';
      box.innerHTML='<div class="t-empty">完成两次扫描后可查看：哪些目录在增长、哪些是新出现的大头</div>';
      return;
    }
    // 上次扫描必须是同一范围：跨范围（如上次 C: 这次 D:）对比没有意义
    function rk(s){ return String(s||'').toLowerCase().split(',').filter(Boolean).sort().join(','); }
    if(rk(prev.root) !== rk(ROOTS.join(','))){
      if(meta) meta.innerHTML='上次扫描是其他范围（'+esc(prev.root)+'）——重新扫描当前范围后即可对比';
      box.innerHTML='<div class="t-empty">历史对比按范围分开：切回上次扫描的范围，或重新扫描当前范围</div>';
      return;
    }
    var grown=[], added=[];
    store.forEach(function(n){
      if(n.f || n.s < 1024*1024 || !inScope(n.p)) return;
      var old = prev.m.get(n.p.toLowerCase());
      if(old == null){ if(n.done) added.push(n); }
      else if(n.done && n.s > old) grown.push({ n:n.n, p:n.p, s:n.s, delta:n.s-old });
    });
    grown.sort(function(a,b){ return b.delta-a.delta; });
    added.sort(function(a,b){ return b.s-a.s; });
    grown = grown.slice(0, 20);
    added = added.slice(0, 20);
    var prevDate = prev.at ? new Date(prev.at).toLocaleString() : '—';
    if(meta) meta.innerHTML='上次：'+esc(prevDate)+' · '+
      '<b>'+grown.length+'</b> 个增长目录 / <b>'+added.length+'</b> 个新增大目录（≥1MB）';
    var html='';
    if(grown.length){
      html+='<div class="f-meta" style="padding-left:18px">📈 增长最大（本次 - 上次）</div>'+
        '<div class="t-head"><div>目录</div><div class="rt">上次</div><div class="rt">本次</div><div class="rt">增量</div><div></div></div>';
      for(var i=0;i<grown.length;i++){
        var g=grown[i];
        var old=prev.m.get(g.p.toLowerCase());
        html+='<div class="t-row" data-path="'+escAttr(g.p)+'">'+
          '<div class="t-ext" title="'+escAttr(g.p)+'">'+esc(g.n)+'</div>'+
          '<div class="t-num">'+fmt(old)+'</div><div class="t-num">'+fmt(g.s)+'</div>'+
          '<div class="t-num" style="color:#e8a0a0">+'+fmt(g.delta)+'</div><div></div></div>';
      }
    }
    if(added.length){
      html+='<div class="f-meta" style="padding-left:18px;margin-top:10px">🆕 新出现的大目录</div>'+
        '<div class="t-head"><div>目录</div><div class="rt" colspan2></div><div class="rt">大小</div><div></div><div></div></div>';
      for(var j=0;j<added.length;j++){
        var a=added[j];
        html+='<div class="t-row" data-path="'+escAttr(a.p)+'">'+
          '<div class="t-ext" title="'+escAttr(a.p)+'">'+esc(a.n)+'</div>'+
          '<div class="t-num">—</div><div class="t-num">'+fmt(a.s)+'</div><div class="t-num">新增</div><div></div></div>';
      }
    }
    if(!grown.length && !added.length){
      html='<div class="t-empty">与上次相比没有明显增长（≥1MB 粒度）——盘面很稳定 👍</div>';
    }
    box.innerHTML=html;
  });
}

(function initDiffView(){
  var box=document.getElementById('diff-body');
  if(box) box.addEventListener('click', function(ev){
    var row=ev.target.closest('.t-row');
    if(row && row.dataset.path){ navigate(row.dataset.path); }
  });
  // 重扫后 prevCache 失效（下次进视图重读），配合 scan-finished 的 saveScanCache 轮换
  if (typeof markDirty === 'function') markDirty();
})();
