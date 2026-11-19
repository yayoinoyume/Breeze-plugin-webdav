# Breeze WebDAV 漫画插件

在 Breeze 里直接看 WebDAV（NAS、自建网盘、rclone serve 等）上的漫画：

- 扫描图片文件夹：目录里只要直接含有 jpg/jpeg/png/webp/gif/bmp，这个目录就算一本漫画；
- 扫描 CBZ/ZIP 整包：只读压缩包尾部索引（EOCD/中央目录），翻到哪页才拉哪页的字节；
- 页序按自然序（p2 在 p10 前）；
- 关键词过滤 + 分页；
- 详情页、阅读快照、按页取原图；
- 错误提示都是中文人话。

当前版本 0.3.0。PDF 不做。

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
- 同一层的目录并发 4 个（上限 8）列目录，结果顺序仍按服务器返回顺序拼接，和串行完全一致；
- 一次扫描最多发 2000 次 PROPFIND，超过就停止并提示「结果可能不完整」；
- 扫描结果缓存 45 秒，翻页不会重新全量扫描。

## 支持 / 不支持

**支持**

- WebDAV 的 PROPFIND 列目录（通过宿主全局 __http_request_promise 发，标准 fetch 发不出 PROPFIND）；
- Basic 认证、中文 / 空格路径的百分号编码；文件名里的字面 %20 按字面量处理（% 会编码成 %25），不会二次解码；
- 图片文件夹与 CBZ/ZIP；跨站点的绝对 URL 会被拒绝，不会把认证头发到别的 host；
- CBZ 中央目录解析 + 单页流式 inflate；支持 HTTP Range 的服务器上只按需拉单页字节，中央目录在内存里缓存（几十 KB），整包缓存只在回退时使用并按 256 MiB 总预算 LRU 逐出；
- 网盘返回 401/403、PROPFIND 405/501、宿主过旧、请求超时的中文提示。

**不支持**

- PDF（任务范围外）；
- 目录逐级钻进 UI：一本漫画就是「单章全一话」，不提供卷/话树；
- 压缩包加密；ZIP64 结构（条目数达到 65535，或单条目尺寸达到 4 GiB 时判定为 ZIP64）；
- 需要登录页 / Cookie / Token 的网盘，只支持 Basic 认证；
- 修改服务器上的文件（只读）。

## 构建与测试

~~~bash
pnpm install
pnpm build          # typecheck + 生成 manifest + rspack 打包
pnpm test           # 构建后跑 node:test
node script/e2e-webdav.mjs
~~~

产物是 dist/breeze-plugin-webdav.bundle.cjs（CJS 单文件，依赖全部内联），同时生成根目录 manifest.json。

- script/test-webdav-server.mjs：用 node:http 手写的测试 WebDAV 服务器（Basic 认证、PROPFIND 0/1/infinity、GET/HEAD、Range）；
- script/e2e-webdav.mjs：加载打包产物，分别以 rootPath=/ 和 rootPath=/comics 跑「目录漫画 + CBZ 漫画」完整链路，报告 CBZ 首屏下载字节数，最后输出 E2E PASS，带两组 dir=/cbz=。

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
  zip/cbz.ts          最小 ZIP/CBZ 读取器（中央目录 + 单页解压 + CRC）
  zip/remote-zip.ts   远程 CBZ：Range 读 EOCD / 中央目录 / 单页字节
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
