# SyncAction

<p align="center">
  <img src="design/brand/syncaction-symbol.svg" width="96" height="96" alt="SyncAction logo">
</p>

SyncAction 是面向 Chrome 与 Edge 的多人共享浏览器工作区。成员可以在侧栏中创建房间、共享标签页、查看同伴所在页面、同步播放媒体；获得用户同意和浏览器对当前网站的授权后，还能使用同页光标、弹幕与画笔。

本仓库提供 MIT 许可源码和独立的 Chrome、Edge 客户端及自托管服务端安装包。此前私有版本的历史和生产运维配置没有迁入。公开版默认服务器
`https://syncaction.example.com`
是占位地址，安装后请在扩展顶栏配置实际服务器；服务端必须自行初始化管理员，不含默认账号密码。

## v0.9.11 下载

从 [v0.9.11 Release](https://github.com/thomasthzh/SyncAction/releases/tag/v0.9.11) 下载：

| 资产                                                                                                                     | 用途                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [Chrome 客户端](https://github.com/thomasthzh/SyncAction/releases/download/v0.9.11/SyncAction-client-chrome-v0.9.11.zip) | 解压后在 Chrome 加载扩展                       |
| [Edge 客户端](https://github.com/thomasthzh/SyncAction/releases/download/v0.9.11/SyncAction-client-edge-v0.9.11.zip)     | 解压后在 Edge 加载扩展                         |
| [服务端](https://github.com/thomasthzh/SyncAction/releases/download/v0.9.11/SyncAction-server-v0.9.11.tar.gz)            | 公共服务、管理员服务、数据库模块和通用部署源码 |
| [SHA256SUMS.txt](https://github.com/thomasthzh/SyncAction/releases/download/v0.9.11/SHA256SUMS.txt)                      | 三个安装资产的 SHA-256 校验值                  |

安装与升级分别见[客户端指南](https://github.com/thomasthzh/SyncAction/blob/v0.9.11/docs/client.md)、[服务端指南](docs/server.md)，变更见[发布说明](docs/releases/v0.9.11.md)。客户端 ZIP 不是浏览器商店安装包；服务端 tarball 不含客户端。

### 本版变化

- 新安装先验证并连接实际服务器；注册待批准、批准后登录与入房目标续接有明确入口。
- 空播放组提供“开始一起看”，串联页面分享、网站同意与有效媒体建组；失败可重试，切换上下文会作废旧意图。
- 慢业务请求期间仍可读取最近已提交的侧栏状态，状态读取不触发存储写入。

- 320–480px 紧凑侧栏采用真实边缘折射、局部高光和轻量流线背景；玻璃层不扭曲文字与按钮。
- 房间、页面搜索、成员跟随和高频操作保留在主界面；窄屏仍显示“分享当前页”。
- 表单提供就地规则、错误焦点、密码显隐和重复提交保护；操作反馈不会串到其他服务器或房间。
- 关闭侧栏后停止无消费者的 UI 状态投影，重新打开时恢复最新快照。
- 减少透明度、减少动画和强制颜色偏好均有适配；无外部字体或视觉资源请求。

## 功能与边界

- 房间、共享标签页和操作日志保存在 PostgreSQL；浏览器重连后可从房间快照恢复。
- 客户端用 logical tab ID、ACK、effect ledger、熔断与人工确认保护个人标签页。
- 房间支持公开加入、申请加入、邀请、消息通知和多个同步播放组。
- 页面协作按服务器和精确网站分别征得同意与浏览器权限，不上传 DOM、表单内容或截图。
- 管理员服务用于账号审批与配额管理，公共服务与管理员入口应分别部署并限制网络访问。

## 目录

| 路径              | 内容                                           |
| ----------------- | ---------------------------------------------- |
| `apps/extension`  | Chrome / Edge Manifest V3 扩展与 Side Panel    |
| `apps/server`     | 公共 HTTP 与实时协作服务                       |
| `apps/superadmin` | 管理员服务与界面                               |
| `packages`        | 协议、账号、房间、同步、副本、媒体和数据库模块 |
| `design/brand`    | 原创标识及可重生成的扩展图标源文件             |
| `infra`           | 通用容器镜像与本地测试数据库示例               |

## 本地开发（完整源码仓库）

以下客户端构建命令仅适用于完整源码仓库。服务端压缩包不含客户端源码或客户端构建命令，独立启动和升级请直接按[服务端指南](docs/server.md)操作。

需要 Node.js 22.13+、pnpm 10.12.1 和 Docker。安装依赖并启动本地数据库：

```sh
pnpm install --frozen-lockfile
docker compose -p syncaction-local -f infra/compose.local.yml up -d --wait
```

空数据库不会自动创建默认管理员。请在**本机私密终端**中设置
`SYNC_ACTION_ADMIN_BOOTSTRAP_USERNAME`、`SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD`（至少 12 个字符）和
`SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_SECRET`（个人生成的 TOTP 密钥），然后执行一次：

```sh
pnpm local:admin:bootstrap
pnpm local:server
```

本地公共服务与管理员服务分别监听回环地址 `127.0.0.1:29373` 和
`127.0.0.1:29374`。另开终端构建客户端：

```sh
pnpm local:client:chrome
pnpm local:client:edge
```

本地构建预先声明本地公共服务的浏览器权限，安装后仍需在扩展顶栏添加并选择
`http://127.0.0.1:29373`。`WXT_PUBLIC_SERVER_URL`
目前只影响构建权限、输出目录及页面协作排除地址，不会更改运行时默认服务器配置；新安装仍以
`https://syncaction.example.com`
占位。自行部署时同样要在顶栏选择实际 HTTPS 公共服务，并按自己的网络边界配置服务端。不要把管理员服务或数据库直接暴露到公网。

## 检查

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

集成测试需要可用的本地 PostgreSQL 测试实例，CI 配置见
`.github/workflows/ci.yml`。构建产物、运行时凭据和本地数据库状态均不在本仓库中。

## 许可

仓库内原创源码与项目自制标识使用 [MIT License](LICENSE)。外部依赖遵循各自许可证，详见各包声明与
`pnpm-lock.yaml`。
