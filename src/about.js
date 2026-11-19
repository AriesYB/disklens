/* DiskLens 关于对话框 —— 版本号（动态读取自 Tauri）、项目主页、开源仓库、
   问题反馈、更新日志、检查更新入口。双入口：顶栏品牌点击 + 页脚「关于」。
   链接用 opener 打开系统浏览器；浏览器模式回退 window.open。 */

(function () {
  var TAURI = !!window.__TAURI__;
  var URLS = {
    home:   'https://ikanp.top/disklens/',
    github: 'https://github.com/AriesYB/disklens',
    issues: 'https://github.com/AriesYB/disklens/issues',
    rel:    'https://github.com/AriesYB/disklens/releases',
    site:   'https://ikanp.top'
  };

  function $(id) { return document.getElementById(id); }
  function openUrl(url) {
    try {
      if (TAURI && window.__TAURI__.opener && window.__TAURI__.opener.openUrl) {
        window.__TAURI__.opener.openUrl(url);
        return;
      }
    } catch (e) {}
    window.open(url, '_blank', 'noopener');
  }
  function openAbout() {
    $('about-mask').style.display = 'flex';
    loadVersion();
    fetchDiag(function (d) {
      var el = $('about-diag-state');
      if (el) el.textContent = diagStateText(d);
    });
  }
  function closeAbout() { $('about-mask').style.display = 'none'; }

  function loadVersion() {
    var el = $('about-ver');
    el.textContent = 'v1.1.0';   // 兜底
    if (TAURI && window.__TAURI__.app && window.__TAURI__.app.getVersion) {
      window.__TAURI__.app.getVersion().then(function (v) {
        if (v) el.textContent = 'v' + v;
      }).catch(function () {});
    }
  }

  /* ===== 诊断报告：上次会话状态展示 + 复制 / 带日志提 Issue ===== */
  var diagCache = null;
  function fetchDiag(cb) {
    if (diagCache) return cb(diagCache);
    if (!TAURI || !feed || !feed.diagReport) return cb(null);
    feed.diagReport(function (d) {
      diagCache = d;
      cb(d);
    });
  }
  function diagStateText(d) {
    if (!d) return '';
    if (d.lastAbnormal) {
      return '⚠ 上次会话异常退出（panic ' + (d.panics || 0) + ' 次）——可带日志反馈帮助定位';
    }
    return '上次会话正常退出 · 本机日志留档 ' + (d.panics ? ('（含 panic ' + d.panics + ' 次）') : '');
  }
  function buildReport(d) {
    return 'DiskLens 诊断报告\n' +
      '版本: v' + (d.version || '') + '\n' +
      '系统: ' + (d.os || '') + '\n' +
      '上次会话: ' + (d.lastAbnormal ? '异常退出' : '正常') + '\n' +
      'PANIC 次数: ' + (d.panics || 0) + '\n' +
      '\n── 上次会话日志尾部 ──\n' + (d.prevTail || '（无）') +
      '\n\n── 当前会话日志尾部 ──\n' + (d.curTail || '（空）') +
      '\n\n注：日志可能包含本机目录路径，提交到公开仓库前请自行检查删除。';
  }

  window.addEventListener('DOMContentLoaded', function () {
    $('brand').addEventListener('click', openAbout);
    $('foot-about').addEventListener('click', openAbout);
    $('about-close').addEventListener('click', closeAbout);
    $('about-mask').addEventListener('mousedown', function (ev) {
      if (ev.target === $('about-mask')) closeAbout();
    });
    $('about-home').addEventListener('click', function () { openUrl(URLS.home); });
    $('about-github').addEventListener('click', function () { openUrl(URLS.github); });
    $('about-issues').addEventListener('click', function () { openUrl(URLS.issues); });
    $('about-rel').addEventListener('click', function () { openUrl(URLS.rel); });
    $('about-site').addEventListener('click', function () { openUrl(URLS.site); });
    // 诊断反馈：复制报告 / 带日志提 Issue（用户点击确认后才离开本机）
    $('about-diag-copy').addEventListener('click', function () {
      fetchDiag(function (d) {
        if (!d) { setStatus('诊断日志不可用（浏览器模式或读取失败）', 'err'); return; }
        copyPath(buildReport(d), null);
        setStatus('已复制诊断报告——粘贴给开发者或保存备用', 'done');
      });
    });
    $('about-diag-issue').addEventListener('click', function () {
      fetchDiag(function (d) {
        if (!d) { setStatus('诊断日志不可用（浏览器模式或读取失败）', 'err'); return; }
        var body = buildReport(d);
        if (body.length > 6000) body = body.slice(0, 6000) + '\n…（过长截断，可用「复制诊断报告」补充）';
        var url = URLS.github + '/issues/new?title=' +
          encodeURIComponent('DiskLens 问题反馈（附诊断日志）') +
          '&body=' + encodeURIComponent(body);
        openUrl(url);
      });
    });
    // 检查更新：复用顶栏按钮（浏览器模式无此按钮，隐藏入口）
    var checkBtn = $('about-check');
    if (document.getElementById('upd-btn')) {
      checkBtn.addEventListener('click', function () {
        closeAbout();
        document.getElementById('upd-btn').click();
      });
    } else {
      checkBtn.style.display = 'none';
    }
    // Esc 关闭（capture 拦截，避免同时触发 treemap 的"收起展开"）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('about-mask').style.display === 'flex') {
        e.stopImmediatePropagation();
        closeAbout();
      }
    }, true);
  });
})();
