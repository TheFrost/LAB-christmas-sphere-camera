// PASS 1 — Webcam frame → HDR equirectangular environment render target.
// Each texel is a reflection direction (view space). Directions towards the viewer
// are wrapped onto the webcam frame with an equidistant (fisheye) projection; past
// the edge of the frame the image is clamped/stretched and fades into the room,
// so grazing reflections at the rim of the sphere get violently compressed.
@group(0) @binding(0) var<uniform> S: Scene;
@group(0) @binding(1) var camSamp: sampler;
@group(0) @binding(2) var camTex: texture_2d<f32>;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = fullscreenPos(i);
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

// Rectangular soft-box seen in direction c (gnomonic footprint).
fn softbox(d: vec3f, c: vec3f, up: vec3f, size: vec2f, soft: f32) -> f32 {
  let z = dot(d, c);
  if (z <= 0.0) { return 0.0; }
  let ax = normalize(cross(up, c));
  let ay = cross(c, ax);
  let q = vec2f(dot(d, ax), dot(d, ay)) / z;
  let e = abs(q) - size;
  let m = 1.0 - smoothstep(-soft, soft, max(e.x, e.y));
  // slight falloff towards the edges of the diffuser, like a real softbox
  return m * (0.75 + 0.25 * (1.0 - length(q / size) * 0.5));
}

fn fairyLights(d: vec3f) -> vec3f {
  let uv = dirToEquirect(d);
  let grid = vec2f(56.0, 28.0);
  let cell = floor(uv * grid);
  let f = fract(uv * grid);
  let h = hash21(cell);
  if (h < 0.55) { return vec3f(0.0); }
  let jitter = vec2f(hash21(cell + 7.1), hash21(cell + 3.7)) * 0.6 + 0.2;
  let dist = length((f - jitter) * vec2f(1.0, 0.5));
  let core = exp(-dist * dist * 900.0);
  let tw = 0.65 + 0.35 * hash21(cell + 11.0);
  let hue = fract(h * 13.7);
  var col = vec3f(1.0, 0.72, 0.38);                  // warm white
  if (hue > 0.75) { col = vec3f(1.0, 0.25, 0.18); }  // red
  else if (hue > 0.55) { col = vec3f(0.35, 1.0, 0.45); } // green
  return col * core * tw * 9.0;
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let d = equirectToDir(i.uv);
  let thetaMax = S.p1.w;
  let aspect = S.p2.x;
  let gain = S.base.w;

  // — webcam projection (equidistant fisheye, mirrored like a real mirror) —
  let theta = acos(clamp(d.z, -1.0, 1.0));
  let radial = d.xy / max(length(d.xy), 1e-6);
  let r = theta / thetaMax;
  let cuv = vec2f(0.5) - 0.5 * radial * r * vec2f(1.0, aspect);
  let outside = max(max(-cuv.x, cuv.x - 1.0), max(-cuv.y, cuv.y - 1.0));
  // clamp-to-edge = the edge pixels smear outwards (stretch), then fade into the room
  let cam = textureSampleLevel(camTex, camSamp, clamp(cuv, vec2f(0.0), vec2f(1.0)), 0.0).rgb * gain;

  let roomTint = max(S.room.rgb, vec3f(0.004));
  let behind = 1.0 - smoothstep(-0.6, 0.2, d.z);
  let room = mix(roomTint * 0.55, vec3f(0.006, 0.008, 0.012), behind) + vec3f(0.003);
  // Fade outside the measured field into an estimated studio instead of
  // repeating the edge pixels over the entire unseen rear hemisphere.
  let fade = max(smoothstep(0.0, 0.18, outside), 1.0 - smoothstep(-0.95, -0.55, d.z));
  var col = mix(cam, room, fade);

  // — studio lighting so the metal has highlights even in a dark room —
  let top = softbox(d, normalize(vec3f(0.0, 0.96, 0.28)), vec3f(0.0, 0.0, -1.0), vec2f(0.42, 0.20), 0.03);
  let left = softbox(d, normalize(vec3f(-0.93, 0.18, -0.32)), vec3f(0.0, 1.0, 0.0), vec2f(0.10, 0.70), 0.02);
  let right = softbox(d, normalize(vec3f(0.95, 0.06, -0.30)), vec3f(0.0, 1.0, 0.0), vec2f(0.12, 0.55), 0.02);
  col += top * vec3f(1.0, 0.97, 0.92) * 7.0;
  col += left * vec3f(0.80, 0.90, 1.00) * 4.5;
  col += right * vec3f(1.00, 0.82, 0.62) * 3.5;
  // floor bounce
  col += vec3f(0.035, 0.025, 0.02) * (1.0 - smoothstep(-0.9, -0.2, d.y)) * (1.0 - fade * 0.3);

  if (d.z < 0.35) {
    col += fairyLights(d) * (1.0 - smoothstep(-0.1, 0.35, d.z));
  }
  return vec4f(col, 1.0);
}
