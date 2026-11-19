/**
 * 扫描并行（T46-PERF-ED / D）单元测试。
 *
 * 用带延迟的假 lister 观察「同层并发」：并发数、顺序、预算与跳过计数
 * 都必须与串行基线（concurrency: 1）一致。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { scanComicsDetailed } from "../src/webdav/scan.ts";

function isDirName(name) {
  return !/\.(png|jpe?g|webp|gif|bmp|cbz|zip)$/i.test(name);
}

function makeLister(tree, options = {}) {
  const state = { inFlight: 0, maxInFlight: 0, calls: [] };
  const delayMs = typeof options.delayMs === "number" ? options.delayMs : 2;
  const failing = new Set(options.failing ?? []);
  const blocked = new Set(options.blocked ?? []);

  const lister = {
    async list(input) {
      state.calls.push(input);
      state.inFlight += 1;
      if (state.inFlight > state.maxInFlight) {
        state.maxInFlight = state.inFlight;
      }
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (failing.has(input)) {
          throw new Error("HTTP 403 forbidden：" + input);
        }
        const names = tree[input];
        if (names === undefined) {
          throw new Error("测试树里没有这个目录：" + input);
        }
        return names.map((name) => ({
          href:
            "/dav" +
            (input === "/" ? "" : input) +
            "/" +
            encodeURIComponent(name) +
            (isDirName(name) ? "/" : ""),
          isCollection: isDirName(name),
          contentLength: isDirName(name) ? null : 10,
          lastModified: null
        }));
      } finally {
        state.inFlight -= 1;
      }
    },
    relativePath(href) {
      const path = decodeURIComponent(String(href).replace(/^\/dav/, "")).replace(/\/$/, "");
      return path === "" ? "/" : path;
    },
    canRequest(path) {
      return !blocked.has(path);
    }
  };

  return { state, lister };
}

const NESTED_TREE = {
  "/": ["系列A", "系列B", "系列C", "系列D", "整包1.cbz", "说明.txt"],
  "/系列A": ["第 1 卷"],
  "/系列A/第 1 卷": ["2.png", "10.png"],
  "/系列B": ["cover.png"],
  "/系列C": ["1.png", "2.png"],
  "/系列D": ["页一.png"]
};

function summarise(result) {
  return {
    comics: result.comics.map((comic) => [comic.kind, comic.path, comic.name, comic.coverImagePath ?? null]),
    warning: result.warning,
    skippedEntries: result.skippedEntries
  };
}

test("scan-parallel-inflight 同一层的列目录请求确实并发，且在飞数不超过 8", async () => {
  const a = makeLister(NESTED_TREE);
  const parallel = await scanComicsDetailed(a.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    concurrency: 4
  });
  assert.ok(a.state.maxInFlight >= 2, "同层应并发，实际最大在飞 " + a.state.maxInFlight);
  assert.ok(a.state.maxInFlight <= 8, "在飞数不得超过 8，实际 " + a.state.maxInFlight);
  assert.ok(
    a.state.maxInFlight <= 4,
    "并发 4 时在飞数不应超过 4，实际 " + a.state.maxInFlight
  );
  assert.ok(parallel.comics.length >= 4, "应扫出多本漫画，实际 " + parallel.comics.length);

  const serial = makeLister(NESTED_TREE);
  await scanComicsDetailed(serial.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    concurrency: 1
  });
  assert.equal(serial.state.maxInFlight, 1, "串行基线的最大在飞数应为 1");

  const capped = makeLister(NESTED_TREE);
  await scanComicsDetailed(capped.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    concurrency: 99
  });
  assert.ok(capped.state.maxInFlight <= 8, "并发上限应为 8，实际 " + capped.state.maxInFlight);
});

test("scan-parallel-order 并发后的列表顺序与串行基线逐项一致", async () => {
  const serial = makeLister(NESTED_TREE);
  const serialResult = await scanComicsDetailed(serial.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    concurrency: 1
  });

  const parallel = makeLister(NESTED_TREE, { delayMs: 5 });
  const parallelResult = await scanComicsDetailed(parallel.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    concurrency: 4
  });

  assert.deepEqual(summarise(parallelResult), summarise(serialResult), "顺序与内容必须与串行一致");
  assert.equal(parallelResult.listCalls, serialResult.listCalls, "请求数不应因并发改变");
  assert.equal(parallelResult.listCalls, serial.state.calls.length);
});

test("scan-parallel-budget maxListCalls / maxComics / 跳过计数与串行一致", async () => {
  const wide = { "/": [] };
  for (let index = 1; index <= 10; index += 1) {
    wide["/"].push("漫画" + index);
    wide["/漫画" + index] = ["001.png"];
  }

  const serial = makeLister(wide);
  const serialResult = await scanComicsDetailed(serial.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxListCalls: 3,
    concurrency: 1
  });
  const parallel = makeLister(wide, { delayMs: 3 });
  const parallelResult = await scanComicsDetailed(parallel.lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxListCalls: 3,
    concurrency: 4
  });

  assert.equal(serialResult.listCalls, 3);
  assert.equal(parallelResult.listCalls, 3, "预算不得因并发被突破");
  assert.deepEqual(summarise(parallelResult), summarise(serialResult));
  assert.match(String(parallelResult.warning), /目录太多.*上限 3 次/);

  const archives = {
    "/": ["1.cbz", "2.cbz", "3.cbz", "4.cbz", "5.cbz"]
  };
  const cappedSerial = await scanComicsDetailed(makeLister(archives).lister, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxComics: 3,
    concurrency: 1
  });
  const cappedParallel = makeLister(archives).lister;
  const cappedParallelResult = await scanComicsDetailed(cappedParallel, {
    rootPath: "/",
    scanDepth: 2,
    includeCbz: true,
    maxComics: 3,
    concurrency: 4
  });
  assert.equal(cappedParallelResult.comics.length, 3);
  assert.deepEqual(summarise(cappedParallelResult), summarise(cappedSerial));

  const dirty = {
    "/": ["好目录", "坏目录", "坏图.png"],
    "/好目录": ["001.png"],
    "/坏目录": ["001.png"]
  };
  const dirtySerial = await scanComicsDetailed(
    makeLister(dirty, { failing: ["/坏目录"], blocked: ["/坏图.png"] }).lister,
    { rootPath: "/", scanDepth: 2, includeCbz: true, concurrency: 1 }
  );
  const dirtyParallel = await scanComicsDetailed(
    makeLister(dirty, { failing: ["/坏目录"], blocked: ["/坏图.png"] }).lister,
    { rootPath: "/", scanDepth: 2, includeCbz: true, concurrency: 4 }
  );
  assert.equal(dirtyParallel.skippedEntries, 2, "坏图 + 失败目录各计一次");
  assert.deepEqual(summarise(dirtyParallel), summarise(dirtySerial));
  assert.match(String(dirtyParallel.warning), /无法安全读取/);
});
