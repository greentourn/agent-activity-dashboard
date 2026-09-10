'use strict';

/**
 * tool-error-kinds.js — the single definition of "what KIND of failure was this tool call,
 * and what is the one-line fix?"
 *
 * Written as CommonJS on purpose: ESM can `require()` CJS, but a CJS consumer cannot
 * synchronously `import` an ESM module. That keeps this file usable both from
 * `server.mjs` (ESM) and from any CJS hook you may want to write against the same
 * categories, so the two can never drift apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * The categories below were not invented — they came from bucketing 736 real failed tool
 * calls (642 sub-agent transcripts + 81 main-thread transcripts, ~14.7B tokens) and then
 * attributing the tokens of each *retry* back to the failure that caused it.
 *
 * The most useful thing that fell out of it: the expensive categories are not the ones
 * that look like mistakes. Ranked by tokens actually burned:
 *
 *   ~39.3M  blocked by a guard hook   ← the guardrails themselves cost the most, so adding
 *                                       a guard "to save tokens" mostly MOVES the cost
 *   ~30M+   browser / E2E             ← stale refs, selectors that no longer match,
 *                                       strict-mode violations, timeouts
 *   ~25M    a search that found nothing ← `grep`/`ls` exiting non-zero while having already
 *                                       printed the correct answer. Not a mistake at all.
 *   ~23.8M  path does not exist
 *   ~15.2M  timeout
 *   ~5.2M   foreground `sleep`        ← blocked outright by the harness
 *
 * `fix` has to be readable inside one table cell. A category with no real fix is just
 * a complaint, so it does not get one.
 */

const ERROR_KINDS = [
  {
    id: 'hook-deny',
    label: 'guard hook บล็อก',
    fix: 'อ่านเหตุที่ guard บอกแล้วแก้ให้ถูกรอบเดียว — deny เสีย token เท่ากับ error จริง',
    test: (t) => /^\s*🔒|Work Loop guard/.test(t),
  },
  {
    id: 'browser-stale-ref',
    label: 'browser: ref เก่า / snapshot ไม่ตรง',
    fix: 'snapshot ใหม่ก่อนคลิกทุกครั้ง — ref หมดอายุเมื่อหน้าเปลี่ยน',
    test: (t) => /Ref \S+ not found in the current page snapshot/i.test(t),
  },
  {
    id: 'browser-no-match',
    label: 'browser: selector ไม่ตรงกับอะไรเลย',
    fix: 'ใช้ ref จาก snapshot หรือ role/name — เลิกเดา CSS selector',
    test: (t) => /does not match any elements/i.test(t),
  },
  {
    id: 'browser-strict',
    label: 'browser: strict mode (selector ตรงหลายตัว)',
    fix: 'จำกัดขอบเขตให้เหลือตัวเดียว (`#id` ตรง ๆ) ห้ามใช้ selector ที่คั่นด้วย comma',
    test: (t) => /strict mode violation/i.test(t),
  },
  {
    id: 'browser-other',
    label: 'browser: อื่น ๆ (timeout / หน้าถูกปิด / eval พัง)',
    fix: 'เช็คว่าหน้ายังเปิดอยู่ + รอ element ด้วย wait_for ก่อนแตะ',
    test: (t, tool) =>
      typeof tool === 'string' && (tool.indexOf('playwright') !== -1 || tool.indexOf('chrome-devtools') !== -1),
  },
  {
    id: 'sleep-blocked',
    label: '`sleep` ถูกบล็อก (harness ห้าม sleep ค้าง)',
    fix: 'รันงานยาวด้วย run_in_background แล้วรอ notification — ห้าม `sleep N; cmd`',
    test: (t) => /Blocked:\s*sleep/i.test(t),
  },
  {
    id: 'path-missing',
    label: 'path ไม่มีจริง (cwd ไม่ใช่ที่คิด)',
    fix: 'ใช้ path absolute หรือ `git -C <repo>` เสมอ',
    test: (t) => /does not exist|no such file|cannot access|Path does not exist/i.test(t),
  },
  {
    id: 'read-dir',
    label: 'Read โฟลเดอร์',
    fix: 'ใช้ Glob หาไฟล์ก่อน แล้วค่อย Read ไฟล์',
    test: (t) => /EISDIR/i.test(t),
  },
  {
    id: 'read-too-big',
    label: 'Read ไฟล์ใหญ่เกินเพดาน',
    fix: 'ใส่ `offset`/`limit` — เพดาน 25,000 โทเค็นต่อครั้ง',
    test: (t) => /exceeds maximum allowed tokens/i.test(t),
  },
  {
    id: 'shell-syntax',
    label: 'shell syntax / heredoc พัง',
    fix: 'สคริปต์ยาวเขียนเป็นไฟล์ใน scratchpad แล้ว `node <path>` — ห้าม heredoc ซ้อน quote',
    test: (t) => /unexpected EOF|syntax error near|eval: line/i.test(t),
  },
  {
    id: 'cd-unquoted',
    label: '`cd` พาธมีช่องว่างแต่ไม่ได้ quote',
    fix: 'ครอบพาธด้วย `"` เสมอ',
    test: (t) => /cd: too many arguments/.test(t),
  },
  {
    id: 'timeout',
    label: 'หมดเวลา (คำสั่งค้างจนถูกฆ่า)',
    fix: 'จำกัดขอบเขตการค้น + ใส่ `timeout` — ค้างแล้วหมดเวลาคือเสีย token เต็มโดยไม่ได้ผลอะไร',
    test: (t) => /timed out|Timeout \d+ms exceeded/i.test(t),
  },
  {
    id: 'tool-param',
    label: 'พารามิเตอร์ของ tool ผิด / schema ไม่ตรง',
    fix: 'ลอกรูปทรงจากเอกสารของ tool ห้ามเดาชื่อฟิลด์ (StructuredOutput: เขียนชื่อฟิลด์ลงในพรอมป์ต)',
    test: (t, tool) =>
      tool === 'StructuredOutput' ||
      /InputValidationError|Unrecognized key|unexpected parameter|validation_error|does not match required schema|Provide either/i.test(
        t,
      ),
  },
  {
    id: 'edit-no-match',
    label: 'Edit: หา old_string ไม่เจอ',
    fix: 'Read ไฟล์จริงก่อนแก้ทุกครั้ง — อย่าเชื่อว่าไฟล์หน้าตาแบบที่จำไว้',
    test: (t) => /String to replace not found/i.test(t),
  },
  {
    id: 'user-rejected',
    label: 'ผู้ใช้กดปฏิเสธ',
    fix: '—',
    test: (t) => /user doesn't want to proceed|tool use was rejected/i.test(t),
  },
];

/** คำสั่งที่ "ไม่เจอของ" แล้วคืน exit ไม่ 0 เป็นเรื่องปกติ ไม่ใช่ความผิดพลาด */
const SEARCHY_CMD = /\b(grep|rg|egrep|fgrep|find|ls|test|diff|cmp)\b/;

/** ท้ายคำสั่งที่กัน exit code ไว้แล้ว */
const EXIT_GUARDED = /\|\|\s*true|\|\|\s*:|\|\|\s*echo|;\s*true\s*$|--quiet|-q\b/;

/**
 * เครื่องมือบ่นออกมาเป็นข้อความ = พลาดจริง ไม่ใช่ "ค้นแล้วไม่เจอ"
 *
 * เจอตอนทดสอบฟีเจอร์นี้เอง: `grep: -P supports only unibyte and UTF-8 locales` ถูกจัดเป็น "ไม่เจอ"
 * เพราะคำสั่งมีคำว่า `grep` และไม่มี `|| true` ⇒ ระบบจะแนะนำให้เติม `|| true` ซึ่ง **จะกลบ error
 * จริง** — คำแนะนำที่ผิดแย่กว่าไม่แนะนำอะไรเลย · `<ชื่อคำสั่ง>: <ข้อความ>` คือรูปแบบมาตรฐานของ
 * stderr ฝั่ง POSIX จึงใช้เป็นตัวแยกได้
 */
const TOOL_COMPLAINT =
  /(^|\n)\s*(grep|rg|ripgrep|ls|find|sed|awk|cat|head|tail|cp|mv|rm|git|node|npm|pnpm|tr|sort|xargs|bash|sh):\s\S/;

/**
 * จัดหมวด failure หนึ่งตัว
 *
 * @param {string} tool ชื่อ tool ที่ล้มเหลว
 * @param {string} text ข้อความ error ที่ได้กลับมา
 * @param {string} cmd  คำสั่ง/pattern ที่ส่งเข้า tool (ใช้แยก "ค้นไม่เจอ" ออกจาก "พลาดจริง")
 * @returns {{id:string,label:string,fix:string}}
 */
function classifyError(tool, text, cmd) {
  const t = String(text || '');
  for (const kind of ERROR_KINDS) {
    if (kind.test(t, tool)) return { id: kind.id, label: kind.label, fix: kind.fix };
  }
  const m = /^Exit code (\d+)/.exec(t);
  if (m) {
    const c = String(cmd || '');
    /*
     * หมวดที่สำคัญที่สุดและเดาไม่ถูกที่สุด: `grep`/`ls`/`find` คืน exit ไม่ 0 เมื่อ **ไม่เจอของ**
     * ซึ่งเป็นผลลัพธ์ที่ถูกต้อง แต่ harness ตี tool_result นั้นเป็น `is_error` ⇒ โมเดลเสีย request
     * เต็ม ๆ ไปกับคำสั่งที่ตอบคำถามไปแล้ว
     *
     * หลักฐานจากของจริง: `ls node_modules/next/dist/bin/next 2>/dev/null && echo "FOUND root next"`
     * พิมพ์ทั้งพาธและคำว่า `FOUND root next` ออกมาครบ แล้ว exit 2 ⇒ เสีย 237,000 โทเค็น
     */
    if (SEARCHY_CMD.test(c) && !EXIT_GUARDED.test(c) && !TOOL_COMPLAINT.test(t)) {
      return {
        id: 'search-not-found',
        label: 'คำสั่งค้นไม่เจอ → exit ' + m[1] + ' (คำสั่งทำงานถูกแล้ว)',
        fix: 'ปิดท้ายด้วย `|| true` — ผลลัพธ์ที่ได้มาถูกอยู่แล้ว ไม่ต้องสั่งใหม่',
      };
    }
    if (TOOL_COMPLAINT.test(t)) {
      return {
        id: 'cmd-complained',
        label: 'คำสั่งบ่นออกมาเอง → exit ' + m[1] + ' (พลาดจริง)',
        fix: 'อ่านบรรทัดที่เครื่องมือบ่นแล้วแก้ตามนั้น — ห้ามกลบด้วย `|| true`',
      };
    }
    return {
      id: 'exit-' + m[1],
      label: 'exit code ' + m[1],
      fix: 'อ่าน stderr ก่อนสั่งใหม่ — บางครั้งคำสั่งสำเร็จแล้ว',
    };
  }
  return { id: 'other', label: 'อื่น ๆ', fix: '—' };
}

/**
 * คำสั่งนี้ "เติม `|| true` ได้อย่างปลอดภัย" ไหม
 *
 * แยกออกมาเป็นฟังก์ชันเพราะเป็นการตัดสินใจเดียวกับที่ `classifyError` ใช้ตัดสินหมวด
 * `search-not-found` ⇒ ถ้าปล่อยให้แต่ละที่เขียนเงื่อนไขเอง มันจะเพี้ยนออกจากกันแน่นอน
 *
 * ⚠️ ตอบ `false` เมื่อไม่ชัด: การเติม `|| true` ผิดที่จะ **กลบ error จริง** ซึ่งแย่กว่าการปล่อยให้
 * error โผล่ตามปกติ
 */
function canGuardExitCode(cmd) {
  const c = String(cmd || '');
  if (!c.trim()) return false;
  if (!SEARCHY_CMD.test(c)) return false;
  if (EXIT_GUARDED.test(c)) return false;
  // คำสั่งที่เปลี่ยนสถานะอะไรก็ตาม ห้ามกลบ exit code เด็ดขาด — exit code คือสัญญาณเดียวที่บอกว่าพัง
  if (/\b(rm|mv|cp|git|npm|pnpm|node|curl|psql|docker|kill|chmod|chown|tee|dd)\b/.test(c)) return false;
  if (/>\s*\S|>>\s*\S/.test(c)) return false;
  return true;
}

module.exports = {
  ERROR_KINDS,
  SEARCHY_CMD,
  EXIT_GUARDED,
  TOOL_COMPLAINT,
  classifyError,
  canGuardExitCode,
};
