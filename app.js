/* 随身翻译 —— 单页字幕，手动切换方向
 * 一块大字：听 src 语言，翻成 dst 语言；中间 ⇄ 一键对调。 */
(() => {
  'use strict';

  /* ---------------- 语言表 ---------------- */
  // id: iOS 语音识别用的 BCP-47；gtx / mm 用短码
  const LANGS = [
    { id: 'zh-CN', label: '中文（简体）', native: '简体中文', mm: 'zh-CN', gtx: 'zh-CN' },
    { id: 'zh-TW', label: '中文（繁體）', native: '繁體中文', mm: 'zh-TW', gtx: 'zh-TW' },
    { id: 'en-US', label: '英语', native: 'English', mm: 'en-GB', gtx: 'en' },
    { id: 'ja-JP', label: '日语', native: '日本語', mm: 'ja-JP', gtx: 'ja' },
    { id: 'ko-KR', label: '韩语', native: '한국어', mm: 'ko-KR', gtx: 'ko' },
    { id: 'fr-FR', label: '法语', native: 'Français', mm: 'fr-FR', gtx: 'fr' },
    { id: 'de-DE', label: '德语', native: 'Deutsch', mm: 'de-DE', gtx: 'de' },
    { id: 'es-ES', label: '西班牙语', native: 'Español', mm: 'es-ES', gtx: 'es' },
    { id: 'ru-RU', label: '俄语', native: 'Русский', mm: 'ru-RU', gtx: 'ru' },
    { id: 'it-IT', label: '意大利语', native: 'Italiano', mm: 'it-IT', gtx: 'it' },
    { id: 'pt-BR', label: '葡萄牙语', native: 'Português', mm: 'pt-BR', gtx: 'pt' },
    { id: 'th-TH', label: '泰语', native: 'ไทย', mm: 'th-TH', gtx: 'th' },
    { id: 'vi-VN', label: '越南语', native: 'Tiếng Việt', mm: 'vi-VN', gtx: 'vi' },
    { id: 'id-ID', label: '印尼语', native: 'Bahasa Indonesia', mm: 'id-ID', gtx: 'id' },
    { id: 'tr-TR', label: '土耳其语', native: 'Türkçe', mm: 'tr-TR', gtx: 'tr' },
    { id: 'ar-SA', label: '阿拉伯语', native: 'العربية', mm: 'ar-SA', gtx: 'ar', rtl: true },
    { id: 'hi-IN', label: '印地语', native: 'हिन्दी', mm: 'hi-IN', gtx: 'hi' },
  ];
  const langOf = (id) => LANGS.find((l) => l.id === id) || LANGS[0];

  /* ---------------- 设置 ---------------- */
  const KEY = 'livesubs.v2';
  const HISTORY_LIMIT = 1000;
  const DEFAULTS = {
    src: 'en-US',   // 说哪种语言
    dst: 'zh-CN',   // 译成哪种
    fontSize: 34,
    showOrig: true,
    tts: false,
    engine: 'auto',
    apiBase: '',
    apiModel: '',
    apiKey: '',
    mmEmail: '',
    asrEngine: 'siliconflow',
    siliconRemember: false,
  };

  const store = {
    read() {
      try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
    },
    write(obj) {
      try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch { /* 无痕模式 */ }
    },
  };

  const saved = store.read();
  const settings = { ...DEFAULTS, ...(saved.settings || {}) };
  // 旧版 AI 选项迁移到硅基流动，凭据按供应商分别读取。
  if (!['siliconflow', 'system'].includes(settings.asrEngine)) settings.asrEngine = 'siliconflow';
  delete settings.groqModel;
  delete settings.groqRemember;
  let siliconKey = saved.siliconKey || '';
  try { if (!settings.siliconRemember) siliconKey = sessionStorage.getItem('livesubs.siliconKey') || ''; } catch { /* 仅内存 */ }
  const pageSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let historySequence = 0;
  let history = Array.isArray(saved.history) ? saved.history.slice(-HISTORY_LIMIT).map((item, index) => ({ ...item, id: item.id || `saved:${item.ts}:${index}` })) : [];

  const persist = () => {
    store.write({ settings, history, ...(settings.siliconRemember && siliconKey ? { siliconKey } : {}) });
    try {
      if (!settings.siliconRemember && siliconKey) sessionStorage.setItem('livesubs.siliconKey', siliconKey);
      else sessionStorage.removeItem('livesubs.siliconKey');
    } catch { /* 仅内存 */ }
  };

  /* ---------------- DOM ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    trans: $('[data-trans]'),
    orig: $('[data-orig]'),
    status: $('[data-state]'),
    talk: $('#talk'),
    srcName: $('#srcName'),
    dstName: $('#dstName'),
  };
  const toastEl = $('#toast');
  let toastTimer = 0;
  const historyView = { following: true, unread: 0, frame: 0, signatures: new WeakMap() };

  function toast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  /* ---------------- 渲染 ---------------- */
  const srcLang = () => langOf(settings.src);
  const dstLang = () => langOf(settings.dst);
  const placeholderText = () => `说 ${srcLang().native} → ${dstLang().native}`;

  function renderLangs() {
    el.srcName.textContent = srcLang().native;
    el.dstName.textContent = dstLang().native;
    el.trans.dir = dstLang().rtl ? 'rtl' : 'ltr';
    if (el.trans.classList.contains('placeholder')) el.trans.textContent = placeholderText();
    if (!state.listening && !state.stopping) setSpeechHint();
    fitAll();
  }

  function setTrans(text, { pending = false, placeholder = false } = {}) {
    el.trans.classList.toggle('placeholder', placeholder);
    el.trans.classList.toggle('pending', pending);
    el.trans.textContent = text;
    if (text) { $('#currentCard').hidden = false; $('#historyEmpty').hidden = true; }
    fit(el.trans);
  }

  function setOrig(text) {
    el.orig.textContent = settings.showOrig ? text : '';
    if (text) { $('#currentCard').hidden = false; $('#historyEmpty').hidden = true; }
  }

  function setStatus(text, live = false) {
    el.status.textContent = text;
    el.status.classList.toggle('live', live);
  }

  // 对话区可以滚动，文字保持设定字号，不再缩小或裁切。
  function fit(node) {
    if (node) node.style.fontSize = '';
    queueConversationScroll();
  }
  function fitAll() { fit(el.trans); }

  window.addEventListener('resize', fitAll);
  window.addEventListener('orientationchange', () => setTimeout(fitAll, 220));

  function updateJumpButton() {
    const button = $('#jumpLatest');
    button.hidden = historyView.following;
    button.textContent = historyView.unread ? `${historyView.unread} 条新译文 · 回到最新 ↓` : '回到最新 ↓';
  }

  function queueConversationScroll() {
    if (historyView.frame) return;
    historyView.frame = requestAnimationFrame(() => {
      historyView.frame = 0;
      if (historyView.following) {
        const view = $('#conversation');
        view.scrollTop = view.scrollHeight;
        historyView.unread = 0;
      }
      updateJumpButton();
    });
  }

  function clearCurrent() {
    el.orig.textContent = '';
    el.trans.textContent = '';
    el.trans.classList.remove('pending', 'placeholder');
    $('#currentCard').hidden = $('#liveInput').hidden;
    $('#historyEmpty').hidden = history.length > 0 || !$('#currentCard').hidden;
    queueConversationScroll();
  }

  /* ---------------- 翻译 ---------------- */
  const cache = new Map();
  const ckey = (from, to, text, config) => JSON.stringify([from, to, text, config.engine, config.apiBase, config.apiModel, config.apiKey, config.mmEmail]);
  const health = { googleFails: 0, googleSkipUntil: 0, lastOk: '', warned: false };


  const abortError = () => new DOMException('已取消', 'AbortError');

  function runAttempt(operation, ms, label, parentSignal) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer = 0;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', cancelled);
        callback(value);
      };
      const cancelled = () => { controller.abort(); finish(reject, abortError()); };
      if (parentSignal?.aborted) { cancelled(); return; }
      parentSignal?.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        finish(reject, new Error(`${label} 超时`));
      }, ms);
      Promise.resolve().then(() => operation(controller.signal)).then(
        value => finish(resolve, value), error => finish(reject, error),
      );
    });
  }

  async function customTranslate(text, from, to, { signal, config = settings } = {}) {
    const base = config.apiBase.replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.apiModel || 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `你是同声传译。把用户说的话翻译成${langOf(to).label}，只输出译文本身，不要解释、不要引号、不要加“译文：”。`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`自定义接口 ${res.status}`);
    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error('自定义接口没有返回内容');
    return out.replace(/^["“]|["”]$/g, '');
  }

  async function googleTranslate(text, from, to, { signal } = {}) {
    const url = 'https://translate.googleapis.com/translate_a/single'
      + `?client=gtx&sl=${encodeURIComponent(langOf(from).gtx)}`
      + `&tl=${encodeURIComponent(langOf(to).gtx)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Google ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.[0])) throw new Error('Google 返回格式异常');
    return data[0].map((seg) => (seg && seg[0]) || '').join('').trim();
  }

  function chunkText(text, max = 480) {
    // MyMemory 限制的是 UTF-8 字节，中文不能按 JS 字符数切。
    const encoder = new TextEncoder();
    const out = [];
    let buf = '';
    let bytes = 0;
    for (const character of text) {
      const size = encoder.encode(character).length;
      if (buf && bytes + size > max) { out.push(buf); buf = ''; bytes = 0; }
      buf += character;
      bytes += size;
    }
    if (buf) out.push(buf);
    return out;
  }

  async function myMemoryTranslate(text, from, to, { signal, config = settings } = {}) {
    const pair = `${langOf(from).mm}|${langOf(to).mm}`;
    const pieces = chunkText(text);
    const outs = [];
    for (const piece of pieces) {
      if (signal?.aborted) throw abortError();
      const q = new URLSearchParams({
        q: piece,
        langpair: pair,
        ...(config.mmEmail ? { de: config.mmEmail } : {}),
      });
      const res = await fetch(`https://api.mymemory.translated.net/get?${q}`, { signal });
      if (!res.ok) throw new Error(`MyMemory ${res.status}`);
      const data = await res.json();
      if (Number(data.responseStatus) !== 200) {
        throw new Error(data.responseDetails || `MyMemory ${data.responseStatus}`);
      }
      outs.push(String(data.responseData.translatedText || '').trim());
    }
    return outs.join(' ');
  }

  /**
   * 依次尝试：自定义 → Google → MyMemory；返回 { text, engine }
   */
  async function translate(text, from, to, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    const clean = text.trim();
    if (!clean) return { text: '', engine: 'none' };
    if (from === to) return { text: clean, engine: 'none' };

    const config = { ...settings };
    const key = ckey(from, to, clean, config);
    if (cache.has(key)) return cache.get(key);

    const mode = config.engine;
    if (mode === 'custom' && !(config.apiBase && config.apiKey)) throw new Error('请先填写自定义接口地址和 API Key');
    const tries = [];
    const googleReady = Date.now() > health.googleSkipUntil;
    if (mode === 'custom') tries.push(['custom', customTranslate, 12000]);
    else if (mode === 'mymemory') tries.push(['mymemory', myMemoryTranslate, 7000]);
    else if (mode === 'google') {
      if (googleReady) tries.push(['google', googleTranslate, 2200]);
      tries.push(['mymemory', myMemoryTranslate, 7000]);
    } else {
      if (config.apiKey && config.apiBase) tries.push(['custom', customTranslate, 12000]);
      if (googleReady) tries.push(['google', googleTranslate, 2200]);
      tries.push(['mymemory', myMemoryTranslate, 7000]);
    }

    let lastErr = null;
    for (const [name, fn, timeout] of tries) {
      try {
        const out = await runAttempt(attemptSignal => fn(clean, from, to, { signal: attemptSignal, config }), timeout, name, signal);
        if (out) {
          const result = { text: out, engine: name };
          if (cache.size > 400) cache.clear();
          cache.set(key, result);
          health.lastOk = name;
          if (name === 'google') health.googleFails = 0;
          return result;
        }
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw abortError();
        lastErr = err;
        if (name === 'google') {
          health.googleFails += 1;
          health.googleSkipUntil = Date.now() + (health.googleFails >= 2 ? 5 : 1) * 60 * 1000;
          if (health.googleFails >= 2) {
            if (!health.warned) {
              health.warned = true;
              toast('Google 翻译连不上，已自动改用 MyMemory。', 3600);
            }
          }
        }
        console.warn(`[translate] ${name} 失败`, err);
      }
    }
    throw lastErr || new Error('翻译失败');
  }

  /* ---------------- 朗读 ---------------- */
  function speak(text, langId) {
    if (!settings.tts || !text || state.listening || state.stopping) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langId;
      u.rate = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* iOS 需要手势，忽略 */ }
  }

  /* ---------------- 语音识别 ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const state = {
    listening: false,
    stopping: false,
    rec: null,
    buffer: '',
    interim: '',
    finalCount: 0,
    heardText: false,
    started: false,
    sessionHadText: false,
    emptyEnds: 0,
    lastVoice: 0,
    wakeLock: null,
    restartTimer: 0,
    idleTimer: 0,
    stopTimer: 0,
    cloud: false,
  };

  const IDLE_STOP_MS = 30000;

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) {
        const lock = await navigator.wakeLock.request('screen');
        if (!state.listening) { await lock.release(); return; }
        state.wakeLock = lock;
        lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
      }
    } catch { /* 不支持就算了 */ }
  }
  function releaseAwake() {
    try { state.wakeLock?.release(); } catch { /* noop */ }
    state.wakeLock = null;
  }

  function uiListening(on) {
    el.talk.classList.toggle('listening', on);
    el.talk.setAttribute('aria-pressed', String(on));
    el.talk.disabled = false;
    $('.lbl', el.talk).textContent = on ? '停止' : '说话';
    if (!on) setStatus('待机', false);
  }

  function setSpeechHint(text = `${settings.asrEngine === 'siliconflow' ? '硅基流动 AI 识别' : '系统语音识别'} · 请说 ${srcLang().native}`) {
    $('#speechHint').textContent = text;
  }

  let typedRequest = null;
  const subtitleFlow = new window.LivesubsSubtitleFlow({
    translate,
    languages: () => ({ from: settings.src, to: settings.dst }),
    onDraft(text) {
      $('#liveInput').hidden = !text;
      $('#liveDraft').textContent = text;
      if (text) { $('#currentCard').hidden = false; $('#historyEmpty').hidden = true; }
      else if (!el.trans.textContent.trim()) $('#currentCard').hidden = true;
      fitAll();
    },
    onWorking(task) {
      if (task.segment || !task.preview) { setOrig(task.text); fitAll(); }
      setTrans('正在翻译…', { pending: true, placeholder: true });
      setStatus(task.preview && !task.segment ? '正在预览译文…' : '正在翻译…', state.listening);
    },
    onResult(task) {
      if (!task.preview || task.segment) {
        const id = task.sourceKey ? `${pageSession}:${task.sourceKey}` : undefined;
        pushHistory(task.text, task.result.text, task.from, task.to, { id, provisional: task.preview });
        clearCurrent();
      } else {
        setOrig('');
        setTrans(task.result.text, { pending: true });
      }
      setStatus(task.preview ? '实时译文' : `已译 ${task.ms}ms`, state.listening);
      if (!task.preview) {
        speak(task.result.text, task.to);
      }
    },
    onError(error, task) {
      setOrig(task.text);
      setTrans('这一句翻译失败', { placeholder: true });
      setStatus('翻译失败');
      toast(`翻译失败：${error.message || error}`, 4200);
    },
  });

  const siliconASR = new window.LivesubsSiliconASR({
    onState(phase, message) {
      if (!state.cloud) return;
      if (phase === 'stopped') { finishListening(); return; }
      setSpeechHint(message);
      if (phase === 'listening') setStatus(`硅基流动正在听 ${srcLang().native}…`, true);
      else if (phase === 'recognizing') setStatus('硅基流动正在识别…', state.listening);
      else if (phase === 'finishing') {
        state.listening = false;
        state.stopping = true;
        uiListening(false);
        el.talk.disabled = true;
        $('.lbl', el.talk).textContent = '收尾中';
        setStatus('正在识别最后一段…');
      }
    },
    onLevel(value) {
      if (state.cloud) $('#siliconLevel').value = value;
    },
    onText(text) {
      if (!state.cloud) return;
      state.heardText = true;
      state.lastVoice = Date.now();
      subtitleFlow.commit(text);
    },
    onError(error) {
      if (!state.cloud) return;
      failRecognition('硅基流动识别已停止', error.message);
    },
  });

  function startSiliconListening() {
    if (!window.isSecureContext) { toast('麦克风需要 HTTPS，请打开在线地址。'); return; }
    if (!siliconKey) {
      syncSettingsUI();
      $('#capInfo').textContent = capabilityText();
      openSheet('settingsSheet');
      $('#siliconKey').focus();
      toast('请先填写你自己的硅基流动API Key，再点说话。', 4200);
      return;
    }
    stopListening({ silent: true });
    stopMicTest();
    try { window.speechSynthesis?.cancel(); } catch { /* 无朗读服务 */ }
    state.listening = state.cloud = true;
    state.heardText = false;
    state.lastVoice = Date.now();
    clearCurrent();
    uiListening(true);
    $('#siliconCapture').hidden = false;
    $('#siliconLevel').value = 0;
    setStatus('正在启动硅基流动收音…', true);
    keepAwake();
    siliconASR.start({ key: siliconKey, language: settings.src });
  }

  function queueTranslate(text, isFinal) {
    if (isFinal) subtitleFlow.commit(text);
    else subtitleFlow.setDraft(text);
  }

  function newRecognizer() {
    const rec = new SR();
    rec.lang = settings.src;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      if (state.rec !== rec || !state.listening) return;
      if (!state.started) state.lastVoice = Date.now();
      state.started = true;
      setStatus(`正在听 ${srcLang().native}…`, true);
      setSpeechHint(`请说 ${srcLang().native} · 把手机靠近说话人或外放音源`);
    };
    rec.onsoundstart = rec.onspeechstart = () => {
      if (state.rec !== rec || !state.listening) return;
      state.lastVoice = Date.now();
      setStatus('收到声音，正在识别…', true);
    };
    rec.onspeechend = () => {
      if (state.rec === rec && state.listening) subtitleFlow.flushPreview(true);
    };

    rec.onresult = (event) => {
      if (state.rec !== rec) return;
      state.lastVoice = Date.now();
      const finals = [];
      const interim = [];
      // results 是本次识别的完整快照。重建文字，避免重复累加已确认结果。
      for (let i = 0; i < event.results.length; i += 1) {
        const r = event.results[i];
        const t = (r[0]?.transcript || '').trim();
        if (r.isFinal) finals.push(t);
        else interim.push(t);
      }
      state.buffer = finals.filter(Boolean).join(' ').trim();
      state.interim = interim.filter(Boolean).join(' ').trim();
      const live = [state.buffer, state.interim].filter(Boolean).join(' ');
      state.sessionHadText = state.sessionHadText || finals.some(Boolean) || interim.some(Boolean);
      state.heardText = state.heardText || !!live;
      if (live) state.emptyEnds = 0;
      // 已确认的结果只提交一次，不再把前面整段内容重复翻译。
      for (let index = state.finalCount; index < finals.length; index += 1) {
        subtitleFlow.commit(finals[index]);
      }
      state.finalCount = finals.length;
      subtitleFlow.setDraft(state.interim);
      if (state.stopping) subtitleFlow.hold();
    };

    rec.onerror = (event) => {
      if (state.rec !== rec) return;
      const code = event.error;
      if (code === 'aborted') return;
      if (code === 'no-speech') {
        setSpeechHint(`暂未识别到 ${srcLang().native} · 请靠近声源，确认左侧语言`);
        return;
      }
      const errors = {
        'not-allowed': ['需要麦克风权限', '请在 Safari 中允许本站使用麦克风和语音识别，再点一次说话。'],
        'service-not-allowed': ['系统语音识别不可用', '请用 Safari 打开，并检查 Siri、听写和语音识别权限；也可用键盘听写。'],
        'network': ['语音识别连接失败', '语音识别服务未连接成功，请换个网络或用键盘听写。'],
        'audio-capture': ['没有可用的麦克风', '请检查麦克风权限及蓝牙耳机的输入，或用键盘听写。'],
        'language-not-supported': ['暂不支持这个识别语言', '请更换左侧语言，或用键盘听写后翻译。'],
      };
      const [title, message] = errors[code] || ['语音识别中断', '请重新点说话，或点左下角用键盘听写。'];
      failRecognition(title, message);
    };

    rec.onend = () => {
      if (state.rec !== rec) return;
      if (state.stopping) { finishListening(); return; }
      if (!state.listening) return;

      // Safari 有时只给临时结果就结束。先保留文字，再开始下一段。
      subtitleFlow.finish();
      state.buffer = '';
      state.interim = '';
      state.emptyEnds = state.sessionHadText ? 0 : state.emptyEnds + 1;
      if (state.emptyEnds >= 4) {
        finishListening();
        setSpeechHint('识别多次未返回文字 · 请靠近声源，或点左下角用键盘听写');
        return;
      }
      clearTimeout(state.restartTimer);
      state.restartTimer = setTimeout(() => {
        if (!state.listening || state.rec !== rec) return;
        state.finalCount = 0;
        state.sessionHadText = false;
        try {
          rec.start();
        } catch {
          failRecognition('语音识别无法继续', '请重新点说话，或点左下角用键盘听写。');
        }
      }, Math.min(350 + state.emptyEnds * 250, 1500));
    };

    return rec;
  }

  function startListening() {
    if (settings.asrEngine === 'siliconflow') { startSiliconListening(); return; }
    if (!SR) {
      setSpeechHint('请用 Safari 打开；也可点左下角用键盘听写');
      toast('当前浏览器没有可用的语音识别。请用 Safari 打开，或用键盘听写。', 4600);
      return;
    }
    if (!window.isSecureContext) {
      toast('麦克风只在 HTTPS 页面可用（当前不是）。换 https 地址打开，或先用 ⌨️ 打字。', 5200);
      return;
    }

    stopListening({ silent: true });
    stopMicTest();
    try { window.speechSynthesis?.cancel(); } catch { /* 无朗读服务 */ }

    state.listening = true;
    state.buffer = '';
    state.interim = '';
    state.finalCount = 0;
    state.heardText = false;
    state.started = false;
    state.sessionHadText = false;
    state.emptyEnds = 0;
    state.lastVoice = Date.now();

    setOrig('');
    setTrans('正在听，请开始说话…', { pending: true, placeholder: true });
    uiListening(true);
    setStatus('正在启动语音识别…', true);
    setSpeechHint(`准备接收 ${srcLang().native} · 首次使用请允许麦克风和语音识别`);
    keepAwake();

    try {
      state.rec = newRecognizer();
      state.rec.start();
    } catch (err) {
      console.warn(err);
      failRecognition('语音识别未启动', '请检查 Safari 麦克风与语音识别权限，或点左下角用键盘听写。');
      return;
    }

    clearInterval(state.idleTimer);
    state.idleTimer = setInterval(() => {
      if (!state.listening) return;
      if (Date.now() - state.lastVoice > IDLE_STOP_MS) {
        stopListening();
        toast('30 秒未收到新的识别结果，已停止收音。');
      }
    }, 1000);
  }

  function stopListening({ silent = false } = {}) {
    const wasListening = state.listening || state.stopping;
    if (state.cloud && !silent) {
      if (!wasListening || state.stopping) return;
      state.listening = false;
      state.stopping = true;
      uiListening(false);
      el.talk.disabled = true;
      $('.lbl', el.talk).textContent = '收尾中';
      siliconASR.stop();
      return;
    }
    state.listening = false;
    clearTimeout(state.restartTimer);
    clearInterval(state.idleTimer);

    if (silent) { finishListening({ discard: true, abort: true }); return; }
    if (!wasListening || state.stopping) return;
    if (!state.rec) { finishListening(); return; }

    // stop 会尝试给出最后一句；立即 abort 会把这个结果丢掉。
    state.stopping = true;
    subtitleFlow.hold();
    uiListening(false);
    el.talk.disabled = true;
    $('.lbl', el.talk).textContent = '收尾中';
    setStatus('正在处理最后一句…');
    state.stopTimer = setTimeout(() => finishListening({ abort: true }), 2500);
    try { state.rec.stop(); } catch { finishListening({ abort: true }); }
  }

  function finishListening({ discard = false, abort = false } = {}) {
    clearTimeout(state.stopTimer);
    clearTimeout(state.restartTimer);
    clearInterval(state.idleTimer);
    siliconASR.cancel();
    state.cloud = false;
    $('#siliconCapture').hidden = true;
    const rec = state.rec;
    state.rec = null;
    state.listening = false;
    state.stopping = false;
    if (rec) {
      rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
      rec.onsoundstart = rec.onspeechstart = rec.onspeechend = null;
      if (abort) { try { rec.abort(); } catch { /* noop */ } }
    }
    uiListening(false);
    releaseAwake();
    if (discard) {
      subtitleFlow.reset();
      typedRequest?.abort();
      typedRequest = null;
      el.trans.classList.remove('pending');
      return;
    }
    setSpeechHint();
    subtitleFlow.finish();
    state.interim = '';
    if (state.heardText) {
      setStatus(subtitleFlow.pending ? '正在翻译…' : '已停止收音');
    } else {
      setTrans('还没有收到语音', { placeholder: true });
      setStatus('未收到识别文字');
      setSpeechHint(`请确认说的是 ${srcLang().native}，并靠近声源；也可用键盘听写`);
    }
  }

  function failRecognition(title, message) {
    finishListening({ abort: true });
    if (!state.heardText) setTrans(title, { placeholder: true });
    setStatus(title);
    setSpeechHint(message);
    toast(message, 5200);
  }

  function toggleTalk() {
    if (state.stopping) return;
    if (state.listening) stopListening();
    else startListening();
  }

  /* ---------------- 独立收音测试 ---------------- */
  let micObjectUrl = '';
  const micTest = new window.LivesubsMicTest({
    onState(phase, message, detail = {}) {
      $('#micTestStatus').textContent = message;
      $('#micRecord').disabled = phase === 'finishing';
      $('#micRecord').textContent = ['recording', 'requesting'].includes(phase) ? '停止录音' : phase === 'finishing' ? '生成回放中' : '开始录音';
      $('#micMode').disabled = ['recording', 'requesting', 'finishing'].includes(phase);
      if (phase === 'requesting') {
        $('#micPlayback').pause();
        $('#micPlayback').removeAttribute('src');
        $('#micPlayback').hidden = true;
        if (micObjectUrl) URL.revokeObjectURL(micObjectUrl);
        micObjectUrl = '';
        $('#micLevel').value = 0;
        $('#micLevelLabel').textContent = '等待麦克风';
        $('#micElapsed').textContent = '0.0 / 10 秒';
        $('#micActual').textContent = '';
      }
      if (phase === 'recording') {
        const names = { autoGainControl: '自动音量', noiseSuppression: '降噪', echoCancellation: '回声处理' };
        const bits = Object.entries(names).filter(([key]) => typeof detail.settings[key] === 'boolean')
          .map(([key, label]) => `${label}：${detail.settings[key] ? '开' : '关'}`);
        $('#micActual').textContent = bits.length ? `设备报告 · ${bits.join(' · ')}` : '设备未报告处理设置，所选模式可能未生效。';
      }
    },
    onLevel(level, elapsed) {
      $('#micElapsed').textContent = `${elapsed.toFixed(1)} / 10 秒`;
      $('#micLevel').value = level ?? 0;
      $('#micLevelLabel').textContent = level === null ? '此设备未提供实时音量，请录完后回放' : level < 12 ? '接近静音' : level < 35 ? '声音较小' : level < 75 ? '有声音' : '声音较强';
    },
    onRecording(blob) {
      if (micObjectUrl) URL.revokeObjectURL(micObjectUrl);
      micObjectUrl = URL.createObjectURL(blob);
      $('#micPlayback').src = micObjectUrl;
      $('#micPlayback').hidden = false;
    },
  });

  function stopMicTest() {
    const wasActive = micTest.running || micTest.waiting || !!micTest.recorder;
    micTest.cancel();
    $('#micPlayback').pause();
    $('#micRecord').disabled = false;
    $('#micRecord').textContent = '开始录音';
    $('#micMode').disabled = false;
    if (wasActive) {
      $('#micTestStatus').textContent = '测试已停止，可重新录音。';
      $('#micLevelLabel').textContent = '已停止收音';
      $('#micLevel').value = 0;
    }
  }

  function openMicTest() {
    stopListening({ silent: true });
    closeSheet('settingsSheet');
    setStatus('收音测试 · 翻译已暂停');
    setSpeechHint('录音只在本页回放，不会上传');
    openSheet('micTestSheet');
  }

  function toggleMicTest() {
    if (micTest.running || micTest.waiting) micTest.stop();
    else micTest.start($('#micMode').value);
  }

  /* ---------------- 历史 ---------------- */
  function pushHistory(orig, trans, from, to, { id, provisional = false } = {}) {
    if (!orig || !trans) return;
    const existing = id ? history.findIndex(item => item.id === id) : -1;
    if (existing >= 0) {
      history[existing] = { ...history[existing], orig, trans, from, to, provisional };
    } else {
      history.push({ id: id || `${pageSession}:record:${++historySequence}`, orig, trans, from, to, provisional, ts: Date.now() });
    }
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    persist();
    renderHistory();
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

  function renderHistory() {
    renderConversation();
    const list = $('#historyList');
    if (!history.length) {
      list.innerHTML = '<div class="empty">还没有记录</div>';
      return;
    }
    list.innerHTML = history
      .slice()
      .reverse()
      .map((h) => `
        <div class="hitem">
          <div class="meta"><span>${fmtTime(h.ts)}</span>
            <span>${langOf(h.from).label} → ${langOf(h.to).label}${h.provisional ? ' · 实时' : ''}</span></div>
          <div class="o">${escapeHtml(h.orig)}</div>
          <div class="t">${escapeHtml(h.trans)}</div>
        </div>`)
      .join('');
  }

  function renderConversation() {
    const view = $('#conversation'), list = $('#timelineList');
    const top = view.getBoundingClientRect().top;
    const anchor = !historyView.following ? [...list.children].find(item => item.getBoundingClientRect().bottom > top) : null;
    const anchorId = anchor?.dataset.historyId;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    const existing = new Map([...list.children].map(item => [item.dataset.historyId, item]));
    let added = 0;
    history.forEach((item, index) => {
      let card = existing.get(item.id);
      if (!card) {
        card = document.createElement('article');
        card.className = 'timeline-item';
        card.setAttribute('role', 'listitem');
        card.dataset.historyId = item.id;
        added += 1;
      }
      existing.delete(item.id);
      const signature = JSON.stringify([item.orig, item.trans, item.from, item.to, item.provisional]);
      if (historyView.signatures.get(card) !== signature) {
        card.innerHTML = `<div class="timeline-meta"><time>${fmtTime(item.ts)}</time><span>${langOf(item.from).native} → ${langOf(item.to).native}${item.provisional ? ' · 实时' : ''}</span></div>
          <p class="timeline-original" dir="${langOf(item.from).rtl ? 'rtl' : 'ltr'}">${escapeHtml(item.orig)}</p>
          <p class="timeline-translation" dir="${langOf(item.to).rtl ? 'rtl' : 'ltr'}">${escapeHtml(item.trans)}</p>`;
        historyView.signatures.set(card, signature);
      }
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    });
    for (const card of existing.values()) card.remove();
    $('#historyCount').textContent = `${history.length} 条`;
    $('#historyEmpty').hidden = history.length > 0 || !$('#currentCard').hidden;
    if (!historyView.following) {
      historyView.unread += added;
      const restored = [...list.children].find(item => item.dataset.historyId === anchorId);
      if (restored) view.scrollTop += restored.getBoundingClientRect().top - top - anchorOffset;
      updateJumpButton();
    } else queueConversationScroll();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildSrt() {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = (ms) => {
      const d = new Date(ms);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`;
    };
    return history.map((h, i) => {
      const start = h.ts;
      const end = Math.max(start + 1200, (history[i + 1]?.ts || start + 4000) - 100);
      return `${i + 1}\n${stamp(start)} --> ${stamp(end)}\n${h.orig}\n${h.trans}\n`;
    }).join('\n');
  }

  async function copyAll() {
    const text = history.map((h) => `${h.orig}\n    → ${h.trans}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    }
  }

  function downloadSrt() {
    const blob = new Blob([buildSrt()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `翻译_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.srt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* ---------------- 抽屉 ---------------- */
  function openSheet(id) { $(`#${id}`).hidden = false; }
  function closeSheet(id) {
    $(`#${id}`).hidden = true;
    if (id === 'micTestSheet') { stopMicTest(); setSpeechHint(); setStatus('待机'); }
  }

  $$('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(sheet.id); });
  });
  $$('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeSheet(btn.dataset.close));
  });

  /* ---------------- 语言选择 ---------------- */
  let langTarget = 'src';
  function openLangPicker(target) {
    langTarget = target;
    $('#langTitle').textContent = target === 'src' ? '我说哪种语言' : '译成哪种语言';
    const current = target === 'src' ? settings.src : settings.dst;
    const list = $('#langList');
    list.innerHTML = LANGS.map((l) => {
      const active = current === l.id;
      return `<button class="lang-item" data-id="${l.id}" type="button">
        <span>${l.label}${active ? ' ✓' : ''}</span><span class="native">${l.native}</span></button>`;
    }).join('');
    $$('.lang-item', list).forEach((btn) => {
      btn.addEventListener('click', () => {
        stopListening({ silent: true });
        const id = btn.dataset.id;
        if (target === 'src') {
          settings.src = id;
          if (settings.dst === id) settings.dst = id === 'zh-CN' ? 'en-US' : 'zh-CN';
        } else {
          settings.dst = id;
          if (settings.src === id) settings.src = id === 'zh-CN' ? 'en-US' : 'zh-CN';
        }
        persist();
        renderLangs();
        closeSheet('langSheet');
      });
    });
    openSheet('langSheet');
  }

  /* ---------------- 设置面板 ---------------- */
  function syncSettingsUI() {
    $('#asrEngine').value = settings.asrEngine;
    $('#siliconBox').hidden = settings.asrEngine !== 'siliconflow';
    $('#siliconKey').value = siliconKey;
    $('#siliconRemember').checked = settings.siliconRemember;
    $('#fontRange').value = settings.fontSize;
    $('#fontOut').textContent = settings.fontSize + 'px';
    $('#showOrig').checked = settings.showOrig;
    $('#tts').checked = settings.tts;
    $('#engine').value = settings.engine;
    $('#apiBase').value = settings.apiBase;
    $('#apiModel').value = settings.apiModel;
    $('#apiKey').value = settings.apiKey;
    $('#mmEmail').value = settings.mmEmail;
    $('#customBox').hidden = settings.engine !== 'custom';
    document.documentElement.style.setProperty('--trans-size', settings.fontSize + 'px');
  }

  function wireSettings() {
    $('#asrEngine').addEventListener('change', e => {
      stopListening({ silent: true });
      settings.asrEngine = e.target.value;
      $('#siliconBox').hidden = settings.asrEngine !== 'siliconflow';
      persist();
      setSpeechHint();
    });
    $('#siliconKey').addEventListener('change', e => {
      stopListening({ silent: true });
      siliconKey = e.target.value.trim();
      persist();
    });
    $('#siliconRemember').addEventListener('change', e => {
      settings.siliconRemember = e.target.checked;
      persist();
    });
    $('#fontRange').addEventListener('input', (e) => {
      settings.fontSize = Number(e.target.value);
      $('#fontOut').textContent = settings.fontSize + 'px';
      document.documentElement.style.setProperty('--trans-size', settings.fontSize + 'px');
      fitAll();
      persist();
    });
    $('#showOrig').addEventListener('change', (e) => {
      settings.showOrig = e.target.checked;
      persist();
      el.orig.style.display = e.target.checked ? '' : 'none';
      document.documentElement.classList.toggle('hide-original', !e.target.checked);
    });
    $('#tts').addEventListener('change', (e) => { settings.tts = e.target.checked; persist(); });
    $('#engine').addEventListener('change', (e) => {
      stopListening({ silent: true });
      settings.engine = e.target.value;
      $('#customBox').hidden = settings.engine !== 'custom';
      persist();
    });
    ['apiBase', 'apiModel', 'apiKey', 'mmEmail'].forEach((id) => {
      const elx = $('#' + id);
      elx.addEventListener('change', () => {
        stopListening({ silent: true });
        settings[id] = elx.value.trim();
        persist();
      });
    });
  }

  function capabilityText() {
    const bits = [];
    bits.push(SR ? '系统语音识别：可用' : '系统语音识别：不可用');
    bits.push(`硅基流动：${siliconKey ? '已填写 Key' : '请填写 Key'}`);
    bits.push(window.isSecureContext ? '安全上下文：是' : '安全上下文：否（麦克风会被拦）');
    bits.push(navigator.onLine ? '网络：在线' : '网络：离线');
    if (health.lastOk) bits.push(`上次翻译走：${health.lastOk}`);
    return bits.join(' · ');
  }

  /* ---------------- 打字输入 ---------------- */
  function openType() {
    stopListening({ silent: true });
    setSpeechHint();
    $('#typeInput').value = '';
    openSheet('typeSheet');
    setTimeout(() => $('#typeInput').focus(), 220);
  }

  async function sendTyped() {
    const text = $('#typeInput').value.trim();
    if (!text) return;
    stopListening({ silent: true });
    const controller = new AbortController();
    typedRequest = controller;
    const from = settings.src, to = settings.dst;
    closeSheet('typeSheet');
    setOrig(text);
    setTrans('…', { pending: true });
    setStatus('正在翻译…');
    try {
      const { text: out } = await translate(text, from, to, { signal: controller.signal });
      if (typedRequest !== controller || controller.signal.aborted) return;
      setTrans(out);
      setStatus('已译');
      pushHistory(text, out, from, to);
      clearCurrent();
      speak(out, to);
    } catch (err) {
      if (controller.signal.aborted || typedRequest !== controller) return;
      setTrans('翻译失败', { placeholder: true });
      toast(`翻译失败：${err.message || err}`);
    } finally {
      if (typedRequest === controller) typedRequest = null;
    }
  }

  /* ---------------- 事件 ---------------- */
  function wire() {
    el.talk.addEventListener('click', toggleTalk);
    $('#srcBtn').addEventListener('click', () => openLangPicker('src'));
    $('#dstBtn').addEventListener('click', () => openLangPicker('dst'));
    $('#openType').addEventListener('click', openType);
    $('#openMicTest').addEventListener('click', openMicTest);
    $('#testMicSettings').addEventListener('click', openMicTest);
    $('#micRecord').addEventListener('click', toggleMicTest);
    $('#conversation').addEventListener('scroll', () => {
      const view = $('#conversation');
      historyView.following = view.scrollHeight - view.clientHeight - view.scrollTop < 60;
      if (historyView.following) historyView.unread = 0;
      updateJumpButton();
    }, { passive: true });
    $('#jumpLatest').addEventListener('click', () => {
      historyView.following = true;
      queueConversationScroll();
    });

    $('#swap').addEventListener('click', () => {
      stopListening({ silent: true });
      [settings.src, settings.dst] = [settings.dst, settings.src];
      persist();
      renderLangs();
      setStatus('已换方向');
    });

    $('#openSettings').addEventListener('click', () => {
      syncSettingsUI();
      $('#capInfo').textContent = capabilityText();
      openSheet('settingsSheet');
    });
    $('#openHistory').addEventListener('click', () => { renderHistory(); openSheet('historySheet'); });
    $('#srtBtn').addEventListener('click', downloadSrt);
    $('#copyBtn').addEventListener('click', copyAll);
    $('#clearBtn').addEventListener('click', () => {
      if (!history.length) return;
      if (confirm('清空所有记录？')) { history = []; persist(); renderHistory(); }
    });
    $('#typeSend').addEventListener('click', sendTyped);
    $('#typeInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendTyped();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (state.listening || state.stopping) finishListening({ abort: true });
        stopMicTest();
      }
    });
    window.addEventListener('pagehide', () => {
      if (state.listening || state.stopping) finishListening({ abort: true });
      stopMicTest();
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    if (!window.isSecureContext) $('#insecure').hidden = false;

    document.documentElement.style.setProperty('--trans-size', settings.fontSize + 'px');
    if (!settings.showOrig) el.orig.style.display = 'none';
    document.documentElement.classList.toggle('hide-original', !settings.showOrig);

    renderLangs();
    wire();
    wireSettings();
    renderHistory();

    clearCurrent();
    setStatus('待机');

    // 开机探一次 Google：国内基本连不上，先把断路器打开，别让第一句干等超时
    if (navigator.onLine && ['auto', 'google'].includes(settings.engine)) {
      (async () => {
        try {
          await runAttempt(signal => googleTranslate('hello', 'en-US', 'zh-CN', { signal }), 1800, 'Google');
        } catch {
          health.googleFails = 2;
          health.googleSkipUntil = Date.now() + 5 * 60 * 1000;
        }
      })();
    }

    window.__livesubs = { settings, translate, health, queueTranslate, setTrans, fitAll, get history() { return history; }, buildSrt };

    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    fitAll();
    setTimeout(fitAll, 400);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
