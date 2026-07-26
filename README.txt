OBS WHIP 多编码直播服务器 - Debian 13 TLS 1.3 公网兼容版
==========================================================

公网播放架构：

OBS
  | 首选：HTTP WHIP 信令 -> 私有网卡 IPv4:8889
  |       WebRTC 媒体 -> DTLS-SRTP / UDP/TCP 8189
  | 兼容：RTMP -> 私有网卡 IPv4:1935
  | 发布同时要求随机密码 + RFC1918 来源 CIDR
  v
MediaMTX
  | H.264 / HEVC(H.265) / AV1
  | WHIP 音频通常为 Opus；RTMP 音频通常为 AAC
  | 零视频转码
  | H.264 / HEVC：Low-Latency HLS，约 5 秒播放安全缓存
  | AV1：浏览器支持 MSE 时优先 LL-HLS，否则 WHEP / WebRTC
  v
127.0.0.1:8888
  v
内部 Web/HLS 网关 127.0.0.1:8080
  v
Caddy 安全边缘
  | TCP/443：HTTP/1.1 + HTTP/2
  | UDP/443：HTTP/3 / QUIC
  | TLS 1.3 ONLY
  v
https://你的域名/

兼容性策略
----------
本版本不再强制 QUIC-only。

支持：
  TCP/443  -> HTTP/1.1 / HTTP/2 -> TLS 1.3
  UDP/443  -> HTTP/3 / QUIC     -> TLS 1.3

因此：
- 支持 HTTP/3 的浏览器可以使用 QUIC。
- QUIC 被网络阻断时，可以回退到 TCP/443 的 HTTP/2 或 HTTP/1.1。
- 不允许 TLS 1.2 或更旧 TLS 版本。
- 不开放明文 HTTP/80。

主要特性
--------
- Debian 13 amd64 / arm64 自动识别
- H.264 / HEVC / AV1 零视频转码
- WHIP/WHEP Opus 音频；RTMP/AAC 由 LL-HLS 保留
- WHIP 首帧等待提高到 15 秒，适配软件 x264 / SVT-AV1 启动延迟
- RTMP/1935 软件编码器兼容入口
- 随附 MediaMTX v1.19.3-r8：修复 AOM AV1 Enhanced RTMP 空 sequence-start，并归一化 OBS/libdatachannel 的 AV1 OBU
- 后台进程自检等待 fork/exec 完成，避免 Caddy 尚未写日志时被误判为启动失败
- AV1 自动在 LL-HLS 与同源 WHEP 间选择，兼顾 AAC 声音与浏览器解码能力
- HLS 主清单连续返回 HTTP 5xx 时自动改走 WHEP，不再无限停留在 manifestLoadError
- WHEP 把分离到达的音频/视频轨合并为同一个播放流，避免后到轨道覆盖先到轨道
- 网页显式“开启声音”按钮，并诊断静音、缺少音频轨和 AAC/WHEP 不兼容
- WHEP 会话 Location 重写及页面切换/关闭时的 DELETE 清理
- 播放器显示网络、编码器、MSE 和 WebRTC 错误，不再静默黑屏
- 约 5 秒直播缓存，应对网络波动
- Web 与 HLS 公网统一为 HTTPS 443
- HTTP/1.1 + HTTP/2 + HTTP/3
- TLS 只允许 TLS 1.3
- QUIC 0-RTT disabled
- strict SNI host
- HSTS / CSP / X-Frame-Options / nosniff / Referrer-Policy
- Permissions-Policy / COOP / CORP
- 网页无 inline JavaScript/CSS，CSP 不需要 unsafe-inline
- 公网路径白名单：只暴露播放器文件和 /live/*
- 后端 8080、8888 只绑定 loopback
- 内部 Web/HLS 网关只接受 GET/HEAD，请求头上限 16 KiB
- 基础每 IP 请求频率保护
- MediaMTX HLS CORS 通配符关闭
- 每次启动轮换 128-bit OBS 推流码
- OBS WHIP 地址在启动时自动选择已启用的 RFC1918 网卡，优先使用默认路由私网地址
- WHIP/8889 与 RTMP/1935 只绑定识别出的 WHIP_IP，不使用 wildcard 监听
- 发布白名单强制生成为该网卡的真实局域网段 + WHIP_IP/32 本机地址
- 发布账号同时校验随机密码和自动生成的来源白名单
- config.env 严格按数据解析，不作为 root shell 代码执行
- 公网 WHEP 只允许 POST/PATCH/DELETE，请求体上限 256 KiB

DNS
---
现在不再要求 HTTPS/SVCB RR。

最基础只需要：

  live.example.com. 300 IN A 203.0.113.10

有 IPv6 时增加 AAAA。

如果 DNS 服务商支持 HTTPS/SVCB RR，可以额外发布 h3 能力，用于让支持的
客户端更快尝试 HTTP/3；即使没有该记录，TCP/443 回退仍然可以正常访问。

TLS 证书
--------
请准备公网可信 PEM：

  certs/fullchain.pem
  certs/privkey.pem

start.sh 会检查：
- 证书与私钥匹配
- 证书尚未过期
- 剩余有效期至少 24 小时
- SAN 覆盖 PUBLIC_DOMAIN

TLS 协议被固定为：

  Min TLS = 1.3
  Max TLS = 1.3

因此 TLS 1.2 客户端会被拒绝。

配置
----
编辑 config.env：

  PUBLIC_DOMAIN=live.example.com
  TLS_CERT=certs/fullchain.pem
  TLS_KEY=certs/privkey.pem
  WHIP_IP=
  INGEST_ALLOW_CIDRS=

WHIP_IP 留空时，start.sh 会扫描已启用网卡，优先选择默认路由对应的 RFC1918
本机地址；多网卡服务器仍可用 WHIP_IP 明确选择某个本机私网地址。程序读取该
网卡的真实掩码，并在每次启动时把发布白名单强制生成为“接口局域网段 +
WHIP_IP/32 本机地址”。旧版 INGEST_ALLOW_CIDRS 手工值会被忽略，不能扩大范围。
无法找到私网网卡、指定公网地址或无法读取掩码时，启动会失败关闭。config.env
只接受文档列出的 KEY=VALUE，不执行 shell。

OBS 位于 NAT 后，或公网 WHEP 观众需要 WebRTC ICE 公网候选时：

  PUBLIC_HOST=你的公网IP或域名

启动
----

  sudo ./start.sh

本包已经随附并固定使用：
- MediaMTX v1.19.3-r8（amd64 / arm64；AOM AV1 RTMP + WHIP/HLS 修补构建）

第一次启动会从官方发布源下载并校验其余依赖：
- hls.js v1.6.16
- 当前最新稳定 Caddy

下载一次后会保存在本地。

OBS
---
WHIP（首选，地址只使用网卡 IP，不需要域名）：

  服务：WHIP
  Server：http://192.168.1.10:8889/live/whip
  Bearer Token：start.sh 显示的 obs:<随机推流码>

TCP/8889 只在启动识别出的 WHIP_IP 上监听；来源地址只能属于该网卡的实际
局域网段或服务器本机 /32。即使上游防火墙误开放端口，公网来源也不能只凭
密码发布。

如果 x264 / SVT-AV1 在 WHIP 下仍因编码器重排或负载断开，改用兼容入口：

  服务：自定义
  Server：rtmp://192.168.1.10:1935
  Stream key：live?user=obs&pass=<start.sh 显示的随机推流码>

注意：RTMP 的 Stream key 只填 live?user=obs&pass=...，不加 obs:。

建议配置：

  x264：
    CBR，关键帧间隔 1～2 秒，B 帧 0，repeat headers，
    preset veryfast 或更快，tune zerolatency。

  SVT-AV1（WHIP）：
    必须使用 CBR，使 OBS 进入 low-delay P 预测结构；
    关键帧间隔 1～2 秒，8-bit 4:2:0。

  AOM AV1：
    CBR，关键帧间隔 1～2 秒，8-bit 4:2:0。
    关键帧间隔不能使用 0/自动；HLS/CMAF 必须定期收到 KEY_FRAME 才能切段。
    网页“自动”模式会检测 av01：浏览器声明支持 MSE AV1 时先使用 LL-HLS；
    若清单连续返回 HTTP 5xx 或无法形成画面，会自动切到 WebRTC / WHEP。

软件编码器首次排障建议从 1920x1080、30 FPS 开始。若 OBS 日志出现
“Encoding queue duration surpassed 5 seconds”，是本机编码器过载，应降低分辨率/
帧率或使用更快 preset；服务器无法修复本机来不及编码的问题。

完整参数和故障对应关系见 OBS-COMPATIBILITY.txt。

公网播放
--------

  https://live.example.com/

Playlist：

  https://live.example.com/live/index.m3u8

浏览器还必须能够解码 OBS 当前推送的视频编码。
H.264 兼容性通常最好；HEVC / AV1 取决于浏览器、系统和设备能力。

播放器默认使用“自动”：
- 检测到 H.264 / HEVC 时使用 LL-HLS。
- 检测到 AV1 且浏览器明确支持 MSE AV1 时，先使用 LL-HLS（可保留 RTMP/AAC）。
- 浏览器未声明 MSE AV1 支持、HLS 连续返回 HTTP 5xx，或 12 秒内无画面时，自动切到 WHEP/WebRTC。
- 右上角可以手动切换“LL-HLS”或“WebRTC / AV1”。
- 自动播放按浏览器要求从静音开始；点击右上角“开启声音”恢复声音。
- OBS 通过 WHIP 推送 AV1+Opus 时，WHEP 可输出音频。
- OBS 通过 RTMP 推送时音频通常为 AAC；WHEP 不传 AAC，播放器会明确提示并建议
  切回 LL-HLS。服务器不做音频转码。

公网端口
--------
Web / HLS：

  443/TCP   HTTP/1.1 + HTTP/2 / TLS 1.3
  443/UDP   HTTP/3 / QUIC / TLS 1.3

不需要开放：

  80/TCP
  8080/TCP
  8888/TCP

OBS 发布控制通道（只允许启动时识别出的同网段局域网和服务器本机）：

  8889/TCP  HTTP WHIP 信令，只绑定 WHIP_IP
  1935/TCP  RTMP 兼容推流，只绑定 WHIP_IP

WebRTC 加密媒体（不是发布信令端口）：

  8189/UDP  DTLS-SRTP 媒体
  8189/TCP  DTLS-SRTP 媒体回退

公网 WHEP 观众需要访问 8189；只使用 LL-HLS 时可以不向公网开放 8189。

注意：网卡 IP 推流不使用 PUBLIC_DOMAIN。WHIP/8889 是明文 HTTP，RTMP/1935
也是明文协议，凭据可能被同网段监听；仅用于启动识别出的可信局域网，程序本身会按启动时检测的局域网段和本机 /32 拒绝其他来源，防火墙仍应明确禁止公网访问。WebRTC 媒体通过 UDP/TCP 8189 上的 DTLS-SRTP 加密。

管理
----
停止：
  sudo ./stop.sh

状态：
  sudo ./status.sh

诊断：
  sudo ./diagnose.sh

证书续期后重新运行 sudo ./start.sh 即可重新加载证书，同时会轮换 OBS 推流码。
