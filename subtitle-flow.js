/* 逐句翻译：完整句子按顺序处理，临时文字限频预览。 */
(() => {
  'use strict';

  class SubtitleFlow {
    constructor({ translate, languages, onDraft, onResult, onError, onWorking }) {
      Object.assign(this, { translate, languages, onDraft, onResult, onError, onWorking });
      this.queue = [];
      this.active = null;
      this.draft = '';
      this.preview = null;
      this.previewed = '';
      this.lastPreviewAt = -Infinity;
      this.epoch = 0;
      this.generation = 0;
      this.stableTimer = 0;
      this.maxTimer = 0;
    }

    clearTimers() {
      clearTimeout(this.stableTimer);
      clearTimeout(this.maxTimer);
      this.stableTimer = this.maxTimer = 0;
    }

    setDraft(text) {
      const clean = text.trim();
      if (clean === this.draft) return;
      this.draft = clean;
      this.onDraft(clean);
      clearTimeout(this.stableTimer);
      if (!clean) {
        this.clearTimers();
        this.preview = null;
        this.previewed = '';
        this.epoch += 1;
        if (this.active?.preview) this.active.controller.abort();
        return;
      }
      this.stableTimer = setTimeout(() => this.flushPreview(), 750);
      // 连续说话也会定期给预览，避免每次更新都把计时器推迟。
      if (!this.maxTimer) this.maxTimer = setTimeout(() => this.flushPreview(), 1800);
    }

    flushPreview() {
      this.clearTimers();
      if (!this.draft || this.draft === this.previewed) return;
      const remaining = 1800 - (performance.now() - this.lastPreviewAt);
      if (remaining > 0) {
        this.maxTimer = setTimeout(() => this.flushPreview(), remaining);
        return;
      }
      this.previewed = this.draft;
      this.preview = { text: this.draft, preview: true, epoch: this.epoch, ...this.languages() };
      this.pump();
    }

    sentences(text) {
      const clean = text.trim();
      if (!clean) return [];
      if (typeof Intl.Segmenter === 'function') {
        try {
          return [...new Intl.Segmenter(this.languages().from, { granularity: 'sentence' }).segment(clean)]
            .map(item => item.segment.trim()).filter(Boolean);
        } catch { /* 不支持的语言使用普通分句 */ }
      }
      const parts = [];
      let buffer = '';
      for (let index = 0; index < clean.length; index += 1) {
        const ch = clean[index];
        buffer += ch;
        if ('。！？!?\n'.includes(ch) || (ch === '.' && (!clean[index + 1] || /\s/.test(clean[index + 1])))) {
          parts.push(buffer.trim()); buffer = '';
        }
      }
      if (buffer.trim()) parts.push(buffer.trim());
      return parts.filter(Boolean);
    }

    commit(text) {
      const parts = this.sentences(text);
      if (!parts.length) return;
      this.setDraft('');
      this.clearTimers();
      this.preview = null;
      this.epoch += 1;
      this.lastPreviewAt = -Infinity;
      if (this.active?.preview) this.active.controller.abort();
      const languages = this.languages();
      for (const part of parts) this.queue.push({ text: part, preview: false, ...languages });
      this.pump();
    }

    finish() {
      if (this.draft) this.commit(this.draft);
      else this.clearTimers();
    }

    hold() {
      this.clearTimers();
      this.preview = null;
      if (this.active?.preview) this.active.controller.abort();
    }

    reset() {
      this.generation += 1;
      this.epoch += 1;
      this.clearTimers();
      this.queue = [];
      this.preview = null;
      this.draft = this.previewed = '';
      this.lastPreviewAt = -Infinity;
      this.active?.controller.abort();
      this.active = null;
      this.onDraft('');
    }

    get pending() { return this.queue.length + (this.active ? 1 : 0); }

    async pump() {
      if (this.active) return;
      const task = this.queue.shift() || this.preview;
      if (!task) return;
      if (task.preview) {
        this.preview = null;
        if (!this.draft || task.epoch !== this.epoch) return;
        task.text = this.draft;
        this.previewed = task.text;
        this.lastPreviewAt = performance.now();
      }
      task.controller = new AbortController();
      task.generation = this.generation;
      this.active = task;
      this.onWorking(task);
      const began = performance.now();
      try {
        const result = await this.translate(task.text, task.from, task.to, { signal: task.controller.signal });
        if (task.generation !== this.generation || task.controller.signal.aborted) return;
        if (task.preview && task.epoch !== this.epoch) return;
        this.onResult({ ...task, result, ms: Math.round(performance.now() - began) });
      } catch (error) {
        if (task.generation !== this.generation || task.controller.signal.aborted || error.name === 'AbortError') return;
        // 临时预览失败仍保留已有字幕，完整句子失败才提示。
        if (!task.preview) this.onError(error, task);
      } finally {
        if (this.active === task) {
          this.active = null;
          this.pump();
        }
      }
    }
  }

  window.LivesubsSubtitleFlow = SubtitleFlow;
})();
