/*
 * agents.js — ดงโหนดของ session/sub-agent ที่โคจรรอบสมอง และสายสัญญาณที่เชื่อมพวกมัน
 *
 * นี่คือส่วนที่ตอบโจทย์ "spawn sub-agent ต่อกันเป็นทอด ๆ" โดยตรง:
 *   - agent ทุกตัวเป็นดวงไฟที่โคจรรอบ "พ่อ" ของตัวเอง ไม่ใช่รอบจุดกลางจอ
 *     ⇒ ลูกของ agent (depth 2, 3, 4…) จึงเห็นเป็นพวงที่ห้อยต่อกันลงไปจริง ๆ
 *   - ตอนเกิด: สายจากพ่อ "งอก" ออกไปก่อน (uSpawn ตัดความยาวเส้น) แล้วดวงไฟจึงผุดขึ้นที่ปลาย
 *     ถ้าเกิดพร้อมกันหลายตัว จะทยอยงอกไล่กันตาม batchIndex → ได้ภาพน้ำตกแบบทอด ๆ
 *   - ระหว่างทำงาน: มีพัลส์วิ่งบนสายตลอด ความถี่ผูกกับว่ามี tool ค้างอยู่กี่ตัว
 *   - ตอนจบ: ดวงไฟวาบขึ้นครั้งหนึ่งแล้วหรี่ลงเป็น "ความทรงจำ" สีตามผลลัพธ์ (ok/ล้ม)
 *
 * เรื่องประสิทธิภาพ: sub-agent อาจมีหลายร้อยตัว (เคยวัดได้ 192 ตัวใน run เดียว) จึงเรนเดอร์
 * ทั้งดงด้วย THREE.Points ตัวเดียว + สายทั้งหมดด้วย LineSegments ตัวเดียว แล้วอัปเดต attribute
 * แทนการสร้าง Mesh ต่อโหนด — สร้าง object ต่อโหนดคือทางที่ทำให้เฟรมตกตอน storm
 */

import * as THREE from "three";
import { GLSL_COMMON } from "./shaders.js";
import { SEMANTIC_HEX, modelColor, outcomeColor, stateColor } from "./palette.js";

const MAX_NODES = 640;
const MAX_LINKS = 640;
/*
 * สายที่แตกออกมาเป็น **เส้นตรง** (คำสั่งผู้ใช้ 2026-09-10: "อยากให้เส้นที่แตกออกมาเป็นเส้นตรง
 * มากกว่าเส้นโค้ง") ⇒ ต้องการแค่ 2 ปลาย ไม่ต้องซอยเป็นท่อน
 *
 * ทำไมท่อนเดียวถึงให้ภาพ "เหมือนเดิมทุกพิกเซล" ทั้งที่เดิมซอย 16 ท่อน: attribute ของสายทุกตัว
 * เป็นฟังก์ชันเชิงเส้นของ t (aProgress = t · สีไล่จากสีแม่ไปสีลูก · aSpawn/aFlow/aSeed/aLive/aWeight
 * คงที่ทั้งเส้น) และเอฟเฟกต์ที่ตาเห็น — พัลส์วิ่ง · หัวลำแสงตอนงอก · การตัดส่วนที่ยังไม่งอก —
 * คิดใน fragment shader จาก `vProgress` ล้วน ๆ ซึ่ง WebGL interpolate ให้แบบ perspective-correct
 * ตามพารามิเตอร์จริงของเส้นอยู่แล้ว ⇒ ซอยเพิ่มได้แค่ "จุดยอดเปลืองขึ้น 16 เท่า" ไม่ได้ภาพเพิ่ม
 */
const LINK_SEG = 1;

/* คลื่นเหตุการณ์ที่วิ่งออกไปตามสาย: เร็ว (หน่วย/วินาที) และระยะที่จางหมดพอดี — ดู surge() */
const SURGE_SPEED = 46;
const SURGE_REACH = 72;

const QUALITY = {
  low: { halo: false, trail: false },
  medium: { halo: true, trail: false },
  high: { halo: true, trail: true },
};

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function createAgentField(options = {}) {
  const opts = {
    coreRadius: 5.2,
    quality: "high",
    sessionOrbit: 13.5,
    ...options,
  };

  let quality = QUALITY[opts.quality] ? opts.quality : "high";
  let Q = QUALITY[quality];

  const group = new THREE.Group();
  group.name = "agent-field";

  /** key → node — แหล่งความจริงเดียวของทุกอย่างที่ลอยอยู่ */
  const nodes = new Map();
  /** เก็บลำดับไว้ต่างหาก เพราะ buffer ต้องเขียนตามลำดับที่แน่นอน */
  let order = [];
  let selectedKey = null;
  let hoverKey = null;
  let time = 0;
  /* คลื่นเหตุการณ์ที่วิ่งออกไปตามสาย — ความแรงที่สลายเอง + รัศมีของหน้าคลื่น (ดู surge()) */
  let surgeAmp = 0;
  let surgeRadius = 0;
  /* นับตัวที่ถูกตัดทิ้งเพราะชนเพดานบัฟเฟอร์ — ต้องบอกคนดูได้ว่าภาพ "ไม่ครบ" ไม่ใช่เงียบ ๆ
     (stress test จริงแตะ 579 โหนดจากเพดาน 640 มาแล้ว) */
  let truncated = 0;

  /* ช่องประจำของแต่ละ session: ให้เลขเดิมตลอด แม้ session อื่นจะหายไป
     (ถ้าคำนวณจาก index ปัจจุบัน ทุกตัวจะเด้งย้ายที่ทุกครั้งที่มีใครจบ) */
  const sessionSlots = new Map();
  let sessionCount = 0;
  function sessionSlot(key) {
    if (!sessionSlots.has(key)) {
      sessionSlots.set(key, sessionCount);
      sessionCount += 1;
    }
    return sessionSlots.get(key);
  }

  const tmpA = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const projected = new THREE.Vector3();

  /* ───────────────────────── ดวงไฟ (Points) ───────────────────────── */

  const nodeGeo = new THREE.BufferGeometry();
  const nPos = new Float32Array(MAX_NODES * 3);
  const nColor = new Float32Array(MAX_NODES * 3);
  const nSize = new Float32Array(MAX_NODES);
  const nState = new Float32Array(MAX_NODES); // 0=จบแล้ว 1=กำลังวิ่ง
  const nSpawn = new Float32Array(MAX_NODES); // 0..1 ความคืบของแอนิเมชันเกิด
  const nFlash = new Float32Array(MAX_NODES); // แสงวาบชั่วขณะ (เกิด/จบ/tool)
  const nSeed = new Float32Array(MAX_NODES);
  const nSelect = new Float32Array(MAX_NODES); // 0=ปกติ 1=hover 2=selected
  /*
   * aKin บอก "ตำแหน่งในสายพันธุ์" เพื่อให้แยกแม่กับลูกได้จากรูปทรง ไม่ใช่แค่ตำแหน่ง:
   *   0 = ใบ (ไม่มีลูก) · 1 = แม่ (มีลูกอย่างน้อยหนึ่ง) · 2 = session (ต้นสาย)
   * เดิมทุกโหนดหน้าตาเหมือนกันหมด ⇒ ดูไม่ออกว่าใครแตกใครออกมา (คำสั่งผู้ใช้ 2026-09-09)
   */
  const nKin = new Float32Array(MAX_NODES);

  nodeGeo.setAttribute("position", new THREE.BufferAttribute(nPos, 3).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setAttribute("aColor", new THREE.BufferAttribute(nColor, 3).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setAttribute("aSize", new THREE.BufferAttribute(nSize, 1).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setAttribute("aState", new THREE.BufferAttribute(nState, 1).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setAttribute("aSpawn", new THREE.BufferAttribute(nSpawn, 1).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setAttribute("aFlash", new THREE.BufferAttribute(nFlash, 1).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setAttribute("aSeed", new THREE.BufferAttribute(nSeed, 1));
  nodeGeo.setAttribute("aSelect", new THREE.BufferAttribute(nSelect, 1).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setAttribute("aKin", new THREE.BufferAttribute(nKin, 1).setUsage(THREE.DynamicDrawUsage));
  nodeGeo.setDrawRange(0, 0);
  nodeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

  const nodeUniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uActivity: { value: 0 },
  };

  const nodeMat = new THREE.ShaderMaterial({
    uniforms: nodeUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aState;
      attribute float aSpawn;
      attribute float aFlash;
      attribute float aSeed;
      attribute float aSelect;
      attribute float aKin;
      varying vec3 vColor;
      varying float vState;
      varying float vFlash;
      varying float vSelect;
      varying float vBeat;
      varying float vKin;

      void main() {
        vColor = aColor;
        vState = aState;
        vFlash = aFlash;
        vSelect = aSelect;
        vKin = aKin;
        /* หัวใจเต้น: ตัวที่กำลังวิ่งเต้นแรงและเร็วกว่าตัวที่จบแล้วชัดเจน */
        float rate = mix(0.9, 3.4, aState);
        vBeat = 0.5 + 0.5 * sin(uTime * rate + aSeed * 6.28318);

        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        /* ease-out-back ตอนเกิด: พุ่งเกินขนาดจริงนิดหนึ่งแล้วหดกลับ = รู้สึกว่า "ผุด" */
        float s = aSpawn;
        float pop = s < 1.0 ? (1.70158 + 1.0) * pow(s, 3.0) - 1.70158 * pow(s, 2.0) : 1.0;
        float size = aSize * pop * (0.80 + vBeat * mix(0.18, 0.55, aState) + vFlash * 0.9 + vSelect * 0.35);
        /* หารด้วยระยะเพื่อให้ขนาดคงที่ในโลกจริง แต่ต้องมีเพดาน ไม่งั้นโหนดที่ลอยมาใกล้
           กล้องจะบานเป็นวงกลมเต็มจอจนบังทุกอย่าง (เจอจริงตอนทดสอบด้วย 250 โหนด)
           ตัวคูณและเพดานถูกยกขึ้น 2026-09-09 ตามคำสั่งผู้ใช้ที่ขอให้ "ชัดเจนหรือใหญ่ขึ้น" */
        gl_PointSize = min(size * uPixelRatio * (36.0 / max(1.0, -mv.z)), 76.0 * uPixelRatio);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_COMMON}
      uniform float uTime;
      varying vec3 vColor;
      varying float vState;
      varying float vFlash;
      varying float vSelect;
      varying float vBeat;
      varying float vKin;

      void main() {
        vec2 uv = gl_PointCoord;
        float d = length(uv - 0.5) * 2.0;
        if (d > 1.0) discard;

        /*
         * โหนดถูกวาดเป็น "ตรา" ไม่ใช่ "ดวงไฟตัน" (แก้ 2026-09-09):
         * ตอนโหนดใหญ่ขึ้นตามคำสั่งผู้ใช้ ดวงตัน + bloom กลายเป็นวงขาวไร้รายละเอียด กลบทั้ง
         * วงแหวนบอกลำดับชั้นของตัวเองและกลบสมองกลางจอ ⇒ ให้ความ "ใหญ่" มาจากเส้นขอบ
         * ส่วนความสว่างเก็บไว้ที่ไส้เล็ก ๆ ตรงกลางเท่านั้น
         */
        float core = smoothstep(0.34, 0.0, d);          // ไส้เล็กแต่สว่าง = ตำแหน่งที่แท้จริง
        float glow = smoothstep(1.0, 0.15, d) * 0.16;   // ฟุ้งบาง ๆ ให้รู้ว่ามีตัวตน
        float rim = smoothstep(0.06, 0.0, abs(d - 0.74)); // ขอบวง = ขนาดที่ตาอ่านได้

        /* วงสถานะ: มีเฉพาะตัวที่ยังทำงาน และหายใจอยู่ตลอด */
        float ringR = 0.52 + 0.05 * sin(uTime * 2.4 + vBeat * 3.0);
        float ring = smoothstep(0.055, 0.0, abs(d - ringR)) * vState * (0.45 + vBeat * 0.55);

        /*
         * เครื่องหมายตำแหน่งในสายพันธุ์ (คำสั่งผู้ใช้ 2026-09-09):
         *   ใบ      = ไส้ + ขอบวง
         *   แม่     = + วงนอกอีกชั้น ⇒ "ตัวนี้แตกลูกต่อ"
         *   session = + แฉกกากบาท ⇒ ต้นสายของทั้งพวง
         */
        float kinRing = smoothstep(0.05, 0.0, abs(d - 0.93)) * step(0.5, vKin) * (0.55 + vBeat * 0.35);
        float flare = 0.0;
        if (vKin > 1.5) {
          vec2 q = abs(uv - 0.5) * 2.0;
          flare = (smoothstep(0.10, 0.0, q.x) * smoothstep(1.0, 0.1, q.y)
                 + smoothstep(0.10, 0.0, q.y) * smoothstep(1.0, 0.1, q.x)) * 0.55;
        }

        float sel = smoothstep(0.045, 0.0, abs(d - 1.0)) * vSelect;

        vec3 col = vColor * (0.75 + rim * 0.5 + ring * 0.4) + vec3(1.0) * (core * 0.75 + vFlash * 0.7);
        float a = core * 0.85 + glow + rim * 0.55 + ring * 0.6 + kinRing * 0.6 + flare * 0.5 + sel * 0.9;
        /* ตัวที่จบแล้วจางลงชัดเจน — เหลือไว้เป็นร่องรอย ไม่ใช่ตัวเอก */
        a *= 0.42 + vState * 0.58 + vFlash * 0.8;
        if (a < 0.004) discard;
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }
    `,
  });

  const points = new THREE.Points(nodeGeo, nodeMat);
  points.frustumCulled = false;
  group.add(points);

  /* ───────────────────────── สายสัญญาณ (LineSegments) ───────────────────────── */

  const linkGeo = new THREE.BufferGeometry();
  const lVerts = MAX_LINKS * LINK_SEG * 2;
  const lPos = new Float32Array(lVerts * 3);
  const lColor = new Float32Array(lVerts * 3);
  const lProg = new Float32Array(lVerts); // 0..1 ตำแหน่งตามความยาวสาย
  const lSpawn = new Float32Array(lVerts); // ความคืบของการ "งอก"
  const lFlow = new Float32Array(lVerts); // ความเร็วพัลส์
  const lSeed = new Float32Array(lVerts);
  const lLive = new Float32Array(lVerts); // 1 = ปลายทางยังวิ่งอยู่
  const lWeight = new Float32Array(lVerts); // ยิ่งแม่มีลูกมาก สายยิ่งเด่น (log ของจำนวนลูก)

  linkGeo.setAttribute("position", new THREE.BufferAttribute(lPos, 3).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setAttribute("aColor", new THREE.BufferAttribute(lColor, 3).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setAttribute("aProgress", new THREE.BufferAttribute(lProg, 1).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setAttribute("aSpawn", new THREE.BufferAttribute(lSpawn, 1).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setAttribute("aFlow", new THREE.BufferAttribute(lFlow, 1).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setAttribute("aSeed", new THREE.BufferAttribute(lSeed, 1).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setAttribute("aLive", new THREE.BufferAttribute(lLive, 1).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setAttribute("aWeight", new THREE.BufferAttribute(lWeight, 1).setUsage(THREE.DynamicDrawUsage));
  linkGeo.setDrawRange(0, 0);
  linkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

  const linkUniforms = {
    uTime: { value: 0 },
    uActivity: { value: 0 },
    /*
     * คลื่นเหตุการณ์ที่วิ่ง "ออกไปตามสาย" (คำสั่งผู้ใช้ 2026-09-10: เหตุการณ์ต้องขยับสมอง/เส้น
     * ไม่ใช่กล้องหรือฉากหลัง) — uSurgeR คือรัศมีของหน้าคลื่นที่ขยายจากสมองออกไป
     * และ uSurge คือความแรงที่สลายตัวเอง ⇒ ทุกเหตุการณ์เห็นเป็น "แสงวิ่งออกไปตามกิ่ง" หนึ่งครั้ง
     */
    uSurge: { value: 0 },
    uSurgeR: { value: 0 },
  };

  const linkMat = new THREE.ShaderMaterial({
    uniforms: linkUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aProgress;
      attribute float aSpawn;
      attribute float aFlow;
      attribute float aSeed;
      attribute float aLive;
      attribute float aWeight;
      varying vec3 vColor;
      varying float vProgress;
      varying float vSpawn;
      varying float vFlow;
      varying float vSeed;
      varying float vLive;
      varying float vWeight;
      varying float vRadius;

      void main() {
        vColor = aColor;
        vProgress = aProgress;
        vSpawn = aSpawn;
        vFlow = aFlow;
        vSeed = aSeed;
        vLive = aLive;
        vWeight = aWeight;
        /* ระยะจากใจกลางสมอง — ใช้ให้คลื่นเหตุการณ์วิ่งออกไปตามกิ่งได้ตามลำดับชั้นจริง
           (ถ้าวัดด้วย t ของแต่ละสาย ทุกชั้นจะสว่างพร้อมกันหมด อ่านไม่ออกว่าคลื่นวิ่งไปทางไหน) */
        vRadius = length(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_COMMON}
      uniform float uTime;
      uniform float uSurge;
      uniform float uSurgeR;
      varying vec3 vColor;
      varying float vProgress;
      varying float vSpawn;
      varying float vFlow;
      varying float vSeed;
      varying float vLive;
      varying float vWeight;
      varying float vRadius;

      void main() {
        /* การ "งอก": ส่วนที่เลย vSpawn ยังไม่มีอยู่จริง — ตัดทิ้งไปเลย */
        if (vProgress > vSpawn) discard;
        /* ขอบที่กำลังงอกสว่างกว่าปกติ = หัวลำแสงที่กำลังพุ่งไปหาลูก */
        float tip = smoothstep(0.14, 0.0, vSpawn - vProgress) * (1.0 - step(0.999, vSpawn));

        /* พัลส์ข้อมูลวิ่งจากพ่อไปลูก — สายที่ปลายทางจบแล้วจะเหลือแค่เส้นจาง ๆ */
        float head = fract(uTime * vFlow + fract(vSeed));
        float d = abs(vProgress - head);
        d = min(d, 1.0 - d);
        float pulse = smoothstep(0.09, 0.0, d) * vLive;
        float head2 = fract(uTime * vFlow * 0.61 + fract(vSeed * 1.7) + 0.5);
        float d2 = abs(vProgress - head2);
        d2 = min(d2, 1.0 - d2);
        pulse += smoothstep(0.06, 0.0, d2) * 0.6 * vLive;

        /*
         * คลื่นเหตุการณ์: แถบสว่างที่วิ่งออกจากสมองไปตามกิ่ง วัดด้วย "ระยะจากใจกลาง" ไม่ใช่ t
         * ⇒ สายชั้นในสว่างก่อน แล้วไล่ออกไปชั้นนอก เห็นเป็นคลื่นเดียวที่พุ่งออกไปตามโครงสร้างจริง
         * นี่คือที่ที่เหตุการณ์ถูกเล่า — แทนที่จะไปขยับกล้องหรือเร่งฉากหลัง
         */
        float wave = smoothstep(5.0, 0.0, abs(vRadius - uSurgeR)) * uSurge;

        /* สายจากแม่ที่มีลูกหลายตัวสว่างกว่า ⇒ มองผ่าน ๆ ก็รู้ว่าเส้นไหนเป็นลำต้น เส้นไหนเป็นกิ่งปลาย */
        float base = mix(0.05, 0.17, vLive) * (0.75 + vWeight * 0.55) * (1.0 + uSurge * 0.55);
        vec3 col = mix(vColor, vec3(1.0), min(1.0, pulse * 0.7 + tip * 0.9 + wave * 0.85));
        float a = (base + pulse * 0.95 + tip * 0.9 + wave * 1.15) * (0.8 + vWeight * 0.35);
        if (a < 0.004) discard;
        gl_FragColor = vec4(col, a);
      }
    `,
  });

  const links = new THREE.LineSegments(linkGeo, linkMat);
  links.frustumCulled = false;
  group.add(links);

  /* ───────────────────────── การจัดวาง ───────────────────────── */

  /*
   * ตำแหน่งเป้าหมายของโหนด = จุดบนวงโคจรรอบพ่อ
   * - session โคจรรอบสมองกลาง
   * - sub โคจรรอบ agent ที่เป็นพ่อ (หรือ session ถ้าไม่มีพ่อ)
   * รัศมีลดหลั่นตามชั้น เพื่อให้ชั้นลึกไม่ทะลุออกไปไกลจนหลุดจอ
   */
  function orbitRadius(node) {
    if (node.kind === "session") return opts.sessionOrbit;
    const d = Math.max(1, node.depth);
    /*
     * รัศมีต้องโตตามจำนวนพี่น้อง: ผิวทรงกลมโตเป็น r² ⇒ ใช้ sqrt(จำนวน) เพื่อให้ความหนาแน่น
     * ต่อพื้นที่คงที่ ไม่ว่าพ่อจะมีลูก 3 ตัวหรือ 250 ตัว
     * (ตอนทดสอบ storm จริง ลูก 253 ตัวของ session เดียวกองเป็นก้อนทึบก้อนเดียวจนแยกไม่ออก)
     */
    const crowd = Math.sqrt(Math.max(1, node.siblingCount || 1));
    const base = 2.9 + 1.6 * Math.log2(1 + d);
    return base * (0.85 + crowd * 0.30) + node.spread * 1.3;
  }

  function computeTarget(node, out) {
    const parent = node.parentKey ? nodes.get(node.parentKey) : null;
    const base = parent ? parent.pos : tmpC.set(0, 0, 0);
    const r = node.orbitR;
    /* ตัวที่จบแล้วโคจรช้าลงเหลือ ~1/4 — เป็น "ความทรงจำ" ที่ลอยนิ่งกว่าตัวที่ยังทำงาน */
    const t = time * node.speed * (node.running ? 1 : 0.25) + node.phase;

    if (node.kind === "session") {
      /*
       * session ถูกตรึงทิศไว้คนละด้านของสมอง (fibonacci) แล้วแกว่งรอบทิศนั้นเบา ๆ
       * เดิมให้ทุกตัวโคจรรอบจุดกลางด้วยความเร็วใกล้กัน ผลคือมันไหลมากองรวมกันด้านเดียว
       * แล้วอีกครึ่งจอว่างเปล่า (เห็นชัดตอนทดสอบด้วย 5 session)
       */
      const sway = 0.55;
      out.copy(node.anchor)
        .multiplyScalar(r)
        .addScaledVector(node.swayA, Math.sin(t) * r * sway * node.tilt)
        .addScaledVector(node.swayB, Math.cos(t * 0.83 + node.phase) * r * sway * node.tilt);
      out.add(base);
      return out;
    }

    /*
     * ลูกกระจายเป็นเปลือกทรงกลมรอบพ่อ (fibonacci) แล้วทั้งเปลือกหมุนช้า ๆ
     * วงแหวนระนาบเดียวใช้ไม่ได้เมื่อมีลูกหลายสิบตัว — มันจะซ้อนกันเป็นเส้นเดียว
     */
    const cnt = Math.max(1, node.siblingCount || 1);
    const k = (node.siblingIndex || 0) + 0.5;
    const phi = Math.acos(Math.max(-1, Math.min(1, 1 - (2 * k) / cnt)));
    const theta = GOLDEN * k + t * 0.42;
    const sp = Math.sin(phi);
    /* หายใจเข้า-ออกเล็กน้อยคนละเฟส ทำให้เปลือกไม่นิ่งเป็นแบบจำลองพลาสติก */
    const breathe = 1 + Math.sin(t * 1.7 + node.phase) * 0.07;

    out.set(Math.cos(theta) * sp, Math.cos(phi), Math.sin(theta) * sp)
      .multiplyScalar(r * breathe)
      .applyAxisAngle(node.axis, node.axisAngle * 0.35);
    out.add(base);
    return out;
  }

  function makeNode(kind, key, data, parentKey, depth) {
    const seed = hash01(key);
    const seed2 = hash01(`${key}#2`);
    const idx = nodes.size;
    const node = {
      key,
      kind,
      sessionId: data.sessionId,
      agentId: data.agentId || null,
      parentKey: parentKey || null,
      depth: depth || 0,
      data,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      target: new THREE.Vector3(),
      color: new THREE.Color(0xffffff),
      size: kind === "session" ? 12 : 6,
      running: true,
      outcome: "",
      spawn: 0, // 0..1
      spawnDelay: 0,
      flash: 0,
      alive: true,
      fade: 1,
      seed,
      spread: seed2,
      phase: seed * Math.PI * 2 + idx * GOLDEN,
      /* เร่งขึ้นจาก 0.055/0.16 เมื่อ 2026-09-09 — กล้องเลิกหมุนเองแล้ว การเคลื่อนไหวที่คนเห็น
         ต้องมาจากตัววัตถุเอง และวงโคจรของ agent เป็นการเคลื่อนไหวที่มีความหมายจริง */
      speed: (kind === "session" ? 0.075 : 0.23) * (0.6 + seed2 * 0.9),
      tilt: 0.25 + seed2 * 0.65,
      axis: new THREE.Vector3(Math.cos(seed * 6.28), 1.0, Math.sin(seed2 * 6.28)).normalize(),
      axisAngle: seed * Math.PI,
      anchor: new THREE.Vector3(0, 0, 1),
      swayA: new THREE.Vector3(1, 0, 0),
      swayB: new THREE.Vector3(0, 1, 0),
      orbitR: 6,
      siblingIndex: 0,
      siblingCount: 1,
      childCount: 0,
      toolFlash: 0,
      lastToolAt: -999,
    };
    node.orbitR = orbitRadius(node);

    if (kind === "session") {
      /* ทิศฐานกระจายทั่วทรงกลมด้วย golden-angle — ยิ่งมี session มาก ยิ่งกระจายทั่วถึง */
      const nSessions = Math.max(3, sessionCount + 1);
      const k = sessionSlot(key) + 0.5;
      const phi = Math.acos(1 - (2 * k) / nSessions);
      const theta = GOLDEN * k;
      node.anchor.set(Math.cos(theta) * Math.sin(phi), Math.cos(phi) * 0.72, Math.sin(theta) * Math.sin(phi)).normalize();
      /* สองแกนตั้งฉากกับ anchor ไว้ให้แกว่งเป็นวงรีเล็ก ๆ รอบทิศฐาน */
      node.swayA.set(-node.anchor.z, 0, node.anchor.x);
      if (node.swayA.lengthSq() < 1e-4) node.swayA.set(1, 0, 0);
      node.swayA.normalize();
      node.swayB.crossVectors(node.anchor, node.swayA).normalize();
    }

    /* เกิดที่ตำแหน่งของพ่อแล้วค่อยพุ่งออกไปวงโคจร — ทำให้สายที่งอกกับดวงไฟเป็นเรื่องเดียวกัน */
    const parent = parentKey ? nodes.get(parentKey) : null;
    if (parent) node.pos.copy(parent.pos);
    else node.pos.set((seed - 0.5) * 4, (seed2 - 0.5) * 4, (seed - 0.5) * 4);
    computeTarget(node, node.target);
    return node;
  }

  /* ───────────────────────── การซิงก์กับ snapshot ───────────────────────── */

  /*
   * syncSnapshot รับ snapshot ทั้งก้อนแล้วทำให้ดงโหนด "ตรงกับความจริง" — เพิ่มตัวที่ยังไม่มี,
   * อัปเดตสี/สถานะของตัวที่มีอยู่, และปล่อยตัวที่หายไปให้จางหาย
   * (การเกิดแบบมีแอนิเมชันเป็นหน้าที่ของ spawn() ที่ store เรียกจาก diff — ที่นี่แค่กันตกหล่น)
   */
  function syncSnapshot(snapshot, { silent = false } = {}) {
    if (!snapshot || !Array.isArray(snapshot.agents)) return;
    const seen = new Set();

    for (const session of snapshot.agents) {
      if (!session || !session.sessionId) continue;
      const sKey = session.sessionId;
      seen.add(sKey);
      let sNode = nodes.get(sKey);
      if (!sNode) {
        sNode = makeNode("session", sKey, { sessionId: sKey, agentId: null }, null, 0);
        sNode.spawn = silent ? 1 : 0;
        nodes.set(sKey, sNode);
        rebuildOrder();
      }
      sNode.data = session;
      sNode.running = !!session.alive;
      if (!sNode.size) sNode.size = 20;
      const st = session.status && session.status.state ? session.status.state : "unknown";
      sNode.color.copy(session.alive ? stateColor(st) : outcomeColor("done"));
      sNode.fade = session.alive ? 1 : 0.45;

      const subs = Array.isArray(session.subagents) ? session.subagents : [];
      for (const sub of subs) {
        if (!sub || !sub.agentId) continue;
        const key = `${sKey}:${sub.agentId}`;
        seen.add(key);
        const parentKey = sub.parentAgentId ? `${sKey}:${sub.parentAgentId}` : sKey;
        let node = nodes.get(key);
        if (!node) {
          if (nodes.size >= MAX_NODES) {
            truncated += 1;
            continue; // กันบัฟเฟอร์ล้นเวลามี agent เป็นพัน
          }
          node = makeNode("sub", key, { sessionId: sKey, agentId: sub.agentId }, parentKey, sub.depth || 1);
          node.spawn = silent ? 1 : 0;
          nodes.set(key, node);
          rebuildOrder();
        }
        /* พ่ออาจมาถึงทีหลังลูก (server อ่าน sidecar ไม่พร้อมกัน) — ผูกใหม่เมื่อพ่อโผล่ */
        if (node.parentKey !== parentKey && nodes.has(parentKey)) {
          node.parentKey = parentKey;
          node.orbitR = orbitRadius(node);
        }
        node.data = sub;
        node.depth = sub.depth || node.depth;
        const wasRunning = node.running;
        node.running = !!sub.running;
        if (wasRunning && !node.running) node.flash = Math.max(node.flash, 1.0);
        node.outcome = sub.outcome || "";
        /* ขนาดคิดที่ nodeSize() ที่เดียว (ต้องรู้จำนวนลูกก่อน) — ที่นี่แค่ให้ค่าตั้งต้นตอนโหนดเพิ่งเกิด */
        if (!node.size) node.size = 8;
        node.color.copy(node.running ? modelColor(sub.modelTag || sub.model) : outcomeColor(sub.outcome));
        node.fade = node.running ? 1 : 0.5;
        /* tool ใหม่ของลูก = แสงวาบเล็ก ๆ ที่ตัวมัน (ไม่ต้องรอ event จาก store) */
        if (sub.current && sub.current.startedTs) {
          const ts = Date.parse(sub.current.startedTs);
          if (ts && ts !== node.lastToolAt) {
            node.lastToolAt = ts;
            node.flash = Math.max(node.flash, 0.55);
          }
        }
      }
    }

    /* ตัวที่หายไปจาก snapshot = จบและถูกเก็บกวาดแล้ว → ให้จางแล้วค่อยลบ */
    for (const [key, node] of nodes) {
      if (!seen.has(key)) node.alive = false;
    }
  }

  function rebuildOrder() {
    /* เรียงตาม depth เพื่อให้พ่ออัปเดตตำแหน่งก่อนลูกเสมอใน update loop เดียว */
    order = Array.from(nodes.values()).sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));

    /* ให้เลขประจำตัวในหมู่พี่น้อง (เรียงตาม key จึงคงที่) เพื่อกระจายตำแหน่งแบบไม่ทับกัน */
    const buckets = new Map();
    for (const node of order) {
      if (node.kind !== "sub") continue;
      const pk = node.parentKey || "";
      let arr = buckets.get(pk);
      if (!arr) {
        arr = [];
        buckets.set(pk, arr);
      }
      node.siblingIndex = arr.length;
      arr.push(node);
    }
    for (const arr of buckets.values()) {
      for (const node of arr) node.siblingCount = arr.length;
    }

    /*
     * นับลูกของทุกโหนด (รวม session) — ใช้ตัดสินสองอย่างที่ผู้ใช้ขอ (2026-09-09):
     *   1. แม่ต้องดูต่างจากใบ  → aKin ในเชดเดอร์
     *   2. สายจากแม่ที่มีลูกเยอะต้องเด่นกว่า → aWeight
     */
    for (const node of nodes.values()) node.childCount = 0;
    for (const node of nodes.values()) {
      if (!node.parentKey) continue;
      const parent = nodes.get(node.parentKey);
      if (parent) parent.childCount += 1;
    }

    for (const node of order) {
      node.orbitR = orbitRadius(node);
      node.size = nodeSize(node);
    }
  }

  /*
   * ขนาดของดวงไฟ = "ชั้นในสายพันธุ์" เป็นหลัก แล้วค่อยบวกน้ำหนักงาน
   * เหตุผล: เดิมขนาดมาจากจำนวน tool อย่างเดียว ⇒ หลานที่ทำงานหนักตัวใหญ่กว่าแม่ของมันเอง
   * ทำให้อ่านลำดับชั้นไม่ออกเลย (คำสั่งผู้ใช้ 2026-09-09 "อยากให้เห็นว่าอันไหนเป็นแม่เป็นลูก")
   */
  const DEPTH_SIZE = [22, 13.5, 10.5, 8.6, 7.2, 6.2];

  function nodeSize(node) {
    if (node.kind === "session") return node.running ? DEPTH_SIZE[0] : DEPTH_SIZE[0] * 0.62;
    const base = DEPTH_SIZE[Math.min(DEPTH_SIZE.length - 1, Math.max(1, node.depth))];
    const tools = (node.data && node.data.tools) || 0;
    const work = Math.min(3.6, Math.log2(1 + tools) * 0.85);
    /* แม่ตัวหนา: มีลูกแล้วต้องใหญ่กว่าใบในชั้นเดียวกันเสมอ */
    const parenthood = node.childCount > 0 ? 2.2 + Math.min(2.6, Math.log2(1 + node.childCount)) : 0;
    return (base + work + parenthood) * (node.running ? 1 : 0.72);
  }

  /* ───────────────────────── เหตุการณ์ที่ขับแอนิเมชัน ───────────────────────── */

  /** สายกำลังจะงอกไปหาลูกใหม่ — batchIndex ทำให้ชุดเดียวกันไล่กันเป็นทอด ๆ */
  function spawn({ sessionId, sub, batchIndex = 0 }) {
    if (!sub || !sub.agentId) return null;
    const key = `${sessionId}:${sub.agentId}`;
    const parentKey = sub.parentAgentId ? `${sessionId}:${sub.parentAgentId}` : sessionId;
    let node = nodes.get(key);
    if (!node) {
      if (nodes.size >= MAX_NODES) {
        truncated += 1;
        return null;
      }
      node = makeNode("sub", key, { sessionId, agentId: sub.agentId }, parentKey, sub.depth || 1);
      nodes.set(key, node);
      rebuildOrder();
    }
    node.data = sub;
    node.spawn = 0;
    node.spawnDelay = Math.min(1.4, batchIndex * 0.055); // 40 ตัว → ไล่กันจบใน ~1.4 วิ
    node.flash = 1.2;
    node.running = true;
    node.color.copy(modelColor(sub.modelTag || sub.model));
    return node;
  }

  function finish({ sessionId, sub }) {
    const key = `${sessionId}:${sub && sub.agentId}`;
    const node = nodes.get(key);
    if (!node) return null;
    node.running = false;
    node.outcome = (sub && sub.outcome) || "";
    node.color.copy(outcomeColor(node.outcome));
    node.flash = 1.4;
    return node;
  }

  function toolStart({ sessionId, agentId }) {
    const key = agentId ? `${sessionId}:${agentId}` : sessionId;
    const node = nodes.get(key);
    if (node) node.flash = Math.max(node.flash, 0.7);
    return node;
  }

  function toolEnd({ sessionId, agentId, error }) {
    const key = agentId ? `${sessionId}:${agentId}` : sessionId;
    const node = nodes.get(key);
    if (node) node.flash = Math.max(node.flash, error ? 1.0 : 0.35);
    return node;
  }

  /*
   * เหตุการณ์หนึ่งครั้ง = คลื่นหนึ่งลูกที่วิ่งออกจากสมองไปตามสายทุกเส้น
   * เป็นช่องทางเดียวที่ "เหตุการณ์" จะขยับภาพได้ นอกจากตัวสมองเอง — กล้องและฉากหลังไม่ตอบสนอง
   * เหตุการณ์อีกต่อไป (คำสั่งผู้ใช้ 2026-09-10)
   */
  function surge(amount = 0.6) {
    /* คลื่นใหม่เริ่มจากใจกลางเสมอ: เหตุการณ์ที่มาถี่ ๆ จึงเห็นเป็นคลื่นซ้อนกันไล่ออกไป
       ไม่ใช่แค่ค่าความสว่างที่ค้างสูงจนอ่านไม่ออกว่ามีอะไรเกิดขึ้นกี่ครั้ง */
    surgeAmp = Math.min(1.4, surgeAmp + amount);
    surgeRadius = 0;
  }

  /* ───────────────────────── ลูปอัปเดต ───────────────────────── */

  function update(dt, ctx = {}) {
    time += dt;
    nodeUniforms.uTime.value = time;
    linkUniforms.uTime.value = time;
    nodeUniforms.uActivity.value = ctx.activity || 0;
    linkUniforms.uActivity.value = ctx.activity || 0;

    /*
     * คลื่นจางตาม **ระยะทางที่วิ่งไปได้** ไม่ใช่ตามเวลา — ทุกเหตุการณ์จึงกวาดครบทั้งดงเสมอ
     * (ราว 1.6 วินาทีต่อคลื่น) และ "ความแรงของเหตุการณ์" ไปโผล่ที่ความสว่างอย่างเดียว
     * ถ้าให้จางตามเวลา เหตุการณ์เบา ๆ อย่าง tool-start จะสว่างแค่สายชั้นในแล้วดับ
     * มองแล้วเหมือนภาพกระพริบ ไม่ใช่คลื่นที่วิ่งไปไหน
     */
    if (surgeAmp > 0) {
      surgeRadius += dt * SURGE_SPEED;
      if (surgeRadius >= SURGE_REACH) {
        surgeAmp = 0;
        surgeRadius = 0;
      }
    }
    linkUniforms.uSurge.value =
      surgeAmp > 0 ? Math.min(1, surgeAmp) * (1 - surgeRadius / SURGE_REACH) : 0;
    linkUniforms.uSurgeR.value = surgeRadius;

    let removed = false;
    let n = 0;
    let lv = 0; // ตัวนับ vertex ของสาย
    const seg = LINK_SEG;

    for (const node of order) {
      if (!nodes.has(node.key)) continue;

      /* คืบหน้าแอนิเมชันเกิด (หลังหมดดีเลย์ของ batch) */
      if (node.spawnDelay > 0) {
        node.spawnDelay -= dt;
      } else if (node.spawn < 1) {
        node.spawn = Math.min(1, node.spawn + dt * 1.7);
      }
      node.flash = Math.max(0, node.flash - dt * 2.2);

      /* โหนดที่หายจาก snapshot: จางลงแล้วลบทิ้ง — ไม่ลบทันทีเพราะจะกระพริบหาย */
      if (!node.alive) {
        node.fade -= dt * 0.9;
        if (node.fade <= 0) {
          nodes.delete(node.key);
          removed = true;
          continue;
        }
      }

      /* วิ่งตามวงโคจร: คำนวณเป้าหมายใหม่ทุกเฟรม แล้วไล่ตามแบบสปริง
       * (ไล่ตามแทนที่จะกระโดดไปเลย ทำให้ตอนพ่อขยับ ลูกลากตามเป็นพวงอย่างนุ่มนวล) */
      computeTarget(node, node.target);

      /*
       * "ยังไม่จบ = ห้ามนิ่ง" (คำสั่งผู้ใช้ 2026-09-09)
       * ตัวที่ยังวิ่งจะสั่นรอบวงโคจรของตัวเองสามแกนคนละเฟส แรงขึ้นตามจำนวน tool ที่ค้างอยู่
       * ส่วนตัวที่จบแล้วไม่สั่นเลย ⇒ แยก "ทำงานอยู่" กับ "จบแล้ว" ได้จาก **การเคลื่อนไหว**
       * ไม่ใช่แค่สี ซึ่งอ่านง่ายกว่ามากเวลามีโหนดเป็นร้อย
       */
      if (node.running) {
        const inFlightNow = (node.data && node.data.inFlight) || 0;
        const amp = (node.kind === "session" ? 0.22 : 0.42) * (1 + Math.min(2, inFlightNow) * 0.55);
        const rate = 1.7 + node.seed * 2.3;
        const ph = node.seed * 6.283;
        node.target.x += Math.sin(time * rate + ph) * amp;
        node.target.y += Math.sin(time * (rate * 0.73) + ph * 1.7) * amp;
        node.target.z += Math.cos(time * (rate * 0.61) + ph * 2.3) * amp;
      }
      const k = node.spawn < 1 ? 3.2 : 1.9; // ตอนเพิ่งเกิดพุ่งออกไปเร็วกว่า
      tmpA.copy(node.target).sub(node.pos).multiplyScalar(Math.min(1, dt * k));
      node.pos.add(tmpA);

      if (n < MAX_NODES) {
        const i3 = n * 3;
        nPos[i3] = node.pos.x;
        nPos[i3 + 1] = node.pos.y;
        nPos[i3 + 2] = node.pos.z;
        const f = node.fade;
        nColor[i3] = node.color.r * f;
        nColor[i3 + 1] = node.color.g * f;
        nColor[i3 + 2] = node.color.b * f;
        /* คิดขนาดใหม่ทุกเฟรม — ขนาดขึ้นกับ running/tools/จำนวนลูก ซึ่งเปลี่ยนได้ตลอดโดยที่
           ผังโหนดไม่เปลี่ยน (rebuildOrder ไม่ถูกเรียก) ⇒ ถ้าคิดแค่ตอน rebuild ขนาดจะค้าง */
        node.size = nodeSize(node);
        nSize[n] = node.size;
        nState[n] = node.running ? 1 : 0;
        nSpawn[n] = node.spawn;
        nFlash[n] = node.flash;
        nSeed[n] = node.seed;
        nSelect[n] = node.key === selectedKey ? 1.0 : node.key === hoverKey ? 0.6 : 0.0;
        nKin[n] = node.kind === "session" ? 2 : node.childCount > 0 ? 1 : 0;
        node.bufferIndex = n;
        n += 1;
      }

      /* วาดสายจากพ่อ (session ต่อกับสมองกลางที่จุด 0,0,0) */
      const parent = node.parentKey ? nodes.get(node.parentKey) : null;
      const from = parent ? parent.pos : tmpC.set(0, 0, 0);
      if (lv + seg * 2 <= lVerts && node.fade > 0.02) {
        /* สายลากตรงจากพ่อไปลูก (คำสั่งผู้ใช้ 2026-09-10) — เดิมดันจุดควบคุม bezier ออกด้านข้าง
           ให้โค้งแบบเส้นประสาท ซึ่งทำให้อ่าน "ใครออกมาจากใคร" ยากเวลามีสายเป็นร้อยเส้นซ้อนกัน */
        const live = node.running ? 1 : 0;
        /* พัลส์ถี่ขึ้นตามจำนวน tool ที่ค้างอยู่จริงของ agent ตัวนั้น */
        const inFlight = node.data && node.data.inFlight ? node.data.inFlight : 0;
        const flow = 0.16 + Math.min(0.55, inFlight * 0.13) + (ctx.activity || 0) * 0.12;
        const parentColor = parent ? parent.color : null;
        /* น้ำหนักของสาย = ลำต้น (แม่มีลูกเยอะ) เด่นกว่ากิ่งปลาย */
        const weight = Math.min(1, Math.log2(1 + (parent ? parent.childCount : 1)) / 4.5);

        for (let i = 0; i < seg; i += 1) {
          const t0 = i / seg;
          const t1 = (i + 1) / seg;
          writeStraight(from, node.pos, t0, lv);
          fillLinkVertex(lv, node, t0, flow, live, parentColor, weight);
          lv += 1;
          writeStraight(from, node.pos, t1, lv);
          fillLinkVertex(lv, node, t1, flow, live, parentColor, weight);
          lv += 1;
        }
      }
    }

    if (removed) rebuildOrder();

    nodeGeo.setDrawRange(0, n);
    nodeGeo.attributes.position.needsUpdate = true;
    nodeGeo.attributes.aColor.needsUpdate = true;
    nodeGeo.attributes.aSize.needsUpdate = true;
    nodeGeo.attributes.aState.needsUpdate = true;
    nodeGeo.attributes.aSpawn.needsUpdate = true;
    nodeGeo.attributes.aFlash.needsUpdate = true;
    nodeGeo.attributes.aSeed.needsUpdate = true;
    nodeGeo.attributes.aSelect.needsUpdate = true;
    nodeGeo.attributes.aKin.needsUpdate = true;

    linkGeo.setDrawRange(0, lv);
    linkGeo.attributes.position.needsUpdate = true;
    linkGeo.attributes.aColor.needsUpdate = true;
    linkGeo.attributes.aProgress.needsUpdate = true;
    linkGeo.attributes.aSpawn.needsUpdate = true;
    linkGeo.attributes.aFlow.needsUpdate = true;
    linkGeo.attributes.aSeed.needsUpdate = true;
    linkGeo.attributes.aLive.needsUpdate = true;
    linkGeo.attributes.aWeight.needsUpdate = true;

    return { nodeCount: n, linkVerts: lv };
  }

  /* จุดบนสายที่พารามิเตอร์ t — เส้นตรงล้วน ไม่มีจุดควบคุมแล้ว (ดูหมายเหตุที่ LINK_SEG) */
  function writeStraight(a, b, t, vi) {
    const it = 1 - t;
    const i3 = vi * 3;
    lPos[i3] = it * a.x + t * b.x;
    lPos[i3 + 1] = it * a.y + t * b.y;
    lPos[i3 + 2] = it * a.z + t * b.z;
  }

  /*
   * สายหนึ่งเส้นไล่สีจาก **สีของแม่** ที่ต้นสาย ไปเป็น **สีของลูก** ที่ปลายสาย
   * นี่คือสิ่งที่ทำให้อ่านออกว่าใครออกมาจากใคร โดยไม่ต้องไล่สายตาไปตามเส้น
   * (เดิมทั้งเส้นเป็นสีลูกสีเดียว ⇒ บอกได้แค่ "มีเส้น" ไม่ได้บอกทิศ)
   */
  function fillLinkVertex(vi, node, t, flow, live, parentColor, weight) {
    const i3 = vi * 3;
    const f = node.fade;
    const pr = parentColor ? parentColor.r : node.color.r;
    const pg = parentColor ? parentColor.g : node.color.g;
    const pb = parentColor ? parentColor.b : node.color.b;
    lColor[i3] = (pr + (node.color.r - pr) * t) * f;
    lColor[i3 + 1] = (pg + (node.color.g - pg) * t) * f;
    lColor[i3 + 2] = (pb + (node.color.b - pb) * t) * f;
    lProg[vi] = t;
    lSpawn[vi] = node.spawn;
    lFlow[vi] = flow;
    lSeed[vi] = node.seed;
    lLive[vi] = live;
    lWeight[vi] = weight;
  }

  /* ───────────────────────── การชี้/เลือก ───────────────────────── */

  /*
   * เลือกโหนดด้วยระยะบนจอ (project แล้ววัดพิกเซล) แทน Raycaster ของ Points
   * เพราะขนาดจุดถูกคำนวณใน shader — Raycaster ไม่รู้ขนาดจริง จึงคลิกพลาดตลอดเวลาที่จุดเล็ก
   */
  function pick(ndc, camera, viewport, maxPx = 26) {
    let best = null;
    let bestD = Infinity;
    for (const node of nodes.values()) {
      if (node.fade <= 0.05 || node.spawn < 0.15) continue;
      projected.copy(node.pos).project(camera);
      if (projected.z > 1) continue;
      const dx = ((projected.x - ndc.x) * viewport.width) / 2;
      const dy = ((projected.y - ndc.y) * viewport.height) / 2;
      const d = Math.hypot(dx, dy);
      /* จุดใหญ่กดโดนง่ายกว่าจุดเล็กตามที่ตาเห็น */
      const radius = Math.max(10, Math.min(maxPx, node.size * 1.8));
      if (d < radius && d < bestD) {
        bestD = d;
        best = node;
      }
    }
    return best;
  }

  function setSelected(key) {
    selectedKey = key || null;
  }
  function setHover(key) {
    hoverKey = key || null;
  }

  function getPosition(key, out = new THREE.Vector3()) {
    const node = nodes.get(key);
    if (!node) return null;
    return out.copy(node.pos);
  }

  function setQuality(level) {
    if (!QUALITY[level]) return;
    quality = level;
    Q = QUALITY[level];
  }

  function setPixelRatio(r) {
    nodeUniforms.uPixelRatio.value = r;
  }

  function dispose() {
    nodeGeo.dispose();
    nodeMat.dispose();
    linkGeo.dispose();
    linkMat.dispose();
    nodes.clear();
    order = [];
    group.clear();
  }

  return {
    group,
    syncSnapshot,
    spawn,
    finish,
    toolStart,
    toolEnd,
    surge,
    update,
    pick,
    setSelected,
    setHover,
    setQuality,
    setPixelRatio,
    getPosition,
    dispose,
    get nodes() {
      return nodes;
    },
    get count() {
      return nodes.size;
    },
    get selected() {
      return selectedKey;
    },
    get truncated() {
      return truncated;
    },
    get maxNodes() {
      return MAX_NODES;
    },
  };
}
