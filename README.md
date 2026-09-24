# 消费争议趋势证据仓

这是一个面向消费争议归集和月度趋势分析的纯后端工程，主要技术为 Node.js 22、TypeScript、Fastify、Kysely 与 SQLite。当前代码提供数据库连接、可重复迁移、健康检查、自动化测试和 Docker 运行基础，并在此之上实现了跨省消费争议的**管辖裁定与期限账本**服务。

SQLite 数据文件默认位于项目目录的 `data` 下，也可由 `DATABASE_PATH` 指向工作目录内的其他位置；监听端口通过 `PORT` 配置。服务不连接外部数据库、缓存或消息系统。

执行 `npm run db:migrate` 初始化数据库（服务启动时也会自动应用未执行的迁移），`npm test` 运行测试，`npm run dev` 启动开发服务。Docker 镜像构建过程中会先执行测试和编译。

## 管辖裁定与期限账本

- **案件受理** `POST /cases`：保存各方主张、适用规则版本与证据水位，法定时钟自受理时刻起算。
- **管辖确认** `POST /cases/:id/jurisdiction`：由登记在册、持有 `jurisdiction.confirm` 权限且与案件三地（消费者常住地、商家主体地、交易发生地）无利益冲突的人员确认主办与协办机构；每案仅一次，之后主办变更走移交。
- **期限事件** `POST /cases/:id/events`：补正（`supplement_requested`/`supplement_received`）、等待外部裁决（`external_wait_started`/`external_wait_ended`）、恢复办理（`resumed`）、紧急延长期（`emergency_extension`）全部以事件追加；系统按负责机构当地工作日历逐日计算每一段计时，暂停段附规则依据。
- **移交** `POST /cases/:id/transfers` → `POST /transfers/:id/sign`：交出方冻结材料清单，接收方签收同一清单版本后在单事务内原子生效；途中到达的新材料进入待归属区；重复签收幂等；并发移交由唯一约束保证只保留一条有效责任链。
- **时点查询** `GET /cases/:id/ledger?at=<ISO>`：返回当时负责机构、剩余时限、被排除的时间段及依据、未签收材料和每次催办的实际依据。
- **到期扫描**：服务启动时立即补扫并按 `SCAN_INTERVAL_MS`（默认 60 秒）持续扫描，通知持久化并按 案件+阶段+责任段+类型 去重，进程重启不重复催办；也可 `POST /internal/scan` 手动触发。

计时口径：受理当日不计入，次日起每个工作日计 1；暂停段按整日排除（开始当日不计、恢复当日计）；暂停未结束时剩余时限冻结。已出具决定的阶段冻结账本快照，之后的规则换版不改写该阶段。

## 编译或构建

```bash
npm run build
```
