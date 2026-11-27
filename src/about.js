/* DiskLens 关于对话框 —— 版本号（动态读取自 Tauri）、项目主页、开源仓库、
   问题反馈、更新日志、检查更新入口。双入口：顶栏品牌点击 + 页脚「关于」。
   链接用 opener 打开系统浏览器；浏览器模式回退 window.open。 */

(function () {
  var TAURI = !!window.__TAURI__;
  var URLS = {
    home:   'https://ikanp.top/disklens/',
    github: 'https://github.com/AriesYB/disklens',
    issues: 'https://github.com/AriesYB/disklens/issues',
    feedback: 'https://ikanp.top/api/feedback/disklens',
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
    showFeedback(false);
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
    return dlText('上次会话正常退出 · 本机日志留档 ') + (d.panics ? (dlText('（含 panic ') + d.panics + dlText(' 次）')) : '');
  }
  function buildReport(d, tailLimit, includeNotice) {
    function tail(text, empty) {
      if (!text) return empty;
      if (!tailLimit || text.length <= tailLimit) return text;
      return '…（仅保留近期日志）\n' + text.slice(-tailLimit);
    }
    return 'DiskLens 诊断报告\n' +
      '版本: v' + (d.version || '') + '\n' +
      '系统: ' + (d.os || '') + '\n' +
      '上次会话: ' + (d.lastAbnormal ? '异常退出' : '正常') + '\n' +
      'PANIC 次数: ' + (d.panics || 0) + '\n' +
      '\n── 上次会话日志尾部 ──\n' + tail(d.prevTail, '（无）') +
      '\n\n── 当前会话日志尾部 ──\n' + tail(d.curTail, '（空）') +
      (includeNotice ? '\n\n注：日志可能包含本机目录路径，提交到公开仓库前请自行检查删除。' : '');
  }

  function showFeedback(visible) {
    $('about-overview').hidden = visible;
    $('feedback-form').hidden = !visible;
    if (visible) $('feedback-text').focus();
  }

  function loadFeedbackLog() {
    var toggle = $('feedback-include-log');
    var preview = $('feedback-log-preview');
    var log = $('feedback-log');
    preview.hidden = !toggle.checked;
    if (!toggle.checked || log.value) return;

    toggle.disabled = true;
    $('feedback-submit').disabled = true;
    log.placeholder = dlText('正在读取日志…');
    log.readOnly = true;
    feed.diagReport(function (report) {
      toggle.disabled = false;
      $('feedback-submit').disabled = false;
      log.readOnly = false;
      log.placeholder = '';
      if (report) {
        log.value = buildReport(report, 3800, false).slice(0, log.maxLength);
      } else {
        toggle.checked = false;
        preview.hidden = true;
        $('feedback-status').textContent = dlText('无法读取诊断日志。你仍可提交文字反馈。');
      }
    });
  }

  async function submitFeedback(event) {
    event.preventDefault();
    var form = $('feedback-form');
    var fields = $('feedback-fields');
    var submit = $('feedback-submit');
    var status = $('feedback-status');
    if (submit.disabled) return;
    var text = $('feedback-text').value.trim();
    if (!text) {
      status.textContent = dlText('请填写反馈内容。');
      $('feedback-text').focus();
      return;
    }
    var payload = {
      type: $('feedback-type').value,
      text: text,
      contact: $('feedback-contact').value.trim(),
      version: $('about-ver').textContent.replace(/^v/, ''),
    };
    if ($('feedback-include-log').checked && $('feedback-log').value.trim()) {
      payload.diagnostics = $('feedback-log').value.trim();
    }
    fields.disabled = submit.disabled = true;
    $('feedback-copy-preview').hidden = true;
    $('feedback-copy-text').value = '';
    status.textContent = dlText('正在提交…');
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch(URLS.feedback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'rate-limit' : 'server');
      var result = await response.json();
      if (result.ok !== true || typeof result.id !== 'string') throw new Error('server');
      form.reset();
      $('feedback-log-preview').hidden = true;
      status.textContent = dlText('反馈已提交。编号 ') + result.id;
    } catch (error) {
      clearTimeout(timeout);
      var kind = { bug: dlText('问题'), suggest: dlText('建议'), other: dlText('其他') }[payload.type];
      var copy = ['DiskLens v' + payload.version + ' · ' + kind, payload.text];
      if (payload.contact) copy.push(dlText('联系方式：') + payload.contact);
      if (payload.diagnostics) copy.push(payload.diagnostics);
      var copyText = copy.join('\n\n');
      var copied = await copyPath(copyText, null);
      status.textContent = (error.message === 'rate-limit' ? dlText('提交太频繁，请稍后再试。') : dlText('未收到提交确认。')) +
        (copied ? dlText('已复制反馈内容。') : dlText('可手动复制下方内容。'));
      if (!copied) {
        $('feedback-copy-text').value = copyText;
        $('feedback-copy-preview').hidden = false;
      }
    } finally {
      clearTimeout(timeout);
      fields.disabled = submit.disabled = false;
    }
  }

  window.addEventListener('DOMContentLoaded', function () {
    $('brand').addEventListener('click', openAbout);
    $('foot-about').addEventListener('click', openAbout);
    $('about-close').addEventListener('click', closeAbout);
    $('about-mask').addEventListener('mousedown', function (ev) {
      if (ev.target === $('about-mask')) closeAbout();
    });
    $('about-home').addEventListener('click', function () { openUrl(diskLensLanguage === 'en' ? 'https://ikanp.top/en/disklens/' : URLS.home); });
    $('about-github').addEventListener('click', function () { openUrl(URLS.github); });
    $('about-issues').addEventListener('click', function () { openUrl(URLS.issues); });
    $('about-feedback').addEventListener('click', function () { showFeedback(true); });
    $('feedback-back').addEventListener('click', function () {
      showFeedback(false);
      $('about-feedback').focus();
    });
    $('feedback-log-option').hidden = !TAURI || !window.feed || !feed.diagReport;
    $('feedback-include-log').addEventListener('change', loadFeedbackLog);
    $('feedback-form').addEventListener('submit', submitFeedback);
    $('about-rel').addEventListener('click', function () { openUrl(URLS.rel); });
    $('about-site').addEventListener('click', function () { openUrl(diskLensLanguage === 'en' ? 'https://ikanp.top/en/' : URLS.site); });
    // 诊断反馈：复制报告 / 带日志提 Issue（用户点击确认后才离开本机）
    $('about-diag-copy').addEventListener('click', function () {
      fetchDiag(function (d) {
        if (!d) { setStatus(dlText('诊断日志不可用（浏览器模式或读取失败）'), 'err'); return; }
        copyPath(buildReport(d, 0, true), null).then(function (copied) {
          setStatus(copied ? dlText('已复制诊断报告') : dlText('复制诊断报告失败'), copied ? 'done' : 'err');
        });
      });
    });
    $('about-diag-issue').addEventListener('click', function () {
      fetchDiag(function (d) {
        if (!d) { setStatus(dlText('诊断日志不可用（浏览器模式或读取失败）'), 'err'); return; }
        var body = buildReport(d, 0, true);
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
