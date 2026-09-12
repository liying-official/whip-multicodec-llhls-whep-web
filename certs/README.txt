TLS 证书 / TLS certificates
============================
项目版本 / Project version: v1.35

中文
----

在此目录提供由服务器系统信任库信任、且覆盖 PUBLIC_DOMAIN 的证书：
  fullchain.pem   叶证书及中间证书链
  privkey.pem     对应私钥

config.env 的默认相对路径为：
  TLS_CERT=certs/fullchain.pem
  TLS_KEY=certs/privkey.pem
并填写自己的 PUBLIC_DOMAIN。也可配置由外部证书管理系统维护的绝对路径。

启动会检查证书和私钥匹配、域名、有效期、ServerAuth 用途及系统信任链；
剩余有效期必须至少
24 小时。私钥的最终目标必须是 root 所有的普通文件，权限不得对组或其他用户
开放，建议 0600；链接路径和最终目标的父目录都必须由 root 所有且不可被组/
其他用户写入。项目目录本身也须满足启动脚本的所有权与不可被非 root 修改要求。
不要把私钥提交进源码库或公开的文档审核包。

本服务监听 TCP/443 与 UDP/443，仅接受 TLS 1.3；不监听 TCP/80，也不自动申请
或续期证书。可使用自己的 DNS-01 ACME 流程、DNS 服务商控制台或其他证书管理
系统申请并续期。公网非标准 HTTPS 端口仍按 PUBLIC_HTTPS_PORT 映射到本机
TCP/UDP 443，详见主 README 和 DNS-SETUP.txt。

以下 ./ 相对命令在项目根目录执行，例如先 cd /opt/obs-whip-live，
不要在 certs 子目录运行。更新证书后：
  systemd 模式：
    sudo systemctl restart obs-whip-live.service
  手工模式：
    sudo ./stop.sh
    sudo ./start.sh

普通停止/重启会保留并复用已有持久推流凭据；全新手工模式在没有持久凭据时生成
当次推流码且不持久化。主动轮换时先执行 sudo ./stop.sh --clear-credentials，
再按原有运行方式启动（systemd 用 systemctl start，手工用 ./start.sh）。
证书更新本身无需主动清除凭据。

English
-------

Place a certificate trusted by the server's system trust store and valid for
PUBLIC_DOMAIN in this directory:
  fullchain.pem   Leaf certificate and intermediate chain
  privkey.pem     Matching private key

The default relative paths in config.env are:
  TLS_CERT=certs/fullchain.pem
  TLS_KEY=certs/privkey.pem
Set your own PUBLIC_DOMAIN. Absolute paths managed by an external certificate
system are also supported.

Startup verifies the certificate/key match, hostname, validity period, ServerAuth
usage and system trust chain. At least 24 hours of validity must remain. The resolved private key
must be a root-owned regular file with no group/other permissions; 0600 is
recommended. Parent directories of both the configured path and the resolved
target must be root-owned and not group/other writable. The project tree must
also meet the startup ownership and non-root write-protection checks.
Never commit private keys to source control or public documentation review bundles.

The service listens on TCP/443 and UDP/443 using TLS 1.3 only. It does not listen
on TCP/80 or obtain/renew certificates automatically. Use your own DNS-01 ACME
workflow, DNS-provider console or other certificate management system. A
nonstandard public HTTPS port still maps PUBLIC_HTTPS_PORT to local TCP/UDP 443;
see the main README and DNS-SETUP.txt.

Run the following ./ commands from the project root, for example after
cd /opt/obs-whip-live, not from the certs subdirectory. After replacing the certificate:
  systemd mode:
    sudo systemctl restart obs-whip-live.service
  Manual mode:
    sudo ./stop.sh
    sudo ./start.sh

Normal stop/restart preserves and reuses existing persisted publishing
credentials. A fresh manual run without persisted credentials generates a
temporary stream key and does not persist it. For deliberate rotation, run
sudo ./stop.sh --clear-credentials, then start using the original operating mode
(systemctl start for systemd, ./start.sh for manual use). Replacing a certificate
does not require clearing publishing credentials.
