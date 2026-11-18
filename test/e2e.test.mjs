import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("e2e 编译后的 bundle 对测试 WebDAV 服务器端到端", () => {
  const result = spawnSync(process.execPath, ["script/e2e-webdav.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /^E2E PASS /);
});
