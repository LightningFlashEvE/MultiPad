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

连接后，MCP 初始化响应会说明如何读取键盘实况。第一次使用时，先调用 `pet_get_care_guide({})`，了解属性的方向、各个动作的时长和收益，以及必须等到哪个事件才能确认完成。该手册可离线读取。随后调用 `pet_get_state({})`。`generation` 是实际协商出的固件能力，`availableNow` 给出这一刻设备接受的动作参数、玩具、装饰与设置，`careNote` 解释当前的取食、睡眠或玩耍状态。

例如，`availableNow.feed` 为真表示还能接收一份水果。如果饱食度已经达到 100 或地面还有食物，可以让兔子等待。要确认一次操作，先把 `pet_get_events` 读到 `hasMore=false` 并保存游标，执行一次操作，再用游标读取后续事件。实体按键与自主动作都可能在两次读取之间改变状态。

| 工具 | 参数 | 效果 |
| --- | --- | --- |
| `pet_get_care_guide` | 空 | 读取属性、动作和互动的规则，了解不同固件支持的能力及事件含义 |
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

`pet_get_state.stats` 包含饱食度 `satiety`、精神值 `energy`、心情值 `mood` 和好感度 `affection`。各项范围均为 0–100，精神值越高表示越有精神。键盘维护这些数值，左右小屏可分别选择两个参数，每行显示参数名和数值，属性值另有进度条。桌宠状态会按固件能力返回，缺少的扩展字段显示为 `null`。

进入养宠模式后，调用 `pet_set_scene({"scene":"nursery"})`，再用 `pet_list_toys({})` 读取可用玩具。胡萝卜玩具 `carrot_toy` 可放在花园和宝宝房。每个场景保留一件已放置的玩具，`deployedToys` 分别返回两个场景的玩具 ID，空位为 `null`。当前场景玩具落地时 `toyDropProgress` 达到 100。兔子有空就会过去用鼻尖推它，玩完后玩具留在原处。

`activeToy` 标识兔子正在使用的玩具。`toyPhase` 依次为 `approaching`、`using`，结束后回到 `idle`。互动结束时产生 `toy_finished`，其 `interrupted` 表示是否被打断。

## 布置兔窝

兔窝 `rabbit_hutch` 常驻宝宝房，场景里可以同时放胡萝卜。调用 `pet_list_decorations({"scene":"nursery"})` 可读取兔窝位置和范围。`pet_move_decoration({"decoration":"rabbit_hutch","x":200,"y":136})` 会移动兔窝并在键盘上保存。坐标以 320×172 的彩屏左上角为原点，表示兔窝底边中心，x 范围 41–280，y 范围 69–167。拖动软件里的兔窝会更新相同设置。状态中的 `hutchPosition` 返回窝的位置，`positionX` 和 `positionY` 返回兔子的当前位置。

调用 `pet_play_action({"action":"sleep"})` 或兔子自行入睡时，它会走到宝宝房的窝里，`bedtime` 变为 `true`，`activeDecoration` 为 `rabbit_hutch`，`decorationPhase` 先是 `approaching`，到窝后变为 `using`。播放 `idle` 可叫醒兔子。想让兔子短暂休息，用 `pet_interact_with_decoration({"decoration":"rabbit_hutch"})`。旧客户端的 `pet_use_toy({"toy":"rabbit_hutch"})` 在新键盘上也能让兔子回窝小憩。连接较早的固件时，应用会按设备能力显示旧玩具目录和状态。

在宠物设置的道具列表中，可以把八种水果、回窝小憩和胡萝卜玩具绑定到 K1–K8。原有兔窝按键会继续触发小憩。`pet_get_state.keyBindings` 按 K1 到 K8 返回八个道具 ID，未绑定项为 `null`。小旋钮 1 调整小时，小旋钮 2 调整季节，按住小旋钮 2 旋转可切换背景。开启跟随现实时间后，软件会同步电脑的本地时刻，状态里的 `hour` 和 `minute` 表示当前场景时刻，`followRealTime` 为 `true`。

实体旋钮、按键和软件中的手动摸头、投喂、放玩具会触发内置 AI。模型输入的 `ownerInteractions` 记录这次互动，连续摸头从第一次检测到时开始决策，松手后执行。键盘自己的动作和内置 AI 发出的指令不会触发新一轮。没有主人互动时每 60 秒启动一轮，模型编排第 0、10、20、30、40、50 秒的六个时段，rest 留给兔子自由活动。新互动会取消旧安排。每个动作执行前重读设备，互动决策超过 4 秒且键盘状态允许时用本地眨眼回应。

模型只收到本轮用到的属性、当前动作和场景、主人刚做的事、上一次已执行的动作，以及当下可选的动作。键盘的事件记录仍可通过 MCP 查询。

外部 MCP 客户端通过 `pet_perform_sequence` 可以编排 1–6 步，每步包含 `behavior` 和执行前等待的 `waitMs`（0–8000 毫秒）。例如先眨眼再跳可提交 `{"steps":[{"behavior":"blink"},{"behavior":"jump","waitMs":500}]}`。每步重读设备，摸头、断连或需求变化时停止剩余步骤。返回的 `accepted` 仅列出键盘接收的动作。

内置 AI 只编排兔子自身动作。主人投放食物或玩具，键盘处理取食与玩耍；模型能观察这些变化并作出反应。取食、回窝途中和玩玩具时会等待，熟睡时可继续休息或叫醒。道具目录位于 `app/src/utils/petCatalog.ts`，新增玩具需为固件分配稳定的 ID 并实现其互动。

## 从 LLM 读取事件

第五代固件支持观察主人摸头。在养宠模式下，轻按并松开大旋钮会轻拍兔子，按住后转动则会顺着旋转方向抚摸。桌面大旋钮可以模拟这两类操作。每次轻按或转过一格，键盘产生 `head_petted`，`encoder` 为 3，`gesture` 为 `tap`、`cw` 或 `ccw`。`source` 为 `physical` 表示实体旋钮，为 `mcp` 表示软件模拟。MCP 客户端可在 `pet_get_state.headPet` 读取方向与剩余毫秒数；一轮摸头结束后 `remainingMs` 为 0、`gesture` 为 `null`。旧固件的 `headPet` 为 `null`。

新一轮摸头会让心情与好感各增加 1，1200 毫秒内再次触摸会延长动画。保持按住时，无论转过几格或中途停顿多久，整次只奖励一次。第六代固件的 headPet.phase 记录当前画格。手随旋钮推进或后退，停转时定格，兔子暂停移动，松手后恢复活动。饱食度达到 90 停止自动进食，精神值不高于 75 才自动睡，恢复到 95 自动醒。心情达到 90 或精神值不高于 15 会暂停自动玩玩具，好感达到 90 停止自动发起面向主人的动作。

第一次调用 `pet_get_events` 可以省略游标。后续沿用上次返回的 `cursor`。`hasMore` 为真时，可以用新游标继续读取下一页。每页最多 16 条，键盘保留最近 64 条。连接发生变化时 `reset` 为真。游标早于缓存时 `overrun` 为真，返回当前能读到的最早一页。

事件包括模式切换、动作变化、水果排队、落地、吃完、时间、季节、按键、大旋钮短按，以及背景变化 `scene_changed`、玩具放下 `toy_placed` 或收起 `toy_removed`、互动开始 `toy_started` 和完成 `toy_finished`。装饰另有 `decoration_moved`、`decoration_started`、`decoration_finished`。每条事件带有 `source`（`physical`、`mcp` 或 `automatic`）、事件序号和设备开机后的毫秒数。

如果写操作的设备回复超时，先查状态或事件，再决定是否发出下一条命令。配置发送和固件升级期间，MCP 返回串口忙。

## 日常梳理

第九代的兔子在散步间歇会原地回头舔毛，也会用双爪捧起垂耳梳理。软件动作按钮及 MCP 的 `pet_play_action`、`pet_perform_sequence` 均支持 `groom_fur`（2.5 秒）和 `groom_ear`（3 秒）。梳理不产生属性奖励。

## 兔子舞、窗外时间和站立眺望

第八代固件增加 `binky` 兔子舞，可通过 `pet_play_action` 或 `pet_perform_sequence` 触发。兔子前跃 36 像素，在空中蹬腿转身，背向起跳方向落地，全程约 1.1 秒。自主散步停顿时也有机会跳舞，心情 0、50、80、100 时每次机会的概率分别为 4%、14%、29%、44%。普通眺望由后脚支撑，身体直立约 3 秒，再放下前爪。

宝宝房的天空、云和远处的树会随场景时钟变色。白天能看到太阳，19 时至次日 6 时能看到月牙和星光。开启跟随现实时间后按分钟更新，手动调时也会立即改变窗外的景色。

第七代固件增加了 `stand_watch`（原地站起来眺望）和 `inspect_table`。宝宝房的木桌是固定家具，桌上有小熊和套圈。通过 `pet_interact_with_decoration({"decoration":"nursery_table"})`，或在编排中选择 `inspect_table`，兔子会走到桌边，前爪搭住桌沿观察约 3.4 秒，再回到地面。`activeDecoration` 和 `decorationPhase` 区分正在走近和已到桌边。兔子也会在自主散步的停顿中眺望或探桌。

## 四项属性如何变化

第十代起，主人可在软件的「宠物设置 → 属性数值」输入 0–100 的整数并逐项保存。设备写入 Flash 后，`pet_get_state` 和 OLED 会读到新值，后续互动和代谢以新值继续计算。

初始饱食度 65、精神值 75、心情 70、好感 35，范围均为 0–100。下表列出养宠模式的实际增减。一次性互动在自然完成时结算，摸头在开始时结算。

| 触发条件 | 饱食度 | 精神值 | 心情 | 好感 |
|---|---:|---:|---:|---:|
| 每满 1 分钟养宠时间 | −1 | — | 若饱食度 <25 或精神值 <15，−1 | — |
| 清醒满 60 秒 / 睡着满 20 秒 | — | −1 / +1 | — | — |
| 累计 60 秒运动时间（散步、取食移动按实际时长，跑跳、逃跑和兔子舞按双倍时长） | −1 | −1 | — | — |
| 吃完一份水果（八种效果相同） | +12 | — | +3 | +2 |
| 玩完胡萝卜 | −1 | −2 | +6 | +2 |
| 完成兔窝短憩 | — | +12 | +5 | +2 |
| 开始一轮摸头 | — | — | +1 | +1 |
| 绊脚生气结束 | — | −1 | −4 | — |
| 面向主人发呆结束 | — | — | +1 | 软件或 MCP 触发时 +1 |
| 照料不足持续 5 分钟（第九代） | — | — | — | −1 |
| 状态良好持续 10 分钟（第九代） | — | — | — | +1 |
| 舔毛、抱耳梳理、站立眺望、趴桌观察动作本身 | — | — | — | — |

饱食度达到 90 会暂缓自动取食。精神值不高于 75 且空闲约 18 秒才会主动回窝长睡，恢复到 95 会醒。心情达到 90 或精神值不高于 15 会抑制主动玩玩具，好感达到 90 会抑制主动面向主人发呆。决策仍会考虑正在取食、摸头、使用家具等状态。长睡按时间恢复精神值；短憩有单独的完成奖励。连续转动旋钮属于同一轮摸头。精神值不高于 15 时，内置 AI 暂缓剧烈动作。旧 Flash 存档和 USB 协议中的疲劳字节按 100 减原值换算。运动的额外消耗需要配套新版固件。四项数值由键盘保存到 Flash，拔电期间不累计代谢时间。

按当前规则，心情既有收益也有损耗，第九代起好感也随照料状况自然变化。饱食度 ≤25、心情 ≤30 或精神值 ≤20 时，每持续 5 分钟好感 −1。饱食度和心情均 ≥70 且精神值 ≥70 时，每持续 10 分钟好感 +1。其他状态持平，离开相应区间会重置本段计时。设备只累计养宠模式运行的时间，断电保存数值和已累计的整分钟。例如吃完一份水果带来的 12 点饱食度相当于约 12 分钟的基础消耗。好感到顶后，普通探索仍可发生；眺望和探桌提供无需额外奖励的活动。
