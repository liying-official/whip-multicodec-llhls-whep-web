# OBS WHIP Multi-Codec LL-HLS/WebRTC Edge

面向 Debian 13 的低延迟直播边缘服务：OBS 通过内网网卡 IP 使用 WHIP 或 RTMP
推流，浏览器通过公网 HTTPS 使用 LL-HLS 或 WHEP/WebRTC 播放。

## 特性

- H.264、H.265/HEVC、AOM AV1、SVT-AV1
- WHIP/WebRTC + Opus
- RTMP + AAC/LL-HLS
- AV1 LL-HLS 与 WHEP 自动回退
- HTTP/1.1、HTTP/2、HTTP/3，TLS 1.3 only
- 公网仅开放 Web/HLS/WHEP；WHIP/RTMP 只绑定私网网卡 IP
- 启动时识别 RFC1918 网卡及真实掩码，发布 ACL 固定为接口局域网段和本机 `/32`
- MediaMTX v1.19.3-r8 AOM AV1 RTMP、WHIP 和 HLS 兼容补丁
- amd64 与 arm64

## 数据链路

```text
OBS
 ├─ WHIP/WebRTC ─┐
 └─ RTMP ────────┤
                  ▼
        patched MediaMTX
          ├─ LL-HLS ── Caddy ── Browser
          └─ WHEP/WebRTC ────── Browser
```

服务器不转码。OBS AOM AV1 的关键帧间隔必须设置为 1–2 秒，不能使用
`0/自动`。

## 快速部署

1. 从 GitHub Releases 下载 Debian 13 完整包。
2. 解压后编辑 `config.env`：

   ```text
   PUBLIC_DOMAIN=live.example.com
   TLS_CERT=certs/fullchain.pem
   TLS_KEY=certs/privkey.pem
   WHIP_IP=
   INGEST_ALLOW_CIDRS=
   PUBLIC_HOST=
   ```

3. 把公网可信证书放入 `certs/`。
4. 启动：

   ```sh
   sudo ./start.sh
   ```

如果使用 GitHub 自动生成的源码归档而不是 Releases 中的完整包，请先恢复脚本执行权限：

```sh
chmod +x start.sh stop.sh status.sh diagnose.sh
```

`WHIP_IP` 留空时会自动选择已启用的 RFC1918 私网网卡。多网卡服务器可以填写
某个本机私网地址；`INGEST_ALLOW_CIDRS` 是旧版兼容项，手工值会被忽略。

详细部署、OBS 参数和安全边界请阅读：

- [README.txt](README.txt)
- [OBS-COMPATIBILITY.txt](OBS-COMPATIBILITY.txt)
- [CODEC-SUPPORT.txt](CODEC-SUPPORT.txt)
- [SECURITY.txt](SECURITY.txt)
- [FIREWALL.txt](FIREWALL.txt)

## 源码与补丁

- `src/`：Go 网关、下载校验和安全辅助程序
- `web/`：HTML/CSS/原生 JavaScript 播放器
- `patches/`：针对 MediaMTX v1.19.3 和 gortmplib v0.4.1 的可复现补丁
- `tools/`：OBS/libdatachannel 行为模拟与回归测试工具
- `BUILDING.md`：从上游源码重建修补版二进制

预编译二进制不提交到 Git 历史，完整可运行包通过 Releases 提供。

## 许可证

项目自有代码使用 [MIT License](LICENSE)。MediaMTX 与 gortmplib 的上游版权及
许可证分别保留在 `third_party/MediaMTX-LICENSE.txt` 和
`third_party/gortmplib-LICENSE.txt`。

