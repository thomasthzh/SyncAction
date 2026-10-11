# SyncAction 服务端

服务端安装包包含公共 API、实时协作服务、独立管理员服务、PostgreSQL 数据库模块与通用开发/容器文件，不含浏览器扩展、生产凭据、证书、数据库备份或任何私有部署配置。

## 组件与端口

| 组件                     | 默认监听                 | 作用                                               |
| ------------------------ | ------------------------ | -------------------------------------------------- |
| `@syncaction/server`     | `127.0.0.1:29373`        | 普通账号、房间、共享标签、Presence、媒体、页面协作 |
| `@syncaction/superadmin` | `127.0.0.1:29374`        | 管理员认证、账号审批、账户密钥和管理操作           |
| PostgreSQL 17            | 自行配置的本地或内部网络 | 持久化状态、事务、迁移                             |

管理员服务有独立的身份认证、TOTP、cookie 和 Origin 校验。公开版不自动创建默认管理员，也不包含任何预设密码。

## 本地启动

需要 Node.js 22.13+、pnpm 10.12.1 和 Docker。下载并解压
[v0.9.10 服务端包](https://github.com/thomasthzh/SyncAction/releases/tag/v0.9.10)，在包根目录执行：

```sh
pnpm install --frozen-lockfile
docker compose -p syncaction-local -f infra/compose.local.yml up -d --wait
```

在自己的私密终端设置
`SYNC_ACTION_ADMIN_BOOTSTRAP_USERNAME`、`SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD`（至少 12 个字符）以及自己生成的
`SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_SECRET`，然后执行一次：

```sh
pnpm local:admin:bootstrap
pnpm local:server
```

本地脚本会在当前包目录生成
`.local/runtime-secrets.json`，公共服务与管理员服务共用其中各自的密钥。此文件必须与本次部署的数据库一起妥善保留；只备份数据库不足以恢复管理员登录。

这是开发运行方式，不是已加固的公网部署模板。不要把终端密钥、生成的本地运行配置或数据库文件提交到 Git。

## 公网部署配置边界

- 使用 HTTPS 反向代理，分别转发公共服务和管理员服务；支持公共服务的 WebSocket 升级。上游仍绑定回环或可信内部网络。
- 数据库不暴露公网；管理员入口应额外限制可访问来源。
- 不要复制其他部署的密钥、默认密码或数据库。备份密钥和数据库，并验证恢复流程。
- 公开包仅提供 `infra/Dockerfile` 与本地数据库示例；生产进程管理、TLS、备份和监控由部署者配置。

公共进程所需环境变量：

| 变量                                                  | 说明                                          |
| ----------------------------------------------------- | --------------------------------------------- |
| `SYNC_ACTION_DATABASE_URL`                            | PostgreSQL 连接 URL                           |
| `SYNC_ACTION_ACCESS_TOKEN_SECRET`                     | 独立的 32 字节 base64url 密钥                 |
| `SYNC_ACTION_ANNOTATION_HMAC_KEY`                     | 独立的 32 字节 base64url 密钥，重启时保持稳定 |
| `SYNC_ACTION_PUBLIC_HOST` / `SYNC_ACTION_PUBLIC_PORT` | 默认回环与 29373                              |

管理员进程还需
`SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY`（独立的 32 字节 base64url 密钥）。生产模式必须设置
`NODE_ENV=production` 和精确的 `SYNC_ACTION_ADMIN_PUBLIC_ORIGIN`，可使用 `SYNC_ACTION_ADMIN_HOST` /
`SYNC_ACTION_ADMIN_PORT` 调整监听。完整校验以各应用的 `src/config.ts` 为准。

## 升级与兼容性

升级前备份数据库和私密环境配置；在测试环境验证迁移、登录与房间恢复后再切换服务。

使用上述本地启动方式、升级到新的解压目录时：

1. 停止旧目录中的服务进程，备份数据库及旧目录的 `.local/runtime-secrets.json`。
2. 在新目录首次运行任何本地启动或初始化命令之前，将自己旧部署的 `.local/runtime-secrets.json`
   复制到新目录相同位置。保留原有 `syncaction-local` Compose 项目和数据库卷，不要删除数据卷。
3. 安装新目录的依赖后运行
   `pnpm local:server`，验证原管理员登录与房间数据；已有数据库不需要重复初始化管理员。

不同版本的解压目录会共用固定的本地数据库，但不会自动共用密钥文件。若遗漏上述迁移，脚本会生成新密钥，导致旧管理员 TOTP 密文无法解密；再次运行管理员初始化命令也不会修复旧密文。这里仅迁移自己的原部署密钥，不应使用其他部署的密钥。

`v0.9.10`
以公开仓库的安全基线为基础，本次未增加数据库迁移或修改协议版本；客户端的玻璃和交互优化不依赖服务器升级。协议与具体功能能力仍以
`/v1/meta` 为准。

客户端只连接公共入口，管理员浏览器连接管理员入口。发布安装包不代表任何现有服务器已升级。
