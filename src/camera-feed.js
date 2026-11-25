// Local webcam capture. The renderer uploads only new frames; no video leaves the browser.
export class CameraFeed {
  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.stream = null;
    this.state = 'idle';
    this.error = null;
    this.fresh = true;
    this.frames = 0;
    this.fps = 0;
    this.generation = 0;
    this.callbackId = null;
    this.lastVideoTime = -1;
    this.fallback = makeFallbackCanvas();
    this.onstate = () => {};
  }

  get active() { return this.state === 'live'; }
  get source() { return this.active ? this.video : this.fallback; }
  get width() { return this.active ? this.video.videoWidth : this.fallback.width; }
  get height() { return this.active ? this.video.videoHeight : this.fallback.height; }

  #setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.fresh = true;
    this.onstate();
  }

  async start() {
    if (this.active || this.state === 'starting') return;
    const generation = ++this.generation;
    this.#setState('starting');
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('The camera requires HTTPS or localhost and a compatible browser.');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => {
        if (this.stream === stream) this.stop();
      });
      await this.video.play();
      if (generation !== this.generation) return;
      if (!this.video.videoWidth || !this.video.videoHeight) throw new Error('The camera did not deliver a valid frame.');
      this.frames = 0;
      this.fps = track?.getSettings?.().frameRate || 0;
      this.lastVideoTime = -1;
      this.#setState('live');
      if (typeof this.video.requestVideoFrameCallback === 'function') {
        const tick = () => {
          if (!this.active || generation !== this.generation) return;
          this.fresh = true;
          this.frames++;
          this.callbackId = this.video.requestVideoFrameCallback(tick);
        };
        this.callbackId = this.video.requestVideoFrameCallback(tick);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.#release();
      this.#setState('error', error);
    }
  }

  #release() {
    if (this.callbackId !== null) this.video.cancelVideoFrameCallback?.(this.callbackId);
    this.callbackId = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.fps = 0;
  }

  stop() {
    ++this.generation;
    this.#release();
    this.#setState('idle');
  }

  consumeFresh() {
    if (this.active && this.video.readyState < 2) return false;
    if (this.active && typeof this.video.requestVideoFrameCallback !== 'function' && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      this.frames++;
      this.fresh = true;
    }
    const fresh = this.fresh;
    this.fresh = false;
    return fresh;
  }
}

// A virtual photo studio while the webcam is off. It uses the same HDR render target.
function makeFallbackCanvas() {
  const c = document.createElement('canvas');
  c.width = 960; c.height = 540;
  const g = c.getContext('2d');
  const gradient = g.createLinearGradient(0, 0, 0, c.height);
  gradient.addColorStop(0, '#303940');
  gradient.addColorStop(0.63, '#171c21');
  gradient.addColorStop(1, '#473125');
  g.fillStyle = gradient;
  g.fillRect(0, 0, c.width, c.height);
  const windowGlow = g.createLinearGradient(100, 75, 360, 310);
  windowGlow.addColorStop(0, '#eff7ff');
  windowGlow.addColorStop(1, '#6c8faa');
  g.fillStyle = windowGlow;
  g.fillRect(92, 70, 260, 240);
  g.fillStyle = '#25303a';
  g.fillRect(215, 70, 12, 240);
  g.fillRect(92, 183, 260, 12);
  const lamp = g.createRadialGradient(760, 162, 3, 760, 162, 145);
  lamp.addColorStop(0, '#fff4d9');
  lamp.addColorStop(0.16, '#edba79');
  lamp.addColorStop(1, 'rgba(255,192,100,0)');
  g.fillStyle = lamp;
  g.fillRect(610, 10, 300, 300);
  g.fillStyle = '#ad8153';
  g.fillRect(757, 178, 5, 210);
  g.fillRect(705, 387, 108, 8);
  return c;
}
