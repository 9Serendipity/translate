/* AudioWorklet：分批传回单声道采样，音频输出保持静音。 */
class LivesubsCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.length = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        this.send();
        this.port.postMessage({ flushed: true });
      }
    };
  }

  send() {
    if (!this.length) return;
    const samples = this.buffer.slice(0, this.length);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.length = 0;
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) {
        this.buffer[this.length++] = sample;
        if (this.length === this.buffer.length) this.send();
      }
    }
    return true;
  }
}
registerProcessor('livesubs-capture', LivesubsCapture);
