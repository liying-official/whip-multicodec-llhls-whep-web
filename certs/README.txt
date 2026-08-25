把公网可信证书放到这里：

  fullchain.pem   证书链
  privkey.pem     私钥

并在 config.env 设置 PUBLIC_DOMAIN。

本兼容模式开放 TCP/443 和 UDP/443，但不开放 TCP/80，也不会自动申请证书。
证书建议由你的 DNS-01 ACME 流程、DNS/CDN 控制面板或其他证书管理系统签发并续期。
更新证书文件后重新运行 sudo ./start.sh 即可加载新证书。
