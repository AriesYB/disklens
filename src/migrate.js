// DiskLens 迁移对话框 —— junction 方式一键迁移目录。
// 数据流：右键「迁移此目录」→ 选目标卷 → migrate_check 预检（blockers/warnings）→
// migrate_start 后台三阶段事务，migrate-update 事件驱动进度/被锁清单。
// 无法自动迁移的场景（系统文件/被占用/ACL）在此给出「去哪个软件里改」的指引。

var migSrc = '';          // 当前迁移源路径
var migVolumes = [];
var migChecking = false;
var migRunning = false;
var migGuidanceMap = [
  { re: /pagefile\.sys|swapfile\.sys/i, t: '虚拟内存文件', s: '这是系统页面文件，不能搬也不能删。请在「系统属性 → 高级 → 性能设置 → 高级 → 虚拟内存 → 更改」里把它设置到其他盘。' },
  { re: /hiberfil\.sys/i, t: '休眠文件', s: '这是休眠/快速启动文件，请在管理员命令行执行 powercfg /h /size 50 缩小，或 powercfg /h off 关闭后自行删除。' },
  { re: /docker.*\.vhdx|ext4\.vhdx|DockerDesktop/i, t: 'Docker Desktop 数据盘', s: '请打开 Docker Desktop → Settings → Resources → Advanced → Disk image location，在软件内修改数据盘位置。' },
  { re: /lxss|wsl|Ubuntu.*\.vhdx/i, t: 'WSL 子系统', s: 'WSL 发行版请用官方方式迁移：wsl --export 导出 → wsl --unregister 注销 → wsl --import 导入到新位置。' },
  { re: /windowsapps/i, t: 'Windows 商店应用', s: '商店应用请在「设置 → 应用 → 安装的应用」里选中应用 → 移动，直接搬会破坏应用。' },
  { re: /onedrive/i, t: 'OneDrive', s: '请在 OneDrive 设置 → 同步和备份 → 更改位置 里迁移，直接搬会导致重新下载全部文件。' },
  { re: /steamapps/i, t: 'Steam 游戏库', s: '请在 Steam → 设置 → 存储 → 库文件夹 里添加新盘并「移动」游戏，Steam 会自动处理。' },
  { re: /\bnode_modules\b|\.cargo|\.gradle|\.m2|go[\/\\]pkg/i, t: '构建缓存目录', s: '这类目录可直接用 junction 迁移，构建工具对路径透明，无需在软件里改。' }
];

function migrationGuidance(paths) {
  var cards = [], seen = {};
  for (var i = 0; i < paths.length; i++) {
    for (var j = 0; j < migGuidanceMap.length; j++) {
      var g = migGuidanceMap[j];
      if (g.re.test(paths[i]) && !seen[g.t]) {
        seen[g.t] = 1;
        cards.push('<div class="mig-card"><div class="mig-card-t">💡 ' + esc(g.t) + ' —— 请到软件里改</div><div class="mig-card-s">' + esc(g.s) + '</div></div>');
      }
    }
  }
  if (!cards.length) {
    cards.push('<div class="mig-card"><div class="mig-card-t">💡 文件被程序占用 —— 关闭程序后重试</div><div class="mig-card-s">下列文件正被某个程序使用。关闭占用它们的程序（或直接退出该软件）后点「重试」。若该软件把数据写死在此路径且无法关闭，请到该软件的设置里修改存储位置（多数软件支持自定义数据目录）。</div></div>');
  }
  return cards.join('');
}

function el(id) { return document.getElementById(id); }

function openMigrate(path) {
  window.__migHandler = onMigrateEvent;   // 接管 migrate-update 事件流
  migSrc = path;
  el('mig-mask').style.display = 'flex';
  el('mig-src').textContent = path;
  el('mig-vol').innerHTML = '<option>加载卷…</option>';
  el('mig-vol-info').textContent = '';
  el('mig-dest').textContent = '';
  el('mig-check').innerHTML = '<div class="mig-note">正在枚举本地卷…</div>';
  el('mig-prog').style.display = 'none';
  el('mig-locked').style.display = 'none';
  el('mig-locked').innerHTML = '';
  el('mig-start').style.display = '';
  el('mig-start').disabled = true;
  el('mig-start').textContent = '检查中…';
  el('mig-stop').style.display = 'none';
  el('mig-rescan').style.display = 'none';
  el('mig-cancel').disabled = false;
  var node = store.get(path.toLowerCase());
  el('mig-src').textContent = path + (node ? '  ·  ' + fmt(node.s) : '');
  feed.listVolumes(function (vols) {
    migVolumes = (vols || []).filter(function (v) {
      return v.mount && v.mount.length >= 3;
    });
    var srcVol = path.slice(0, 3).toUpperCase();
    var html = '';
    for (var i = 0; i < migVolumes.length; i++) {
      var v = migVolumes[i];
      html += '<option value="' + escAttr(v.mount) + '">' + esc(v.mount) +
        '  ' + esc(v.fs || '?') + '  剩余 ' + fmt(v.free_bytes) + '</option>';
    }
    el('mig-vol').innerHTML = html;
    // 默认选中一个与源不同且有空间的 NTFS 卷
    var pick = -1;
    for (var k = 0; k < migVolumes.length; k++) {
      var mv = migVolumes[k];
      if (mv.mount.toUpperCase() !== srcVol && (mv.fs || '').toUpperCase() === 'NTFS' && mv.free_bytes > 0) { pick = k; break; }
    }
    if (pick < 0) pick = 0;
    el('mig-vol').selectedIndex = pick;
    runMigrateCheck();
  });
}

function migSelectedRoot() {
  var i = el('mig-vol').selectedIndex;
  return i >= 0 && migVolumes[i] ? migVolumes[i].mount : '';
}

function runMigrateCheck() {
  var destRoot = migSelectedRoot();
  if (!destRoot || !migSrc) return;
  var basename = migSrc.replace(/\\+$/, '').split('\\').pop();
  el('mig-dest').textContent = destRoot.replace(/\\+$/, '') + '\\' + basename;
  el('mig-start').disabled = true;
  el('mig-start').textContent = '检查中…';
  el('mig-check').innerHTML = '<div class="mig-note"><span class="spin" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:-3px;margin-right:8px"></span>正在评估：统计体积、检查空间与可迁移性…</div>';
  migChecking = true;
  feed.migrateCheck(migSrc, destRoot, function (r) {
    migChecking = false;
    if (!r) { el('mig-check').innerHTML = '<div class="mig-err">预检失败</div>'; return; }
    var html = '';
    for (var i = 0; i < r.blockers.length; i++)
      html += '<div class="mig-item err">⛔ ' + esc(r.blockers[i]) + '</div>';
    for (var j = 0; j < r.warnings.length; j++)
      html += '<div class="mig-item warn">⚠ ' + esc(r.warnings[j]) + '</div>';
    if (r.ok) {
      var fast = r.same_volume ? '（同卷：rename 瞬时完成）' : '（跨卷：复制 → 校验 → 切换，全程可断点续传）';
      html += '<div class="mig-item ok">✓ 可以迁移：' + fmt(r.src_bytes) + ' · ' + r.src_files.toLocaleString() + ' 个文件 ' + fast + '</div>';
    } else {
      html += '<div class="mig-card"><div class="mig-card-t">💡 无法自动迁移？</div><div class="mig-card-s">系统文件与被程序写死的数据目录不适合 junction 迁移——请到对应软件的设置里修改存储位置（虚拟内存、Docker、WSL、OneDrive、Steam 等常见项的改法见本页指引）。</div></div>';
    }
    el('mig-check').innerHTML = html;
    el('mig-vol-info').textContent = '目标剩余 ' + fmt(r.dest_free);
    el('mig-start').disabled = !r.ok;
    el('mig-start').textContent = r.ok ? '开始迁移' : '不可迁移';
  });
}

function renderMigProgress(ev) {
  el('mig-prog').style.display = '';
  var pct = ev.bytes_total > 0 ? Math.min(100, ev.bytes_done / ev.bytes_total * 100) : (ev.stage === 'done' ? 100 : 0);
  el('mig-fill').style.width = pct.toFixed(1) + '%';
  var stageNames = { copy: '复制', verify: '校验', switch: '切换' };
  var st = stageNames[ev.stage] || '';
  if (ev.stage === 'verify' || ev.stage === 'switch') pct = 100; // 两阶段瞬间完成
  el('mig-stage').textContent = st ? st + '… ' + fmt(ev.bytes_done) + ' / ' + fmt(ev.bytes_total) : ev.message;
  el('mig-cur').textContent = ev.current || '';
}

function renderMigLocked(ev) {
  el('mig-locked').style.display = '';
  var html = '<div class="mig-item err">⛔ ' + esc(ev.message) + '</div>';
  html += migrationGuidance(ev.locked);
  html += '<div class="mig-locked-list">';
  for (var i = 0; i < ev.locked.length && i < 20; i++)
    html += '<div class="mig-mono mig-locked-row">' + esc(ev.locked[i]) + '</div>';
  if (ev.locked.length > 20)
    html += '<div class="mig-locked-row">…共 ' + ev.locked.length + ' 个</div>';
  html += '</div>';
  el('mig-locked').innerHTML = html;
}

function onMigrateEvent(ev) {
  if (!ev || !ev.stage) return;
  if (ev.stage === 'copy' || ev.stage === 'verify' || ev.stage === 'switch') {
    renderMigProgress(ev);
    return;
  }
  if (ev.stage === 'locked') {
    renderMigProgress(ev);
    renderMigLocked(ev);
    migRunning = false;
    el('mig-stop').style.display = 'none';
    el('mig-start').style.display = '';
    el('mig-start').disabled = false;
    el('mig-start').textContent = '重试';
    return;
  }
  if (ev.stage === 'done') {
    renderMigProgress(ev);
    el('mig-stage').textContent = '✓ ' + ev.message;
    el('mig-fill').style.width = '100%';
    el('mig-fill').classList.add('ok');
    migRunning = false;
    el('mig-stop').style.display = 'none';
    el('mig-start').style.display = 'none';
    el('mig-rescan').style.display = '';
    el('mig-cancel').disabled = false;
    return;
  }
  if (ev.stage === 'error' || ev.stage === 'aborted') {
    el('mig-prog').style.display = '';
    el('mig-stage').textContent = (ev.stage === 'error' ? '⛔ ' : '⏹ ') + ev.message;
    migRunning = false;
    el('mig-stop').style.display = 'none';
    if (ev.locked && ev.locked.length) {
      el('mig-locked').style.display = '';
      el('mig-locked').innerHTML = migrationGuidance(ev.locked) +
        '<div class="mig-locked-list">' + ev.locked.slice(0, 20).map(function (p) {
          return '<div class="mig-mono mig-locked-row">' + esc(p) + '</div>';
        }).join('') + '</div>';
      el('mig-start').style.display = '';
      el('mig-start').disabled = false;
      el('mig-start').textContent = '重试';
    } else {
      el('mig-start').style.display = '';
      el('mig-start').disabled = ev.stage === 'error' && /不可迁移|系统目录|盘根/.test(ev.message);
      if (!el('mig-start').disabled) el('mig-start').textContent = '重试';
    }
    el('mig-cancel').disabled = false;
  }
}

function closeMigrate() {
  if (migRunning) { feed.migrateStop(); migRunning = false; }
  el('mig-mask').style.display = 'none';
}

(function initMigrateUI() {
  document.getElementById('mi-migrate').addEventListener('click', function () {
    var p = menuPath;
    hideCtx();
    if (p) openMigrate(p);
  });
  el('mig-vol').addEventListener('change', function () {
    if (!migChecking) runMigrateCheck();
  });
  el('mig-start').addEventListener('click', function () {
    if (migRunning || migChecking || el('mig-start').disabled) return;
    el('mig-start').style.display = 'none';
    el('mig-stop').style.display = '';
    el('mig-locked').style.display = 'none';
    el('mig-fill').classList.remove('ok');
    migRunning = true;
    el('mig-cancel').disabled = true;
    feed.migrateStart(migSrc, migSelectedRoot());
  });
  el('mig-stop').addEventListener('click', function () { feed.migrateStop(); });
  el('mig-rescan').addEventListener('click', function () {
    closeMigrate();
    el('scan-btn').click();   // 重新扫描以刷新视图
  });
  el('mig-cancel').addEventListener('click', closeMigrate);
  el('mig-close').addEventListener('click', closeMigrate);
  el('mig-mask').addEventListener('mousedown', function (ev) {
    if (ev.target === this && !migRunning) closeMigrate();
  });
})();
