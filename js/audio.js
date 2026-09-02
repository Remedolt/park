class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.engineGain = null;
    this.started = false;
    this.muted = false;
    this._loopId = 0;
    this._sensorNext = 0;
    this._skidAmt = 0;
  }

  async start() {
    if (this.started) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(this.ctx.destination);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.22;
    this.musicGain.connect(this.master);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.7;
    this.sfxGain.connect(this.master);

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.master);

    this._noise = this._makeNoise(2);
    this._setupEngine();
    this._setupSkid();
    this._setupAmbient();
    this._startMusic();
    this.started = true;
  }

  _makeNoise(seconds) {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  _noiseSrc(loop = true) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = loop;
    return src;
  }

  _setupEngine() {
    const ctx = this.ctx;
    this.engOsc = ctx.createOscillator();
    this.engOsc.type = "sawtooth";
    this.engOsc.frequency.value = 48;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = "lowpass";
    this.engFilter.frequency.value = 280;
    this.engFilter.Q.value = 4;
    this.engOsc.connect(this.engFilter);
    this.engFilter.connect(this.engineGain);

    this.exhSrc = this._noiseSrc();
    this.exhFilter = ctx.createBiquadFilter();
    this.exhFilter.type = "bandpass";
    this.exhFilter.frequency.value = 180;
    this.exhFilter.Q.value = 1.2;
    this.exhGain = ctx.createGain();
    this.exhGain.gain.value = 0.18;
    this.exhSrc.connect(this.exhFilter);
    this.exhFilter.connect(this.exhGain);
    this.exhGain.connect(this.engineGain);

    this.engOsc.start();
    this.exhSrc.start();
  }

  _setupSkid() {
    this.skidSrc = this._noiseSrc();
    this.skidFilter = this.ctx.createBiquadFilter();
    this.skidFilter.type = "bandpass";
    this.skidFilter.frequency.value = 1400;
    this.skidFilter.Q.value = 0.8;
    this.skidGain = this.ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidSrc.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.sfxGain);
    this.skidSrc.start();
  }

  _setupAmbient() {
    const pad = this.ctx.createOscillator();
    pad.type = "sine";
    pad.frequency.value = 110;
    const pad2 = this.ctx.createOscillator();
    pad2.type = "sine";
    pad2.frequency.value = 164.8;
    const g = this.ctx.createGain();
    g.gain.value = 0.03;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 600;
    pad.connect(f);
    pad2.connect(f);
    f.connect(g);
    g.connect(this.musicGain);
    pad.start();
    pad2.start();

    const wind = this._noiseSrc();
    const wf = this.ctx.createBiquadFilter();
    wf.type = "lowpass";
    wf.frequency.value = 380;
    const wg = this.ctx.createGain();
    wg.gain.value = 0.035;
    wind.connect(wf);
    wf.connect(wg);
    wg.connect(this.sfxGain);
    wind.start();
  }

  _tone(freq, type, t, dur, vol, dest) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest || this.musicGain);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _startMusic() {
    const ctx = this.ctx;
    const bpm = 78;
    const beat = 60 / bpm;
    const bar = beat * 4;
    const loop = bar * 4;
    const bass = [55, 65.4, 49, 73.4];
    const chords = [
      [220, 261.6, 329.6],
      [174.6, 220, 261.6],
      [196, 246.9, 293.7],
      [164.8, 196, 246.9],
    ];
    const melody = [440, 0, 523.25, 440, 392, 0, 349.23, 392];

    const schedule = (when) => {
      for (let b = 0; b < 4; b++) {
        const t0 = when + b * bar;
        this._tone(bass[b], "triangle", t0, bar * 0.9, 0.12);
        for (const n of chords[b]) this._tone(n / 2, "sine", t0, bar * 0.85, 0.035);
        for (let i = 0; i < 4; i++) {
          const ht = t0 + i * beat;
          const src = this._noiseSrc(false);
          const f = ctx.createBiquadFilter();
          f.type = "highpass";
          f.frequency.value = 7000;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.04, ht);
          g.gain.exponentialRampToValueAtTime(0.0001, ht + 0.06);
          src.connect(f);
          f.connect(g);
          g.connect(this.musicGain);
          src.start(ht);
          src.stop(ht + 0.08);
        }
        const m = melody[b * 2];
        const m2 = melody[b * 2 + 1];
        if (m) this._tone(m, "triangle", t0 + beat * 0.5, beat * 0.7, 0.05);
        if (m2) this._tone(m2, "triangle", t0 + beat * 2.5, beat * 0.6, 0.045);
      }
    };

    const first = ctx.currentTime + 0.05;
    schedule(first);
    this._loopId = setInterval(() => {
      if (!this.started) return;
      schedule(this.ctx.currentTime + 0.08);
    }, loop * 1000);
  }

  setEngine(speed, throttle, braking, inReverse) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const rpm = 42 + Math.abs(speed) * 7.5 + throttle * 38 + (braking ? 4 : 0);
    this.engOsc.frequency.setTargetAtTime(rpm, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(220 + throttle * 900 + Math.abs(speed) * 18, t, 0.08);
    const vol = 0.035 + throttle * 0.09 + Math.min(0.06, Math.abs(speed) * 0.004);
    this.engineGain.gain.setTargetAtTime(this.muted ? 0 : vol, t, 0.04);
    this.exhFilter.frequency.setTargetAtTime(inReverse ? 140 : 190 + throttle * 80, t, 0.1);
  }

  setSkid(amount) {
    if (!this.started) return;
    this._skidAmt = amount;
    const t = this.ctx.currentTime;
    this.skidGain.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.22, amount * 0.28), t, 0.04);
    this.skidFilter.frequency.setTargetAtTime(900 + amount * 1600, t, 0.05);
  }

  crash() {
    if (!this.started || this.muted) return;
    const t = this.ctx.currentTime;
    this._tone(70, "sine", t, 0.28, 0.45, this.sfxGain);
    this._tone(38, "triangle", t, 0.4, 0.35, this.sfxGain);
    const src = this._noiseSrc(false);
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.25);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
    src.stop(t + 0.4);
  }

  success() {
    if (!this.started || this.muted) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this._tone(f, "triangle", t + i * 0.09, 0.35, 0.16, this.sfxGain);
    });
  }

  fail() {
    if (!this.started || this.muted) return;
    const t = this.ctx.currentTime;
    this._tone(196, "sawtooth", t, 0.35, 0.12, this.sfxGain);
    this._tone(147, "sawtooth", t + 0.18, 0.5, 0.12, this.sfxGain);
  }

  horn() {
    if (!this.started || this.muted) return;
    const t = this.ctx.currentTime;
    this._tone(370, "square", t, 0.28, 0.08, this.sfxGain);
    this._tone(311, "square", t, 0.28, 0.07, this.sfxGain);
  }

  sensor(dist) {
    if (!this.started || this.muted || dist > 90) return;
    const t = this.ctx.currentTime;
    if (t < this._sensorNext) return;
    const interval = 0.12 + Math.max(0, dist) / 180;
    this._sensorNext = t + interval;
    this._tone(980, "sine", t, 0.04, 0.06, this.sfxGain);
  }

  idleQuiet(on) {
    if (!this.started) return;
    this.musicGain.gain.setTargetAtTime(on ? 0.1 : 0.22, this.ctx.currentTime, 0.4);
  }
}

window.AudioEngine = AudioEngine;
