import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { build_sphere, build_cap, generate_engraving, LightProbe } from '../src/wasm/sphere_core.js';
import { perspective, quatFromAxisAngle, mat4FromQuat } from '../src/math.js';

const wasm = await init({ module_or_path: await readFile(new URL('../src/wasm/sphere_core_bg.wasm', import.meta.url)) });

function validateMesh(mesh) {
  const vertices = mesh.vertices;
  const indices = mesh.indices;
  assert.equal(vertices.length % 11, 0);
  assert.equal(indices.length % 3, 0);
  assert(vertices.every(Number.isFinite));
  assert(indices.every(i => i < vertices.length / 11));
  return vertices;
}

test('Rust sphere has unit radius and outward unit normals', () => {
  const mesh = build_sphere(256, 160, 1);
  const v = validateMesh(mesh);
  assert.equal(v.length / 11, 257 * 161);
  for (let i = 0; i < v.length; i += 11) {
    assert(Math.abs(Math.hypot(...v.subarray(i, i + 3)) - 1) < 1e-5);
    assert(Math.abs(Math.hypot(...v.subarray(i + 3, i + 6)) - 1) < 1e-5);
    assert(Math.abs(v[i] - v[i + 3]) < 1e-6);
  }
  mesh.free();
});

test('Rust generates valid gold cap and suspension loop', () => {
  const mesh = build_cap(160);
  const v = validateMesh(mesh);
  assert(v.some((value, i) => i % 11 === 1 && value > 1.3));
  mesh.free();
});

test('engraving bake creates deterministic frosted relief and clear areas', () => {
  const w = 256, h = 128;
  const a = generate_engraving(w, h, 1225);
  const b = generate_engraving(w, h, 1225);
  assert.equal(a.length, w * h * 4);
  assert.deepEqual(a, b);
  let frost = 0, clear = 0, relief = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 2] > 60) frost++;
    if (a[i + 2] < 10) clear++;
    if (a[i + 3] > 12) relief++;
  }
  assert(frost > w * h * 0.05 && clear > w * h * 0.1 && relief > 0);
});

test('cached Rust light probe responds to pixels and changes in projection', () => {
  const w = 64, h = 36;
  const probe = new LightProbe(w, h);
  const px = new Uint8Array(wasm.memory.buffer, probe.pixels_ptr(), w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 255; px[i + 3] = 255; }
  const output = () => new Float32Array(wasm.memory.buffer, probe.out_ptr(), 40).slice();
  probe.update(1.8, 1);
  const red = output();
  assert(red.every(Number.isFinite));
  assert.equal(red[36], 1);
  assert.equal(red[37], 0);
  probe.update(1.8, 1);
  assert.deepEqual(output(), red);
  probe.update(0.8, 1);
  assert.notEqual(output()[8], red[8]);
  px.fill(0);
  probe.update(0.8, 1);
  assert(output().every(x => Math.abs(x) < 1e-6));
  probe.free();
});

test('quaternion and perspective conventions match WebGPU', () => {
  const m = mat4FromQuat(quatFromAxisAngle(0, 1, 0, Math.PI / 2));
  assert(Math.abs(m[0]) < 1e-6 && Math.abs(m[2] + 1) < 1e-6);
  const p = perspective(Math.PI / 4, 1.5, 0.1, 50);
  const depth = z => (p[10] * z + p[14]) / (p[11] * z);
  assert(Math.abs(depth(-0.1)) < 1e-6);
  assert(Math.abs(depth(-50) - 1) < 1e-6);
});
