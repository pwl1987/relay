# RELAY-BACKUP-INTEGRITY-09 协调方独立审计（2026-11-15）

**裁决：REWORK（Major-R1：恢复目标实体身份未核实，可绕过源实例隔离守卫）。**

## 已核实
- GitHub live main = bacc849d6500c6a98a62ac551c36eb39ac880e0f，提交链 a458e95 合同→0eb4b7b 实施→9b8555f CI 修复→bacc849 收口；exact-head GitHub Actions [43695134793](https://github.com/pwl1987/relay/actions/runs/43695134793) test/e2e 双 success，前置 [43694571961](https://github.com/pwl1987/relay/actions/runs/43694571961) 同样双 success，初版 43694046569 test 红由分支环境适配修正。真实 diff 包含 backup.sh/backup-validate、manifest/check、restore-verify、测试与证据，不涉及本包 src/migrations/preflight。
- VM80 安全定向实跑 npx vitest run test/unit/d09-backup-chain.test.ts test/integration/d09-backup-integrity.test.ts --reporter=dot：**20/20 PASS**（15 unit、5 真实合成双租户一次性 PG E2E）；原 d09 容器无残留。源码确认 backup.sh F-1 审计索引已改显式 schema、两路径同源/完成标记，恢复交付和审计核对较原方案显著改善。Agent 报告+Reviewer 的完整测试证据可信程度高，但不能代替本轮安全反例。
- 本地 HEAD=GitHub main bacc849，origin/main 跟踪指针尚停在 cc8cab5（陈旧缓存,不是本地分叉）,当前 Writer auto/released；未跟踪 config/、soak-r3b/ 与 4 份 CI 回执均未触碰。

## Major-R1：协调方新增两项无副作用亲测反例
1. **文本别名绕过**：restore-verify.sh 仅当 [[ "$RELAY_DB_URL" == "$RESTORE_URL"* ]] 拒绝。协调方以 RELAY_DB_URL=postgresql://demo@127.0.0.1:55433/relayp000，RESTORE_URL=postgresql://demo@localhost:55433，RELAY_RESTORE_ISOLATED=1，构造**只含合成数据、完成标记和真实 sha256sum** 的临时备份目录，并将 PATH 的 psql 替换为假执行器（只记 argv，退出 79，零 DB 连接）。实测脚本绕过拒绝门，假执行器记录 `psql postgresql://demo@localhost:55433/postgres -c DROP DATABASE IF EXISTS relay_restore_v... -q`，exit=79。两个地址可指同一 PostgreSQL 实例，故前缀比较不能作为实际隔离证明；本次没执行 DROP。
2. **Docker 执行目标错位**：在 VM80 宿主无 psql 的回退路径，脚本完全忽略 RESTORE_URL 的 host/port，直接 docker exec "$RELAY_RESTORE_CONTAINER" psql。协调方用 RELAY_DB_URL 指向源实例、RESTORE_URL 指向不同且无效的 DNS 主机、RELAY_RESTORE_CONTAINER=relay-p000-pg，同样用 PATH 假 docker 完全拦截真实调用，观测到 `docker exec relay-p000-pg psql -U postgres -c DROP DATABASE IF EXISTS relay_restore_v...`，exit=79。即使 URL 不同，真实操作容器仍可能是源/生产。**同样未执行真实 Docker/DB 命令**。
3. **缺少真实可验证门**：RELAY_RESTORE_ISOLATED=1 只是一项操作者声明；RELAY_DB_URL 可能缺失，别名、默认端口、Docker 容器身份均未与真实执行对象比较。以上两例是现有代码可达行为，并非假想失误；09 的原负向测试仅覆盖字面相同的源 URL，未覆盖身份别名和容器错位。代码安全目标“在任何 DDL 前证明目标不是源实例”未满足，因此 09 不可整体 PASS。

## 影响、范围与下一步
- 生产 read-only preflight 已在前一轮验证 NO-GO（0008/0009、Gate 配置、旧进程、Egress 栈），09 无授权生产操作；本轮新反例无任何真实生产数据查询、DROP、CREATE 或服务重启。
- 09 的 schema 备份、manifest、索引与部分恢复校验实现保持有效，不推倒重做；当前唯一 ACTIVE 交接 **RELAY-RESTORE-TARGET-09R**，先假命令 red/green，修正 host 与 docker 路径实际目标身份，后以一次性独立 PG 验证，Reviewer/CI 收口。D3 决策材料已标记禁止选项 A 立即执行。

**最终判定：REWORK。**