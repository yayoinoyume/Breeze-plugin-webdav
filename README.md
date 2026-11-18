# Breeze WebDAV 漫画插件

在 Breeze 里直接看 WebDAV（NAS、自建网盘、rclone serve 等）上的漫画：

- 扫描图片文件夹：目录里只要直接含有 jpg/jpeg/png/webp/gif/bmp，这个目录就算一本漫画；
- 扫描 CBZ/ZIP 整包：压缩包也能看，按中央目录取页；
- 页序按自然序（p2 在 p10 前）；
- 关键词过滤 + 分页；
- 详情页、阅读快照、按页取原图；
- 错误提示都是中文人话。

当前版本 0.1.2。PDF 不做。

## 在 Breeze 里安装

1. pnpm build，然后在仓库里起静态服务器：

   ~~~bash
   python3 -m http.server 7878 --directory dist
   ~~~

   让手机和电脑在同一局域网，确认 http://<电脑IP>:7878/breeze-plugin-webdav.bundle.cjs 可访问。
2. Breeze → 发现页 → 插件商店 → 浏览安装 → 网络安装，填入上面的 bundle 地址。
3. 进入插件设置，填服务器与扫描参数（见下一节）。
4. 发现页会出现两个入口：
   - **漫画库**：按设置扫描出的漫画列表；
   - **搜索**：Breeze 搜索页，输入关键词过滤漫画名。

   设置页通过 Breeze 的「插件设置」进入，不用单独入口。

## 设置项

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| 服务器地址 | 空 | 例如 http://192.168.1.2:5005/dav；不写协议时按 http 补 |
| 用户名 | 空 | Basic 认证用户名；用户名和密码都为空时不发认证头 |
| 密码 | 空 | Basic 认证密码 |
| 漫画库根路径 | / | 相对服务器地址的起点，例如 /comics |
| 扫描深度 | 2 | 根目录算第 0 层；最多向下几层找「没有图片的目录」 |
| 漫画数量上限 | 300 | 一次扫描最多返回多少本，避免大库卡死 |
| 收录 CBZ 整包 | 开 | 关闭后只认图片文件夹 |

扫描规则：

- 目录的直接子项里有图片 → 该目录是一本漫画，**不再向下钻**；
- 目录里没有图片 → 继续向下找，直到扫描深度用完；
- 同级的 .cbz / .zip 文件各自算一本漫画（开关打开时）；
- 关键词只过滤漫画名，大小写不敏感；每页 20 本；
- 一次扫描最多发 2000 次 PROPFIND，超过就停止并提示「结果可能不完整」；
- 扫描结果缓存 45 秒，翻页不会重新全量扫描。

## 支持 / 不支持

**支持**

- WebDAV 的 PROPFIND 列目录（通过宿主全局 __http_request_promise 发，标准 fetch 发不出 PROPFIND）；
- Basic 认证、中文 / 空格路径的百分号编码；文件名里的字面 %20 按字面量处理（% 会编码成 %25），不会二次解码；
- 图片文件夹与 CBZ/ZIP；跨站点的绝对 URL 会被拒绝，不会把认证头发到别的 host；
- CBZ 中央目录解析 + 单页流式 inflate；整包缓存按 256 MiB 总预算 LRU 逐出；
- 网盘返回 401/403、PROPFIND 405/501、宿主过旧、请求超时的中文提示。

**不支持**

- PDF（任务范围外）；
- 目录逐级钻进 UI：一本漫画就是「单章全一话」，不提供卷/话树；
- 压缩包加密；ZIP64 结构（条目数达到 65535，或单条目尺寸达到 4 GiB 时判定为 ZIP64）；
- 需要登录页 / Cookie / Token 的网盘，只支持 Basic 认证；
- 修改服务器上的文件（只读）。

## 已知限制

- **单次请求 30 秒硬超时**：宿主对每次 HTTP 请求固定 30 秒超时，插件侧改不了。图片太大或网盘太慢会失败，提示「网盘太慢或文件太大，下载超时」。
- **CBZ 要整包下载**：打开 CBZ 漫画或取它的第一张封面时，会按 Range 分块把整包拉下来（默认 8 MiB 一块），再在本地解压单页。包越大越慢、越吃内存；缓存按总字节预算 256 MiB 逐出，缓存键包含服务器地址和用户名，换账号不会串包。
- **封面也是按需取图**：列表里的封面是 wdav:// 占位地址，宿主真正加载封面时才去下载；CBZ 封面会触发整包下载。
- **下载与解压上限**：单个文件最多 256 MiB；CBZ 单页解压后最多 64 MiB，压缩比超过 1000:1 视为异常并拒绝；解压采用流式计数，中央目录谎报尺寸也会被中途截断。
- **拿不到文件长度就不下载**：HEAD 没有 Content-Length 时改用 GET Range 0-0 读 Content-Range；如果服务器忽略 Range 返回 200，这次探测本身可能已经收到整包，但插件会判定探测失败并停止，不会再把整包当长度结果，也不会再发第二次整包 GET；两样都失败会明确报「服务器不支持分块下载，也拿不到文件长度」。
- **并发抓图**：宿主默认并发 5；同一 CBZ 的多个页面共享一次整包下载（in-flight 去重）。缓存按 256 MiB 总字节预算 LRU 逐出，不按整包个数封顶。
- **最坏内存占用**：缓存 256 MiB + 在途下载最多 256 MiB（单文件上限）+ 并发页解压开销；宿主并发 5、单页解压上限 64 MiB 时，峰值可能到几百 MiB。内存紧张时少用大 CBZ 或降低宿主并发。
- **扫描广度上限**：一次扫描最多 2000 次列目录请求；超限会返回已发现结果并附带中文提示，提示会出现在列表响应 extern.scanWarning、详情描述和详情/快照的 extern 里，结果可能不完整。
- **扫描缓存**：同一套设置 45 秒内复用上次结果；刚往网盘加了漫画，最多等 45 秒再刷新。
- **密码明文保存**：密码是普通设置字段，宿主只做遮挡显示，落盘未见加密（与 Breeze 其他插件的设置一致）。
- **PROPFIND 依赖未文档化全局**：__http_request_promise 不是官方文档 API，Breeze 未来若收紧会失效。
- **运行时是 text-encoding polyfill**：Breeze 的 QuickJS 运行时替换了全局 TextDecoder，不支持 `fatal` 选项，传了会在构造时直接抛异常（Node 支持这些选项，普通用例抓不到这类环境差异，必须保留 polyfill 替身用例）。插件只使用不带选项的 UTF-8 解码，非法 UTF-8 由 U+FFFD 检查拒绝；后续维护不要给 TextDecoder/TextEncoder 传 Node 专有选项。测试里的替身见 test/support/polyfill-textdecoder.mjs。
- **图片字节不进宿主 cache**：宿主 cache 单值上限 500 KiB，图片只走模块内 LRU 或直取。

## 构建与测试

~~~bash
pnpm install
pnpm build          # typecheck + 生成 manifest + rspack 打包
pnpm test           # 构建后跑 node:test
node script/e2e-webdav.mjs
~~~

产物是 dist/breeze-plugin-webdav.bundle.cjs（CJS 单文件，依赖全部内联），同时生成根目录 manifest.json。

- script/test-webdav-server.mjs：用 node:http 手写的测试 WebDAV 服务器（Basic 认证、PROPFIND 0/1/infinity、GET/HEAD、Range）；
- script/e2e-webdav.mjs：加载打包产物，分别以 rootPath=/ 和 rootPath=/comics 跑「目录漫画 + CBZ 漫画」完整链路，最后输出 E2E PASS，带两组 dir=/cbz=。

## 代码结构

~~~text
src/
  plugin-info.ts      插件元信息与发现页入口
  plugin.ts           宿主入口 getInfo / getSettingsBundle / 业务函数
  settings.ts         设置字段 schema 与读写
  comics.ts           搜索 / 详情 / 阅读 / 取图（业务层）
  errors.ts           中文错误提示归类
  util/names.ts       自然排序、扩展名、路径小工具
  webdav/xml.ts       手写 DAV multistatus 解析
  webdav/client.ts    PROPFIND / Basic 认证 / URL 编码 / href 换算 / 跨站拦截
  webdav/scan.ts      BFS 扫描漫画
  webdav/ids.ts       漫画 id / 页面 url 的可逆编码
  zip/cbz.ts          最小 ZIP/CBZ 读取器（中央目录 + 单页解压）
  http/host.ts        __http_request_promise 封装
  http/download.ts    Range 分块下载与重试
script/
  test-webdav-server.mjs  测试用 WebDAV 服务器 + fixture
  e2e-webdav.mjs          端到端测试
test/                     单元测试与 e2e 包装
~~~

## 调试排错

| 现象 | 提示 | 原因 |
| --- | --- | --- |
| 打不开列表 | 网盘用户名或密码不对 | 401/403 |
| 打不开列表 | 这个网盘不支持列目录（PROPFIND），换一个 WebDAV 地址试试 | 405/501，或地址不是 WebDAV 根 |
| 插件完全没反应 | 当前 Breeze 版本太旧，插件用不了 | 没有 __http_request_promise |
| 图片转圈后失败 | 网盘太慢或文件太大，下载超时 | 宿主 30 秒总超时 |
