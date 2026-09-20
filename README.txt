WHIP 多编码 LL-HLS/WHEP 直播服务
-----------------------------

English: README.en.md | 简体中文: README.md

低延迟、零视频转码直播服务。兼容的推流客户端通过可信局域网使用
WHIP 或 RTMP 发布，浏览器通过公网 TLS 1.3 使用 LL-HLS 或 WHEP/WebRTC 播放。
项目不限定推流软件；客户端需满足协议、编码及认证要求。

当前版本：v1.35

主要特性
--------

- H.264、H.265/HEVC、AV1、VP9 零视频转码
- WHIP/WHEP + Opus；RTMP + AAC/LL-HLS
- WHEP 显式协商 Opus stereo=1;sprop-stereo=1，保持 Chromium 左右声道播放
- LL-HLS 与 WHEP 自动能力检测、回退和编码热切换
- LL-HLS 区分带宽/丢包与RTT弱网，使用12s目标延迟和实际8s/6s缓冲READY迟滞；只有RTT类改用完整媒体段
- hls.js 1.7.3 的 SourceBuffer 写入超时、停滞清单检测及自动 MediaSource 重建用于弱网故障恢复；追回速度始终不超过 1.05x
- HTTP/1.1、HTTP/2、HTTP/3；仅允许 TLS 1.3，禁用 QUIC 0-RTT
- 支持 PUBLIC_HTTPS_PORT，公网 TCP/UDP 非标准端口可同时映射到本机 443
- WHIP/8889 与 RTMP/1935 只绑定启动时识别的 RFC1918 私网网卡
- 发布同时校验随机密码、接口真实局域网段和服务器本机 /32
- WHEP MIME、请求体、速率、活动会话、来源 IP 和心跳保护
- 公网 WHEP SDP 仅保留已验证的 PUBLIC_HOST IPv4 ICE 候选；可信本地 IPv4 请求可额外获得精确 WHIP_IP 候选，无允许候选时失败关闭
- 匿名 Web/HLS 路径会移除浏览器认证头和无关 Cookie；上游错误正文不进入页面或浏览器日志
- Host authority（含公网端口）/SNI 严格校验，正常及错误响应使用一致的安全头并移除 Server/Via
- 可选 systemd 服务、只读程序树、强化进程沙箱、自动恢复和 root-only 持久发布凭据
- Linux amd64 与 arm64 完整运行包

v1.35 固定使用：

- MediaMTX v1.21.0-r11，在 v1.21.0 安全基线上重放并回归 AOM AV1 RTMP/WHIP/HLS 兼容修复
- Caddy v2.11.4-V1.35-go1.27.1-fix8v9，使用固定源码提交和模块图构建
- helper、MediaMTX 与 Caddy 均使用 Go 1.27.1 构建
- hls.js v1.7.3，随包提供并校验 npm 签名/provenance，不在启动时从网络下载

数据链路
--------
推流客户端
 ├─ WHIP / WebRTC ─┐
 └─ RTMP ──────────┤
                    ▼
          patched MediaMTX
            ├─ LL-HLS ── secure gateway ── Caddy ── Browser
            └─ WHEP signaling ─ secure gateway ── Caddy ── Browser
                 WebRTC media (DTLS-SRTP) ─────────────── Browser

服务器不转码。浏览器必须能够解码推流端当前输出的编码；H.264 通常具有最广泛的
兼容性。AOM AV1 的关键帧间隔必须设置为 1～2 秒，不能使用 0/自动。

快速部署
--------

代码已在 Debian 13 / Ubuntu 26.04 环境下测试通过；其他兼容的 Linux 发行版可自行测试部署。
运行包包含 Linux amd64 / arm64 二进制，启动脚本按 CPU 架构选择。需要 root 权限、
系统 CA 信任库、iproute2（ip / ss）、getent、GNU coreutils（含 timeout、
sha256sum）、常用 shell 工具和 tar / gzip；服务安装还需要运行中的 systemd、
systemd-analyze、systemd-notify、systemctl 和 flock。使用预编译包无需安装 Go。

1. 从 GitHub Releases（https://github.com/liying-official/whip-multicodec-llhls-whep-web/releases）
   下载 v1.35 完整运行包及同一发布提供的 .sha256 文件。以下命令使用本次交付的规范文件名；
   文件名中的平台与构建标签不表示发行版兼容范围。
2. 在下载目录执行下列命令。此流程仅适用于 /opt/obs-whip-live 不存在的首次安装；
   已有部署使用后面的“卸载与重装”流程。目录已存在时 mkdir 会失败，不能继续覆盖解压。
   set -eu
   archive='obs-whip-multicodec-llhls-web-debian13-v1.35-weak-network-fix12.tar.gz'
   sha256sum -c "$archive.sha256"
   sudo mkdir -m 0755 /opt/obs-whip-live
   sudo tar -xzf "$archive" -C /opt/obs-whip-live --strip-components=1 --same-owner --same-permissions
   cd /opt/obs-whip-live
   sudo sha256sum -c SHA256SUMS

   包内 SHA256SUMS 应在修改配置前全部通过。解压使用包内 root 所有权与文件权限；
   项目和所有父目录必须由 root 管理、不能被组或其他用户写入，项目路径不能含符号链接。
   不要从 /tmp 或普通用户可写的下载目录直接运行 root 启动脚本。
3. 在 /opt/obs-whip-live 中执行 sudoedit config.env，逐项核对并替换为自己的环境：
   PUBLIC_DOMAIN=live.example.com
   PUBLIC_HTTPS_PORT=443
   TLS_CERT=certs/fullchain.pem
   TLS_KEY=certs/privkey.pem
   WHIP_IP=
   INGEST_ALLOW_CIDRS=
   PUBLIC_HOST=rtc.example.com

   包内 config.env 是未配置模板：站点域名、WebRTC 域名和网卡地址留空，
   HTTPS 公网端口默认为 443。必须先填写自己的 PUBLIC_DOMAIN 和 PUBLIC_HOST；
   未配置时安装器和启动脚本会拒绝运行。上述域名仅为部署示例。
   WHIP_IP 留空时，优先选择默认路由对应的已启用 RFC1918 私网地址；也可明确选择
   本机私网网卡。发布来源固定为该接口实际局域网段和本机 WHIP_IP/32，
   INGEST_ALLOW_CIDRS 是兼容配置键，其手工值不会扩大发布范围。

   PUBLIC_DOMAIN 是播放站点域名，可按实际网络配置 A / AAAA。
   PUBLIC_HOST 必须为 A-only DNS 域名，有 1～16 个可公开路由的 IPv4 A 记录，
   不允许裸 IP、协议、端口或原生 IPv6 / AAAA。启动时验证过的全部 A 记录构成该进程
   的公网 WHEP ICE 精确白名单，DNS 后续变化需重启服务更新。公网请求者只获得这组候选；
   真实来源为私网、回环或链路本地 IPv4 的请求者还可获得已配置的精确 WHIP_IP 候选。
   其他地址、IPv6、mDNS 和畸形候选被过滤，无允许候选时失败关闭。
4. 将自己的 PEM 完整证书链和私钥放到配置路径。发布包不包含真实证书或私钥。
   私钥最终目标必须为 root 所有且不向组或其他用户开放，推荐 root:root 0600；
   配置路径及解析后目标的父目录链均须 root 管理、不可被组或其他用户写入。
   启动会校验证书/私钥匹配、系统信任链、PUBLIC_DOMAIN、ServerAuth 用途及至少
   24 小时剩余有效期。Caddy 不自动签发证书；更新证书后须重启服务。
5. 完成配置和证书准备后，在项目目录安装服务：
   sudo ./install-systemd.sh --check-only
   sudo ./install-systemd.sh
   sudo systemctl status obs-whip-live.service
   sudo ./show-credentials.sh

   --check-only 检查路径/所有权/权限、关键文件和清单存在性、必填配置，
   不写 unit、不要求 systemd 为 PID 1，也不执行完整内容哈希或运行时验收。
   正式安装才会严格核验全部受管文件的 SHA-256（可编辑的 config.env 内容除外），
   验证 unit 并启用服务。程序先完成真实启动检查才发送 systemd 就绪通知，安装器随后
   观察 152 秒稳定性；核心进程存活本身不足以算通过。DNS 查询和重试共享 30 秒总时限，
   无法确认 A-only 条件或超时均拒绝启动。

服务模式首次启动把发布凭据保存在 root-only 的 runtime/publish.credentials，
后续重启复用，凭据不写入 journal。也可使用 sudo ./start.sh 手工运行：已有持久
凭据时复用；没有持久文件时只生成内存中的临时凭据。活动 unit 存在时拒绝并行手工启动。
服务将项目程序树设为只读，仅 logs/、runtime/ 可写，启用进程、命名空间和文件系统
隔离；网关或 Caddy 意外退出时由 systemd 重启整组服务。

卸载与重装
--------

sudo ./uninstall.sh 停止并移除服务，但保留整个项目目录（包括配置、证书和持久凭据）。
sudo ./uninstall.sh --purge 会删除项目目录，不可用于保留数据的重装。
卸载会核验 unit 归属、停止结果、MainPID / ControlPID 和 cgroup；无法确认完全停止，
或 disable / reload 失败时返回非零并保留目录，删除后的 reload 失败会恢复 unit 文件。

重装必须使用完整的新目录，不能把新包覆盖解压到卸载后保留的旧树。以下命令先校验
新包、保留旧树，再恢复配置、证书和推流凭据。将 archive 改为实际新包的绝对路径；
/opt/obs-whip-live-backup 必须不存在，已有备份时先另选未占用的备份目录并同步替换命令。
外部证书路径继续由管理员维护。下例恢复整个 certs/ 后，会从已校验的新包重新提取
受管的 certs/README.txt，避免旧文档破坏新包清单。若配置使用旧项目目录中 certs/
以外的自定义证书路径，须在安装前单独恢复这些证书/私钥并核验所有权和权限；不要恢复
旧代码、模板或其他受管文档。恢复配置后仍需确认域名、端口和网卡符合当前环境。
set -eu
archive='/absolute/path/obs-whip-multicodec-llhls-web-debian13-v1.35-weak-network-fix12.tar.gz'
cd "$(dirname "$archive")"
sha256sum -c "$(basename "$archive").sha256"
sudo mkdir -m 0700 /opt/obs-whip-live-backup
cd /opt/obs-whip-live
sudo ./uninstall.sh
cd /opt
sudo mv /opt/obs-whip-live /opt/obs-whip-live-backup/project
sudo mkdir -m 0755 /opt/obs-whip-live
sudo tar -xzf "$archive" -C /opt/obs-whip-live --strip-components=1 --same-owner --same-permissions
cd /opt/obs-whip-live
sudo sha256sum -c SHA256SUMS
sudo cp -a /opt/obs-whip-live-backup/project/config.env ./config.env
sudo cp -a /opt/obs-whip-live-backup/project/certs/. ./certs/
release_root=$(basename "$archive" .tar.gz)
sudo tar -xzf "$archive" -C /opt/obs-whip-live --strip-components=1 --same-owner --same-permissions "$release_root/certs/README.txt"
if sudo test -f /opt/obs-whip-live-backup/project/runtime/publish.credentials; then
  sudo mkdir -m 0700 runtime
  sudo cp -p /opt/obs-whip-live-backup/project/runtime/publish.credentials runtime/publish.credentials
fi
sudoedit config.env
sudo ./install-systemd.sh --check-only
sudo ./install-systemd.sh
sudo ./show-credentials.sh

日常管理
--------

所有命令均在 /opt/obs-whip-live 下执行：
sudo ./status.sh
sudo ./diagnose.sh
sudo journalctl -u obs-whip-live.service
sudo systemctl restart obs-whip-live.service
sudo ./stop.sh

status.sh / diagnose.sh 在核心进程、必需监听、TLS/Caddy 或公网 ICE 安全检查失败时
返回非零。服务模式重启可重新加载证书和 DNS 候选，并保留发布凭据。手工模式更新
证书后先 sudo ./stop.sh 再 sudo ./start.sh。stop.sh 默认保留持久凭据；
主动轮换使用 sudo ./stop.sh --clear-credentials，它会先安全停止当前 unit，再删除旧凭据。
服务模式随后用 sudo systemctl start obs-whip-live.service 启动并生成新凭据。

OBS 配置推荐（可选客户端）
--------

WHIP（推荐）：
Server:       http://<LAN_IP>:8889/live/whip
Bearer Token: obs:<show-credentials.sh 显示的随机密码>

RTMP 兼容入口（密码同 WHIP，Stream key 中不加 obs:）：
Server:     rtmp://<LAN_IP>:1935
Stream key: live?user=obs&pass=<随机密码>

建议从 H.264、CBR、1～2 秒关键帧、关闭 B 帧开始验证。软件编码器首次排障建议使用
1920×1080、30 FPS；服务器无法修复 OBS 本机编码队列过载。

播放地址
--------

标准端口播放页为 https://live.example.com/；非标准端口为
https://live.example.com:<PUBLIC_HTTPS_PORT>/。HLS 主清单路径为
/live/index.m3u8，同源 WHEP 创建路径为 /rtc/live/whep；路径前均使用相同的
HTTPS 域名及公网端口。WHEP 媒体单独通过 8189 传输，不经过 HTTPS 反向代理。
页面默认先静音，点击“开启声音”恢复。WHIP/WHEP 音频使用 Opus；RTMP 通常为 AAC，
要保留 AAC 声音请手动选择 LL-HLS。

网络端口
--------

| 服务器本机监听 | 用途 | 暴露范围 |
| --- | --- | --- |
| TCP/443 | HTTPS、HTTP/1.1、HTTP/2 | 公网 |
| UDP/443 | HTTP/3 / QUIC | 公网 |
| UDP/TCP 8189 | WHEP WebRTC 加密媒体 | 使用 WHEP 时公网 |
| TCP/8889 | WHIP 推流信令 | 可信局域网 |
| TCP/1935 | RTMP 兼容推流 | 可信局域网 |
| TCP/8080、8888、9998 | 内部网关、HLS、指标 | 仅 loopback |

如果公网使用非标准 HTTPS 端口，必须把同一个公网 TCP/UDP 端口映射到服务器
TCP/UDP 443，并在 PUBLIC_HTTPS_PORT 中填写该公网端口。
只开放 TCP 仍可使用 HTTP/1.1/2，但 HTTP/3 不可用。使用公网 WHEP 时还需同端口映射
UDP/TCP 8189；仅使用 LL-HLS 时可不向公网开放 8189。TCP/80、管理 API、RTSP、SRT、
MoQ、pprof、录制与回放服务均未启用；指标 9998 只在 loopback 提供。
WHIP/8889 和 RTMP/1935 是可信局域网内的明文发布信令，应由防火墙阻止公网访问。

v1.35 默认限流规则
------------

v1.35 的默认限流按安全网关识别到的真实来源分组计数：IPv4 保持每个
/32（单地址）独立，IPv6 按 /64 前缀聚合。

| 流量类型 | 默认规则 | 超限行为 |
| --- | --- | --- |
| Web 与 LL-HLS GET/HEAD | 每个 IPv4 /32 或 IPv6 /64 每分钟 6,000 个请求（固定窗口） | HTTP 429，Retry-After 为当前固定窗口剩余的重置秒数（至少 1 秒） |
| WHEP 会话创建 POST | 每个 IPv4 /32 或 IPv6 /64 滚动窗口 10 次/10 秒且 30 次/60 秒 | HTTP 429 |
| WHEP 有效操作（create/PATCH/DELETE/心跳） | 每个 IPv4 /32 或 IPv6 /64 30 次/10 秒且 120 次/60 秒（固定窗口） | HTTP 429 |
| WHEP 活动会话 | 每个 IPv4 /32 或 IPv6 /64 最多 5 个 | HTTP 429 |

Web/LL-HLS 与 WHEP 限流表各自最多追踪 20,000 个来源键。WHEP create 在计入
配额前必须先通过 application/sdp MIME 校验，请求体上限为 256 KiB；会话使用
60 秒心跳，连续 5 分钟未刷新时回收。以上是 v1.35 内置默认值，不是公网带宽上限。
当 WHEP 操作同时触发 10 秒和 60 秒窗口时，Retry-After 返回两个窗口中较长的剩余重置时间。

内部 HLS/WHEP 后端地址必须是本机已分配的字面 IP。网关不使用环境 HTTP 代理，
并把实际连接固定到已校验的 IP/端口；WHEP 后端重定向不会被跟随。
标准 WHEP OPTIONS 能力发现由网关本地返回，不接触后端，也不消耗创建/操作限额。
公网 Web/HLS 只接受无请求体的 GET/HEAD；WHEP 创建用 POST，会话控制用 PATCH/DELETE，
播放器心跳使用 X-WHEP-Keepalive: 1 的无请求体 POST。会话控制绑定创建者的精确来源 IP，
与 IPv6 /64 的限额聚合范围不同。公网仅路由播放器静态文件、受控 HLS 资源及 WHEP
入口；/live/whip、/live/whep、MediaMTX 内置播放页及其他管理路径被拒绝。
WHEP create 返回的 SDP 按启动时 PUBLIC_HOST 的已验证 A 记录精确匹配。
公网来源不会得到 WHIP_IP；私网、回环或链路本地 IPv4 真实来源可额外获得精确
WHIP_IP 候选。其他公网地址、IPv6、mDNS 和畸形候选不会返回。

播放行为
--------

- AUTO 在浏览器具备 RTCPeerConnection 时优先尝试 WebRTC/WHEP；没有 WebRTC 时才走 HLS 检测/播放路径。HLS metadata 并行提供 codec/capability hint，不是 WHEP 的前置依赖。手动 LL-HLS 和手动 WHEP 可独立诊断。
- 每次 WHEP 建立保留 15 秒期限；AUTO 保留受控重试和连续失败后的 HLS fallback。手动 WHEP 建立超时或编码不支持时保留手动选择并显示错误，可点击 WHEP 重试。切换时取消旧 metadata；晚到 201 只清理它创建的旧 session。
- LL-HLS Normal：lowLatencyMode=true，target latency 6s，maxBufferLength=10s / maxMaxBufferLength=15s，最大追帧速度 1.05x。
- bandwidth-loss Weak：lowLatencyMode=true，继续使用可用的 LL-HLS parts；RTT Weak：lowLatencyMode=false，使用完整媒体段。两类 Weak 的 target latency 均为 12s，buffer 上限均为 16s/24s，播放速度 1.00x。
- 实际 forward buffer 首次达到 8s 才是 Weak READY；之后不低于 6s 可保持 READY，低于6s撤销。target latency、配置或 seek 成功不代表实际 READY。
- 带宽路径在起播预热后要求连续6个风险样本：带宽/流码率 ratio<1.2 且 buffer<4s，健康样本清零。早期保护可在8秒 stall warmup之前，通过3个有效下降slope或3个 severe-starvation 网络样本保护已开始的播放；暂停、seeking或无效采样间隔不累积趋势证据。
- RTT分类要求健康请求开销baseline、4个连续相对变差样本、足够带宽/无近期网络错误，并伴随buffer pressure。已有卡顿episode保持dedup及healthy→network升级语义；健康解码器stall不增加网络incident，也不删除已有真实incident。
- Weak安全定位只在同一段已下载连续buffer内后退1.5–6s；暂停、seeking、结束或旧generation不会移动位置。每个Weak episode最多成功后退一次；初始有界重试结束后仍可由monitor尝试。
- Fast recovery：ratio≥1.7、20个健康样本、最近15s无stall/network error；Stable recovery：ratio≥1.5、30个健康样本、最近30s quiet。两条路径提交时均复核当前位置所在连续可播放缓冲≥6s，不依赖首次8s READY。低于6s的短谷值最多保持3000ms既有stable计数，不增加样本、不退出。
- fix12：同一Hls重载清单前重置统计上下文，保留当前请求的原生完成/错误回调；旧owner、取消和被替换请求仍隔离。连续清单错误共用有界的2.5s饥饿确认，不反复顺延；退出或销毁时取消。Loader不改变载荷或上游超时；独立body-idle中止保持关闭，不能保证消除所有长时间网络等待。
- fix12：有效RTT参照仍要求4个当前同类请求改善至baseline+100ms以内。缺失、过期、上下文或请求形态改变时，仅整段恢复分支可重新取证：8个样本跨度至少6s，再由4个后续请求验证；候选开销≤200ms，并要求带宽裕量、≥6s缓冲及新鲜视频推进。坏样本、间隙或上下文变化重置候选；原参照300s有效期不延长。200ms是本分支保守资格上限，持续高于它的网络可能保持未知，不是所有网络的健康标准。
- fix12：恢复资格使用单调时钟、新鲜主视频传输与媒体推进；离线、暂停、seek、冻结或长采样中断后重新取证。READY的8/6s迟滞、带宽/样本/静默门槛、单次安全回退及append保护保留。
- 弱网退出在原Hls/MSE/媒体时间线上完成，不因退出或追赶reload、seek、清空有效前向缓冲、重建、暂停/重播。模式已正常但延迟较大时，按钮显示“平滑追赶”；同一恢复链路不补发回退预算。真实媒体缺失、致命网络/解码故障仍使用原恢复流程。
- 平滑追赶由应用单独在1.00–1.05x内控制，最多每秒上调0.05；缓冲低于3s先回1x，恢复到4s并有新鲜健康证据后才再加速。6s是退出准入，不是追赶期间缓冲永不波动的承诺。临时最大延迟保护为24–120s的有限值：在进入过渡时从有效当前媒体窗口计算并固定；原生倍速控制临时为1。实际延迟≤6.75s并连续确认3s后恢复正常18s最大延迟和1.05x原生上限。暂停、离线、错误和证据不足时显示暂缓原因，不到时强制seek。
- 正常目标仍是6s；最高1.05x消化6s额外延迟的理论下界为120s，缓冲保护会延长该过程。服务端仍约2s segment、1s CMAF part、24 segments；音视频共用媒体时钟，不能保证所有浏览器主观听不出变速。
- WHEP音频需要Opus；RTMP通常发送AAC，要保留AAC声音请手动选择LL-HLS。服务器不做视频/音频转码。

文档
--------

- 完整部署与运行说明（README.txt）
- OBS 配置推荐（OBS-COMPATIBILITY.txt）
- 编码与传输能力（CODEC-SUPPORT.txt）
- 安全模型（SECURITY.txt）
- 防火墙与端口（FIREWALL.txt）
- DNS 配置（DNS-SETUP.txt）
- 源码构建（BUILDING.md）

简要更新内容见仓库中英文精简更新日志和对应 GitHub Release 页面：
https://github.com/liying-official/whip-multicodec-llhls-whep-web/blob/main/CHANGELOG.md
https://github.com/liying-official/whip-multicodec-llhls-whep-web/blob/main/CHANGELOG.en.md
详细更新、修复方案、报告、日志与证据保留在本地，不提交到公开仓库或发行附件。

源码、二进制与许可证
----------

- src/：Go 安全网关与辅助程序
- web/：HTML、CSS、原生 JavaScript 播放器及固定版本 hls.js
- patches/：MediaMTX 与 gortmplib 的可复现兼容补丁
- third_party/：第三方许可证、版本、模块图和构建记录
- tools/：WHIP/libdatachannel 推流行为模拟与回归测试工具

预编译 Linux 二进制不提交到 Git 历史，只通过 Releases 提供。项目自有代码使用
MIT License（LICENSE）；第三方组件许可证保存在 third_party/。

播放连续性与兼容性边界
-----------

hls.js 1.7.3 保持官方资源原样；播放器通过 bufferController 扩展点给每次
SourceBuffer 写入绑定独立超时归属。完成、错误、替换及销毁会撤销旧回调，
只有当前且仍在 updating 的写入才允许超时恢复，15 秒 append watchdog 保持启用。
直播已播放至少 8 秒、音频/视频清单发生非致命超时且连续前向缓冲低于 6 秒时，
立即进入 bandwidth-loss 保护、停止加速并尝试一次有界安全回退。
保护可能产生短暂 seek 和内容回放；带宽长期低于源实际码率或断网超过缓冲时仍会卡顿。
项目不提供 ABR、转码或额外带宽，也不能消除路由器/NAT 上的 TCP 重传。

播放设备不支持硬件解码AV1的环境下使用软解码播放， AV1/WHEP 仍可能出现收包继续但视频停止解码的兼容性问题。
持续收到数据或连接显示 connected 不代表持续解码成功；请分别实际验证手动 WHEP
和手动 LL-HLS，必要时切换播放模式或编码器。弱网恢复保护不保证任意网络条件下无卡顿。
