import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Node has no real WebGPU device. Intercept Vite raw imports and exercise the
// renderer's scheduling against a minimal recording device (not shader validation).
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.wgsl?raw')) {
      const file = new URL(url); file.search = '';
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(file, 'utf8'))}` };
    }
    return nextLoad(url, context);
  }
});
const { Renderer } = await import('../src/renderer.js');
hooks.deregister();

function fixture() {
  const events = [];
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_DST: 4 };
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, INDEX: 8 };
  globalThis.window = { devicePixelRatio: 2 };
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
  const texture = ({ size = [1, 1], format }) => ({ width: size[0], height: size[1], format, createView: () => ({}), destroy() {} });
  const device = {
    limits: { maxTextureDimension2D: 8192 }, lost: new Promise(() => {}), addEventListener() {},
    queue: { writeBuffer() {}, writeTexture() {}, submit() {}, copyExternalImageToTexture() { events.push('upload'); } },
    createBuffer: () => ({}), createSampler: () => ({}), createTexture: texture,
    createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginRenderPass() { events.push('pass'); return { setPipeline() {}, setBindGroup() {}, draw() {}, drawIndexed() {}, setVertexBuffer() {}, setIndexBuffer() {}, end() {} }; },
      finish: () => ({}),
    }),
  };
  const canvas = { clientWidth: 1440, clientHeight: 900, getContext: () => ({ configure() {}, getCurrentTexture: () => texture({}) }) };
  const renderer = new Renderer(canvas, {}, device);
  renderer.setEngraving(new Uint8Array(4), 2048, 1024);
  const identity = new Float32Array(16);
  const uniforms = { proj: identity, view: identity, model: identity, time: 0, exposure: 1, engrave: 1, frost: 1, clearcoat: .6, roughness: 0, thetaMax: 1.8, camAspect: 16 / 9, hasCam: false, baseColor: [0.8, 0.035, 0.045], camGain: 1.25, keyDir: [0, 1, 0, 1.6], keyColor: [1, 1, 1, 1] };
  return { renderer, uniforms, events, canvas };
}

test('environment is generated only after a new image or projection change', () => {
  const { renderer, uniforms, events, canvas } = fixture();
  renderer.uploadCamera({}, 960, 540);
  events.length = 0;
  renderer.render(uniforms);
  assert.equal(events.filter(e => e === 'pass').length, 12); // env + 10 mips + scene
  assert(canvas.width * canvas.height < 2_110_000);
  events.length = 0;
  renderer.render({ ...uniforms, time: 1, exposure: 2, roughness: .1 });
  assert.deepEqual(events, ['pass']);
  events.length = 0;
  renderer.render({ ...uniforms, thetaMax: 2 });
  assert.equal(events.length, 12);
  events.length = 0;
  renderer.uploadCamera({}, 960, 540);
  renderer.render({ ...uniforms, thetaMax: 2 });
  assert.equal(events[0], 'upload');
  assert.equal(events.length, 13);
});
