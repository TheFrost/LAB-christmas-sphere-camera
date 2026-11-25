// PASS 3 — PBR ornament. Base: metallic 1, roughness 0 (red mirror metal), with a
// glass clear-coat and baked snow engravings that switch the surface to a frosted
// dielectric. Specular IBL samples the webcam environment render target.
@group(0) @binding(0) var<uniform> S: Scene;
@group(0) @binding(1) var envSamp: sampler;
@group(0) @binding(2) var envTex: texture_2d<f32>;
@group(0) @binding(3) var engTex: texture_2d<f32>;

struct Material { color: vec4f, params: vec4f }; // rgb F0 + roughness | kind
@group(1) @binding(0) var<uniform> M: Material;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) vpos: vec3f,
  @location(1) vn: vec3f,
  @location(2) uv: vec2f,
  @location(3) vt: vec3f,
  @location(4) opos: vec3f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) t: vec3f) -> VO {
  let mv = S.view * S.model;
  let vp = mv * vec4f(p, 1.0);
  var o: VO;
  o.pos = S.proj * vp;
  o.vpos = vp.xyz;
  o.vn = (mv * vec4f(n, 0.0)).xyz;
  o.vt = (mv * vec4f(t, 0.0)).xyz;
  o.uv = uv;
  o.opos = p;
  return o;
}

fn envBRDFApprox(F0: vec3f, r: f32, NoV: f32) -> vec3f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let rr = r * c0 + c1;
  let a004 = min(rr.x * rr.x, exp2(-9.28 * NoV)) * rr.x + rr.y;
  let AB = vec2f(-1.04, 1.04) * a004 + rr.zw;
  return F0 * AB.x + AB.y;
}

fn shIrradiance(n: vec3f) -> vec3f {
  let x = n.x; let y = n.y; let z = n.z;
  var r = S.sh[0].rgb * 0.282095
        + S.sh[1].rgb * (0.488603 * y) + S.sh[2].rgb * (0.488603 * z) + S.sh[3].rgb * (0.488603 * x)
        + S.sh[4].rgb * (1.092548 * x * y) + S.sh[5].rgb * (1.092548 * y * z)
        + S.sh[6].rgb * (0.315392 * (3.0 * z * z - 1.0))
        + S.sh[7].rgb * (1.092548 * x * z) + S.sh[8].rgb * (0.546274 * (x * x - y * y));
  return max(r, vec3f(0.0));
}

fn sampleEnv(d: vec3f, lod: f32) -> vec3f {
  return textureSampleLevel(envTex, envSamp, dirToEquirect(d), lod).rgb;
}

fn ggx(NoH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let kind = M.params.x;
  let Ng = normalize(i.vn);
  let V = normalize(-i.vpos);
  let maxLod = S.p1.z;
  let envW = f32(textureDimensions(envTex, 0).x);

  // Engraving map (sampled in uniform control flow for derivatives).
  let e = textureSample(engTex, envSamp, i.uv);

  // Footprint LOD of the mirror reflection — kills shimmer at the grazing rim,
  // where one pixel covers a huge solid angle of the environment.
  let Rg = reflect(-V, Ng);
  let dR = max(length(dpdx(Rg)), length(dpdy(Rg)));
  let footLod = log2(max(dR * envW / (2.0 * PI), 1e-4));

  var N = Ng;
  var F0 = M.color.rgb;
  var rough = M.color.a;
  var metal = 1.0;
  var albedo = vec3f(0.0);
  var ao = 1.0;
  var coat = 0.0;

  if (kind < 0.5) {
    let T = normalize(i.vt - Ng * dot(i.vt, Ng));
    let B = cross(Ng, T);
    let g = (e.rg * 2.0 - 1.0) * S.p0.z;
    N = normalize(Ng + T * g.x + B * g.y);
    let frost = clamp(e.b * S.p0.w, 0.0, 1.0);
    F0 = S.base.rgb;
    rough = mix(S.p1.y, 0.62, frost);
    metal = 1.0 - frost * 0.92;
    albedo = vec3f(0.93, 0.95, 1.0) * mix(0.75, 1.0, e.a);
    coat = S.p1.x * (1.0 - frost * 0.85);
    // contact occlusion under the cap + groove cavity
    ao = mix(0.35, 1.0, (1.0 - smoothstep(0.90, 0.985, i.opos.y))) * (1.0 - e.a * 0.25 * S.p0.z);
  }

  let NoV = clamp(dot(N, V), 1e-4, 1.0);
  let R = reflect(-V, N);
  let lod = clamp(max(sqrt(rough) * 8.0, footLod), 0.0, maxLod);
  let F0m = mix(vec3f(0.04), F0, metal);
  // At zero roughness the conductor is an ideal mirror with Schlick Fresnel.
  let mirrorF = F0m + (1.0 - F0m) * pow(1.0 - NoV, 5.0);
  let brdf = mix(mirrorF, envBRDFApprox(F0m, rough, NoV), smoothstep(0.0, 0.18, rough));
  let spec = sampleEnv(R, lod) * brdf;
  let diffuse = albedo * (1.0 - metal) * (shIrradiance(N) + vec3f(0.008));

  // Analytic key light matching the top softbox (only visible on rough areas).
  let L = normalize(S.keyDir.xyz);
  let H = normalize(L + V);
  let NoL = max(dot(N, L), 0.0);
  let a = max(rough * rough, 0.02);
  let Fk = F0m + (1.0 - F0m) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  let keySpec = Fk * ggx(max(dot(N, H), 0.0), a) * 0.25 * smoothstep(0.05, 0.3, rough);
  let key = (albedo * (1.0 - metal) / PI + keySpec) * NoL * S.keyColor.rgb * S.keyDir.w;

  var col = (spec + diffuse + key) * ao;

  // Glass clear-coat: colourless Fresnel reflection on top of the red metal.
  if (coat > 0.0) {
    let NoVg = clamp(dot(Ng, V), 1e-4, 1.0);
    let Fc = (0.04 + 0.96 * pow(1.0 - NoVg, 5.0)) * coat;
    let Rc = reflect(-V, normalize(mix(Ng, N, 0.35)));
    let lodc = clamp(footLod, 0.0, maxLod);
    col = col * (1.0 - Fc) + sampleEnv(Rc, lodc) * Fc * ao;
  }

  col *= S.p0.y;
  return vec4f(linearToSrgb(acesFitted(col)), 1.0);
}
