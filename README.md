# SyncAction

<p align="center">
  <img src="design/brand/syncaction-symbol.svg" width="96" height="96" alt="SyncAction logo">
</p>

SyncAction 是面向 Chrome 与 Edge 的多人共享浏览器工作区。成员可以在侧栏中创建房间、共享标签页、查看同伴所在页面、同步播放媒体；获得用户同意和浏览器对当前网站的授权后，还能使用同页光标、弹幕与画笔。

本仓库提供可审阅、可自行构建的源码。此前私有版本的安装包、发布历史和生产运维配置没有迁入；当前仓库没有可下载的预编译 Release。构建自己的服务与扩展时，请先配置自己的服务器地址和管理员身份。

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

## 本地开发

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

本地构建会将扩展绑定到本地公共服务。普通源码构建中的 `syncaction.example.com`
只是占位域名；自行部署时通过 `WXT_PUBLIC_SERVER_URL`
指向自己的 HTTPS 服务，并按自己的网络边界配置服务端。不要把管理员服务或数据库直接暴露到公网。

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
