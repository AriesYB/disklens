/* DiskLens main —— Feed 抽象（Tauri 事件 / 浏览器 Mock）+ 视图调度 + 工具栏。
   全局状态（store/curPath/stack/divs/expanded…）由 treemap.js 声明，本文件只驱动。 */

var feed;
var dirty = false;
var IN_TAURI = !!window.__TAURI__;
var viewMode = 'treemap';
var fileIndex = new Map();   // lower(path) -> 文件节点（供大文件榜使用）
var scanning = false;
var scanT0 = 0;

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
  n.s = ev.size;
  n.done = ev.done;
  var idx = ev.path.lastIndexOf('\\');
  var parentPath = idx > 0 ? ev.path.slice(0, idx) : '';
  if(parentPath){
    var pn = store.get(parentPath.toLowerCase());
    if(pn && !pn.c.includes(n)) pn.c.push(n);   // 时序原因成孤儿的自动回挂
  }
  if(n.f) fileIndex.set(ev.path.toLowerCase(), n);   // 文件入索引，大文件榜用
  markDirty();
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

/* ===== Tauri Feed：invoke 扫描命令 + 监听事件流 ===== */
function TauriFeed(){
  window.__TAURI__.event.listen('scan-update', function(ev){ applyEvent(ev.payload); });
  window.__TAURI__.event.listen('scan-finished', function(ev){
    setStatus(ev.payload || '完成', 'done');
    setScanning(false);
  });
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
    else { setStatus(msg, 'done'); setScanning(false); }
  }, 13200+(ticks2+1)*620));
};
MockFeed.prototype.stop = function(){ this._clear(); setStatus('已停止','done'); setScanning(false); };
MockFeed.prototype.open = function(p){
  setStatus('浏览器模式：打开文件夹需在 Tauri 客户端内使用','err');
};

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
  document.getElementById('scan-btn').addEventListener('click', function(){
    window.ROOT = window.rootInput.value || 'C:\\';
    window.curPath = window.ROOT;
    store.clear(); fileIndex.clear(); window.divs = {}; window.map.innerHTML = '';
    document.getElementById('list').innerHTML = '';
    document.getElementById('files').innerHTML = '';
    window.expanded = {}; window.stack = []; selectedRow = '';
    setScanning(true);
    setStatus('扫描中…', 'scanning');
    render();
    feed.start(window.ROOT);
  });
  document.getElementById('stop-btn').addEventListener('click', function(){ feed.stop(); });
});
