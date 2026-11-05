@echo off
rem UTF-8 first, so every line below (Thai comments and messages) is read correctly.
chcp 65001 >nul
rem ===========================================================================
rem  Agent Activity Dashboard - double-click launcher (Windows)
rem
rem  ดับเบิลคลิกไฟล์นี้ = รันเซิร์ฟเวอร์ + เปิด NEURAL CORE (หน้า 3D) ในเบราว์เซอร์ให้เลย
rem  ปิดหน้าต่างดำนี้ (หรือกด Ctrl+C) = หยุดเซิร์ฟเวอร์
rem  ถ้าเซิร์ฟเวอร์รันอยู่แล้ว ดับเบิลคลิกซ้ำจะแค่เปิดหน้าเว็บให้ ไม่รันซ้อน
rem ===========================================================================
setlocal
title Agent Activity Dashboard
cd /d "%~dp0"

rem ---- ตั้งค่า (แก้ได้ หรือกำหนดเป็น environment variable ไว้ก่อนก็ได้) ----------
rem  DASH_PORT : พอร์ตของเซิร์ฟเวอร์
rem  DASH_ARGS : option เพิ่มเติมของ server.mjs เช่น --live-usage, --stale-minutes 60
rem              (ใส่ DASH_ARGS เป็นค่าว่างถ้าไม่อยากให้ดึง % โควตาสดจาก Anthropic)
if not defined DASH_PORT set "DASH_PORT=7676"
if not defined DASH_ARGS set "DASH_ARGS=--live-usage"

set "DASH_URL=http://127.0.0.1:%DASH_PORT%/brain.html"

rem ---- ต้องมี Node.js 18+ --------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ไม่พบ Node.js ในเครื่อง
  echo   ติดตั้ง Node.js 18 ขึ้นไปจาก https://nodejs.org แล้วดับเบิลคลิกไฟล์นี้อีกครั้ง
  echo.
  pause
  exit /b 1
)

rem ---- รันอยู่แล้ว? เปิดหน้าเว็บอย่างเดียว ------------------------------------------
rem  /api/state มีเฉพาะ dashboard ตัวนี้ และ -f ทำให้ curl ถือว่า 404 จากโปรแกรมอื่นบนพอร์ตนี้เป็น "ไม่ใช่"
curl.exe -sf -o nul --max-time 2 "http://127.0.0.1:%DASH_PORT%/api/state" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   Dashboard รันอยู่แล้ว - เปิดหน้าเว็บให้: %DASH_URL%
  start "" "%DASH_URL%"
  timeout /t 3 >nul 2>nul
  exit /b 0
)

rem ---- รันเซิร์ฟเวอร์ (--open เปิดเบราว์เซอร์ให้เองเมื่อพร้อม) -----------------------
node server.mjs --open --port %DASH_PORT% %DASH_ARGS%

rem  ถึงตรงนี้ได้แปลว่าเซิร์ฟเวอร์หยุดแล้ว ถ้าหยุดเพราะ error (เช่นพอร์ตถูกโปรแกรมอื่นใช้อยู่)
rem  ให้ค้างหน้าต่างไว้ให้อ่านข้อความก่อน — Ctrl+C ได้ exit code ติดลบ จึงไม่เข้าเงื่อนไขนี้
if %errorlevel% gtr 0 (
  echo.
  echo   เซิร์ฟเวอร์หยุดทำงานเพราะเกิดข้อผิดพลาด ^(ดูข้อความด้านบน^)
  echo   ถ้าพอร์ตถูกโปรแกรมอื่นใช้อยู่ ให้เปิดไฟล์นี้ด้วย Notepad แล้วแก้ DASH_PORT เป็นเลขอื่น
  pause
)
endlocal
