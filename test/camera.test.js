import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraFeed } from '../src/camera-feed.js';

function fixtures() {
  const callbacks = new Map();
  let next = 0;
  const video = {
    videoWidth: 1280, videoHeight: 720, readyState: 2, currentTime: 0,
    async play() {}, pause() {},
    requestVideoFrameCallback(fn) { callbacks.set(++next, fn); return next; },
    cancelVideoFrameCallback(id) { callbacks.delete(id); },
  };
  const track = new EventTarget();
  track.stopped = false;
  track.stop = () => { track.stopped = true; };
  track.getSettings = () => ({ frameRate: 60 });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const gradient = { addColorStop() {} };
  const canvas = { getContext: () => ({ createLinearGradient: () => gradient, createRadialGradient: () => gradient, fillRect() {} }) };
  globalThis.document = { createElement: tag => tag === 'video' ? video : canvas };
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } });
  return { video, track, stream, callbacks };
}

test('camera starts, emits each fresh frame once and releases all resources', async () => {
  const { video, track, callbacks } = fixtures();
  const feed = new CameraFeed();
  assert(feed.consumeFresh());
  assert(!feed.consumeFresh());
  await feed.start();
  assert(feed.active);
  assert.equal(feed.width, 1280);
  assert(feed.consumeFresh());
  assert(!feed.consumeFresh());
  const [id, fn] = callbacks.entries().next().value;
  callbacks.delete(id);
  fn();
  assert(feed.consumeFresh());
  assert(!feed.consumeFresh());
  feed.stop();
  assert.equal(feed.state, 'idle');
  assert(track.stopped);
  assert.equal(video.srcObject, null);
  assert.equal(callbacks.size, 0);
  assert(feed.consumeFresh());
});

test('permission denial stays visible and virtual studio remains available', async () => {
  fixtures();
  const error = new Error('Denied');
  error.name = 'NotAllowedError';
  navigator.mediaDevices.getUserMedia = async () => { throw error; };
  const feed = new CameraFeed();
  await feed.start();
  assert.equal(feed.state, 'error');
  assert.equal(feed.error.name, 'NotAllowedError');
  assert.equal(feed.source, feed.fallback);
  assert(feed.consumeFresh());
});

test('cancel releases a stream that resolves after permission prompt', async () => {
  const { stream, track, video } = fixtures();
  let resolve;
  navigator.mediaDevices.getUserMedia = () => new Promise(r => { resolve = r; });
  const feed = new CameraFeed();
  const start = feed.start();
  assert.equal(feed.state, 'starting');
  feed.stop();
  resolve(stream);
  await start;
  assert.equal(feed.state, 'idle');
  assert(track.stopped);
  assert.equal(video.srcObject, null);
});

test('camera without video-frame callback uses video time instead of render time', async () => {
  const { video } = fixtures();
  delete video.requestVideoFrameCallback;
  const feed = new CameraFeed();
  await feed.start();
  assert(feed.consumeFresh());
  assert(!feed.consumeFresh());
  video.currentTime += 1 / 30;
  assert(feed.consumeFresh());
  assert(!feed.consumeFresh());
  feed.stop();
});
