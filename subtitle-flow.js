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
      this.segments = [];
      this.previewResults = new Map();
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
      const previous = this.draft;
      this.draft = clean;
      clearTimeout(this.stableTimer);
      if (!clean) {
        this.onDraft('');
        this.clearTimers();
        this.preview = null;
        this.previewed = '';
        this.segments = [];
        this.queue = this.queue.filter(task => !task.preview);
        this.epoch += 1;
        if (this.active?.preview) this.active.controller.abort();
        return;
      }
      const segments = this.earlySegments(clean, previous);
      let common = 0;
      while (common < segments.length && this.segments[common]?.text === segments[common].text) common += 1;
      this.segments = segments;
      this.queue = this.queue.filter(task => !task.segment || (task.epoch === this.epoch && segments[task.index]?.text === task.text));
      if (this.active?.segment && segments[this.active.index]?.text !== this.active.text) this.active.controller.abort();
      if (common < segments.length) {
        this.preview = null;
        this.previewed = '';
        if (this.active?.preview && !this.active.segment) this.active.controller.abort();
        for (let index = common; index < segments.length; index += 1) {
          this.queue.push({ text: segments[index].text, preview: true, segment: true, index, epoch: this.epoch, ...this.languages() });
        }
        this.pump();
      }
      this.onDraft(this.tail());
      if (!this.tail()) { this.clearTimers(); return; }
      this.stableTimer = setTimeout(() => this.flushPreview(), 300);
      // 连续讲话不必等整体停顿，最多等待 1.2 秒先给短段预览。
      if (!this.maxTimer) this.maxTimer = setTimeout(() => this.flushPreview(), 1200);
    }

    tail() { return this.draft.slice(this.segments.at(-1)?.end || 0).trim(); }

    earlySegments(text, previous) {
      const segments = [];
      let start = 0;
      const closers = /["'”’）)\]}】》]/;
      for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (!'。！？!?'.includes(ch) && ch !== '.') continue;
        if (ch === '.') {
          if (text[index + 1] === '.' || (/[0-9]/.test(text[index - 1] || '') && /[0-9]/.test(text[index + 1] || ''))) continue;
          if (text[index + 1] && !/\s/.test(text[index + 1]) && !closers.test(text[index + 1])) continue;
          const token = text.slice(start, index + 1).match(/([A-Za-z.]+)\.$/)?.[1] || '';
          if (/^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|u\.s|u\.k)$/i.test(token) || /^[A-Za-z]$/.test(token)) continue;
        }
        let end = index + 1;
        while (end < text.length && (closers.test(text[end]) || '。！？!?'.includes(text[end]))) end += 1;
        while (/\s/.test(text[end] || '') && end < text.length) end += 1;
        const sentence = text.slice(start, end).trim();
        if (sentence) segments.push({ text: sentence, end });
        start = end;
        index = end - 1;
      }
      let stable = 0;
      while (stable < previous.length && stable < text.length && previous[stable] === text[stable]) stable += 1;
      // 没有标点时，只提前取两次识别都稳定的前缀，并给后面留出少量余量。
      while (start < stable) {
        const tail = text.slice(start);
        let length = 0;
        if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(tail)) {
          const characters = Array.from(tail);
          if (characters.length < 38) break;
          let prefix = characters.slice(0, 32).join('');
          const pause = Math.max(prefix.lastIndexOf('，'), prefix.lastIndexOf('；'), prefix.lastIndexOf('、'));
          if (pause >= 18) prefix = prefix.slice(0, pause + 1);
          length = prefix.length;
        } else {
          const words = [...tail.matchAll(/\S+\s*/g)];
          if (words.length < 12) break;
          length = words[9].index + words[9][0].length;
        }
        const end = start + length;
        if (end > stable) break;
        segments.push({ text: text.slice(start, end).trim(), end });
        start = end;
      }
      return segments;
    }

    resultKey(text, from, to) { return JSON.stringify([text, from, to]); }

    flushPreview(immediate = false) {
      this.clearTimers();
      const tail = this.tail();
      if (!tail || tail === this.previewed) return;
      const remaining = 1800 - (performance.now() - this.lastPreviewAt);
      if (!immediate && remaining > 0) {
        this.maxTimer = setTimeout(() => this.flushPreview(), remaining);
        return;
      }
      this.previewed = tail;
      this.preview = { text: tail, preview: true, epoch: this.epoch, ...this.languages() };
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
      const clean = text.trim();
      const ready = this.earlySegments(clean, clean);
      const end = ready.at(-1)?.end || 0;
      const parts = [...ready.map(part => part.text), ...this.sentences(clean.slice(end))];
      if (!parts.length) return;
      const languages = this.languages();
      const promoted = this.active?.preview && parts.length === 1 && this.active.text === parts[0]
        && this.active.from === languages.from && this.active.to === languages.to;
      if (promoted) { this.active.preview = false; this.active.segment = false; }
      this.setDraft('');
      this.clearTimers();
      this.preview = null;
      this.epoch += 1;
      this.lastPreviewAt = -Infinity;
      if (this.active?.preview) this.active.controller.abort();
      this.queue = this.queue.filter(task => !task.preview);
      for (const part of parts) {
        if (promoted) break;
        const key = this.resultKey(part, languages.from, languages.to);
        const cached = this.previewResults.get(key);
        this.previewResults.delete(key);
        this.queue.push({ text: part, preview: false, cached, render: !cached, ...languages });
      }
      this.pump();
    }

    finish() {
      if (this.draft) this.commit(this.draft);
      else this.clearTimers();
    }

    hold() {
      this.clearTimers();
      this.preview = null;
      this.queue = this.queue.filter(task => !task.preview);
      if (this.active?.preview) this.active.controller.abort();
    }

    reset() {
      this.generation += 1;
      this.epoch += 1;
      this.clearTimers();
      this.queue = [];
      this.preview = null;
      this.draft = this.previewed = '';
      this.segments = [];
      this.previewResults.clear();
      this.lastPreviewAt = -Infinity;
      this.active?.controller.abort();
      this.active = null;
      this.onDraft('');
    }

    get pending() { return this.queue.length + (this.active ? 1 : 0); }

    async pump() {
      if (this.active) return;
      let task;
      while ((task = this.queue.shift() || this.preview)) {
        if (!task.preview) break;
        if (!task.segment) this.preview = null;
        if (!this.draft || task.epoch !== this.epoch) continue;
        if (task.segment && this.segments[task.index]?.text !== task.text) continue;
        if (!task.segment) {
          task.text = this.tail();
          if (!task.text) continue;
          this.previewed = task.text;
          this.lastPreviewAt = performance.now();
        }
        break;
      }
      if (!task) return;
      task.controller = new AbortController();
      task.generation = this.generation;
      this.active = task;
      if (!task.cached) this.onWorking(task);
      const began = performance.now();
      try {
        const result = task.cached || await this.translate(task.text, task.from, task.to, { signal: task.controller.signal });
        if (task.generation !== this.generation || task.controller.signal.aborted) return;
        if (task.preview && task.epoch !== this.epoch) return;
        if (task.segment && this.segments[task.index]?.text !== task.text) return;
        if (task.preview) {
          if (this.previewResults.size >= 200) this.previewResults.delete(this.previewResults.keys().next().value);
          this.previewResults.set(this.resultKey(task.text, task.from, task.to), result);
        }
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
