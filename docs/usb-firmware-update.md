# MultiPad USB 固件升级

## 首次安装

只有确认板级兼容性、且原片内固件和外置 SPI Flash 都已备份的样机可以使用这套测试固件。通过 SWD 把 `bootloader/leden.hex` 写到内部 Flash 起始位置。Bootloader 在没有可启动应用时会枚举为 USB 串口升级设备。此后用普通 USB 数据线写入 `usb-app/leden.bin`。

以下是从仓库根目录构建两种映像的命令。工具链与普通固件相同。

```sh
cmake -S firmware -B out/bootloader -G Ninja -DCMAKE_BUILD_TYPE=Debug -DMULTIPAD_IMAGE=bootloader
cmake --build out/bootloader
cmake -S firmware -B out/usb-app -G Ninja -DCMAKE_BUILD_TYPE=Debug -DMULTIPAD_IMAGE=usb-app
cmake --build out/usb-app
```

单独运行的 `standalone` 固件仍从 `0x08000000` 启动。它的 BIN 用于 SWD 单独烧录，USB 升级器会拒绝这个装载地址。

## 日常升级与恢复

用 USB 连上键盘，在新版 MultiPad 上位机点 **USB 升级**，选择 `out/usb-app/leden.bin`。也可以退出上位机，在 `app/` 目录执行：

```sh
pnpm firmware:update ../out/usb-app/leden.bin
```

应用握手返回升级能力标识后，上位机才请求切换。Bootloader 使用独立的 USB 设备 ID，并通过 CDC 返回每个数据块的写入状态。升完以后上位机重新连接并检查握手。

需要手动进入恢复模式时，按住工程中编码器 1 的按压键（PE10）再给键盘上电。应用损坏或内部 Flash 没有应用时，Bootloader 也会一直保持在升级模式。

## 内部 Flash 布局

| 用途 | 起始地址 | 容量或说明 |
| --- | --- | --- |
| Bootloader | `0x08000000` | 32 KiB |
| 运行中的应用 | `0x08008000` | 224 KiB |
| 暂存映像 | `0x08040000` | 224 KiB |
| 当前应用记录 | `0x0807F000` | 2 KiB |
| 待写入标记 | `0x0807F800` | 2 KiB |

新映像先完整写入暂存区，校验向量和 CRC32，再设置待写入标记。复位后，Bootloader 校验并写入应用区，验证成功再清除标记。标记保留期间，启动后可以重新校验和写入。升级过程只写片内 Flash。

## 实机记录

- 同一台键盘通过 SWD 安装 Bootloader，再通过 USB 装入首个应用。第二次由正在运行的应用切换至升级模式并通过 USB 写入同一构建。两次升级后 Windows 重新枚举 HID 和正常 CDC。
- 安装后的 MultiPad 也通过「USB 升级」入口完成第三次实机升级。升级后自动重连并恢复三屏显示，本机配置保持一致。
- 升级前后回读的三屏素材与原外置 Flash 备份逐字节一致。
- CRC32 用于校验传输完整性。此版本供开发实测，镜像签名、固件版本回退策略和人为断电测试仍待验证。
