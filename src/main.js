import init, { build_sphere, build_cap, generate_engraving, LightProbe } from './wasm/sphere_core.js';
import { Renderer } from './renderer.js';
import { OrbitControls } from './controls.js';
import { CameraFeed } from './camera-feed.js';
import { perspective, translation, mat4FromQuat } from './math.js';

const $ = (id) => document.getElementById(id);
const loader = $('loader');
const loaderText = $('loader-text');
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const ENG_W = 2048;
const ENG_H = 1024;
const PROBE_W = 64;

// Linear-space F0 of a deep Christmas-red metal; gold for the cap.
const RED_F0 = [0.80, 0.035, 0.045];
const GOLD_F0 = [1.0, 0.76, 0.33];
const KEY_DIR = normalize([0.0, 0.96, 0.28]);

const ui = {
  exposure: $('exposure'), fov: $('fov'), gain: $('gain'), engrave: $('engrave'),
  frost: $('frost'), clearcoat: $('clearcoat'), roughness: $('roughness'), auto: $('auto'),
};

async function main() {
  const canvas = $('gpu');
  const renderer = await Renderer.create(canvas);

  loaderText.textContent = 'Loading Rust/WASM core…';
  renderer.onError = showError;
  const wasm = await init();

  loaderText.textContent = 'Rust: generating geometry and baking snow engravings (2048×1024)…';
  await nextPaint();
  let t0 = performance.now();
  const sphere = build_sphere(256, 160, 1.0);
  const cap = build_cap(160);
  const engraving = generate_engraving(ENG_W, ENG_H, 1225);
  const bakeMs = performance.now() - t0;
  $('s-bake').textContent = `${bakeMs.toFixed(0)} ms`;

  renderer.setEngraving(engraving, ENG_W, ENG_H);
  renderer.addMesh(sphere.vertices, sphere.indices, { color: RED_F0, roughness: 0, kind: 0 });
  renderer.addMesh(cap.vertices, cap.indices, { color: GOLD_F0, roughness: 0.2, kind: 1 });
  sphere.free();
  cap.free();

  const info = renderer.adapter.info || {};
  $('s-gpu').textContent = [info.vendor, info.architecture].filter(Boolean).join(' · ') || 'WebGPU';

  // ── webcam + Rust light probe ──
  const feed = new CameraFeed();
  const camBtn = $('cam-btn');
  const probeCanvas = document.createElement('canvas');
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
  let probe = null;
  const shView = new Float32Array(40);
  let lastProbeAngle = null;
  let rustMs = 0;
  let lastProbeAt = -Infinity;

  const syncCamUi = () => {
    const status = $('camera-status');
    const starting = feed.state === 'starting';
    camBtn.textContent = feed.active ? 'Stop camera' : starting ? 'Cancel' : 'Enable camera';
    camBtn.classList.toggle('on', feed.active);
    camBtn.setAttribute('aria-pressed', String(feed.active));
    status.dataset.state = feed.state;
    if (feed.active) {
      status.textContent = 'Live camera';
      $('s-cam').textContent = `${feed.width}×${feed.height}${feed.fps ? ` · ${Math.round(feed.fps)} Hz` : ''}`;
    } else {
      $('s-cam').textContent = 'Virtual studio';
      status.textContent = starting ? 'Waiting for permission…' : feed.state === 'error'
        ? ({ NotAllowedError: 'Permission denied. Enable the camera to try again.', NotFoundError: 'No camera was found.', NotReadableError: 'Camera is busy or unavailable.' }[feed.error?.name] || feed.error?.message || 'Camera unavailable')
        : 'Virtual studio · camera off';
    }
    status.title = status.textContent;
    probe?.free();
    probe = null;
    shView.fill(0);
    lastProbeAngle = null;
    lastProbeAt = -Infinity;
  };
  renderer.onError = (err) => { feed.stop(); showError(err); };
  feed.onstate = syncCamUi;
  syncCamUi();
  camBtn.addEventListener('click', () => {
    if (feed.active || feed.state === 'starting') feed.stop();
    else feed.start();
  });
  window.addEventListener('pagehide', () => feed.stop());

  function runProbe(thetaMax) {
    if (!probeCtx || !feed.width || !feed.height || (feed.active && feed.video.readyState < 2)) return;
    const w = PROBE_W;
    const h = Math.max(8, Math.round((PROBE_W * feed.height) / Math.max(feed.width, 1)));
    if (!probe || probeCanvas.width !== w || probeCanvas.height !== h) {
      probe?.free();
      probe = new LightProbe(w, h);
      probeCanvas.width = w;
      probeCanvas.height = h;
    }
    probeCtx.drawImage(feed.source, 0, 0, w, h);
    const px = probeCtx.getImageData(0, 0, w, h).data;
    const t = performance.now();
    new Uint8Array(wasm.memory.buffer, probe.pixels_ptr(), px.length).set(px);
    probe.update(thetaMax, 0.18);
    // memory may have grown → always rebuild the view
    shView.set(new Float32Array(wasm.memory.buffer, probe.out_ptr(), 40));
    lastProbeAngle = thetaMax;
    lastProbeAt = performance.now();
    rustMs += (performance.now() - t - rustMs) * 0.1;
  }

  // ── controls & UI ──
  const controls = new OrbitControls(canvas);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    controls.autoRotate = false;
    ui.auto.checked = false;
  }
  const outputs = document.querySelectorAll('output[data-for]');
  const fmt = { fov: (v) => `${v}°` };
  const refreshOutputs = () => outputs.forEach((o) => {
    const v = ui[o.dataset.for].value;
    o.textContent = fmt[o.dataset.for]?.(v) ?? Number(v).toFixed(2);
  });
  Object.values(ui).forEach((el) => el.addEventListener('input', refreshOutputs));
  refreshOutputs();
  ui.auto.addEventListener('change', () => (controls.autoRotate = ui.auto.checked));

  const toggleUi = () => {
    const hidden = document.body.classList.toggle('ui-hidden');
    $('ui-toggle').textContent = hidden ? 'Show interface' : 'Hide interface';
    $('ui-toggle').setAttribute('aria-pressed', String(hidden));
    document.querySelectorAll('.panel').forEach((panel) => { panel.inert = hidden; });
  };
  $('ui-toggle').addEventListener('click', toggleUi);
  $('reset-view').addEventListener('click', () => controls.reset());
  const material = $('material-panel');
  const compact = matchMedia('(max-width: 760px)');
  const syncMaterial = () => { material.open = !compact.matches; };
  compact.addEventListener('change', syncMaterial);
  syncMaterial();
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, button, summary, textarea, select, [contenteditable]')) return;
    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        ui.auto.checked = !ui.auto.checked;
        controls.autoRotate = ui.auto.checked;
        break;
      case 'r': controls.reset(); break;
      case 'c': camBtn.click(); break;
      case 'h': toggleUi(); break;
    }
  });

  // ── frame loop ──
  const model = new Float32Array(16);
  let last = performance.now();
  let fpsAcc = 0, fpsFrames = 0, cpuAvg = 0, uploads = 0;
  const view = translation(0, -0.12, -controls.distance);
  let proj = null, lastAspect = 0;
  const start = last;

  function frame(now) {
    if (renderer.lost) return;
    try { renderFrame(now); } catch (err) { feed.stop(); showError(err); return; }
    requestAnimationFrame(frame);
  }

  function renderFrame(now) {
    const elapsed = (now - last) / 1000;
    const dt = Math.min(elapsed, 0.1);
    last = now;
    const cpu0 = performance.now();

    controls.update(dt);
    const thetaMax = (Number(ui.fov.value) * Math.PI) / 180;

    const fresh = feed.consumeFresh();
    if (fresh && renderer.uploadCamera(feed.source, feed.width, feed.height) && feed.active) uploads++;
    // The sharp reflection uses every delivered camera frame. The low-frequency
    // diffuse lighting can update at 15 Hz, avoiding a synchronous CPU readback
    // on every frame (and still updates immediately when aperture changes).
    if (thetaMax !== lastProbeAngle || (fresh && now - lastProbeAt >= 1000 / 15)) runProbe(thetaMax);

    const aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
    const baseFov = (30 * Math.PI) / 180;
    const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(baseFov / 2) / aspect) : baseFov;
    if (aspect !== lastAspect) {
      proj = perspective(fovy, aspect, 0.1, 50);
      lastAspect = aspect;
    }
    view[14] = -controls.distance;

    renderer.render({
      proj,
      view,
      model: mat4FromQuat(controls.q, model),
      time: (now - start) / 1000,
      exposure: Number(ui.exposure.value),
      engrave: Number(ui.engrave.value),
      frost: Number(ui.frost.value),
      clearcoat: Number(ui.clearcoat.value),
      roughness: Number(ui.roughness.value),
      thetaMax,
      camAspect: feed.width / Math.max(feed.height, 1),
      hasCam: feed.active,
      camGain: Number(ui.gain.value),
      baseColor: RED_F0,
      sh: shView,
      keyDir: [...KEY_DIR, 1.6],
      keyColor: [1.0, 0.95, 0.88, 1],
    });

    // stats
    cpuAvg += (performance.now() - cpu0 - cpuAvg) * 0.05;
    fpsAcc += elapsed; fpsFrames++;
    if (fpsAcc >= 0.5) {
      $('s-fps').textContent = (fpsFrames / fpsAcc).toFixed(0);
      $('s-cpu').textContent = `${cpuAvg.toFixed(2)} ms`;
      $('s-rust').textContent = `${rustMs.toFixed(3)} ms`;
      if (feed.active) $('s-cam').textContent = `${feed.width}×${feed.height} · ${Math.round(uploads / fpsAcc)} Hz`;
      uploads = 0;
      fpsAcc = 0; fpsFrames = 0;
    }
  }

  requestAnimationFrame(frame);
  loader.classList.add('done');

}

function normalize(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}

function showError(err) {
  console.error(err);
  loader.classList.remove('done');
  loader.classList.add('error');
  loaderText.textContent = `${err.message}\n\nReload in a WebGPU-compatible browser.`;
}

main().catch(showError);
