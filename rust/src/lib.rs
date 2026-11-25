//! sphere_core — heavy CPU work for the Christmas Sphere experiment.
//!
//! * Geometry: high-density UV sphere, fluted metal cap (lathe) and hanging loop.
//! * Engraving bake: procedural 6-fold snowflakes + snow drift, Gaussian blurred
//!   ("difuminado") and converted to a tangent-space normal / frost map.
//! * LightProbe: per-camera-frame projection of the webcam image onto second-order
//!   spherical harmonics (irradiance), with temporal smoothing.

use std::f32::consts::PI;
use wasm_bindgen::prelude::*;

// ───────────────────────────── utilities ─────────────────────────────

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
fn normalize(a: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt().max(1e-12);
    [a[0] / l, a[1] / l, a[2] / l]
}

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        let mut r = Rng(seed ^ 0x853c_49e6_748f_ea9b);
        r.next_u32();
        r
    }
    fn next_u32(&mut self) -> u32 {
        let x = self.0;
        self.0 = x
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let xorshifted = (((x >> 18) ^ x) >> 27) as u32;
        let rot = (x >> 59) as u32;
        xorshifted.rotate_right(rot)
    }
    fn f(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
    fn unit_vec(&mut self) -> [f32; 3] {
        let z = self.range(-1.0, 1.0);
        let a = self.range(0.0, 2.0 * PI);
        let r = (1.0 - z * z).max(0.0).sqrt();
        [r * a.cos(), z, r * a.sin()]
    }
}

#[inline]
fn hash3(x: i32, y: i32, z: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343)
        ^ (y as u32).wrapping_mul(0xd816_3841)
        ^ (z as u32).wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    (h & 0x00ff_ffff) as f32 / 16_777_215.0
}

fn value_noise(p: [f32; 3]) -> f32 {
    let (fx, fy, fz) = (p[0].floor(), p[1].floor(), p[2].floor());
    let (ix, iy, iz) = (fx as i32, fy as i32, fz as i32);
    let (tx, ty, tz) = (p[0] - fx, p[1] - fy, p[2] - fz);
    let s = |t: f32| t * t * (3.0 - 2.0 * t);
    let (ux, uy, uz) = (s(tx), s(ty), s(tz));
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c = |dx, dy, dz| hash3(ix + dx, iy + dy, iz + dz);
    let x00 = lerp(c(0, 0, 0), c(1, 0, 0), ux);
    let x10 = lerp(c(0, 1, 0), c(1, 1, 0), ux);
    let x01 = lerp(c(0, 0, 1), c(1, 0, 1), ux);
    let x11 = lerp(c(0, 1, 1), c(1, 1, 1), ux);
    lerp(lerp(x00, x10, uy), lerp(x01, x11, uy), uz)
}

fn fbm(p: [f32; 3], octaves: u32) -> f32 {
    let (mut sum, mut amp, mut norm, mut q) = (0.0, 0.5, 0.0, p);
    for _ in 0..octaves {
        sum += amp * value_noise(q);
        norm += amp;
        amp *= 0.5;
        q = [q[0] * 2.03 + 1.7, q[1] * 2.03 - 3.1, q[2] * 2.03 + 0.4];
    }
    sum / norm
}

// ───────────────────────────── geometry ─────────────────────────────

/// Interleaved vertex layout: position(3) normal(3) uv(2) tangent(3) = 11 floats.
const STRIDE: usize = 11;

#[wasm_bindgen]
pub struct Mesh {
    vertices: Vec<f32>,
    indices: Vec<u32>,
}

#[wasm_bindgen]
impl Mesh {
    #[wasm_bindgen(getter)]
    pub fn vertices(&self) -> Vec<f32> {
        self.vertices.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }
}

fn grid_indices(cols: u32, rows: u32, base: u32, out: &mut Vec<u32>) {
    for j in 0..rows {
        for i in 0..cols {
            let a = base + j * (cols + 1) + i;
            let b = a + cols + 1;
            out.extend_from_slice(&[a, a + 1, b, a + 1, b + 1, b]);
        }
    }
}

/// Smooth UV sphere. v = 0 at the north pole, u wraps around Y.
#[wasm_bindgen]
pub fn build_sphere(lon: u32, lat: u32, radius: f32) -> Mesh {
    let mut v = Vec::with_capacity(((lon + 1) * (lat + 1)) as usize * STRIDE);
    for j in 0..=lat {
        let fv = j as f32 / lat as f32;
        let th = fv * PI;
        let (st, ct) = th.sin_cos();
        for i in 0..=lon {
            let fu = i as f32 / lon as f32;
            let ph = fu * 2.0 * PI;
            let (sp, cp) = ph.sin_cos();
            let n = [st * cp, ct, st * sp];
            v.extend_from_slice(&[
                n[0] * radius,
                n[1] * radius,
                n[2] * radius,
                n[0],
                n[1],
                n[2],
                fu,
                fv,
                -sp,
                0.0,
                cp,
            ]);
        }
    }
    let mut idx = Vec::new();
    grid_indices(lon, lat, 0, &mut idx);
    Mesh { vertices: v, indices: idx }
}

/// Fluted ornament cap (lathe) + wire loop, with normals from face accumulation.
#[wasm_bindgen]
pub fn build_cap(segments: u32) -> Mesh {
    // Profile from top to bottom: (radius, y, flute_amount)
    let mut prof: Vec<(f32, f32, f32)> = Vec::new();
    // dome top
    for k in 0..=6 {
        let a = k as f32 / 6.0 * (PI * 0.5);
        prof.push((0.165 * a.sin(), 1.200 + 0.018 * a.cos(), 0.0));
    }
    // top bevel
    prof.push((0.180, 1.192, 0.0));
    prof.push((0.186, 1.180, 0.4));
    // fluted body
    for k in 0..=18 {
        let t = k as f32 / 18.0;
        prof.push((0.186 - 0.006 * t, 1.172 - t * 0.150, 1.0));
    }
    // lip
    prof.push((0.188, 1.012, 0.3));
    prof.push((0.214, 1.004, 0.0));
    prof.push((0.218, 0.990, 0.0));
    prof.push((0.212, 0.978, 0.0));
    prof.push((0.190, 0.972, 0.0));
    prof.push((0.170, 0.955, 0.0));

    let rows = prof.len() as u32 - 1;
    let flutes = 28.0;
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut uvs: Vec<[f32; 2]> = Vec::new();
    let mut tans: Vec<[f32; 3]> = Vec::new();
    for (j, &(r, y, fl)) in prof.iter().enumerate() {
        for i in 0..=segments {
            let fu = i as f32 / segments as f32;
            let ph = fu * 2.0 * PI;
            let (sp, cp) = ph.sin_cos();
            let flute = (ph * flutes).cos().abs().powf(0.6);
            let rr = r * (1.0 - 0.035 * fl * (1.0 - flute));
            pos.push([rr * cp, y, rr * sp]);
            uvs.push([fu, j as f32 / rows as f32]);
            tans.push([-sp, 0.0, cp]);
        }
    }
    let mut idx = Vec::new();
    grid_indices(segments, rows, 0, &mut idx);

    // accumulate normals (CCW from outside → outward)
    let mut nrm = vec![[0.0f32; 3]; pos.len()];
    for t in idx.chunks(3) {
        let (a, b, c) = (pos[t[0] as usize], pos[t[1] as usize], pos[t[2] as usize]);
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = cross(e1, e2);
        for &k in t {
            let m = &mut nrm[k as usize];
            m[0] += n[0];
            m[1] += n[1];
            m[2] += n[2];
        }
    }
    // weld the seam (u=0 and u=1 share position)
    let cols = (segments + 1) as usize;
    for j in 0..prof.len() {
        let a = j * cols;
        let b = a + segments as usize;
        let s = [
            nrm[a][0] + nrm[b][0],
            nrm[a][1] + nrm[b][1],
            nrm[a][2] + nrm[b][2],
        ];
        nrm[a] = s;
        nrm[b] = s;
    }

    let mut v = Vec::with_capacity(pos.len() * STRIDE);
    for k in 0..pos.len() {
        let mut n = normalize(nrm[k]);
        if k < cols {
            n = [0.0, 1.0, 0.0];
        }
        let p = pos[k];
        v.extend_from_slice(&[
            p[0], p[1], p[2], n[0], n[1], n[2], uvs[k][0], uvs[k][1], tans[k][0], tans[k][1],
            tans[k][2],
        ]);
    }

    // hanging loop (torus in the XY plane)
    let base = (v.len() / STRIDE) as u32;
    let (major, minor) = (0.072f32, 0.013f32);
    let center = [0.0f32, 1.205 + major - minor * 0.5, 0.0];
    let (su, sv) = (64u32, 16u32);
    for j in 0..=sv {
        let b = j as f32 / sv as f32 * 2.0 * PI;
        let (sb, cb) = b.sin_cos();
        for i in 0..=su {
            let a = i as f32 / su as f32 * 2.0 * PI;
            let (sa, ca) = a.sin_cos();
            let n = [cb * ca, cb * sa, sb];
            let p = [
                center[0] + (major + minor * cb) * ca,
                center[1] + (major + minor * cb) * sa,
                center[2] + minor * sb,
            ];
            v.extend_from_slice(&[
                p[0],
                p[1],
                p[2],
                n[0],
                n[1],
                n[2],
                i as f32 / su as f32,
                j as f32 / sv as f32,
                -sa,
                ca,
                0.0,
            ]);
        }
    }
    grid_indices(su, sv, base, &mut idx);

    Mesh { vertices: v, indices: idx }
}

// ───────────────────────────── engraving bake ─────────────────────────────

#[derive(Clone, Copy)]
struct Shape {
    arm: f32,
    thick: f32,
    branches: [(f32, f32); 3],
    nb: usize,
    hex: f32,
    soft: f32,
    disk: bool,
}

struct Flake {
    c: [f32; 3],
    tu: [f32; 3],
    tv: [f32; 3],
    cos_lim: f32,
    inv_scale: f32,
    shape: Shape,
    carve: f32,
    frost: f32,
}

#[inline]
fn seg_dist(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (pax, pay, bax, bay) = (px - ax, py - ay, bx - ax, by - ay);
    let h = ((pax * bax + pay * bay) / (bax * bax + bay * bay)).clamp(0.0, 1.0);
    let (dx, dy) = (pax - bax * h, pay - bay * h);
    (dx * dx + dy * dy).sqrt()
}

/// Signed distance to a 6-fold symmetric snowflake (normalized units, rim ≈ 1).
fn flake_sdf(x: f32, y: f32, s: &Shape) -> f32 {
    let r = (x * x + y * y).sqrt();
    if s.disk {
        return r - 0.55;
    }
    let sector = PI / 3.0;
    let mut a = y.atan2(x);
    a -= (a / sector).round() * sector;
    let a = a.abs();
    let (px, py) = (r * a.cos(), r * a.sin());
    let (c60, s60) = (0.5f32, 0.866_025_4f32);

    let mut d = seg_dist(px, py, 0.0, 0.0, s.arm, 0.0) - s.thick;
    for k in 0..s.nb {
        let (bp, bl) = s.branches[k];
        let bd = seg_dist(px, py, bp, 0.0, bp + bl * c60, bl * s60) - s.thick * 0.8;
        d = d.min(bd);
    }
    if s.hex > 0.0 {
        let hd = seg_dist(px, py, s.hex, 0.0, s.hex * c60, s.hex * s60).abs() - s.thick * 0.7;
        d = d.min(hd);
    }
    // small diamond at the arm tip
    let tip = (px - s.arm).abs() + py.abs() * 1.6 - s.thick * 2.2;
    d.min(tip)
}

fn random_shape(rng: &mut Rng) -> Shape {
    let arm = rng.range(0.82, 0.95);
    let nb = 1 + (rng.f() * 3.0) as usize;
    let mut branches = [(0.0, 0.0); 3];
    for k in 0..nb {
        let pos = 0.28 + (k as f32 + rng.range(0.1, 0.7)) * (arm - 0.35) / nb as f32;
        let len = (rng.range(0.12, 0.34) * (1.0 - k as f32 * 0.22)).min(0.85 * pos);
        branches[k] = (pos, len);
    }
    let hex = if rng.f() < 0.55 { rng.range(0.14, 0.26) } else { 0.0 };
    Shape {
        arm,
        thick: rng.range(0.032, 0.05),
        branches,
        nb,
        hex,
        soft: 0.035,
        disk: false,
    }
}

fn make_flake(rng: &mut Rng, c: [f32; 3], radius: f32, shape: Shape, carve: f32, frost: f32) -> Flake {
    let up = if c[1].abs() > 0.95 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let tu0 = normalize(cross(up, c));
    let tv0 = cross(c, tu0);
    let rot = rng.range(0.0, 2.0 * PI);
    let (sr, cr) = rot.sin_cos();
    let tu = [
        tu0[0] * cr + tv0[0] * sr,
        tu0[1] * cr + tv0[1] * sr,
        tu0[2] * cr + tv0[2] * sr,
    ];
    let tv = cross(c, tu);
    Flake {
        c,
        tu,
        tv,
        cos_lim: (radius * 1.08).cos(),
        inv_scale: 1.0 / radius.tan(),
        shape,
        carve,
        frost,
    }
}

fn gaussian_blur(src: &mut [f32], w: usize, h: usize, sigma: f32) {
    let radius = (sigma * 3.0).ceil() as i32;
    let mut k: Vec<f32> = (-radius..=radius)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let s: f32 = k.iter().sum();
    k.iter_mut().for_each(|x| *x /= s);
    let mut tmp = vec![0.0f32; w * h];
    // horizontal (wraps around longitude)
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        for x in 0..w {
            let mut acc = 0.0;
            for (ki, kv) in k.iter().enumerate() {
                let xx = (x as i32 + ki as i32 - radius).rem_euclid(w as i32) as usize;
                acc += row[xx] * kv;
            }
            tmp[y * w + x] = acc;
        }
    }
    // vertical (clamped at the poles)
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (ki, kv) in k.iter().enumerate() {
                let yy = (y as i32 + ki as i32 - radius).clamp(0, h as i32 - 1) as usize;
                acc += tmp[yy * w + x] * kv;
            }
            src[y * w + x] = acc;
        }
    }
}

/// Bakes the engraving map for the sphere UVs.
/// RGBA8: R,G = tangent-space normal XY · B = frost (snow) mask · A = carve depth.
#[wasm_bindgen]
pub fn generate_engraving(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    let mut rng = Rng::new(seed as u64);
    let mut flakes: Vec<Flake> = Vec::new();

    // Big snowflakes, non-overlapping, kept away from the cap.
    let mut placed: Vec<([f32; 3], f32)> = Vec::new();
    let mut tries = 0;
    while placed.len() < 30 && tries < 6000 {
        tries += 1;
        let c = rng.unit_vec();
        if c[1] > 0.72 || c[1] < -0.82 {
            continue;
        }
        let r = rng.range(0.11, 0.24);
        if placed
            .iter()
            .any(|(pc, pr)| dot(*pc, c).clamp(-1.0, 1.0).acos() < (pr + r) * 0.95)
        {
            continue;
        }
        placed.push((c, r));
        let shape = random_shape(&mut rng);
        flakes.push(make_flake(&mut rng, c, r, shape, 1.0, 1.0));
    }
    // Small stars and soft snow speckles fill the gaps.
    for k in 0..520 {
        let c = rng.unit_vec();
        if c[1] > 0.8 {
            continue;
        }
        if placed
            .iter()
            .any(|(pc, pr)| dot(*pc, c).clamp(-1.0, 1.0).acos() < *pr * 1.05)
        {
            continue;
        }
        if k % 4 == 0 {
            let r = rng.range(0.035, 0.06);
            let mut s = random_shape(&mut rng);
            s.nb = 1;
            s.hex = 0.0;
            s.thick = 0.07;
            s.soft = 0.08;
            flakes.push(make_flake(&mut rng, c, r, s, 0.7, 0.9));
        } else {
            let r = rng.range(0.008, 0.02);
            let s = Shape {
                arm: 0.0,
                thick: 0.0,
                branches: [(0.0, 0.0); 3],
                nb: 0,
                hex: 0.0,
                soft: 0.45,
                disk: true,
            };
            let fr = rng.range(0.35, 0.8);
            flakes.push(make_flake(&mut rng, c, r, s, 0.25, fr));
        }
    }

    // Row buckets: which flakes can touch each texel row.
    let mut rows: Vec<Vec<u16>> = vec![Vec::new(); h];
    for (fi, f) in flakes.iter().enumerate() {
        let rho = f.cos_lim.clamp(-1.0, 1.0).acos();
        let tc = f.c[1].clamp(-1.0, 1.0).acos();
        let j0 = (((tc - rho) / PI) * h as f32).floor().max(0.0) as usize;
        let j1 = ((((tc + rho) / PI) * h as f32).ceil() as usize).min(h - 1);
        for row in rows.iter_mut().take(j1 + 1).skip(j0) {
            row.push(fi as u16);
        }
    }

    let mut carve = vec![0.0f32; w * h];
    let mut frost = vec![0.0f32; w * h];
    let phis: Vec<(f32, f32)> = (0..w)
        .map(|i| ((i as f32 + 0.5) / w as f32 * 2.0 * PI).sin_cos())
        .collect();

    for j in 0..h {
        let th = (j as f32 + 0.5) / h as f32 * PI;
        let (st, ct) = th.sin_cos();
        let cand = &rows[j];
        for i in 0..w {
            let (sp, cp) = phis[i];
            let p = [st * cp, ct, st * sp];
            let (mut cv, mut fr) = (0.0f32, 0.0f32);
            for &fi in cand {
                let f = &flakes[fi as usize];
                let d = dot(p, f.c);
                if d < f.cos_lim {
                    continue;
                }
                let lx = dot(p, f.tu) / d * f.inv_scale;
                let ly = dot(p, f.tv) / d * f.inv_scale;
                let sd = flake_sdf(lx, ly, &f.shape);
                let s = &f.shape;
                let g = smoothstep(s.soft, -s.thick.max(0.25 * s.soft), sd);
                let m = smoothstep(s.soft * 1.4, -s.soft * 0.4, sd);
                cv = cv.max(g * f.carve);
                fr = fr.max(m * f.frost);
            }
            // Snow drift hugging the lower hemisphere, with grainy edge.
            if p[1] < -0.15 {
                let t = -0.52 + 0.22 * (fbm([p[0] * 2.4, p[1] * 2.4, p[2] * 2.4], 4) - 0.5) * 2.0;
                let drift = smoothstep(t + 0.10, t - 0.14, p[1]);
                if drift > 0.0 {
                    let grain = value_noise([p[0] * 110.0, p[1] * 110.0, p[2] * 110.0]);
                    fr = fr.max(drift * (0.62 + 0.38 * grain));
                    cv = cv.max(drift * grain * 0.22);
                }
            }
            carve[j * w + i] = cv;
            frost[j * w + i] = fr;
        }
    }

    // "Difuminado": soften both the relief and the frost.
    gaussian_blur(&mut carve, w, h, 1.1);
    gaussian_blur(&mut frost, w, h, 2.2);

    // Height → tangent-space normal (T = +u east, B = +v south).
    let depth = 0.0065f32;
    let arc_b = PI / h as f32;
    let mut out = vec![0u8; w * h * 4];
    for j in 0..h {
        let th = (j as f32 + 0.5) / h as f32 * PI;
        let arc_t = (2.0 * PI * th.sin().max(0.05)) / w as f32;
        let jm = j.saturating_sub(1);
        let jp = (j + 1).min(h - 1);
        for i in 0..w {
            let im = (i + w - 1) % w;
            let ip = (i + 1) % w;
            let gx = (carve[j * w + ip] - carve[j * w + im]) / (2.0 * arc_t);
            let gy = (carve[jp * w + i] - carve[jm * w + i]) / ((jp - jm).max(1) as f32 * arc_b);
            let nx = (gx * depth).clamp(-1.0, 1.0);
            let ny = (gy * depth).clamp(-1.0, 1.0);
            let o = (j * w + i) * 4;
            out[o] = ((nx * 0.5 + 0.5) * 255.0).round() as u8;
            out[o + 1] = ((ny * 0.5 + 0.5) * 255.0).round() as u8;
            out[o + 2] = (frost[j * w + i].clamp(0.0, 1.0) * 255.0).round() as u8;
            out[o + 3] = (carve[j * w + i].clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    out
}

// ───────────────────────────── light probe ─────────────────────────────

/// Projects each (downsampled) camera frame onto L2 spherical harmonics using the
/// same equidistant "fisheye" mapping the GPU uses to wrap the frame around the
/// environment, so the frost's diffuse light matches the reflection.
#[wasm_bindgen]
pub struct LightProbe {
    w: usize,
    h: usize,
    pixels: Vec<u8>,
    out: Vec<f32>,
    lut: Vec<f32>,
    primed: bool,
    theta_cached: f32,
    weights: Vec<[f32; 9]>,
    omega_sum: f32,
}

#[wasm_bindgen]
impl LightProbe {
    #[wasm_bindgen(constructor)]
    pub fn new(w: u32, h: u32) -> LightProbe {
        let lut = (0..256)
            .map(|i| {
                let c = i as f32 / 255.0;
                if c <= 0.04045 {
                    c / 12.92
                } else {
                    ((c + 0.055) / 1.055).powf(2.4)
                }
            })
            .collect();
        LightProbe {
            w: w as usize,
            h: h as usize,
            pixels: vec![0; (w * h * 4) as usize],
            out: vec![0.0; 40],
            lut,
            primed: false,
            theta_cached: f32::NAN,
            weights: vec![[0.0; 9]; (w * h) as usize],
            omega_sum: 0.0,
        }
    }

    pub fn pixels_ptr(&self) -> *const u8 {
        self.pixels.as_ptr()
    }

    /// 9 × vec4 SH (rgb, pad) followed by vec4(avg linear rgb, avg luminance).
    pub fn out_ptr(&self) -> *const f32 {
        self.out.as_ptr()
    }

    pub fn update(&mut self, theta_max: f32, smoothing: f32) {
        // Direction, solid-angle and SH basis depend only on projection and size,
        // not on the image. Cache them until the user changes the aperture.
        if self.theta_cached != theta_max {
            self.rebuild_weights(theta_max);
        }
        let mut acc = [[0.0f32; 3]; 9];
        let mut avg = [0.0f32; 3];
        for (pixel, weights) in self.pixels.chunks_exact(4).zip(&self.weights) {
            let col = [
                self.lut[pixel[0] as usize],
                self.lut[pixel[1] as usize],
                self.lut[pixel[2] as usize],
            ];
            for c in 0..3 { avg[c] += col[c]; }
            for (k, &weight) in weights.iter().enumerate() {
                for c in 0..3 { acc[k][c] += col[c] * weight; }
            }
        }
        let n = (self.w * self.h) as f32;
        let avg = [avg[0] / n, avg[1] / n, avg[2] / n];
        // Whatever the camera can't see: a dim, uniform room.
        let rest = (4.0 * PI - self.omega_sum).max(0.0);
        for c in 0..3 {
            acc[0][c] += avg[c] * 0.35 * 0.282_095 * rest;
        }
        // Lambert convolution (Ramamoorthi & Hanrahan) divided by π.
        let band = [1.0, 2.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0, 0.25, 0.25, 0.25, 0.25, 0.25];

        let s = if self.primed { smoothing.clamp(0.0, 1.0) } else { 1.0 };
        self.primed = true;
        for k in 0..9 {
            for c in 0..3 {
                let target = acc[k][c] * band[k];
                let cur = &mut self.out[k * 4 + c];
                *cur += (target - *cur) * s;
            }
        }
        let lum = 0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2];
        let tail = [avg[0], avg[1], avg[2], lum];
        for c in 0..4 {
            let cur = &mut self.out[36 + c];
            *cur += (tail[c] - *cur) * s;
        }
    }
}

impl LightProbe {
    fn rebuild_weights(&mut self, theta_max: f32) {
        self.theta_cached = theta_max;
        self.omega_sum = 0.0;
        let aspect = self.w as f32 / self.h as f32;
        let px_area = (2.0 / self.w as f32 * theta_max).powi(2);
        for y in 0..self.h {
            let dy = (0.5 - (y as f32 + 0.5) / self.h as f32) * 2.0 / aspect;
            for x in 0..self.w {
                let dx = (0.5 - (x as f32 + 0.5) / self.w as f32) * 2.0;
                let r = (dx * dx + dy * dy).sqrt();
                let theta = r * theta_max;
                let weight = &mut self.weights[y * self.w + x];
                if theta >= PI {
                    *weight = [0.0; 9];
                    continue;
                }
                let (st, z) = theta.sin_cos();
                let scale = if r > 1e-6 { st / r } else { theta_max };
                let (dxv, dyv) = (dx * scale, dy * scale);
                let solid_angle = px_area * if theta > 1e-4 { st / theta } else { 1.0 };
                self.omega_sum += solid_angle;
                let basis = [
                    0.282_095, 0.488_603 * dyv, 0.488_603 * z, 0.488_603 * dxv,
                    1.092_548 * dxv * dyv, 1.092_548 * dyv * z,
                    0.315_392 * (3.0 * z * z - 1.0), 1.092_548 * dxv * z,
                    0.546_274 * (dxv * dxv - dyv * dyv),
                ];
                for (out, value) in weight.iter_mut().zip(basis) { *out = value * solid_angle; }
            }
        }
    }
}
