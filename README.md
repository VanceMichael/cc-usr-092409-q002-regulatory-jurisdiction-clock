# 消费争议趋势证据仓

这是一个面向消费争议归集和月度趋势分析的纯后端工程，主要技术为 Node.js 22、TypeScript、Fastify、Kysely 与 SQLite。当前代码提供数据库连接、可重复迁移、健康检查、自动化测试和 Docker 运行基础。

SQLite 数据文件默认位于项目目录的 `data` 下，也可由 `DATABASE_PATH` 指向工作目录内的其他位置；监听端口通过 `PORT` 配置。服务不连接外部数据库、缓存或消息系统。

执行 `npm run db:migrate` 初始化数据库，`npm test` 运行测试，`npm run dev` 启动开发服务。Docker 镜像构建过程中会先执行测试和编译。

## 管辖裁定与期限账本

服务在证据仓之上提供跨省协同所需的管辖与期限能力（详见 `docs/domain.md`）：

- 基础数据：`POST /admin/regions|agencies|personnel|calendar-days`、`/admin/personnel/grants`、`/admin/conflicts`、`/admin/rule-versions`
- 案件与证据：`POST /cases`、`POST /cases/:id/claims`、`POST /cases/:id/materials`、待归属材料 `POST /cases/:id/materials/:mid/attribute`
- 管辖裁定：`POST /cases/:id/rulings`（需授权且无利益冲突，原子切换责任链）
- 期限账本：`POST /cases/:id/stages|clock-events|decisions`，时钟视图 `GET /cases/:id/clock[?stage_id=&as_of=]`
- 移交：`POST /cases/:id/transfers`、`POST /transfers/:id/freeze|receive|cancel`（冻结清单→同版签收→原子生效）
- 催办与扫描：`POST /cases/:id/reminders`、`POST /scanner/run`、`GET /scanner/status`
- 时点回放：`GET /cases/:id/timeline?as_of=<ISO-8601>`

扫描间隔由 `SCANNER_INTERVAL_MS`（毫秒，默认 60000）控制，进程启动即扫描一次。请求可带 `x-now: <ISO-8601>` 头固定业务时钟（主要用于测试与补录历史事件）。写接口通过 `idempotency_key` 幂等，错误体为 `{ "error": { "code", "message", "details" } }`。

## 编译或构建

```bash
npm run build
```
