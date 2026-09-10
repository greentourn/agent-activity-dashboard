// controls.js
// ตัวควบคุมกล้องแบบ orbit ("หมุนวนรอบจุดสนใจ") เขียนขึ้นเอง ไม่พึ่งพา three/examples/OrbitControls
// (ใช้ได้เฉพาะ `import * as THREE from "three"` เท่านั้น) สำหรับฉาก 3D "สมอง AI" ที่ผู้ใช้ต้อง
// หมุน/ซูม/แพนดูโหนดต่าง ๆ ได้ลื่นไหลทั้งบนเมาส์และมือถือ/แท็บเล็ต
//
// แนวคิดหลัก: เก็บสถานะกล้องเป็นพิกัดทรงกลม (spherical: radius/phi/theta) รอบจุด target แล้วมี
// "ค่าเป้าหมาย" (goal) แยกจาก "ค่าจริงที่ใช้เรนเดอร์" อยู่เสมอ — ทุกอินพุต (ลาก/wheel/pinch/โฟกัส
// โหนด) แก้แค่ค่าเป้าหมาย ส่วน update(dt) มีหน้าที่เดียวคือค่อย ๆ ผ่อนค่าจริงเข้าหาค่าเป้าหมายทุกเฟรม
// (exponential smoothing ที่ปรับตาม dt จริง ไม่ผูกกับเฟรมเรต) — นี่คือกลไกเดียวที่ทำให้ทั้งการหมุนแบบ
// มีโมเมนตัม (ลากแล้วปล่อยยังหมุนต่อ) และการ ease ไปยังเป้าหมายใหม่ (โฟกัสโหนด/reset) ใช้สูตรเดียวกัน

import * as THREE from "three";

// ── ค่าคงที่ภายใน ──────────────────────────────────────────────────────────
// ไม่ได้เปิดเป็น option เพราะเป็นรายละเอียด "ความรู้สึก" ของตัวควบคุม ไม่ใช่พฤติกรรมเชิงฟังก์ชัน
const TWO_PI = Math.PI * 2;
const EPSILON = 1e-5;
// ต้องปล่อยมืออย่างน้อยกี่วินาที auto-rotate ถึงจะเริ่มกลับมาหมุนเอง (ข้อ 5 ของสเปก)
const AUTO_ROTATE_RESUME_DELAY = 2;
// ยิ่งมาก ยิ่งเร่งความเร็ว auto-rotate กลับเข้าสู่ความเร็วเต็มไวขึ้นหลังพ้นช่วงรอ (นิยามที่ 60fps เหมือน dampingFactor)
const AUTO_ROTATE_RAMP_FACTOR = 0.6;
// ใช้กับการ ease แบบ "มีเป้าหมายเดียว" ทั้งหมด (setTarget/focusOn/reset/ระยะซูม) — ตอบสนองไวกว่า
// ค่า dampingFactor เริ่มต้นของโมเมนตัมลากเล็กน้อย เพราะเป็นการเคลื่อนที่ที่ผู้ใช้ "สั่ง" ไม่ใช่ "ปล่อยค้าง"
const EASE_FACTOR = 0.12;
// ตัวคูณความไวหมุนพื้นฐาน ก่อนคูณด้วย distanceFactor (ข้อ 1) และหารด้วยขนาด element
const ROTATE_SPEED = 1.35;
// แปลง deltaY ของ wheel (หน่วยพิกเซลโดยประมาณ) เป็นเลขชี้กำลังสำหรับซูมแบบ exponential (ข้อ 2)
const ZOOM_WHEEL_SENSITIVITY = 0.0015;
// กันเฟรมที่ dt ใหญ่ผิดปกติ (สลับแท็บ/แท็บถูกพักแล้วกลับมา) ทำให้กล้องกระโดดหรือ damping พังทันทีเฟรมเดียว
const MAX_FRAME_DT = 0.1;

/**
 * แปลง "ค่าปัจจัยต่อเฟรมที่นิยามไว้ที่ 60fps" (เช่น dampingFactor) ให้เป็นสัดส่วนที่ถูกต้องตาม dt จริง
 * ของเฟรมนี้ — ถ้าใช้ dampingFactor ตรง ๆ ทุกเฟรมโดยไม่ปรับ จอ 144Hz จะหน่วง (damp) เร็วกว่าจอ 30Hz
 * เห็นได้ชัด เพราะ update() ถูกเรียกถี่กว่า สูตรนี้ทำให้ผลลัพธ์สะสมต่อวินาทีเท่ากันไม่ว่าเฟรมเรตเท่าไร
 */
function frameFactor(perFrameFactor, dt) {
  return 1 - Math.pow(1 - perFrameFactor, Math.max(dt, 0) * 60);
}

/** หามุมเบี่ยงที่สั้นที่สุดจาก from ไป to โดยพันรอบ 2π อย่างถูกต้อง (กัน ease หมุนอ้อมโลกตอนกลับ theta) */
function shortestAngleDelta(from, to) {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

/** แปลง event.deltaY ของ wheel ให้เป็นหน่วย "พิกเซลโดยประมาณ" ไม่ว่า deltaMode ของเบราว์เซอร์จะเป็นแบบไหน */
function normalizeWheelDelta(event) {
  switch (event.deltaMode) {
    case 1: // DOM_DELTA_LINE — ส่วนใหญ่คือ Firefox นับเป็น "บรรทัด" ไม่ใช่พิกเซล
      return event.deltaY * 18;
    case 2: // DOM_DELTA_PAGE — พบน้อยมาก แต่กันไว้ไม่ให้ซูมกระโดดทีเดียวสุด
      return event.deltaY * 400;
    default: // DOM_DELTA_PIXEL — เคสปกติ (Chrome/Edge/trackpad)
      return event.deltaY;
  }
}

/**
 * สร้างตัวควบคุมกล้องแบบ orbit หนึ่งตัว ผูกกับ camera + domElement ที่ส่งเข้ามา
 * @param {THREE.Camera} camera
 * @param {HTMLElement} domElement
 * @param {object} [options]
 */
export function createControls(camera, domElement, options = {}) {
  const minDistance = options.minDistance ?? 6;
  const maxDistance = options.maxDistance ?? 90;
  const minPolar = options.minPolar ?? 0.15;
  const maxPolar = options.maxPolar ?? Math.PI - 0.15;
  const dampingFactor = options.dampingFactor ?? 0.075;
  const autoRotateSpeed = options.autoRotateSpeed ?? 0.045;
  let autoRotateEnabled = options.autoRotate ?? true;
  const enablePan = options.enablePan ?? true;

  const clampDistance = (value) => THREE.MathUtils.clamp(value, minDistance, maxDistance);
  const clampPolar = (value) => THREE.MathUtils.clamp(value, minPolar, maxPolar);

  // ── สถานะ target (จุดที่กล้องหมุนรอบ) ────────────────────────────────────
  const target = options.target ? options.target.clone() : new THREE.Vector3(0, 0, 0);
  const targetGoal = target.clone(); // ease ปลายทาง — ปกติเท่ากับ target เป๊ะ ยกเว้นตอนกำลัง setTarget/focusOn/reset

  // ── สถานะเชิงมุม/ระยะของกล้อง (พิกัดทรงกลมรอบ target) ────────────────────
  const initialDistance = clampDistance(options.distance ?? 26);
  const spherical = new THREE.Spherical(initialDistance, Math.PI / 2 - 0.35, Math.PI / 4);
  {
    // ถ้าผู้เรียกตั้งตำแหน่งกล้องไว้ก่อนแล้ว (ไม่ทับซ้อนกับ target พอดี) ให้สืบทิศจากตรงนั้นแทน
    // ค่ามุมเริ่มต้นด้านบน (45°, เงยจากแนวนอนเล็กน้อย) ใช้เฉพาะตอนกล้องซ้อนทับ target พอดี (เวกเตอร์ศูนย์
    // ไม่มีทิศทางให้สืบ) กันกรณีที่ยังไม่มีใครตั้งตำแหน่งกล้องมาก่อนเรียก createControls
    const offset = camera.position.clone().sub(target);
    if (offset.lengthSq() > EPSILON) {
      spherical.setFromVector3(offset);
    }
    spherical.radius = initialDistance;
    spherical.phi = clampPolar(spherical.phi);
  }
  // จำค่าเริ่มต้นไว้ให้ reset() ย้อนกลับมาได้
  const initialTarget = target.clone();
  const initialTheta = spherical.theta;
  const initialPhi = spherical.phi;

  // ── โมเมนตัมจากการลาก (ค่าที่ "ค้างรอ" ให้ update() ผ่อนเข้าสถานะจริงทีละนิดทุกเฟรม แล้วสลายไปเอง
  //    ด้วย damping — นี่คือกลไกที่ทำให้ลากแล้วปล่อยกลางคันยังรู้สึก "ลื่น"/มีน้ำหนักต่อไปอีกครู่) ──
  const sphericalDelta = { theta: 0, phi: 0 };
  const panDelta = new THREE.Vector3();
  let distanceGoal = spherical.radius; // wheel/pinch/focusOn/distance-setter แก้ค่านี้อย่างเดียว

  // ใช้เฉพาะตอน reset() ต้อง ease มุมกลับไปค่าเริ่มต้น — ไม่ใช่โมเมนตัม จึงแยกกลไกจาก sphericalDelta
  let rotationEase = null; // null = ไม่ได้กำลัง ease มุมอยู่ | { theta, phi } = กำลัง ease ไปหาค่านี้

  // ── ตัวติดตามอินพุตจากผู้ใช้ ──────────────────────────────────────────────
  const pointers = new Map(); // pointerId -> { x, y } (พิกัดล่าสุดของนิ้ว/เมาส์ที่กำลังกดอยู่)
  let dragMode = "none"; // "none" | "rotate" | "pan" | "pinch"
  let pinchDistance = 0;
  const pinchMidpoint = { x: 0, y: 0 };
  // เริ่มต้นถือว่า idle มานานพอแล้ว ให้ auto-rotate ค่อย ๆ เริ่มหมุนได้ทันทีตั้งแต่โหลดฉากเสร็จ
  let idleTime = AUTO_ROTATE_RESUME_DELAY;
  let autoRotateRamp = 0;

  // เวกเตอร์ scratch — จองไว้ครั้งเดียวใช้ซ้ำทุกเฟรม กัน garbage collection ถี่ ๆ ระหว่างลาก/เรนเดอร์
  const cameraOffsetScratch = new THREE.Vector3();
  const panApplyScratch = new THREE.Vector3();
  const panRightScratch = new THREE.Vector3();
  const panUpScratch = new THREE.Vector3();

  function elementHeight() {
    return Math.max(domElement.clientHeight, 1);
  }

  /** ระยะโลกที่ตรงกับ 1 พิกเซลบนจอ ณ ระยะกล้องปัจจุบัน — ทำให้ pan รู้สึกเหมือน "จับ" วัตถุใต้เคอร์เซอร์ลากจริง */
  function panPixelToWorldScale() {
    if (camera.isPerspectiveCamera) {
      const fov = THREE.MathUtils.degToRad(camera.fov || 50);
      return (2 * Math.tan(fov / 2) * spherical.radius) / elementHeight();
    }
    if (camera.isOrthographicCamera) {
      const frustumHeight = (camera.top - camera.bottom) / (camera.zoom || 1);
      return frustumHeight / elementHeight();
    }
    // fallback เผื่อกล้องชนิดอื่น — ใช้อัตราส่วนอย่างง่ายพอให้ยังลากได้ ไม่ error
    return spherical.radius / elementHeight();
  }

  /** สะสมมุมหมุนที่ค้างรอ (สลายด้วย damping ใน update()) จากระยะทางที่ลากบนจอ (พิกเซล) */
  function rotate(deltaXPixels, deltaYPixels) {
    // ผู้ใช้เข้ามาหมุนเองแล้ว ต้องยกเลิก ease มุมที่ค้างจาก reset() ไม่ให้สองกลไกแย่งกันแก้ spherical.theta/phi
    rotationEase = null;
    const size = elementHeight();
    // ข้อ 1: ความไวปรับตามทั้ง distance (ยิ่งซูมออกไกลยิ่งหมุนไวขึ้น ชดเชยขนาดวัตถุที่เล็กลงบนจอ ยิ่งซูมเข้า
    // ใกล้ยิ่งหมุนช้าลงให้ละเอียดขึ้น) และขนาด element (จอใหญ่ = ลากพิกเซลเท่ากันได้มุมเท่าเดิม)
    const distanceFactor = THREE.MathUtils.clamp(
      spherical.radius / ((minDistance + maxDistance) / 2),
      0.4,
      2.2,
    );
    const speed = TWO_PI * ROTATE_SPEED * distanceFactor;
    sphericalDelta.theta -= (deltaXPixels / size) * speed;
    sphericalDelta.phi -= (deltaYPixels / size) * speed;
  }

  /** สะสมระยะแพนที่ค้างรอ (โลก, สลายด้วย damping ใน update()) จากระยะทางที่ลากบนจอ (พิกเซล) */
  function pan(deltaXPixels, deltaYPixels) {
    if (!enablePan) return;
    const scale = panPixelToWorldScale();
    camera.updateMatrixWorld(); // matrixWorld อาจยังไม่อัปเดตของเฟรมนี้ (pointermove เกิดนอกรอบ render loop)
    panRightScratch.setFromMatrixColumn(camera.matrixWorld, 0); // แกน x ของกล้องในโลก = "ขวา"
    panUpScratch.setFromMatrixColumn(camera.matrixWorld, 1); // แกน y ของกล้องในโลก = "ขึ้น"
    // ลากขวา (deltaX บวก) ต้องให้ฉากดูเหมือนเลื่อนตามนิ้ว/เมาส์ ⇒ target เลื่อนไปทาง "ซ้าย" ของกล้อง จึงลบ
    // ลากลง (deltaY บวกในพิกัดจอ) ⇒ ให้ฉากเลื่อนลงตามนิ้ว ⇒ target เลื่อนขึ้นในโลก จึงบวกตรง ๆ
    panDelta.addScaledVector(panRightScratch, -deltaXPixels * scale);
    panDelta.addScaledVector(panUpScratch, deltaYPixels * scale);
    // sync goal เข้ากับ target ทันที เพื่อยกเลิก ease เป้าหมายเก่า (setTarget/focusOn ที่อาจค้างอยู่)
    // ไม่ให้สองกลไกแย่งกันเขียน target ในเฟรมเดียวกัน — จากนี้ momentum ในข้อ pan จะเป็นผู้คุม target แต่ผู้เดียว
    targetGoal.copy(target);
  }

  function applyZoom(factor) {
    distanceGoal = clampDistance(distanceGoal * factor);
  }

  function pinchMetrics() {
    const ids = Array.from(pointers.keys());
    const a = pointers.get(ids[0]);
    const b = pointers.get(ids[1]);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return { distance: Math.hypot(dx, dy), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }

  function beginInteraction() {
    // การจับกล้องถือว่าเริ่มโต้ตอบทันที — auto-rotate ต้องหยุดพุ่งทันที ไม่ต้องรอ update() รอบถัดไปประมวลผล
    idleTime = 0;
    autoRotateRamp = 0;
  }

  function onPointerDown(event) {
    domElement.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      if (event.pointerType === "mouse") {
        // ข้อ 3: ลากขวา หรือ shift+ลากซ้าย = pan, ปกติลากซ้าย = rotate
        dragMode = event.button === 2 || event.shiftKey ? "pan" : "rotate";
      } else {
        // ทัชนิ้วเดียว = หมุนก่อน ถ้ามีนิ้วที่สองตามมาจะถูกอัปเกรดเป็น pinch ด้านล่าง
        dragMode = "rotate";
      }
    } else if (pointers.size === 2) {
      // ข้อ 3: ลาก 2 นิ้ว = pan + ซูมพร้อมกัน (pinch)
      dragMode = "pinch";
      const metrics = pinchMetrics();
      pinchDistance = metrics.distance;
      pinchMidpoint.x = metrics.midX;
      pinchMidpoint.y = metrics.midY;
    }
    beginInteraction();
    event.preventDefault();
  }

  function onPointerMove(event) {
    const point = pointers.get(event.pointerId);
    if (!point) return; // เมาส์ขยับผ่าน ๆ โดยไม่ได้กดปุ่มไว้ (hover) ไม่เกี่ยวกับตัวควบคุมนี้
    const deltaX = event.clientX - point.x;
    const deltaY = event.clientY - point.y;
    point.x = event.clientX;
    point.y = event.clientY;

    if (dragMode === "rotate") {
      rotate(deltaX, deltaY);
    } else if (dragMode === "pan") {
      pan(deltaX, deltaY);
    } else if (dragMode === "pinch" && pointers.size >= 2) {
      const metrics = pinchMetrics();
      if (pinchDistance > EPSILON) {
        // นิ้วแยกออกจากกัน (ระยะเพิ่มขึ้น) = ซูมเข้า (ระยะกล้องลดลง) ตามธรรมชาติของ pinch-to-zoom
        const ratio = metrics.distance / pinchDistance;
        if (ratio > EPSILON) applyZoom(1 / ratio);
      }
      pan(metrics.midX - pinchMidpoint.x, metrics.midY - pinchMidpoint.y);
      pinchDistance = metrics.distance;
      pinchMidpoint.x = metrics.midX;
      pinchMidpoint.y = metrics.midY;
    }
    idleTime = 0;
    event.preventDefault();
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (domElement.hasPointerCapture && domElement.hasPointerCapture(event.pointerId)) {
      domElement.releasePointerCapture(event.pointerId);
    }
    if (pointers.size === 0) {
      dragMode = "none";
    } else if (pointers.size === 1) {
      // เหลือนิ้วเดียวจากที่เคย pinch อยู่ — ตำแหน่งล่าสุดของนิ้วที่เหลือถูกเก็บไว้ใน map แล้ว ดังนั้น
      // pointermove ครั้งถัดไปจะคำนวณ delta จากตำแหน่งนั้นต่อเนื่อง ไม่มีการกระโดดของกล้อง
      dragMode = "rotate";
    }
    // การปล่อยมือไม่ล้างโมเมนตัม (sphericalDelta/panDelta) ที่ค้างอยู่ — ปล่อยให้ update() สลายเองตาม
    // damping ต่อไป นี่คือกลไกที่ทำให้ "ลากแล้วปล่อยกลางคัน" ยังหมุน/แพนต่อไปอีกครู่แบบมีน้ำหนัก
  }

  function onWheel(event) {
    event.preventDefault();
    // ข้อ 2: ซูมแบบ exponential (คูณ/หาร) ไม่ใช่บวก/ลบตรง ๆ — ความรู้สึกซูมจะคงที่ไม่ว่าจะอยู่ระยะไหน
    applyZoom(Math.exp(normalizeWheelDelta(event) * ZOOM_WHEEL_SENSITIVITY));
  }

  function onContextMenu(event) {
    // กันเมนูคลิกขวาของเบราว์เซอร์เด้งตอนปล่อยเมาส์หลังใช้ลากขวาเพื่อ pan (ข้อ 3)
    event.preventDefault();
  }

  domElement.style.touchAction = "none"; // กันเบราว์เซอร์ทำ pan/scroll/pinch-zoom หน้าเว็บเองระหว่างลากบน canvas
  domElement.addEventListener("pointerdown", onPointerDown, { passive: false });
  domElement.addEventListener("pointermove", onPointerMove, { passive: false });
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointercancel", onPointerUp);
  domElement.addEventListener("wheel", onWheel, { passive: false });
  domElement.addEventListener("contextmenu", onContextMenu);

  function applyToCamera() {
    cameraOffsetScratch.setFromSpherical(spherical);
    camera.position.copy(target).add(cameraOffsetScratch);
    camera.lookAt(target);
  }

  function update(dt) {
    const delta = Math.min(Math.max(dt || 0, 0), MAX_FRAME_DT);

    // เวลาที่ไม่มีนิ้ว/เมาส์กดค้างอยู่เลย สะสมไว้ตัดสินว่า auto-rotate จะกลับมาหมุนเมื่อไร (ข้อ 5)
    if (pointers.size === 0) {
      idleTime += delta;
    } else {
      idleTime = 0;
    }

    // ── auto-rotate: ไล่ ramp (0→1) แทนการเปิด/ปิดทันที กันความรู้สึกกระตุกตอนเริ่ม/หยุดหมุนเอง ──
    if (pointers.size > 0) {
      autoRotateRamp = 0; // ถูกจับอยู่ตอนนี้ — หยุดทันที ให้ผู้ใช้ควบคุมเต็มที่ (ไม่ต้องรอ ease)
    } else {
      const rampTarget = autoRotateEnabled && idleTime >= AUTO_ROTATE_RESUME_DELAY ? 1 : 0;
      autoRotateRamp += (rampTarget - autoRotateRamp) * frameFactor(AUTO_ROTATE_RAMP_FACTOR, delta);
    }
    if (autoRotateRamp > EPSILON) {
      spherical.theta -= autoRotateSpeed * delta * autoRotateRamp;
    }

    // ── โมเมนตัมจากการลากหมุน: ผ่อนเข้าสถานะจริงทีละนิด แล้วสลายตัวมันเองทุกเฟรมด้วย damping (ข้อ 4) ──
    const rotFactor = frameFactor(dampingFactor, delta);
    spherical.theta += sphericalDelta.theta * rotFactor;
    spherical.phi += sphericalDelta.phi * rotFactor;
    sphericalDelta.theta *= 1 - rotFactor;
    sphericalDelta.phi *= 1 - rotFactor;
    spherical.phi = clampPolar(spherical.phi);

    // ── ease มุมกลับค่าเริ่มต้น (ใช้เฉพาะตอน reset() ทำงานอยู่) ──
    if (rotationEase) {
      const f = frameFactor(EASE_FACTOR, delta);
      spherical.theta += shortestAngleDelta(spherical.theta, rotationEase.theta) * f;
      spherical.phi += (rotationEase.phi - spherical.phi) * f;
      spherical.phi = clampPolar(spherical.phi);
      const closeEnough =
        Math.abs(shortestAngleDelta(spherical.theta, rotationEase.theta)) < 1e-3 &&
        Math.abs(rotationEase.phi - spherical.phi) < 1e-3;
      if (closeEnough) {
        spherical.theta = rotationEase.theta;
        spherical.phi = rotationEase.phi;
        rotationEase = null;
      }
    }

    // ── โมเมนตัมจากการลากแพน (เหมือนข้อหมุน แต่เป็นเวกเตอร์โลกแทนมุม) ──
    if (enablePan && panDelta.lengthSq() > EPSILON * EPSILON) {
      const panFactor = frameFactor(dampingFactor, delta);
      panApplyScratch.copy(panDelta).multiplyScalar(panFactor);
      target.add(panApplyScratch);
      targetGoal.add(panApplyScratch); // คงให้ target/targetGoal เท่ากันเสมอระหว่างลากแพน กัน ease ด้านล่างแย่งงาน
      panDelta.multiplyScalar(1 - panFactor);
    }

    // ── ease target เข้าหา targetGoal (มีผลเฉพาะตอน setTarget(animate)/focusOn/reset ทำงานอยู่ — ข้อ 6) ──
    if (!target.equals(targetGoal)) {
      const f = frameFactor(EASE_FACTOR, delta);
      target.lerp(targetGoal, f);
      if (target.distanceToSquared(targetGoal) < EPSILON * EPSILON) {
        target.copy(targetGoal);
      }
    }

    // ── ease ระยะซูมเข้าหา distanceGoal (wheel/pinch/focusOn/setter ทั้งหมดแก้แค่ distanceGoal — ข้อ 6) ──
    if (Math.abs(spherical.radius - distanceGoal) > EPSILON) {
      const f = frameFactor(EASE_FACTOR, delta);
      spherical.radius += (distanceGoal - spherical.radius) * f;
    } else {
      spherical.radius = distanceGoal;
    }

    applyToCamera();
  }

  function dispose() {
    domElement.removeEventListener("pointerdown", onPointerDown);
    domElement.removeEventListener("pointermove", onPointerMove);
    domElement.removeEventListener("pointerup", onPointerUp);
    domElement.removeEventListener("pointercancel", onPointerUp);
    domElement.removeEventListener("wheel", onWheel);
    domElement.removeEventListener("contextmenu", onContextMenu);
    pointers.clear();
  }

  function setTarget(vec3, animateOptions = {}) {
    const animate = animateOptions.animate !== false; // ค่าเริ่มต้นตามสเปกคือ true
    if (animate) {
      targetGoal.copy(vec3);
    } else {
      target.copy(vec3);
      targetGoal.copy(vec3);
    }
  }

  function focusOn(vec3, distanceValue) {
    setTarget(vec3, { animate: true });
    if (typeof distanceValue === "number") {
      distanceGoal = clampDistance(distanceValue);
    }
  }

  function reset() {
    targetGoal.copy(initialTarget);
    distanceGoal = initialDistance;
    rotationEase = { theta: initialTheta, phi: initialPhi };
    // ล้างโมเมนตัมที่ค้างอยู่ ไม่ให้ไปหักล้าง/รบกวนการ ease กลับค่าเริ่มต้นที่เพิ่งสั่ง
    sphericalDelta.theta = 0;
    sphericalDelta.phi = 0;
    panDelta.set(0, 0, 0);
  }

  applyToCamera(); // ให้กล้องอยู่ตำแหน่งถูกต้องตั้งแต่เฟรมแรก ไม่ต้องรอ update(dt) ถูกเรียกก่อน

  return {
    update,
    dispose,
    setTarget,
    focusOn,
    reset,
    get autoRotate() {
      return autoRotateEnabled;
    },
    set autoRotate(value) {
      autoRotateEnabled = Boolean(value);
    },
    get distance() {
      return spherical.radius;
    },
    set distance(value) {
      const clamped = clampDistance(value);
      spherical.radius = clamped;
      distanceGoal = clamped;
    },
    get target() {
      return target.clone();
    },
    get isUserInteracting() {
      // จริงระหว่างลาก + อีก 2 วินาทีหลังปล่อยมือ (ข้อ 5) — ใช้ค่าเดียวกับที่ auto-rotate ใช้ตัดสินใจ
      return pointers.size > 0 || idleTime < AUTO_ROTATE_RESUME_DELAY;
    },
  };
}
