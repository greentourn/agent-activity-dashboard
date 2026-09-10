// starfield.js
// ฉากหลังของ visualizer "สมอง AI" แบบ abstract ไฮเทคอนาคต
// ประกอบด้วย 4 องค์ประกอบที่เปิด/ปิดได้อิสระ: dust (ฝุ่นดาว), grid (กริดหมอกประสาท),
// nebula (เนบิวลาพื้นหลัง), motes (จุดพลังงานลอย) — ทุกอย่างเคลื่อนไหวตลอดเวลาแม้ตอน idle
// เพื่อสื่อว่าระบบ "ตื่นอยู่ รอคำสั่ง" ห้ามหยุดนิ่งเด็ดขาด
//
// import ได้เฉพาะ three core (r180) — ห้าม import three/examples และห้าม CDN

import * as THREE from "three";

// ---------------------------------------------------------------------------
// ยูทิลิตี้ทั่วไป
// ---------------------------------------------------------------------------

// จำกัดค่าให้อยู่ในช่วง 0..1 และกันค่าที่ไม่ใช่ตัวเลข (undefined/NaN) ไม่ให้พังการเรนเดอร์
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ไล่ current เข้าหา target แบบ exponential smoothing ที่ไม่ขึ้นกับเฟรมเรต (ใช้ dt จริง)
function smoothTo(current, target, dt, speed) {
  if (!(dt > 0)) return current;
  const t = 1 - Math.exp(-speed * dt);
  return current + (target - current) * t;
}

// สุ่มจุดแบบกระจายสม่ำเสมอ "ตามปริมาตร" ภายในเปลือกทรงกลมกลวง (hollow sphere shell)
// ใช้ cube-root sampling เพื่อไม่ให้จุดกระจุกตัวใกล้จุดศูนย์กลาง
function randomPointInShell(innerRadius, outerRadius) {
  const u = Math.random();
  const r = Math.cbrt(u * (outerRadius ** 3 - innerRadius ** 3) + innerRadius ** 3);
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const sinPhi = Math.sin(phi);
  return [
    r * sinPhi * Math.cos(theta),
    r * sinPhi * Math.sin(theta),
    r * Math.cos(phi),
  ];
}

function getPixelRatio() {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// ---------------------------------------------------------------------------
// GLSL — Deep-space dust (THREE.Points)
// ---------------------------------------------------------------------------

const DUST_VERTEX_SHADER = `
  attribute float aSeed;
  attribute float aSize;
  attribute vec3 aColor;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uTwinkleSpeed;

  varying vec3 vColor;
  varying float vTwinkle;
  varying float vDist;

  void main() {
    vColor = aColor;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mvPosition.xyz);

    // twinkle ต่อจุด: sin ของเวลา บวก seed เฉพาะจุด (กันไม่ให้จุดกระพริบพร้อมกันหมด)
    vTwinkle = 0.5 + 0.5 * sin(uTime * uTwinkleSpeed + aSeed * 6.2831853);

    gl_PointSize = aSize * uPixelRatio * (200.0 / max(vDist, 1.0));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const DUST_FRAGMENT_SHADER = `
  uniform float uIntensity;
  uniform vec3 uTintColor;
  uniform float uTintMix;
  uniform float uFadeNear;
  uniform float uFadeFar;

  varying vec3 vColor;
  varying float vTwinkle;
  varying float vDist;

  void main() {
    // จุดวงกลมนุ่ม ๆ แทนสี่เหลี่ยมของ point sprite ดิบ
    vec2 uv = gl_PointCoord - vec2(0.5);
    float shape = smoothstep(0.5, 0.0, length(uv));

    // fade ตามระยะกล้อง: จางเมื่อใกล้กล้องเกินไป (กันจุดโตทะลุจอ) และจางเมื่อไกลเข้าหมอก
    float fadeNear = smoothstep(0.0, uFadeNear, vDist);
    float fadeFarT = smoothstep(uFadeFar * 0.6, uFadeFar, vDist);
    float fade = fadeNear * (1.0 - fadeFarT);

    vec3 baseColor = mix(vColor, uTintColor, uTintMix);
    float twinkleAmt = 0.35 + 0.65 * vTwinkle;
    float alpha = shape * fade * twinkleAmt * uIntensity;

    gl_FragColor = vec4(baseColor, alpha);
  }
`;

// ---------------------------------------------------------------------------
// GLSL — Neural haze grid (THREE.LineSegments)
// ---------------------------------------------------------------------------

const GRID_VERTEX_SHADER = `
  attribute float aDist;

  uniform float uTime;
  uniform float uShake;

  varying float vDist;

  // hash เล็ก ๆ ไว้สั่นกริดตอน mood = blocked
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  void main() {
    vDist = aDist;

    vec3 pos = position;
    if (uShake > 0.0001) {
      float n = hash11(aDist * 12.9898 + floor(uTime * 8.0));
      pos.y += (n - 0.5) * uShake;
    }

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const GRID_FRAGMENT_SHADER = `
  uniform float uTime;
  uniform float uRippleSpeed;
  uniform float uIntensity;
  uniform vec3 uColor;
  uniform float uFadeRadius;

  varying float vDist;

  void main() {
    // ระลอกคลื่นวิ่งออกจากศูนย์กลางกริดแบบ radar ช้า ๆ
    float wave = sin(vDist * 0.35 - uTime * uRippleSpeed);
    float ripple = smoothstep(0.85, 1.0, wave);
    float base = 0.12;

    // หายไปในหมอกเมื่อไกลจากศูนย์กลาง
    float fadeT = smoothstep(uFadeRadius * 0.35, uFadeRadius, vDist);
    float fade = 1.0 - fadeT;

    float glow = (base + ripple * 0.9) * fade * uIntensity;
    gl_FragColor = vec4(uColor, glow);
  }
`;

// ---------------------------------------------------------------------------
// GLSL — Volumetric nebula backdrop (sphere กลับด้าน + fbm noise)
// ---------------------------------------------------------------------------

const NEBULA_VERTEX_SHADER = `
  varying vec3 vPos;

  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NEBULA_FRAGMENT_SHADER = `
  uniform float uTime;
  uniform float uFlowSpeed;
  uniform float uSwirl;
  uniform vec3 uColorDeep;
  uniform vec3 uColorGlow;
  uniform float uIntensity;

  varying vec3 vPos;

  // hash 3D -> 1D (เขียนเอง ไม่พึ่ง lib)
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // value noise 3D แบบ trilinear interpolation
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);

    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);

    return mix(nxy0, nxy1, f.z);
  }

  // fractal brownian motion — ซ้อน noise หลายความถี่เป็นก้อนเมฆ
  float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 5; i++) {
      sum += amp * noise3(p * freq);
      freq *= 2.02;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec3 p = normalize(vPos) * 2.2;

    // หมุนพิกัดตัวอย่างช้า ๆ ตามเวลา (uSwirl สลับทิศตอน mood = thinking)
    float ang = uTime * uFlowSpeed * uSwirl;
    float ca = cos(ang);
    float sa = sin(ang);
    vec3 q = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);
    q.y += uTime * uFlowSpeed * 0.15;

    float n1 = fbm(q);
    float n2 = fbm(q * 1.7 + 5.2);
    float cloud = smoothstep(0.35, 0.85, n1) * 0.7 + smoothstep(0.5, 0.9, n2) * 0.3;

    vec3 color = mix(uColorDeep, uColorGlow, cloud);
    float brightness = uIntensity * (0.25 + cloud * 0.6);

    gl_FragColor = vec4(color * brightness, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// GLSL — Energy motes (THREE.Points ลอยขึ้นช้า ๆ แล้ววนกลับ)
// ---------------------------------------------------------------------------

const MOTE_VERTEX_SHADER = `
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aSize;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uRiseSpeed;
  uniform float uHeight;

  varying float vAlpha;

  void main() {
    // cycle วิ่ง 0..1 ซ้ำไปเรื่อย ๆ ต่อจุด (ความเร็ว/เฟสต่างกันตาม attribute)
    float cycle = fract(uTime * uRiseSpeed * aSpeed + aPhase);

    vec3 pos = position;
    pos.y += (cycle - 0.5) * uHeight;

    // envelope จาง-ทึบ-จาง เพื่อกลบรอยต่อตอนวนกลับ (ไม่ให้เห็นจุดหายวับ)
    float envelope = smoothstep(0.0, 0.12, cycle) * smoothstep(1.0, 0.85, cycle);
    vAlpha = envelope;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    float dist = length(mvPosition.xyz);
    gl_PointSize = aSize * uPixelRatio * (220.0 / max(dist, 1.0));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const MOTE_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uTintColor;
  uniform float uTintMix;
  uniform float uIntensity;

  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float shape = smoothstep(0.5, 0.0, length(uv));

    vec3 finalColor = mix(uColor, uTintColor, uTintMix);
    float alpha = shape * vAlpha * uIntensity;

    gl_FragColor = vec4(finalColor, alpha);
  }
`;

// ---------------------------------------------------------------------------
// ระบบย่อย: Deep-space dust
// ---------------------------------------------------------------------------

function createDustSystem({ count, radius, colorA, colorB }) {
  const innerRadius = radius / 3;
  const outerRadius = radius * (7 / 6);

  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);

  const white = new THREE.Color(0xffffff);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const [x, y, z] = randomPointInShell(innerRadius, outerRadius);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    seeds[i] = Math.random() * 1000;
    sizes[i] = 0.6 + Math.random() * 1.8;

    tmpColor.copy(colorA).lerp(colorB, Math.random());
    if (Math.random() < 0.15) tmpColor.lerp(white, 0.6); // ผสมขาวจาง ๆ บางจุด
    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  geometry.setDrawRange(0, count);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: getPixelRatio() },
      uTwinkleSpeed: { value: 0.6 },
      uIntensity: { value: 1 },
      uTintColor: { value: new THREE.Color() },
      uTintMix: { value: 0 },
      uFadeNear: { value: innerRadius * 0.5 },
      uFadeFar: { value: outerRadius },
    },
    vertexShader: DUST_VERTEX_SHADER,
    fragmentShader: DUST_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  let visibleCount = count;

  return {
    points,
    geometry,
    material,
    baseCount: count,
    update(dt, state, tintColor) {
      material.uniforms.uTime.value = state.time;
      material.uniforms.uTwinkleSpeed.value = 0.6 + state.activity * 1.6;
      material.uniforms.uTintColor.value.copy(tintColor);
      material.uniforms.uTintMix.value = state.moodBlocked;
      material.uniforms.uIntensity.value = state.intensity * (1 + state.pulse * 0.6);
      points.rotation.y += dt * (0.008 + state.activity * 0.02);
    },
    setVisibleCount(n) {
      visibleCount = Math.max(0, Math.min(count, Math.floor(n)));
      geometry.setDrawRange(0, visibleCount);
    },
    getVisibleCount() {
      return visibleCount;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// ระบบย่อย: Neural haze grid
// ---------------------------------------------------------------------------

function buildGridGeometry(size, divisions) {
  const half = size / 2;
  const step = size / divisions;
  const positions = [];
  const dists = [];

  const pushLine = (x1, z1, x2, z2) => {
    positions.push(x1, 0, z1, x2, 0, z2);
    dists.push(Math.hypot(x1, z1), Math.hypot(x2, z2));
  };

  for (let i = 0; i <= divisions; i++) {
    const p = -half + i * step;
    pushLine(p, -half, p, half); // เส้นขนานแกน Z
    pushLine(-half, p, half, p); // เส้นขนานแกน X
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("aDist", new THREE.BufferAttribute(new Float32Array(dists), 1));
  return geometry;
}

function createGridSystem({ radius, colorA, colorB }) {
  const size = radius * 2.5;
  const divisions = 28;
  const geometry = buildGridGeometry(size, divisions);
  const baseColor = colorA.clone().lerp(colorB, 0.5);
  const baseY = -radius * 0.35;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRippleSpeed: { value: 1.6 },
      uIntensity: { value: 1 },
      uShake: { value: 0 },
      uColor: { value: baseColor.clone() },
      uFadeRadius: { value: size * 0.5 },
    },
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  // เอียงเป็นพื้นแล้วขยับลงต่ำกว่าจุดศูนย์กลาง ให้ความรู้สึกมีมิติแบบ perspective floor
  lines.rotation.x = -Math.PI / 2 + 0.22;
  lines.position.y = baseY;

  let rippleEnabled = true;
  const tmpColor = new THREE.Color();

  return {
    lines,
    geometry,
    material,
    baseY,
    update(dt, state, alertColor) {
      material.uniforms.uTime.value = state.time;
      material.uniforms.uRippleSpeed.value = rippleEnabled ? 1.6 + state.activity * 3.2 : 0;
      material.uniforms.uShake.value = state.moodBlocked * 1.2;
      material.uniforms.uIntensity.value = state.intensity * (1 + state.pulse * 0.5);

      tmpColor.copy(baseColor).lerp(alertColor, state.moodBlocked);
      material.uniforms.uColor.value.copy(tmpColor);
    },
    setRippleEnabled(enabled) {
      rippleEnabled = enabled;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// ระบบย่อย: Volumetric nebula backdrop
// ---------------------------------------------------------------------------

function createNebulaSystem({ radius, colorB, colorAlert, colorDeepThink }) {
  const geometry = new THREE.SphereGeometry(radius, 48, 32);

  const colorDeep = new THREE.Color().setHSL((0.6 + 0.72) / 2, 0.55, 0.045);
  const baseGlow = colorB.clone();
  baseGlow.multiplyScalar(0.5);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFlowSpeed: { value: 0.03 },
      uSwirl: { value: 1 },
      uColorDeep: { value: colorDeep },
      uColorGlow: { value: baseGlow.clone() },
      uIntensity: { value: 1 },
    },
    vertexShader: NEBULA_VERTEX_SHADER,
    fragmentShader: NEBULA_FRAGMENT_SHADER,
    side: THREE.BackSide,
    transparent: false,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10; // วาดก่อนเสมอ ให้เป็นฉากหลังสุด ไม่บังวัตถุหลัก

  const tmpColor = new THREE.Color();

  return {
    mesh,
    geometry,
    material,
    update(dt, state) {
      material.uniforms.uTime.value = state.time;
      material.uniforms.uFlowSpeed.value = 0.03 + state.activity * 0.05;
      // mood = thinking -> หมุนวนเข้าใน (สลับทิศ)
      material.uniforms.uSwirl.value = state.moodThinking > 0.5 ? -1 : 1;
      material.uniforms.uIntensity.value = state.intensity * (1 + state.pulse * 0.4);

      // โทนม่วงเข้มขึ้นตอน thinking, แดง/ส้มตอน blocked
      tmpColor.copy(baseGlow).lerp(colorDeepThink, state.moodThinking);
      tmpColor.lerp(colorAlert, state.moodBlocked);
      material.uniforms.uColorGlow.value.copy(tmpColor);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// ระบบย่อย: Energy motes
// ---------------------------------------------------------------------------

function createMoteSystem({ count, radius, colorB }) {
  const spread = radius * 0.8;
  const height = radius * 0.9;

  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const speeds = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 0.4;
    positions[i * 3 + 2] = Math.sin(angle) * r;

    phases[i] = Math.random();
    speeds[i] = 0.05 + Math.random() * 0.06;
    sizes[i] = 1.2 + Math.random() * 1.6;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

  const baseColor = colorB.clone().lerp(new THREE.Color(0xffffff), 0.3);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: getPixelRatio() },
      uRiseSpeed: { value: 1 },
      uHeight: { value: height },
      uIntensity: { value: 1 },
      uColor: { value: baseColor },
      uTintColor: { value: new THREE.Color() },
      uTintMix: { value: 0 },
    },
    vertexShader: MOTE_VERTEX_SHADER,
    fragmentShader: MOTE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    geometry,
    material,
    count,
    update(dt, state, alertColor) {
      material.uniforms.uTime.value = state.time;
      material.uniforms.uRiseSpeed.value = 1 + state.activity * 1.2;
      material.uniforms.uIntensity.value = state.intensity * (1 + state.pulse * 0.6);
      material.uniforms.uTintColor.value.copy(alertColor);
      material.uniforms.uTintMix.value = state.moodBlocked;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createStarfield(options = {}) {
  const {
    dust = true,
    grid = true,
    nebula = true,
    motes = true,
    dustCount = 4000,
    moteCount = 120,
    radius = 120,
    hueA = 0.58,
    hueB = 0.76,
  } = options;

  const group = new THREE.Group();
  group.name = "starfield";

  // โทนสีหลัก (ฟ้า→ม่วง) และโทนแจ้งเตือน/สถานะพิเศษ ใช้ lerp ข้ามไปมาตอน mood เปลี่ยน
  const colorA = new THREE.Color().setHSL(hueA, 0.75, 0.6);
  const colorB = new THREE.Color().setHSL(hueB, 0.7, 0.55);
  const colorAlert = new THREE.Color().setHSL(0.05, 0.85, 0.55);
  const colorDeepThink = new THREE.Color().setHSL(hueB, 0.9, 0.28);

  let quality = "high";
  let externalIntensity = 1;
  let internalTime = 0;
  let moodBlocked = 0;
  let moodThinking = 0;

  const dustSystem = dust
    ? createDustSystem({ count: dustCount, radius, colorA, colorB })
    : null;
  if (dustSystem) group.add(dustSystem.points);

  const gridSystem = grid
    ? createGridSystem({ radius, colorA, colorB })
    : null;
  if (gridSystem) group.add(gridSystem.lines);

  const nebulaSystem = nebula
    ? createNebulaSystem({ radius: radius * 2.5, colorB, colorAlert, colorDeepThink })
    : null;
  if (nebulaSystem) group.add(nebulaSystem.mesh);

  const moteSystem = motes
    ? createMoteSystem({ count: moteCount, radius, colorB })
    : null;
  if (moteSystem) group.add(moteSystem.points);

  function update(dt, ctx = {}) {
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    internalTime += safeDt;

    const time = Number.isFinite(ctx.time) ? ctx.time : internalTime;
    const activity = clamp01(ctx.activity);
    const pulse = clamp01(ctx.pulse);
    const mood = typeof ctx.mood === "string" ? ctx.mood : "idle";

    moodBlocked = smoothTo(moodBlocked, mood === "blocked" ? 1 : 0, safeDt, 3);
    moodThinking = smoothTo(moodThinking, mood === "thinking" ? 1 : 0, safeDt, 2);

    const state = {
      time,
      activity,
      pulse,
      moodBlocked,
      moodThinking,
      intensity: externalIntensity,
    };

    if (dustSystem) dustSystem.update(safeDt, state, colorAlert);
    if (gridSystem) gridSystem.update(safeDt, state, colorAlert);
    if (nebulaSystem) nebulaSystem.update(safeDt, state);
    if (moteSystem) moteSystem.update(safeDt, state, colorAlert);

    // parallax เบา ๆ จากความสูงกล้อง (ถ้าผู้เรียกส่งมา) — ทนถ้าไม่มี field นี้
    if (gridSystem && ctx.cameraPos && typeof ctx.cameraPos.y === "number") {
      gridSystem.lines.position.y = gridSystem.baseY + ctx.cameraPos.y * 0.04;
    }
  }

  function setQuality(level) {
    quality = level === "low" || level === "medium" ? level : "high";
    const isLow = quality === "low";

    if (nebulaSystem) nebulaSystem.mesh.visible = !isLow;
    if (dustSystem) {
      dustSystem.setVisibleCount(isLow ? Math.floor(dustSystem.baseCount / 3) : dustSystem.baseCount);
    }
    if (gridSystem) gridSystem.setRippleEnabled(!isLow);
  }

  function setIntensity(v) {
    externalIntensity = clamp01(v);
  }

  function dispose() {
    if (dustSystem) dustSystem.dispose();
    if (gridSystem) gridSystem.dispose();
    if (nebulaSystem) nebulaSystem.dispose();
    if (moteSystem) moteSystem.dispose();
    group.clear();
  }

  return {
    group,
    update,
    setQuality,
    setIntensity,
    dispose,
    get info() {
      const pointCount = (dustSystem ? dustSystem.getVisibleCount() : 0) + (moteSystem ? moteSystem.count : 0);
      return {
        objects: group.children.length,
        points: pointCount,
        quality,
      };
    },
  };
}
