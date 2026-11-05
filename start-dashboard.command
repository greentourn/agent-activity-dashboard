#!/bin/bash
# ===========================================================================
#  Agent Activity Dashboard - double-click launcher (macOS)
#
#  ดับเบิลคลิกไฟล์นี้ใน Finder = เปิด Terminal รันเซิร์ฟเวอร์ + เปิด NEURAL CORE (หน้า 3D) ให้เลย
#  ปิดหน้าต่าง Terminal (หรือกด Ctrl+C) = หยุดเซิร์ฟเวอร์
#  ถ้าเซิร์ฟเวอร์รันอยู่แล้ว ดับเบิลคลิกซ้ำจะแค่เปิดหน้าเว็บให้ ไม่รันซ้อน
#
#  ครั้งแรกถ้า macOS ไม่ยอมเปิด (ไฟล์มาจาก ZIP ที่โหลดจากเว็บ) ดูวิธีแก้ใน README หัวข้อ
#  "ดับเบิลคลิกเปิด"
# ===========================================================================

# Finder starts us in $HOME, not next to server.mjs.
cd "$(dirname "$0")" || exit 1

# ---- ตั้งค่า (แก้ได้ หรือ export เป็น environment variable ไว้ก่อนก็ได้) -------------
#  DASH_PORT : พอร์ตของเซิร์ฟเวอร์
#  DASH_ARGS : option เพิ่มเติมของ server.mjs เช่น --live-usage, --stale-minutes 60
#              (ตั้งเป็นค่าว่าง DASH_ARGS="" ถ้าไม่อยากให้ดึง % โควตาสดจาก Anthropic)
DASH_PORT="${DASH_PORT:-7676}"
DASH_ARGS="${DASH_ARGS---live-usage}"

DASH_URL="http://127.0.0.1:${DASH_PORT}/brain.html"

pause_before_close() {
  echo
  read -r -n 1 -s -p "  กดปุ่มใดก็ได้เพื่อปิดหน้าต่างนี้..."
  echo
}

# ---- ต้องมี Node.js 18+ ----------------------------------------------------------
# Terminal usually has the right PATH already, but cover Homebrew (Apple Silicon + Intel) and nvm
# in case the user's shell profile doesn't set them up for a non-interactive script.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  ไม่พบ Node.js ในเครื่อง"
  echo "  ติดตั้ง Node.js 18 ขึ้นไปจาก https://nodejs.org (หรือ brew install node) แล้วดับเบิลคลิกไฟล์นี้อีกครั้ง"
  pause_before_close
  exit 1
fi

# ---- รันอยู่แล้ว? เปิดหน้าเว็บอย่างเดียว --------------------------------------------
# /api/state มีเฉพาะ dashboard ตัวนี้ และ -f ทำให้ curl ถือว่า 404 จากโปรแกรมอื่นบนพอร์ตนี้เป็น "ไม่ใช่"
if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${DASH_PORT}/api/state"; then
  echo
  echo "  Dashboard รันอยู่แล้ว - เปิดหน้าเว็บให้: ${DASH_URL}"
  open "${DASH_URL}"
  sleep 2
  exit 0
fi

# ---- รันเซิร์ฟเวอร์ (--open เปิดเบราว์เซอร์ให้เองเมื่อพร้อม) -------------------------
# DASH_ARGS is deliberately unquoted: it is a list of options, split on spaces.
# shellcheck disable=SC2086
node server.mjs --open --port "${DASH_PORT}" ${DASH_ARGS}
status=$?

# ถึงตรงนี้ได้แปลว่าเซิร์ฟเวอร์หยุดแล้ว ถ้าหยุดเพราะ error (เช่นพอร์ตถูกโปรแกรมอื่นใช้อยู่)
# ให้ค้างหน้าต่างไว้ให้อ่านข้อความก่อน — Ctrl+C ได้ 130 จึงไม่เข้าเงื่อนไขนี้
if [ "$status" -ne 0 ] && [ "$status" -ne 130 ]; then
  echo
  echo "  เซิร์ฟเวอร์หยุดทำงานเพราะเกิดข้อผิดพลาด (ดูข้อความด้านบน)"
  echo "  ถ้าพอร์ตถูกโปรแกรมอื่นใช้อยู่ ให้เปิดไฟล์นี้ด้วย TextEdit แล้วแก้ DASH_PORT เป็นเลขอื่น"
  pause_before_close
fi
exit "$status"
