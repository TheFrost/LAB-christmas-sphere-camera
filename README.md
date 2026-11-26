# Frost Lab / 001 — Christmas Ornament

A rendering experiment built with **Vite, vanilla JavaScript, native WebGPU (WGSL) and Rust compiled to WebAssembly**. A polished red metal sphere reflects the device camera and an HDR-lit studio environment, with engraved snowflakes and a gold metal cap.

## Getting started

```sh
npm install
npm run dev
```

Open the `localhost` address Vite prints in a WebGPU-compatible browser. Select **Enable camera** and grant permission. Without a camera, the scene uses a virtual studio. All capture and processing happens locally; the video is never recorded or transmitted.

To access it from another device, use HTTPS: the camera and WebGPU require a secure context (localhost counts as one).

## Controls

- Drag with mouse or finger: quaternion rotation, free on all three axes.
- Wheel or pinch: zoom.
- Double-click or `R`: reset the view.
- Spacebar: auto-rotate.
- `C`: start/stop the camera.
- `H`: hide/show the controls. There is also a button to bring them back.

## Pipeline

1. `CameraFeed` detects new frames with `requestVideoFrameCallback`, falling back to `currentTime`.
2. `copyExternalImageToTexture` copies each available frame into an sRGB texture without reading the whole frame on the CPU.
3. The `env.wgsl` shader projects the camera into a 1536 × 768 `rgba16float` HDR equirectangular render target, using a configurable equidistant projection. The area the camera doesn't cover is filled with the virtual studio; a single webcam can't reconstruct a full 360° environment.
4. The GPU generates the environment mipmaps only when a new frame arrives or the projection parameters change. The base material is metallic 1 / roughness 0, with Fresnel, a frosted normal map, optional clearcoat and 4× MSAA antialiasing. The reflection uses `reflect(-V, N)`, filtered by its angular footprint to avoid aliasing at the edge.
5. Rust generates the sphere mesh, the cap with its loop and the 2048 × 1024 engraving texture. An L2 spherical-harmonics probe estimates diffuse lighting from a 64-pixel-wide camera thumbnail; it uses precomputed weights and updates up to 15 times per second. This does not limit the update rate of specular reflections.

The panel shows render FPS, CPU time, camera frames actually uploaded per second, Rust probe time and GPU adapter info. The target is 60 FPS, but it depends on the browser, GPU, display and the camera's real frame rate.

## Build and tests

The precompiled WebAssembly is included in `src/wasm`, so you don't need Rust to run or build the frontend.

```sh
npm test         # JS tests and tests of the real WASM functions
npm run build    # Static build in dist/
npm run preview  # Serve the production build
```

Development serves `/`; production and `npm run preview` use `/sphere-christmas/`. The Vercel rewrites also preserve access from the standalone deployment. Public URL: https://lab.thefrost.xyz/sphere-christmas/.

If you modify `rust/src/lib.rs`, install Rust, the `wasm32-unknown-unknown` target and `wasm-pack`, then run:

```sh
npm run wasm
npm run build:full
```

**Author:** Frost Lab. Initial implementation with Claude, continued with Codex.
