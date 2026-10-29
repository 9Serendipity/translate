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
  let history = Array.isArray(saved.history) ? saved.history.slice(-200) : [];

  const persist = () => store.write({ settings, history });

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
    fitAll();
  }

  function setTrans(text, { pending = false, placeholder = false } = {}) {
    el.trans.classList.toggle('placeholder', placeholder);
    el.trans.classList.toggle('pending', pending);
    el.trans.textContent = text;
    fit(el.trans);
  }

  function setOrig(text) {
    el.orig.textContent = settings.showOrig ? text : '';
  }

  function setStatus(text, live = false) {
    el.status.textContent = text;
    el.status.classList.toggle('live', live);
  }

  // 字太大就往下缩，留 14% 余量，保证不贴着按钮
  function fit(node) {
    if (!node) return;
    if (node.classList.contains('placeholder')) { node.style.fontSize = ''; return; }
    const box = node.parentElement;
    if (!box) return;
    let size = settings.fontSize;
    node.style.fontSize = size + 'px';
    const limit = Math.max(48, Math.round(box.clientHeight * 0.86));
    let guard = 0;
    while (node.scrollHeight > limit && size > 15 && guard++ < 40) {
      size -= 2;
      node.style.fontSize = size + 'px';
    }
    // 缩到底还放不下：从头开始裁，保证句首可见
    box.style.justifyContent = node.scrollHeight > box.clientHeight ? 'flex-start' : '';
  }
  function fitAll() { fit(el.trans); }

  window.addEventListener('resize', fitAll);
  window.addEventListener('orientationchange', () => setTimeout(fitAll, 220));

  /* ---------------- 翻译 ---------------- */
  const cache = new Map();
  const ckey = (from, to, text) => `${from}|${to}|${text}`;
  const health = { googleFails: 0, googleSkipUntil: 0, lastOk: '', warned: false };

  const hasCustom = () => !!(settings.apiKey && settings.apiBase);

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms)),
    ]);
  }

  async function customTranslate(text, from, to) {
    const base = settings.apiBase.replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.apiModel || 'gpt-4o-mini',
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

  async function googleTranslate(text, from, to) {
    const url = 'https://translate.googleapis.com/translate_a/single'
      + `?client=gtx&sl=${encodeURIComponent(langOf(from).gtx)}`
      + `&tl=${encodeURIComponent(langOf(to).gtx)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.[0])) throw new Error('Google 返回格式异常');
    return data[0].map((seg) => (seg && seg[0]) || '').join('').trim();
  }

  // 不用 lookbehind：iOS 16.4 以下解析会在文件级直接报错
  function splitSentences(text) {
    const out = [];
    let buf = '';
    for (const ch of text) {
      buf += ch;
      if ('。！？.!?\n'.indexOf(ch) >= 0) { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
    return out;
  }

  function chunkText(text, max = 450) {
    if (text.length <= max) return [text];
    const out = [];
    let buf = '';
    for (const piece of splitSentences(text)) {
      if ((buf + piece).length > max && buf) { out.push(buf); buf = piece; }
      else buf += piece;
    }
    if (buf) out.push(buf);
    return out.flatMap((p) => {
      if (p.length <= max) return [p];
      const cuts = [];
      for (let i = 0; i < p.length; i += max - 10) cuts.push(p.slice(i, i + max - 10));
      return cuts;
    });
  }

  async function myMemoryTranslate(text, from, to) {
    const pair = `${langOf(from).mm}|${langOf(to).mm}`;
    const pieces = chunkText(text);
    const outs = [];
    for (const piece of pieces) {
      const q = new URLSearchParams({
        q: piece,
        langpair: pair,
        ...(settings.mmEmail ? { de: settings.mmEmail } : {}),
      });
      const res = await fetch(`https://api.mymemory.translated.net/get?${q}`);
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
  async function translate(text, from, to) {
    const clean = text.trim();
    if (!clean) return { text: '', engine: 'none' };
    if (from === to) return { text: clean, engine: 'none' };

    const key = ckey(from, to, clean);
    if (cache.has(key)) return cache.get(key);

    const mode = settings.engine;
    const tries = [];
    const googleReady = Date.now() > health.googleSkipUntil;
    if (mode === 'custom') tries.push(['custom', customTranslate, 12000]);
    else if (mode === 'mymemory') tries.push(['mymemory', myMemoryTranslate, 9000]);
    else if (mode === 'google') {
      if (googleReady) tries.push(['google', googleTranslate, 5000]);
      tries.push(['mymemory', myMemoryTranslate, 9000]);
    } else {
      if (hasCustom()) tries.push(['custom', customTranslate, 12000]);
      if (googleReady) tries.push(['google', googleTranslate, 5000]);
      tries.push(['mymemory', myMemoryTranslate, 9000]);
    }

    let lastErr = null;
    for (const [name, fn, timeout] of tries) {
      try {
        const out = await withTimeout(fn(clean, from, to), timeout, name);
        if (out) {
          const result = { text: out, engine: name };
          if (cache.size > 400) cache.clear();
          cache.set(key, result);
          health.lastOk = name;
          if (name === 'google') health.googleFails = 0;
          return result;
        }
      } catch (err) {
        lastErr = err;
        if (name === 'google') {
          health.googleFails += 1;
          if (health.googleFails >= 2) {
            health.googleSkipUntil = Date.now() + 5 * 60 * 1000;
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
    if (!settings.tts || !text) return;
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
    rec: null,
    buffer: '',
    lastVoice: 0,
    token: 0,
    wakeLock: null,
    restartTimer: 0,
    idleTimer: 0,
  };

  const IDLE_STOP_MS = 20000;

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } catch { /* 不支持就算了 */ }
  }
  function releaseAwake() {
    try { state.wakeLock?.release(); } catch { /* noop */ }
    state.wakeLock = null;
  }

  function uiListening(on) {
    el.talk.classList.toggle('listening', on);
    $('.lbl', el.talk).textContent = on ? '停止' : '说话';
    if (on) setStatus('正在听…', true);
    else setStatus('待机', false);
  }

  let translateTimer = 0;

  function queueTranslate(text, isFinal) {
    const from = settings.src;
    const to = settings.dst;

    clearTimeout(translateTimer);
    translateTimer = setTimeout(async () => {
      if (!text.trim()) return;
      const token = ++state.token;
      // 已经有译文就先压暗，等新的回来再换
      if (!el.trans.textContent.trim() || el.trans.classList.contains('placeholder')) {
        setTrans('…', { pending: true });
      } else {
        el.trans.classList.add('pending');
      }
      const t0 = performance.now();
      try {
        const { text: out, engine } = await translate(text, from, to);
        if (token !== state.token) return; // 已经有更新的一句
        setTrans(out);
        const ms = Math.round(performance.now() - t0);
        setStatus(`${engine === 'none' ? '同语' : '已译'} ${ms}ms`);
        if (isFinal) {
          pushHistory(text, out, from, to);
          speak(out, to);
        }
      } catch (err) {
        if (token !== state.token) return;
        setTrans('翻译失败，换个引擎试试', { placeholder: true });
        setStatus('翻译失败');
        toast(`翻译失败：${err.message || err}`, 4200);
      }
    }, isFinal ? 260 : 520);
  }

  function newRecognizer() {
    const rec = new SR();
    rec.lang = settings.src;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => setStatus('正在听…', true);

    rec.onresult = (event) => {
      state.lastVoice = Date.now();
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const r = event.results[i];
        const t = r[0]?.transcript || '';
        if (r.isFinal) state.buffer = `${state.buffer} ${t}`.trim();
        else interim += t;
      }
      const live = `${state.buffer} ${interim}`.trim();
      if (!live) return;
      setOrig(live);
      queueTranslate(live, interim === '');
    };

    rec.onerror = (event) => {
      const code = event.error;
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        stopListening({ silent: true });
        setStatus('麦克风被拒');
        toast('麦克风被拒绝了。到「设置 → Safari → 麦克风」里允许，或确认页面是 HTTPS。', 5200);
        return;
      }
      if (code === 'network') {
        toast('语音识别需要联网，网络好像不通。', 4000);
        return;
      }
      console.warn('[speech] error', code);
    };

    rec.onend = () => {
      // iOS 每次停顿都会自己结束，只要还在听就重启
      if (!state.listening) return;
      clearTimeout(state.restartTimer);
      state.restartTimer = setTimeout(() => {
        if (!state.listening) return;
        try {
          rec.start();
        } catch {
          setTimeout(() => {
            if (state.listening) { try { rec.start(); } catch { /* 放弃 */ } }
          }, 500);
        }
      }, 220);
    };

    return rec;
  }

  function startListening() {
    if (!SR) {
      toast('这个浏览器没有语音识别（需要 Safari 14.1+）。先用 ⌨️ 打字吧。', 4600);
      return;
    }
    if (!window.isSecureContext) {
      toast('麦克风只在 HTTPS 页面可用（当前不是）。换 https 地址打开，或先用 ⌨️ 打字。', 5200);
      return;
    }

    stopListening({ silent: true });

    state.listening = true;
    state.buffer = '';
    state.lastVoice = Date.now();
    state.token += 1;

    setOrig('');
    if (el.trans.classList.contains('placeholder')) setTrans('…', { pending: true });
    else el.trans.classList.add('pending');
    uiListening(true);
    keepAwake();

    try {
      state.rec = newRecognizer();
      state.rec.start();
    } catch (err) {
      console.warn(err);
      stopListening({ silent: true });
      setStatus('麦克风没起来');
      toast(`启动识别失败：${err?.message || err}。检查麦克风权限后重试，或先用 ⌨️ 打字。`, 5600);
      return;
    }

    clearInterval(state.idleTimer);
    state.idleTimer = setInterval(() => {
      if (!state.listening) return;
      if (Date.now() - state.lastVoice > IDLE_STOP_MS) {
        stopListening();
        toast('好一会儿没声音了，已自动停止。');
      }
    }, 1000);
  }

  function stopListening({ silent = false } = {}) {
    const wasListening = state.listening;
    state.listening = false;
    clearTimeout(state.restartTimer);
    clearInterval(state.idleTimer);
    if (state.rec) {
      try { state.rec.onend = null; state.rec.stop(); } catch { /* noop */ }
      try { state.rec.abort?.(); } catch { /* noop */ }
      state.rec = null;
    }
    uiListening(false);
    releaseAwake();

    if (!silent && wasListening) {
      const text = state.buffer.trim();
      if (text) {
        queueTranslate(text, true);
        setOrig(text);
      } else if (el.trans.classList.contains('pending')) {
        setTrans('没听清，再说一次？', { placeholder: true });
      }
    }
  }

  function toggleTalk() {
    if (state.listening) stopListening();
    else startListening();
  }

  /* ---------------- 历史 ---------------- */
  function pushHistory(orig, trans, from, to) {
    if (!orig || !trans) return;
    const last = history[history.length - 1];
    if (last && last.orig === orig) return; // 去重
    history.push({ orig, trans, from, to, ts: Date.now() });
    if (history.length > 200) history = history.slice(-200);
    persist();
    renderHistory();
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

  function renderHistory() {
    const list = $('#historyList');
    if (!history.length) {
      list.innerHTML = '<div class="empty">还没有记录</div>';
      return;
    }
    list.innerHTML = history
      .slice(-60)
      .reverse()
      .map((h) => `
        <div class="hitem">
          <div class="meta"><span>${fmtTime(h.ts)}</span>
            <span>${langOf(h.from).label} → ${langOf(h.to).label}</span></div>
          <div class="o">${escapeHtml(h.orig)}</div>
          <div class="t">${escapeHtml(h.trans)}</div>
        </div>`)
      .join('');
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
  function closeSheet(id) { $(`#${id}`).hidden = true; }

  $$('.sheet').forEach((sheet) => {
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
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
        stopListening({ silent: true });
      });
    });
    openSheet('langSheet');
  }

  /* ---------------- 设置面板 ---------------- */
  function syncSettingsUI() {
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
    });
    $('#tts').addEventListener('change', (e) => { settings.tts = e.target.checked; persist(); });
    $('#engine').addEventListener('change', (e) => {
      settings.engine = e.target.value;
      $('#customBox').hidden = settings.engine !== 'custom';
      persist();
    });
    ['apiBase', 'apiModel', 'apiKey', 'mmEmail'].forEach((id) => {
      const elx = $('#' + id);
      elx.addEventListener('change', () => {
        settings[id] = elx.value.trim();
        persist();
      });
    });
  }

  function capabilityText() {
    const bits = [];
    bits.push(SR ? '语音识别：可用' : '语音识别：不可用');
    bits.push(window.isSecureContext ? '安全上下文：是' : '安全上下文：否（麦克风会被拦）');
    bits.push(navigator.onLine ? '网络：在线' : '网络：离线');
    if (health.lastOk) bits.push(`上次翻译走：${health.lastOk}`);
    return bits.join(' · ');
  }

  /* ---------------- 打字输入 ---------------- */
  function openType() {
    $('#typeInput').value = '';
    openSheet('typeSheet');
    setTimeout(() => $('#typeInput').focus(), 220);
  }

  async function sendTyped() {
    const text = $('#typeInput').value.trim();
    if (!text) return;
    closeSheet('typeSheet');
    setOrig(text);
    setTrans('…', { pending: true });
    try {
      const { text: out } = await translate(text, settings.src, settings.dst);
      setTrans(out);
      setStatus('已译');
      pushHistory(text, out, settings.src, settings.dst);
      speak(out, settings.dst);
    } catch (err) {
      setTrans('翻译失败', { placeholder: true });
      toast(`翻译失败：${err.message || err}`);
    }
  }

  /* ---------------- 事件 ---------------- */
  function wire() {
    el.talk.addEventListener('click', toggleTalk);
    $('#srcBtn').addEventListener('click', () => openLangPicker('src'));
    $('#dstBtn').addEventListener('click', () => openLangPicker('dst'));
    $('#openType').addEventListener('click', openType);

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
      if (document.hidden) stopListening({ silent: true });
    });
    window.addEventListener('pagehide', () => stopListening({ silent: true }));
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    if (!window.isSecureContext) $('#insecure').hidden = false;

    document.documentElement.style.setProperty('--trans-size', settings.fontSize + 'px');
    if (!settings.showOrig) el.orig.style.display = 'none';

    renderLangs();
    wire();
    wireSettings();
    renderHistory();

    setTrans(placeholderText(), { placeholder: true });
    setStatus('待机');

    // 开机探一次 Google：国内基本连不上，先把断路器打开，别让第一句干等超时
    if (navigator.onLine) {
      (async () => {
        try {
          await withTimeout(googleTranslate('hello', 'en-US', 'zh-CN'), 3000, 'google');
          health.lastOk = 'google';
        } catch {
          health.googleFails = 2;
          health.googleSkipUntil = Date.now() + 5 * 60 * 1000;
          health.lastOk = 'mymemory';
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
