// public/brain/fx/bloom.js
//
// Bloom/glow post-processing เขียนเอง (ไม่พึ่ง three/examples/jsm) สำหรับฉาก "สมอง AI" นีออน
// บนพื้นดำ — render-to-texture หลายชั้นด้วย WebGLRenderTarget + fullscreen quad
//
// สถาปัตยกรรม (ต่อเฟรม):
//   1) scene pass      : เรนเดอร์ฉากจริงลง sceneRT แบบ HDR เชิงเส้นล้วน (ไม่ tonemap/ไม่ sRGB ตรงนี้)
//   2) bright pass     : downsample สองเท่า + soft-knee threshold -> mip 0 (ครึ่งความละเอียดของฉาก)
//   3) blur chain      : ต่อ mip (1/2, 1/4, 1/8, 1/16, ...) — เบลอ gaussian 9-tap แยกแกน H แล้ว V
//                        แล้วค่อย downsample ต่อไปชั้นถัดไป (เหมือน mip chain ของ bloom ทั่วไป)
//   4) upsample+combine: ไล่จากชั้นเล็กสุด (ฟุ้งกว้างสุด) กลับขึ้นมาบวกกับชั้นที่ใหญ่กว่าไปเรื่อย ๆ
//                        (tent upsample 4-tap) จนได้ bloom texture สุดท้ายที่ความละเอียด mip 0
//   5) composite pass  : scene + bloom*strength -> จอ พร้อม ACES tonemap โดยประมาณ, vignette,
//                        chromatic aberration, film grain (ตาม uTime), scanline (ปิดโดย default),
//                        และแปลงสี linear -> sRGB เองที่ pass นี้ pass เดียว
//
// ทำไม RT กลางต้องเป็น linear (NoColorSpace) และทำไม pass สุดท้ายต้องแปลง sRGB เอง:
//   three r180 จะแทรก chunk <colorspace_fragment> / <tonemapping_fragment> ให้เฉพาะ "material
//   สำเร็จรูป" ของ three เอง (MeshStandardMaterial ฯลฯ) เท่านั้น — chunk พวกนี้อ่านค่า
//   renderer.outputColorSpace / renderer.toneMapping "แบบ global" โดยไม่สนใจว่ากำลังเรนเดอร์ลง
//   canvas หรือลง WebGLRenderTarget ก็ตาม ดังนั้นถ้าปล่อย renderer ไว้ที่ค่าเดิม (เช่น
//   SRGBColorSpace + ACESFilmicToneMapping) ตอนเรนเดอร์ฉากจริงลง sceneRT วัตถุในฉากจะโดน
//   tonemap/sRGB ทับไปแล้วตั้งแต่ pass แรก — HDR bloom (ที่ต้องอ่านค่าความสว่าง "ก่อน" ตัด
//   threshold) จะพังทันที เราจึงต้องสลับ renderer ไปเป็น NoToneMapping + LinearSRGBColorSpace
//   ชั่วคราวเฉพาะตอนเรนเดอร์ฉากจริง (แล้วคืนค่าเดิมท้ายฟังก์ชัน) ส่วน ShaderMaterial ที่เราเขียนเอง
//   ในไฟล์นี้ทั้งหมดไม่ include chunk สองตัวนั้นเลย (เขียน gl_FragColor เองล้วน ๆ) จึงไม่ถูก
//   renderer.outputColorSpace/toneMapping มาแทรกซ้อนอัตโนมัติ — เราต้องแปลง linear -> sRGB
//   และ tonemap เองด้วยมือใน pass composite (ฟังก์ชัน linearToSRGB / acesFilm ด้านล่าง) มิฉะนั้น
//   ภาพจะซีดหรือมืดผิดตามที่โจทย์เตือนไว้
//
// ห้าม import จาก three/examples/jsm — ทุก pass ในไฟล์นี้เขียน GLSL เองทั้งหมด

import * as THREE from "three";

// ------------------------------------------------------------------------------------------------
// ค่า default ของ options (ตรงตาม API ที่ไฟล์อื่นเรียกใช้)
// ------------------------------------------------------------------------------------------------
const DEFAULT_OPTIONS = {
  strength: 1.15,
  threshold: 0.62,
  knee: 0.35,
  radius: 1.0,
  levels: 4,
  resolutionScale: 1.0,
  chromatic: 0.0016,
  vignette: 0.42,
  grain: 0.035,
  scanline: 0.0,
  toneMapping: true,
};

// จำกัดจำนวนชั้น blur ไว้ในช่วงที่สมเหตุสมผล (โจทย์ระบุ 3–5 ชั้น) กันคนตั้งค่าพลาดจนพัง RT chain
const MIN_LEVELS = 1;
const MAX_LEVELS = 8;

// ------------------------------------------------------------------------------------------------
// Vertex shader ร่วมของทุก pass — fullscreen quad แบบ "ไม่พึ่งกล้อง"
//
// PlaneGeometry(2,2) มีตำแหน่งจุดยอดอยู่ที่ (±1, ±1, 0) พอดีกับ NDC clip-space อยู่แล้ว จึงเขียน
// gl_Position ตรง ๆ จาก position.xy ได้เลยโดยไม่ต้องผ่าน projectionMatrix/modelViewMatrix ของกล้อง
// (กล้อง orthographic ที่ส่งเข้า renderer.render ยังต้องมีไว้เพราะ API ของ three ต้องการอาร์กิวเมนต์
// กล้อง แต่ shader นี้ไม่ได้อ่านค่าจากมันเลย — กันปัญหาระยะ near/far หรือ lookAt ผิดพลาดไปในตัว)
// ------------------------------------------------------------------------------------------------
const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ------------------------------------------------------------------------------------------------
// Pass: downsample (+ threshold ตัวเลือก) — ใช้ทั้งเป็น "bright pass" (uApplyThreshold=1) ตอนตัด
// เฉพาะพิกเซลสว่าง และใช้ซ้ำเป็น "downsample เฉย ๆ" (uApplyThreshold=0) ระหว่าง mip แต่ละชั้น
// เพื่อลด shader program ที่ต้อง compile (โปรแกรมเดียวใช้ซ้ำได้ทุกชั้น)
//
// เทคนิค downsample: 4-tap box filter แบบยิง ray กึ่งกลางพิกเซลปลายทางแต่ละมุม (offset ±0.5 texel
// ของภาพต้นทาง) อาศัย bilinear filtering ของฮาร์ดแวร์ให้แต่ละ tap เฉลี่ยพื้นที่ 2x2 texel ต้นทางให้
// เอง รวม 4 tap แล้วได้ผลเทียบเท่า box filter ที่กว้างกว่าและเนียนกว่าการสุ่มจุดเดียวตรงกลาง
// ------------------------------------------------------------------------------------------------
const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tInput;
uniform vec2 uTexelSize;       // 1 / ความละเอียดของ tInput (ต้นทาง)
uniform float uApplyThreshold; // 1.0 = ตัด soft-knee threshold ด้วย (bright pass), 0.0 = downsample เฉย ๆ
uniform float uThreshold;
uniform float uKnee;

vec3 downsampleBox4(vec2 uv) {
  vec3 s0 = texture2D(tInput, uv + uTexelSize * vec2(-0.5, -0.5)).rgb;
  vec3 s1 = texture2D(tInput, uv + uTexelSize * vec2( 0.5, -0.5)).rgb;
  vec3 s2 = texture2D(tInput, uv + uTexelSize * vec2(-0.5,  0.5)).rgb;
  vec3 s3 = texture2D(tInput, uv + uTexelSize * vec2( 0.5,  0.5)).rgb;
  return (s0 + s1 + s2 + s3) * 0.25;
}

void main() {
  vec3 color = max(downsampleBox4(vUv), 0.0);

  if (uApplyThreshold > 0.5) {
    // soft-knee threshold สไตล์ Unreal — กันขอบสว่างตัดแข็งเป็นรอยหยัก (hard clip) เวลาค่าความสว่าง
    // อยู่ใกล้ threshold พอดี โดยผสม curve กำลังสองช่วงใกล้ knee เข้ากับ hard threshold ช่วงไกล knee
    float brightness = max(max(color.r, color.g), color.b);
    float knee = uThreshold * uKnee + 1e-5;
    float soft = brightness - uThreshold + knee;
    soft = clamp(soft, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    float contribution = max(soft, brightness - uThreshold);
    contribution /= max(brightness, 1e-4);
    color *= contribution;
  }

  gl_FragColor = vec4(max(color, 0.0), 1.0);
}
`;

// ------------------------------------------------------------------------------------------------
// Pass: blur — gaussian 9-tap แยกแกน (separable) ใช้ shader/material เดียวกันทั้งแนวนอนและแนวตั้ง
// (สลับด้วย uDirection) และใช้ซ้ำได้ทุก mip level (สลับ uTexelSize ตามขนาดจริงของ RT ชั้นนั้น)
//
// น้ำหนัก 9 tap (1 กลาง + 4 คู่ซ้าย-ขวา/บน-ล่าง) เป็นชุดสัมประสิทธิ์ gaussian มาตรฐานที่ใช้กันทั่วไป
// ในการเบลอแบบ realtime ผลรวมน้ำหนัก = 1.0 พอดี (energy-preserving)
// ------------------------------------------------------------------------------------------------
const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tInput;
uniform vec2 uTexelSize; // 1 / ความละเอียดของ mip ชั้นนี้
uniform vec2 uDirection; // (1,0) = แนวนอน, (0,1) = แนวตั้ง
uniform float uRadius;   // ถ่างระยะห่างระหว่าง tap ให้กว้าง/แคบลง (ควบคุมความฟุ้งโดยรวม)

void main() {
  vec2 step = uTexelSize * uDirection * uRadius;

  vec3 sum = texture2D(tInput, vUv).rgb * 0.227027;
  sum += texture2D(tInput, vUv + step * 1.0).rgb * 0.1945946;
  sum += texture2D(tInput, vUv - step * 1.0).rgb * 0.1945946;
  sum += texture2D(tInput, vUv + step * 2.0).rgb * 0.1216216;
  sum += texture2D(tInput, vUv - step * 2.0).rgb * 0.1216216;
  sum += texture2D(tInput, vUv + step * 3.0).rgb * 0.054054;
  sum += texture2D(tInput, vUv - step * 3.0).rgb * 0.054054;
  sum += texture2D(tInput, vUv + step * 4.0).rgb * 0.016216;
  sum += texture2D(tInput, vUv - step * 4.0).rgb * 0.016216;

  gl_FragColor = vec4(max(sum, 0.0), 1.0);
}
`;

// ------------------------------------------------------------------------------------------------
// Pass: upsample + combine — ไล่จากชั้นเล็กสุด (ฟุ้งกว้างสุด) กลับขึ้นมาบวกกับชั้นที่ใหญ่กว่าทีละชั้น
// จนได้ bloom texture สุดท้ายที่ความละเอียด mip 0 ยิ่งชั้นเล็ก (ความละเอียดต่ำ) เท่าไหร่ ระยะฟุ้งของ
// มันเมื่อเทียบเป็นสัดส่วนกับจอก็ยิ่งกว้างเท่านั้น (ทั้งที่ blur kernel ขนาดเท่าเดิมทุกชั้น) — การบวก
// ไล่ชั้นแบบนี้จึงได้ glow ที่มีทั้งขอบคมและฟุ้งกว้างซ้อนกันโดยธรรมชาติ ไม่ต้องเพิ่ม kernel ใหญ่ขึ้น
//
// upsample ใช้ 4-tap tent (แนวทแยงมุม) แทนการสุ่ม bilinear จุดเดียว เพื่อลด block artifact ตอนขยาย
// ภาพความละเอียดต่ำขึ้นไปชั้นที่ใหญ่กว่า
// ------------------------------------------------------------------------------------------------
const COMBINE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tSmall;        // ผลรวมจากชั้นที่เล็ก/ฟุ้งกว้างกว่า (จะถูก upsample มาบวก)
uniform sampler2D tCurrent;      // ภาพเบลอของชั้นปัจจุบัน (ความละเอียดสูงกว่า tSmall)
uniform vec2 uTexelSizeSmall;    // 1 / ความละเอียดของ tSmall
uniform float uWeight;           // น้ำหนักของชั้นที่ upsample เข้ามา

vec3 tentUpsample(vec2 uv) {
  vec3 s0 = texture2D(tSmall, uv + uTexelSizeSmall * vec2(-1.0, -1.0)).rgb;
  vec3 s1 = texture2D(tSmall, uv + uTexelSizeSmall * vec2( 1.0, -1.0)).rgb;
  vec3 s2 = texture2D(tSmall, uv + uTexelSizeSmall * vec2(-1.0,  1.0)).rgb;
  vec3 s3 = texture2D(tSmall, uv + uTexelSizeSmall * vec2( 1.0,  1.0)).rgb;
  return (s0 + s1 + s2 + s3) * 0.25;
}

void main() {
  vec3 up = tentUpsample(vUv);
  vec3 cur = texture2D(tCurrent, vUv).rgb;
  gl_FragColor = vec4(max(cur + up * uWeight, 0.0), 1.0);
}
`;

// ------------------------------------------------------------------------------------------------
// Pass: composite — scene + bloom*strength -> จอ พร้อม tonemap / vignette / chromatic aberration /
// film grain / scanline แล้วแปลง linear -> sRGB เป็นขั้นตอนสุดท้าย (ดูคำอธิบายยาวหัวไฟล์)
// ------------------------------------------------------------------------------------------------
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uStrength;
uniform float uTime;
uniform vec2 uResolution;
uniform float uChromatic;
uniform float uVignette;
uniform float uGrain;
uniform float uScanline;
uniform float uToneMapping;

// รวม scene + bloom ที่ uv หนึ่ง ๆ — เรียกซ้ำ 3 ครั้งต่อพิกเซล (คนละ uv เล็กน้อย) เพื่อทำ chromatic
// aberration แบบแยกช่องสี R/G/B โดยไม่ต้องมี texture หรือ pass เพิ่ม
vec3 sampleCombined(vec2 uv) {
  vec3 sceneColor = texture2D(tScene, uv).rgb;
  // tBloom มีความละเอียดแค่ mip 0 (ครึ่งจอ) — การ sample ตรงนี้ที่ uv ระดับความละเอียดเต็มจอจะโดน
  // bilinear filter ของฮาร์ดแวร์ช่วย upsample ให้อัตโนมัติ ไม่ต้องเขียน upsample pass เพิ่มอีกชั้น
  vec3 bloomColor = texture2D(tBloom, uv).rgb;
  return sceneColor + bloomColor * uStrength;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec3 acesFilm(vec3 x) {
  // ACES filmic tonemap โดยประมาณ (Narkowicz 2015) — สูตรมาตรฐานที่ใช้กันแพร่หลายใน realtime
  // shader เพราะเร็วกว่าตาราง ACES จริงมาก แลกความแม่นยำสีเล็กน้อยที่ยอมรับได้
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  // RT ภายในทั้งหมดเก็บสีแบบ linear ล้วน (ดูคำอธิบายหัวไฟล์) — pass นี้เป็น pass เดียวที่เขียนสี
  // ลง canvas จริง จึงต้องแปลง linear -> sRGB เอง (สูตร sRGB OETF เต็มรูปแบบ ไม่ใช่ pow(1/2.2) เฉย ๆ)
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(0.0031308, c));
}

void main() {
  vec2 dir = vUv - 0.5;
  float dist = length(dir);

  // chromatic aberration เบามาก ที่ขอบจอ: offset ต่อช่องสีแปรผันตรงกับระยะจากจุดกึ่งกลาง (dir มี
  // ขนาด = dist อยู่แล้ว จึงไม่ต้อง normalize ซ้ำ และไม่มีปัญหาหารด้วยศูนย์ตรงกลางจอ)
  vec2 caOffset = dir * uChromatic;
  vec3 colR = sampleCombined(vUv - caOffset);
  vec3 colG = sampleCombined(vUv);
  vec3 colB = sampleCombined(vUv + caOffset);
  vec3 color = vec3(colR.r, colG.g, colB.b);

  if (uToneMapping > 0.5) {
    color = acesFilm(color);
  } else {
    color = clamp(color, 0.0, 1.0);
  }

  // vignette เบา ๆ: 1.0 ตรงกลางจอ ค่อย ๆ มืดลงเมื่อเข้าใกล้ขอบ (edge0 < edge1 เสมอ — สลับค่าไม่ได้
  // เพราะ smoothstep ของ GLSL ให้ผลไม่นิยามถ้า edge0 > edge1)
  float vig = 1.0 - smoothstep(0.35, 0.85, dist);
  color *= mix(1.0, vig, clamp(uVignette, 0.0, 1.0));

  // film grain เคลื่อนไหวตาม uTime (เวลาสะสมจาก dt ที่ผู้เรียกป้อนเข้ามา — ห้ามใช้ Date.now())
  // เคยลองล็อกลายให้นิ่งเมื่อ 2026-09-10 แล้วเอากลับ: ผู้ใช้ยืนยันว่า "พื้นหลังเคลื่อนไหวได้
  // แต่ไม่ได้ให้เคลื่อนไหวตาม event" — เกรนไม่ได้ผูกกับเหตุการณ์อยู่แล้ว จึงไม่ใช่สิ่งที่ต้องตัด
  float n = hash(vUv * uResolution + uTime * 137.0) - 0.5;
  color += n * uGrain;

  // scanline เบามาก ปิดโดย default (uScanline = 0)
  if (uScanline > 0.0001) {
    float scan = sin(vUv.y * uResolution.y * 3.14159265) * 0.5 + 0.5;
    color *= 1.0 - uScanline * (1.0 - scan);
  }

  color = linearToSRGB(max(color, 0.0));
  gl_FragColor = vec4(color, 1.0);
}
`;

// ------------------------------------------------------------------------------------------------
// เลือกชนิดข้อมูลของ RenderTarget: HalfFloat ถ้าอุปกรณ์รองรับจริง (ทั้ง texture และ render-to-
// texture) ไม่งั้น fallback เป็น UnsignedByte กันจอดำ/throw บนอุปกรณ์เก่าหรือ WebGL1 ที่ไม่มี
// extension ที่จำเป็น
// ------------------------------------------------------------------------------------------------
function pickHDRType(renderer) {
  try {
    if (renderer.capabilities.isWebGL2) {
      // WebGL2: extension เดียว (EXT_color_buffer_float) คุมทั้งความสามารถ render-to-texture ของ
      // half float และ float รวมกัน ไม่มี extension แยกเหมือน WebGL1
      if (renderer.extensions.has("EXT_color_buffer_float")) {
        return THREE.HalfFloatType;
      }
    } else {
      const hasHalfFloatTexture = renderer.extensions.has("OES_texture_half_float");
      const hasHalfFloatRenderable = renderer.extensions.has("EXT_color_buffer_half_float");
      if (hasHalfFloatTexture && hasHalfFloatRenderable) {
        return THREE.HalfFloatType;
      }
    }
  } catch (err) {
    // renderer.extensions.has() ไม่ควร throw แต่กันไว้เผื่อ context แปลก ๆ — fallback ปลอดภัยกว่า
  }
  return THREE.UnsignedByteType;
}

function clampLevels(levels) {
  const n = Math.round(levels);
  if (!Number.isFinite(n)) return DEFAULT_OPTIONS.levels;
  return Math.min(MAX_LEVELS, Math.max(MIN_LEVELS, n));
}

// ต่ำสุด 0.05 กัน RT ขนาดศูนย์/ติดลบเวลาผู้เรียกใส่ค่าพลาด — ใช้ทั้งตอนคำนวณขนาดจริงและตอนเทียบ
// ค่าเก่า/ใหม่ให้ตรงกัน มิฉะนั้นถ้าใครตั้ง resolutionScale ผิดช่วง (เช่น 0) การเทียบค่าดิบ (ที่ไม่ผ่าน
// clamp) กับค่า clamp แล้วที่เก็บไว้จะไม่มีวันเท่ากัน -> buildChain() ถูกเรียกซ้ำทุกเฟรมไม่รู้จบ
function clampResolutionScale(scale) {
  if (!Number.isFinite(scale)) return DEFAULT_OPTIONS.resolutionScale;
  return Math.max(0.05, scale);
}

/**
 * สร้าง bloom/glow post-processing pipeline สำหรับฉาก three.js หนึ่งฉาก
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {object} [options]
 * @returns {{
 *   render: (dt: number) => void,
 *   setSize: (width: number, height: number, pixelRatio?: number) => void,
 *   dispose: () => void,
 *   params: object,
 *   setQuality: (level: "low"|"medium"|"high") => void,
 *   readonly info: { levels: number, rtCount: number, quality: string, width: number, height: number },
 * }}
 */
export function createBloom(renderer, scene, camera, options = {}) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, options);
  // เก็บค่าตอนสร้างไว้เป็น "ค่าเต็มคุณภาพ" ของ instance นี้ — setQuality('medium'/'high') จะย้อนกลับ
  // มาใช้ค่าชุดนี้สำหรับ grain/chromatic (ไม่ใช่ค่า DEFAULT_OPTIONS ตายตัว เผื่อผู้เรียก custom มา)
  const fullQualityDefaults = Object.assign({}, opts);

  const params = {
    strength: opts.strength,
    threshold: opts.threshold,
    knee: opts.knee,
    radius: opts.radius,
    levels: clampLevels(opts.levels),
    resolutionScale: opts.resolutionScale,
    chromatic: opts.chromatic,
    vignette: opts.vignette,
    grain: opts.grain,
    scanline: opts.scanline,
    toneMapping: opts.toneMapping,
  };

  let quality = "high";
  let time = 0;
  let currentLevels = 0;
  let currentResolutionScale = 0;
  /** @type {THREE.WebGLRenderTarget[]} */
  let rtA = [];
  /** @type {THREE.WebGLRenderTarget[]} */
  let rtB = [];
  /** @type {{ width: number, height: number, texel: THREE.Vector2 }[]} */
  let sizes = [];

  const hdrType = pickHDRType(renderer);
  const _drawSize = new THREE.Vector2();
  renderer.getDrawingBufferSize(_drawSize);

  function createRT(width, height, type, extra) {
    return new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), Object.assign({
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      // RT กลางเก็บสีแบบ linear ล้วน ไม่ใช่ sRGB (ดูคำอธิบายยาวหัวไฟล์) — แปลงเป็น sRGB เองที่
      // pass composite เท่านั้น
      colorSpace: THREE.NoColorSpace,
    }, extra || {}));
  }

  function createSceneRT(width, height) {
    return createRT(width, height, hdrType, { depthBuffer: true, stencilBuffer: false });
  }

  let sceneRT = createSceneRT(Math.max(1, Math.round(_drawSize.x)), Math.max(1, Math.round(_drawSize.y)));

  // --- materials (คอมไพล์ครั้งเดียว ใช้ซ้ำได้ทุกชั้น/ทุกเฟรม — เปลี่ยนแค่ uniform ก่อนแต่ละ draw) ---
  function makeFullscreenMaterial(fragmentShader, uniforms) {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      transparent: false,
      toneMapped: false,
    });
  }

  const downsampleMaterial = makeFullscreenMaterial(DOWNSAMPLE_FRAG, {
    tInput: { value: null },
    uTexelSize: { value: new THREE.Vector2() },
    uApplyThreshold: { value: 1 },
    uThreshold: { value: params.threshold },
    uKnee: { value: params.knee },
  });

  const blurMaterial = makeFullscreenMaterial(BLUR_FRAG, {
    tInput: { value: null },
    uTexelSize: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2(1, 0) },
    uRadius: { value: params.radius },
  });

  const combineMaterial = makeFullscreenMaterial(COMBINE_FRAG, {
    tSmall: { value: null },
    tCurrent: { value: null },
    uTexelSizeSmall: { value: new THREE.Vector2() },
    uWeight: { value: 1.0 },
  });

  const compositeMaterial = makeFullscreenMaterial(COMPOSITE_FRAG, {
    tScene: { value: null },
    tBloom: { value: null },
    uStrength: { value: params.strength },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2() },
    uChromatic: { value: params.chromatic },
    uVignette: { value: params.vignette },
    uGrain: { value: params.grain },
    uScanline: { value: params.scanline },
    uToneMapping: { value: params.toneMapping ? 1 : 0 },
  });

  // --- fullscreen quad ใช้ร่วมกันทุก pass (สลับแค่ .material ก่อน render แต่ละครั้ง) ---
  const fsGeometry = new THREE.PlaneGeometry(2, 2);
  const fsMesh = new THREE.Mesh(fsGeometry, downsampleMaterial);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  // กล้องนี้มีไว้ให้ตรง signature ของ renderer.render เท่านั้น — FULLSCREEN_VERT ไม่ได้อ่านค่าจากมันเลย
  const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function blit(material, target) {
    fsMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCamera);
  }

  function disposeChain() {
    for (let i = 0; i < rtA.length; i++) rtA[i].dispose();
    for (let i = 0; i < rtB.length; i++) rtB[i].dispose();
    rtA = [];
    rtB = [];
    sizes = [];
  }

  // สร้าง mip chain ใหม่ตาม params.levels / params.resolutionScale ปัจจุบัน — dispose ของเก่าก่อน
  // เสมอกันหลุด GPU memory ตอนถูกเรียกซ้ำ ๆ (resize รัว ๆ หรือสลับ quality บ่อย ๆ)
  function buildChain() {
    disposeChain();

    const levels = clampLevels(params.levels);
    const scale = clampResolutionScale(params.resolutionScale);

    let w = Math.max(1, Math.floor((sceneRT.width * scale) / 2));
    let h = Math.max(1, Math.floor((sceneRT.height * scale) / 2));

    for (let i = 0; i < levels; i++) {
      sizes.push({ width: w, height: h, texel: new THREE.Vector2(1 / w, 1 / h) });
      rtA.push(createRT(w, h, hdrType));
      rtB.push(createRT(w, h, hdrType));
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }

    currentLevels = levels;
    currentResolutionScale = scale;
  }

  buildChain();

  function render(dt) {
    // กันเฟรมกระโดดใหญ่ผิดปกติ (เช่น กลับมาจาก tab ที่ถูกพักไว้) ไม่ให้ grain/anim อื่น ๆ กระตุก
    // แรง — เวลาสะสมมาจาก dt เท่านั้น ไม่แตะ Date.now()/performance.now()
    const safeDt = Math.min(Math.max(dt || 0, 0), 0.1);
    time += safeDt;

    // ผู้ใช้อาจแก้ params.levels / params.resolutionScale ตรง ๆ ได้เหมือน param อื่น ๆ — ตรวจจับ
    // การเปลี่ยนแปลงเชิงโครงสร้างพวกนี้แล้วสร้าง RT chain ใหม่ให้อัตโนมัติก่อนเรนเดอร์เฟรมถัดไป
    if (
      clampLevels(params.levels) !== currentLevels ||
      clampResolutionScale(params.resolutionScale) !== currentResolutionScale
    ) {
      buildChain();
    }

    const prevTarget = renderer.getRenderTarget();
    const prevToneMapping = renderer.toneMapping;
    const prevOutputColorSpace = renderer.outputColorSpace;
    const prevAutoClear = renderer.autoClear;

    // --- 1) scene pass: เรนเดอร์ฉากจริงลง sceneRT แบบ HDR เชิงเส้นล้วน (ดูคำอธิบายยาวหัวไฟล์) ---
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = true;
    renderer.setRenderTarget(sceneRT);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // pass ที่เหลือทั้งหมดเป็น fullscreen quad ทึบแสง (NoBlending) ที่เขียนทับทุกพิกเซลอยู่แล้ว
    // ปิด autoClear ไปเลยเพื่อลดงาน GPU ที่ไม่จำเป็น (เป้าหมาย 60fps บน iGPU)
    renderer.autoClear = false;

    // --- 2) bright pass: downsample ครึ่งขนาด + soft-knee threshold -> mip 0 ---
    downsampleMaterial.uniforms.tInput.value = sceneRT.texture;
    downsampleMaterial.uniforms.uTexelSize.value.set(1 / sceneRT.width, 1 / sceneRT.height);
    downsampleMaterial.uniforms.uApplyThreshold.value = 1;
    downsampleMaterial.uniforms.uThreshold.value = params.threshold;
    downsampleMaterial.uniforms.uKnee.value = params.knee;
    blit(downsampleMaterial, rtA[0]);

    // --- 3) blur chain: gaussian 9-tap H แล้ว V ต่อ mip แล้ว downsample ต่อไปชั้นถัดไป ---
    blurMaterial.uniforms.uRadius.value = params.radius;
    for (let i = 0; i < currentLevels; i++) {
      const texel = sizes[i].texel;

      blurMaterial.uniforms.tInput.value = rtA[i].texture;
      blurMaterial.uniforms.uTexelSize.value.copy(texel);
      blurMaterial.uniforms.uDirection.value.set(1, 0);
      blit(blurMaterial, rtB[i]);

      blurMaterial.uniforms.tInput.value = rtB[i].texture;
      blurMaterial.uniforms.uDirection.value.set(0, 1);
      blit(blurMaterial, rtA[i]); // rtA[i] กลายเป็นภาพเบลอสุดท้าย (blurred_i) ของชั้นนี้

      if (i < currentLevels - 1) {
        downsampleMaterial.uniforms.tInput.value = rtA[i].texture;
        downsampleMaterial.uniforms.uTexelSize.value.copy(texel);
        downsampleMaterial.uniforms.uApplyThreshold.value = 0;
        blit(downsampleMaterial, rtA[i + 1]);
      }
    }

    // --- 4) upsample + combine: ไล่จากชั้นเล็กสุดกลับขึ้นมาชั้นใหญ่ที่สุด (mip 0) ---
    let bloomTexture = rtA[currentLevels - 1].texture;
    for (let i = currentLevels - 2; i >= 0; i--) {
      combineMaterial.uniforms.tSmall.value = bloomTexture;
      combineMaterial.uniforms.tCurrent.value = rtA[i].texture;
      combineMaterial.uniforms.uTexelSizeSmall.value.copy(sizes[i + 1].texel);
      combineMaterial.uniforms.uWeight.value = 1.0;
      blit(combineMaterial, rtB[i]);
      bloomTexture = rtB[i].texture;
    }

    // --- 5) composite: scene + bloom -> จอ พร้อม tonemap/vignette/chromatic/grain/scanline ---
    compositeMaterial.uniforms.tScene.value = sceneRT.texture;
    compositeMaterial.uniforms.tBloom.value = bloomTexture;
    compositeMaterial.uniforms.uStrength.value = params.strength;
    compositeMaterial.uniforms.uTime.value = time;
    compositeMaterial.uniforms.uResolution.value.set(sceneRT.width, sceneRT.height);
    compositeMaterial.uniforms.uChromatic.value = params.chromatic;
    compositeMaterial.uniforms.uVignette.value = params.vignette;
    compositeMaterial.uniforms.uGrain.value = params.grain;
    compositeMaterial.uniforms.uScanline.value = params.scanline;
    compositeMaterial.uniforms.uToneMapping.value = params.toneMapping ? 1 : 0;
    blit(compositeMaterial, null);

    // คืนสถานะ renderer เดิมทั้งหมด — pass ของเราเองไม่สนใจค่าพวกนี้อยู่แล้ว (ไม่ include chunk
    // colorspace/tonemapping ของ three) แต่โค้ดอื่นนอกไฟล์นี้ที่เรียก renderer ต่อจากเราอาจสนใจ
    renderer.toneMapping = prevToneMapping;
    renderer.outputColorSpace = prevOutputColorSpace;
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  // ต้องรองรับ renderer.setPixelRatio() ที่ผู้เรียกตั้งไว้แล้ว — หลังสั่ง setSize/setPixelRatio ทุก
  // ครั้งให้อ่านขนาด "จริง" กลับมาจาก getDrawingBufferSize() เสมอ ห้ามคำนวณเอาเองจาก width*pixelRatio
  // เพราะ renderer อาจปัดเศษ/clamp ด้วย maxTextureSize ต่างจากที่เราคูณเลขเองตรง ๆ
  function setSize(width, height, pixelRatio) {
    if (typeof pixelRatio === "number" && pixelRatio > 0) {
      renderer.setPixelRatio(pixelRatio);
    }
    if (typeof width === "number" && typeof height === "number") {
      renderer.setSize(width, height);
    }

    renderer.getDrawingBufferSize(_drawSize);
    const w = Math.max(1, Math.round(_drawSize.x));
    const h = Math.max(1, Math.round(_drawSize.y));

    // dispose ของเก่าก่อนสร้างใหม่เสมอ กันรั่วตอนถูกเรียกซ้ำ ๆ (เช่น ลาก resize หน้าต่างรัว ๆ)
    sceneRT.dispose();
    sceneRT = createSceneRT(w, h);
    buildChain();
  }

  function setQuality(level) {
    if (level === "low") {
      params.levels = 2;
      params.resolutionScale = 0.6;
      params.grain = 0;
      params.chromatic = 0;
      quality = "low";
    } else if (level === "medium") {
      params.levels = 3;
      params.resolutionScale = 0.8;
      params.grain = fullQualityDefaults.grain;
      params.chromatic = fullQualityDefaults.chromatic;
      quality = "medium";
    } else {
      // "high" หรือค่าที่ไม่รู้จัก -> fallback เป็น high (ค่าคุณภาพเต็มตอนสร้าง instance นี้)
      params.levels = fullQualityDefaults.levels;
      params.resolutionScale = fullQualityDefaults.resolutionScale;
      params.grain = fullQualityDefaults.grain;
      params.chromatic = fullQualityDefaults.chromatic;
      quality = "high";
    }
    // สร้าง chain ใหม่ทันที (ไม่ต้องรอ render() เฟรมถัดไปตรวจจับเอง) เผื่อมีคนอ่าน .info ก่อนเฟรมถัดไป
    buildChain();
  }

  function dispose() {
    disposeChain();
    sceneRT.dispose();
    fsGeometry.dispose();
    downsampleMaterial.dispose();
    blurMaterial.dispose();
    combineMaterial.dispose();
    compositeMaterial.dispose();
  }

  return {
    render,
    setSize,
    dispose,
    params,
    setQuality,
    get info() {
      return {
        levels: currentLevels,
        rtCount: 1 + rtA.length + rtB.length,
        quality,
        width: sceneRT.width,
        height: sceneRT.height,
      };
    },
  };
}
