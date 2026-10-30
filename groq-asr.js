/* Groq ASR：本机采样、短段 WAV、顺序识别；Key 只发往固定的 Groq 接口。 */
(() => {
  'use strict';
  const RATE = 16000;
  const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

  function wav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    // 温和提升偏小的人声，放大幅度有上限，并避免削顶。
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const gain = peak > 0 ? Math.min(8, 0.85 / peak) : 1;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i] * gain));
      view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  class GroqASR {
    constructor({ onState = () => {}, onLevel = () => {}, onText = () => {}, onError = () => {} } = {}) {
      Object.assign(this, { onState, onLevel, onText, onError });
      this.generation = 0;
      this.running = this.waiting = this.finishing = false;
      this.stream = this.context = this.source = this.capture = this.gain = null;
      this.active = null;
      this.queue = [];
      this.requests = [];
      this.timer = this.idleTimer = this.flushTimer = 0;
      this.captureDone = true;
      this.resetSamples();
    }

    resetSamples() {
      this.samples = [];
      this.maxRms = this.speechSamples = this.silenceSamples = 0;
      this.phase = this.sampleSum = this.sampleCount = 0;
    }

    releaseAudio() {
      clearInterval(this.idleTimer);
      clearTimeout(this.flushTimer);
      this.idleTimer = this.flushTimer = 0;
      if (this.capture?.port) this.capture.port.onmessage = null;
      if (this.capture) this.capture.onaudioprocess = this.capture.onprocessorerror = null;
      for (const node of [this.source, this.capture, this.gain]) { try { node?.disconnect(); } catch { /* 已断开 */ } }
      if (this.stream) for (const track of this.stream.getTracks()) { track.onended = null; track.stop(); }
      const context = this.context;
      this.stream = this.context = this.source = this.capture = this.gain = null;
      if (context) context.close().catch(() => {});
    }

    cancel() {
      this.generation += 1;
      this.running = this.waiting = this.finishing = false;
      this.captureDone = true;
      clearTimeout(this.timer);
      this.timer = 0;
      this.active?.controller.abort();
      this.active = null;
      this.queue = [];
      this.releaseAudio();
      this.resetSamples();
      this.key = this.prompt = '';
    }

    fail(message) {
      this.cancel();
      this.onError(new Error(message));
    }

    async start({ key, model = 'whisper-large-v3', language = 'en' }) {
      this.cancel();
      const generation = this.generation;
      if (!key?.trim()) { this.onError(new Error('请先在设置中填写 Groq API Key。')); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !navigator.mediaDevices?.getUserMedia) { this.onError(new Error('当前浏览器无法录音，请用 Safari 打开。')); return; }
      this.key = key.trim();
      this.model = model === 'whisper-large-v3-turbo' ? model : 'whisper-large-v3';
      this.language = language.split('-')[0];
      this.prompt = '';
      this.waiting = true;
      this.captureDone = false;
      this.onState('requesting', '请允许麦克风，音频将直接发送到 Groq 识别。');
      try {
        // 在点击手势中创建和恢复，兼容 iPhone 的音频启动要求。
        const context = new AC();
        this.context = context;
        const resumed = context.resume().catch(() => {});
        const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
        const audio = { channelCount: 1 };
        for (const name of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) if (supported[name]) audio[name] = true;
        const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        await resumed;
        if (generation !== this.generation) return;
        this.source = context.createMediaStreamSource(stream);
        this.gain = context.createGain();
        this.gain.gain.value = 0;
        if (context.audioWorklet && typeof AudioWorkletNode === 'function') {
          await context.audioWorklet.addModule('pcm-capture.js?v=10');
          if (generation !== this.generation) return;
          this.capture = new AudioWorkletNode(context, 'livesubs-capture', { channelCount: 1, channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          this.capture.onprocessorerror = () => { if (generation === this.generation) this.fail('音频采样中断，已停止收音，请重新点说话。'); };
          this.capture.port.onmessage = event => {
            if (generation !== this.generation) return;
            if (event.data.samples) this.ingest(event.data.samples, context.sampleRate);
            if (event.data.flushed && this.finishing) this.finishCapture();
          };
        } else {
          this.capture = context.createScriptProcessor(2048, 1, 1);
          this.capture.onaudioprocess = event => {
            if (generation === this.generation) this.ingest(event.inputBuffer.getChannelData(0), context.sampleRate);
            event.outputBuffer.getChannelData(0).fill(0);
          };
        }
        this.source.connect(this.capture); this.capture.connect(this.gain); this.gain.connect(context.destination);
        stream.getAudioTracks().forEach(track => { track.onended = () => this.stop(); });
        this.running = true;
        this.waiting = false;
        this.lastVoice = performance.now();
        this.onState('listening', 'Groq 正在收音，停顿时尽快识别；连续讲话约每 8 秒处理一次。');
        this.idleTimer = setInterval(() => {
          if (this.running && performance.now() - this.lastVoice > 30000) this.stop();
        }, 1000);
      } catch (error) {
        if (generation !== this.generation) return;
        const messages = {
          NotAllowedError: '麦克风未获允许。请在 Safari 中允许本站使用麦克风。',
          NotFoundError: '没有找到麦克风，请检查耳机和音频输入。',
          NotReadableError: '麦克风被占用，请关闭其他录音后重试。',
        };
        this.fail(messages[error.name] || '无法启动 Groq 收音，请重新打开 Safari 后重试。');
      }
    }

    ingest(input, inputRate) {
      if (!this.running && !this.finishing) return;
      const block = [];
      for (const value of input) {
        this.phase += RATE; this.sampleSum += value; this.sampleCount += 1;
        if (this.phase >= inputRate) {
          block.push(this.sampleSum / this.sampleCount);
          this.phase -= inputRate; this.sampleSum = this.sampleCount = 0;
        }
      }
      if (!block.length) return;
      const rms = Math.sqrt(block.reduce((sum, value) => sum + value * value, 0) / block.length);
      this.onLevel(Math.max(0, Math.min(100, (20 * Math.log10(Math.max(rms, 0.00001)) + 70) / 70 * 100)));
      this.maxRms = Math.max(this.maxRms, rms);
      if (rms >= 0.0005) { this.silenceSamples = 0; this.speechSamples += block.length; this.lastVoice = performance.now(); }
      else this.silenceSamples += block.length;
      // 保留弱人声；仅连续的接近数字静音片段不上传。保留少量前导，避免吞掉开头。
      this.samples.push(...block);
      if (this.maxRms < 0.0005 && this.samples.length > RATE) this.samples = this.samples.slice(-Math.round(RATE * 0.25));
      const paused = this.speechSamples >= RATE * 0.25 && this.silenceSamples >= RATE * 0.65;
      if (!this.finishing && ((paused && this.samples.length >= RATE * 1.2) || this.samples.length >= RATE * 8)) this.flushChunk();
    }

    flushChunk() {
      const samples = this.samples;
      const audible = this.maxRms >= 0.0005;
      this.samples = [];
      this.maxRms = this.speechSamples = this.silenceSamples = 0;
      if (!audible || samples.length < RATE * 0.25) return;
      if (this.queue.length >= 8) { this.fail('识别连接过慢，已停止收音以免积压。请换网络后重试。'); return; }
      this.queue.push({ audio: wav(samples), duration: samples.length / RATE });
      this.pump();
    }

    stop() {
      if (this.waiting) { this.cancel(); this.onState('stopped', '已取消收音。'); return; }
      if (!this.running || this.finishing) return;
      this.running = false;
      this.finishing = true;
      clearInterval(this.idleTimer);
      this.onState('finishing', '正在识别最后一段…');
      if (this.capture?.port) {
        this.capture.port.postMessage('flush');
        this.flushTimer = setTimeout(() => this.finishCapture(), 250);
      } else this.finishCapture();
    }

    finishCapture() {
      if (!this.finishing || this.captureDone) return;
      this.captureDone = true;
      this.releaseAudio();
      this.flushChunk();
      this.pump();
    }

    pump() {
      if (this.active || this.timer) return;
      if (!this.queue.length) {
        if (this.finishing && this.captureDone) { this.finishing = false; this.key = ''; this.onState('stopped', '已停止收音。'); }
        return;
      }
      // 对同一页面的请求采用滚动窗口限速，保留跨会话记录，短句不会突发挤爆免费档。
      const now = performance.now();
      this.requests = this.requests.filter(at => now - at < 60000);
      const delay = Math.max(0, (this.requests.at(-1) ?? -Infinity) + 3100 - now, this.requests.length >= 20 ? this.requests[0] + 60050 - now : 0);
      if (delay > 0) {
        const generation = this.generation;
        this.timer = setTimeout(() => { this.timer = 0; if (generation === this.generation) this.pump(); }, delay);
        return;
      }
      const task = this.queue.shift(), controller = new AbortController(), generation = this.generation;
      const active = { task, controller };
      this.active = active;
      this.requests.push(now);
      this.onState('recognizing', this.finishing ? '正在识别最后一段…' : 'Groq 正在识别，麦克风继续收音…');
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
      const form = new FormData();
      form.append('file', task.audio, 'speech.wav');
      form.append('model', this.model);
      form.append('language', this.language);
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');
      if (this.prompt) form.append('prompt', this.prompt);
      fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${this.key}` }, body: form, signal: controller.signal, credentials: 'omit' })
        .then(async response => {
          if (!response.ok) {
            const messages = { 401: 'Groq Key 无效，请在设置中检查或重新创建。', 403: 'Groq 拒绝了访问，请检查账户、模型权限和当前网络。', 429: 'Groq 请求或免费额度已达上限，已停止收音，请稍后再试。' };
            throw new Error(messages[response.status] || `Groq 识别失败（${response.status}），已停止收音。`);
          }
          const data = await response.json();
          if (generation !== this.generation || this.active !== active) return;
          if (typeof data.text !== 'string') throw new Error('Groq 返回格式异常，请稍后重试。');
          const segments = Array.isArray(data.segments) ? data.segments : [];
          const text = segments.length ? segments.filter(segment => !(segment.no_speech_prob > 0.85 && segment.avg_logprob < -1)).map(segment => segment.text || '').join('').trim() : data.text.trim();
          if (text) {
            this.prompt = text.slice(-400);
            this.onText(text);
          } else this.onState('empty', '这段没有识别到文字，仍在收音；可靠近声源再试。');
        })
        .catch(error => {
          if (generation !== this.generation || this.active !== active) return;
          this.fail(timedOut ? 'Groq 识别超时，已停止收音。请检查网络后重试。' : error.name === 'TypeError' ? '无法连接 Groq，已停止收音。请检查网络后重试。' : error.message);
        })
        .finally(() => {
          clearTimeout(timeout);
          if (generation !== this.generation || this.active !== active) return;
          this.active = null;
          this.pump();
        });
    }
  }

  GroqASR.wav = wav;
  window.LivesubsGroqASR = GroqASR;
})();
