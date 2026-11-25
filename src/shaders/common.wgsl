// Shared scene uniforms (448 bytes). Everything lighting-related lives in VIEW space:
// the webcam sits where the viewer is, so the reflected world is anchored to the camera.
struct Scene {
  proj  : mat4x4f,
  view  : mat4x4f,
  model : mat4x4f,
  p0    : vec4f,          // time, exposure, engraveStrength, frostAmount
  p1    : vec4f,          // clearcoat, baseRoughness, envMaxLod, thetaMax
  p2    : vec4f,          // camAspect, hasCam, resolution.x, resolution.y
  base  : vec4f,          // ornament base colour (F0), w = camGain
  sh    : array<vec4f, 9>,// L2 irradiance SH from Rust (already ÷π, Lambert-convolved)
  keyDir   : vec4f,       // view-space key light direction, w = intensity
  keyColor : vec4f,
  room     : vec4f,       // avg linear camera colour, w = luminance
};

const PI = 3.14159265359;

fn fullscreenPos(i: u32) -> vec2f {
  return vec2f(f32((i << 1u) & 2u), f32(i & 2u));
}

// Direction ↔ equirectangular UV, centred on +Z (towards the viewer).
fn dirToEquirect(d: vec3f) -> vec2f {
  let lon = atan2(d.x, d.z);
  let lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2f(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}

fn equirectToDir(uv: vec2f) -> vec3f {
  let lon = (uv.x - 0.5) * 2.0 * PI;
  let lat = (0.5 - uv.y) * PI;
  return vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
}

fn acesFitted(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
