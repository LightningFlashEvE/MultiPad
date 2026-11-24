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
| `pet_get_state` | 空 | 返回模式、动作、横坐标、当前水果、排队数、时刻和季节 |
| `pet_set_mode` | `enabled` | 进入桌宠模式，或退出并恢复当前层彩屏 |
| `pet_play_action` | `action` | `idle`、`blink`、`walk`、`run`、`jump`、`sleep`、`daydream`、`eat`、`flee` |
| `pet_feed` | `fruit` | `apple`、`banana`、`orange`、`grape`、`strawberry`、`pear`、`cherry`、`watermelon` |
| `pet_set_time` | `hour` | 设置场景的整点，范围 0–23 |
| `pet_set_season` | `season` | `spring`、`summer`、`autumn`、`winter` |
| `pet_get_events` | 可选 `cursor` | 读取桌宠事件，并返回下一次读取的游标 |

`pet_feed` 成功表示水果已进入等待队列。水果从屏幕上方落下，兔子走过去吃。落地和吃完分别产生事件。`pet_play_action` 的 `eat` 播放进食动作。播放 `idle` 可叫醒睡着的兔子。投喂过程中，单独播放动作会返回忙。投喂、动作以及季节和时间修改需要桌宠模式已开启。

## 从 LLM 读取事件

第一次调用 `pet_get_events` 可以省略游标。后续沿用上次返回的 `cursor`。`hasMore` 为真时，可以用新游标继续读取下一页。每页最多 16 条，键盘保留最近 64 条。连接发生变化时 `reset` 为真。游标早于缓存时 `overrun` 为真，返回当前能读到的最早一页。

事件包括模式切换、动作变化、水果排队、落地、吃完、时间、季节、实体键和大旋钮短按。每条事件带有 `source`（`physical`、`mcp` 或 `automatic`）、事件序号和设备开机后的毫秒数。场景时间由 `hour` 单独返回。

如果写操作的设备回复超时，先查状态或事件，再决定是否发出下一条命令。配置发送和固件升级期间，MCP 返回串口忙。
