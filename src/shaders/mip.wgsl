// Mip-chain downsample (4 bilinear taps = 4×4 tent). U wraps (equirect longitude).
@group(0) @binding(0) var srcSamp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(src, 0));
  let o = texel * 0.75;
  var c = textureSampleLevel(src, srcSamp, i.uv + vec2f(-o.x, -o.y), 0.0);
  c += textureSampleLevel(src, srcSamp, i.uv + vec2f( o.x, -o.y), 0.0);
  c += textureSampleLevel(src, srcSamp, i.uv + vec2f(-o.x,  o.y), 0.0);
  c += textureSampleLevel(src, srcSamp, i.uv + vec2f( o.x,  o.y), 0.0);
  return c * 0.25;
}
