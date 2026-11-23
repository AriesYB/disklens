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

/* ===== AI 面板：扫描分析 / 单目录深度处理 ===== */
var aiMode = 'scan';   // 当前场景
var aiPath = null;     // 右键选中的目录
var aiScope = null;    // 手动选定的盘符范围
var aiDataChoice = 'fresh';

function aiScanRoots(){
  return aiScope || (aiPath ? [aiPath] : curPath===THISPC ? ROOTS.slice() : [curPath]);
}

function openAiAssist(path, mode) {
  var el = function(id){ return document.getElementById(id); };
  window.__migHandler = null;
  aiPath = path || null;
  aiScope = null;   // 每次打开重置为跟随当前扫描范围
  aiDataChoice = 'fresh';
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
  document.getElementById('ai-scan-settings').hidden = aiMode !== 'scan';
  document.getElementById('ai-github').style.display = (aiMode === 'skill') ? '' : 'none';
  document.getElementById('ai-migrate').style.display = (aiMode === 'skill' && aiPath) ? '' : 'none';
  var inst = document.querySelector('.ai-install');
  if (inst) inst.style.display = (aiMode === 'skill') ? '' : 'none';
  if (aiMode === 'scan') refreshAiChannel();   // 通道区块随场景出现并刷新状态
  renderAiPanel();
}

function syncAiScanControls(){
  document.querySelectorAll('[data-ai-data]').forEach(function(button){
    button.setAttribute('aria-pressed', button.dataset.aiData===aiDataChoice);
  });
  if(aiMode==='scan'){
    aiChEl('ai-prompt-label').textContent = aiDataChoice==='fresh'
      ? '将指令发给 AI 后，DiskLens 会扫描所选范围。可在主界面停止。'
      : 'AI 会读取已有记录，并说明数据时间。';
  }
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
  if (aiPath) {
    el('ai-src').textContent = aiPath + sizeTxt;
  } else {
    // 盘根范围可增减盘符，目录范围跟随当前路径。
    var scopeRoots = aiScanRoots();
    var drives = (typeof drivesCache !== 'undefined' && drivesCache) ? drivesCache : [];
    var chips = '';
    for (var ci = 0; ci < scopeRoots.length; ci++) {
      var rp = scopeRoots[ci];
      var lab = rp;
      for (var di = 0; di < drives.length; di++) {
        if (String(drives[di].mount).toLowerCase() === String(rp).toLowerCase()) {
          lab = drives[di].mount + (drives[di].label ? ' ' + drives[di].label : '');
          break;
        }
      }
      chips += '<span class="ai-scope-chip">' + esc(lab) +
        (scopeRoots.length > 1 ? '<button class="ai-scope-x" data-p="' + escAttr(rp) + '" title="移出分析范围">×</button>' : '') +
        '</span>';
    }
    var rest = '';
    for (var ri = 0; ri < drives.length; ri++) {
      var dm = drives[ri].mount, hit = false;
      for (var rj = 0; rj < scopeRoots.length; rj++) {
        if (String(scopeRoots[rj]).toLowerCase() === String(dm).toLowerCase()) { hit = true; break; }
      }
      if (!hit) rest += '<option value="' + escAttr(dm) + '">' + esc(dm + (drives[ri].label ? ' ' + drives[ri].label : '')) + '</option>';
    }
    var adder = rest && scopeRoots.every(function(path){ return /^[a-z]:\\$/i.test(path); })
      ? '<select id="ai-scope-add" title="添加分析范围"><option value="">＋ 添加盘…</option>' + rest + '</select>'
      : '';
    el('ai-src').innerHTML = '分析范围：' + chips + adder;
    var xBtns = el('ai-src').querySelectorAll('button.ai-scope-x');
    for (var xb = 0; xb < xBtns.length; xb++) {
      xBtns[xb].addEventListener('click', function(){
        var p = this.dataset.p, next = [];
        var cur0 = aiScanRoots();
        for (var k = 0; k < cur0.length; k++) {
          if (String(cur0[k]).toLowerCase() !== String(p).toLowerCase()) next.push(cur0[k]);
        }
        if (next.length) { aiScope = next; renderAiPanel(); }   // 至少保留一个盘
      });
    }
    var addEl = document.getElementById('ai-scope-add');
    if (addEl) {
      addEl.addEventListener('change', function(){
        if (!this.value) return;
        var cur1 = aiScanRoots().slice();
        cur1.push(this.value);
        aiScope = cur1;
        renderAiPanel();
      });
    }
  }

  var prompt = '';
  if (aiMode === 'scan') {
    el('ai-body').innerHTML = '';   // 说明都在指令里，面板只留复制动作
    var chOk = aiChInfo && aiChInfo.enabled && aiChInfo.port;
    if (!IN_TAURI) {
      prompt = '（AI 联动通道可在桌面客户端使用。）';
    } else if (!chOk) {
      prompt = '（正在获取通道端点，稍候…若长时间无响应请重启应用。）';
    } else {
      var base = 'http://127.0.0.1:' + aiChInfo.port;
      var hd = '-H "X-DiskLens-Token: ' + aiChInfo.token + '"';
      var scanRoots = aiScanRoots();
      var policy = aiDataChoice==='reuse' ? 'reuse' : 'auto';
      var paths = scanRoots.map(function(path){ return 'path='+encodeURIComponent(path).replace(/'/g,'%27'); });
      var read = 'curl -sS --max-time 5 ' + hd + ' "' + base;
      var statusCommand = read + '/api/status?' + paths.join('&') + '&policy=' + policy + '"';
      var treeCommands = paths.map(function(path){
        return read + '/api/tree?' + path + '&depth=4&min=100MB&flat=1"';
      }).join('\n    ');
      var snapshotCommands = paths.map(function(path){
        return read + '/api/scan?' + path + '&depth=3"';
      }).join('\n    ');
      var scopeNote = scanRoots.length > 1
        ? '本次分析范围为 ' + scanRoots.join('、')
        : '本次分析和提案范围仅限「' + scanRoots[0] + '」及其子目录';
      var fresh = aiDataChoice === 'fresh';
      var prepare;
      if(fresh){
        var scanRequest = {roots:scanRoots, policy:'refresh'};
        if(needsDetailedScan(scanRoots)) scanRequest.full = true;
        var request = JSON.stringify(scanRequest).replace(/'/g,'\\u0027');
        var start = 'curl -sS --max-time 8 -X POST ' + hd +
          ' -H "Content-Type: application/json" --data-binary ' + "'" + request + "'" + ' ' + base + '/api/scan';
        prepare = '第 0 步·按所选范围启动一次后台扫描。DiskLens 会按列表顺序逐盘扫描，盘内并行。执行下方命令。\n    ' + start + '\n' +
          '  · 仅在返回 started=true 时记录 scanId。若请求失败、超时或已有扫描在运行，请说明情况并结束，勿重发 POST。\n' +
          '  · 每 5 秒分次执行下方 GET。运行时使用 progress 的已访问文件、目录、已统计字节和完成扫描根数来报告进展。' +
          '只要这些指标还在推进就继续等待。若连续 120 秒无推进，告知我当前 scanId 和进度，并保留本次任务供后续查询。\n    ' + statusCommand + '\n' +
          '  · 仅在 scanId 与本次一致且 scanState=completed、ready=true 时取数。若 source=snapshot，另需 snapshotScanId 等于本次 scanId；扫描完成后最多再等 30 秒发布快照。' +
          '若已停止或 scanId 改变，说明情况并结束。勿读取以前的快照或重新发起扫描。\n';
      } else {
        prepare = '第 0 步·只读检查一次。请执行下方 GET 命令。\n    ' + statusCommand + '\n' +
          '  · 若 ready=false、scanning=true 或请求失败，告诉我现有数据不可用或扫描正在进行，然后结束。不要自动重试或轮询。\n' +
          '  · 若 ready=true，说明结果已有 scanAgeSeconds 秒，根据 source 读取对应的数据。\n';
      }
      prompt = '请作为磁盘清理顾问，通过 DiskLens 分析数据。禁止用其他工具自行遍历磁盘。\n' +
        scopeNote + '。\n' + prepare +
        '第 1 步·读取已有数据。\n' +
        '  · 若状态返回 detailsLimited=true，目录总量包含已聚合内容，明细只保留部分目录。分析时请说明这一点。\n' +
        '  · 若 source=detail，执行以下大小清单查询。\n    ' + treeCommands + '\n' +
        '  · 若 source=snapshot，执行以下快照查询。快照可能只包含部分子项，请说明这一限制，并依据列出的条目分析。\n    ' + snapshotCommands + '\n' +
        '  · 下钻只允许本次范围内的目录。读数失败时请结束并告知我。\n' +
        '第 2 步·分析并回传提案：curl -s -X POST ' + hd + ' -d "@proposal.json" ' + base + '/api/proposal\n' +
        '  body: {"summary":"一句话结论","items":[\n' +
        '    {"action":"migrate","src":"绝对路径","dest_root":"D:\\\\","reason":"为什么值得 junction 迁移"},\n' +
        '    {"action":"cleanup","src":"…","reason":"可再生缓存/临时文件，说明为什么安全"},\n' +
        '    {"action":"note","src":"…","reason":"需改软件配置才能迁的，给出具体改法"}]}\n' +
        '  提案按范围（盘符）并存：范围含多个盘时，可逐盘分析、每盘各回传一份提案（哪些盘以第 0 步确认的本次范围为准），用户会逐个确认——不要等所有盘都分析完才回传，也不要分析范围之外的盘；\n' +
        '第 3 步·执行约定：我会在 DiskLens 弹出的确认面板里勾选，migrate 项由 DiskLens 事务引擎执行' +
        '（复制→校验→junction，失败源目录原样保留）——你不要直接操作我的文件系统。\n' +
        '· 官方配置重定向类（GRADLE_USER_HOME、PIP_CACHE_DIR、Docker/WSL 数据盘等）一律放 note 项写清改法，不要提议 migrate。';
      if (aiPath) {
        prompt += '\n\n本次重点关注：「' + aiPath + '」' +
          (kbHit ? '（识别为 ' + kbHit.tool + '）' : '') +
          (node && node.s > 0 ? '，约 ' + fmt(node.s) : '') + '。';
      }
      prompt += '\n执行结果：curl -s ' + hd + ' ' + base + '/api/proposal?id=<POST 返回的 id> 轮询（多盘提案并存，必带 id）。';
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
  syncAiScanControls();
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
    openAiAssist(p, 'scan');
  });
  // 顶栏入口以当前展示路径为分析范围。
  document.getElementById('ai-bar-btn').addEventListener('click', function () {
    openAiAssist(null, 'scan');
  });
  document.querySelectorAll('[data-ai-data]').forEach(function(button){
    button.addEventListener('click', function(){
      aiDataChoice = this.dataset.aiData;
      renderAiPanel();
    });
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
    else { st.textContent='🔌 已就绪 · 读取已有结果'; st.className='ai-ch-status ok'; }
    // 通道端点就绪后刷新提示词。
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
    else { st.textContent='🔌 已就绪 · 读取已有结果'; st.className='ai-ch-status ok'; }
  });
  // 轮换令牌：旧令牌立即失效，已发给 AI 的接入信息要重新复制
  aiChEl('ai-ch-rotate').addEventListener('click', function(){
    if(!IN_TAURI || !feed.aiChannelRotateToken) return;
    if(!window.confirm('确定换新令牌？\n旧令牌立即失效，之前发给 AI 助手的接入信息需要重新复制。')){
      return;
    }
    feed.aiChannelRotateToken(function(){
      refreshAiChannel();
      setStatus('已生成新令牌（已自动写盘，重启后不变）——请重新复制通道接入信息', 'done');
    });
  });
  aiChEl('ai-ch-copy').addEventListener('click', function(){
    if(!aiChInfo || !aiChInfo.port) return;
    var b='http://127.0.0.1:'+aiChInfo.port;
    var txt='DiskLens AI 联动通道\n端点: '+b+'\n令牌: '+aiChInfo.token+
      '\n示例: curl -s -H "X-DiskLens-Token: '+aiChInfo.token+'" "'+b+'/api/tree?depth=3"（响应几 KB，直接读 stdout）';
    copyPath(txt,null);
    setStatus('已复制通道接入信息','done');
  });
})();

/* ===== AI 提案面板：确认 + 串行执行迁移队列 ===== */
var propData = null;       // 当前展示的提案 {id, summary, items, scope, ...}
var propQueue = [];        // 待确认提案队列：按盘符范围并存（先扫 C 再切 D，两边可同时等确认）
var propRunning = false;   // 执行中（禁止关闭/忽略/再次执行）
var propAborted = false;   // 用户点停：结束当前项后不再继续

// 提案范围口语名（后端从 items[].src 推导的 scope 键 →「C:\」「C:\+D:\」，空=未标注）
function propScopeLabel(p){
  var key = String((p && p.scope) || '');
  if(!key || key === 'global') return '';
  return key.split(',').filter(Boolean).map(function(r){
    return String(r).replace(/\\+$/, '').toUpperCase() + '\\';
  }).join('+');
}

// 面板顶部多提案切换条：pending ≥2 时出现（按范围并存时逐个确认）
function renderPropTabs(){
  var el = aiChEl('prop-tabs');
  if(!el) return;
  var pend = propQueue.filter(function(q){ return q.status==='pending'; });
  if(pend.length < 2){ el.style.display='none'; el.innerHTML=''; return; }
  var html='';
  for(var i=0;i<pend.length;i++){
    var q = pend[i];
    var act = (propData && propData.id===q.id) ? ' active' : '';
    html += '<button class="prop-tab'+act+'" data-id="'+escAttr(String(q.id||''))+'">'+
      esc(propScopeLabel(q)||'通用')+'（'+(q.items||[]).length+'项）</button>';
  }
  el.innerHTML = html;
  el.style.display = 'flex';
}

// 悬浮角标同步：有 pending 提案才显示，多提案时带数量；title 列出各范围
function updatePropFab(){
  var b = document.getElementById('prop-fab');
  if(!b) return;
  var pend = propQueue.filter(function(q){ return q.status==='pending'; });
  if(pend.length){
    b.style.display = 'flex';
    document.getElementById('prop-fab-n').textContent = pend.length > 1 ? String(pend.length) : '';
    var names = pend.map(function(q){ return propScopeLabel(q)||'通用'; }).join('、');
    b.title = 'AI 提案待确认：' + names + ' —— 点击打开确认面板';
  } else {
    b.style.display = 'none';
  }
}

function showProposal(p){
  if(!p || !p.items || !p.items.length) return;
  // pending 提案登记进队列（重开/已在队列的不重复）。
  // 角标无条件同步——启动恢复路径的提案是先入队再弹面板，
  // 走不到下面的推入分支，只在这里刷角标会漏（悬浮窗消失 bug）
  if(p.status==='pending' && p.id && !propQueue.some(function(q){ return q.id===p.id; })){
    propQueue.push(p);
  }
  updatePropFab();
  var reopening = !!(propData && propData.id === p.id);
  diagLog('info', (reopening ? '重新打开' : '收到') + ' AI 提案「' + (p.summary||'') + '」（' + (p.items.length||0) + ' 项）');
  if(propRunning){   // 正在执行上一批：不弹面板，提案留在队列（状态栏 chip 可见）
    setStatus('收到新 AI 提案，但当前批次执行中——完成后可从状态栏「待确认」打开','err');
    return;
  }
  propData = p;
  if(!reopening) propResults = [];   // 重开同一提案保留已累积的行级结果
  aiChEl('prop-scope').textContent = propScopeLabel(p) ? '【' + propScopeLabel(p) + '】' : '';
  aiChEl('prop-summary').textContent = p.summary || '';
  aiChEl('prop-progress').textContent = '';
  aiChEl('prop-stop').style.display = 'none';
  renderProposal();
  renderPropTabs();
  aiChEl('prop-run').disabled = false;
  aiChEl('prop-reject').disabled = false;
  aiChEl('prop-close').disabled = false;
  aiChEl('prop-mask').style.display = 'flex';
}

// 启动恢复：把落盘的 pending 提案整队登记（多盘并存），弹最新一条
function restoreProposals(list){
  var pend = (list||[]).filter(function(p){
    return p && p.status==='pending' && p.items && p.items.length;
  });
  for(var i=0;i<pend.length;i++){
    if(!propQueue.some(function(q){ return q.id===pend[i].id; })) propQueue.push(pend[i]);
  }
  if(pend.length){
    if(!propRunning) showProposal(pend[pend.length-1]);
    else updatePropFab();
  }
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
    // 迁移默认勾选；清理默认不勾（由用户主动勾选，按钮文案随勾选实时刷新）；说明项不可执行
    var cb = act==='migrate' ? '<input type="checkbox" class="pr-cb" data-i="'+i+'" checked>'
              : act==='cleanup' ? '<input type="checkbox" class="pr-cb" data-i="'+i+'" title="勾选后随「执行」一并移入回收站">'
              : '<span style="display:inline-block;width:13px"></span>';
    var actBtns = '';
    if (it.src) {
      actBtns += '<button class="pr-loc" data-p="'+escAttr(it.src)+'">📂 定位</button>';
      if (act==='cleanup') actBtns += '<button class="pr-recycle" data-i="'+i+'" title="移入 Windows 系统回收站（可在回收站还原，勿随手清空回收站）">🗑 移入回收站</button>';
    }
    html+='<div class="pr-row">'
      +'<div class="pr-top">'+cb+badge
      +'<span class="pr-path" title="'+escAttr(it.src||'')+'">'+esc(it.src||'')+'</span>'
      +(size?'<span class="pr-size">'+size+'</span>':'')
      +'<span class="pr-act">'+actBtns+'</span>'
      +'</div><div class="pr-sub">'
      +(act==='migrate'&&it.dest_root?'<div>目标：<span class="dest">'+esc(it.dest_root)+'</span></div>':'')
      +(it.reason?'<div class="reason">理由：'+esc(it.reason)+'</div>':'')
      +'</div><div class="pr-st" id="pr-st-'+i+'"></div></div>';
  }
  aiChEl('prop-list').innerHTML = html || '<div class="pr-empty">提案没有条目</div>';
  updateRunBtn();
}

// 底部按钮文案随勾选实时刷新：展示本次将处理的条目数（迁移几个 / 清理几个）
function updateRunBtn(){
  var cbs = document.querySelectorAll('#prop-list .pr-cb');
  var mig=0, cln=0;
  for(var c=0;c<cbs.length;c++){
    if(!cbs[c].checked) continue;
    var it = (propData && propData.items) ? propData.items[parseInt(cbs[c].dataset.i,10)] : null;
    if(!it) continue;
    if((it.action||'note')==='cleanup') cln++; else mig++;
  }
  var b = aiChEl('prop-run');
  var total = mig+cln;
  b.textContent = !total ? '执行选中的迁移'
    : '执行选中项（'+mig+' 迁移'+(cln?' · '+cln+' 清理':'')+'）';
  b.disabled = propRunning ? true : !total;
}

function prSt(i, cls, text){
  var el = document.getElementById('pr-st-'+i);
  if(el){ el.className='pr-st '+cls; el.textContent=text; }
}

function propProg(t){ aiChEl('prop-progress').textContent = t; }

function propItemProgress(i, label, pct, current){
  var row = document.getElementById('pr-st-'+i);
  if(!row) return;
  var bar = row.querySelector('progress');
  if(!bar){
    row.className = 'pr-st run';
    var status = document.createElement('div');
    status.className = 'pr-progress-label';
    bar = document.createElement('progress');
    bar.max = 100;
    var currentPath = document.createElement('div');
    currentPath.className = 'pr-current';
    row.replaceChildren(status,bar,currentPath);
  }
  bar.hidden = pct===null;
  if(pct!==null && bar.value!==pct) bar.value = pct;
  bar.setAttribute('aria-label',label);
  row.querySelector('.pr-progress-label').textContent = label+(pct===null?'':' · '+Math.floor(pct)+'%');
  var path = row.querySelector('.pr-current');
  path.hidden = !current;
  if(path.textContent!==(current||'')){
    path.textContent = current||'';
    path.title = current||'';
  }
}

function recycleProposalItem(i, src, cb){
  var start = Date.now();
  var current = src, pct = null;
  var active = true;
  function render(){
    propItemProgress(i,'正在移入回收站 · 已用 '+Math.floor((Date.now()-start)/1000)+' 秒'+
      (pct===null?'':' · 系统估算'),
      pct, current);
  }
  render();
  var timer = setInterval(render, 1000);
  feed.recycleDelete([src], function(failed){
    active = false;
    clearInterval(timer);
    if(!failed.length){
      var path = src.replace(/[\\/]+$/,'').replace(/\//g,'\\');
      var rm = removeSubtree(path);
      propDelta(path, -rm.s, -rm.al);
      markDirty();
      var cbEl = document.querySelector('.pr-cb[data-i="'+i+'"]');
      cbEl.checked = false;
      cbEl.disabled = true;
      document.querySelector('.pr-recycle[data-i="'+i+'"]').disabled = true;
    }
    cb(failed);
  }, function(ev){
    if(!active) return;
    if(ev.current) current = ev.current;
    if(ev.total>0 && Number.isFinite(ev.done)){
      pct = Math.max(pct||0, Math.min(99,ev.done/ev.total*100));
    }
    render();
  });
}

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
  if(!sel.length){ propProg('没有勾选任何可执行项'); return; }
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
    // 整批执行结果 + 行级操作（回收站/撤销）累积结果一并回传
    var all = results.concat(propResults);
    propData.status = status;   // 本地同步终态：悬浮角标随之消失
    propQueue = propQueue.filter(function(q){ return q.id !== propData.id; });
    renderPropTabs();
    updatePropFab();
    if(feed.aiProposalResult) feed.aiProposalResult(propData.id, status, all);
    if(doneN>0) setStatus('AI 提案执行完毕（成功 '+doneN+' 项）','done');
  }

  (function next(){
    if(k>=sel.length || propAborted) return finish(propAborted?'aborted':'done');
    var i = sel[k], it = items[i] || {};
    var src = it.src||'', dest = it.dest_root||'';
    window.__migHandler = null;
    // 清理项：整目录移入系统回收站（可在回收站还原），不走迁移事务
    if((it.action||'note')==='cleanup'){
      propProg('第 '+(k+1)+'/'+sel.length+' 项：清理 '+src);
      recycleProposalItem(i, src, function(failed){
        if(failed && failed.length){
          prSt(i,'err','⛔ 移入回收站失败（文件被占用？）');
          results.push({src:src,ok:false,error:'回收站删除失败'});
          failN++; k++; return next();
        }
        prSt(i,'ok','🗑 已移入回收站（可在回收站还原）');
        results.push({src:src,ok:true,action:'recycled'});
        doneN++; k++; return next();
      });
      return;
    }
    propItemProgress(i,'预检中',null,src);
    propProg('第 '+(k+1)+'/'+sel.length+' 项：预检 '+src);
    feed.migrateCheck(src, dest, function(r){
      if(propAborted){ prSt(i,'skip','已停止'); return finish('aborted'); }
      if(!r){ prSt(i,'err','⛔ 预检失败'); results.push({src:src,ok:false,error:'预检失败'});
        failN++; k++; return next(); }
      if(!r.ok){
        var msg=(r.blockers||[]).join('；')||'预检未通过';
        prSt(i,'err','⛔ '+msg); results.push({src:src,ok:false,error:msg});
        failN++; k++; return next();
      }
      propItemProgress(i,'准备迁移',null,src);
      window.__migHandler = function(ev){
        if(ev.stage==='copy'||ev.stage==='verify'||ev.stage==='switch'){
          var ph = ev.stage==='copy'?'复制':(ev.stage==='verify'?'校验':'切换 junction');
          var pct = ev.stage!=='copy' ? null :
            ev.bytes_total>0 ? Math.min(100,ev.bytes_done/ev.bytes_total*100) :
            ev.files_total>0 ? Math.min(100,ev.files_done/ev.files_total*100) : null;
          var bytes = ev.stage==='copy' && ev.bytes_total>0
            ? ' · '+fmt(ev.bytes_done)+' / '+fmt(ev.bytes_total) : '';
          propItemProgress(i,ph+bytes,pct,ev.current||src);
          return;
        }
        if(ev.stage==='done'){
          prSt(i,'ok','✓ 迁移完成（原位置已建 junction）· 建议先验证相关软件可用，确认后再决定是否撤销');
          // 完成行给出撤销入口（验证可用后可一键回迁；数据仍需人工确认才删）
          var stEl = document.getElementById('pr-st-'+i);
          if(stEl) stEl.innerHTML = '✓ 迁移完成 · 建议先验证相关软件可用 <button class="pr-undo" data-i="'+i+'" style="padding:2px 8px;font-size:11px;margin-left:6px">↩ 撤销迁移</button>';
          results.push({src:src,ok:true,dest:r.dest_path||dest});
          // 迁移完成：局部重扫受影响目录（junction/目标两侧数据变化）
          if(feed.scanRefresh){
            feed.scanRefresh(src);
            feed.scanRefresh(r.dest_path||dest);
          }
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
  if(reject){
    // 显式「全部忽略」才作废：提案回写 rejected，AI 可据此重发
    if(propData && propData.status==='pending' && feed.aiProposalResult){
      feed.aiProposalResult(propData.id, 'rejected', []);
    }
    var rid = propData ? propData.id : null;
    propQueue = propQueue.filter(function(q){ return q.id !== rid; });
    propData = null;
    updatePropFab();
  }
  // 普通关闭（✕/遮罩）只收起面板：提案保持 pending 并落盘，
  // 状态栏出现「📋 AI 提案待确认」，点击随时重开——误关不再前功尽弃
  aiChEl('prop-mask').style.display = 'none';
}

(function initProposalUI(){
  aiChEl('prop-run').addEventListener('click', runProposal);
  aiChEl('prop-reject').addEventListener('click', function(){ closeProposal(true); });
  aiChEl('prop-close').addEventListener('click', function(){ closeProposal(false); });
  aiChEl('prop-mask').addEventListener('mousedown', function(ev){
    if(ev.target===this) closeProposal(false);
  });
  // 右下角悬浮角标：打开最新的待确认提案（多盘并存时逐个处理）
  document.addEventListener('click', function(ev){
    if(!(ev.target.closest && ev.target.closest('#prop-fab'))) return;
    if(propRunning) return;
    var pend = propQueue.filter(function(q){ return q.status==='pending'; });
    var target = pend.length ? pend[pend.length-1] : propData;
    if(target) showProposal(target);
  });
  // 面板顶部的多提案切换条
  document.addEventListener('click', function(ev){
    var t = ev.target.closest && ev.target.closest('.prop-tab');
    if(!t || propRunning) return;
    var q = propQueue.filter(function(x){ return String(x.id)===t.dataset.id; })[0];
    if(q) showProposal(q);
  });
  aiChEl('prop-stop').addEventListener('click', function(){
    propAborted = true;
    propProg('正在停止（当前项完成后结束）…');
    if(window.__migHandler && feed.migrateStop) feed.migrateStop();
  });
  aiChEl('prop-list').addEventListener('change', function(ev){
    if(ev.target && ev.target.classList && ev.target.classList.contains('pr-cb')) updateRunBtn();
  });
  aiChEl('prop-list').addEventListener('click', function(ev){
    var loc = ev.target.closest('button.pr-loc');
    if(loc && loc.dataset.p){ feed.open(loc.dataset.p, true); return; }
    // 撤销迁移（行级）：验证相关软件没问题后，删 junction 并把数据搬回原位
    var undo = ev.target.closest('button.pr-undo');
    if(undo){
      if(propRunning){ prSt(parseInt(undo.dataset.i,10)||0,'err','当前批次执行中，稍后再撤销'); return; }
      var ui = parseInt(undo.dataset.i, 10);
      var uit = (propData && propData.items) ? propData.items[ui] : null;
      if(!uit || !uit.src || !uit.dest_root) return;
      undo.disabled = true;
      prSt(ui,'run','⟳ 撤销迁移中…');
      window.__migHandler = function(ev){
        var pct = ev.bytes_total>0 ? Math.round(ev.bytes_done/ev.bytes_total*100) : 100;
        if(ev.stage==='copy'||ev.stage==='verify'||ev.stage==='switch'){
          var ph = ev.stage==='copy'?'回移':(ev.stage==='verify'?'校验':'恢复目录');
          prSt(ui,'run','⟳ 撤销·'+ph+'… '+pct+'%'+(ev.current?' · '+ev.current:''));
          return;
        }
        if(ev.stage==='done'){
          prSt(ui,'ok','↩ 撤销完成：数据已回到原位（目标侧已清理）');
          resultsPush(propData.id, {src:uit.src, ok:true, action:'undo'});
          if(feed.scanRefresh){ feed.scanRefresh(uit.src); feed.scanRefresh(uit.dest_root); }
          window.__migHandler = null;
          return;
        }
        var m2 = ev.message || ev.stage;
        if(ev.locked && ev.locked.length) m2 += '（'+ev.locked.length+' 个文件被占用）';
        prSt(ui,'err',(ev.stage==='aborted'?'⏹ ':'⛔ ')+m2);
        resultsPush(propData.id, {src:uit.src, ok:false, error:'撤销：'+m2});
        window.__migHandler = null;
      };
      feed.migrateUndo(uit.src, uit.dest_root);
      return;
    }
    var rc = ev.target.closest('button.pr-recycle');
    if(rc){
      var i = parseInt(rc.dataset.i, 10);
      var it = (propData && propData.items) ? propData.items[i] : null;
      if(!it || !it.src || propRunning || rc.disabled) return;
      propRunning = true;
      rc.disabled = true;
      updateRunBtn();
      aiChEl('prop-close').disabled = true;
      aiChEl('prop-reject').disabled = true;
      recycleProposalItem(i, it.src, function(failed){
        propRunning = false;
        updateRunBtn();
        aiChEl('prop-close').disabled = false;
        aiChEl('prop-reject').disabled = false;
        rc.disabled = !failed.length;
        if(failed.length){ prSt(i,'err','⛔ 移入回收站失败（文件被占用？）');
          resultsPush(propData.id, {src:it.src, ok:false, error:'回收站删除失败'}); }
        else{
          prSt(i,'ok','🗑 已移入回收站（可在回收站还原）');
          resultsPush(propData.id, {src:it.src, ok:true, action:'recycled'});
        }
      });
    }
  });
})();

// 轻量结果追加：行级操作（回收站/撤销）即时回写——前端累积，整包发送（Rust 侧整包替换）
var propResults = [];
function resultsPush(id, item){
  propResults.push(item);
  if(feed.aiProposalResult) feed.aiProposalResult(id, 'pending', propResults);
}

// 浏览器模式 / 调试入口：模拟一条 AI 提案（与 POST /api/proposal 的 payload 同构）
window.__testProposal = function(p){ showProposal(p); };
