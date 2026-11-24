# MultiPad 桌宠 MCP

按 [USB 升级说明](usb-firmware-update.md) 装入支持桌宠 MCP 的应用固件，连接键盘并启动新版 MultiPad 上位机。MCP 和界面共用同一个串口连接。

## 启动

在上位机进程的环境中设置 `MULTIPAD_PET_MCP_TOKEN`。应用会在 `http://127.0.0.1:18775/mcp` 提供 Streamable HTTP MCP。用 `MULTIPAD_PET_MCP_PORT` 可以更换端口。

在 PowerShell 中生成令牌，再从同一个终端启动上位机。使用 Windows 打包版时，在 `MultiPad.exe` 所在目录运行以下命令。

```powershell
$env:MULTIPAD_PET_MCP_TOKEN = [guid]::NewGuid().ToString('N')
.\MultiPad.exe
```

使用源码时，在 `app/` 目录设置同一个环境变量后运行 `pnpm dev`。

在本机 MCP 客户端填写该 URL，并配置请求头 `Authorization: Bearer <同一个令牌>`。服务只绑定 IPv4 回环地址。令牌需要 16–128 个非空格 ASCII 字符，会随进程环境传入。

## 工具

| 工具 | 参数 | 效果 |
| --- | --- | --- |
| `pet_get_state` | 空 | 返回模式、动作、位置、水果、排队数、时刻、季节、四项属性、背景和玩具互动进度 |
| `pet_set_mode` | `enabled` | 进入桌宠模式，或退出并恢复当前层彩屏 |
| `pet_play_action` | `action` | `trip_angry` 绊脚生气、`gaze_owner` 面向主人发呆，以及原有的 `idle`、`blink`、`walk`、`run`、`jump`、`sleep`、`daydream`、`eat`、`flee` |
| `pet_feed` | `fruit` | `apple`、`banana`、`orange`、`grape`、`strawberry`、`pear`、`cherry`、`watermelon` |
| `pet_set_time` | `hour` | 设置场景的整点，范围 0–23 |
| `pet_set_season` | `season` | `spring`、`summer`、`autumn`、`winter` |
| `pet_set_scene` | `scene` | 切换花园 `garden` 或室内玩具厂 `toy_factory` |
| `pet_list_toys` | 可选 `scene` | 返回场景内玩具的 ID、名称和互动说明。省略场景时读取键盘当前背景 |
| `pet_use_toy` | `toy` | 让兔子走向指定玩具并互动。室内玩具厂有兔窝 `rabbit_hutch` |
| `pet_get_events` | 可选 `cursor` | 读取桌宠事件，并返回下一次读取的游标 |

`pet_feed` 成功表示水果已进入等待队列。水果从屏幕上方落下，兔子走过去吃。落地和吃完分别产生事件。`pet_play_action` 的 `eat` 播放进食动作。播放 `idle` 可叫醒睡着的兔子。投喂过程中，单独播放动作会返回忙。投喂、动作以及季节和时间修改需要桌宠模式已开启。

## 属性与玩具

`pet_get_state.stats` 包含饱食度 `satiety`、困意 `sleepiness`、心情值 `mood` 和好感度 `affection`。各项范围均为 0–100，困意越高表示越想睡。键盘维护这些数值，软件里的两块小屏可分别选择其中一项显示。旧版桌宠固件仍可投喂和播放原有动作，扩展状态字段为 `null`，`availableToys` 为空数组。

进入养宠模式后，调用 `pet_set_scene({"scene":"toy_factory"})`，再用 `pet_list_toys({})` 读取可用玩具。调用 `pet_use_toy({"toy":"rabbit_hutch"})` 后，键盘状态中的 `activeToy` 标识正在使用的玩具。`toyPhase` 依次为 `approaching`、`using`，结束后回到 `idle`。互动结束时产生 `toy_finished`，其 `interrupted` 字段为 `false` 表示自然结束，为 `true` 表示中途退出。

内置 AI 在每轮决策时读取属性，只能选择当前背景内可用的玩具。兔子正在取食或使用玩具时，AI 会等待下一轮。软件端的玩具目录位于 `app/src/utils/petCatalog.ts`，新增玩具需为固件分配稳定的玩具 ID 并实现其互动。

## 从 LLM 读取事件

第一次调用 `pet_get_events` 可以省略游标。后续沿用上次返回的 `cursor`。`hasMore` 为真时，可以用新游标继续读取下一页。每页最多 16 条，键盘保留最近 64 条。连接发生变化时 `reset` 为真。游标早于缓存时 `overrun` 为真，返回当前能读到的最早一页。

事件包括模式切换、动作变化、水果排队、落地、吃完、时间、季节、实体键、大旋钮短按，以及背景变化 `scene_changed`、互动开始 `toy_started` 和完成 `toy_finished`。每条事件带有 `source`（`physical`、`mcp` 或 `automatic`）、事件序号和设备开机后的毫秒数。场景时间由 `hour` 单独返回。

如果写操作的设备回复超时，先查状态或事件，再决定是否发出下一条命令。配置发送和固件升级期间，MCP 返回串口忙。
