// Raw WebGPU renderer.
//   Pass 1  webcam frame ──► equirectangular HDR environment (render target, rgba16f)
//   Pass 2  environment mip chain (roughness / anti-alias prefilter)
//   Pass 3  backdrop + PBR ornament, 4× MSAA, resolved to the canvas
import commonWGSL from './shaders/common.wgsl?raw';
import envWGSL from './shaders/env.wgsl?raw';
import mipWGSL from './shaders/mip.wgsl?raw';
import backgroundWGSL from './shaders/background.wgsl?raw';
import ornamentWGSL from './shaders/ornament.wgsl?raw';

const ENV_W = 1536;
const ENV_H = 768;
const ENV_MIPS = Math.floor(Math.log2(ENV_W)) + 1;
const ENG_MIPS = 11;
const SAMPLES = 4;
const MAX_RENDER_PIXELS = 2_100_000;
const SCENE_FLOATS = 112; // 448 bytes
const VERTEX_STRIDE = 11 * 4;

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('Este navegador no soporta WebGPU.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No se encontró un adaptador WebGPU.');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const renderer = new Renderer(canvas, adapter, device);
    const error = await device.popErrorScope();
    if (error) throw new Error(`WebGPU: ${error.message}`);
    return renderer;
  }

  constructor(canvas, adapter, device) {
    this.canvas = canvas;
    this.adapter = adapter;
    this.device = device;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context = canvas.getContext('webgpu');
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.scene = new Float32Array(SCENE_FLOATS);
    this.onError = (error) => console.error(error);
    this.lost = false;
    device.lost.then((info) => {
      if (info.reason !== 'destroyed') {
        this.lost = true;
        this.onError(new Error(`Se perdió el dispositivo WebGPU: ${info.message}`));
      }
    });
    device.addEventListener('uncapturederror', (event) => {
      this.lost = true;
      this.onError(event.error);
    });

    const d = device;
    this.sceneBuffer = d.createBuffer({ size: SCENE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.envSampler = d.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'clamp-to-edge', maxAnisotropy: 1,
    });
    this.camSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.envTex = d.createTexture({
      size: [ENV_W, ENV_H], format: 'rgba16float', mipLevelCount: ENV_MIPS,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // ── pipelines ──
    const mod = (code) => d.createShaderModule({ code: commonWGSL + '\n' + code });
    this.mipGen = {};
    this.envPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod(envWGSL), entryPoint: 'vs' },
      fragment: { module: mod(envWGSL), entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    });

    this.bgPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod(backgroundWGSL), entryPoint: 'vs' },
      fragment: { module: mod(backgroundWGSL), entryPoint: 'fs', targets: [{ format: this.format }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: SAMPLES },
    });

    const ornModule = mod(ornamentWGSL);
    this.ornPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: ornModule, entryPoint: 'vs',
        buffers: [{
          arrayStride: VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
            { shaderLocation: 3, offset: 32, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module: ornModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });

    this.bgBindGroup = d.createBindGroup({
      layout: this.bgPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.sceneBuffer } }],
    });

    this.envChain = this.#buildMipChain(this.envTex, ENV_MIPS);
    this.meshes = [];
    this.camTex = null;
    this.environmentDirty = true;
    this.environmentKey = null;
  }

  // ── mip generation ──
  #mipPipeline(format) {
    if (!this.mipGen[format]) {
      const module = this.device.createShaderModule({ code: mipWGSL });
      this.mipGen[format] = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      });
    }
    return this.mipGen[format];
  }

  #buildMipChain(texture, levels) {
    const pipeline = this.#mipPipeline(texture.format);
    const steps = [];
    for (let l = 1; l < levels; l++) {
      steps.push({
        target: texture.createView({ baseMipLevel: l, mipLevelCount: 1 }),
        bindGroup: this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.envSampler },
            { binding: 1, resource: texture.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) },
          ],
        }),
      });
    }
    return { pipeline, steps, level0: texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }) };
  }

  #encodeMips(encoder, chain) {
    for (const s of chain.steps) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: s.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
      pass.setPipeline(chain.pipeline);
      pass.setBindGroup(0, s.bindGroup);
      pass.draw(3);
      pass.end();
    }
  }

  // ── resources from Rust ──
  setEngraving(rgba, width, height) {
    const d = this.device;
    this.engTex = d.createTexture({
      size: [width, height], format: 'rgba8unorm', mipLevelCount: ENG_MIPS,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    d.queue.writeTexture({ texture: this.engTex }, rgba, { bytesPerRow: width * 4 }, [width, height]);
    const enc = d.createCommandEncoder();
    this.#encodeMips(enc, this.#buildMipChain(this.engTex, ENG_MIPS));
    d.queue.submit([enc.finish()]);

    this.ornBindGroup = d.createBindGroup({
      layout: this.ornPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sceneBuffer } },
        { binding: 1, resource: this.envSampler },
        { binding: 2, resource: this.envTex.createView() },
        { binding: 3, resource: this.engTex.createView() },
      ],
    });
  }

  addMesh(vertices, indices, material) {
    const d = this.device;
    const vb = d.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(vb, 0, vertices);
    const ib = d.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(ib, 0, indices);
    const mb = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(mb, 0, new Float32Array([...material.color, material.roughness, material.kind, 0, 0, 0]));
    const bindGroup = d.createBindGroup({
      layout: this.ornPipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: mb } }],
    });
    this.meshes.push({ vb, ib, count: indices.length, bindGroup });
  }

  // ── webcam upload (one GPU copy per *new* camera frame) ──
  uploadCamera(source, width, height) {
    if (!width || !height) return false;
    if (!this.camTex || this.camTex.width !== width || this.camTex.height !== height) {
      this.camTex?.destroy();
      this.camTex = this.device.createTexture({
        size: [width, height], format: 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.envBindGroup = this.device.createBindGroup({
        layout: this.envPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.sceneBuffer } },
          { binding: 1, resource: this.camSampler },
          { binding: 2, resource: this.camTex.createView() },
        ],
      });
    }
    this.device.queue.copyExternalImageToTexture({ source }, { texture: this.camTex }, [width, height]);
    this.environmentDirty = true;
    return true;
  }

  resize() {
    const cssWidth = Math.max(1, this.canvas.clientWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight);
    const maxDimension = this.device.limits.maxTextureDimension2D;
    const dpr = Math.min(window.devicePixelRatio || 1, 2,
      Math.sqrt(MAX_RENDER_PIXELS / (cssWidth * cssHeight)),
      maxDimension / Math.max(cssWidth, cssHeight));
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.msaaTex) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.msaaTex?.destroy();
    this.depthTex?.destroy();
    this.msaaTex = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depthTex = this.device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.msaaView = this.msaaTex.createView();
    this.depthView = this.depthTex.createView();
  }

  /** @param {object} u  uniform values for this frame */
  render(u) {
    if (this.lost || !this.envBindGroup || !this.ornBindGroup) return;
    this.resize();
    const s = this.scene;
    s.set(u.proj, 0);
    s.set(u.view, 16);
    s.set(u.model, 32);
    s.set([u.time, u.exposure, u.engrave, u.frost], 48);
    s.set([u.clearcoat, u.roughness, ENV_MIPS - 1, u.thetaMax], 52);
    s.set([u.camAspect, u.hasCam ? 1 : 0, this.canvas.width, this.canvas.height], 56);
    s.set([...u.baseColor, u.camGain], 60);
    if (u.sh) {
      for (let i = 0; i < 36; i++) s[64 + i] = u.sh[i] * u.camGain;
    } else s.fill(0, 64, 100);
    s.set(u.keyDir, 100);
    s.set(u.keyColor, 104);
    if (u.sh) {
      for (let i = 0; i < 4; i++) s[108 + i] = u.sh[36 + i] * u.camGain;
    } else s.fill(0, 108, 112);
    this.device.queue.writeBuffer(this.sceneBuffer, 0, s);

    const enc = this.device.createCommandEncoder();

    // The environment stays in view space. Orbiting, zoom and material tweaks
    // therefore never require reprojecting the camera or rebuilding its mipmaps.
    const key = `${u.thetaMax}:${u.camAspect}:${u.camGain}:${u.hasCam}`;
    if (this.environmentDirty || key !== this.environmentKey) {
      this.environmentDirty = false;
      this.environmentKey = key;
      // Pass 1 — webcam → environment render target
      const envPass = enc.beginRenderPass({
        colorAttachments: [{ view: this.envChain.level0, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      envPass.setPipeline(this.envPipeline);
      envPass.setBindGroup(0, this.envBindGroup);
      envPass.draw(3);
      envPass.end();

      // Pass 2 — mip chain (roughness/footprint filtering)
      this.#encodeMips(enc, this.envChain);
    }

    // Pass 3 — scene
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.msaaView,
        resolveTarget: this.context.getCurrentTexture().createView(),
        loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1],
      }],
      depthStencilAttachment: { view: this.depthView, depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
    });
    pass.setPipeline(this.bgPipeline);
    pass.setBindGroup(0, this.bgBindGroup);
    pass.draw(3);

    pass.setPipeline(this.ornPipeline);
    pass.setBindGroup(0, this.ornBindGroup);
    for (const m of this.meshes) {
      pass.setBindGroup(1, m.bindGroup);
      pass.setVertexBuffer(0, m.vb);
      pass.setIndexBuffer(m.ib, 'uint32');
      pass.drawIndexed(m.count);
    }
    pass.end();

    this.device.queue.submit([enc.finish()]);
  }
}
