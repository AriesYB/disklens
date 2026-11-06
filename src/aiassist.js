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

function openAiAssist(path) {
  var el = function(id){ return document.getElementById(id); };
  window.__migHandler = null;
  el('ai-src').textContent = path;
  var node = store.get(path.toLowerCase());
  var sizeTxt = node && node.s > 0 ? ' · ' + fmt(node.s) : '';

  // 识别：优先本地知识库，其次迁移对话框的指引表（软件写死类）
  var hit = aiMatchKB(path);
  var kbHit = hit;
  if (!hit && typeof migGuidanceMap !== 'undefined') {
    for (var gi = 0; gi < migGuidanceMap.length; gi++) {
      if (migGuidanceMap[gi].re.test(path)) { kbHit = { tool: migGuidanceMap[gi].t, act: 'tool', via: migGuidanceMap[gi].s }; break; }
    }
  }
  var isSystem = /\\windows(\\|$)/i.test(path) || /WindowsApps/i.test(path) ||
                 /pagefile|hiberfil|swapfile/i.test(path);

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

  // AI 指令生成
  var prompt;
  if (isSystem) {
    prompt = '请检查「' + path + '」是否有可安全清理的缓存或临时内容，'
      + '列出清单征求我确认后再操作；系统核心文件一律不动。';
  } else if (kbHit && kbHit.act === 'clean') {
    prompt = '请使用 c-relocator skill 分析「' + path + '」：'
      + '先 audit 确认哪些是可再生缓存，列出可安全清理清单征求我确认；'
      + '其余部分如体积可观可迁移到剩余空间最大的 NTFS 盘并保留 undo 台账。';
  } else if (kbHit && kbHit.act === 'tool') {
    prompt = '「' + path + '」属于 ' + kbHit.tool + ' 的数据，官方迁移方式：' + kbHit.via +
      '。请协助我完成迁移（不要直接搬目录）。';
  } else {
    var via = kbHit ? ('该目录属于 ' + kbHit.tool + '，优先走官方重定向（' + kbHit.via + '）')
                 : '优先检查所属软件是否支持官方改路径/重定向';
    prompt = '请使用 c-relocator skill 迁移「' + path + '」到剩余空间最大的 NTFS 盘：'
      + via + '；无法重定向的部分用 NTFS junction 兜底；'
      + '迁移前预占位，完成后 audit 验证，保留 manifest 台账与 undo 能力。';
  }
  el('ai-prompt').textContent = prompt;

  el('ai-mask').style.display = 'flex';
  el('ai-prompt-wrap').style.display = isSystem ? 'none' : '';
  el('ai-actions').style.display = '';
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
    if (p) openAiAssist(p);
  });
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
    var p = document.getElementById('ai-src').textContent;
    closeAiAssist();
    if (p) openMigrate(p);
  });
})();
