/*
 * shaders.js — คลัง GLSL ที่ใช้ร่วมกันทุกวัตถุในฉาก
 *
 * ทำไมต้องรวมไว้ที่เดียว: noise/fbm/curl ถูกใช้ทั้งใน vertex ของเปลือกสมอง, fragment ของเนบิวลา
 * และการเคลื่อนที่ของอนุภาค — ถ้าก๊อปโค้ด noise ไปวางแต่ละไฟล์ พอปรับ "ความหยาบ" ที่หนึ่ง
 * อีกที่จะเพี้ยนตาม แล้วหาไม่เจอว่าเพราะอะไร
 *
 * ทุกฟังก์ชันที่นี่เป็น string ล้วน — ประกอบด้วย template literal ตอนสร้าง material
 */

/* hash + value/simplex noise แบบไม่มี texture — ทำงานได้ทุก GPU */
export const GLSL_NOISE = /* glsl */ `
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  vec3 hash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
  }

  /* simplex noise 3 มิติ (Ashima) — ใช้กับการบิดผิวสมองและเมฆพลังงาน */
  vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0 / 7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  /* fbm — ซ้อน noise หลายชั้นให้ผิวมีรายละเอียดแบบอินทรีย์ ไม่ใช่คลื่นไซน์เรียบ ๆ */
  float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      sum += amp * snoise(p * freq);
      freq *= 2.02;
      amp *= 0.5;
    }
    return sum;
  }
`;

/* ยูทิลิตี้เล็ก ๆ ที่ shader ส่วนใหญ่ต้องใช้ */
export const GLSL_UTIL = /* glsl */ `
  mat3 rotY(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  }

  mat3 rotX(float a) {
    float c = cos(a), s = sin(a);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
  }

  float easeOutCubic(float t) { return 1.0 - pow(1.0 - t, 3.0); }
  float easeInOutSine(float t) { return -(cos(3.14159265 * t) - 1.0) / 2.0; }

  /* จุดกลมนุ่ม ๆ สำหรับ gl_PointCoord — ใช้แทน texture ทุกที่ในโปรเจกต์นี้ */
  float softDisc(vec2 uv, float hardness) {
    float d = length(uv - 0.5) * 2.0;
    return 1.0 - smoothstep(hardness, 1.0, d);
  }

  /* วงแหวนบาง ๆ (ใช้ทำ shockwave / ring ของ node) */
  float ringMask(vec2 uv, float radius, float width) {
    float d = length(uv - 0.5) * 2.0;
    return smoothstep(width, 0.0, abs(d - radius));
  }
`;

/*
 * fresnel — ทำให้ขอบวัตถุเรืองแสงกว่าตรงกลาง คือหัวใจของลุค "พลังงาน/โฮโลแกรม"
 * ถ้าไม่มีตัวนี้ ทรงกลมจะดูเป็นลูกบอลพลาสติกทันที
 */
export const GLSL_FRESNEL = /* glsl */ `
  float fresnel(vec3 viewDir, vec3 normal, float power) {
    return pow(1.0 - clamp(dot(viewDir, normal), 0.0, 1.0), power);
  }
`;

/** ประกอบ chunk ที่ใช้บ่อยเป็นก้อนเดียว (ลดการพิมพ์ผิดตอน import) */
export const GLSL_COMMON = `${GLSL_NOISE}\n${GLSL_UTIL}\n${GLSL_FRESNEL}`;
