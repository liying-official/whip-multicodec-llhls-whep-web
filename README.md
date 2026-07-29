# OBS WHIP 多编码 LL-HLS/WHEP 直播边缘

[English](README.en.md) | 简体中文

面向 Debian 13 的低延迟、零视频转码直播边缘服务。OBS 通过可信局域网使用
WHIP 或 RTMP 发布，浏览器通过公网 TLS 1.3 使用 LL-HLS 或 WHEP/WebRTC 播放。

当前版本：**R33 Runtime Audit Fixes**

## 主要特性

- H.264、H.265/HEVC、AV1、VP9 零视频转码
- WHIP/WHEP + Opus；RTMP + AAC/LL-HLS
- LL-HLS 与 WHEP 自动能力检测、回退和编码热切换
- HTTP/1.1、HTTP/2、HTTP/3；仅允许 TLS 1.3，禁用 QUIC 0-RTT
- 支持 `PUBLIC_HTTPS_PORT`，公网 TCP/UDP 非标准端口可同时映射到本机 443
- WHIP/8889 与 RTMP/1935 只绑定启动时识别的 RFC1918 私网网卡
- 发布同时校验随机密码、接口真实局域网段和服务器本机 `/32`
- WHEP MIME、请求体、速率、活动会话、来源 IP 和心跳保护
- Host/SNI 严格校验，正常及错误响应使用一致的安全头并移除 `Server`/`Via`
- 可选 systemd 服务、进程沙箱、自动恢复和 root-only 持久发布凭据
- Debian 13 amd64 与 arm64 完整运行包

R33 固定使用：

- MediaMTX `v1.19.3-r8`，包含 AOM AV1 RTMP/WHIP/HLS 兼容修复
- Caddy `v2.11.4-r33-go1.26.5`，使用固定源码提交和模块图构建
- hls.js `v1.6.16`，随包提供，不在启动时从网络下载

## 数据链路

```text
OBS
 ├─ WHIP / WebRTC ─┐
 └─ RTMP ──────────┤
                    ▼
          patched MediaMTX
            ├─ LL-HLS ── secure gateway ── Caddy ── Browser
            └─ WHEP / WebRTC ────────────── Caddy ── Browser
```

服务器不转码。浏览器必须能够解码 OBS 当前输出的编码；H.264 通常具有最广泛的
兼容性。AOM AV1 的关键帧间隔必须设置为 1～2 秒，不能使用 `0/自动`。

## 快速部署

1. 从 [GitHub Releases](https://github.com/liying-official/whip-multicodec-llhls-whep-web/releases)
   下载 R33 Debian 13 完整包和对应 `.sha256` 文件。
2. 校验 SHA-256，解压后把项目安装到 `/opt` 或 `/usr/local` 下由 root 管理的目录。
3. 编辑 `config.env`：

   ```text
   PUBLIC_DOMAIN=live.example.com
   PUBLIC_HTTPS_PORT=443
   TLS_CERT=certs/fullchain.pem
   TLS_KEY=certs/privkey.pem
   WHIP_IP=
   INGEST_ALLOW_CIDRS=
   PUBLIC_HOST=rtc.example.com
   ```

   `PUBLIC_HOST` 必须是能够解析 IPv4 A 记录、但没有 AAAA 记录的 DNS 域名。
   `WHIP_IP` 留空时会优先选择默认路由对应的 RFC1918 私网地址。
   `INGEST_ALLOW_CIDRS` 仅为旧版兼容项，手工值不会扩大发布范围。

4. 放置公网可信 PEM 证书及私钥，确保项目目录和关键文件不可被普通用户写入。
5. 安装并启用 systemd 服务：

   ```sh
   sudo ./install-systemd.sh
   sudo systemctl status obs-whip-live.service
   sudo ./show-credentials.sh
   ```

也可以使用 `sudo ./start.sh` 手工运行；手工启动每次都会轮换发布凭据。

## OBS 参数

WHIP（推荐）：

```text
Server:       http://<LAN_IP>:8889/live/whip
Bearer Token: obs:<show-credentials.sh 显示的随机密码>
```

RTMP 兼容入口：

```text
Server:     rtmp://<LAN_IP>:1935
Stream key: live?user=obs&pass=<随机密码>
```

建议从 H.264、CBR、1～2 秒关键帧、关闭 B 帧开始验证。软件编码器首次排障建议使用
1920×1080、30 FPS；服务器无法修复 OBS 本机编码队列过载。

## 网络端口

| 端口 | 用途 | 暴露范围 |
| --- | --- | --- |
| TCP/443 | HTTPS、HTTP/1.1、HTTP/2 | 公网 |
| UDP/443 | HTTP/3 / QUIC | 公网 |
| UDP/TCP 8189 | WHEP WebRTC 加密媒体 | 使用 WHEP 时公网 |
| TCP/8889 | OBS WHIP 信令 | 可信局域网 |
| TCP/1935 | OBS RTMP 兼容推流 | 可信局域网 |
| TCP/8080、8888、9998 | 内部网关、HLS、指标 | 仅 loopback |

如果公网使用非标准 HTTPS 端口，必须把同一个公网 TCP/UDP 端口映射到服务器
TCP/UDP 443，并在 `PUBLIC_HTTPS_PORT` 中填写该公网端口。

## R33 默认限流规则

R33 的默认限流按安全网关识别到的真实来源 IP 分别计数：

| 流量类型 | 默认规则 | 超限行为 |
| --- | --- | --- |
| Web 与 LL-HLS GET/HEAD | 每个 IP 每分钟 6,000 个请求（固定窗口） | HTTP 429，`Retry-After: 10` |
| WHEP 会话创建 POST | 每个 IP 滚动窗口 10 次/10 秒且 30 次/60 秒 | HTTP 429 |
| WHEP 活动会话 | 每个 IP 最多 5 个 | HTTP 429 |

Web/LL-HLS 与 WHEP 限流表各自最多追踪 20,000 个来源 IP。WHEP create 在计入
配额前必须先通过 `application/sdp` MIME 校验，请求体上限为 256 KiB；会话使用
60 秒心跳，连续 5 分钟未刷新时回收。以上是 R33 内置默认值，不是公网带宽上限。

## 文档

- [完整部署与运行说明](README.txt)
- [R33 双轮压力测试报告（中文）](docs/pressure-test-report-r33-20260730-zh.md)
- [OBS 编码器兼容参数](OBS-COMPATIBILITY.txt)
- [编码与传输能力](CODEC-SUPPORT.txt)
- [安全模型](SECURITY.txt)
- [防火墙与端口](FIREWALL.txt)
- [DNS 配置](DNS-SETUP.txt)
- [源码构建](BUILDING.md)

版本更新内容只发布在对应的 GitHub Release 页面。完整运行包不包含更新日志或历史
调试报告，包内文档只描述当前版本的部署和运行方式。

## 源码、二进制与许可证

- `src/`：Go 安全网关与辅助程序
- `web/`：HTML、CSS、原生 JavaScript 播放器及固定版本 hls.js
- `patches/`：MediaMTX 与 gortmplib 的可复现兼容补丁
- `third_party/`：第三方许可证、版本、模块图和构建记录
- `tools/`：OBS/libdatachannel 行为模拟与回归测试工具

预编译 Linux 二进制不提交到 Git 历史，只通过 Releases 提供。项目自有代码使用
[MIT License](LICENSE)；第三方组件许可证保存在 `third_party/`。
