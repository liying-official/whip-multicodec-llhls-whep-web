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
  | H.264 / HEVC(H.265) / AV1 / VP9
  | WHIP 音频通常为 Opus；RTMP 音频通常为 AAC
  | 零视频转码
  | H.264 / HEVC：Low-Latency HLS，约 5 秒播放安全缓存
  | AV1 / VP9：浏览器支持 MSE 时优先 LL-HLS，否则 WHEP / WebRTC
  | WHEP 信令：私有网卡 IPv4:8889
  v
HLS 127.0.0.1:8888 + WHEP 私网 8889
  v
内部 Web/HLS/WHEP 安全网关 127.0.0.1:8080
  v
Caddy 安全边缘
  | 本机 TCP/443：HTTP/1.1 + HTTP/2
  | 本机 UDP/443：HTTP/3 / QUIC
  | 公网 TCP/UDP PUBLIC_HTTPS_PORT 同时映射到本机 443
  | TLS 1.3 ONLY
  v
https://你的域名[:PUBLIC_HTTPS_PORT]/

兼容性策略
----------
本版本不再强制 QUIC-only。

支持：
  本机 TCP/443  -> HTTP/1.1 / HTTP/2 -> TLS 1.3
  本机 UDP/443  -> HTTP/3 / QUIC     -> TLS 1.3
  公网 TCP/UDP PUBLIC_HTTPS_PORT -> 本机同协议 443

因此：
- 支持 HTTP/3 的浏览器可以使用 QUIC。
- QUIC 被网络阻断时，可以回退到同一公网端口的 TCP HTTP/2 或 HTTP/1.1。
- 不允许 TLS 1.2 或更旧 TLS 版本。
- 不开放明文 HTTP/80。

主要特性
--------
- Debian 13 amd64 / arm64 自动识别
- H.264 / HEVC / AV1 / VP9 零视频转码
- WHIP/WHEP Opus 音频；RTMP/AAC 由 LL-HLS 保留
- WHIP 首帧等待提高到 15 秒，适配软件 x264 / SVT-AV1 启动延迟
- RTMP/1935 软件编码器兼容入口
- 随附 MediaMTX v1.19.3-r8：修复 AOM AV1 Enhanced RTMP 空 sequence-start，并归一化 OBS/libdatachannel 的 AV1 OBU
- 后台进程自检等待 fork/exec 完成，避免 Caddy 尚未写日志时被误判为启动失败
- AV1 / VP9 自动在 LL-HLS 与同源 WHEP 间选择，兼顾 AAC 声音与浏览器解码能力
- HLS 主清单连续返回 HTTP 5xx 时自动改走 WHEP，不再无限停留在 manifestLoadError
- 每次新建 WHEP 会话前重新读取当前 HLS 编码；OBS 不同编码热切换后无需刷新页面即可更新标签与能力判断
- 自动模式无直播时按 5/10/20/30/60 秒退避探测，不再每约 9 秒持续新建 HLS session
- WHEP 把分离到达的音频/视频轨合并为同一个播放流，避免后到轨道覆盖先到轨道
- 网页显式“开启声音”按钮，并诊断静音、缺少音频轨和 AAC/WHEP 不兼容
- WHEP 会话 Location 重写及页面切换/关闭时的 DELETE 清理
- 公网 WHEP 按真实来源 IP 限制：10 次创建/10 秒、30 次创建/分钟、最多 5 个活动会话
- WHEP create 在计入任何配额前强制 MIME `application/sdp`；HTML form/text/plain 跨站 POST 返回 415 且不消耗限流额度
- 活动 WHEP 会话绑定创建者 IP，并使用 60 秒心跳 + 5 分钟僵尸计数回收
- MediaMTX 原始 WHEP 错误不再返回观众；编码不支持通过安全错误分类继续触发 LL-HLS fallback
- MediaMTX HLS 4xx/5xx 原始正文也在 loopback helper 层清洗；只保留状态码和固定安全文案
- /hls.min.js 使用 `public, max-age=0, must-revalidate`，浏览器可缓存但每次会重新验证，依赖安全更新可立即生效
- 播放器显示网络、编码器、MSE 和 WebRTC 错误，不再静默黑屏
- 正常网络约 5 秒目标直播缓存；持续低缓冲/低吞吐时自动切换约 8 秒弱网稳定缓冲模式
- 弱网检测带 8 秒起播预热，避免把首次 waiting 误判为网络故障；恢复稳定后再自动退出弱网模式
- HLS 服务端使用约 2 秒媒体段和 1 秒 CMAF part，并保留 24 个媒体段，为短时断网/抖动恢复提供更大的追赶窗口
- LL-HLS / WHEP 双路径音画同步保护，弱网恢复后自动校正持续 A/V 漂移
- Web/HLS/WHEP 信令统一使用 PUBLIC_HTTPS_PORT；默认 443，也支持公网非标准端口
- HTTP/3 Alt-Svc 使用 PUBLIC_HTTPS_PORT，不再错误通告服务器内网监听端口
- HTTP/1.1 + HTTP/2 + HTTP/3
- TLS 只允许 TLS 1.3
- QUIC 0-RTT disabled
- Host/SNI 严格一致性检查（handler-level 421；不泄漏 Server/Via）
- HSTS / CSP / X-Frame-Options / nosniff / Referrer-Policy
- Permissions-Policy / COOP / CORP
- 413 等 Caddy error route 与正常响应使用同一组完整安全头
- 网页无 inline JavaScript/CSS，CSP 不需要 unsafe-inline
- 公网路径白名单：只暴露播放器文件和 /live/*
- 后端 8080、8888 只绑定 loopback
- 内部网关对 Web/HLS 只接受 GET/HEAD；WHEP 仅接受受控 POST/PATCH/DELETE/心跳，请求头上限 16 KiB
- 基础每 IP 请求频率保护
- MediaMTX HLS CORS 通配符关闭
- 手工启动每次轮换 128-bit OBS 推流码；systemd 故障重启复用 root-only 凭据
- OBS WHIP 地址在启动时自动选择已启用的 RFC1918 网卡，优先使用默认路由私网地址
- WHIP/8889 与 RTMP/1935 只绑定识别出的 WHIP_IP，不使用 wildcard 监听
- PUBLIC_HOST 为必填 A-only DNS 域名；启动前验证域名格式、IPv4 A 记录并拒绝原生 IPv6/AAAA，支持动态公网 IPv4/DDNS
- 发布白名单强制生成为该网卡的真实局域网段 + WHIP_IP/32 本机地址
- 发布账号同时校验随机密码和自动生成的来源白名单
- config.env 严格按数据解析，不作为 root shell 代码执行
- 公网 WHEP 创建只允许 POST；会话控制仅允许 PATCH/DELETE，播放器心跳使用带专用头的 POST；请求体上限 256 KiB
- WHEP 创建必须是 `Content-Type: application/sdp`（允许合法 MIME 参数）；其他类型在限流计数前直接 415
- WHEP 创建采用滚动窗口：单 IP 10 次/10 秒、30 次/60 秒；同时最多 5 个活动会话
- 可选 systemd 管理器支持开机启动和 Caddy/Gateway 进程退出后的整组重启；沙箱允许自动网卡探测所需的 AF_NETLINK；凭据存放于 root-only 文件且不写 journal

DNS
---
现在不再要求 HTTPS/SVCB RR。

最基础只需要：

  live.example.com. 300 IN A 203.0.113.10

PUBLIC_DOMAIN 如需 IPv6 可增加 AAAA；PUBLIC_HOST 必须保持 A-only。

如果 DNS 服务商支持 HTTPS/SVCB RR，可以额外发布 h3 能力，用于让支持的
客户端更快尝试 HTTP/3；非标准公网端口时 RR 的 port 参数必须与
PUBLIC_HTTPS_PORT 一致。即使没有该记录，浏览器仍可从正确的 Alt-Svc 通告发现 h3。

TLS 证书
--------
请准备公网可信 PEM：

  certs/fullchain.pem
  certs/privkey.pem

以上是项目目录内的通用相对默认路径；也可在 config.env 中改为管理员维护的
其他证书和私钥路径。发布包不包含实际证书或私钥。

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
  PUBLIC_HTTPS_PORT=443
  TLS_CERT=certs/fullchain.pem
  TLS_KEY=certs/privkey.pem
  WHIP_IP=
  PUBLIC_HOST=live.example.com
  INGEST_ALLOW_CIDRS=

PUBLIC_HTTPS_PORT 是观众实际访问的公网端口，不是 Caddy 本机监听端口。默认 443；
如果路由器使用非标准公网端口映射到服务器 443，则必须填写实际公网端口：

  PUBLIC_HTTPS_PORT=<PUBLIC_HTTPS_PORT>

并同时配置 TCP/<PUBLIC_HTTPS_PORT> -> TCP/443 与
UDP/<PUBLIC_HTTPS_PORT> -> UDP/443。启动信息、诊断 URL、WHEP URL 和 HTTP/3
Alt-Svc 都会使用该端口。只映射 TCP 会保留 HTTP/1.1/2，但 HTTP/3 必然不可用。

WHIP_IP 留空时，start.sh 会扫描已启用网卡，优先选择默认路由对应的 RFC1918
本机地址；多网卡服务器仍可用 WHIP_IP 明确选择某个本机私网地址。程序读取该
网卡的真实掩码，并在每次启动时把发布白名单强制生成为“接口局域网段 +
WHIP_IP/32 本机地址”。旧版 INGEST_ALLOW_CIDRS 手工值会被忽略，不能扩大范围。
无法找到私网网卡、指定公网地址或无法读取掩码时，启动会失败关闭。config.env
只接受文档列出的 KEY=VALUE，不执行 shell。

PUBLIC_HOST 现在为必填项，必须填写公网 DNS 域名，例如：

  PUBLIC_HOST=live.example.com

不要填写 http:// / https://、端口或裸 IPv4/IPv6 地址。公网 IPv4 可以动态变化；
只要 DDNS 持续更新该域名的 IPv4 A 记录即可。PUBLIC_HOST 不允许 AAAA；主站需要 IPv6 时请使用独立 A-only WebRTC 子域名。start.sh 会在启动前验证 PUBLIC_HOST
非空、域名格式合法，并且当前至少能解析出一个 IPv4 A 记录；任一条件不满足都会
直接拒绝启动，以免 WHEP 生成不可用的公网 ICE candidate。

安装目录安全要求
--------------------
start.sh 会以 root 执行包内 helper、MediaMTX 和 Caddy。为防止普通本地用户在
启动前替换这些文件，项目目录、所有父目录、关键脚本/模板以及 bin/web/src/third_party
必须由 root 所有，并且 group/other 不可写。推荐部署到 /opt，例如：

  sudo cp -a <解压后的项目目录> /opt/obs-whip-live-r33
  sudo chown -R root:root /opt/obs-whip-live-r33
  sudo chmod go-w /opt/obs-whip-live-r33

从 /tmp、普通用户可写的下载目录或其他不可信父目录直接 sudo ./start.sh 会被安全拒绝。
证书路径仍可按 config.env 指向管理员管理的位置。

启动
----

手工启动（每次启动轮换推流码）：

  sudo ./start.sh

本包已经随附并固定使用：
- MediaMTX v1.19.3-r8（amd64 / arm64；AOM AV1 RTMP + WHIP/HLS 修补构建）
- Caddy v2.11.4-r33-go1.26.5（amd64 / arm64；固定源码提交、模块清单和可复现构建）
- hls.js v1.6.16

启动过程不下载 Caddy 或 hls.js，避免外网/上游服务不可用时阻塞。Caddy 随包
二进制、许可证、精确 go.mod/go.sum 与构建说明见 third_party/；hls.js 的
许可证和 npm SHA-512 完整性验证记录也保存在 third_party/。

可选 systemd 开机启动
---------------------
先按上面的安全要求安装到 /opt 或 /usr/local、填写 config.env，再执行：

  sudo ./install-systemd.sh

安装器会创建并启用 `obs-whip-live.service`。服务模式首次启动生成 root-only
`runtime/publish.credentials`，后续自动重启复用同一凭据，避免无人值守重启使
OBS 立刻失效；凭据不会输出到 journal。查看凭据：

  sudo ./show-credentials.sh

查看日志与状态：

  sudo systemctl status obs-whip-live.service
  sudo journalctl -u obs-whip-live.service

systemd 管理器监测 MediaMTX supervisor、Gateway 和 Caddy；unit 已允许
AF_NETLINK，以便 WHIP_IP 留空时 iproute2 能在沙箱内探测默认路由和网卡。Gateway/Caddy
意外退出时让 systemd 整组重启。手工 `stop.sh` 默认仍删除持久凭据并使其失效；
unit 运行时 `stop.sh` 会先正确停止 unit 再删除凭据。start.sh 会拒绝与活动 unit
并行启动。

OBS
---
WHIP（首选，地址只使用网卡 IP，不需要域名）：

  服务：WHIP
  Server：http://<LAN_IP>:8889/live/whip
  Bearer Token：start.sh 显示的 obs:<随机推流码>

TCP/8889 只在启动识别出的 WHIP_IP 上监听；来源地址只能属于该网卡的实际
局域网段或服务器本机 /32。即使上游防火墙误开放端口，公网来源也不能只凭
密码发布。

如果 x264 / SVT-AV1 在 WHIP 下仍因编码器重排或负载断开，改用兼容入口：

  服务：自定义
  Server：rtmp://<LAN_IP>:1935
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

标准端口：

  https://live.example.com/

非标准端口：

  https://live.example.com:<PUBLIC_HTTPS_PORT>/

Playlist：

  https://live.example.com[:PUBLIC_HTTPS_PORT]/live/index.m3u8

浏览器还必须能够解码 OBS 当前推送的视频编码。
H.264 兼容性通常最好；HEVC / AV1 / VP9 取决于浏览器、系统和设备能力。

播放器默认使用“自动”：
- 先从实际 HLS 主清单读取当前视频编码/profile：H.264 / H.265(HEVC) / AV1 / VP9。
- 对 LL-HLS 使用 MediaSource.isTypeSupported() + MediaCapabilities 检测。
- 对 WHEP 使用 RTCRtpReceiver.getCapabilities() + MediaCapabilities 检测。
- 自动模式优先选择浏览器明确支持的路径；LL-HLS 不支持而 WebRTC 支持时直接使用 WHEP。
- 两条路径都明确不支持时停止尝试并提示当前设备/浏览器无法解码该编码。
- 页面左上角显示当前编码、LL-HLS/WebRTC 支持状态、预计流畅性以及“硬件解码/软件解码”。
- “硬件解码/软件解码”依据 MediaCapabilities.powerEfficient 推断，不代表驱动级确认。
- HLS 连续返回 HTTP 5xx、AV1 / VP9 HLS 媒体错误或无画面时仍保留原有 WHEP 回退机制。
- 弱网 LL-HLS：正常网络保持约 5 秒目标；持续低缓冲/吞吐不足时在真正饿死前进入约 8 秒稳定缓冲模式，并把最大前向缓冲提高到 16 秒、上限提高到 24 秒。
- 弱网模式最高约 1.03x 温和追赶，正常模式最高 1.06x；只有严重落后且目标点已经缓冲时才跳回安全直播点。
- HLS manifest/playlist/fragment 使用分级超时、指数退避和有限重试；短时断网恢复时重新靠近 live edge，避免长期追逐已经过期的 LL-HLS part。
- 自动模式检测到尚无直播时不创建 hls.js 播放实例，而是按 5/10/20/30/60 秒退避重新获取主清单；流恢复或浏览器重新联网时立即探测。手动 LL-HLS 仍保留原始重试，便于诊断。
- LL-HLS 显式启用音频时间戳重整、短视频轨延展和视频空洞 nudge，降低卡顿恢复后的音画漂移。
- 弱网 WHEP：优先比较 audio/video estimatedPlayoutTimestamp 的相对基线变化；浏览器不提供时回退比较 jitter-buffer 延迟。
- WHEP 只有持续多次明显 A/V 偏移才重建会话，并带 20 秒冷却，避免网络差时反复重连。
- WHEP connectionState=disconnected 先给予 7 秒浏览器自恢复窗口；仍未恢复时按 3/5/8/12 秒退避重建，会话稳定 15 秒后清零退避级别。
- 自动模式下 WHEP 连续恢复失败且 LL-HLS 可用时可切换到 LL-HLS 稳定路径；手动选择 WHEP 时保持用户选择并继续退避恢复。
- 公网 WHEP 创建受单 IP 10/10 秒、30/60 秒和最多 5 个活动会话保护；超限返回 HTTP 429。
- 活动会话每 60 秒向同源安全网关发送一次轻量心跳；5 分钟未刷新会自动释放本地计数。
- MediaMTX 原始错误正文只在服务器侧分类，不显示给观众；播放器只显示友好错误。
- HLS 4xx/5xx 也由 helper 改成固定安全正文，且 `Cache-Control: no-store`；2xx/3xx（包括 HLS cookie redirect）保持原行为。
- 右上角可以手动切换“LL-HLS”或“WebRTC / WHEP”。
- 自动播放按浏览器要求从静音开始；点击右上角“开启声音”恢复声音。
- OBS 通过 WHIP 推送 AV1/VP9 + Opus 时，WHEP 可输出音频。
- OBS 通过 RTMP 推送时音频通常为 AAC；WHEP 不传 AAC，播放器会明确提示并建议
  切回 LL-HLS。服务器不做音频转码。
- 若观众可用带宽长期低于源直播实际码率，且服务器不做 ABR/转码，则任何播放器都无法无限避免缓冲耗尽；本版优化的是提前增加安全缓冲、短时断网容忍与恢复速度。

公网端口
--------
服务器本机监听：

  443/TCP   HTTP/1.1 + HTTP/2 / TLS 1.3
  443/UDP   HTTP/3 / QUIC / TLS 1.3

公网映射必须让两种协议使用同一个 PUBLIC_HTTPS_PORT：

  PUBLIC_HTTPS_PORT/TCP -> 服务器 443/TCP
  PUBLIC_HTTPS_PORT/UDP -> 服务器 443/UDP

默认 PUBLIC_HTTPS_PORT=443。若填写其他端口，观众 URL 必须带
`:<PUBLIC_HTTPS_PORT>`，Caddy 会通告相同端口的 HTTP/3 Alt-Svc；不能把公网
TCP 与 UDP 映射到不同端口。

不需要开放：

  80/TCP
  8080/TCP
  8888/TCP
  9998/TCP  MediaMTX metrics，仅监听 127.0.0.1，供监控读取

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
使用 systemd 时执行 `sudo systemctl restart obs-whip-live.service`；服务模式复用
root-only 凭据，不会因证书重载自动更换 OBS 密码。要主动轮换，先停止 unit，
运行 `sudo ./stop.sh` 删除凭据，再执行 `sudo systemctl start obs-whip-live.service`。


版本与发布说明
--------------
当前版本的更新内容统一写在对应的 GitHub Release 介绍页面。运行包不包含更新
日志、历史调试报告或测试环境记录，避免旧参数被误认为当前部署要求。
当前操作始终以本 README、SECURITY.txt、OBS-COMPATIBILITY.txt 和
CODEC-SUPPORT.txt 为准。
