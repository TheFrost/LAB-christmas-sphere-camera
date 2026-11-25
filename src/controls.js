// Basic orbit controls. Because the webcam reflection is anchored to the viewer,
// orbiting is implemented as a free (trackball-style) rotation of the ornament
// around the screen axes — no gimbal lock, every direction reachable — plus zoom.
import { quatFromAxisAngle, quatMul, quatNormalize, quatSlerp } from './math.js';

const HOME = quatNormalize(quatFromAxisAngle(1, 0, 0, 0.18));

export class OrbitControls {
  constructor(el, { distance = 5.2, min = 2.4, max = 9 } = {}) {
    this.el = el;
    this.q = HOME.slice();
    this.vel = [0, 0];          // angular velocity (rad/s) around screen Y, X
    this.distance = distance;
    this.targetDistance = distance;
    this.min = min;
    this.max = max;
    this.homeDistance = distance;
    this.autoRotate = true;
    this.pointers = new Map();
    this.dragging = false;
    this.pinchStart = 0;
    this.resetting = 0;
    this.lastMove = 0;
    this.pending = [0, 0];

    el.addEventListener('pointerdown', (e) => this.#down(e));
    window.addEventListener('pointermove', (e) => this.#move(e));
    window.addEventListener('pointerup', (e) => this.#up(e));
    window.addEventListener('pointercancel', (e) => this.#up(e));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0012));
      this.targetDistance = clamp(this.targetDistance * k, min, max);
    }, { passive: false });
    el.addEventListener('dblclick', () => this.reset());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset() {
    this.resetting = 1;
    this.vel = [0, 0];
    this.targetDistance = this.homeDistance;
  }

  #down(e) {
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) this.pinchStart = this.#pinchDist() * this.targetDistance;
    this.dragging = true;
    this.resetting = 0;
    this.vel = [0, 0];
    this.el.classList.add('grabbing');
  }

  #move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.pointers.size >= 2) {
      const d = this.#pinchDist();
      // fingers spread → camera closer (distance × pinch stays constant)
      if (this.pinchStart > 0) this.targetDistance = clamp(this.pinchStart / Math.max(d, 1), this.min, this.max);
      return;
    }
    this.pending[0] += dx;
    this.pending[1] += dy;
    this.lastMove = performance.now();
  }

  #up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStart = 0;
    if (this.pointers.size === 0) {
      this.dragging = false;
      this.el.classList.remove('grabbing');
      if (performance.now() - this.lastMove > 80) this.vel = [0, 0];
    }
  }

  #pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  #rotate(ay, ax) {
    // ay: around screen Y (horizontal drag), ax: around screen X (vertical drag)
    const angle = Math.hypot(ax, ay);
    if (angle < 1e-7) return;
    const r = quatFromAxisAngle(ax, ay, 0, angle);
    this.q = quatNormalize(quatMul(r, this.q));
  }

  update(dt) {
    const speed = 0.0065; // rad per CSS pixel
    if (this.dragging) {
      const [px, py] = this.pending;
      this.#rotate(px * speed, py * speed);
      if (dt > 0) {
        const k = 1 - Math.exp(-dt * 25);
        this.vel[0] += ((px * speed) / dt - this.vel[0]) * k;
        this.vel[1] += ((py * speed) / dt - this.vel[1]) * k;
      }
    } else {
      this.#rotate(this.vel[0] * dt, this.vel[1] * dt);
      const damp = Math.exp(-dt * 3.2);
      this.vel[0] *= damp;
      this.vel[1] *= damp;
      if (this.autoRotate && !this.resetting && Math.hypot(...this.vel) < 0.15) {
        // gentle spin around the ornament's own hanging axis
        const spin = quatFromAxisAngle(0, 1, 0, dt * 0.22);
        this.q = quatNormalize(quatMul(this.q, spin));
      }
    }
    this.pending = [0, 0];

    if (this.resetting) {
      this.q = quatSlerp(this.q, HOME, 1 - Math.exp(-dt * 6));
      this.resetting -= dt * 0.6;
      if (this.resetting <= 0) this.resetting = 0;
    }
    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-dt * 8));
  }
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
