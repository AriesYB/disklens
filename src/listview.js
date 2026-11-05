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
    '<div class="th">占比</div>'+
    '<div class="th">状态</div></div>';
  for(var j=0;j<items.length;j++){
    var it=items[j];
    var pct=(tot>0&&it.s>0)?(it.s/tot*100):0;
    html+='<div class="l-row'+(it.done?' done':' counting')+(selectedRow===it.p?' sel':'')+'"'+
      ' data-path="'+escAttr(it.p)+'" data-kind="'+(it.f?'file':'dir')+'">'+
      '<div class="l-name"><span class="ic '+(it.f?'ic-file">📄':'ic-dir">📁')+'</span>'+
      '<span class="nm" title="'+escAttr(it.p)+'">'+esc(it.n)+'</span></div>'+
      '<div class="l-size">'+fmt(it.s)+'</div>'+
      '<div class="l-pct"><div class="l-track"><div class="l-fill" style="width:'+
        Math.min(100,pct).toFixed(1)+'%"></div></div>'+
      '<span class="pv">'+(pct>0?pct.toFixed(1):'0')+'%</span></div>'+
      '<div class="l-st">'+(it.done?'✓ 就绪':'⟳ 统计中')+'</div></div>';
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

/* ===== 大文件榜 ===== */
function renderFiles(){
  var box=document.getElementById('files');
  if(!box) return;
  var arr=[];
  fileIndex.forEach(function(n){ if(n.s>=BIG_FILE_MIN) arr.push(n); });
  arr.sort(function(a,b){ return b.s-a.s; });
  var html='<div class="f-meta">共 <b>'+arr.length+'</b> 个 ≥1MB 的大文件'+
    (scanning?' · 实时更新中':'')+'</div>';
  if(!arr.length){
    html+='<div class="empty"><div class="e-ic">📦</div><div>'+
      (scanning?'扫描中，发现大文件后自动上榜':'本次扫描未发现 ≥1MB 的大文件')+'</div></div>';
    box.innerHTML=html;
    return;
  }
  var shown=arr.slice(0,FILES_MAX_ROWS);
  html+='<div class="f-head"><div>#</div><div>文件名</div><div class="f-fsize" style="text-align:right">大小</div>'+
    '<div>所在目录</div><div></div></div>';
  for(var i=0;i<shown.length;i++){
    var n=shown[i];
    var dir=parentPathOf(n.p);
    html+='<div class="f-row'+(i<3?' r'+(i+1):'')+'" data-path="'+escAttr(n.p)+'" data-parent="'+escAttr(dir)+'">'+
      '<div class="f-rank">'+(i+1)+'</div>'+
      '<div class="f-file"><span class="ic ic-file">📄</span><span class="nm" title="'+escAttr(n.p)+'">'+esc(n.n)+'</span></div>'+
      '<div class="f-fsize">'+fmt(n.s)+'</div>'+
      '<div class="f-dir" title="'+escAttr(dir)+'">'+esc(dir)+'</div>'+
      '<div class="f-act"><button class="icon-btn act-open">📂 定位</button>'+
      '<button class="icon-btn act-copy">📋 复制</button></div></div>';
  }
  if(arr.length>shown.length){
    html+='<div class="f-meta">（仅显示前 '+FILES_MAX_ROWS+' 个，其余 '+
      (arr.length-shown.length)+' 个已省略）</div>';
  }
  box.innerHTML=html;
}
function parentPathOf(p){
  var idx=p.lastIndexOf('\\');
  if(idx<=0) return p;
  return idx===2 ? p.slice(0,3) : p.slice(0,idx);   // 'C:\x' 的父是 'C:\'
}

(function initFilesView(){
  var box=document.getElementById('files');
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
    var parent=row.dataset.parent;
    if(parent){ setView('list'); navigate(parent); }
  });
  box.addEventListener('contextmenu',function(ev){
    var row=ev.target.closest('.f-row');
    if(!row) return;
    ev.preventDefault();
    openContextMenu(ev,row.dataset.path,true);
  });
})();
