/* DiskLens 应用内更新 —— tauri-plugin-updater 封装。
   双源检查（服务器 latest.json 优先，GitHub Releases 回退，endpoints 见 tauri.conf.json）：
   - 启动后静默检查一次，失败/无更新完全不打扰
   - 顶栏「⟳ 检查更新」按钮手动触发，结果用状态栏/对话框反馈
   - 发现新版本 → 对话框展示版本号与更新说明 → 下载进度 → 完成重启
   仅 Tauri 客户端可用；浏览器模式自动隐藏入口。 */

(function () {
  var TAURI = !!window.__TAURI__;
  var checking = false;   // 防重入：启动静默检查与手动点击并发
  var installing = false;

  function $(id) { return document.getElementById(id); }

  /* ===== 对话框 ===== */
  function openDialog() {
    $('upd-mask').style.display = 'flex';
  }
  function closeDialog() {
    $('upd-mask').style.display = 'none';
    $('upd-prog').style.display = 'none';
    $('upd-actions').style.display = 'flex';
  }

  /* 状态栏短反馈（手动检查时用） */
  function flashStatus(msg, cls) {
    if (typeof setStatus === 'function') {
      setStatus(msg, cls);
      if (cls !== 'done') { setTimeout(function () { try { setStatus('就绪', 'done'); } catch (_) {} }, 4000); }
    }
  }

  function setBtnState(text, disabled) {
    var b = $('upd-btn');
    if (!b) return;
    b.textContent = text;
    b.disabled = !!disabled;
  }

  /* ===== 检查入口 ===== */
  function checkForUpdate(manual) {
    if (!TAURI || checking || installing) { if (manual) flashStatus('正在检查中…'); return; }
    checking = true;
    if (manual) setBtnState('检查中…', true);

    window.__TAURI__.updater.check({ timeout: 15000 }).then(function (update) {
      checking = false;
      setBtnState('⟳ 检查更新', false);
      if (!update) {
        if (manual) flashStatus('✓ 已是最新版本', 'done');
        return;
      }
      showUpdate(update);
    }).catch(function (e) {
      checking = false;
      setBtnState('⟳ 检查更新', false);
      // 启动静默检查失败不打扰；手动检查才提示（多为断网/服务器未就绪）
      if (manual) flashStatus('检查更新失败：' + String(e).slice(0, 80), 'err');
    });
  }

  function showUpdate(update) {
    $('upd-ver').textContent = 'v' + update.version;
    var notes = (update.body || '').trim();
    $('upd-notes').textContent = notes || '性能优化与问题修复。';
    $('upd-prog').style.display = 'none';
    $('upd-actions').style.display = 'flex';
    $('upd-later').style.display = '';
    $('upd-err').style.display = 'none';
    openDialog();

    $('upd-go').onclick = function () {
      if (installing) return;
      installing = true;
      $('upd-actions').style.display = 'none';
      $('upd-prog').style.display = '';
      $('upd-stage').textContent = '下载中…';
      $('upd-fill').style.width = '0';
      update.downloadAndInstall(function (ev) {
        if (ev.event === 'Started' && ev.data.contentLength) {
          $('upd-fill').dataset.total = ev.data.contentLength;
        } else if (ev.event === 'Progress') {
          var total = Number($('upd-fill').dataset.total || 0);
          var cur = parseFloat($('upd-fill').style.width || '0');
          // Progress 只给增量，用「本次会话已收字节占比」近似推进（无总量时按次数步进）
          var next = total > 0 ? Math.min(99, cur + 100 * ev.data.chunkLength / total) : Math.min(99, cur + 1.5);
          $('upd-fill').style.width = next.toFixed(1) + '%';
        } else if (ev.event === 'Finished') {
          $('upd-stage').textContent = '安装中…（完成后自动重启）';
          $('upd-fill').style.width = '100%';
        }
      }).then(function () {
        $('upd-stage').textContent = '更新完成，正在重启…';
        window.__TAURI__.process.relaunch().catch(function () {});
      }).catch(function (e) {
        installing = false;
        $('upd-stage').textContent = '';
        $('upd-prog').style.display = 'none';
        $('upd-actions').style.display = 'flex';
        $('upd-err').textContent = '更新失败：' + String(e).slice(0, 120);
        $('upd-err').style.display = '';
      });
    };
  }

  /* ===== 启动 ===== */
  window.addEventListener('DOMContentLoaded', function () {
    if (!TAURI) return;   // 浏览器模式：不注入入口、不检查
    var btn = document.createElement('button');
    btn.id = 'upd-btn';
    btn.title = '检查 DiskLens 新版本';
    btn.textContent = '⟳ 检查更新';
    btn.addEventListener('click', function () { checkForUpdate(true); });
    $('appbar').insertBefore(btn, $('status'));

    $('upd-close').addEventListener('click', function () {
      if (!installing) closeDialog();
    });
    $('upd-later').addEventListener('click', closeDialog);
    $('upd-mask').addEventListener('mousedown', function (ev) {
      if (ev.target === $('upd-mask') && !installing) closeDialog();
    });

    // 启动静默检查：等首屏与扫描界面就绪后再查，失败静默
    setTimeout(function () { checkForUpdate(false); }, 5000);
  });
})();
