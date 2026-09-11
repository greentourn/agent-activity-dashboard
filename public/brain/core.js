/*
 * core.js — "สมอง" ที่อยู่กลางจอ
 *
 * นี่คือตัวละครหลักของหน้านี้: ก้อนพลังงานที่ต้อง "มีชีวิตตลอดเวลา" แม้ระบบไม่มีงานเลย
 * (ข้อกำหนดของผู้ใช้: ตอนรอคำสั่งก็ต้องเคลื่อนไหวเหมือนรอตอบสนอง) และต้องเปลี่ยนบุคลิก
 * ให้เห็นชัดเมื่อบริบทเปลี่ยน — คิด / เรียกเครื่องมือ / รอ sub-agent / รออนุญาต / ถูกบล็อก / แตก agent
 *
 * ชั้นของวัตถุ (เรียงจากในออกนอก):
 *   1. innerCore   ทรงกลมทึบเรืองแสง = แกนจิตสำนึก เต้นตามจังหวะคิด
 *   2. synapse     เส้นโค้งพาดผ่านภายใน มีพลังงานวิ่ง = การส่งสัญญาณ
 *   3. neurons     จุดบนผิวทรงกลมที่ถูก fbm ดันขึ้นลง = เนื้อสมอง
 *   4. cortex      เปลือกโปร่งแสง fresnel = ผิวสมอง
 *   5. gyroRings   วงแหวนสามวงหมุนคนละแกน = เครื่องมือวัดแบบ HUD ยานอวกาศ
 *   6. shockwaves  เปลือกทรงกลมที่ขยายแล้วจาง = เหตุการณ์ (spawn / error / prompt)
 *
 * ทุกชั้นอ่านค่าเดียวกันจาก ctx แล้วตีความเอง — ไม่มีชั้นไหนสั่งชั้นอื่นโดยตรง เพื่อให้เพิ่ม/ลด
 * ชั้นได้โดยไม่ต้องรื้อ logic ของอารมณ์
 */

import * as THREE from "three";
import { GLSL_COMMON } from "./shaders.js";
import { SEMANTIC_HEX, STATE_HEX, color } from "./palette.js";

/* พารามิเตอร์ของแต่ละอารมณ์ — ตารางเดียวที่ตัดสินว่า "หน้าตาของ mood นี้เป็นยังไง"
 * แก้ที่นี่ที่เดียวแล้วทั้งสมองเปลี่ยนพร้อมกัน */
/*
 * ค่า `spin` ถูกยกขึ้นทั้งตาราง 2026-09-09 (คำสั่งผู้ใช้): เดิมความรู้สึก "มีชีวิต" มาจากกล้องที่หมุนเอง
 * ซึ่งลากพื้นหลังทั้งจอไปด้วยจนเวียนหัวและไม่สื่ออะไร ตอนนี้กล้องนิ่งเป็นค่าเริ่มต้นแล้ว
 * สมองจึงต้องหมุนและหายใจของมันเองให้เห็นชัด — ของที่ขยับควรเป็นของที่ "มีเรื่องจะเล่า" เท่านั้น
 * (blocked จงใจหมุนช้าที่สุด เพราะต้องอ่านว่า "ค้าง/สั่น" ไม่ใช่ "กำลังทำงาน")
 */
const MOOD_PROFILE = {
  idle: { breath: 0.30, warp: 0.38, spin: 0.34, flow: 0.42, glow: 0.68, jitter: 0.0, swirl: 0.12, hue: STATE_HEX.idle },
  thinking: { breath: 0.62, warp: 0.78, spin: 0.62, flow: 0.95, glow: 0.98, jitter: 0.0, swirl: 1.15, hue: STATE_HEX.thinking },
  tool: { breath: 0.92, warp: 0.60, spin: 0.98, flow: 2.30, glow: 1.10, jitter: 0.02, swirl: -0.45, hue: STATE_HEX.tool },
  delegating: { breath: 0.78, warp: 0.68, spin: 0.84, flow: 1.72, glow: 1.06, jitter: 0.0, swirl: -0.24, hue: STATE_HEX.delegating },
  waiting: { breath: 0.16, warp: 0.30, spin: 0.16, flow: 0.26, glow: 0.60, jitter: 0.35, swirl: 0.0, hue: STATE_HEX.waiting },
  blocked: { breath: 1.30, warp: 1.15, spin: 0.10, flow: 0.30, glow: 1.20, jitter: 0.95, swirl: 0.0, hue: STATE_HEX.blocked },
  spawning: { breath: 1.15, warp: 0.85, spin: 1.25, flow: 2.80, glow: 1.18, jitter: 0.05, swirl: -0.9, hue: SEMANTIC_HEX.spawn },
};

const QUALITY = {
  low: { cortexDetail: 3, neuronCount: 2600, synapseCount: 34, synapseSeg: 18, rings: 2, waves: 4 },
  medium: { cortexDetail: 4, neuronCount: 4200, synapseCount: 64, synapseSeg: 26, rings: 3, waves: 6 },
  high: { cortexDetail: 5, neuronCount: 7200, synapseCount: 96, synapseSeg: 34, rings: 3, waves: 8 },
};

/* PRNG ของตัวเอง — ต้องได้สมองหน้าตาเดิมทุกครั้งที่รีเฟรช ไม่งั้นเทียบภาพก่อน/หลังแก้ไม่ได้ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* กระจายจุดบนผิวทรงกลมให้สม่ำเสมอจริง (fibonacci) — ถ้าสุ่มมุมตรง ๆ จุดจะกองที่ขั้ว */
function fibonacciSphere(i, n, out) {
  const k = i + 0.5;
  const phi = Math.acos(1 - (2 * k) / n);
  const theta = Math.PI * (1 + Math.sqrt(5)) * k;
  out.set(Math.cos(theta) * Math.sin(phi), Math.sin(theta) * Math.sin(phi), Math.cos(phi));
  return out;
}

export function createBrainCore(options = {}) {
  const opts = {
    radius: 5.2,
    quality: "high",
    seed: 20260909,
    ...options,
  };

  const group = new THREE.Group();
  group.name = "brain-core";

  let quality = QUALITY[opts.quality] ? opts.quality : "high";
  let Q = QUALITY[quality];
  const rand = mulberry32(opts.seed);
  const R = opts.radius;

  /* สถานะที่เดินต่อเนื่องทุกเฟรม — เก็บเป็น object เดียวเพื่อให้ update() อ่าน/เขียนที่เดียว */
  const S = {
    time: 0,
    breathPhase: 0,
    flowPhase: 0,
    spinPhase: 0,
    /* ค่าที่ "ไล่ตาม" เป้าหมายแบบสปริง — ทำให้เปลี่ยนอารมณ์แล้วไม่กระตุก */
    breath: MOOD_PROFILE.idle.breath,
    warp: MOOD_PROFILE.idle.warp,
    spin: MOOD_PROFILE.idle.spin,
    flow: MOOD_PROFILE.idle.flow,
    glow: MOOD_PROFILE.idle.glow,
    jitter: 0,
    swirl: 0,
    hue: color(STATE_HEX.idle).clone(),
    excite: 0, // 0..1 พุ่งขึ้นตอนมีเหตุการณ์ แล้วสลายเอง
    mood: "idle",
  };

  const disposables = [];
  const track = (obj) => {
    disposables.push(obj);
    return obj;
  };

  /* ───────────────────────── 1. แกนกลาง ───────────────────────── */

  const innerUniforms = {
    uTime: { value: 0 },
    uGlow: { value: 1 },
    uHue: { value: S.hue.clone() },
    uDeep: { value: color(SEMANTIC_HEX.coreDeep).clone() },
    uExcite: { value: 0 },
    uWarp: { value: 0.4 },
  };

  const innerCore = new THREE.Mesh(
    track(new THREE.IcosahedronGeometry(R * 0.42, 4)),
    track(
      new THREE.ShaderMaterial({
        uniforms: innerUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          ${GLSL_COMMON}
          uniform float uTime;
          uniform float uWarp;
          uniform float uExcite;
          varying vec3 vNormal;
          varying vec3 vView;
          varying float vNoise;

          void main() {
            /* ผิวแกนกลางเดือดตลอดเวลา — นี่คือสิ่งที่ทำให้ "ยังมีชีวิต" ตอน idle */
            float n = fbm(normal * 2.4 + vec3(0.0, uTime * 0.35, 0.0), 4);
            vNoise = n;
            vec3 p = position + normal * n * uWarp * (0.55 + uExcite * 0.9);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vNormal = normalize(normalMatrix * normal);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          ${GLSL_COMMON}
          uniform vec3 uHue;
          uniform vec3 uDeep;
          uniform float uGlow;
          uniform float uExcite;
          varying vec3 vNormal;
          varying vec3 vView;
          varying float vNoise;

          void main() {
            float f = fresnel(vView, vNormal, 2.1);
            /* ใจกลางเป็นสีลึก ขอบเป็นสีอารมณ์ปัจจุบัน — ได้ลุก "พลาสมาในขวดแก้ว" */
            vec3 col = mix(uDeep, uHue, clamp(f * 1.35 + vNoise * 0.35, 0.0, 1.0));
            col += uHue * uExcite * 0.8;
            float a = (0.04 + f * 0.30) * uGlow;
            gl_FragColor = vec4(col * (0.70 + uGlow * 0.35), clamp(a, 0.0, 0.85));
          }
        `,
      }),
    ),
  );
  group.add(innerCore);

  /* ───────────────────────── 2. เปลือกสมอง ───────────────────────── */

  const cortexUniforms = {
    uTime: { value: 0 },
    uWarp: { value: 0.4 },
    uGlow: { value: 1 },
    uHue: { value: S.hue.clone() },
    uJitter: { value: 0 },
    uExcite: { value: 0 },
    uBreath: { value: 0 },
  };

  const cortex = new THREE.Mesh(
    track(new THREE.IcosahedronGeometry(R, Q.cortexDetail)),
    track(
      new THREE.ShaderMaterial({
        uniforms: cortexUniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          ${GLSL_COMMON}
          #define FISSURE_DEPTH ${(R * 0.10).toFixed(3)}
          #define SULCI_DEPTH ${(R * 0.035).toFixed(3)}

          /*
           * brainShape — ดัดทรงกลมให้อ่านออกว่าเป็น "สมอง":
           *   1) ร่องกลาง (longitudinal fissure) ดึงผิวใกล้ระนาบ x=0 ยุบลงไป ⇒ เห็นเป็นสองซีก
           *   2) บีบเป็นทรงรี กว้างซ้าย-ขวา แบนบน-ล่างเล็กน้อย
           * เปลือกกับจุดเนื้อสมองต้องใช้สูตรเดียวกันเป๊ะ ไม่งั้นจุดจะลอยหลุดออกนอกเปลือก
           */
          vec3 brainShape(vec3 pos, vec3 nrm, float ridge, float warp, float breath) {
            vec3 p = pos + nrm * ridge * warp + nrm * breath;
            float fissure = smoothstep(0.0, 0.20, abs(nrm.x));
            p -= nrm * (1.0 - fissure) * FISSURE_DEPTH;
            /* ร่องขวางตื้น ๆ อีกชุด (sulci) ให้ผิวไม่เรียบเป็นไข่ */
            float sulci = sin(nrm.y * 9.0 + nrm.z * 6.0) * 0.5 + 0.5;
            p -= nrm * smoothstep(0.72, 1.0, sulci) * SULCI_DEPTH;
            return p * vec3(1.13, 0.93, 1.02);
          }
          uniform float uTime;
          uniform float uWarp;
          uniform float uJitter;
          uniform float uBreath;
          varying vec3 vNormal;
          varying vec3 vView;
          varying float vRidge;

          void main() {
            vec3 n = normalize(position);
            /* สองความถี่: ก้อนใหญ่ = รูปทรงสมอง, ก้อนเล็ก = ร่องหยัก */
            float slow = fbm(n * 1.6 + vec3(uTime * 0.09, 0.0, uTime * 0.06), 4);
            float fine = fbm(n * 5.5 - vec3(0.0, uTime * 0.22, 0.0), 3);
            /* jitter = อาการสั่นตอน "รออนุญาต/ถูกบล็อก" ทำให้ผิดปกติเห็นได้จากหางตา */
            float shake = uJitter * (hash11(dot(n, vec3(12.9898, 78.233, 37.719)) + floor(uTime * 18.0)) - 0.5);
            float ridge = slow * 0.62 + fine * 0.24 + shake;
            vRidge = ridge;
            vec3 p = brainShape(position, n, ridge, uWarp, uBreath);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vNormal = normalize(normalMatrix * n);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          ${GLSL_COMMON}
          uniform vec3 uHue;
          uniform float uGlow;
          uniform float uExcite;
          uniform float uTime;
          varying vec3 vNormal;
          varying vec3 vView;
          varying float vRidge;

          void main() {
            float f = fresnel(vView, vNormal, 2.6);
            /* เส้นชั้นความสูงบนผิว = ลายวงจร ทำให้ดู "สังเคราะห์" ไม่ใช่ก้อนเมฆ */
            float contour = smoothstep(0.86, 1.0, abs(sin(vRidge * 26.0 - uTime * 1.1)));
            vec3 col = uHue * (f * 0.95 + contour * 0.85 + 0.04);
            col += uHue * uExcite * 0.35;
            float a = (f * 0.20 + contour * 0.20 + 0.008) * uGlow;
            if (a < 0.004) discard;
            gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
          }
        `,
      }),
    ),
  );
  group.add(cortex);

  /* ───────────────────────── 3. เนื้อสมอง (จุด) ───────────────────────── */

  function buildNeurons(count) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const scale = new Float32Array(count);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      fibonacciSphere(i, count, v);
      /* ดันจุดเข้า-ออกจากผิวเล็กน้อย ให้เป็น "เปลือกหนา" ไม่ใช่แผ่นบาง */
      const shell = 0.90 + rand() * 0.16;
      pos[i * 3] = v.x * R * shell;
      pos[i * 3 + 1] = v.y * R * shell;
      pos[i * 3 + 2] = v.z * R * shell;
      seed[i] = rand() * 100;
      scale[i] = 0.5 + rand() * rand() * 2.6; // ส่วนใหญ่เล็ก มีบางจุดเด่น
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    geo.setAttribute("aScale", new THREE.BufferAttribute(scale, 1));
    return geo;
  }

  const neuronUniforms = {
    uTime: { value: 0 },
    uWarp: { value: 0.4 },
    uGlow: { value: 1 },
    uHue: { value: S.hue.clone() },
    uSwirl: { value: 0 },
    uExcite: { value: 0 },
    uBreath: { value: 0 },
    uPixelRatio: { value: 1 },
    uSize: { value: 2.6 },
  };

  let neuronGeo = track(buildNeurons(Q.neuronCount));
  const neuronMat = track(
    new THREE.ShaderMaterial({
      uniforms: neuronUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        ${GLSL_COMMON}
        #define FISSURE_DEPTH ${(R * 0.10).toFixed(3)}
        #define SULCI_DEPTH ${(R * 0.035).toFixed(3)}

        /*
         * brainShape — ดัดทรงกลมให้อ่านออกว่าเป็น "สมอง":
         *   1) ร่องกลาง (longitudinal fissure) ดึงผิวใกล้ระนาบ x=0 ยุบลงไป ⇒ เห็นเป็นสองซีก
         *   2) บีบเป็นทรงรี กว้างซ้าย-ขวา แบนบน-ล่างเล็กน้อย
         * เปลือกกับจุดเนื้อสมองต้องใช้สูตรเดียวกันเป๊ะ ไม่งั้นจุดจะลอยหลุดออกนอกเปลือก
         */
        vec3 brainShape(vec3 pos, vec3 nrm, float ridge, float warp, float breath) {
          vec3 p = pos + nrm * ridge * warp + nrm * breath;
          float fissure = smoothstep(0.0, 0.20, abs(nrm.x));
          p -= nrm * (1.0 - fissure) * FISSURE_DEPTH;
          /* ร่องขวางตื้น ๆ อีกชุด (sulci) ให้ผิวไม่เรียบเป็นไข่ */
          float sulci = sin(nrm.y * 9.0 + nrm.z * 6.0) * 0.5 + 0.5;
          p -= nrm * smoothstep(0.72, 1.0, sulci) * SULCI_DEPTH;
          return p * vec3(1.13, 0.93, 1.02);
        }
        uniform float uTime;
        uniform float uWarp;
        uniform float uSwirl;
        uniform float uBreath;
        uniform float uPixelRatio;
        uniform float uSize;
        uniform float uExcite;
        attribute float aSeed;
        attribute float aScale;
        varying float vTwinkle;
        varying float vDepth;
        varying float vRidge;

        void main() {
          vec3 n = normalize(position);
          float coarse = fbm(n * 1.6 + vec3(uTime * 0.09, 0.0, uTime * 0.06), 4);
          float fine = fbm(n * 5.5 - vec3(0.0, uTime * 0.22, 0.0), 3);
          float ridge = coarse * 0.62 + fine * 0.24;
          /* ridged noise (1 - |n|) ทำให้เกิด "สัน" คมชัดแบบร่องสมอง แทนที่จะเป็นคลื่นนุ่ม ๆ
             ค่านี้ส่งต่อไป fragment เพื่อหรี่จุดที่อยู่ก้นร่อง — นั่นคือสิ่งที่ทำให้เห็นเป็นโครงสร้าง
             ไม่ใช่ลูกบอลเรืองแสงตัน (ปัญหาที่เจอจริงตอนทดสอบรอบแรก) */
          vRidge = 1.0 - abs(coarse * 1.35);
          vec3 p = brainShape(position, n, ridge, uWarp, uBreath);

          /* uSwirl > 0 = พลังงานหมุนวน "เข้าใน" ตอนคิด · < 0 = สะบัดออกตอนเรียกเครื่องมือ */
          float band = p.y / ${R.toFixed(2)};
          float ang = uSwirl * (0.55 + band * 0.35) * uTime * 0.45;
          p = rotY(ang) * p;
          p *= 1.0 - uSwirl * 0.035 * sin(uTime * 0.8 + aSeed);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          /* กระพริบไม่พร้อมกัน — เฟสมาจาก seed ต่อจุด ทำให้ผิวมีชีวิตแม้ค่าอื่นนิ่ง */
          vTwinkle = 0.45 + 0.55 * sin(uTime * (1.1 + fract(aSeed) * 2.2) + aSeed * 6.28);
          vDepth = -mv.z;
          gl_PointSize = uSize * aScale * uPixelRatio * (34.0 / max(1.0, -mv.z))
                       * (0.75 + vTwinkle * 0.5 + uExcite * 0.6)
                       * (0.45 + smoothstep(0.0, 1.0, vRidge) * 0.85);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLSL_COMMON}
        uniform vec3 uHue;
        uniform float uGlow;
        uniform float uExcite;
        varying float vTwinkle;
        varying float vDepth;
        varying float vRidge;

        void main() {
          float d = softDisc(gl_PointCoord, 0.15);
          if (d <= 0.001) discard;
          float core = pow(d, 3.0);
          vec3 col = mix(uHue, vec3(1.0), core * 0.45 + uExcite * 0.15);
          /* จุดที่อยู่ไกลกล้องจางกว่ามาก — ถ้าไม่ทำ ซีกหลังของทรงกลมจะทะลุมาบวกกับซีกหน้า
             จนตรงกลางกลายเป็นสีขาวตัน มองไม่เห็นว่าเป็นสมอง */
          float depthFade = smoothstep(46.0, 16.0, vDepth);
          /* สัน = สว่าง · ร่อง = เกือบดับ ⇒ ผิวมีลายให้ตาจับได้ */
          float ridgeMask = smoothstep(0.05, 0.95, vRidge);
          float a = d * (0.030 + vTwinkle * 0.095) * uGlow * (0.30 + depthFade * 0.80)
                  * (0.25 + ridgeMask * 1.05);
          gl_FragColor = vec4(col, a);
        }
      `,
    }),
  );
  let neurons = new THREE.Points(neuronGeo, neuronMat);
  neurons.frustumCulled = false;
  group.add(neurons);

  /* ───────────────────────── 4. เส้นประสาท (synapse) ───────────────────────── */

  /*
   * เส้นโค้งพาดข้ามภายในสมอง แต่ละเส้นมี "พลังงาน" วิ่งจากปลายหนึ่งไปอีกปลาย
   * ความเร็วและจำนวนพัลส์คือสิ่งที่บอกว่าระบบกำลังทำงานหนักแค่ไหน — ตอน idle ก็ยังวิ่ง
   * แต่ช้าและจาง เพื่อให้ "รอคำสั่ง" ไม่เท่ากับ "ตาย"
   */
  function buildSynapses(countArcs, segments) {
    const geo = new THREE.BufferGeometry();
    const vertsPerArc = segments * 2; // LineSegments: ทีละคู่
    const total = countArcs * vertsPerArc;
    const pos = new Float32Array(total * 3);
    const prog = new Float32Array(total);
    const seed = new Float32Array(total);

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();

    let w = 0;
    for (let arc = 0; arc < countArcs; arc += 1) {
      fibonacciSphere(Math.floor(rand() * 4096), 4096, a).multiplyScalar(R * (0.86 + rand() * 0.12));
      fibonacciSphere(Math.floor(rand() * 4096), 4096, b).multiplyScalar(R * (0.86 + rand() * 0.12));
      /* จุดควบคุมดึงเข้าหาศูนย์กลาง → เส้นพาดผ่านใจกลางสมอง ไม่ใช่เลียบผิว */
      mid.copy(a).add(b).multiplyScalar(0.5).multiplyScalar(0.18 + rand() * 0.30);
      const s = rand() * 100;
      for (let i = 0; i < segments; i += 1) {
        const t0 = i / segments;
        const t1 = (i + 1) / segments;
        quadratic(a, mid, b, t0, p0);
        quadratic(a, mid, b, t1, p1);
        pos[w * 3] = p0.x; pos[w * 3 + 1] = p0.y; pos[w * 3 + 2] = p0.z;
        prog[w] = t0; seed[w] = s; w += 1;
        pos[w * 3] = p1.x; pos[w * 3 + 1] = p1.y; pos[w * 3 + 2] = p1.z;
        prog[w] = t1; seed[w] = s; w += 1;
      }
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aProgress", new THREE.BufferAttribute(prog, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    return geo;
  }

  function quadratic(a, c, b, t, out) {
    const it = 1 - t;
    out.set(
      it * it * a.x + 2 * it * t * c.x + t * t * b.x,
      it * it * a.y + 2 * it * t * c.y + t * t * b.y,
      it * it * a.z + 2 * it * t * c.z + t * t * b.z,
    );
    return out;
  }

  const synapseUniforms = {
    uTime: { value: 0 },
    uFlow: { value: 0 },
    uGlow: { value: 1 },
    uHue: { value: S.hue.clone() },
    uHot: { value: color(SEMANTIC_HEX.white).clone() },
    uExcite: { value: 0 },
    uSpin: { value: 0 },
  };

  let synapseGeo = track(buildSynapses(Q.synapseCount, Q.synapseSeg));
  const synapseMat = track(
    new THREE.ShaderMaterial({
      uniforms: synapseUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        ${GLSL_COMMON}
        uniform float uTime;
        uniform float uSpin;
        attribute float aProgress;
        attribute float aSeed;
        varying float vProgress;
        varying float vSeed;

        void main() {
          vProgress = aProgress;
          vSeed = aSeed;
          /* หมุนทั้งพวงช้า ๆ คนละเฟส เพื่อไม่ให้ลายเส้นนิ่งเป็นภาพวาด */
          vec3 p = rotY(uTime * uSpin * 0.35 + aSeed * 0.01) * position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLSL_COMMON}
        uniform float uTime;
        uniform float uFlow;
        uniform float uGlow;
        uniform float uExcite;
        uniform vec3 uHue;
        uniform vec3 uHot;
        varying float vProgress;
        varying float vSeed;

        void main() {
          /* หัวพัลส์วิ่งจาก 0→1 ซ้ำไปเรื่อย ๆ · เฟสต่างกันตาม seed ของเส้น */
          float head = fract(uTime * uFlow * 0.22 + fract(vSeed * 0.017));
          float d = abs(vProgress - head);
          d = min(d, 1.0 - d);
          float pulse = smoothstep(0.10, 0.0, d);
          float tail = smoothstep(0.34, 0.0, d) * 0.30;

          float base = 0.018 + 0.022 * sin(vSeed + uTime * 0.6);
          vec3 col = mix(uHue, uHot, pulse * 0.75);
          float a = (base + pulse * 0.75 + tail * 0.7) * uGlow * (0.70 + uExcite * 0.5);
          if (a < 0.004) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
    }),
  );
  let synapses = new THREE.LineSegments(synapseGeo, synapseMat);
  synapses.frustumCulled = false;
  group.add(synapses);

  /* ───────────────────────── 5. วงแหวน gyroscope ───────────────────────── */

  const ringGroup = new THREE.Group();
  group.add(ringGroup);
  const rings = [];

  const ringMat = track(
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHue: { value: S.hue.clone() },
        uGlow: { value: 1 },
        uJitter: { value: 0 },
        uExcite: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLSL_COMMON}
        uniform float uTime;
        uniform vec3 uHue;
        uniform float uGlow;
        uniform float uJitter;
        uniform float uExcite;
        varying vec2 vUv;

        void main() {
          /* ขีดสเกลรอบวง + ช่วงเรืองที่วิ่งไปรอบ ๆ = มาตรวัดที่กำลังอ่านค่า */
          float ticks = step(0.72, fract(vUv.x * 96.0));
          float sweep = smoothstep(0.16, 0.0, abs(fract(vUv.x - uTime * 0.11) - 0.5));
          float body = 0.16 + ticks * 0.30 + sweep * 0.85;
          /* ตอน jitter สูง ขีดจะกระตุกเป็นช่วง ๆ เหมือนสัญญาณขาด */
          body *= 1.0 - uJitter * step(0.5, fract(vUv.x * 13.0 + floor(uTime * 12.0) * 0.37)) * 0.8;
          vec3 col = uHue * (0.7 + sweep * 0.8 + uExcite * 0.5);
          gl_FragColor = vec4(col, body * uGlow * 0.30);
        }
      `,
    }),
  );

  function buildRings(count) {
    for (const r of rings) {
      ringGroup.remove(r.mesh);
      r.mesh.geometry.dispose();
    }
    rings.length = 0;
    const specs = [
      { r: R * 1.34, tube: 0.030, tilt: [0.0, 0.0, 0.0], speed: 0.16 },
      { r: R * 1.62, tube: 0.022, tilt: [Math.PI / 2.6, 0.4, 0.0], speed: -0.11 },
      { r: R * 1.94, tube: 0.016, tilt: [-Math.PI / 3.2, -0.7, 0.3], speed: 0.07 },
    ];
    for (let i = 0; i < count && i < specs.length; i += 1) {
      const s = specs[i];
      const geo = new THREE.TorusGeometry(s.r, s.tube, 8, 220);
      const mesh = new THREE.Mesh(geo, ringMat);
      mesh.rotation.set(s.tilt[0], s.tilt[1], s.tilt[2]);
      ringGroup.add(mesh);
      rings.push({ mesh, speed: s.speed, base: s.tilt.slice() });
    }
  }
  buildRings(Q.rings);

  /* ───────────────────────── 6. คลื่นกระแทก (เหตุการณ์) ───────────────────────── */

  /*
   * pool ของเปลือกทรงกลมที่ขยายออกแล้วจางหาย — ใช้เป็น "เสียง" ของเหตุการณ์:
   * spawn = มิ้นต์, error = แดง, prompt = ขาว. ทำเป็น pool เพราะเหตุการณ์มาเป็นชุด
   * (spawn 40 ตัวรวดเดียว) การสร้าง geometry ใหม่ทุกครั้งจะกระตุก
   */
  const waveGeo = track(new THREE.IcosahedronGeometry(1, 5));
  const waves = [];
  function buildWaves(count) {
    for (const w of waves) {
      group.remove(w.mesh);
      w.mesh.material.dispose();
    }
    waves.length = 0;
    for (let i = 0; i < count; i += 1) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uProgress: { value: 1 },
          uHue: { value: new THREE.Color(SEMANTIC_HEX.spawn) },
          uStrength: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        vertexShader: /* glsl */ `
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vNormal = normalize(normalMatrix * normal);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          ${GLSL_COMMON}
          uniform float uProgress;
          uniform float uStrength;
          uniform vec3 uHue;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            if (uProgress >= 1.0) discard;
            float f = fresnel(vView, vNormal, 3.4);
            /* จางแบบกำลังสาม: แรงตอนออก แล้วหายไว ไม่ค้างจนรก */
            float fade = pow(1.0 - uProgress, 4.0);
            float a = f * fade * uStrength * 0.16;
            if (a < 0.003) discard;
            gl_FragColor = vec4(uHue * (0.8 + f), a);
          }
        `,
      });
      const mesh = new THREE.Mesh(waveGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      group.add(mesh);
      waves.push({ mesh, mat, progress: 1, speed: 1, from: R * 0.5, to: R * 3 });
    }
  }
  buildWaves(Q.waves);
  let waveCursor = 0;

  /* ───────────────────────── API ───────────────────────── */

  /** ยิงคลื่นกระแทกออกจากสมอง — ใช้ตอน spawn / error / prompt ใหม่ */
  function shockwave({ hex = SEMANTIC_HEX.spawn, strength = 1, speed = 1, reach = 3.0 } = {}) {
    const w = waves[waveCursor % waves.length];
    waveCursor += 1;
    w.progress = 0;
    w.speed = speed;
    w.from = R * 0.55;
    w.to = R * reach;
    w.mat.uniforms.uHue.value.set(hex);
    w.mat.uniforms.uStrength.value = strength;
    w.mesh.visible = true;
    return w;
  }

  /** กระตุ้นสมองชั่วขณะ (ไม่มีคลื่น) — ใช้กับเหตุการณ์ย่อย เช่น tool เริ่ม/จบ */
  function excite(amount = 0.4) {
    S.excite = Math.min(1.6, S.excite + amount);
  }

  function setQuality(level) {
    if (!QUALITY[level] || level === quality) return;
    quality = level;
    Q = QUALITY[level];

    group.remove(neurons);
    neuronGeo.dispose();
    neuronGeo = buildNeurons(Q.neuronCount);
    neurons = new THREE.Points(neuronGeo, neuronMat);
    neurons.frustumCulled = false;
    group.add(neurons);

    group.remove(synapses);
    synapseGeo.dispose();
    synapseGeo = buildSynapses(Q.synapseCount, Q.synapseSeg);
    synapses = new THREE.LineSegments(synapseGeo, synapseMat);
    synapses.frustumCulled = false;
    group.add(synapses);

    /* เปลือกสมองสร้างใหม่ตาม detail — geometry เก่าต้องคืน ไม่งั้นสลับคุณภาพไปมาแล้ว VRAM บวม */
    const oldGeo = cortex.geometry;
    cortex.geometry = new THREE.IcosahedronGeometry(R, Q.cortexDetail);
    oldGeo.dispose();

    buildRings(Q.rings);
    buildWaves(Q.waves);
  }

  function setPixelRatio(ratio) {
    neuronUniforms.uPixelRatio.value = ratio;
  }

  /* สปริงแบบเฟรมเรตอิสระ — ค่าที่ไล่ตามเป้าหมายด้วยอัตราเดียวกันไม่ว่าจะ 30 หรือ 144 fps */
  function chase(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.pow(1 - rate, dt * 60));
  }

  /*
   * ท่าทางของทั้งก้อนสมอง — โยก/ส่าย/ลอยขึ้นลงคนละคาบกัน
   * มีไว้เพราะการหมุนรอบแกนเดียวอ่านออกยากเมื่อทรงเกือบกลม: พอเพิ่มการเอียงสองแกนกับการลอย
   * ตาจะจับได้ทันทีว่า "ก้อนนี้กำลังเคลื่อนไหว" โดยที่กล้องกับพื้นหลังยังนิ่งสนิท
   * (คำสั่งผู้ใช้ 2026-09-09: ให้การเคลื่อนไหวไปอยู่ที่วัตถุกลางจอแทนกล้อง/ฉากหลัง)
   */
  function poseGroup(dt, amount) {
    const t = S.time;
    group.rotation.x = Math.sin(t * 0.23) * 0.16 * amount;
    group.rotation.z = Math.sin(t * 0.17 + 1.1) * 0.11 * amount;
    group.position.y = Math.sin(t * 0.31 + 0.4) * 0.42 * amount;
    group.position.x = Math.sin(t * 0.13 + 2.2) * 0.26 * amount;
  }

  function update(dt, ctx = {}) {
    const mood = MOOD_PROFILE[ctx.mood] ? ctx.mood : "idle";
    const P = MOOD_PROFILE[mood];
    const activity = Math.max(0, Math.min(1, ctx.activity || 0));
    S.mood = mood;
    S.time += dt;

    /* ความยุ่งเร่งทุกอย่างขึ้นอีกชั้นบนอารมณ์ — ยุ่งมากตอนคิด ≠ ยุ่งน้อยตอนคิด */
    const boost = 1 + activity * 0.85;
    S.breath = chase(S.breath, P.breath * boost, 0.05, dt);
    S.warp = chase(S.warp, P.warp * (1 + activity * 0.35), 0.05, dt);
    S.spin = chase(S.spin, P.spin * boost, 0.04, dt);
    S.flow = chase(S.flow, P.flow * boost, 0.06, dt);
    S.glow = chase(S.glow, P.glow * (0.9 + activity * 0.35), 0.05, dt);
    S.jitter = chase(S.jitter, P.jitter, 0.12, dt);
    S.swirl = chase(S.swirl, P.swirl, 0.03, dt);
    S.hue.lerp(color(P.hue), 1 - Math.pow(1 - 0.04, dt * 60));

    /* excite สลายเอง — เหตุการณ์จึงเป็น "แสงวาบ" ไม่ใช่สถานะค้าง */
    S.excite = Math.max(0, S.excite - dt * 1.15);
    const excite = Math.min(1, S.excite) + (ctx.pulse || 0) * 0.5;

    S.breathPhase += dt * S.breath;
    S.flowPhase += dt * S.flow;
    S.spinPhase += dt * S.spin;

    /* ลมหายใจ: ไซน์สองความถี่ซ้อนกัน ให้จังหวะไม่ซ้ำเป๊ะจนดูเป็นเครื่องจักร */
    const breath =
      Math.sin(S.breathPhase * 2.0) * 0.055 + Math.sin(S.breathPhase * 0.73 + 1.3) * 0.03;
    const breathAbs = breath * R;

    innerUniforms.uTime.value = S.time;
    innerUniforms.uGlow.value = S.glow * (1 + excite * 0.35);
    innerUniforms.uHue.value.copy(S.hue);
    innerUniforms.uExcite.value = excite;
    innerUniforms.uWarp.value = S.warp;
    innerCore.scale.setScalar(1 + breath * 1.6 + excite * 0.10);
    innerCore.rotation.y = S.spinPhase * 0.95;
    innerCore.rotation.x = Math.sin(S.time * 0.21) * 0.35;

    cortexUniforms.uTime.value = S.time;
    cortexUniforms.uWarp.value = S.warp;
    cortexUniforms.uGlow.value = S.glow;
    cortexUniforms.uHue.value.copy(S.hue);
    cortexUniforms.uJitter.value = S.jitter;
    cortexUniforms.uExcite.value = excite;
    cortexUniforms.uBreath.value = breathAbs;
    cortex.rotation.y = S.spinPhase * 0.62;

    neuronUniforms.uTime.value = S.time;
    neuronUniforms.uWarp.value = S.warp;
    neuronUniforms.uGlow.value = S.glow;
    neuronUniforms.uHue.value.copy(S.hue);
    neuronUniforms.uSwirl.value = S.swirl;
    neuronUniforms.uExcite.value = excite;
    neuronUniforms.uBreath.value = breathAbs;
    /* เปลือกกับเนื้อสมองต้องหมุนอัตราเดียวกันเป๊ะ ไม่งั้นจุดจะเลื่อนหลุดจากร่องของเปลือก */
    neurons.rotation.y = S.spinPhase * 0.62;

    synapseUniforms.uTime.value = S.time;
    synapseUniforms.uFlow.value = S.flow;
    synapseUniforms.uGlow.value = S.glow * (0.85 + activity * 0.5);
    synapseUniforms.uHue.value.copy(S.hue);
    synapseUniforms.uExcite.value = excite;
    synapseUniforms.uSpin.value = S.spin;

    ringMat.uniforms.uTime.value = S.time;
    ringMat.uniforms.uHue.value.copy(S.hue);
    ringMat.uniforms.uGlow.value = S.glow;
    ringMat.uniforms.uJitter.value = S.jitter;
    ringMat.uniforms.uExcite.value = excite;
    for (let i = 0; i < rings.length; i += 1) {
      const r = rings[i];
      r.mesh.rotation.z += dt * r.speed * (0.6 + activity * 1.6);
      r.mesh.rotation.x = r.base[0] + Math.sin(S.time * 0.13 + i) * 0.12;
      const wobble = S.jitter * Math.sin(S.time * 30 + i * 2.1) * 0.05;
      r.mesh.scale.setScalar(1 + breath * 0.5 + excite * 0.05 + wobble);
    }

    for (const w of waves) {
      if (w.progress >= 1) {
        if (w.mesh.visible) w.mesh.visible = false;
        continue;
      }
      w.progress = Math.min(1, w.progress + dt * 1.35 * w.speed);
      const e = 1 - Math.pow(1 - w.progress, 2.4); // ออกเร็ว ชะลอปลาย
      const radius = w.from + (w.to - w.from) * e;
      w.mesh.scale.setScalar(radius);
      w.mat.uniforms.uProgress.value = w.progress;
      if (w.progress >= 1) w.mesh.visible = false;
    }

    /* ยิ่งยุ่งยิ่งโยกแรงขึ้นเล็กน้อย — แต่ไม่เคยหยุดนิ่งแม้ตอน idle */
    poseGroup(dt, 0.75 + activity * 0.6 + excite * 0.3);

    return { breath, excite, hue: S.hue };
  }

  function dispose() {
    for (const d of disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    for (const w of waves) w.mat.dispose();
    for (const r of rings) r.mesh.geometry.dispose();
    group.clear();
  }

  return {
    group,
    update,
    shockwave,
    excite,
    setQuality,
    setPixelRatio,
    dispose,
    get radius() {
      return R;
    },
    get mood() {
      return S.mood;
    },
    get info() {
      return { quality, neurons: Q.neuronCount, synapses: Q.synapseCount, waves: waves.length };
    },
  };
}
