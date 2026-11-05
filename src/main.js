/* DiskLens main —— Feed 抽象（Tauri 事件 / 浏览器 Mock）+ store + 工具栏 */
/* globals ROOT, curPath, store, render, treemap 已由 treemap.js 注入全局 */

var feed;
var store = new Map();          // lower(path) -> { n,s,done,p,f,c:[] }
var dirty = false;
var IN_TAURI = !!window.__TAURI__;

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
  markDirty();
}
(function loop(){
  if(dirty){
    dirty = false;
    try { render(); }
    catch(e){
      window.__errs = window.__errs || [];
      window.__errs.push('render: ' + e.message);
      try { setStatus('渲染异常：' + e.message); } catch(_) {}
    }
  }
  setTimeout(loop, 150);
})();

/* ===== Tauri Feed：invoke 扫描命令 + 监听事件流 ===== */
function TauriFeed(){
  var self = this;
  window.__TAURI__.event.listen('scan-update', function(ev){ applyEvent(ev.payload); });
  window.__TAURI__.event.listen('scan-finished', function(ev){
    setStatus(ev.payload || '完成');
    setScanning(false);
  });
}
TauriFeed.prototype.start = function(root){
  var self = this;
  setStatus('扫描中…');
  window.__TAURI__.core.invoke('scan_start', { root: root }).catch(function(e){
    setStatus(String(e));
    setScanning(false);
  });
};
TauriFeed.prototype.stop = function(){
  window.__TAURI__.core.invoke('scan_stop').catch(function(){});
};
TauriFeed.prototype.open = function(p, sel){
  window.__TAURI__.core.invoke('open_in_explorer', { path: p, select: !!sel }).catch(function(e){
    setStatus(String(e));
  });
};

/* ===== Mock Feed：浏览器直接打开 index.html 时的合成数据（UI 开发用） ===== */
function MockFeed(){ this.timers = []; }
MockFeed.prototype._clear = function(){ this.timers.forEach(clearTimeout); this.timers = []; };
MockFeed.prototype.start = function(root, onDone){
  var self = this;
  this._clear();
  this.onDone = onDone;
  var GB = 1073741824;
  var dirs = [
    ['C:\\', '', 'C:\\'],
    ['C:\\Users', 'C:\\', 'Users'],
    ['C:\\Users\\HetFrame', 'C:\\Users', 'HetFrame'],
    ['C:\\Users\\HetFrame\\AppData', 'C:\\Users\\HetFrame', 'AppData'],
    ['C:\\Program Files', 'C:\\', 'Program Files'],
    ['C:\\ProgramData', 'C:\\', 'ProgramData'],
    ['C:\\Windows', 'C:\\', 'Windows']
  ];
  var files = [
    ['C:\\pagefile.sys', 'C:\\', 'pagefile.sys', 25.5],
    ['C:\\hiberfil.sys', 'C:\\', 'hiberfil.sys', 6.2]
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
  var growth = { 'C:\\Users':59.5, 'C:\\Users\\HetFrame':58.4, 'C:\\Users\\HetFrame\\AppData':34.8,
                 'C:\\Program Files':7.85, 'C:\\ProgramData':5.39, 'C:\\Windows':21.3, 'C:\\':140 };
  var ticks = 12;
  for(var t = 1; t <= ticks; t++){
    (function(frac){
      self.timers.push(setTimeout(function(){
        for(var p in growth){
          var target = growth[p]*GB;
          var base = p === 'C:\\' ? 29.17*GB : target*0.06;
          var parts = p.split('\\');
          applyEvent({ path:p, parent:parts.slice(0,-1).join('\\'), name:parts[parts.length-1],
                       size:Math.round(base+(target-base)*frac/ticks), done:false, file:false });
        }
      }, 800+t*420));
    })(t);
  }
  // 第二波：深层目录"晚些才被扫到"并渐进生长（模拟真实 DFS 越扫越深，下钻有东西可看）
  var late = [
    ['C:\\Users\\HetFrame\\AppData\\Local', 'C:\\Users\\HetFrame\\AppData', 'Local', 25.2, 9200],
    ['C:\\Users\\HetFrame\\AppData\\LocalLow', 'C:\\Users\\HetFrame\\AppData', 'LocalLow', 0.8, 9600],
    ['C:\\Users\\HetFrame\\AppData\\Roaming', 'C:\\Users\\HetFrame\\AppData', 'Roaming', 8.1, 10000],
    ['C:\\Users\\HetFrame\\Desktop', 'C:\\Users\\HetFrame', 'Desktop', 6.0, 10400],
    ['C:\\Users\\HetFrame\\Documents', 'C:\\Users\\HetFrame', 'Documents', 3.5, 10800],
    ['C:\\Users\\HetFrame\\Downloads', 'C:\\Users\\HetFrame', 'Downloads', 26.1, 11200],
    ['C:\\Users\\HetFrame\\.vscode', 'C:\\Users\\HetFrame', '.vscode', 2.0, 11600],
    ['C:\\Program Files\\Windows Apps', 'C:\\Program Files', 'Windows Apps', 4.2, 12000],
    ['C:\\ProgramData\\Microsoft', 'C:\\ProgramData', 'Microsoft', 3.1, 12400],
    ['C:\\Windows\\System32', 'C:\\Windows', 'System32', 6.1, 12800]
  ];
  var growth2 = {
    'C:\\Users\\HetFrame\\AppData\\Local':25.2, 'C:\\Users\\HetFrame\\AppData\\Roaming':8.1,
    'C:\\Users\\HetFrame\\AppData\\LocalLow':0.8, 'C:\\Users\\HetFrame\\Desktop':6.0,
    'C:\\Users\\HetFrame\\Documents':3.5, 'C:\\Users\\HetFrame\\Downloads':26.1,
    'C:\\Users\\HetFrame\\.vscode':2.0, 'C:\\Program Files\\Windows Apps':4.2,
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
    if(self.onDone) self.onDone('模拟扫描完成');
  }, 13200+(ticks2+1)*620));
};
MockFeed.prototype.stop = function(){ this._clear(); setStatus('已停止'); };
MockFeed.prototype.open = function(p){
  setStatus('浏览器模式：打开文件夹需在 Tauri 客户端内使用（'+p+'）');
};

/* ===== 工具栏 ===== */
function setStatus(s){ var el = document.getElementById('status'); if(el) el.textContent = s; }
function setScanning(on){
  document.getElementById('scan-btn').disabled = on;
  document.getElementById('stop-btn').disabled = !on;
}

window.addEventListener('DOMContentLoaded', function(){
  window.map = document.getElementById('map');
  window.rootInput = document.getElementById('root-input');
  window.statusEl = document.getElementById('status');
  window.ROOT = window.rootInput.value || 'C:\\';
  window.curPath = window.ROOT;
  feed = IN_TAURI ? new TauriFeed() : new MockFeed();
  render();
  if(!IN_TAURI) setStatus('浏览器模式（合成数据）；Tauri 客户端内为真实扫描');

  document.getElementById('scan-btn').addEventListener('click', function(){
    window.ROOT = window.rootInput.value || 'C:\\';
    window.curPath = window.ROOT;
    store.clear(); window.divs = {}; window.map.innerHTML = '';
    window.expanded = {}; window.stack = [];
    setScanning(true);
    document.getElementById('foot').innerHTML =
      'scanning <b>'+esc(window.ROOT)+'</b> … <span id="stat"></span> · 单击展开/收起 · 双击进入 · 右键更多操作';
    render();
    feed.start(window.ROOT);
  });
  document.getElementById('stop-btn').addEventListener('click', function(){ feed.stop(); });
});
