// DiskLens × c-relocator 联动 —— AI 辅助迁移/清理。
// 识别目录属于哪个工具，给出推荐动作（官方配置重定向 / junction / 清理），
// 并生成可直接发给 AI 助手（已安装 c-relocator skill）的现成指令。
// skill 安装：npx skills add AriesYB/c-relocator  |  https://github.com/AriesYB/c-relocator

var AI_GITHUB = 'https://github.com/AriesYB/c-relocator';

// 知识库：与 c-relocator 的 rules.json 对齐（npm/pip/conda/Gradle/Maven/cargo/Go/
// HuggingFace/JetBrains/VS Code/微信 QQ/WPS/CUDA/~/.cache 等）
var AI_KB = [
  { re:/\.gradle(\\|$)/i,        tool:'Gradle',          via:'GRADLE_USER_HOME 环境变量',            act:'redirect' },
  { re:/\.m2(\\|$)|repository/i, tool:'Maven',           via:'settings.xml 的 localRepository',      act:'redirect' },
  { re:/\.cargo|\.rustup/i,      tool:'cargo / rustup',  via:'CARGO_HOME / RUSTUP_HOME 环境变量',    act:'redirect' },
  { re:/conda|anaconda|miniconda/i, tool:'Conda',        via:'.condarc 的 envs_dirs/pkgs_dirs',      act:'redirect' },
  { re:/pip(\\|$)|pip\\cache/i,  tool:'pip',             via:'PIP_CACHE_DIR 环境变量',               act:'redirect' },
  { re:/npm-cache|\.npm/i,       tool:'npm',             via:'npm config set cache',                 act:'redirect' },
  { re:/go(\\|\/)(pkg|mod)/i,    tool:'Go',              via:'GOPATH / GOMODCACHE 环境变量',         act:'redirect' },
  { re:/huggingface/i,           tool:'HuggingFace',     via:'HF_HOME 环境变量',                     act:'redirect' },
  { re:/JetBrains/i,             tool:'JetBrains IDE',   via:'idea.properties 可改 system/config 位置', act:'redirect' },
  { re:/CUDA(\\|$)/i,            tool:'CUDA Toolkit',    via:'无官方重定向，junction 兜底',          act:'junction' },
  { re:/node_modules/i,          tool:'npm/yarn 项目',   via:'直接迁移（构建工具对 junction 透明）', act:'junction' },
  { re:/\.cache(\\|$)/i,         tool:'通用缓存',        via:'多为可再生产物，可迁移或清理',         act:'clean' },
  { re:/Electron|SquirrelTemp/i, tool:'Electron 更新缓存', via:'多为旧版本安装包，可安全清理',       act:'clean' },
  { re:/Docker.*\.vhdx|ext4\.vhdx/i, tool:'Docker Desktop', via:'Settings → Resources 官方迁移（勿 junction）', act:'tool' },
  { re:/lxss|wsl(\\|$)/i,        tool:'WSL',             via:'wsl --export / --import（勿直接搬）',  act:'tool' },
  { re:/OneDrive/i,              tool:'OneDrive',        via:'OneDrive 设置内更改位置',              act:'tool' },
  { re:/steamapps|Steam/i,       tool:'Steam',           via:'Steam → 存储 → 库文件夹移动',          act:'tool' }
];

function aiMatchKB(path) {
  for (var i = 0; i < AI_KB.length; i++) {
    if (AI_KB[i].re.test(path)) return AI_KB[i];
  }
  return null;
}

var ACT_LABEL = { redirect:'官方配置重定向（最干净，软件无感）',
                  junction:'junction 目录联接（对程序透明）',
                  clean:'可清理缓存（先列清单再删）',
                  tool:'到软件内迁移（不适合直接搬）' };

/* ===== AI 面板：双场景（scan=通道全盘分析 / skill=单目录深度处理） ===== */
var aiMode = 'scan';   // 当前场景
var aiPath = null;     // 右键选中的目录（顶栏入口为 null = 全盘）

function openAiAssist(path, mode) {
  var el = function(id){ return document.getElementById(id); };
  window.__migHandler = null;
  aiPath = path || null;
  el('ai-mask').style.display = 'flex';
  setAiMode(mode || 'scan');
}

function setAiMode(m) {
  aiMode = (m === 'skill') ? 'skill' : 'scan';
  var modes = document.querySelectorAll('#ai-modes .ai-mode');
  for (var i = 0; i < modes.length; i++)
    modes[i].classList.toggle('active', modes[i].dataset.mode === aiMode);
  // 场景专属区块显隐：通道只在 scan 场景出现；skill 专属按钮/安装提示只在 skill 场景
  document.getElementById('ai-channel').style.display = (aiMode === 'scan') ? '' : 'none';
  document.getElementById('ai-github').style.display = (aiMode === 'skill') ? '' : 'none';
  document.getElementById('ai-migrate').style.display = (aiMode === 'skill' && aiPath) ? '' : 'none';
  var inst = document.querySelector('.ai-install');
  if (inst) inst.style.display = (aiMode === 'skill') ? '' : 'none';
  if (aiMode === 'scan') refreshAiChannel();   // 通道区块随场景出现并刷新状态
  renderAiPanel();
}

function renderAiPanel() {
  var el = function(id){ return document.getElementById(id); };
  var kbHit = null, isSystem = false, node = null, sizeTxt = '';
  if (aiPath) {
    node = store.get(aiPath.toLowerCase());
    sizeTxt = node && node.s > 0 ? ' · ' + fmt(node.s) : '';
    kbHit = aiMatchKB(aiPath);
    if (!kbHit && typeof migGuidanceMap !== 'undefined') {
      for (var gi = 0; gi < migGuidanceMap.length; gi++) {
        if (migGuidanceMap[gi].re.test(aiPath)) { kbHit = { tool: migGuidanceMap[gi].t, act: 'tool', via: migGuidanceMap[gi].s }; break; }
      }
    }
    isSystem = /\\windows(\\|$)/i.test(aiPath) || /WindowsApps/i.test(aiPath) ||
               /pagefile|hiberfil|swapfile/i.test(aiPath);
  }

  // 顶部对象行
  el('ai-src').textContent = aiPath
    ? aiPath + sizeTxt
    : '全盘范围：' + (window.ROOT || '') + '（AI 从扫描快照里自行找目标）';

  var prompt = '';
  if (aiMode === 'scan') {
    el('ai-prompt-label').textContent = '① 复制下面的指令发给 AI 助手（ZCode / Claude Code 等）——它分析后这里会弹出确认面板：';
    el('ai-body').innerHTML = '';   // 说明都在指令里，面板只留复制动作
    var chOk = aiChInfo && aiChInfo.enabled && aiChInfo.port;
    if (!IN_TAURI) {
      prompt = '（浏览器演示模式无联动通道——请在桌面客户端内使用全盘分析。）';
    } else if (!chOk) {
      prompt = '（正在获取通道端点，稍候…若长时间无响应请重启应用。）';
    } else {
      var base = 'http://127.0.0.1:' + aiChInfo.port;
      var hd = '-H "X-DiskLens-Token: ' + aiChInfo.token + '"';
      prompt = '请作为磁盘清理顾问，全程只通过 DiskLens 联动通道工作（数据与执行均以此为准，' +
        '在拿到通道数据前不要用 du/PowerShell 等自己扫盘）：\n' +
        '第 0 步·查状态：curl -s ' + hd + ' ' + base + '/api/status\n' +
        '  → {"scanning":…,"hasSnapshot":…,"root":"…"}\n' +
        '  · hasSnapshot=false（还没扫过）：先触发扫描 curl -s -X POST ' + hd + ' -d \'{"root":"' +
        String(window.ROOT || 'C:\\\\') + '"}\' ' + base + '/api/scan' +
        '，之后每 5 秒轮询 /api/status 直到 scanning=false 且 hasSnapshot=true（大目录需几十秒到几分钟，期间向我播报进度）；\n' +
        '  · scanning=true（正在扫）：不要重复触发，轮询等它完成即可；\n' +
        '  · hasSnapshot=true 且 scanning=false：直接进第 1 步。\n' +
        '第 1 步·取数：curl -s ' + hd + ' ' + base + '/api/scan\n' +
        '  快照的 tree 字段是树形构成：节点 {n 名称, p 路径, s 大小, al 磁盘占用, c 子项[], agg 小项聚合, d 受限, f 文件叶}，' +
        '可直接看出层级分布（目录里哪个子目录/文件占大头），不需要自己 du。\n' +
        '  要看任意目录更细的分布（突破 10MB 粒度、含小目录）：curl -s ' + hd + ' "' + base + '/api/tree?path=c%3A%5Csome%5Cdir" 返回其直接子目录。\n' +
        '第 2 步·分析并回传提案：curl -s -X POST ' + hd + ' -d "@proposal.json" ' + base + '/api/proposal\n' +
        '  body: {"summary":"一句话结论","items":[\n' +
        '    {"action":"migrate","src":"绝对路径","dest_root":"D:\\\\","reason":"为什么值得 junction 迁移"},\n' +
        '    {"action":"cleanup","src":"…","reason":"可再生缓存/临时文件，说明为什么安全"},\n' +
        '    {"action":"note","src":"…","reason":"需改软件配置才能迁的，给出具体改法"}]}\n' +
        '第 3 步·执行约定：我会在 DiskLens 弹出的确认面板里勾选，migrate 项由 DiskLens 事务引擎执行' +
        '（复制→校验→junction，失败源目录原样保留）——你不要直接操作我的文件系统。\n' +
        '· 官方配置重定向类（GRADLE_USER_HOME、PIP_CACHE_DIR、Docker/WSL 数据盘等）一律放 note 项写清改法，不要提议 migrate。';
      if (aiPath) {
        prompt += '\n\n本次重点关注：「' + aiPath + '」' +
          (kbHit ? '（识别为 ' + kbHit.tool + '）' : '') +
          (node && node.s > 0 ? '，约 ' + fmt(node.s) : '') + '。';
      }
      prompt += '\n执行结果：curl -s ' + hd + ' ' + base + '/api/proposal 轮询。';
    }
  } else {
    // skill 场景：单目录深度处理（AI 自己动手：重定向 / 配置 / 清理台账）
    el('ai-prompt-label').textContent = '复制指令发给已装 c-relocator skill 的 AI 助手：';
    if (!aiPath) {
      el('ai-body').innerHTML = '<div class="ai-card"><div class="ai-card-t">未选定目录</div>' +
        '<div class="ai-card-s">深度处理针对单个目录——请先在方块/列表视图里右键一个目录再进此场景。</div></div>';
      el('ai-prompt').textContent = '';
      el('ai-prompt-wrap').style.display = 'none';
      return;
    }
    var html = '';
    if (isSystem) {
      html += '<div class="ai-card"><div class="ai-card-t">⛔ 系统目录 / 系统文件</div>' +
        '<div class="ai-card-s">不适合迁移或清理，AI 也不会碰它（c-relocator 有硬性禁止清单）。</div></div>';
    } else if (kbHit) {
      html += '<div class="ai-card"><div class="ai-card-t">识别为：' + esc(kbHit.tool) + '</div>' +
        '<div class="ai-card-s">推荐方式：<b>' + (ACT_LABEL[kbHit.act]||'') + '</b>' +
        (kbHit.via ? '——' + esc(kbHit.via) : '') + '</div></div>';
    } else {
      html += '<div class="ai-card"><div class="ai-card-t">未识别的目录</div>' +
        '<div class="ai-card-s">按通用流程处理：junction 方式迁移对绝大多数程序透明；' +
        '若里面有可再生的缓存/临时文件，也可以让 AI 先分析哪些能安全清理。</div></div>';
    }
    el('ai-body').innerHTML = html;
    if (isSystem) {
      prompt = '请检查「' + aiPath + '」是否有可安全清理的缓存或临时内容，'
        + '列出清单征求我确认后再操作；系统核心文件一律不动。';
    } else if (kbHit && kbHit.act === 'clean') {
      prompt = '请使用 c-relocator skill 分析「' + aiPath + '」：'
        + '先 audit 确认哪些是可再生缓存，列出可安全清理清单征求我确认；'
        + '其余部分如体积可观可迁移到剩余空间最大的 NTFS 盘并保留 undo 台账。';
    } else if (kbHit && kbHit.act === 'tool') {
      prompt = '「' + aiPath + '」属于 ' + kbHit.tool + ' 的数据，官方迁移方式：' + kbHit.via +
        '。请协助我完成迁移（不要直接搬目录）。';
    } else {
      var via = kbHit ? ('该目录属于 ' + kbHit.tool + '，优先走官方重定向（' + kbHit.via + '）')
                  : '优先检查所属软件是否支持官方改路径/重定向';
      prompt = '请使用 c-relocator skill 迁移「' + aiPath + '」到剩余空间最大的 NTFS 盘：'
        + via + '；无法重定向的部分用 NTFS junction 兜底；'
        + '迁移前预占位，完成后 audit 验证，保留 manifest 台账与 undo 能力。';
    }
  }
  el('ai-prompt').textContent = prompt;
  el('ai-prompt-wrap').style.display = (aiMode === 'skill' && isSystem) ? 'none' : '';
}

function closeAiAssist() {
  document.getElementById('ai-mask').style.display = 'none';
}

function openExternal(url) {
  try {
    if (IN_TAURI && window.__TAURI__.opener && window.__TAURI__.opener.openUrl) {
      window.__TAURI__.opener.openUrl(url);
      return;
    }
  } catch (e) {}
  window.open(url, '_blank');
}

(function initAiAssistUI() {
  document.getElementById('mi-ai').addEventListener('click', function () {
    var p = menuPath;
    hideCtx();
    openAiAssist(p, 'scan');   // 右键进入：默认全盘分析（可切换单目录深度处理）
  });
  // 顶栏直达：全盘分析（不依赖选中目录）
  document.getElementById('ai-bar-btn').addEventListener('click', function () {
    openAiAssist(null, 'scan');
  });
  // 场景卡片切换
  var modes = document.querySelectorAll('#ai-modes .ai-mode');
  for (var i = 0; i < modes.length; i++) {
    modes[i].addEventListener('click', function () { setAiMode(this.dataset.mode); });
  }
  document.getElementById('ai-close').addEventListener('click', closeAiAssist);
  document.getElementById('ai-mask').addEventListener('mousedown', function (ev) {
    if (ev.target === this) closeAiAssist();
  });
  document.getElementById('ai-copy').addEventListener('click', function () {
    var b = this;
    copyPath(document.getElementById('ai-prompt').textContent, b);
  });
  document.getElementById('ai-github').addEventListener('click', function () {
    openExternal(AI_GITHUB);
  });
  document.getElementById('ai-migrate').addEventListener('click', function () {
    closeAiAssist();
    if (aiPath) openMigrate(aiPath);
  });
})();

/* ===== AI 联动通道（本地 HTTP）：端点展示 / 启用开关 ===== */
var aiChInfo = null;   // {port, token, enabled}

function aiChEl(id){ return document.getElementById(id); }

function refreshAiChannel(){
  var st = aiChEl('ai-ch-status'), url = aiChEl('ai-ch-url'), tok = aiChEl('ai-ch-token');
  var tgl = aiChEl('ai-ch-enabled');
  if(!IN_TAURI){
    url.textContent='—'; tok.textContent='—'; tgl.checked=false; tgl.disabled=true;
    st.textContent='🔌 浏览器模式不可用'; st.className='ai-ch-status off';
    return;
  }
  feed.aiChannelInfo(function(info){
    if(!info || !info.port){
      url.textContent='—'; tok.textContent='—';
      st.textContent='🔌 通道未启动'; st.className='ai-ch-status err';
      return;
    }
    aiChInfo = info;
    url.textContent='http://127.0.0.1:'+info.port;
    tok.textContent=info.token;
    tgl.checked=!!info.enabled; tgl.disabled=false;
    if(!info.enabled){ st.textContent='🔌 已停用'; st.className='ai-ch-status off'; }
    else { st.textContent='🔌 已就绪' + (window.aiSnapReady ? '' : '（先扫一次盘）'); st.className='ai-ch-status ok'; }
    // 通道端点就绪后，全盘分析提示词从占位刷新为完整版
    if (aiMode === 'scan' && document.getElementById('ai-mask').style.display !== 'none') renderAiPanel();
  });
}

(function initAiChannel(){
  aiChEl('ai-ch-enabled').addEventListener('change', function(){
    var on = this.checked;
    if (IN_TAURI && feed.aiChannelSetEnabled) feed.aiChannelSetEnabled(on);
    var st = aiChEl('ai-ch-status');
    if(aiChInfo){ aiChInfo.enabled = on; }
    if(!on){ st.textContent='🔌 已停用'; st.className='ai-ch-status off'; }
    else { st.textContent='🔌 已就绪' + (window.aiSnapReady ? '' : '（先扫一次盘）'); st.className='ai-ch-status ok'; }
  });
  aiChEl('ai-ch-copy').addEventListener('click', function(){
    if(!aiChInfo || !aiChInfo.port) return;
    var b='http://127.0.0.1:'+aiChInfo.port;
    var txt='DiskLens AI 联动通道\n端点: '+b+'\n令牌: '+aiChInfo.token+
      '\n示例: curl -s -H "X-DiskLens-Token: '+aiChInfo.token+'" '+b+'/api/scan';
    copyPath(txt,null);
    setStatus('已复制通道接入信息','done');
  });
})();

/* ===== AI 提案面板：确认 + 串行执行迁移队列 ===== */
var propData = null;       // 当前提案 {id, summary, items, ...}
var propRunning = false;   // 执行中（禁止关闭/忽略/再次执行）
var propAborted = false;   // 用户点停：结束当前项后不再继续

function showProposal(p){
  if(!p || !p.items || !p.items.length) return;
  if(propRunning){   // 正在执行上一批：不弹新面板（后端 409 已挡绝大多数，双保险）
    setStatus('收到新 AI 提案，但当前批次执行中——稍后请 AI 重发','err');
    return;
  }
  propData = p;
  aiChEl('prop-summary').textContent = p.summary || '';
  aiChEl('prop-progress').textContent = '';
  aiChEl('prop-stop').style.display = 'none';
  renderProposal();
  aiChEl('prop-run').disabled = false;
  aiChEl('prop-reject').disabled = false;
  aiChEl('prop-close').disabled = false;
  aiChEl('prop-mask').style.display = 'flex';
}

function renderProposal(){
  var items = propData.items || [];
  var html = '';
  for(var i=0;i<items.length;i++){
    var it = items[i] || {};
    var act = it.action || 'note';
    var badge = act==='migrate' ? '<span class="pr-badge migrate">📦 迁移</span>'
              : act==='cleanup' ? '<span class="pr-badge cleanup">🧹 清理建议</span>'
              : '<span class="pr-badge note">📝 说明</span>';
    var node = store.get(String(it.src||'').toLowerCase());
    var size = node ? fmt(node.s) : (it.est_bytes ? fmt(it.est_bytes) : '');
    var cb = act==='migrate' ? '<input type="checkbox" class="pr-cb" data-i="'+i+'" checked>'
                             : '<span style="display:inline-block;width:13px"></span>';
    html+='<div class="pr-row">'
      +'<div class="pr-top">'+cb+badge
      +'<span class="pr-path" title="'+escAttr(it.src||'')+'">'+esc(it.src||'')+'</span>'
      +(size?'<span class="pr-size">'+size+'</span>':'')
      +'<span class="pr-act">'+(act!=='migrate'&&it.src?'<button class="pr-loc" data-p="'+escAttr(it.src)+'">📂 定位</button>':'')+'</span>'
      +'</div><div class="pr-sub">'
      +(act==='migrate'&&it.dest_root?'<div>目标：<span class="dest">'+esc(it.dest_root)+'</span></div>':'')
      +(it.reason?'<div class="reason">理由：'+esc(it.reason)+'</div>':'')
      +'</div><div class="pr-st" id="pr-st-'+i+'"></div></div>';
  }
  aiChEl('prop-list').innerHTML = html || '<div class="pr-empty">提案没有条目</div>';
}

function prSt(i, cls, text){
  var el = document.getElementById('pr-st-'+i);
  if(el){ el.className='pr-st '+cls; el.textContent=text; }
}

function propProg(t){ aiChEl('prop-progress').textContent = t; }

// 串行执行：预检 → 迁移 → done/error 后下一项（后端 MigrateState 单实例互斥）
function runProposal(){
  if(!propData || propRunning) return;
  if(typeof migRunning!=='undefined' && migRunning){
    propProg('⛔ 迁移对话框正在执行——请先等它完成或关闭');
    return;
  }
  var items = propData.items || [];
  var sel = [];
  var cbs = document.querySelectorAll('#prop-list .pr-cb');
  for(var c=0;c<cbs.length;c++){ if(cbs[c].checked) sel.push(parseInt(cbs[c].dataset.i,10)); }
  if(!sel.length){ propProg('没有勾选任何迁移项'); return; }
  propRunning = true; propAborted = false;
  aiChEl('prop-run').disabled = true;
  aiChEl('prop-reject').disabled = true;
  aiChEl('prop-close').disabled = true;
  aiChEl('prop-stop').style.display = '';
  var results = [];
  var doneN = 0, failN = 0, k = 0;

  function finish(status){
    propRunning = false;
    window.__migHandler = null;
    aiChEl('prop-stop').style.display = 'none';
    aiChEl('prop-close').disabled = false;
    propProg('完成：✓ '+doneN+' 成功 · ⛔ '+failN+' 失败'+(propAborted?' · 已手动停止':'')
      +'（结果已回传，AI 可经 /api/proposal 查询）');
    if(feed.aiProposalResult) feed.aiProposalResult(propData.id, status, results);
    // 迁移过的目录：建议重扫刷新视图
    if(doneN>0) setStatus('AI 提案执行完毕（成功 '+doneN+' 项）——建议重新扫描','done');
  }

  (function next(){
    if(k>=sel.length || propAborted) return finish(propAborted?'aborted':'done');
    var i = sel[k], it = items[i] || {};
    var src = it.src||'', dest = it.dest_root||'';
    prSt(i,'run','⟳ 预检中…');
    propProg('第 '+(k+1)+'/'+sel.length+' 项：预检 '+src);
    feed.migrateCheck(src, dest, function(r){
      if(!r){ prSt(i,'err','⛔ 预检失败'); results.push({src:src,ok:false,error:'预检失败'});
        failN++; k++; return next(); }
      if(!r.ok){
        var msg=(r.blockers||[]).join('；')||'预检未通过';
        prSt(i,'err','⛔ '+msg); results.push({src:src,ok:false,error:msg});
        failN++; k++; return next();
      }
      prSt(i,'run','⟳ 迁移中… 0%');
      window.__migHandler = function(ev){
        if(ev.stage==='copy'||ev.stage==='verify'||ev.stage==='switch'){
          var pct = ev.bytes_total>0 ? Math.round(ev.bytes_done/ev.bytes_total*100) : 100;
          var ph = ev.stage==='copy'?'复制':(ev.stage==='verify'?'校验':'切换 junction');
          prSt(i,'run','⟳ '+ph+'… '+pct+'%'+(ev.current?' · '+ev.current:''));
          return;
        }
        if(ev.stage==='done'){
          prSt(i,'ok','✓ 迁移完成（原位置已建 junction）');
          results.push({src:src,ok:true,dest:r.dest_path||dest});
          doneN++; k++; return next();
        }
        // error / aborted / locked
        var m = ev.message || ev.stage;
        if(ev.locked && ev.locked.length) m += '（'+ev.locked.length+' 个文件被占用）';
        prSt(i,'err',(ev.stage==='aborted'?'⏹ ':'⛔ ')+m);
        results.push({src:src,ok:false,error:m});
        failN++; k++; return next();
      };
      feed.migrateStart(src, dest);
    });
  })();
}

function closeProposal(reject){
  if(propRunning) return;
  if(reject && propData && propData.status==='pending' && feed.aiProposalResult){
    feed.aiProposalResult(propData.id, 'rejected', []);
  }
  propData = null;
  aiChEl('prop-mask').style.display = 'none';
}

(function initProposalUI(){
  aiChEl('prop-run').addEventListener('click', runProposal);
  aiChEl('prop-reject').addEventListener('click', function(){ closeProposal(true); });
  aiChEl('prop-close').addEventListener('click', function(){ closeProposal(true); });
  aiChEl('prop-mask').addEventListener('mousedown', function(ev){
    if(ev.target===this) closeProposal(true);
  });
  aiChEl('prop-stop').addEventListener('click', function(){
    propAborted = true;
    propProg('正在停止（当前项完成后结束）…');
    if(feed.migrateStop) feed.migrateStop();
  });
  aiChEl('prop-list').addEventListener('click', function(ev){
    var b = ev.target.closest('button.pr-loc');
    if(b && b.dataset.p) feed.open(b.dataset.p, true);
  });
})();

// 浏览器模式 / 调试入口：模拟一条 AI 提案（与 POST /api/proposal 的 payload 同构）
window.__testProposal = function(p){ showProposal(p); };
