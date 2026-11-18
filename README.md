# Breeze WebDAV 漫画插件

在 Breeze 里浏览 WebDAV 服务器（NAS、自建网盘）上的漫画：列目录、按页取图、整包下载 CBZ。

当前版本 `0.1.0` **只包含骨架与核心网络层**，已经能被 Breeze 加载并显示设置页；搜索、详情、阅读等业务函数在后续任务补。

## 为什么需要单独的网络层

Breeze 插件跑在 QuickJS 里，没有 Node API、没有文件系统，而且：

- 标准 `fetch` 的方法白名单只有 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，**发不出 WebDAV 的 PROPFIND**；
- 宿主全局 `__http_request_promise` 不做方法白名单，可以发任意方法，响应体放在 native buffer 里；
- 单次请求总超时固定 30 秒，所以大文件必须按 Range 分块下载（默认 8 MiB 一块）。

本插件的 `src/webdav` 与 `src/http` 就是围绕这三条约束实现的。

## 构建

```bash
pnpm install
pnpm build
ls -la dist/*.bundle.cjs
```

产物是 `dist/breeze-plugin-webdav.bundle.cjs`（CJS 单文件，依赖全部内联），同时生成 `manifest.json`。

## 测试

```bash
pnpm test                  # 单测 + 端到端（会先构建）
node script/e2e-webdav.mjs # 只跑端到端，成功时输出一行 E2E PASS
```

`script/test-webdav-server.mjs` 是一个用 `node:http` 手写的测试 WebDAV 服务器（Basic 认证、PROPFIND 0/1/infinity、GET/HEAD、Range），fixture 在脚本内生成，不依赖 rclone 或任何系统软件。

## 在 Breeze 里安装（调试方式）

1. `pnpm build`，然后在仓库里起一个静态服务器：
   ```bash
   python3 -m http.server 7878 --directory dist
   ```
   把手机和电脑放在同一局域网，确保 `http://<电脑IP>:7878/breeze-plugin-webdav.bundle.cjs` 可访问。
2. Breeze → 发现页 → 插件商店 → 浏览安装 → 网络安装，填入上面的 bundle 地址。
3. 进入插件设置，填写：
   - 服务器地址，例如 `http://192.168.1.2:5005/dav`
   - 用户名 / 密码
   - 漫画库根路径（默认 `/`）
   - 扫描深度（默认 2）、漫画数量上限（默认 300）、是否收录 CBZ
4. 调试时也可以在插件设置里打开调试模式填同一个地址。

## 目录结构

```
src/
  plugin-info.ts      插件元信息（uuid / 版本 / npm 名）
  plugin.ts           宿主入口 getInfo / getSettingsBundle
  settings.ts         设置字段 schema 与读写
  webdav/xml.ts       手写 DAV multistatus 解析
  webdav/client.ts    PROPFIND / Basic 认证 / URL 编码
  http/host.ts        __http_request_promise 封装
  http/download.ts    Range 分块下载与重试
script/
  test-webdav-server.mjs  测试用 WebDAV 服务器 + fixture
  e2e-webdav.mjs          端到端测试
test/                     单元测试与 e2e 包装
```

## 已知限制

- 单次 HTTP 请求受宿主 30 秒总超时限制；超大 CBZ 依赖分块，但单块仍要能在 30 秒内下完。
- PROPFIND 依赖未文档化的宿主全局 `__http_request_promise`，Breeze 未来若收紧会失效。
- 宿主 cache 单值上限 500 KiB，图片字节不进 cache（后续业务用模块内 LRU 或 native 池）。
- 不实现 PDF；不调用 `importLocalComic`。
