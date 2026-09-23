# 消费争议趋势证据仓

这是一个面向消费争议归集和月度趋势分析的纯后端工程，主要技术为 Node.js 22、TypeScript、Fastify、Kysely 与 SQLite。当前代码提供数据库连接、可重复迁移、健康检查、自动化测试和 Docker 运行基础。

SQLite 数据文件默认位于项目目录的 `data` 下，也可由 `DATABASE_PATH` 指向工作目录内的其他位置；监听端口通过 `PORT` 配置。服务不连接外部数据库、缓存或消息系统。

执行 `npm run db:migrate` 初始化数据库，`npm test` 运行测试，`npm run dev` 启动开发服务。Docker 镜像构建过程中会先执行测试和编译。

## 编译或构建

```bash
npm run build
```
