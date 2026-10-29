/* 独立录音诊断：只保存内存中的片段，不发送任何音频。 */
(() => {
  'use strict';

  class MicTest {
    constructor({ onState, onLevel, onRecording }) {
      Object.assign(this, { onState, onLevel, onRecording });
      this.generation = 0;
      this.running = false;
      this.waiting = false;
      this.stream = this.context = this.recorder = null;
      this.frame = this.timer = 0;
    }

    releaseAudio() {
      cancelAnimationFrame(this.frame);
      clearTimeout(this.timer);
      this.frame = this.timer = 0;
      if (this.stream) {
        for (const track of this.stream.getTracks()) { track.onended = null; track.stop(); }
      }
      this.stream = null;
      if (this.context) this.context.close().catch(() => {});
      this.context = null;
    }

    cancel() {
      this.generation += 1;
      this.running = this.waiting = false;
      const recorder = this.recorder;
      this.recorder = null;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* 已结束 */ } }
      this.releaseAudio();
    }

    async start(mode = 'voice') {
      this.cancel();
      const generation = this.generation;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
        this.onState('error', '当前浏览器无法录音，请用 Safari 打开。');
        return;
      }
      this.waiting = true;
      this.onState('requesting', '请允许麦克风，然后让远处的声源发声。');
      let context = null;
      try {
        // 在点击手势内建立 AudioContext，兼容 iPhone 的音频启动要求。
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          try { context = new AC(); context.resume().catch(() => {}); } catch { /* 仍可录音 */ }
        }
        this.context = context;
        const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
        const audio = { channelCount: 1 };
        for (const name of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
          if (supported[name]) audio[name] = mode === 'voice';
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        if (generation !== this.generation) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        this.stream = stream;
        this.waiting = false;
        const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(value => MediaRecorder.isTypeSupported?.(value));
        const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        this.recorder = recorder;
        const chunks = [];
        recorder.ondataavailable = event => {
          if (generation === this.generation && event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => {
          if (generation !== this.generation) return;
          this.cancel();
          this.onState('error', '录音中断，请重试。');
        };
        recorder.onstop = () => {
          if (generation !== this.generation) return;
          this.running = false;
          this.recorder = null;
          this.releaseAudio();
          const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/mp4' });
          if (!blob.size) { this.onState('error', '没有生成录音，请重试。'); return; }
          this.onRecording(blob);
          this.onState('ready', '录音已完成。请播放，听远处的人声是否清楚。');
        };
        stream.getAudioTracks().forEach(track => { track.onended = () => this.stop(); });
        let analyser = null, samples = null;
        if (context) {
          try {
            analyser = context.createAnalyser();
            analyser.fftSize = 1024;
            context.createMediaStreamSource(stream).connect(analyser);
            samples = new Float32Array(analyser.fftSize);
          } catch { analyser = null; }
        }
        recorder.start();
        this.running = true;
        const began = performance.now();
        const settings = stream.getAudioTracks()[0]?.getSettings?.() || {};
        this.onState('recording', '录音中，最多 10 秒；可提前点停止。', { settings, metering: !!analyser });
        const update = () => {
          if (generation !== this.generation || !this.running) return;
          let level = null;
          if (analyser) {
            analyser.getFloatTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
            level = Math.max(0, Math.min(100, (20 * Math.log10(Math.max(rms, 0.00001)) + 60) / 60 * 100));
          }
          this.onLevel(level, Math.min(10, (performance.now() - began) / 1000));
          this.frame = requestAnimationFrame(update);
        };
        update();
        this.timer = setTimeout(() => this.stop(), 10000);
      } catch (error) {
        if (generation !== this.generation) return;
        this.cancel();
        const messages = {
          NotAllowedError: '麦克风未获允许。请在 Safari 中允许本站使用麦克风。',
          NotFoundError: '没有找到可用的麦克风，请检查耳机和音频输入。',
          NotReadableError: '麦克风暂时无法使用，请关闭其他录音后重试。',
        };
        this.onState('error', messages[error.name] || '无法启动录音，请用 Safari 重试。');
      }
    }

    stop() {
      if (this.waiting) { this.cancel(); this.onState('idle', '已取消收音测试。'); return; }
      if (!this.running) return;
      this.running = false;
      this.onState('finishing', '正在生成回放…');
      try { this.recorder.stop(); } catch {
        this.cancel();
        this.onState('error', '无法完成录音，请重试。');
      }
      this.releaseAudio();
    }
  }

  window.LivesubsMicTest = MicTest;
})();
