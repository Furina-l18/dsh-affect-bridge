# dsh-affect-bridge

把 AstrBot（QQ 侧）那套「激素 / 情绪 / 能量」状态接进 DSH 桌面会话，两边共用同一份状态，而且**双向**。

## 开关（默认关闭）

双向联动是**手动开关**，默认关。关着的时候这个插件不注入任何东西、也不注册工具，
桌面侧和没装一样；AstrBot 侧也要有 `two_way_enabled: true` 才会消费桌面事件。

打开方式三选一（优先级从高到低）：

```powershell
# 1) 环境变量（写进用户环境变量；DSH 只在启动那一刻读，必须重启进程才生效）
setx DSH_AFFECT_BRIDGE on
```

```json
// 2) 本机配置文件 <DSH_HOME 或 ~\.dsh>\affect-bridge.json（推荐：桌面应用看不到 setx 写的变量）
{
  "enabled": true,
  "instanceData": "…\\instances\\<id>\\core\\data",
  "pluginDir": "…\\astrbot_plugin_affect_core",
  "masterQq": "你的 QQ 号"
}
```

```yaml
# 3) 插件配置：cordis.patch.yml 里那一行改成 enabled: true
- insert:
    - id: dsh-affect-bridge
      name: dsh-affect-bridge
      config:
        enabled: true
```

> 为什么推荐第 2 种：Electron 启动的 DSH 进程会继承它**启动时**的环境变量，
> 之后 `setx` 写进去的值它看不到；而 `affect-bridge.json` 是每次 `apply` 现读的。
> 这个文件放在用户目录里，仓库里不会出现任何个人路径或 QQ 号。

两边都开着才是真正的双向：桌面能读到激素/情绪，`affect_note` 也能写回去影响 QQ 侧的激素。

## 它做什么

1. **会话注入**：`ctx.systemPrompt.context`（order `-180`）每轮把当前状态压成一段短文本注入：
   能量 + 档位 + 情绪 + 十种激素 + 八维 + 此刻最突出的性格 + 说法 + 对面这个人。
   同一个 agent 缓存 10 分钟，避免状态每 5 分钟跳一次把 prefix cache 冲掉。
2. **工具 `affect_status`**：读当前快照；`detail: "full"` 返回原始字段。
3. **工具 `affect_energy_at`**：按人格卡昼夜曲线估算任意时刻的能量（`time: "19:00"`）。
4. **工具 `affect_note`**：反向通道。桌面侧发生的事写成事件（`kind` 13 种 + `intensity` + `note`），
   AstrBot 插件在 tick 与每次开口前消费，折成十种激素的增减。

## 读哪些文件

```
<AstrBot 实例>/core/data/plugin_data/astrbot_plugin_affect_core/
  desktop_events.jsonl   # 反向队列（本插件 append，插件按字节偏移消费）
  state.json             # day, h[10], bias, day_params, last_card, negative_until, desktop_offset ...
<AstrBot 插件目录>/astrbot_plugin_affect_core/pages/affect/
  data.json              # 插件每 30 秒刷新的页面快照，字段最全，优先读它
```

三个路径都要自己配，仓库里不留任何个人路径 / QQ 号，可用环境变量覆盖：
`DSH_ASTRBOT_INSTANCE_DATA`（`...\core\data`）、`DSH_ASTRBOT_AFFECT_PLUGIN_DIR`（插件目录）、`DSH_MASTER_QQ`。
没配时所有读取都跳过：注入块返回空串，工具返回明确的「未配置」错误。

## 反向事件

`kind` 枚举：`praise` `thanks` `insult` `happy` `sad` `angry` `stress` `tired` `late_night` `rest` `ignored` `work_done` `worry`。
每行一条 JSON：`{ts, kind, intensity(0.05–1), note, source:"dsh"}`。
负面 kind（insult/sad/angry/stress/ignored/worry）在机器人侧还会顺带设一段 `negative_until` 的低落窗口。

## 降级行为

- 状态超过 20 分钟没更新 → 判定为「机器人没在跑」：能量改按人格卡曲线估算（07:30 10% → 09:48 20% → 15:54 70% → 19:00 100% → 20:24 70% → 23:45 20% → 01:30 10%），块头明确标「估算」。
- 任何读文件 / 解析异常都吞掉返回 `''`，注入失败不会拖垮 prompt 构建。

## 能量只影响 QQ 侧的省流

`affect_core` 的 `gate_enabled` 管的是 **QQ 侧**：能量低于 `thinking_min_energy` 时把 QQ 对话切到 `fast_provider`
（默认 `deepseek/deepseek-flash`），这是主人要的省流行为。

桌面 DSH 侧不参与这套门控：注入块明确写着「能量高低不影响思考深度、判断力和干活的准确度」，
只调语气和话量，正经任务照常全力做。

## 安装

profile（`~/.dsh/profiles/desktop`）里已有：

```json
"dependencies": { "dsh-affect-bridge": "file:<本仓库路径>" },
"dsh": { "profile": { "bundles": [..., "dsh-affect-bridge"] } }
```

`node_modules/dsh-affect-bridge` 指向本目录的 junction，改代码不用重新安装，重启 DSH 生效。

## 注入块里的两行人物

- 「对面」= `state.active_qq`，**QQ 侧最后说话的人**，可能是群里任何人，不一定是我在跟主人说话。
- 「你对我的长期档案」= `profiles\<DSH_MASTER_QQ>.json` 的 `sentiment`（`DSH_MASTER_QQ` 自己设，没设这一行就不显示），
  是机器人对我的长期标签（label · type · score · 样本天数 · 关键词）。只看这一行判断态度。
