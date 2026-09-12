# v1.35 源码构建 / Building v1.35 from source

Use Go **1.27.1**, Git, Node.js/npm, GNU tar/coreutils and an isolated Linux
build host. FFmpeg development packages and pkg-config are needed to compile
the gortmplib examples during its complete tests. Upstream tests reuse fixed
ports; run them in an isolated environment with no existing media deployment.

The exact source commits, patches and module files are pinned below. Build
directories must be outside the release tree. The release contains Linux
amd64/arm64 binaries and the local hls.js asset; normal startup does not
download components. Native arm64 execution must be verified separately from
cross-compilation on amd64.

构建需要 Go **1.27.1**、Git、Node.js/npm、GNU tar/coreutils 和隔离的 Linux 环境。完整 gortmplib 测试会编译示例，因此还需要 FFmpeg 开发包及 pkg-config。上游测试复用固定端口，应使用没有既有媒体服务的隔离环境。

下文固定了源码提交、补丁和模块文件；构建目录必须位于发行目录之外。发行包包含 Linux amd64/arm64 二进制和本地 hls.js，正常启动不会下载组件。amd64 上的 arm64 交叉编译不等同于 arm64 原生运行验证。

解压前，应使用 Go 官方下载记录核对 Go 1.27.1 发行包的 SHA-256。把该工具链加入 PATH，设置 `GOTOOLCHAIN=local` 禁止自动替换工具链。从项目根目录执行以下命令块，确保 `PROJECT_ROOT` 记录正确源码目录；其中 `go version` 必须显示 go1.27.1。中英文说明共用文中的命令、路径、版本和哈希。

## 准备构建目录 / Prepare the build workspace

Use the official Go 1.27.1 distribution and verify its SHA-256 against the
corresponding official download record before extracting it. Put that toolchain
on PATH and disable automatic toolchain substitution. Run the following block
from the project root so PROJECT_ROOT captures the correct source directory:

```sh
export GOTOOLCHAIN=local
export LC_ALL=C
go version  # must report go1.27.1
PROJECT_ROOT=$(pwd -P)
BUILD_ROOT=$(mktemp -d /var/tmp/obs-whip-build.XXXXXX)
cd "$BUILD_ROOT"
```

按以下顺序获取并核对指定提交、应用补丁、复制精确的模块文件和回放样本，再下载并验证模块。模块替换指向同级 gortmplib 目录。将已核验的 `web/hls.min.js` 复制到 MediaMTX 内嵌页面，仅生成 rpicamera 静态资源。构建 Linux amd64/arm64 二进制后，在清除代理变量的子 shell 中执行 vet、完整普通测试和 race 测试。

## 应用 gortmplib 和 MediaMTX 补丁 / Patch gortmplib and MediaMTX

```sh
git clone --branch v1.0.2 --depth 1 https://github.com/bluenviron/gortmplib.git
test "$(git -C gortmplib rev-parse HEAD)" = fbafd129baf54d49a2e3243f620d738ed72ff82e
git -C gortmplib apply "$PROJECT_ROOT/patches/gortmplib-v1.0.2-av1-empty-sequence-start.patch"

git clone --branch v1.21.0 --depth 1 https://github.com/bluenviron/mediamtx.git
test "$(git -C mediamtx rev-parse HEAD)" = 2c6727904fbf233615de74a6c54a9b94dbf6025d
for patch in mediamtx-v1.21.0-av1-whip-hls.patch \
  mediamtx-v1.21.0-av1-valid-test-fixtures.patch \
  mediamtx-v1.21.0-r11-version.patch \
  mediamtx-v1.21.0-go1.27-test-isolation.patch \
  mediamtx-v1.21.0-webrtc-local-candidate-priority.patch \
  mediamtx-v1.21.0-whip-rtp-reorder-512.patch \
  mediamtx-v1.21.0-whip-reorder-regressions.patch \
  mediamtx-v1.21.0-hlsjs-1.7.3.patch; do
  git -C mediamtx apply "$PROJECT_ROOT/patches/$patch"
done
cp "$PROJECT_ROOT/third_party/MediaMTX-go.mod" mediamtx/go.mod
cp "$PROJECT_ROOT/third_party/MediaMTX-go.sum" mediamtx/go.sum
mkdir -p mediamtx/internal/protocols/webrtc/testdata
cp "$PROJECT_ROOT/tests/fixtures/whip-av1-sequences.bin" \
  mediamtx/internal/protocols/webrtc/testdata/whip-av1-sequences.bin
go -C mediamtx mod download
go -C mediamtx mod verify
go -C gortmplib mod download

# Reuse the verified browser asset for the embedded upstream HLS page too.
cp "$PROJECT_ROOT/web/hls.min.js" mediamtx/internal/servers/hls/hls.min.js
printf '%s  %s\n' \
  a12e7ee1cd64a69dcdb314157e45dafcba705bfb0b1440b7935cb265d374423e \
  mediamtx/internal/servers/hls/hls.min.js | sha256sum -c -
# Only this asset needs generation; preserve the patched VERSION and hls.js.
go -C mediamtx generate ./internal/staticsources/rpicamera
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go -C mediamtx build -p 4 \
    -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o "$PROJECT_ROOT/bin/mediamtx_linux_$arch" .
done
(
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
  export NO_PROXY='*' no_proxy='*'
  go -C mediamtx vet ./...
  go -C mediamtx test -p 1 -count=1 ./...
  go -C mediamtx test -race -p 1 -count=1 ./...
  go -C gortmplib test -p 1 -count=1 ./...
  go -C gortmplib test -race -p 1 -count=1 ./...
)
```

The module replacement points to the sibling gortmplib tree. The r11 patch
sets `v1.21.0-r11` and Go 1.27.1; do not run the version getter afterward.
The HLS generator patch also pins v1.7.3 and its official release.zip SHA-256,
so an intentional future HLS regeneration retains the pinned version.

The AV1 normalization, AOM sequence-header restoration, empty RTMP AV1
sequence-start, private ICE host priority and bounded 512-packet RTP/SRTP
windows remain necessary with v1.21.0. Its new RTX registration is retained.
The gap test now fills the configured window while preserving its missing
sequence assertion; the captured-packet regression covers delivery, duplicates,
wraparound, old replays and authenticated-tampering rejection for two SRTP
profiles. The current upstream MoQ payload, authentication and fingerprint
tests remain intact and must still pass; no MoQ teardown patch is required.

See `third_party/MediaMTX-AOM-AV1-PATCH.txt` for scope and validation status,
and `third_party/MediaMTX-v1.21.0-UPSTREAM-ATTESTATION.txt` for provenance status.

r11 补丁设置实际二进制版本 `v1.21.0-r11` 和 Go 1.27.1，之后不要再次运行版本生成器。HLS 生成器同时固定 v1.7.3 及其官方 release.zip SHA-256，后续主动重新生成 HLS 资源时仍保持该固定版本。

MediaMTX v1.21.0 仍需要 AV1 归一化、AOM 序列头恢复、空 RTMP AV1 sequence-start、私有 ICE 地址优先级和有界 512 包 RTP/SRTP 窗口；保留上游新增的 RTX 注册。缺包测试填满配置窗口后仍检查真实缺包；捕获包回放检查交付、重复、回绕、旧包重放以及两种 SRTP 配置下的篡改拒绝。当前上游 MoQ 载荷、鉴权和指纹测试保持完整并必须通过，无需 MoQ teardown 补丁。

补丁范围与验证记录见 `third_party/MediaMTX-AOM-AV1-PATCH.txt`，来源证明见 `third_party/MediaMTX-v1.21.0-UPSTREAM-ATTESTATION.txt`。

Caddy 当前为 v2.11.4，使用 Go 1.27.1、随包模块依赖图和 API 兼容补丁重建两个架构。下列 CustomVersion 必须与现有二进制标识完全一致。

## 构建 Caddy / Build Caddy

Caddy remains at v2.11.4; rebuild both architectures with Go 1.27.1 and the
included dependency graph/API compatibility patch:

```sh
git clone --branch v2.11.4 --depth 1 https://github.com/caddyserver/caddy.git
test "$(git -C caddy rev-parse HEAD)" = e2eee6a7fce366321294c9c2a79f3146891dcbdf
cp "$PROJECT_ROOT/third_party/Caddy-go.mod" caddy/go.mod
cp "$PROJECT_ROOT/third_party/Caddy-go.sum" caddy/go.sum
git -C caddy apply "$PROJECT_ROOT/third_party/Caddy-cel-go-0.30.patch"
go -C caddy mod download
go -C caddy mod verify
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go -C caddy build -p 4 \
    -mod=readonly -trimpath -buildvcs=false \
    -ldflags='-s -w -buildid= -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.4-V1.35-go1.27.1-fix8v9' \
    -o "$PROJECT_ROOT/bin/caddy_linux_$arch" ./cmd/caddy
done
(
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
  export NO_PROXY='*' no_proxy='*'
  go -C caddy vet ./...
  go -C caddy test -p 1 -timeout 180s -count=1 ./...
  go -C caddy test -race -p 1 -timeout 180s -count=1 ./cmd/caddy ./caddyconfig/caddyfile ./modules/caddyhttp
)
```

Preserve the current x/crypto v0.56.0 security floor in both component graphs.
Compare the complete module graphs during upgrades. The current source-entry and binary scan results are
recorded below. A binary symbol match alone is not a reachability proof.

两个组件的依赖图均须保留当前 x/crypto v0.56.0 安全基线。升级时应比较完整依赖图。源码入口和二进制扫描记录见下文；仅匹配二进制符号不能证明运行时可达。

在项目根目录运行以下 vet、普通测试、race、十轮随机顺序测试、JavaScript 和 shell 回归，并按相同固定参数生成两个架构的 helper。

## 构建 helper 并运行项目回归 / Build helper and run first-party regressions

```sh
cd "$PROJECT_ROOT"
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
go test -count=10 -shuffle=on ./src
node --test tests/*.test.js
sh tests/dns-resolution.test.sh
sh tests/diagnose-exit-status.test.sh
sudo sh tests/install-systemd-trust.test.sh
sudo sh tests/control-plane-repair.test.sh
sh tests/caddy-authority.test.sh
sh tests/whep-runtime.test.sh
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -p 4 -mod=readonly -trimpath \
    -buildvcs=false -ldflags='-s -w -buildid=' -o "bin/helper_linux_$arch" ./src
done
```

Download source and modules before entering an isolated test network. A temporary
HTTP proxy may be used for downloads; the test subshells clear inherited proxies
without changing the parent download environment. Upstream WebRTC tests require
STUN binding responses at stun.l.google.com:19302; an offline namespace needs a
local responder and a namespace-local hostname mapping. It also needs multicast
routing and a silent route for the SRT cancellation-test destination.

Use bounded outer timeouts for runtime tests and isolate their fixed ports.
Verify the deployed configuration, startup stability and journal/input errors.
Real systemd checks must examine ActiveState, SubState, Result, MainPID and
NRestarts; a single `is-active` result is insufficient. Exercise notify readiness,
DNS failure, stop refusal, read-only cleanup, foreign roots and disagreement
between runtime files and manager state in an isolated systemd environment.

Exercise manual LL-HLS directly, as well as WHEP and WHEP-first AUTO fallback.
Under controlled weak-network conditions, verify policy activation and recovery,
actual buffer ranges and advancing decoded frames. A successful fragment event
or an AUTO/WHEP test alone does not prove manual HLS continuity. Recheck the
public route allowlist, ingest IP/auth ACL, WHEP limits/ownership/candidate
filtering, TLS/security headers, loopback listeners and service sandbox.

进入隔离测试网络之前先下载源码和模块。下载时可临时使用 HTTP 代理；测试子 shell 清除继承的代理变量，不改变父进程的下载环境。上游 WebRTC 测试要求 stun.l.google.com:19302 返回 STUN Binding 响应，离线命名空间需要本地响应器和命名空间内的主机名映射，并需要多播路由和 SRT 取消测试目标的静默路由。

运行时测试需要外层超时和固定端口隔离。检查实际部署配置、启动稳定性、日志与输入错误。systemd 检查须同时读取 ActiveState、SubState、Result、MainPID、NRestarts；单次 `is-active` 不足以证明稳定。在隔离的 systemd 环境中验证 notify 就绪、DNS 失败、停止拒绝、只读清理、外来项目目录及运行记录与管理器状态不一致的情形。

必须直接测试手动 LL-HLS，同时覆盖 WHEP 和优先 WHEP 的 AUTO 回退。可控弱网测试须核实策略进入与恢复、实际缓冲范围和持续增长的解码帧；仅分片事件成功或 AUTO/WHEP 通过不能证明手动 HLS 连续播放。再次核对公网路由白名单、推流 IP/凭据 ACL、WHEP 限额/归属/候选过滤、TLS/安全头、回环监听及服务沙箱。

## 浏览器资源与发行打包 / Browser asset and release packaging

hls.js **1.7.3** is bundled unchanged at `web/hls.min.js`, SHA-256
`a12e7ee1cd64a69dcdb314157e45dafcba705bfb0b1440b7935cb265d374423e`.
The same asset is embedded in MediaMTX. Its npm verification and controller
compatibility record are in `third_party/HLSJS-VERSION.txt`. The project policy
extension remains separate from the published library. Startup checks the
pinned version and asset hash and does not fetch npm or a CDN.

The canonical release name is stored in `tools/release-basename.txt`. Use the
exact archive basename shown below. Its platform/build labels identify this
artifact and do not restrict Linux compatibility; the product version is v1.35.
The packager requires the output and README/BUILDING release identifiers to
match the canonical name exactly, and rejects stale or mixed release names.
Caddy's exact CustomVersion records the existing binary identity and must be
preserved to reproduce its bytes. New patches, fixtures and provenance records
must appear in `tools/release-managed-files.txt`; executable files also need the
explicit mode allowlist. Keep the established package epoch:

```sh
SOURCE_DATE_EPOCH=1788652800 bash tools/package-release.sh \
  ../release/obs-whip-multicodec-llhls-web-debian13-v1.35-weak-network-fix10.tar.gz
```

The official packager regenerates SHA256SUMS in the output archive and normalizes
modes, ownership and timestamps; it does not update the working-tree manifest. It excludes runtime data, certificates, nested archives, source-only CHANGELOG*/
RELEASE_NOTES* files, local-only records and bin/.gitkeep. It always writes an
unconfigured config.env into the archive (empty domains/interface, public HTTPS
port 443), without changing the source configuration; deployment values are never
copied into the release configuration.
Package twice in separate output directories with this same epoch, compare
bytes, verify the sidecar and all archive members, and check the extracted
manifest. Repeat each component build with the same source, graph, generated
assets and flags before asserting binary reproducibility.

`web/hls.min.js` 是未修改的 hls.js **1.7.3**，上文 SHA-256 同时用于 MediaMTX 内嵌资源。npm 验证和控制器兼容记录见 `third_party/HLSJS-VERSION.txt`；项目策略扩展与上游库分离。启动检查固定版本和资源哈希，不访问 npm 或 CDN。

规范发行名称存于 `tools/release-basename.txt`，使用上方准确归档名。平台与构建标签用于标识本次交付，不限制 Linux 兼容范围；产品版本为 v1.35。打包器要求输出文件名与 README/BUILDING 中的发行标识精确匹配该规范名称，拒绝过期或混用的名称。Caddy CustomVersion 是重现现有二进制所需的真实标识，保持原样。新增补丁、样本和来源记录须列入 `tools/release-managed-files.txt`，可执行文件还须列入显式权限白名单。保持 `SOURCE_DATE_EPOCH=1788652800`。

官方打包器在输出归档中重新生成 SHA256SUMS，并统一权限、所有者和时间戳；工作目录内的 SHA256SUMS 不会因此自动更新。打包排除运行数据、证书、嵌套归档、仅源码仓库保留的 CHANGELOG*/RELEASE_NOTES*、local-only 记录及 bin/.gitkeep，并始终在归档中生成未配置的 config.env（域名和网卡留空、公网 HTTPS 端口 443），不修改源目录配置，也不复制其实际部署值。在两个独立输出目录使用相同时间戳打包，比较字节，核验 sidecar、归档成员和解压后的完整清单。在声称二进制可重现前，应使用相同源码、依赖图、生成资源和参数分别重建每个组件。

## v1.35 验证记录和二进制 SHA-256 / v1.35 validation and binary SHA-256

The following checks completed on 2026-09-12 with Go 1.27.1:

- MediaMTX: 1,226 test/subtest runs passed in each complete normal and race suite.
- gortmplib: 426 test/subtest runs passed in each complete normal and race suite.
- Caddy: 1,070 test/subtest runs passed in the complete normal suite; 159 passed
  in the focused race suite for cmd/caddy, caddyconfig/caddyfile and modules/caddyhttp.
- MediaMTX, Caddy and helper vet passed. Helper normal, race and ten shuffled
  repetitions passed. Project JavaScript tests passed 124/124.
- The real compiled helper and bundled Caddy passed 115/115 security checks
  against a controlled media backend, including HTTP/1.1, HTTP/2, HTTP/3,
  TLS policy, public routes, credential stripping, candidate filtering, request
  limits and session ownership. This fixture does not validate real media ingest.
- Real systemd-nspawn acceptance passed 101/101 checks with the upgraded
  MediaMTX and systemd services. Installation and restart each remained stable
  for the full 152-second observation; authentication, ingest ACLs, listeners,
  stop behavior and credential retention were checked.
- The listed shell regressions passed. The installer rejection test now creates
  an explicitly unconfigured fixture instead of inheriting the configured
  deployment's values; its rejection assertion remains unchanged.
- All six binaries were rebuilt with a fresh GOCACHE and the same inputs and
  flags, including compile parallelism `-p 4`; every byte comparison returned 0.

No executed test case was skipped in the recorded Go or JavaScript suites.
Go JSON skip events identify packages with no test files. Full MediaMTX runs
used an isolated mount/network namespace with local STUN binding responses and
multicast routing. This verifies the protocol fixture, not Google STUN or public
NAT traversal. The initial missing-route/STUN fixture failures were corrected
without changing assertions. Caddy's initial PROXY-protocol integration failures
occurred with inherited HTTP proxies; its complete suite passed with proxies
unset, without skipping those tests. The isolated systemd container initially
stalled while a cold public-certificate fixture attempted OCSP/DNS access with
no external route. The final fixture used a container-only CA and leaf trusted
inside that container; certificate verification remained enabled and production
certificates were unchanged.

Fresh govulncheck v1.8.0 scans used Go 1.27.1 and the vulnerability database
updated at 2026-09-10T14:48:42Z. Helper source and both binaries had no findings.
MediaMTX (`.`) and Caddy (`./cmd/caddy`) source-entry scans each reported only
module-level GO-2026-5932 for x/crypto v0.56.0, with no affected imported-package
or callable-symbol finding. Each MediaMTX/Caddy binary retained OpenPGP package
and symbol findings for that same advisory; these are not zero-warning binaries.
The database has no fixed version for that unmaintained OpenPGP API. JSON-mode
exit status 0 means the scan completed; the finding records determine its result.

Detailed runtime and weak-network records, including coverage limits, are
retained locally; published release notes summarize their scope. Unit tests, the local
STUN fixture and static binary checks do not substitute for those runtime results.

以下是 2026-09-12 使用 Go 1.27.1 完成的验证记录，不表示本次文档整理重新执行了运行测试：

- MediaMTX 完整普通和 race 测试各通过 1,226 个测试/子测试；gortmplib 两套各通过 426 个。
- Caddy 完整普通测试通过 1,070 个；cmd/caddy、caddyconfig/caddyfile 和 modules/caddyhttp 的定向 race 测试通过 159 个。
- MediaMTX、Caddy、helper 的 vet 通过；helper 普通、race 和十轮随机顺序测试通过；项目 JavaScript 通过 124/124。
- 实际 helper 与随包 Caddy 在受控媒体后端上通过 115/115 安全边界检查，覆盖 HTTP/1.1、HTTP/2、HTTP/3、TLS、公网路由、凭据剥离、候选过滤、请求限额和会话归属；该夹具不验证真实媒体推流。
- 实际 systemd-nspawn 环境使用升级后的 MediaMTX 和 systemd 服务通过 101/101 检查；安装与重启均完整观察 152 秒稳定状态，并检查鉴权、推流 ACL、监听、停止及凭据保留。
- 所列 shell 回归均通过。安装器拒绝测试显式创建未配置夹具，不再继承已部署配置值，拒绝断言未改变。
- 六个二进制使用全新 GOCACHE、相同输入和参数（包括 `-p 4`）重建，每个字节比较均返回 0。

记录中的 Go 和 JavaScript 已执行用例没有跳过；Go JSON skip 事件对应没有测试文件的包。完整 MediaMTX 测试使用带本地 STUN Binding 响应与多播路由的隔离挂载/网络命名空间，只验证协议夹具，不证明 Google STUN 或公网 NAT 可达。初次缺路由/STUN 的夹具失败通过补全夹具解决，断言未改变。Caddy 初次 PROXY 协议测试失败源于继承的 HTTP 代理；清除代理后完整套件通过，没有跳过这些测试。隔离 systemd 容器曾因无外网路由而等待冷启动公网证书夹具的 OCSP/DNS；最终夹具采用仅在容器中受信任的测试 CA/叶证书，证书验证保持启用，线上证书未更改。

govulncheck v1.8.0 使用 Go 1.27.1 和更新至 2026-09-10T14:48:42Z 的数据库。helper 源码和两个二进制无发现。MediaMTX（`.`）和 Caddy（`./cmd/caddy`）源码入口仅报告 x/crypto v0.56.0 的模块级 GO-2026-5932，没有受影响导入包或可调用符号发现。两个组件的每个二进制仍有同一公告的 OpenPGP 包/符号发现，不能称为零警告；数据库未提供该停止维护 API 的修复版本。JSON 模式退出 0 仅表示扫描完成，结论必须依据 finding 记录。

运行时、真实弱网及其覆盖限制的详细记录保留在本地，公开更新摘要说明发布范围。单元测试、本地 STUN 夹具和静态二进制检查不能替代运行时结果。下表中英文共用，哈希对应当前随包二进制。

| 二进制 / Binary | SHA-256 |
|---|---|
| caddy_linux_amd64 | `9733bf44efa76a9c3cccd705e4f6cd4c91a760a11c0e3f5b46efc91ae6a762da` |
| caddy_linux_arm64 | `c8c4fc95aa9ccfed022059b7613b170f1614aa1da3b675762b8ec2ae443d91be` |
| helper_linux_amd64 | `82b7622832fabee208972c1d0480c5c61c2f467a9c3f8cbbce8a05268a118ca9` |
| helper_linux_arm64 | `2b94c3b041218d656d6a895e95f1394cd308e6790aa936539289eb5747e14e11` |
| mediamtx_linux_amd64 | `d2a1acd4296d1d41443007069eff85bc622a865cbc169e5e752bdfdcc083b292` |
| mediamtx_linux_arm64 | `c7e91886e84ba890c648f8b1c89dda624ed8ad1b1a516ef96a34925459b44b99` |
