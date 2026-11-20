# MultiPad 效率键盘

Windows 上位机和 STM32 固件在同一仓库维护。涉及 USB 协议的改动可以在同一个 PR 内修改两端。

| 目录 | 内容 | 上游基线 |
| --- | --- | --- |
| [app](app/) | Electron / Vue 上位机 | [iLx11/key-pad-application](https://github.com/iLx11/key-pad-application) · `e2844bf` |
| [firmware](firmware/) | STM32F103VETx 固件 | [iLx11/multi-pad](https://github.com/iLx11/multi-pad) · `78c1ee5` |

## 本地构建

- 上位机在 `app/` 运行 `pnpm install` 后，可用 `pnpm start` 启动开发窗口，或用 `pnpm electron:build` 打包。仓库导入前，本机已成功打包 Windows x64 并连接实机。上游 TypeScript 全量检查仍有历史报错。
- 固件在 `firmware/` 使用 Arm GNU Embedded Toolchain 10.3-2021.10、CMake 3.28.1 和 Ninja。将工具加入当前终端的 PATH，在仓库根目录运行：

  ```sh
  cmake -S firmware -B out/firmware -G Ninja -DCMAKE_BUILD_TYPE=Debug
  cmake --build out/firmware
  ```

  编译会生成 `leden.elf`、`leden.hex` 和 `leden.bin`。公开固件基线已编译通过，实机刷写与板级兼容性待验证。

## 维护

- 建议用功能分支和 PR 合并到 `main`。跨端改动记录协议版本和验证过的设备。
- 从 Git Tag 发布。上位机可以用 `app-v*`，固件可以用 `fw-v*`。协议相关 Release 在说明里链接配套版本，附对应构建产物和实机验证结果。
- 原作者的历史和 [GPL-3.0 许可证](LICENSE)保留。分发二进制时提供对应源码和构建脚本。
- [屏幕回读设计](docs/screen-readback.md)。
