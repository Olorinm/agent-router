# 用 CLI 开通云端 Agent

[English](cloud-environments.md) | [简体中文](cloud-environments.zh-CN.md)

登录 Router 后，选择服务器提供的环境方案，就能创建 Agent、分配云环境、自动启动 Host 并绑定起来。聊天平台按需连接。

```sh
agent-router login @alice:agents.example
agent-router setup-options
agent-router setup helper --environment cloud-codex
agent-router channel-connect feishu
agent-router setup-check
```

`cloud-codex` 是运营者配置的方案名，内核可以换成 Host 支持的其他 Agent。平台也可以选择微信、Telegram、邮件或 Matrix。开通成功表示 Host 和本地运行条件已经就绪；模型授权是否有效，仍需原生检查或发送一次真实任务确认。

```sh
agent-router environment-status        # 查看开通进度
agent-router environment-pause         # 暂停
agent-router environment-resume        # 恢复原环境
agent-router environment-reconcile     # 检查并接续中断的开通
agent-router environment-destroy       # 销毁环境
```

已创建的 Agent 可以用 `environment-create 方案名` 分配环境。加 `--no-wait` 会立即返回进度。断开 CLI 不会取消开通，重复申请也不会买第二台机器。创建响应丢失时，会按已保存的操作标识查找；查不到或找到多个，由运营者核实，不自动重建。

暂停和销毁前会检查任务，正在执行或结果不明时不继续。恢复使用原环境 ID 和会话绑定。环境被销毁或过期后，需要明确创建新 Agent；旧 Router 对话记录仍保留。云厂商保留的快照需单独清理。

运营者先完成一次服务器配置：

1. 安装配套的环境模块和支持 `--ready-file` 的 Host。相关 PR 已合并，需从配套版本构建安装包；旧 Host 安装包没有这个参数，目前不假设已有 npm 发布。
2. 配置已有的阿里云或火山沙箱服务、镜像模板、原生运行时和持久化目录。模板启动 Host，Host 等配置完整后才监听。
3. 将[环境方案](../../examples/cloud-environments/environments.json)和 [Host 配置](../../examples/cloud-environments/host-profile.json)放在服务器私有目录。按用户设置 `owners`，明确填 `"*"` 才对所有注册账号开放。用户自己的原生授权文件通过 `files` 注入，不能打包进共享镜像。云服务密钥只保留在 Router。
4. 用 `onboarding:init --environments-file` 生成开通配置，设置 `AGENT_ROUTER_ONBOARDING_FILE` 后重启 Router。

Router 会保存“账号 → Agent → 环境 → Host”的绑定，每 30 秒为就绪环境续期。Router 离线超过环境的 `lifetimeSeconds` 后，按云厂商的超时策略处理。火山目前需显式暂停，过期策略为销毁，因此要认真配置存储和运行时长。续期失败会显示需要处理，不会默默重建环境或重放任务。

已有测试覆盖完整安装包、Go CLI、真实 Host 进程、重启和会话续接；其中云生命周期和模型协议为测试替身。2026-10-13 已另外完成火山生产部署实测：CLI 开通、分配沙箱、Host 自动启动、真实 Codex 模型与工具执行、同一环境暂停恢复、文件保留和原生会话续接均通过。阿里云及外部持久化挂载尚未在这条链路中验收。详见[环境模块的验证记录](https://github.com/Olorinm/agent-environment/blob/main/docs/verification.md)。部署步骤、网关要求和验证命令见[英文说明](cloud-environments.md)。

方案可用 `instructions` 设置 Agent 的通用操作说明。旧 Codex worker 的一次性迁移见[迁移指南](../../scripts/migrations/README.md)。旧固定 Host 开通入口和静态个人渠道启动接法已移除。
