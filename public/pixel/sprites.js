/*
 * sprites.js — ประตูเดียวสู่ภาพพิกเซลทั้งหมดของ PIXEL OFFICE
 *
 * scene.js import จากไฟล์นี้ไฟล์เดียว ส่วนงานวาดจริงแยกอยู่ใน art/ ตามชนิดของภาพ:
 *   art/base.js        พาเลต · วาดแผนที่พิกเซล · atlas · hash
 *   art/characters.js  ตัวละคร (หน้าตาจาก id · ท่าทาง · หน้า · ของในมือ)
 *   art/props.js       เฟอร์นิเจอร์ · ของแต่งผนัง · เปลือกห้อง (พื้น/ผนัง)
 *   art/fx.js          ไอคอน · ฟองคำพูด · เอฟเฟกต์ · ตัวอักษรจิ๋ว 3×5
 * แยกไฟล์เพราะภาพแต่ละกลุ่มยาวหลายร้อยบรรทัดของแผนที่พิกเซล — รวมไฟล์เดียวแก้ยากและอ่านไม่ไหว
 * สัญญา (ชื่อฟังก์ชัน/รูปทรงค่าที่คืน) อยู่ที่ไฟล์นี้ ห้ามเปลี่ยนโดยไม่แก้ scene.js ตาม
 */

export { TILE, PALETTE, MODEL_SHIRT } from "./art/base.js";
export { lookFor, poseInfo, character } from "./art/characters.js";
export { prop, paintRoomShell } from "./art/props.js";
export { icon, bubble, effect, drawTinyText } from "./art/fx.js";

import { clearCharacterCache } from "./art/characters.js";
import { clearPropCache } from "./art/props.js";
import { clearFxCache } from "./art/fx.js";

/** ทิ้งภาพที่อบไว้ทั้งหมด (เช่น หลังเปลี่ยนความละเอียดจอแบบรุนแรง หรือใน DevTools ตอนแก้ภาพ) */
export function clearCache() {
  clearCharacterCache();
  clearPropCache();
  clearFxCache();
}
