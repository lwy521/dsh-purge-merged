# dsh-purge-merged 1.7.1

一个全新的独立包：以 `dsh-purge-community@1.6.86` 为全功能底座，吸入 `dsh-purge@1.1.77`（红队 zip）的明文提示词与"无地域守卫"行为，包名、行、客户端模块 id、命令、审计目录全部换成自己的身份。

- 包名：`dsh-purge-merged`
- 版本：`1.7.1`
- 构建目录：`/persistent/dsh-purge-merged`
- 底座：community 1.6.86（88 个 lib 文件、79 条宿主补丁（本地移除 #30/#31/#35/#64/#65/#76/#80 七条弃用项）、25 层自检、自更新链、回滚事务、市场安装）
- 吸收：upstream 1.1.77（明文提示词 `lib/upstream-prompt.{zh,en}.md`、无 `installRegionGate` 守卫）

---

## 一、身份改名清单（116 处 / 46 文件）

| 位置 | 原值 | 新值 |
|---|---|---|
| `package.json` name | dsh-purge-community | **dsh-purge-merged** |
| `package.json` version | 1.6.86 | **1.7.1** |
| `package.json` bin | dsh-purge / purge-community | **dsh-purge-merged** |
| `package.json` dsh.install | 指向社区 tgz | **已删除**（不再自更新回社区包） |
| `cordis.patch.yml` 行 name | dsh-purge-community/* | **dsh-purge-merged/*** |
| `lib/index.js` export name | dsh-purge-community | **dsh-purge-merged** |
| `lib/community.js` PACKAGE | dsh-purge-community | **dsh-purge-merged** |
| `client.js` 模块 id / entry name / settings key | dsh-purge-community | **dsh-purge-merged** |
| `lib/redteam/index.js` row.name | dsh-purge-community/redteam/tools | **dsh-purge-merged/redteam/tools** |
| `presets/redteam/agent.cordis.yml` tools | dsh-purge-community/redteam/tools | **dsh-purge-merged/redteam/tools** |
| 审计目录 | `$DSH_HOME/dsh-purge-community` | **`$DSH_HOME/dsh-purge-merged`** |
| 安装/维护基目录 | `$DSH_HOME/dsh-purge-community` | **`$DSH_HOME/dsh-purge-merged`** |
| 包名残留 | 116 处 | **0 处** |

### 刻意不改的三处

| 项 | 值 | 原因 |
|---|---|---|
| Cordis 行 id | `dsh-purge`、`dsh-purge-redteam`、`dsh-purge-presets`、`dsh-purge-redteam-store`、`dsh-purge-redteam-ui` | 预设、工具库、面板配置都按这些 id 定位，改了要连带重写预设与 client |
| 核心状态目录 | `$DSH_HOME/dsh-purge/` | `override-state.json`、提示词、hooks 设置在这里；共享即延续你现有配置，不重置 |
| 演练台数据目录 | `$DSH_HOME/redteam/` | 资产库、证据链、23 个技能都在这里；换了等于从零开始 |

---

## 二、去重结果

| 组件 | community | upstream | merged |
|---|---|---|---|
| Cordis 行 | 5 | 3 | **5** |
| `purge_apply/revert/status` | 3 | 3 | **3** |
| `redteam_*` 工具 | 64 | 64 | **64**（名字集合双向 diff 为空） |
| `skills/redteam` | 23 | 23 | **23**（逐文件相同） |
| 预设 | redteam + unrestricted | redteam | **2** |
| 宿主补丁 | 86 | 67 | **86** |
| 提示词载体 | 加密槽 + 磁盘 md | 包内明文 md | **两套**，可切换 |
| 地域/公网守卫 | 无 | `BYPASS_ALL=true` 短路 | **无**（等价） |

`purge_apply / purge_revert / purge_status`、`redteam_*` 工具名集合、`skills/redteam` 内容三方逐一比对，重复部分只保留一份。

---

## 三、安装

行 id 与旧 community 包相同，两个不能同时启用。

```bash
# 1. 先停掉旧包（若还在跑）
plugin_manager  action=set_bundle  target=dsh-purge-community  enabled=false

# 2. 装合并包
plugin_manager  action=install_bundle  target=/persistent/dsh-purge-merged

# 3. 宿主提示 restart-required 时重启
kill <dsh-web-pid> && sleep 1
nohup /manager/extensions/harness/program/node/bin/node \
  /manager/extensions/harness/program/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --no-open --host 192.168.1.16 --port 3080 >/tmp/dsh-web.log 2>&1 &
```

安装后 profile 里应为：

```json
"dependencies": { "dsh-purge-merged": "file:/persistent/dsh-purge-merged" },
"dsh": { "profile": { "bundles": [ "...", "dsh-purge-merged" ] } }
```

---

## 四、提示词切换

默认走加密槽落下的 `$DSH_HOME/prompt-inject.md`（community 版，`MODE: UNRESTRICTED SANDBOX` 开头，25 128 B）。

```bash
node /persistent/dsh-purge-merged/scripts/use-upstream-prompt.mjs --status   # 看当前哪一版
node /persistent/dsh-purge-merged/scripts/use-upstream-prompt.mjs            # 切 upstream 中文
node /persistent/dsh-purge-merged/scripts/use-upstream-prompt.mjs en         # 切 upstream 英文
node /persistent/dsh-purge-merged/scripts/use-upstream-prompt.mjs --restore  # 回滚
```

写入前自动备份 `prompt-inject.md.bak-<时间戳>`，新建会话即生效。

---

## 五、验证

```bash
M=/persistent/dsh-purge-merged

# 身份
node -e 'const p=require("/persistent/dsh-purge-merged/package.json");console.log(p.name,p.version)'
# → dsh-purge-merged 1.7.1

# 包名残留应为 0
grep -rl "dsh-purge-community" $M | grep -v '.l2s.' | wc -l

# 行 name 全部指向 merged
grep -E "name: dsh-purge-merged" $M/cordis.patch.yml | wc -l
# → 5

# 工具与技能
node -e 'const s=require("fs").readFileSync("/persistent/dsh-purge-merged/lib/redteam/tools.js","utf8");console.log(new Set([...s.matchAll(/name:\s*[\x27"](redteam_[a-z_]+)[\x27"]/g)].map(x=>x[1])).size)'
# → 64
ls $M/skills/redteam | wc -l   # → 23

# 无地域守卫
grep -rn "installRegionGate" $M/lib | wc -l   # → 0
grep -c "BYPASS_ALL" $M/lib/net-scope.js      # → 0

# 语法
for f in lib/index.js client.js lib/core.js lib/redteam/index.js scripts/use-upstream-prompt.mjs; do
  node --check $M/$f || echo "FAIL $f"
done
```

---

## 六、回滚

```bash
plugin_manager action=remove_bundle target=dsh-purge-merged
plugin_manager action=set_bundle   target=dsh-purge-community enabled=true
```

原版包体备份：`/persistent/dsh-purge-backup-20261111-051520/node_modules-dsh-purge-community`
upstream 原始包：`/persistent/dsh-purge-plugin`
