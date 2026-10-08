/* Frugends Surprise Box — engine v4
 * Baked rigid-body sim + scroll-scrubbed playback + Frugends energy detonation.
 * Box: 40 x 30 x 20 cm. Units = metres. Local space, y up.
 *
 * v4 changes (BURST only)
 *  - flush two-layer lid stack: no daylight between wall and closed flaps
 *  - depth-tested ignition inside the carton, then a fast screen takeover
 *  - explosion/whiteout locked to the actual product launch
 *  - procedural fibre, grain, roughness and bump maps for realistic board
 *
 * v3 changes
 *  - finite-height wall contacts use the rendered article extents; bodies may
 *    cross the carton footprint only after their complete shape clears the rim
 *  - incoming articles are guided over the open mouth instead of tunnelling
 *    through a side wall at high speed
 *  - flap board thickness grows away from the hinge, and burst flaps open in
 *    two collision-free layers before the contents start moving
 *
 * v2 changes
 *  - RSC carton with four 15 cm flaps; PACK retains its original two-layer
 *    closure. BURST now uses score-aligned wall/flap ends instead of a cap.
 *  - multi-sphere collision proxies (1-3 per body along the long axis)
 *  - bigger objects, up to 25 cm
 *  - scene "burst": lid blows, objects hang sharp in bullet time, then a
 *    full-screen energy detonation takes the frame and blows out to white.
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var BOX = { w: 0.40, d: 0.30, h: 0.20, t: 0.004 };
  var FLAP = BOX.d / 2;             // 15 cm — RSC: half the SHORT side
  var TILT = 9 * DEG;
  var DT = 1 / 120;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(x) { return x * x * (3 - 2 * x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ramp(x, a, b) { return clamp((x - a) / (b - a), 0, 1); }

  /* ------------------------------------------------------- object catalog
   * Real article sizes for a 40x30x20 carton. Largest is the 25 cm muesli
   * carton lying flat. Total volume is ~39% of the cavity, which compacts
   * into a genuinely full box that still closes.
   * slot:true = reserved for a real brand packshot (gold cage in greybox).
   */
  var CATALOG = [
    { id: 'muesli',      kind: 'box',    he: [0.082, 0.029, 0.110], m: 0.45, col: 0xc9bce4, slot: true },
    { id: 'gummi-gr-a',  kind: 'pillow', he: [0.074, 0.023, 0.094], m: 0.30, col: 0x9a86d6, slot: true },
    { id: 'dose-05-a',   kind: 'can',    he: [0.033, 0.084, 0.033], m: 0.52, col: 0xb9bdd4, slot: true },
    { id: 'gummi-kl-a',  kind: 'pillow', he: [0.042, 0.013, 0.056], m: 0.10, col: 0xe0d4f0 },
    { id: 'schoko-a',    kind: 'box',    he: [0.080, 0.005, 0.040], m: 0.10, col: 0x6e5fa8 },
    { id: 'deo-a',       kind: 'deo',    he: [0.025, 0.085, 0.025], m: 0.18, col: 0xd5d7e0 },
    { id: 'gummi-gr-b',  kind: 'pillow', he: [0.070, 0.022, 0.088], m: 0.28, col: 0xb49be0 },
    { id: 'gummi-kl-b',  kind: 'pillow', he: [0.040, 0.012, 0.054], m: 0.09, col: 0xcfc3e8 },
    { id: 'dose-05-b',   kind: 'can',    he: [0.033, 0.084, 0.033], m: 0.52, col: 0x8a8fb5 },
    { id: 'schoko-b',    kind: 'box',    he: [0.078, 0.005, 0.039], m: 0.10, col: 0x7c5cbf },
    { id: 'gummi-kl-c',  kind: 'pillow', he: [0.043, 0.013, 0.057], m: 0.10, col: 0xe8dcf5 },
    { id: 'deo-b',       kind: 'deo',    he: [0.024, 0.082, 0.024], m: 0.17, col: 0xaeb3d0 },
    { id: 'gummi-kl-d',  kind: 'pillow', he: [0.040, 0.012, 0.052], m: 0.09, col: 0xc0b2de }
  ];

  /* -------- collision proxy: 1-3 spheres strung along the longest axis --- */
  function proxySpheres(he) {
    var ax = 0;
    if (he[1] > he[ax]) ax = 1;
    if (he[2] > he[ax]) ax = 2;
    var o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
    var rad = Math.hypot(he[o1], he[o2]) * 0.92;
    var n = clamp(Math.round(he[ax] / Math.max(rad, 1e-4)), 1, 3);
    var out = [];
    if (n === 1) { out.push({ o: [0, 0, 0], r: Math.hypot(he[0], he[1], he[2]) * 0.80 }); return out; }
    var reach = Math.max(he[ax] - rad, 0);
    for (var i = 0; i < n; i++) {
      var f = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      var o = [0, 0, 0]; o[ax] = f * reach;
      out.push({ o: o, r: rad });
    }
    return out;
  }

  /* Half-extents of the ACTUAL rendered geometry, which is larger than the
   * collision box for bags (crimp fins overhang the body) — the tuck has to
   * clamp against these or it is systematically too optimistic.
   */
  function meshExtents(def, he) {
    if (def.kind === 'pillow') return [he[0], he[1], he[2] * 0.97 + he[1] * 0.275];
    return [he[0], he[1], he[2]];
  }

  function makeBodies(count, sizeScale) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var c = CATALOG[i % CATALOG.length];
      var he = [c.he[0] * sizeScale, c.he[1] * sizeScale, c.he[2] * sizeScale];
      var r = Math.hypot(he[0], he[1], he[2]);
      out.push({
        def: c, he: he, ext: meshExtents(c, he), m: c.m, inv: 1 / c.m, I: c.m * r * r * 0.42,
        sph: proxySpheres(he), rBound: r,
        p: [0, 0, 0], prevP: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0],
        t0: 0, asleep: false, sleepT: 0
      });
    }
    return out;
  }

  function qMulVec(q, v, out) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var ix = w * v[0] + y * v[2] - z * v[1];
    var iy = w * v[1] + z * v[0] - x * v[2];
    var iz = w * v[2] + x * v[1] - y * v[0];
    var iw = -x * v[0] - y * v[1] - z * v[2];
    out[0] = ix * w + iw * -x + iy * -z - iz * -y;
    out[1] = iy * w + iw * -y + iz * -x - ix * -z;
    out[2] = iz * w + iw * -z + ix * -y - iy * -x;
    return out;
  }
  function randQuat(rng, q) {
    var u = rng(), v = rng(), w = rng();
    var s1 = Math.sqrt(1 - u), s2 = Math.sqrt(u);
    q[0] = s1 * Math.sin(2 * Math.PI * v); q[1] = s1 * Math.cos(2 * Math.PI * v);
    q[2] = s2 * Math.sin(2 * Math.PI * w); q[3] = s2 * Math.cos(2 * Math.PI * w);
  }

  var CAV = { x: BOX.w / 2 - BOX.t, z: BOX.d / 2 - BOX.t, yFloor: BOX.t, yRim: BOX.h };

  function step(bodies, g, dt, contain, ballistic) {
    var i, k, b;
    var corner = [0, 0, 0], rc = [0, 0, 0], so = [0, 0, 0];

    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (b.asleep) continue;
      b.prevP[0] = b.p[0]; b.prevP[1] = b.p[1]; b.prevP[2] = b.p[2];
      b.v[0] += g[0] * dt; b.v[1] += g[1] * dt; b.v[2] += g[2] * dt;
      b.p[0] += b.v[0] * dt; b.p[1] += b.v[1] * dt; b.p[2] += b.v[2] * dt;
      var q = b.q, w = b.w;
      var dx = 0.5 * (w[0] * q[3] + w[1] * q[2] - w[2] * q[1]) * dt;
      var dy = 0.5 * (w[1] * q[3] + w[2] * q[0] - w[0] * q[2]) * dt;
      var dz = 0.5 * (w[2] * q[3] + w[0] * q[1] - w[1] * q[0]) * dt;
      var dw = 0.5 * (-w[0] * q[0] - w[1] * q[1] - w[2] * q[2]) * dt;
      q[0] += dx; q[1] += dy; q[2] += dz; q[3] += dw;
      var n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
      b.v[0] *= 0.9992; b.v[1] *= 0.9992; b.v[2] *= 0.9992;
      b.w[0] *= 0.994; b.w[1] *= 0.994; b.w[2] *= 0.994;
    }
    /* --- rendered corners vs a FINITE carton shell -----------------------
     * The old solver classified a body only by its centre. An incoming item
     * whose centre was outside therefore saw just the ground, not the wall;
     * one whose centre crossed inside in a single 120 Hz step was teleported
     * through the board. It also ignored the larger crimp fins of bags.
     *
     * During packing, keep the lowest rendered corner above the rim until the
     * complete horizontal footprint is over the mouth. The item then drops
     * naturally. During the burst, the previous centre decides which face of
     * a wall owns a fast-moving body, preventing one-frame tunnelling.
     */
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (b.asleep) continue;

      if (contain || ballistic) {
        var gMinX = 1e9, gMaxX = -1e9, gMinY = 1e9, gMinZ = 1e9, gMaxZ = -1e9;
        for (k = 0; k < 8; k++) {
          corner[0] = (k & 1 ? 1 : -1) * b.ext[0];
          corner[1] = (k & 2 ? 1 : -1) * b.ext[1];
          corner[2] = (k & 4 ? 1 : -1) * b.ext[2];
          qMulVec(b.q, corner, rc);
          var gx = b.p[0] + rc[0], gy = b.p[1] + rc[1], gz = b.p[2] + rc[2];
          if (gx < gMinX) gMinX = gx; if (gx > gMaxX) gMaxX = gx;
          if (gy < gMinY) gMinY = gy;
          if (gz < gMinZ) gMinZ = gz; if (gz > gMaxZ) gMaxZ = gz;
        }
        var overMouth = gMinX >= -CAV.x && gMaxX <= CAV.x && gMinZ >= -CAV.z && gMaxZ <= CAV.z;
        var rimClearance = CAV.yRim + 0.002;
        if (!overMouth && gMinY < rimClearance) {
          b.p[1] += rimClearance - gMinY;
          if (b.v[1] < 0) b.v[1] = 0;
          // Excess pitch/roll can keep a long pack permanently hooked on the
          // rim. Damping those components reads as a real cardboard contact.
          b.w[0] *= 0.80; b.w[2] *= 0.80;
        }
      }

      var inside = Math.abs(b.p[0]) < CAV.x && Math.abs(b.p[2]) < CAV.z;
      var wasInside = Math.abs(b.prevP[0]) < CAV.x && Math.abs(b.prevP[2]) < CAV.z;
      // baked shot only: nudge strays back over the mouth instead of letting
      // them skitter across the floor where nobody wants them
      if (contain && !inside) {
        var ox = Math.max(Math.abs(b.p[0]) - CAV.x * 0.55, 0) * Math.sign(b.p[0]);
        var oz = Math.max(Math.abs(b.p[2]) - CAV.z * 0.55, 0) * Math.sign(b.p[2]);
        b.v[0] -= ox * 26 * dt; b.v[2] -= oz * 26 * dt;
        b.asleep = false; b.sleepT = 0;
      }
      for (var pass = 0; pass < 6; pass++) {
        var deepest = 0, nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
        for (k = 0; k < 8; k++) {
          corner[0] = (k & 1 ? 1 : -1) * b.ext[0];
          corner[1] = (k & 2 ? 1 : -1) * b.ext[1];
          corner[2] = (k & 4 ? 1 : -1) * b.ext[2];
          qMulVec(b.q, corner, rc);
          var wx = b.p[0] + rc[0], wy = b.p[1] + rc[1], wz = b.p[2] + rc[2];
          var pen, on = 0, onx = 0, ony = 0, onz = 0;
          if (inside || wasInside) {
            pen = CAV.yFloor - wy; if (pen > on) { on = pen; onx = 0; ony = 1; onz = 0; }
            // Side walls stop at the rim. Corners above it are free to cross.
            if (wy < CAV.yRim) {
              pen = wx - CAV.x; if (pen > on) { on = pen; onx = -1; ony = 0; onz = 0; }
              pen = -CAV.x - wx; if (pen > on) { on = pen; onx = 1; ony = 0; onz = 0; }
              pen = wz - CAV.z; if (pen > on) { on = pen; onx = 0; ony = 0; onz = -1; }
              pen = -CAV.z - wz; if (pen > on) { on = pen; onx = 0; ony = 0; onz = 1; }
            }
          } else {
            pen = -wy; if (pen > on) { on = pen; onx = 0; ony = 1; onz = 0; }
            // Exterior faces: an object falling beside the box may hit the
            // board, but can never be pulled through to the cavity.
            if (wy > 0 && wy < CAV.yRim) {
              if (b.p[0] >= CAV.x && Math.abs(wz) <= BOX.d / 2) {
                pen = BOX.w / 2 - wx; if (pen > on) { on = pen; onx = 1; ony = 0; onz = 0; }
              } else if (b.p[0] <= -CAV.x && Math.abs(wz) <= BOX.d / 2) {
                pen = wx + BOX.w / 2; if (pen > on) { on = pen; onx = -1; ony = 0; onz = 0; }
              }
              if (b.p[2] >= CAV.z && Math.abs(wx) <= BOX.w / 2) {
                pen = BOX.d / 2 - wz; if (pen > on) { on = pen; onx = 0; ony = 0; onz = 1; }
              } else if (b.p[2] <= -CAV.z && Math.abs(wx) <= BOX.w / 2) {
                pen = wz + BOX.d / 2; if (pen > on) { on = pen; onx = 0; ony = 0; onz = -1; }
              }
            }
          }
          if (on > deepest) { deepest = on; nx = onx; ny = ony; nz = onz; cx = rc[0]; cy = rc[1]; cz = rc[2]; }
        }
        if (deepest <= 0) break;
        b.p[0] += nx * deepest; b.p[1] += ny * deepest; b.p[2] += nz * deepest;
        var vcx = b.v[0] + (b.w[1] * cz - b.w[2] * cy);
        var vcy = b.v[1] + (b.w[2] * cx - b.w[0] * cz);
        var vcz = b.v[2] + (b.w[0] * cy - b.w[1] * cx);
        var vn = vcx * nx + vcy * ny + vcz * nz;
        if (vn < 0) {
          var j = -(1 + 0.10) * vn / (b.inv + (cx * cx + cy * cy + cz * cz) / b.I + 1e-9);
          var jx = nx * j, jy = ny * j, jz = nz * j;
          b.v[0] += jx * b.inv; b.v[1] += jy * b.inv; b.v[2] += jz * b.inv;
          b.w[0] += (cy * jz - cz * jy) / b.I * 0.5;
          b.w[1] += (cz * jx - cx * jz) / b.I * 0.5;
          b.w[2] += (cx * jy - cy * jx) / b.I * 0.5;
          var dn = b.v[0] * nx + b.v[1] * ny + b.v[2] * nz;
          b.v[0] -= (b.v[0] - nx * dn) * 0.32;
          b.v[1] -= (b.v[1] - ny * dn) * 0.32;
          b.v[2] -= (b.v[2] - nz * dn) * 0.32;
          b.w[0] *= 0.82; b.w[1] *= 0.82; b.w[2] *= 0.82;
        }
      }
      if (Math.hypot(b.v[0], b.v[1], b.v[2]) < 0.014 &&
          Math.hypot(b.w[0], b.w[1], b.w[2]) < 0.16 && b.p[1] < CAV.yRim + 0.02) {
        b.sleepT += dt;
        if (b.sleepT > 0.3) { b.asleep = true; b.v[0] = b.v[1] = b.v[2] = 0; b.w[0] = b.w[1] = b.w[2] = 0; }
      } else b.sleepT = 0;
    }

    // The first burst frames still collide with the carton, but not with each
    // other: wall response preserves the shell while zero mutual friction
    // preserves the violent launch.
    if (ballistic) return;

    // --- body vs body, multi-sphere
    for (i = 0; i < bodies.length; i++) {
      var A = bodies[i];
      for (var jj = i + 1; jj < bodies.length; jj++) {
        var B = bodies[jj];
        var bdx = B.p[0] - A.p[0], bdy = B.p[1] - A.p[1], bdz = B.p[2] - A.p[2];
        var bd2 = bdx * bdx + bdy * bdy + bdz * bdz;
        var br = A.rBound + B.rBound;
        if (bd2 > br * br) continue;
        for (var sa = 0; sa < A.sph.length; sa++) {
          qMulVec(A.q, A.sph[sa].o, rc);
          var ax = A.p[0] + rc[0], ay = A.p[1] + rc[1], az = A.p[2] + rc[2];
          for (var sb = 0; sb < B.sph.length; sb++) {
            qMulVec(B.q, B.sph[sb].o, so);
            var bx = B.p[0] + so[0], by = B.p[1] + so[1], bz = B.p[2] + so[2];
            var ddx = bx - ax, ddy = by - ay, ddz = bz - az;
            var d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            var rr = A.sph[sa].r + B.sph[sb].r;
            if (d2 > rr * rr || d2 < 1e-10) continue;
            var d = Math.sqrt(d2), iv = 1 / d;
            var Nx = ddx * iv, Ny = ddy * iv, Nz = ddz * iv;
            var pen2 = (rr - d) * 0.62;
            var wA = A.asleep ? 0 : A.inv, wB = B.asleep ? 0 : B.inv;
            var ws = wA + wB; if (ws <= 0) continue;
            A.p[0] -= Nx * pen2 * (wA / ws); A.p[1] -= Ny * pen2 * (wA / ws); A.p[2] -= Nz * pen2 * (wA / ws);
            B.p[0] += Nx * pen2 * (wB / ws); B.p[1] += Ny * pen2 * (wB / ws); B.p[2] += Nz * pen2 * (wB / ws);
            var rvn = (B.v[0] - A.v[0]) * Nx + (B.v[1] - A.v[1]) * Ny + (B.v[2] - A.v[2]) * Nz;
            if (rvn < 0) {
              var ji = -(1 + 0.20) * rvn / ws;
              A.v[0] -= Nx * ji * wA; A.v[1] -= Ny * ji * wA; A.v[2] -= Nz * ji * wA;
              B.v[0] += Nx * ji * wB; B.v[1] += Ny * ji * wB; B.v[2] += Nz * ji * wB;
              var spin = ji * 1.5;
              A.w[0] += (rc[1] * Nz - rc[2] * Ny) * spin * wA;
              A.w[2] += (rc[0] * Ny - rc[1] * Nx) * spin * wA;
              B.w[0] -= (so[1] * Nz - so[2] * Ny) * spin * wB;
              B.w[2] -= (so[0] * Ny - so[1] * Nx) * spin * wB;
              A.asleep = false; B.asleep = false; A.sleepT = 0; B.sleepT = 0;
            }
          }
        }
      }
    }
  }

  function record(bodies, frames, f) {
    var o = f * bodies.length * 7;
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i], k = o + i * 7;
      frames[k] = b.p[0]; frames[k + 1] = b.p[1]; frames[k + 2] = b.p[2];
      frames[k + 3] = b.q[0]; frames[k + 4] = b.q[1]; frames[k + 5] = b.q[2]; frames[k + 6] = b.q[3];
    }
  }

  var GL = [0, -9.81 * Math.cos(TILT), 9.81 * Math.sin(TILT)];

  /* ---- hard tuck: press every body inside the cavity and below the rim.
   * Runs only in the compaction phase, a few millimetres per step, so it
   * reads as settling rather than snapping. This is what guarantees the
   * carton can actually close on its contents.
   */
  /* Orientation for bulky articles: longest axis horizontal, flattest face
   * down, random yaw. A 23 cm carton and a 0.5 l can both only fit a 20 cm
   * cavity lying down — and that is how you would pack them by hand anyway.
   */
  function restQuat(he, yaw, q) {
    var L = 0, S = 0;
    if (he[1] > he[L]) L = 1; if (he[2] > he[L]) L = 2;
    if (he[1] < he[S]) S = 1; if (he[2] < he[S]) S = 2;
    if (S === L) S = (L + 1) % 3;
    var M = 3 - L - S;
    var cols = [null, null, null];
    cols[L] = [1, 0, 0]; cols[S] = [0, 1, 0]; cols[M] = [0, 0, 1];
    var det = cols[0][0] * (cols[1][1] * cols[2][2] - cols[1][2] * cols[2][1])
            - cols[1][0] * (cols[0][1] * cols[2][2] - cols[0][2] * cols[2][1])
            + cols[2][0] * (cols[0][1] * cols[1][2] - cols[0][2] * cols[1][1]);
    if (det < 0) cols[M] = [-cols[M][0], -cols[M][1], -cols[M][2]];
    var m00 = cols[0][0], m01 = cols[1][0], m02 = cols[2][0];
    var m10 = cols[0][1], m11 = cols[1][1], m12 = cols[2][1];
    var m20 = cols[0][2], m21 = cols[1][2], m22 = cols[2][2];
    var tr = m00 + m11 + m22, s, bq;
    if (tr > 0) { s = 0.5 / Math.sqrt(tr + 1); bq = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
    else if (m00 > m11 && m00 > m22) { s = 2 * Math.sqrt(1 + m00 - m11 - m22); bq = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { s = 2 * Math.sqrt(1 + m11 - m00 - m22); bq = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
    else { s = 2 * Math.sqrt(1 + m22 - m00 - m11); bq = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
    var ys = Math.sin(yaw * 0.5), yc = Math.cos(yaw * 0.5);   // yaw about world Y
    q[0] = yc * bq[0] + ys * bq[2];
    q[1] = yc * bq[1] + ys * bq[3];
    q[2] = yc * bq[2] - ys * bq[0];
    q[3] = yc * bq[3] - ys * bq[1];
    var n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
  }

  function tuckStep(bodies, lim, damp) {
    var c = [0, 0, 0], rc = [0, 0, 0];
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      var maxY = -1e9, minY = 1e9, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (var k = 0; k < 8; k++) {
        c[0] = (k & 1 ? 1 : -1) * b.ext[0];
        c[1] = (k & 2 ? 1 : -1) * b.ext[1];
        c[2] = (k & 4 ? 1 : -1) * b.ext[2];
        qMulVec(b.q, c, rc);
        var x = b.p[0] + rc[0], y = b.p[1] + rc[1], z = b.p[2] + rc[2];
        if (y > maxY) maxY = y; if (y < minY) minY = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      var ceil = CAV.yRim - 0.004, lx = CAV.x - 0.002, lz = CAV.z - 0.002, moved = false;
      var overMouth = minX >= -lx && maxX <= lx && minZ >= -lz && maxZ <= lz;
      if (!overMouth) {
        // Never compact sideways through a wall. Lift the complete rendered
        // shape above the rim, guide it across the mouth, then let the normal
        // branch lower it. The hard phase may guide faster, but not teleport.
        var lift = CAV.yRim + 0.002 - minY;
        if (lift > 0) { b.p[1] += lift; minY += lift; maxY += lift; b.v[1] = Math.max(b.v[1], 0); moved = true; }
        if (damp) {
          var shiftX = maxX > lx ? lx - maxX : minX < -lx ? -lx - minX : 0;
          var shiftZ = maxZ > lz ? lz - maxZ : minZ < -lz ? -lz - minZ : 0;
          if (shiftX) { b.p[0] += clamp(shiftX, -lim, lim); moved = true; }
          if (shiftZ) { b.p[2] += clamp(shiftZ, -lim, lim); moved = true; }
        }
        b.v[0] *= damp ? 0.72 : 0.92; b.v[1] *= 0.72; b.v[2] *= damp ? 0.72 : 0.92;
        b.w[0] *= 0.62; b.w[1] *= 0.82; b.w[2] *= 0.62;
        if (moved) { b.asleep = false; b.sleepT = 0; }
        continue;
      }

      var down = maxY > ceil ? Math.min(maxY - ceil, lim) : 0;
      if (down) { b.p[1] -= down; minY -= down; maxY -= down; b.v[1] = Math.min(b.v[1], 0); moved = true; }
      // Apply the floor bound after the ceiling move, using the updated value.
      // This closes the transient one-frame floor penetration from v2.
      if (minY < CAV.yFloor) { var up = CAV.yFloor - minY; b.p[1] += up; minY += up; maxY += up; b.v[1] = Math.max(b.v[1], 0); moved = true; }
      if (maxX > lx) { b.p[0] -= Math.min(maxX - lx, lim); moved = true; }
      if (minX < -lx) { b.p[0] += Math.min(-lx - minX, lim); moved = true; }
      if (maxZ > lz) { b.p[2] -= Math.min(maxZ - lz, lim); moved = true; }
      if (minZ < -lz) { b.p[2] += Math.min(-lz - minZ, lim); moved = true; }
      if (moved) { b.asleep = false; b.sleepT = 0; }
      if (damp) {
        b.v[0] *= 0.72; b.v[1] *= 0.72; b.v[2] *= 0.72;
        b.w[0] *= 0.62; b.w[1] *= 0.62; b.w[2] *= 0.62;
      }
    }
  }

  function bakePackIn(count, seed, sizeScale) {
    var rng = mulberry32(seed);
    var bodies = makeBodies(count, sizeScale);
    var cols = 5, rows = Math.ceil(count / cols);
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      var gx = i % cols, gz = Math.floor(i / cols);
      var tx = lerp(-CAV.x * 0.50, CAV.x * 0.50, cols < 2 ? 0.5 : gx / (cols - 1)) + (rng() - 0.5) * 0.02;
      var tz = lerp(-CAV.z * 0.40, CAV.z * 0.40, rows < 2 ? 0.5 : gz / (rows - 1)) + (rng() - 0.5) * 0.02;
      var ty = CAV.yFloor + b.he[1] + 0.008 + rng() * 0.025;
      // fly in from the arc the camera is actually looking at, otherwise most
      // of the articles arrive behind the carton and the shot reads as empty
      var az = 1.26 + ((i / Math.max(count - 1, 1)) * 2 - 1) * 1.92 + rng() * 0.22;
      var rad = 0.80 + rng() * 0.30;
      b.p[0] = Math.cos(az) * rad; b.p[1] = 0.24 + rng() * 0.18; b.p[2] = Math.sin(az) * rad;
      // A 25 cm carton only fits a 20 cm cavity lying down, and a 0.5 l can
      // only standing. Big articles therefore arrive in their natural resting
      // orientation with barely any tumble — exactly how you pack by hand.
      var big = Math.max(b.he[0], b.he[1], b.he[2]) * 2 > 0.115;
      var spin;
      if (big) {
        restQuat(b.he, rng() * Math.PI * 2, b.q);
        spin = 1.4;
      } else {
        randQuat(rng, b.q);
        spin = 9 + rng() * 7;
      }
      var T = 0.30 + rng() * 0.12;
      b.v[0] = (tx - b.p[0] - 0.5 * GL[0] * T * T) / T;
      b.v[1] = (ty - b.p[1] - 0.5 * GL[1] * T * T) / T;
      b.v[2] = (tz - b.p[2] - 0.5 * GL[2] * T * T) / T;
      b.w[0] = (rng() - 0.5) * spin; b.w[1] = (rng() - 0.5) * spin; b.w[2] = (rng() - 0.5) * spin;
      b.t0 = i * (1.05 / count) + rng() * 0.05;
      b.frozen = true;
    }
    var duration = 3.25, compactAt = 1.80, closeAt = 2.70, soloAt = 3.05;
    var steps = Math.round(duration / DT) + 1;
    var frames = new Float32Array(steps * bodies.length * 7);
    var live = [];
    record(bodies, frames, 0);
    for (var f = 1; f < steps; f++) {
      var t = f * DT;
      for (var z = 0; z < bodies.length; z++) {
        var bb = bodies[z];
        if (bb.frozen && t >= bb.t0) { bb.frozen = false; live.push(bb); }
      }
      // The contact solver undoes the tuck as fast as it applies it, so the
      // last fifth of a second is tuck ONLY — nothing left to push back, and
      // the final recorded frame is provably inside the carton.
      if (t < soloAt && live.length) step(live, GL, DT, true);
      if (t >= compactAt) {
        var hard = t >= closeAt;
        tuckStep(bodies, hard ? 0.024 : 0.005, hard);
      }
      record(bodies, frames, f);
    }
    return {
      frames: frames, steps: steps, duration: duration, count: bodies.length, bodies: bodies,
      settled: bodies.map(function (b) { return { p: b.p.slice(), q: b.q.slice() }; }),
      t0: bodies.map(function (b) { return b.t0; })
    };
  }

  function bakeBurst(count, seed, sizeScale, settled) {
    var rng = mulberry32(seed + 7717);
    var bodies = makeBodies(count, sizeScale);
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i], s = settled[i];
      b.p = s.p.slice(); b.q = s.q.slice();
      var rl = Math.hypot(b.p[0], b.p[2]) || 1e-4;
      // 0.20 m of carton costs ~2.0 m/s on its own, so anything under that
      // never leaves the box — these are sized to clear it and keep going
      var spread = 1.40 + rng() * 1.40;
      var up = 3.30 + rng() * 1.10;
      b.v[0] = (b.p[0] / rl) * spread + (rng() - 0.5) * 0.8;
      b.v[1] = up;
      b.v[2] = (b.p[2] / rl) * spread * 0.8 + (rng() - 0.5) * 0.8 + 0.5;
      var sp = 20 + rng() * 14;
      b.w[0] = (rng() - 0.5) * sp; b.w[1] = (rng() - 0.5) * sp; b.w[2] = (rng() - 0.5) * sp;
    }
    var duration = 2.10;
    var steps = Math.round(duration / DT) + 1;
    var frames = new Float32Array(steps * bodies.length * 7);
    var blastDirs = new Array(bodies.length);
    record(bodies, frames, 0);
    for (var f = 1; f < steps; f++) {
      // The first launch merely clears the carton. Once every item is above
      // the rim, the detonation supplies a second, genuinely radial impulse.
      // Baking it into the simulation keeps the trajectory continuous and
      // avoids a render-only displacement through the box or its flaps.
      if (f * DT >= 0.29 && (f - 1) * DT < 0.29) {
        for (var k = 0; k < bodies.length; k++) {
          var body = bodies[k];
          var dx = body.p[0] * 4 + body.v[0] * 0.65;
          var dz = body.p[2] * 4 + body.v[2] * 0.65;
          var radial = Math.hypot(dx, dz) || 1;
          var shock = 5.0 + rng() * 1.8;
          blastDirs[k] = [dx / radial, dz / radial];
          body.v[0] += dx / radial * shock;
          body.v[1] += 3.5 + rng() * 1.0;
          // Depth alone reads as hovering because perspective shrinks it;
          // keep the blast's visible upward/lateral momentum dominant.
          body.v[2] += dz / radial * shock * 0.55;
        }
      }
      // The expanding pressure front continues to accelerate the items until
      // they have cleared the viewport; gravity must not arc one back in.
      if (f * DT >= 0.29 && f * DT <= 1.42) {
        for (var m = 0; m < bodies.length; m++) {
          bodies[m].v[0] += blastDirs[m][0] * 3.0 * DT;
          bodies[m].v[1] += 11.2 * DT;
          bodies[m].v[2] += blastDirs[m][1] * 1.2 * DT;
        }
      }
      step(bodies, GL, DT, false, f * DT < 0.18);
      record(bodies, frames, f);
    }
    return { frames: frames, steps: steps, duration: duration, count: bodies.length, bodies: bodies, t0: bodies.map(function () { return -99; }) };
  }

  /* ------------------------------------------------------ time remapping */
  function remapper(segs) {
    return function (t) {
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (t <= s[1] || i === segs.length - 1) {
          var u = s[1] === s[0] ? 1 : clamp((t - s[0]) / (s[1] - s[0]), 0, 1);
          if (s[4] === 'smooth') u = smooth(u);
          else if (s[4] === 'in') u = u * u;
          else if (s[4] === 'out') u = 1 - (1 - u) * (1 - u);
          return lerp(s[2], s[3], u);
        }
      }
      return 0;
    };
  }
  // Cubic position curve with explicit endpoint speeds (simulation seconds
  // per unit of scroll). Unlike ease-in/out segments it never freezes at a
  // bullet-time boundary, so slow motion reads as continuous movement.
  function movingCurve(t, a, b, x, y, startSpeed, endSpeed) {
    var u = clamp((t - a) / (b - a), 0, 1), u2 = u * u, u3 = u2 * u, span = b - a;
    return (2 * u3 - 3 * u2 + 1) * x + (u3 - 2 * u2 + u) * span * startSpeed +
      (-2 * u3 + 3 * u2) * y + (u3 - u2) * span * endSpeed;
  }
  function packSegments(bullet) {
    var hold = lerp(0.06, 0.22, bullet);
    return remapper([
      [0.00, 0.28, -1.50, 0.00, 'smooth'],
      [0.28, 0.40, 0.00, 0.28, 'out'],
      [0.40, 0.55, 0.28, 0.28 + hold, 'smooth'],
      [0.55, 0.90, 0.28 + hold, 2.30, 'in'],
      [0.90, 1.00, 2.30, 3.22, 'out']
    ]);
  }
  function burstSegments(bullet) {
    var slowTravel = lerp(0.12, 0.20, bullet);
    var endSlow = 0.11 + slowTravel;
    var prelude = remapper([
      [0.000, 0.115, -0.62, -0.12, 'smooth'],
      [0.115, 0.205, -0.12, 0.00, 'smooth']
    ]);
    return function (t) {
      if (t <= 0.205) return prelude(t);                         // box opens
      if (t <= 0.275) return movingCurve(t, 0.205, 0.275, 0, 0.11, 2.4, 0.65);
      if (t <= 0.490) return movingCurve(t, 0.275, 0.490, 0.11, endSlow, 0.65, 1.25);
      if (t <= 0.710) return movingCurve(t, 0.490, 0.710, endSlow, 1.42, 1.25, 5.0);
      return movingCurve(t, 0.710, 1, 1.42, 2.08, 5.0, 0);
    };
  }
  /* Explosion envelopes are scroll-space on purpose: bullet-time slows the
   * baked objects, while the energy keeps growing and takes over the canvas.
   */
  function explodeAt(t) {
    // A restrained nucleus forms while the products are still packed. The
    // launch impulse grows into a readable blast front, continues moving
    // through the mini bullet-time, then accelerates into canvas takeover.
    if (t <= 0.145) return 0;
    if (t < 0.205) return lerp(0, 0.075, smooth(ramp(t, 0.145, 0.205)));
    if (t < 0.275) return movingCurve(t, 0.205, 0.275, 0.075, 0.205, 2.0, 0.7);
    if (t < 0.490) return movingCurve(t, 0.275, 0.490, 0.205, 0.325, 0.7, 1.0);
    return movingCurve(t, 0.490, 0.745, 0.325, 1, 1.0, 0);
  }
  function whiteAt(t) { return smooth(ramp(t, 0.675, 0.91)); }
  function ignitionAt(t) {
    return smooth(ramp(t, 0.075, 0.135)) * (1 - smooth(ramp(t, 0.25, 0.43)));
  }

  function flapAngles(scene, time, t) {
    // [outerBack, outerFront, innerLeft, innerRight]
    var a = [0, 0, 0, 0];
    function spring(u, over) {
      // easeOutBack: exactly 0 at u=0. The previous curve returned -0.18 there,
      // which dipped every flap below the rim and through its neighbours.
      if (u <= 0) return 0; if (u >= 1) return 1;
      var c1 = 1.70158 * over, c3 = c1 + 1, p = u - 1;
      return 1 + c3 * p * p * p + c1 * p * p;
    }
    if (scene === 'pack') {
      // outer pair fully clear before the inner pair starts — no shared window,
      // so they cannot sweep through one another
      var seq = [[-1.50, -1.02], [-1.44, -0.96], [-0.92, -0.44], [-0.86, -0.38]];
      var open = [118, 114, 106, 110];
      for (var i = 0; i < 4; i++) {
        a[i] = spring(clamp((time - seq[i][0]) / (seq[i][1] - seq[i][0]), 0, 1), 0.18) * open[i] * DEG;
      }
    } else {
      var strain = ramp(time, -0.62, -0.17);
      var openB = [132, 138, 120, 126];
      for (var k = 0; k < 4; k++) {
        // a packed carton bulges its lid UP, never down through its own board
        // Only the visible upper layer may preload. Tilting the lower pair at
        // the same time makes the two crossed board planes cut through each
        // other at their corners even at a seemingly harmless one degree.
        var pre = 1.1 * DEG * smooth(strain) * (k < 2 ? 1 : 0);
        // The outer pair is the upper board layer and has to clear first. The
        // inner pair follows only after the outer boards are past 90 degrees.
        // Both layers are fully open before simulation time zero, so products
        // never need to pass through a moving flap on launch.
        var start = k < 2 ? -0.160 : -0.066;
        var end = k < 2 ? -0.072 : -0.004;
        var pop = spring(ramp(time, start, end), k < 2 ? 0.18 : 0.12) * openB[k] * DEG;
        a[k] = Math.max(pre, pop);
      }
    }
    return a;
  }

  var CAM = {
    pack: [
      { t: 0.00, p: [0.92, 0.50, 1.24], a: [0, 0.10, 0], fov: 34 },
      { t: 0.28, p: [0.64, 0.78, 1.08], a: [0, 0.12, 0], fov: 36 },
      { t: 0.44, p: [0.42, 0.60, 1.30], a: [0, 0.16, 0], fov: 40 },
      { t: 0.56, p: [0.20, 0.50, 1.02], a: [0, 0.14, 0], fov: 33 },
      { t: 0.78, p: [-0.60, 0.88, 1.02], a: [0, 0.09, 0], fov: 39 },
      { t: 1.00, p: [-0.24, 0.82, 0.78], a: [0, 0.05, 0], fov: 41 }
    ],
    burst: [
      { t: 0.00, p: [-0.34, 0.46, 0.86], a: [0, 0.11, 0], fov: 35 },
      { t: 0.12, p: [-0.19, 0.50, 1.02], a: [0, 0.20, 0], fov: 39 },
      { t: 0.30, p: [0.24, 0.80, 1.58], a: [0, 0.44, 0], fov: 46 },
      { t: 0.52, p: [0.90, 0.94, 1.64], a: [0, 0.48, 0], fov: 48 },
      { t: 0.72, p: [0.62, 0.80, 1.86], a: [0, 0.34, 0], fov: 46 },
      { t: 1.00, p: [0.26, 0.58, 2.10], a: [0, 0.20, 0], fov: 42 }
    ]
  };
  function camValue(key, field, axis) { return axis < 0 ? key[field] : key[field][axis]; }
  function camRate(keys, i, field, axis) {
    var before = i > 0 ? (camValue(keys[i], field, axis) - camValue(keys[i - 1], field, axis)) /
      (keys[i].t - keys[i - 1].t) : 0;
    var after = i < keys.length - 1 ? (camValue(keys[i + 1], field, axis) - camValue(keys[i], field, axis)) /
      (keys[i + 1].t - keys[i].t) : 0;
    if (i === 0) return after;
    if (i === keys.length - 1) return before;
    return before * after <= 0 ? 0 : 2 * before * after / (before + after);
  }
  function sampleCam(keys, t, outP, outA, continuous) {
    var i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    var k0 = keys[i], k1 = keys[i + 1];
    if (continuous) {
      var p = [0, 0, 0], a = [0, 0, 0];
      for (var j = 0; j < 3; j++) {
        p[j] = movingCurve(t, k0.t, k1.t, k0.p[j], k1.p[j], camRate(keys, i, 'p', j), camRate(keys, i + 1, 'p', j));
        a[j] = movingCurve(t, k0.t, k1.t, k0.a[j], k1.a[j], camRate(keys, i, 'a', j), camRate(keys, i + 1, 'a', j));
      }
      outP.set(p[0], p[1], p[2]); outA.set(a[0], a[1], a[2]);
      return movingCurve(t, k0.t, k1.t, k0.fov, k1.fov, camRate(keys, i, 'fov', -1), camRate(keys, i + 1, 'fov', -1));
    }
    var u = smooth(clamp((t - k0.t) / (k1.t - k0.t || 1), 0, 1));
    outP.set(lerp(k0.p[0], k1.p[0], u), lerp(k0.p[1], k1.p[1], u), lerp(k0.p[2], k1.p[2], u));
    outA.set(lerp(k0.a[0], k1.a[0], u), lerp(k0.a[1], k1.a[1], u), lerp(k0.a[2], k1.a[2], u));
    return lerp(k0.fov, k1.fov, u);
  }

  /* ============================ Frugends energy detonation (screen space) */
  var EXPL_FRAG = [
    'precision highp float;',
    'uniform vec2 uRes; uniform vec2 uAnchor; uniform float uProg; uniform float uWhite; uniform float uTime;',
    'const vec3 GOLD=vec3(1.0,0.804,0.157); const vec3 CREAM=vec3(1.0,0.957,0.710);',
    'const vec3 LAVENDER=vec3(0.780,0.722,0.878); const vec3 PURPLE=vec3(0.486,0.361,0.749);',
    'const vec3 CYAN=vec3(0.267,0.851,1.0); const vec3 ORANGE=vec3(0.961,0.620,0.043);',
    'float hash11(float n){return fract(sin(n)*43758.5453);}',
    'float hash12(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);',
    ' return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y);}',
    'float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p=p*2.02+vec2(1.7,9.2);a*=0.5;}return v;}',
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/uRes.xy;',
    ' float asp=uRes.x/uRes.y;',
    ' vec2 p=vec2((uv.x-uAnchor.x)*asp,uv.y-uAnchor.y);',
    ' float r=length(p); float ang=atan(p.y,p.x);',
    ' float E=uProg; if(E<=0.0){gl_FragColor=vec4(0.0);return;}',
    ' float t=uTime;',
    // ignition flash — brief and tight, must not wash the structure out
    ' float ign=smoothstep(0.0,0.035,E)*exp(-pow(max(E-0.04,0.0)*15.0,2.0));',
    // expanding plasma core — large enough to own the full canvas before white
    ' float coreR=0.025+E*E*0.92;',
    ' vec2 wq=p*(2.2+E*1.5);',
    ' vec2 warp=wq+vec2(fbm(wq*1.5+t*0.5),fbm(wq*1.5-t*0.4+3.0))*0.85;',
    ' float turb=fbm(warp*2.0+vec2(t*0.35,-t*0.25))+fbm(warp*4.4-t*0.5)*0.5;',
    ' float body=smoothstep(coreR*1.52,0.0,r)*pow(clamp(turb-0.04,0.0,2.0),1.18);',
    ' vec3 col=vec3(0.0);',
    // gold core -> lavender rim gradient
    ' col+=PURPLE*0.95*smoothstep(0.02,0.40,body);',
    ' col+=LAVENDER*1.20*smoothstep(0.22,0.62,body);',
    ' col+=mix(ORANGE,GOLD,0.55)*1.55*smoothstep(0.45,0.88,body);',
    ' col+=CREAM*1.35*pow(smoothstep(0.80,1.10,body),1.5);',
    // white-hot centre — tight, so the gold structure stays readable
    ' float hot=exp(-r*r/max(coreR*coreR*0.22,1e-5));',
    ' col+=mix(GOLD,CREAM,0.28)*hot*(0.72+ign*0.48);',
    // keep pre-ignition tight and coloured; the old broad white Gaussian
    // obscured the opening and erased all contrast against white paperboard
    ' col+=mix(GOLD,LAVENDER,0.25)*ign*exp(-r*r*185.0)*0.85;',
    // three shockwave rings, gold with a lavender trailing edge
    ' float ringCoverage=0.0;',
    ' for(int i=0;i<3;i++){float fi=float(i);',
    '  float d=fi*0.085; float e=max(E-d,0.0);',
    '  float rr=e*(0.95+fi*0.34);',
    '  float w=0.014+e*0.070;',
    '  float m=exp(-pow((r-rr)/w,2.0))*(1.0-smoothstep(0.35,1.0,e));',
    '  ringCoverage=max(ringCoverage,m);',
    '  col+=mix(GOLD,CREAM,0.35)*m*(1.9-fi*0.45);',
    '  col+=LAVENDER*exp(-pow((r-rr*0.90)/(w*2.1),2.0))*m*0.55;}',
    // radial energy spokes — arcade streaks
    ' float spokes=0.0;',
    ' for(int s=0;s<5;s++){float fs=float(s);',
    '  float k=7.0+fs*5.0; float off=hash11(fs*2.7)*6.2831;',
    '  spokes+=pow(abs(sin(ang*k*0.5+off)),14.0)*(1.0/(1.0+fs));}',
    ' float spokeR=smoothstep(coreR*3.0,coreR*0.22,r)*smoothstep(0.0,0.10,E)*(1.0-smoothstep(0.58,1.0,E));',
    ' col+=mix(GOLD,CREAM,0.5)*spokes*spokeR*1.8;',
    // anamorphic flare bar
    ' float bar=exp(-pow(p.y/(0.006+E*0.020),2.0))*exp(-pow(p.x/(0.34+E*0.85),2.0));',
    ' col+=mix(LAVENDER,CREAM,0.42)*bar*(0.85+ign*1.1)*smoothstep(0.075,0.18,E)*(1.0-smoothstep(0.62,1.0,E));',
    // outer heat bloom
    ' col+=mix(PURPLE,LAVENDER,0.5)*exp(-pow((r-coreR*1.25)*3.4,2.0))*0.55*(1.0-smoothstep(0.7,1.0,E));',
    // late phase must stay gold/lavender instead of going grey
    ' col+=mix(GOLD,LAVENDER,0.45)*smoothstep(coreR*1.6,0.0,r)*smoothstep(0.45,0.95,E)*0.85;',
    // screen takeover: turbulent violet/gold atmosphere fills the corners
    // before the final neutral white hand-off
    ' float take=smoothstep(0.42,0.92,E);',
    ' float veil=(0.14+0.22*fbm(uv*5.0+vec2(t*0.08,-t*0.06)))*take;',
    ' col+=mix(PURPLE,CREAM,0.48)*veil;',
    // grain so the gradients do not band
    ' col+=(hash12(gl_FragCoord.xy+t)-0.5)*0.016;',
    ' col=col/(1.0+col*0.22);',
    ' float lum=max(max(col.r,col.g),col.b);',
    // Let products remain visible through the gold shock front during the
    // launch. The late takeover and final white hand-off stay fully opaque.
    ' float alpha=max(clamp(lum*1.18,0.0,0.94),take*0.82);',
    ' alpha*=1.0-0.23*ringCoverage*(1.0-take);',
    ' col=mix(col,vec3(1.0),uWhite);',
    ' alpha=max(alpha,uWhite);',
    ' gl_FragColor=vec4(col,alpha);',
    '}'
  ].join('\n');

  /* --------- article geometry: enough shape to read as a real product --- */
  function buildItem(THREE, def, he, mat) {
    var g = new THREE.Group();
    if (def.kind === 'pillow') {
      // flow-wrap bag: squashed capsule with a crimped seal at each end
      var r = he[1];
      var body = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(he[2] * 2 - r * 2, 0.002), 4, 18), mat);
      body.rotation.x = Math.PI / 2;
      body.scale.x = he[0] / r;
      g.add(body);
      var fin = new THREE.BoxGeometry(he[0] * 1.72, r * 0.24, r * 0.55);
      var f1 = new THREE.Mesh(fin, mat); f1.position.z = he[2] * 0.97; g.add(f1);
      var f2 = new THREE.Mesh(fin, mat); f2.position.z = -he[2] * 0.97; g.add(f2);
    } else if (def.kind === 'can') {
      var cr = he[0], ch = he[1] * 2;
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(cr, cr, ch * 0.90, 22), mat));
      var alu = new THREE.MeshStandardMaterial({ color: 0xc2c6dc, roughness: 0.26, metalness: 0.88 });
      var top = new THREE.Mesh(new THREE.CylinderGeometry(cr * 0.84, cr, ch * 0.06, 22), alu);
      top.position.y = ch * 0.47; g.add(top);
      var bot = new THREE.Mesh(new THREE.CylinderGeometry(cr, cr * 0.88, ch * 0.05, 22), alu);
      bot.position.y = -ch * 0.47; g.add(bot);
    } else if (def.kind === 'deo') {
      var dr = he[0], dh = he[1] * 2;
      var can = new THREE.Mesh(new THREE.CylinderGeometry(dr, dr * 0.94, dh * 0.70, 20), mat);
      can.position.y = -dh * 0.15; g.add(can);
      var cap = new THREE.Mesh(new THREE.CylinderGeometry(dr * 0.97, dr * 0.97, dh * 0.30, 20),
        new THREE.MeshStandardMaterial({ color: 0x9aa0c8, roughness: 0.55 }));
      cap.position.y = dh * 0.35; g.add(cap);
    } else {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(he[0] * 2, he[1] * 2, he[2] * 2), mat));
    }
    return g;
  }

  function shadowTexture(THREE) {
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var g = c.getContext('2d');
    var rg = g.createRadialGradient(128, 128, 8, 128, 128, 126);
    rg.addColorStop(0, 'rgba(0,0,0,0.72)');
    rg.addColorStop(0.45, 'rgba(0,0,0,0.34)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }

  function groundLightTexture(THREE) {
    // Transparent light catcher: the host page remains visible while the
    // warm/cool pools that previously appeared on the opaque floor survive.
    var c = document.createElement('canvas'); c.width = c.height = 512;
    var g = c.getContext('2d');
    g.clearRect(0, 0, 512, 512);
    var warm = g.createRadialGradient(286, 260, 4, 286, 260, 250);
    warm.addColorStop(0, 'rgba(255,211,111,.62)');
    warm.addColorStop(0.28, 'rgba(235,164,45,.34)');
    warm.addColorStop(0.66, 'rgba(169,104,24,.13)');
    warm.addColorStop(1, 'rgba(117,67,15,0)');
    g.fillStyle = warm; g.fillRect(0, 0, 512, 512);
    var cool = g.createRadialGradient(150, 215, 0, 150, 215, 190);
    cool.addColorStop(0, 'rgba(136,105,212,.22)');
    cool.addColorStop(0.52, 'rgba(92,72,170,.08)');
    cool.addColorStop(1, 'rgba(70,54,140,0)');
    g.fillStyle = cool; g.fillRect(0, 0, 512, 512);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  /* Coated white paperboard: irregular pulp density and short, broken paper
   * fibres. The detail is directionless, with no parallel wood-like streaks.
   */
  function kraftTextureSet(THREE) {
    var size = 512, albedo = document.createElement('canvas'), bump = document.createElement('canvas');
    var rough = document.createElement('canvas');
    albedo.width = albedo.height = bump.width = bump.height = rough.width = rough.height = size;
    var ac = albedo.getContext('2d'), bc = bump.getContext('2d'), rc = rough.getContext('2d');
    var ai = ac.createImageData(size, size), bi = bc.createImageData(size, size), ri = rc.createImageData(size, size);
    function hash(x, y) {
      var n = Math.sin(x * 127.1 + y * 311.7 + 19.19) * 43758.5453;
      return n - Math.floor(n);
    }
    function fade(n) { return n * n * (3 - 2 * n); }
    function valueNoise(x, y, cell) {
      var gx = x / cell, gy = y / cell, ix = Math.floor(gx), iy = Math.floor(gy);
      var fx = fade(gx - ix), fy = fade(gy - iy);
      var a = hash(ix, iy), b = hash(ix + 1, iy);
      var c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
      return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    }
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var p = (y * size + x) * 4;
        var cloud = (valueNoise(x, y, 58) - 0.5) * 9.0;
        var pulp = (valueNoise(x + 193, y - 71, 13) - 0.5) * 10.0;
        var tooth = (hash(x, y) - 0.5) * 9.0;
        var speck = hash(x + 913, y - 271) > 0.9993 ? -17 : 0;
        var av = clamp(241 + cloud + pulp + tooth + speck, 212, 253);
        var bv = clamp(128 + cloud * 2.2 + pulp * 2.8 + tooth * 3.2 + speck * 0.4, 88, 173);
        var rv = clamp(239 - cloud * 0.45 - pulp * 0.65 - tooth * 0.5, 216, 250);
        ai.data[p] = ai.data[p + 1] = ai.data[p + 2] = av; ai.data[p + 3] = 255;
        bi.data[p] = bi.data[p + 1] = bi.data[p + 2] = bv; bi.data[p + 3] = 255;
        ri.data[p] = ri.data[p + 1] = ri.data[p + 2] = rv; ri.data[p + 3] = 255;
      }
    }
    ac.putImageData(ai, 0, 0); bc.putImageData(bi, 0, 0); rc.putImageData(ri, 0, 0);

    var rng = mulberry32(0x50415045); // "PAPE"
    ac.lineCap = bc.lineCap = 'round';
    for (var f = 0; f < 13500; f++) {
      var fx = rng() * size, fy = rng() * size, len = 0.8 + Math.pow(rng(), 3.0) * 8.0;
      var angle = rng() * Math.PI * 2, dx = Math.cos(angle) * len, dy = Math.sin(angle) * len;
      var light = rng() > 0.59;
      ac.strokeStyle = light ? 'rgba(255,255,255,' + (0.06 + rng() * 0.09) + ')' :
        'rgba(94,101,109,' + (0.035 + rng() * 0.065) + ')';
      ac.lineWidth = 0.28 + rng() * 0.52;
      ac.beginPath(); ac.moveTo(fx, fy); ac.lineTo(fx + dx, fy + dy); ac.stroke();
      bc.strokeStyle = light ? 'rgba(199,199,199,.11)' : 'rgba(58,58,58,.11)';
      bc.lineWidth = 0.34 + rng() * 0.56;
      bc.beginPath(); bc.moveTo(fx, fy); bc.lineTo(fx + dx, fy + dy); bc.stroke();
    }

    function texture(canvas, colorMap) {
      var tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1.15, 1.15);
      tex.anisotropy = 8;
      if (colorMap) tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }
    return { map: texture(albedo, true), bump: texture(bump, false), roughness: texture(rough, false) };
  }

  function paperboardGeometry(THREE, sx, sy, sz, scoreAxis, scoreSign) {
    // A shallow pressed edge rather than the mathematically sharp corners of
    // BoxGeometry. Dimensions remain unchanged at the centre of every face.
    var radius = Math.min(0.00175, Math.min(sx, sy, sz) * 0.44);
    var geo = new THREE.BoxGeometry(sx, sy, sz, 4, 4, 4);
    var pos = geo.attributes.position, norm = geo.attributes.normal, uv = geo.attributes.uv;
    var half = [sx / 2, sy / 2, sz / 2], dims = [sx, sy, sz];
    function gridPosition(v, h) {
      var a = Math.abs(v);
      return Math.sign(v) * (a > h * 0.75 ? h : a > h * 0.25 ? h - radius : 0);
    }
    function gridUV(v, dimension) {
      var edge = radius / dimension;
      if (v < 0.125) return 0;
      if (v < 0.375) return edge;
      if (v < 0.625) return 0.5;
      if (v < 0.875) return 1 - edge;
      return 1;
    }
    for (var i = 0; i < pos.count; i++) {
      var faceAxis = Math.abs(norm.getX(i)) > 0.9 ? 0 : Math.abs(norm.getY(i)) > 0.9 ? 1 : 2;
      // The score is an uncut bend in one blank. Rounding *both* independent
      // meshes at that shared edge retracts their skins and leaves a bright
      // raised lip above a dark hairline, even when the pivots are coplanar.
      // Keep the fold edge full-thickness; only free/cut edges are softened.
      var raw = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      if (scoreAxis !== undefined && raw[scoreAxis] * scoreSign > half[scoreAxis] - 1e-7) {
        var scoreUDim = faceAxis === 0 ? dims[2] : dims[0];
        var scoreVDim = faceAxis === 1 ? dims[2] : dims[1];
        uv.setXY(i, gridUV(uv.getX(i), scoreUDim), gridUV(uv.getY(i), scoreVDim));
        continue;
      }
      var p = [gridPosition(pos.getX(i), half[0]), gridPosition(pos.getY(i), half[1]),
        gridPosition(pos.getZ(i), half[2])];
      var delta = [0, 0, 0], lengthSq = 0;
      for (var a = 0; a < 3; a++) {
        var core = clamp(p[a], -half[a] + radius, half[a] - radius);
        delta[a] = p[a] - core; lengthSq += delta[a] * delta[a];
        p[a] = core;
      }
      var length = Math.sqrt(lengthSq) || 1;
      for (var b = 0; b < 3; b++) p[b] += delta[b] * radius / length;
      pos.setXYZ(i, p[0], p[1], p[2]);
      norm.setXYZ(i, delta[0] / length, delta[1] / length, delta[2] / length);
      var uDim = faceAxis === 0 ? dims[2] : dims[0];
      var vDim = faceAxis === 1 ? dims[2] : dims[1];
      uv.setXY(i, gridUV(uv.getX(i), uDim), gridUV(uv.getY(i), vDim));
    }
    return geo;
  }

  function ignitionTexture(THREE) {
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var g = c.getContext('2d'), rg = g.createRadialGradient(128, 128, 0, 128, 128, 126);
    rg.addColorStop(0, 'rgba(255,182,42,1)');
    rg.addColorStop(0.08, 'rgba(255,145,20,.98)');
    rg.addColorStop(0.23, 'rgba(231,104,24,.84)');
    rg.addColorStop(0.48, 'rgba(151,87,217,.52)');
    rg.addColorStop(1, 'rgba(76,50,148,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }

  function ignitionHaloTexture(THREE) {
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var g = c.getContext('2d'), rg = g.createRadialGradient(128, 128, 4, 128, 128, 126);
    rg.addColorStop(0, 'rgba(141,78,194,0)');
    rg.addColorStop(0.17, 'rgba(153,75,213,.56)');
    rg.addColorStop(0.39, 'rgba(78,35,139,.82)');
    rg.addColorStop(0.72, 'rgba(49,22,95,.28)');
    rg.addColorStop(1, 'rgba(68,44,133,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }

  class SurpriseBoxElement extends HTMLElement {
    static get observedAttributes() { return ['objects', 'bullet', 'stretch', 'hud', 'tone', 'scene', 'size']; }

    connectedCallback() {
      if (this._booted) { this._stop = false; this._start(); return; }
      this._booted = true;
      this.style.display = 'block';
      this.style.position = 'relative';
      this._wrap = document.createElement('div');
      this._wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden';
      this.appendChild(this._wrap);
      this._hud = document.createElement('div');
      this._hud.style.cssText = 'position:absolute;left:14px;bottom:14px;z-index:3;pointer-events:none;' +
        'font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;' +
        'color:#6B6E7D;line-height:1.75;white-space:pre;background:rgba(20,23,41,0.62);' +
        'border:1px solid #363A6E;border-radius:8px;padding:9px 12px';
      this.appendChild(this._hud);
      var self = this, tries = 0;
      (function poll() {
        if (window.THREE) return self._init(window.THREE);
        if (++tries > 400) { self._hud.textContent = 'THREE.JS NICHT GELADEN'; return; }
        setTimeout(poll, 30);
      })();
    }
    disconnectedCallback() { this._stop = true; if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }
    attributeChangedCallback(n) {
      if (!this._three) return;
      if (n === 'objects' || n === 'size' || n === 'scene') this._rebuild();
      else if (n === 'tone') this._applyTone();
      else if (n === 'hud') this._hud.style.display = this.getAttribute('hud') === 'false' ? 'none' : 'block';
    }
    _num(a, d) { var v = parseFloat(this.getAttribute(a)); return isFinite(v) ? v : d; }

    _init(THREE) {
      this._three = THREE;
      var r = this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
      this._dpr = Math.min(window.devicePixelRatio || 1, /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 1.75 : 2);
      r.setPixelRatio(this._dpr);
      r.setClearColor(0x000000, 0);
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.02;
      r.autoClear = false;
      r.domElement.style.cssText = 'display:block;width:100%;height:100%';
      this._wrap.appendChild(r.domElement);

      var sc = this._scene = new THREE.Scene();
      // True alpha surface: the component can sit on an existing page without
      // drawing a rectangular or circular background platform.
      sc.background = null;
      this._cam = new THREE.PerspectiveCamera(38, 1, 0.05, 40);
      this._camA = new THREE.Vector3(); this._camP = new THREE.Vector3();

      var whiteBoard = this.getAttribute('scene') === 'burst';
      if (whiteBoard) {
        this._burstAmbient = new THREE.AmbientLight(0xffffff, 0.42);
        sc.add(this._burstAmbient);
      }
      sc.add(new THREE.HemisphereLight(whiteBoard ? 0xffffff : 0x8b7bd6,
        whiteBoard ? 0x777d8d : 0x2a2440, whiteBoard ? 0.9 : 0.62));
      var key = new THREE.DirectionalLight(whiteBoard ? 0xfff4ea : 0xffd68a, whiteBoard ? 2.05 : 2.5);
      key.position.set(0.85, 1.35, 0.95); sc.add(key);
      var rim = new THREE.DirectionalLight(0xa08fd8, whiteBoard ? 0.32 : 0.85);
      rim.position.set(-1.05, 0.55, -0.85); sc.add(rim);
      var kick = new THREE.DirectionalLight(0x44d9ff, whiteBoard ? 0.10 : 0.22);
      kick.position.set(-0.6, 0.2, -1.1); sc.add(kick);
      var fill = new THREE.DirectionalLight(whiteBoard ? 0xffffff : 0x7c5cbf, whiteBoard ? 0.55 : 0.55);
      fill.position.set(-0.45, 0.3, 1.05); sc.add(fill);
      // straight down into the cavity, or the contents disappear in shadow
      var cav = new THREE.DirectionalLight(whiteBoard ? 0xffffff : 0xfff0d0, whiteBoard ? 1.05 : 0.95);
      cav.position.set(0.12, 1.6, 0.45); sc.add(cav);
      if (whiteBoard) this._burstCavityFill = cav;

      var groundMat = this._groundWashMat = new THREE.MeshBasicMaterial({
        map: groundLightTexture(THREE), transparent: true, opacity: 0.78,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
      });
      var ground = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.05), groundMat);
      // The carton is tilted 9 degrees; its front bottom is below world y=0.
      // Put both transparent ground effects below that corner, or they slice
      // through the wall and produce a false brown plinth.
      ground.rotation.x = -Math.PI / 2; ground.position.set(0.05, -0.034, 0.03); sc.add(ground);
      this._ground = ground;

      this._blob = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.80),
        new THREE.MeshBasicMaterial({ map: shadowTexture(THREE), transparent: true, depthWrite: false }));
      this._blob.rotation.x = -Math.PI / 2; this._blob.position.set(0, -0.032, 0.02); sc.add(this._blob);

      this._boxGroup = new THREE.Group();
      this._boxGroup.rotation.x = TILT;
      sc.add(this._boxGroup);
      this._buildCarton();
      this._rebuild();

      // BURST starts as a real light source inside the cavity. Render the
      // broad, camera-facing glow BEHIND the solid carton in a separate pass:
      // a depth-tested sprite intersecting a moving flap clips along a hard,
      // ruler-straight line across the paper. Point lights still illuminate
      // the flap surfaces; the glow remains visible through the open mouth.
      if (this.getAttribute('scene') === 'burst') {
        this._ignitionScene = new THREE.Scene();
        var ignitionGroup = new THREE.Group();
        ignitionGroup.rotation.x = TILT;
        this._ignitionScene.add(ignitionGroup);
        var haloMat = new THREE.SpriteMaterial({
          map: ignitionHaloTexture(THREE), color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.NormalBlending, depthTest: false, depthWrite: false
        });
        this._burstHalo = new THREE.Sprite(haloMat);
        this._burstHalo.position.set(0, BOX.h * 0.82, -0.016);
        this._burstHalo.scale.setScalar(0.1);
        this._burstHalo.visible = false;
        ignitionGroup.add(this._burstHalo);
        var glowMat = new THREE.SpriteMaterial({
          map: ignitionTexture(THREE), color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.NormalBlending, depthTest: false, depthWrite: false, toneMapped: false
        });
        this._burstGlow = new THREE.Sprite(glowMat);
        this._burstGlow.position.set(0, BOX.h * 0.82, 0);
        this._burstGlow.scale.setScalar(0.08);
        this._burstGlow.visible = false;
        ignitionGroup.add(this._burstGlow);
        // A small, soft veil over the mouth restores the bright internal core
        // without letting the old large sprite cut straight across a flap.
        var veilMat = glowMat.clone();
        veilMat.opacity = 0;
        this._burstGlowVeil = new THREE.Sprite(veilMat);
        this._burstGlowVeil.position.copy(this._burstGlow.position);
        this._burstGlowVeil.scale.setScalar(0.05);
        this._burstGlowVeil.visible = false;
        this._boxGroup.add(this._burstGlowVeil);
        this._burstLight = new THREE.PointLight(0xffbd36, 0, 0.46, 1.65);
        this._burstLight.position.set(0, BOX.h * 0.68, 0);
        this._boxGroup.add(this._burstLight);
        this._burstVioletLight = new THREE.PointLight(0x7938bc, 0, 0.52, 1.7);
        this._burstVioletLight.position.set(-0.055, BOX.h * 0.62, -0.025);
        this._boxGroup.add(this._burstVioletLight);
      }

      // explosion overlay
      this._fxScene = new THREE.Scene();
      this._fxCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._fxMat = new THREE.ShaderMaterial({
        uniforms: {
          uRes: { value: new THREE.Vector2(1, 1) }, uAnchor: { value: new THREE.Vector2(0.5, 0.5) },
          uProg: { value: 0 }, uWhite: { value: 0 }, uTime: { value: 0 }
        },
        vertexShader: 'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: EXPL_FRAG, transparent: true, depthTest: false, depthWrite: false
      });
      this._fxScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._fxMat));

      var self = this;
      this._ro = new ResizeObserver(function () { self._resize(); }); this._ro.observe(this);
      this._visible = true;
      this._io = new IntersectionObserver(function (e) {
        self._visible = e[0].isIntersecting;
        if (self._visible) self._resize();
      }, { rootMargin: '140px' });
      this._io.observe(this);
      this._resize();
      this._t = 0; this._target = 0; this._fps = 60; this._frameAcc = 0; this._frameN = 0;
      this._start();
    }

    _kraft() {
      var v = this.getAttribute('tone');
      return v && v.charAt(0) !== '{' ? v :
        this.getAttribute('scene') === 'burst' ? '#f5f5f1' : '#b07f52';
    }

    _buildCarton() {
      var THREE = this._three, G = this._boxGroup, w = BOX.w, d = BOX.d, h = BOX.h, t = BOX.t;
      var wallPanels = this._wallPanels = [];
      var kraft = this._kraft(), burstCarton = this.getAttribute('scene') === 'burst';
      var detail = burstCarton ? kraftTextureSet(THREE) : null;
      function boardMaterial(color, roughness, bumpScale) {
        var options = { color: color, roughness: roughness };
        if (detail) {
          options.map = detail.map;
          options.bumpMap = detail.bump;
          options.bumpScale = bumpScale;
          options.roughnessMap = detail.roughness;
        }
        return new THREE.MeshStandardMaterial(options);
      }
      // PACK keeps its established look; the richer material is BURST-only.
      var out = this._matOut = boardMaterial(kraft, burstCarton ? 0.98 : 0.88, burstCarton ? 0.00072 : 0.00048);
      var ins = this._matIn = boardMaterial(new THREE.Color(kraft).multiplyScalar(burstCarton ? 0.94 : 0.58), 0.99, burstCarton ? 0.00056 : 0.00038);
      var edge = this._matEdge = boardMaterial(new THREE.Color(kraft).multiplyScalar(burstCarton ? 0.99 : 0.80), 0.99, burstCarton ? 0.00056 : 0.00072);
      if (burstCarton) {
        this._burstInnerNeutral = new THREE.Color(kraft).multiplyScalar(0.94);
        this._burstInnerEnergy = new THREE.Color('#695576');
      }

      /* Every panel is ONE solid box carrying a different material per face:
       * board edge on the cut sides, liner on the cavity side. No separate
       * liner planes sitting a fraction of a millimetre in front of a wall,
       * which is what produced the z-fighting slivers and shards.
       * BoxGeometry face order: +x, -x, +y, -y, +z, -z
       */
      function faces(innerFace) {
        var m = [edge, edge, edge, edge, edge, edge];
        m[innerFace] = ins;
        // the two large outward faces of a wall show printed kraft
        if (innerFace === 4) m[5] = out; else if (innerFace === 5) m[4] = out;
        else if (innerFace === 0) m[1] = out; else if (innerFace === 1) m[0] = out;
        else if (innerFace === 2) m[3] = out; else if (innerFace === 3) m[2] = out;
        return m;
      }
      function panel(sx, sy, sz, x, y, z, innerFace) {
        var geometry = burstCarton ? paperboardGeometry(THREE, sx, sy, sz, 1, 1) : new THREE.BoxGeometry(sx, sy, sz);
        var materials = faces(innerFace);
        if (burstCarton) materials[2] = out; // exposed top fold, not a dark cut-edge rim
        var m = new THREE.Mesh(geometry, materials);
        m.position.set(x, y, z); G.add(m); wallPanels.push(m); return m;
      }
      // BURST needs only the interior floor surface. Its old solid perimeter
      // appeared outside the front wall as a false plinth at the box base.
      if (burstCarton) {
        var floor = new THREE.Mesh(new THREE.PlaneGeometry(w - 2 * t, d - 2 * t), ins);
        floor.rotation.x = -Math.PI / 2; floor.position.y = t; G.add(floor);
      } else panel(w, t, d, 0, t / 2, 0, 2);
      // At a real inward fold the outside wall runs uninterrupted to the top.
      // The major flap starts at its INNER top corner. A flap starting at the
      // outside face exposes its entire 4 mm bent edge as a false raised lid.
      var majorScore = h;
      var minorScore = burstCarton ? h - 2 * t : h;
      panel(w, majorScore, t, 0, majorScore / 2, -d / 2 + t / 2, 4); // back wall
      panel(w, majorScore, t, 0, majorScore / 2, d / 2 - t / 2, 5);  // front wall
      panel(t, minorScore, burstCarton ? d - 2 * t : d,
        -w / 2 + t / 2, minorScore / 2, 0, 0); // left wall meets front/back, no corner overlap
      panel(t, minorScore, burstCarton ? d - 2 * t : d,
        w / 2 - t / 2, minorScore / 2, 0, 1);  // right wall

      /* --- RSC flaps -----------------------------------------------------
       * PACK retains the original 15 cm leaves. BURST's outer pair starts at
       * the inner edge of the full-height long walls and reaches the centre;
       * its inner pair has narrow corner slots so all four can swing clear.
       */
      // The major hinge is the inner, upper wall corner. Its flap folds inward
      // below that corner; the outside facade therefore has no extra strip.
      // The minor pair remains one caliper below the major pair.
      // PACK retains its previous hinge positions and appearance.
      var yIn = burstCarton ? minorScore : h;
      var yOut = burstCarton ? h : h + t + 0.0002;
      var majorReach = burstCarton ? d / 2 - t : FLAP;
      var specs = [
        { hinge: [0, yOut, burstCarton ? -d / 2 + t : -d / 2], size: [w, t, majorReach], off: [0, 0, majorReach / 2], axis: 'x', sign: -1 },
        { hinge: [0, yOut, burstCarton ? d / 2 - t : d / 2], size: [w, t, majorReach], off: [0, 0, -majorReach / 2], axis: 'x', sign: 1 },
        // The corner slots need one extra caliper of clearance on each end,
        // otherwise the inner leaves sweep through the newly inset outer fold.
        { hinge: [-w / 2, yIn, 0], size: [FLAP, t, burstCarton ? d - 4 * t : d], off: [FLAP / 2, 0, 0], axis: 'z', sign: 1 },
        { hinge: [w / 2, yIn, 0], size: [FLAP, t, burstCarton ? d - 4 * t : d], off: [-FLAP / 2, 0, 0], axis: 'z', sign: -1 }
      ];
      this._flaps = [];
      for (var i = 0; i < specs.length; i++) {
        var s = specs[i];
        var pivot = new THREE.Group();
        pivot.position.set(s.hinge[0], s.hinge[1], s.hinge[2]);
        var flapGeometry = burstCarton ? paperboardGeometry(THREE, s.size[0], s.size[1], s.size[2],
          i < 2 ? 2 : 0, [-1, 1, -1, 1][i]) :
          new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]);
        var flapMats = faces(3);
        if (burstCarton) flapMats[[5, 4, 1, 0][i]] = ins; // folded hinge is inside the carton
        var mesh = new THREE.Mesh(flapGeometry, flapMats);
        mesh.position.set(s.off[0], burstCarton && i < 2 ? -t / 2 : t / 2, s.off[2]);
        pivot.add(mesh);
        G.add(pivot);
        this._flaps.push({ pivot: pivot, axis: s.axis, sign: s.sign });
      }

      var src = this.getAttribute('logo') || 'assets/frugends-logo-arena.png';
      // The printed mark occupies ~29% of the 40 x 20 cm front panel.
      var lw = burstCarton ? 0.21 : 0.27, lh = lw * (1007 / 1920);
      var logoMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.80, alphaTest: 0.5 });
      new THREE.TextureLoader().load(src, function (tex) {
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
        logoMat.map = tex; logoMat.needsUpdate = true;
      });
      var logo = new THREE.Mesh(new THREE.PlaneGeometry(lw, lh), logoMat);
      logo.position.set(0, h * 0.50, d / 2 + 0.0016);
      G.add(logo);
    }

    _applyTone() {
      if (!this._matOut) return;
      var c = new this._three.Color(this._kraft());
      this._matOut.color.copy(c);
      var burstCarton = this.getAttribute('scene') === 'burst';
      this._matIn.color.copy(c).multiplyScalar(burstCarton ? 0.94 : 0.58);
      this._matEdge.color.copy(c).multiplyScalar(burstCarton ? 0.99 : 0.80);
      if (burstCarton) this._burstInnerNeutral.copy(this._matIn.color);
    }

    _rebuild() {
      var THREE = this._three;
      var count = clamp(Math.round(this._num('objects', 13)), 6, CATALOG.length);
      var sizeScale = clamp(this._num('size', 1), 0.5, 1.4);
      var scene = this.getAttribute('scene') === 'burst' ? 'burst' : 'pack';
      if (this._objRoot) this._boxGroup.remove(this._objRoot);
      this._objRoot = new THREE.Group(); this._boxGroup.add(this._objRoot);

      var t0 = performance.now();
      var pack = bakePackIn(count, 20260918, sizeScale);
      this._bake = scene === 'burst' ? bakeBurst(count, 20260918, sizeScale, pack.settled) : pack;
      this._bakeMs = performance.now() - t0;
      this._sceneKind = scene;

      this._nodes = [];
      for (var i = 0; i < count; i++) {
        var b = this._bake.bodies[i], def = b.def, he = b.he;
        var mat = new THREE.MeshStandardMaterial({
          color: def.col,
          roughness: def.kind === 'can' ? 0.30 : def.kind === 'pillow' ? 0.46 : 0.74,
          metalness: def.kind === 'can' ? 0.72 : def.kind === 'pillow' ? 0.18 : 0.04
        });
        var item = buildItem(THREE, def, he, mat);
        var stretch = new THREE.Group(); stretch.add(item);
        this._objRoot.add(stretch);
        this._nodes.push({ stretch: stretch, mesh: item, mat: mat, def: def });
      }
      this._qA = new THREE.Quaternion(); this._qB = new THREE.Quaternion();
      this._qAl = new THREE.Quaternion();
      this._vP = new THREE.Vector3(); this._vV = new THREE.Vector3();
      this._vUp = new THREE.Vector3(0, 0, 1);
      this._anchorV = new THREE.Vector3();
    }

    _resize() {
      if (!this._renderer) return;
      var w = this.clientWidth, h = this.clientHeight;
      if (!w || !h) return;                 // 0-sized measure: keep the last valid buffer
      this._lastW = w; this._lastH = h;
      this._renderer.setSize(w, h, false);
      this._cam.aspect = w / h; this._cam.updateProjectionMatrix();
      if (this._fxMat) this._fxMat.uniforms.uRes.value.set(w * this._dpr, h * this._dpr);
    }

    _sample(time, i, outP, outQ, outV) {
      var bk = this._bake, n = bk.count;
      var f = clamp(time / DT, 0, bk.steps - 1);
      var f0 = Math.floor(f), f1 = Math.min(f0 + 1, bk.steps - 1), u = f - f0;
      var a = (f0 * n + i) * 7, b = (f1 * n + i) * 7, F = bk.frames;
      outP.set(lerp(F[a], F[b], u), lerp(F[a + 1], F[b + 1], u), lerp(F[a + 2], F[b + 2], u));
      this._qA.set(F[a + 3], F[a + 4], F[a + 5], F[a + 6]);
      this._qB.set(F[b + 3], F[b + 4], F[b + 5], F[b + 6]);
      outQ.copy(this._qA).slerp(this._qB, u);
      var f2 = Math.min(f0 + 2, bk.steps - 1), c = (f2 * n + i) * 7;
      outV.set((F[c] - F[a]) / (DT * 2), (F[c + 1] - F[a + 1]) / (DT * 2), (F[c + 2] - F[a + 2]) / (DT * 2));
    }

    _progress() {
      var host = this.closest('[data-scrub-track]') || this.parentElement;
      var hr = host.getBoundingClientRect();
      var vh = window.innerHeight || 1;
      var travel = hr.height - vh;
      if (travel <= 1) return clamp(0.5 - hr.top / vh, 0, 1);
      return clamp(-hr.top / travel, 0, 1);
    }

    _start() {
      if (this._raf) return;
      var self = this;
      var tick = function () {
        self._raf = null;
        if (self._stop || !self.isConnected) return;
        self._raf = requestAnimationFrame(tick);
        try { self._frame(); }
        catch (e) { if (!self._logged) { self._logged = true; console.error('[surprise-box]', e); } }
      };
      this._last = performance.now();
      this._raf = requestAnimationFrame(tick);
    }

    _frame() {
      var now = performance.now();
      var dt = Math.min((now - this._last) / 1000, 0.05);
      this._last = now;
      // the ResizeObserver can miss an instance that mounts at 0x0 far below
      // the fold, so re-check cheaply every frame
      if (this.clientWidth !== this._lastW || this.clientHeight !== this._lastH) this._resize();
      if (!this._visible || !this._bake) return;
      this._frameAcc += dt; this._frameN++;
      if (this._frameAcc > 0.4) { this._fps = this._frameN / this._frameAcc; this._frameAcc = 0; this._frameN = 0; }

      this._target = this._progress();
      this._t += (this._target - this._t) * (1 - Math.exp(-dt * 11));
      var t = this._t, burst = this._sceneKind === 'burst';

      var bullet = clamp(this._num('bullet', 0.65), 0, 1);
      var remap = burst ? burstSegments(bullet) : packSegments(bullet);
      var show = remap(t);
      var rate = Math.max(0, (remap(Math.min(t + 0.004, 1)) - show) / 0.004);
      var expl = burst ? explodeAt(t) : 0;
      var white = burst ? whiteAt(t) : 0;
      var ignition = burst ? ignitionAt(t) : 0;

      if (this._groundWashMat) {
        // Carry the internal ignition onto the alpha light catcher.
        this._groundWashMat.opacity = clamp(0.72 + ignition * 0.25 + expl * 0.10, 0, 1);
      }

      if (this._burstGlow) {
        var glowGrow = smooth(ramp(t, 0.075, 0.185));
        // Scroll-derived pulse: stable while the user pauses. A wall-clock
        // pulse made the nucleus shimmer between otherwise identical frames.
        var pulse = 1 + Math.sin(t * 28.0) * 0.038 * ignition;
        this._burstGlow.visible = ignition > 0.001;
        this._burstGlow.material.opacity = clamp(ignition * 0.92, 0, 0.92);
        this._burstGlow.material.rotation = t * 1.8;
        this._burstGlow.scale.setScalar((0.07 + glowGrow * 0.35) * pulse);
        this._burstGlow.position.y = BOX.h * (0.82 + glowGrow * 0.18);
        this._burstGlowVeil.visible = this._burstGlow.visible;
        this._burstGlowVeil.position.y = this._burstGlow.position.y + 0.008;
        this._burstGlowVeil.material.opacity = ignition * 0.42 * smooth(ramp(t, 0.115, 0.155)) *
          (1 - smooth(ramp(t, 0.22, 0.34)));
        this._burstGlowVeil.scale.setScalar(this._burstGlow.scale.x * 0.72);
        this._burstHalo.visible = ignition > 0.001;
        this._burstHalo.material.opacity = ignition;
        this._burstHalo.material.rotation = -t * 0.75;
        this._burstHalo.scale.setScalar((0.18 + glowGrow * 0.49) * pulse);
        this._burstHalo.position.y = this._burstGlow.position.y - 0.016;
        this._burstLight.position.y = BOX.h * (0.68 + glowGrow * 0.12);
        this._burstLight.intensity = ignition * 7.2;
        this._burstVioletLight.intensity = ignition * 3.8;
        // Let the coloured energy lead inside the box without dimming the
        // outer white paperboard enough to make it look grey.
        this._burstAmbient.intensity = 0.42 - ignition * 0.29;
        this._burstCavityFill.intensity = 1.05 - ignition * 0.95;
        this._matIn.color.copy(this._burstInnerNeutral).lerp(this._burstInnerEnergy, ignition);
      }

      var fa = flapAngles(this._sceneKind, show, t);
      for (var i = 0; i < this._flaps.length; i++) {
        var fl = this._flaps[i];
        fl.pivot.rotation.x = 0; fl.pivot.rotation.z = 0;
        fl.pivot.rotation[fl.axis] = fa[i] * fl.sign;
      }

      var stretchAmt = clamp(this._num('stretch', 0.6), 0, 1);
      var vp = this._vP, vv = this._vV, q = this._qAl, bq = this._qB;
      // Keep the products readable through the launch, then dissolve them only
      // as the expanding energy has genuinely taken over the viewport.
      var swallow = burst ? smooth(ramp(t, 0.76, 0.92)) : ramp(expl, 0.62, 0.96);
      var simT = Math.max(0, show);
      for (var j = 0; j < this._nodes.length; j++) {
        var nd = this._nodes[j];
        this._sample(simT, j, vp, bq, vv);
        var born = show >= this._bake.t0[j] - 1e-4;
        nd.stretch.visible = born && swallow < 0.99;
        if (!nd.stretch.visible) continue;
        nd.stretch.position.copy(vp);
        // no velocity stretch while the lid is still shut
        // Stretch follows actual on-screen speed. A forced trail on almost
        // stationary objects looked like a stuck frame during bullet-time.
        var visualRate = Math.min(rate, 6);
        var s = show < 0.01 ? 0 : clamp(vv.length() * visualRate * 0.022 * stretchAmt, 0, 0.42);
        if (s > 0.02) {
          q.setFromUnitVectors(this._vUp, vv.normalize());
          nd.stretch.quaternion.copy(q);
          var el = 1 + s, sq = 1 / Math.sqrt(el);
          nd.stretch.scale.set(sq, sq, el);
          nd.mesh.quaternion.copy(q).invert().multiply(bq);
        } else {
          nd.stretch.quaternion.identity();
          nd.stretch.scale.set(1, 1, 1);
          nd.mesh.quaternion.copy(bq);
        }
        // blown out by the detonation rather than simply hidden
        if (swallow > 0) {
          nd.mat.emissive.setRGB(swallow * 1.6, swallow * 1.35, swallow * 0.95);
          var k = 1 - swallow * 0.35;
          nd.stretch.scale.multiplyScalar(k);
        } else if (nd.mat.emissive.r !== 0) nd.mat.emissive.setRGB(0, 0, 0);
      }

      var fov = sampleCam(CAM[this._sceneKind], t, this._camP, this._camA, burst);
      // No wall-clock camera shake: it made the box, products and explosion
      // jitter against one another at a stationary scroll position.
      this._cam.position.copy(this._camP);
      this._cam.lookAt(this._camA);
      if (Math.abs(this._cam.fov - fov) > 0.01) { this._cam.fov = fov; this._cam.updateProjectionMatrix(); }
      this._blob.scale.setScalar(1 + Math.max(0, fa[1]) * 0.06);

      var R = this._renderer;
      R.clear();
      if (this._ignitionScene) R.render(this._ignitionScene, this._cam);
      R.render(this._scene, this._cam);

      if (expl > 0) {
        // Screen-space takeover is projected from just above the centre of the
        // mouth — never from the front wall/logo area.
        this._anchorV.set(0, BOX.h + 0.035, 0);
        this._boxGroup.localToWorld(this._anchorV);
        this._anchorV.project(this._cam);
        var u = this._fxMat.uniforms;
        u.uAnchor.value.set(this._anchorV.x * 0.5 + 0.5, this._anchorV.y * 0.5 + 0.5);
        // Turbulence is scroll-deterministic, making every scrubbed frame
        // spatially stable and exactly reversible.
        u.uProg.value = expl; u.uWhite.value = white; u.uTime.value = t * 1.8;
        R.render(this._fxScene, this._fxCam);
      }

      if (this._hud.style.display !== 'none') {
        var inf = R.info.render;
        this._hud.textContent =
          'FPS ' + this._fps.toFixed(0).padStart(3, ' ') + '   DPR ' + this._dpr.toFixed(2) + '   CALLS ' + inf.calls + '\n' +
          'SCROLL ' + t.toFixed(3) + '   SIM ' + show.toFixed(2) + 's   RATE ' + rate.toFixed(2) + '\n' +
          (burst ? 'EXPL ' + expl.toFixed(2) + '   WHITE ' + white.toFixed(2) + '   ' : 'OBJ ' + this._bake.count + '   ') +
          (rate < 0.9 && show > -0.2 && expl < 0.05 ? 'BULLET TIME' : expl > 0.05 ? 'DETONATION' : '—');
      }
    }
  }

  if (!window.customElements.get('surprise-box')) window.customElements.define('surprise-box', SurpriseBoxElement);
})();
