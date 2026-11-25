/* tslint:disable */
/* eslint-disable */

/**
 * Projects each (downsampled) camera frame onto L2 spherical harmonics using the
 * same equidistant "fisheye" mapping the GPU uses to wrap the frame around the
 * environment, so the frost's diffuse light matches the reflection.
 */
export class LightProbe {
    free(): void;
    [Symbol.dispose](): void;
    constructor(w: number, h: number);
    /**
     * 9 × vec4 SH (rgb, pad) followed by vec4(avg linear rgb, avg luminance).
     */
    out_ptr(): number;
    pixels_ptr(): number;
    update(theta_max: number, smoothing: number): void;
}

export class Mesh {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly indices: Uint32Array;
    readonly vertices: Float32Array;
}

/**
 * Fluted ornament cap (lathe) + wire loop, with normals from face accumulation.
 */
export function build_cap(segments: number): Mesh;

/**
 * Smooth UV sphere. v = 0 at the north pole, u wraps around Y.
 */
export function build_sphere(lon: number, lat: number, radius: number): Mesh;

/**
 * Bakes the engraving map for the sphere UVs.
 * RGBA8: R,G = tangent-space normal XY · B = frost (snow) mask · A = carve depth.
 */
export function generate_engraving(w: number, h: number, seed: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_lightprobe_free: (a: number, b: number) => void;
    readonly __wbg_mesh_free: (a: number, b: number) => void;
    readonly build_cap: (a: number) => number;
    readonly build_sphere: (a: number, b: number, c: number) => number;
    readonly generate_engraving: (a: number, b: number, c: number) => [number, number];
    readonly lightprobe_new: (a: number, b: number) => number;
    readonly lightprobe_out_ptr: (a: number) => number;
    readonly lightprobe_pixels_ptr: (a: number) => number;
    readonly lightprobe_update: (a: number, b: number, c: number) => void;
    readonly mesh_indices: (a: number) => [number, number];
    readonly mesh_vertices: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
