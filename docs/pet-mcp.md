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
| `pet_set_scene` | `scene` | 切换花园 `garden` 或宝宝房 `nursery` |
| `pet_list_toys` | 可选 `scene` | 返回场景内玩具的 ID、名称和互动说明。省略场景时读取键盘当前背景 |
| `pet_use_toy` | `toy` | 切换该场景的玩具。放下新玩具，再次选择即收起，选择另一件则替换 |
| `pet_place_toy` | `toy` | 在空位放下玩具。如果同一件已在场景中，重复请求保持原样。如果有其他玩具则返回忙 |
| `pet_interact_with_toy` | `toy` | 让兔子再玩一次当前场景中已经落地的玩具 |
| `pet_list_decorations` | 可选 `scene` | 查询场景中的互动装饰、当前位置及移动范围 |
| `pet_move_decoration` | `decoration`、`x`、`y` | 一次设置并保存宝宝房兔窝的位置 |
| `pet_interact_with_decoration` | `decoration` | 选择 `rabbit_hutch` 让兔子自行回窝小憩，随后恢复活动 |
| `pet_get_events` | 可选 `cursor` | 读取桌宠事件，并返回下一次读取的游标 |

`pet_feed` 成功表示键盘已接收一份水果。新固件可同时显示八份。水果各自从上方落下，兔子一次吃一份。饱食度达到 100 时，剩余水果留在地上，等兔子饿了再吃。状态中的 `foods` 返回每份水果的种类、坐标和阶段（`falling`、`landed`、`eating`）。只有 `fruit_eaten` 事件表示吃完。在同一来源连续投下相同水果时，事件无法区分这些水果的个体。`pet_play_action` 的 `eat` 只播放进食动作。投喂、动作以及季节和时间修改需要桌宠模式已开启。

## 属性与玩具

`pet_get_state.stats` 包含饱食度 `satiety`、困意 `sleepiness`、心情值 `mood` 和好感度 `affection`。各项范围均为 0–100，困意越高表示越想睡。键盘维护这些数值，左右小屏可分别选择两个参数，每行显示参数名和数值，属性值另有进度条。桌宠状态会按固件能力返回，缺少的扩展字段显示为 `null`。

进入养宠模式后，调用 `pet_set_scene({"scene":"nursery"})`，再用 `pet_list_toys({})` 读取可用玩具。胡萝卜玩具 `carrot_toy` 可放在花园和宝宝房。每个场景保留一件已放置的玩具，`deployedToys` 分别返回两个场景的玩具 ID，空位为 `null`。当前场景玩具落地时 `toyDropProgress` 达到 100。兔子有空就会过去用鼻尖推它，玩完后玩具留在原处。

`activeToy` 标识兔子正在使用的玩具。`toyPhase` 依次为 `approaching`、`using`，结束后回到 `idle`。互动结束时产生 `toy_finished`，其 `interrupted` 表示是否被打断。

## 布置兔窝

兔窝 `rabbit_hutch` 常驻宝宝房，场景里可以同时放胡萝卜。调用 `pet_list_decorations({"scene":"nursery"})` 可读取兔窝位置和范围。`pet_move_decoration({"decoration":"rabbit_hutch","x":200,"y":136})` 会移动兔窝并在键盘上保存。坐标以 320×172 的彩屏左上角为原点，表示兔窝底边中心，x 范围 41–280，y 范围 69–167。拖动软件里的兔窝会更新相同设置。状态中的 `hutchPosition` 返回窝的位置，`positionX` 和 `positionY` 返回兔子的当前位置。

调用 `pet_play_action({"action":"sleep"})` 或兔子自行入睡时，它会走到宝宝房的窝里，`bedtime` 变为 `true`，`activeDecoration` 为 `rabbit_hutch`，`decorationPhase` 先是 `approaching`，到窝后变为 `using`。播放 `idle` 可叫醒兔子。想让兔子短暂休息，用 `pet_interact_with_decoration({"decoration":"rabbit_hutch"})`。旧客户端的 `pet_use_toy({"toy":"rabbit_hutch"})` 在新键盘上也能让兔子回窝小憩。连接较早的固件时，应用会按设备能力显示旧玩具目录和状态。

在宠物设置的道具列表中，可以把八种水果、回窝小憩和胡萝卜玩具绑定到 K1–K8。原有兔窝按键会继续触发小憩。`pet_get_state.keyBindings` 按 K1 到 K8 返回八个道具 ID，未绑定项为 `null`。小旋钮 1 调整小时，小旋钮 2 调整季节，按住小旋钮 2 旋转可切换背景。开启跟随现实时间后，软件会同步电脑的本地时刻，状态里的 `hour` 和 `minute` 表示当前场景时刻，`followRealTime` 为 `true`。

内置 AI 在每轮决策时读取属性、场景中的水果和已放置的玩具。它可以在空位放下玩具，或和已落地的玩具再次互动。已有水果或已吃饱时，AI 暂停投喂。取食、回窝途中和玩玩具时会等待，熟睡时可继续休息或叫醒。道具目录位于 `app/src/utils/petCatalog.ts`，新增玩具需为固件分配稳定的 ID 并实现其互动。

## 从 LLM 读取事件

第一次调用 `pet_get_events` 可以省略游标。后续沿用上次返回的 `cursor`。`hasMore` 为真时，可以用新游标继续读取下一页。每页最多 16 条，键盘保留最近 64 条。连接发生变化时 `reset` 为真。游标早于缓存时 `overrun` 为真，返回当前能读到的最早一页。

事件包括模式切换、动作变化、水果排队、落地、吃完、时间、季节、按键、大旋钮短按，以及背景变化 `scene_changed`、玩具放下 `toy_placed` 或收起 `toy_removed`、互动开始 `toy_started` 和完成 `toy_finished`。装饰另有 `decoration_moved`、`decoration_started`、`decoration_finished`。每条事件带有 `source`（`physical`、`mcp` 或 `automatic`）、事件序号和设备开机后的毫秒数。

如果写操作的设备回复超时，先查状态或事件，再决定是否发出下一条命令。配置发送和固件升级期间，MCP 返回串口忙。
