// DiskLens treemap 引擎 —— 从 c-relocator Map-Reloc.ps1 viewer 完整移植：
// squarify 布局 + 排序迟滞(12%) + 极小项/细条折叠 + 单击展开/双击进入 +
// 客户端风格右键菜单 + 文件灰/目录彩色 + counting 流动斜纹。
// 数据来源与渲染解耦：store 由 main.js 的 Feed 填充，本文件只读 store 渲染。

/* ===== 全局状态 ===== */
var curPath = null, stack = [], store = new Map(), divs = {}, dirty = false;
var expanded = {}, orderState = {};
var menuPath = '', menuSel = false;
var map, rootInput, statusEl, footStat;

/* ===== 工具 ===== */
function fmt(b){ if(b>=1073741824) return (b/1073741824).toFixed(2)+' GB';
  if(b>=1048576) return (b/1048576).toFixed(1)+' MB';
  if(b>=1024) return (b/1024).toFixed(0)+' KB'; return b+' B'; }
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
var PALETTE=['#3987d8','#2ea88a','#a568d6','#d69a44','#4a7de0','#8fb544',
             '#d46b78','#3fb3c4','#c474ad','#6f8f3d','#8a7fe0','#c98a3b'];
function colors(d){ return PALETTE[((d%PALETTE.length)+PALETTE.length)%PALETTE.length]; }
/* 共享右键菜单：treemap / 列表 / 大文件榜 三视图通用 */
function openContextMenu(ev,fp,isFile){
  menuPath=fp; menuSel=!!isFile;
  document.getElementById('mi-open-t').textContent=isFile?'打开所在文件夹（并选中）':'在资源管理器中打开';
  document.getElementById('mi-enter').style.display=isFile?'none':'';
  document.getElementById('mi-expand').style.display=isFile?'none':'';
  document.getElementById('mi-migrate').style.display=isFile?'none':'';
  document.getElementById('mi-ai').style.display=isFile?'none':'';
  document.getElementById('mi-expand-t').textContent=expanded[fp]?'收起':'展开';
  document.getElementById('mi-copy-t').textContent='复制完整路径';
  document.getElementById('ctxpath').textContent=fp;
  var c=document.getElementById('ctx');
  c.style.display='block';
  c.style.left=Math.min(ev.clientX,window.innerWidth-256)+'px';
  c.style.top=Math.min(ev.clientY,window.innerHeight-200)+'px';
}
function worst(row,len){ if(!row.length) return Infinity;
  var s=0,mx=0,mn=Infinity;
  for(var i=0;i<row.length;i++){s+=row[i].s; if(row[i].s>mx)mx=row[i].s; if(row[i].s<mn)mn=row[i].s;}
  if(mn<=0||s<=0) return Infinity;
  var l=len*len, s2=s*s;
  return Math.max(l*mx/s2, s2/(l*mn)); }
function layoutRow(row,x,y,w,h,out){
  var s=0; for(var i=0;i<row.length;i++) s+=row[i].s;
  if(w>=h){ var rw=s/h, ry=y;
    for(var j=0;j<row.length;j++){ var rh=row[j].s/rw; out.push({n:row[j],x:x,y:ry,w:rw,h:rh}); ry+=rh; }
    return {x:x+rw,y:y};
  } else { var rh=s/w, xx=x;
    for(var j2=0;j2<row.length;j2++){ var rw2=row[j2].s/rh; out.push({n:row[j2],x:xx,y:y,w:rw2,h:rh}); xx+=rw2; }
    return {x:x,y:y+rh};
  } }
function squarify(items,x,y,w,h,out){
  var row=[],i=0;
  while(i<items.length&&w>1&&h>1){
    var len=Math.min(w,h);
    var c1=worst(row,len), c2=worst(row.concat([items[i]]),len);
    if(c1===Infinity||c2<=c1){ row.push(items[i]); i++; }
    else { var r=layoutRow(row,x,y,w,h,out);
      if(w>=h){ w-=(r.x-x); x=r.x; } else { h-=(r.y-y); y=r.y; }
      row=[]; }
  }
  if(row.length&&w>1&&h>1) layoutRow(row,x,y,w,h,out);
}

/* ===== 排序迟滞：新项按大小插入，旧项超相邻 12% 才上移 ===== */
function stableOrder(arr,keyBase){
  var st=orderState[keyBase];
  if(!st){ st=orderState[keyBase]={list:[]}; }
  var byName={};
  for(var i=0;i<arr.length;i++) byName[arr[i].n]=arr[i];
  var out=[];
  for(var j=0;j<st.list.length;j++){ var it=byName[st.list[j]]; if(it){ out.push(it); delete byName[st.list[j]]; } }
  for(var k2=0;k2<arr.length;k2++){ if(byName[arr[k2].n]){ out.push(arr[k2]); delete byName[arr[k2].n]; } }
  var changed=true,passes=0;
  while(changed&&passes<60){
    changed=false;passes++;
    for(var m=0;m<out.length-1;m++){
      if(out[m+1].s>out[m].s*1.12){ var t=out[m];out[m]=out[m+1];out[m+1]=t;changed=true; }
    }
  }
  st.list=out.map(function(x){return x.n;});
  return out;
}

/* ===== 单元格创建/绘制 ===== */
function getCell(kk){
  var d=divs[kk];
  if(!d){
    d=document.createElement('div'); d.className='cell new';
    d.dataset.k=kk; map.appendChild(d); divs[kk]=d;
    setTimeout(function(el){ return function(){ el.className=el.className.replace(' new',''); }; }(d), 40);
    var l=document.createElement('div'); l.className='lbl'; d.appendChild(l);
    var b=document.createElement('div'); b.className='badge'; d.appendChild(b);
    d.style.cursor='pointer';
    d.addEventListener('mousemove',function(ev){
      var el=ev.currentTarget, n=el.__n||{};
      var t=document.getElementById('tip'); t.style.display='block';
      t.style.left=Math.min(ev.clientX+14,window.innerWidth-560)+'px';
      t.style.top=(ev.clientY+14)+'px';
      var fp=n.agg?('聚合 '+n.agg+' 个极小/未扫完项'):(el.__path||n.p||'');
      t.innerHTML='<div style="color:#9fd1ff;word-break:break-all">'+esc(fp)+'</div><b>'+fmt(n.raw!=null?n.raw:n.s)+'</b>'+
        (n.f?'<span style="color:#888"> · 文件</span>':'<span style="color:#888"> · 目录 · 单击展开/收起 · 双击进入</span>')+
        (n.done?'':'<br><span style="color:#ffd479">counting...</span>')+
        '<br><span style="color:#888">右键：'+(n.f?'打开所在文件夹':'更多操作')+'</span>';
    });
    d.addEventListener('mouseleave',function(){ document.getElementById('tip').style.display='none'; });
    d.addEventListener('click',function(ev){ ev.stopPropagation();
      var el=ev.currentTarget, n=el.__n||{};
      if(n.f||n.agg) return;
      var p=el.__path; if(!p) return;
      if(expanded[p]){ delete expanded[p]; }
      else {
        expanded[p]=1;
        var sn=store.get(p.toLowerCase());
        // 单子链钻取：若内部只有一条大子目录链，继续展开下去，保证点击必有可见变化
        if(typeof drillExpand==='function' && sn && sn.done){ drillExpand(p, 3); }
        // 展开时还没扫完 → 请后端优先扫这个子树（已扫完的目录后端会直接忽略）
        if(typeof scanning!=='undefined'&&scanning&&sn&&!sn.done&&
           feed&&typeof feed.scanPriority==='function'){ feed.scanPriority(p); }
      }
      render();
    });
    d.addEventListener('dblclick',function(ev){ ev.stopPropagation();
      var el=ev.currentTarget, n=el.__n||{};
      if(n.f) return;
      var p=el.__path;
      if(p){ navigate(p); } });
    d.addEventListener('contextmenu',function(ev){ ev.preventDefault(); ev.stopPropagation();
      var el=ev.currentTarget, n=el.__n||{};
      openContextMenu(ev,el.__path||n.p||'',!!n.f);
    });
  }
  return d;
}
function paintCell(d,o,x,y,w,h,pth,kk,seen,ci){
  d.__n=o.n; d.__path=pth;
  d.style.left=x+'px'; d.style.top=y+'px';
  d.style.width=Math.max(0,w-2)+'px'; d.style.height=Math.max(0,h-2)+'px';
  d.style.backgroundColor=o.n.f?(o.n.agg?'#39414e':'#5b6472'):colors(ci);
  d.classList.toggle('expd',!!expanded[pth]);
  d.classList.toggle('counting',!o.n.done);
  var lbl=d.querySelector('.lbl');
  lbl.textContent=o.n.n+'  '+fmt(o.n.raw!=null?o.n.raw:o.n.s)+(expanded[pth]?' ▾':'');
  lbl.style.fontSize=(w>180&&h>50)?'14px':'11px';
  lbl.style.paddingLeft=expanded[pth]?
    (4+Math.max(0,pth.split('\\').length-curPath.split('\\').length)*12)+'px':'';
  d.querySelector('.badge').textContent='';
  seen[kk]=1;
}

/* ===== 布局：面积折叠 + 形状检测 + 剩余条占位 ===== */
function layoutInto(node,x0,y0,w0,h0,keyBase,seen){
  var items=(node.c||[]).slice().sort(function(a,b){return b.s-a.s;});
  var tot=0; for(var q=0;q<items.length;q++) tot+=items[q].s;
  if(!items.length||tot<=0||w0<10||h0<10) return;
  var MINA=180;
  var k0=(w0*h0)/tot;
  // 统计中（未 done）的目录永不折叠进"剩余"条，并给一块最小可见面积——
  // 扫描进行中它们带着转圈动画占位，用户能直观看到"哪些正在统计"
  var countingN=0;
  for(var cq=0;cq<items.length;cq++){ if(!items[cq].done) countingN++; }
  var visFrac=countingN>0?Math.min(0.03,0.15/countingN):0;
  // 最小可见面积对应的字节等效：tot*visFrac（k0 是 px²/byte，量级 1e-6，不能用 max(1,k0) 缩放）
  var minVisBytes=visFrac>0?tot*visFrac:0;
  var main=[],rest=0,restN=0;
  for(var q2=0;q2<items.length;q2++){
    var it=items[q2];
    if(!it.done){ main.push(it); continue; }
    if(it.s*k0>=MINA){ main.push(it); }
    else { rest+=it.s; restN++; }
  }
  var aggS=rest, aggN=restN, agg=aggS>0;
  if(!main.length){
    if(agg){
      var d0=getCell(keyBase+'|:agg');
      paintCell(d0,{n:{n:'… 剩余'+aggN+'项（极小/未扫完）',s:aggS,raw:aggS,done:true,f:1,agg:aggN}},x0,y0,w0,h0,keyBase,keyBase+'|:agg',seen,0);
      d0.style.background='#3f3f46';
    }
    return;
  }
  function lsOf(it){ return (!it.done && it.s<minVisBytes) ? minVisBytes : it.s; }
  main=stableOrder(main,keyBase);
  var out=[];
  for(var pass=0;pass<4;pass++){
    var goodSum=0; for(var g=0;g<main.length;g++) goodSum+=lsOf(main[g]);
    if(goodSum<=0){ main=[]; break; }
    var stripH=agg?Math.max(18,Math.min(Math.round(h0*aggS/(goodSum+aggS)),Math.round(h0*0.4))):0;
    var availH=h0-stripH;
    if(availH<10){ break; }
    var k=(w0*availH)/goodSum;
    var px=main.map(function(it,i2){ return {n:it.n,s:lsOf(it)*k,raw:it.s,p:it.p,f:it.f,done:it.done,c:it.c,idx:i2}; });
    out=[]; squarify(px,x0,y0,w0,availH,out);
    var bad=false, keep={};
    for(var b=0;b<out.length;b++){
      var r=out[b];
      var mx=Math.max(r.w,r.h), mn=Math.min(r.w,r.h);
      // 统计中的块豁免形状折叠：可见性优先，完成后会被真实尺寸替换
      if(r.n.done && (mn<5||mx/mn>7)){ bad=true; agg=true; aggS+=r.n.raw; aggN++; }
      else { keep[r.n.idx]=1; }
    }
    if(!bad) break;
    main=main.filter(function(it,i3){ return keep[i3]; });
  }
  var goodSum=0; for(var g2=0;g2<main.length;g2++) goodSum+=lsOf(main[g2]);
  if(goodSum<=0){
    if(agg){
      var d1=getCell(keyBase+'|:agg');
      paintCell(d1,{n:{n:'… 剩余'+aggN+'项（极小/未扫完）',s:aggS,raw:aggS,done:true,f:1,agg:aggN}},x0,y0,w0,h0,keyBase,keyBase+'|:agg',seen,0);
      d1.style.background='#3f3f46';
    }
    return;
  }
  var stripH=agg?Math.max(18,Math.min(Math.round(h0*aggS/(goodSum+aggS)),Math.round(h0*0.4))):0;
  var availH=h0-stripH;
  if(availH<10){
    var d2=getCell(keyBase+'|:agg');
    paintCell(d2,{n:{n:'… 剩余'+aggN+'项（极小/未扫完）',s:aggS,raw:aggS,done:true,f:1,agg:aggN}},x0,y0,w0,h0,keyBase,keyBase+'|:agg',seen,0);
    d2.style.background='#3f3f46';
    return;
  }
  var k=(w0*availH)/goodSum;
  var px=main.map(function(it){ return {n:it.n,s:lsOf(it)*k,raw:it.s,p:it.p,f:it.f,done:it.done,c:it.c}; });
  out=[]; squarify(px,x0,y0,w0,availH,out);
  var depth=stack.length;
  var sep=(keyBase.charAt(keyBase.length-1)==='\\')?'':'\\';
  for(var i=0;i<out.length;i++){
    var o=out[i], kk=keyBase+'|'+o.n.n;
    var pth=o.n.p||(keyBase+sep+o.n.n);
    var d=getCell(kk);
    paintCell(d,o,o.x,o.y,o.w,o.h,pth,kk,seen,depth+i);
    var totKids=0;
    for(var q3=0;q3<(o.n.c||[]).length;q3++) totKids+=o.n.c[q3].s;
    if(expanded[pth]&&totKids>0){
      layoutInto(o.n,o.x+2,o.y+16,Math.max(0,o.w-4),Math.max(0,o.h-16),pth,seen);
    } else if(expanded[pth]&&!o.n.f&&!o.n.done){
      // 展开了一个还没扫到/尚无体积的目录：整个内部显示"统计中"占位（优先扫描已在调度）
      var ck=getCell(pth+'|:counting');
      paintCell(ck,{n:{n:'',s:0,raw:0,done:false,f:0}},
        o.x+2,o.y+16,Math.max(0,o.w-4),Math.max(0,o.h-16),pth,ck,seen,depth);
      ck.style.backgroundColor='#223247';
      var cl=ck.querySelector('.lbl');
      cl.textContent='⟳ 统计中…（已优先调度，扫到即显示）';
      cl.style.fontSize=(o.w>160&&o.h>56)?'14px':'11px';
      cl.style.paddingTop=(o.h>56)?'18px':'2px';
    }
  }
  if(agg&&stripH>0){
    var akk=keyBase+'|:agg';
    var ad=getCell(akk);
    paintCell(ad,{n:{n:'… 剩余'+aggN+'项（极小/未扫完）',s:aggS,raw:aggS,done:true,f:1,agg:aggN}},x0,y0+availH,w0,stripH,keyBase,akk,seen,depth);
    ad.style.background='#3f3f46';
  }
}

/* ===== 渲染（treemap 视图；render() 为 main.js 的视图调度器） ===== */
function renderTreemap(){
  if(!curPath) return;
  var node = store.get(curPath.toLowerCase());
  if(!node) return;
  var W = map.clientWidth, H = map.clientHeight;
  var items=(node.c||[]);
  var tot=0; for(var q=0;q<items.length;q++) tot+=items[q].s;
  var wait = document.getElementById('wait');
  if(items.length&&tot>0){ wait.style.display='none'; }
  else if(node.done){ wait.style.display='flex'; wait.innerHTML='<div><div style="margin-bottom:10px">'+esc(node.n)+'</div><div style="color:#8a8a8a">空目录，或全部子项已折叠进“剩余”条</div></div>'; }
  else { wait.style.display='flex'; wait.innerHTML='<div><div class="spin"></div><div style="margin-top:12px">counting directories...</div></div>'; }
  var seen={};
  layoutInto(node,0,0,W,H,curPath,seen);
  for(var key in divs){ if(!seen[key]){ var old=divs[key]; old.style.opacity='0';
    (function(el){ setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); },450); })(old);
    delete divs[key]; } }
}
function goUp(){
  if(!stack.length) return;
  var p=stack.pop(); curPath=p.path; divs={}; map.innerHTML=''; expanded={}; render();
}
function navigate(path,isChild){
  if(isChild!==false && curPath && store.get(curPath.toLowerCase())){ stack.push({name:store.get(curPath.toLowerCase()).n,path:curPath}); }
  curPath=path; divs={}; map.innerHTML=''; expanded={};
  // 进入还没扫完的目录 → 优先调度扫描
  var n=store.get(path.toLowerCase());
  if(typeof scanning!=='undefined'&&scanning&&n&&!n.done&&
     feed&&typeof feed.scanPriority==='function'){ feed.scanPriority(path); }
  render();
}

/* ===== 菜单 ===== */
function hideCtx(){ document.getElementById('ctx').style.display='none'; }
function openPathInExplorer(p,sel){ feed.open(p,sel); }
document.getElementById('mi-open').addEventListener('click',function(){ openPathInExplorer(menuPath,menuSel); hideCtx(); });
document.getElementById('mi-copy').addEventListener('click',function(){
  copyPath(menuPath,document.getElementById('mi-copy-t')); setTimeout(hideCtx,650); });
document.getElementById('mi-enter').addEventListener('click',function(){
  if(menuPath&&!menuSel){ navigate(menuPath); } hideCtx(); });
document.getElementById('mi-expand').addEventListener('click',function(){
  var p=menuPath;
  if(p&&!menuSel){
    if(expanded[p]){ delete expanded[p]; }
    else { expanded[p]=1; }
    render();
  }
  hideCtx();
});
document.addEventListener('mousedown',function(ev){
  var c=document.getElementById('ctx');
  if(c.style.display==='block'&&!c.contains(ev.target)) c.style.display='none';
},true);
document.addEventListener('keydown',function(e){
  if(e.target&&(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')) return;
  if(e.key==='Backspace'&&stack.length){ e.preventDefault(); goUp(); }
  if(e.key==='Escape'){ hideCtx();
    if(Object.keys(expanded).length){ expanded={}; render(); } }
});
// 空白处单击返回上一级。必须核对 mousedown 的起点：扫描中方块随数据不停位移/缩放，
// 按在方块上、抬起时方块已滑走 → click 落在 map 上，若不加甄别就会误触发 goUp，
// 表现为"扫描时要单击两次才展开"（第一次被吞掉）。
// 注意：本文件顶层执行时 main.js 还没给全局 map 赋值（var map 仍是 undefined，
// 顶层 map.addEventListener 曾在此处抛 TypeError，导致本行之后所有注册全部失效），
// 所以这里必须用 getElementById 直接取节点。
var _downOnMap = false;
var mapEl = document.getElementById('map');
mapEl.addEventListener('mousedown',function(ev){ _downOnMap = (ev.target === mapEl); });
mapEl.addEventListener('click',function(){ if(_downOnMap) goUp(); });
// 拖拽/缩放窗口时 resize 事件风暴会连环触发全量重绘造成卡顿：合并为最多 180ms 一次
var _rsT=null;
window.addEventListener('resize',function(){
  if(_rsT) return;
  _rsT=setTimeout(function(){ _rsT=null; render(); },180);
});
function copyPath(p,fbEl){
  function restore(){ if(fbEl) fbEl.textContent='复制完整路径'; }
  function ok(){ if(fbEl){ fbEl.textContent='✓ 已复制'; setTimeout(restore,900); } }
  function fail(){ if(fbEl){ fbEl.textContent='复制失败'; setTimeout(restore,1200); } }
  function fallback(){ var t=document.createElement('textarea'); t.value=p;
    document.body.appendChild(t); t.select();
    var done=false; try{ done=document.execCommand('copy'); }catch(e){ }
    document.body.removeChild(t);
    if(done){ ok(); } else { fail(); } }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(p).then(ok,fallback);
  } else { fallback(); }
}
