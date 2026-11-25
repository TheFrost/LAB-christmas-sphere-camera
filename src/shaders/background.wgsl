// Dark studio backdrop. Each layer evaluates just the nearest light cell instead
// of looping over dozens of lights for every screen pixel.
@group(0) @binding(0) var<uniform> S: Scene;
struct VO { @builtin(position) pos: vec4f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  o.pos = vec4f(fullscreenPos(i) * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn bokeh(p: vec2f, scale: f32, seed: f32, t: f32) -> vec3f {
  let q = p * scale + seed;
  let cell = floor(q);
  let h = hash21(cell + seed);
  let center = vec2f(0.5) + (vec2f(hash21(cell + 3.2), hash21(cell + 7.9)) - 0.5) * 0.18;
  let drift = vec2f(sin(t * 0.12 + h * 40.0), cos(t * 0.09 + h * 30.0)) * 0.035;
  let r = mix(0.09, 0.32, h * h);
  let dist = length(fract(q) - center - drift);
  let disk = 1.0 - smoothstep(r * 0.68, r, dist);
  let rim = disk * smoothstep(r * 0.53, r * 0.84, dist);
  let color = mix(vec3f(0.8, 0.15, 0.08), vec3f(1.0, 0.68, 0.30), hash21(cell + 5.0));
  let twinkle = 0.65 + 0.35 * sin(t * 0.8 + h * 52.0);
  return color * (disk * 0.038 + rim * 0.018) * twinkle * step(0.25, h);
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let res = S.p2.zw;
  let p = (i.pos.xy - 0.5 * res) / res.y;
  let t = S.p0.x;
  var col = mix(vec3f(0.024, 0.029, 0.035), vec3f(0.003, 0.004, 0.006), smoothstep(0.0, 0.95, length(p)));
  col += vec3f(0.055, 0.009, 0.012) * exp(-dot(p, p) * 4.0);
  let mask = smoothstep(0.24, 0.52, length(p));
  col += (bokeh(p, 4.7, 0.3, t) + bokeh(p, 8.9, 3.7, t) * 0.5) * mask;
  col *= 1.0 - 0.65 * smoothstep(0.45, 1.3, length(p));
  col += (hash21(i.pos.xy) - 0.5) * 0.002;
  return vec4f(linearToSrgb(max(col, vec3f(0.0))), 1.0);
}
