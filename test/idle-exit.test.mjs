// ทดสอบ `--idle-exit <วินาที>` ของ server.mjs — ตัวที่ทำให้ "ปิดหน้าเว็บครบทุกหน้า = เซิร์ฟเวอร์หยุดเอง"
// (ไฟล์ดับเบิลคลิก start-dashboard.bat / .command เปิดใช้ตัวนี้)
//
// รันเซิร์ฟเวอร์จริงเป็น child process แล้วใช้การเชื่อมต่อ /api/stream แทน "แท็บเบราว์เซอร์" หนึ่งแท็บ
// HOME/USERPROFILE ชี้ไปโฟลเดอร์ว่างชั่วคราว เทสต์จึงไม่ไปอ่าน ~/.claude จริงของเครื่อง
// ใช้ --idle-exit 2 ให้ทั้งไฟล์จบใน ~10 วิ (ค่าที่ไฟล์ดับเบิลคลิกใช้จริงคือ 30)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const IDLE_SECONDS = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start server.mjs and resolve once it prints its banner (i.e. it is listening). */
async function startServer(extraArgs) {
  const home = mkdtempSync(join(tmpdir(), "aad-idle-"));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, "--port", String(port), ...extraArgs], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + 10_000;
  while (!out.includes("Ctrl+C to stop")) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`);
    if (Date.now() > deadline) throw new Error(`server never became ready:\n${out}`);
    await sleep(50);
  }
  return {
    port,
    exited,
    output: () => out,
    isRunning: () => child.exitCode === null,
    stop() {
      if (child.exitCode === null) child.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** One SSE connection = one open browser page. Resolves after the first frame arrives. */
function openPage(port) {
  return new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/api/stream`, (res) => {
      res.once("data", () => resolve({ close: () => req.destroy() }));
    });
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
  });
}

/** Resolves to the exit code, or to "still running" if the process outlives `ms`. */
const exitWithin = (server, ms) => Promise.race([server.exited, sleep(ms).then(() => "still running")]);

test("--idle-exit: never armed before the first page connects (browser may still be launching)", async () => {
  const server = await startServer(["--idle-exit", String(IDLE_SECONDS)]);
  try {
    assert.equal(await exitWithin(server, (IDLE_SECONDS + 1) * 1000), "still running");
  } finally {
    server.stop();
  }
});

test("--idle-exit: a page reopened inside the window cancels the countdown, closing the last page stops the server", async () => {
  const server = await startServer(["--idle-exit", String(IDLE_SECONDS)]);
  try {
    // reload / switching between the 3D, Pixel and Classic views = disconnect then reconnect quickly
    const first = await openPage(server.port);
    first.close();
    await sleep(500);
    const second = await openPage(server.port);
    assert.equal(
      await exitWithin(server, (IDLE_SECONDS + 1) * 1000),
      "still running",
      "a page is open again, so the server must keep running",
    );

    // the last page goes away -> the server stops on its own, cleanly (exit 0 = launcher window just closes)
    second.close();
    const code = await exitWithin(server, (IDLE_SECONDS + 3) * 1000);
    assert.equal(code, 0, `expected a clean exit, got ${code}\n${server.output()}`);
  } finally {
    server.stop();
  }
});

test("without --idle-exit the server keeps running after the last page closes (default unchanged)", async () => {
  const server = await startServer([]);
  try {
    const page = await openPage(server.port);
    page.close();
    assert.equal(await exitWithin(server, (IDLE_SECONDS + 1) * 1000), "still running");
  } finally {
    server.stop();
  }
});
