function main(config) {
  try {
    if (!config.proxies) {
      config.proxies = [];
    }

    // 1. 精准锁定当前正在生效、速度最稳的新加坡 IEPL 专线作为跳板
    let fallbackProxyName = "";
    if (config.proxies.length > 0) {
      const matched = config.proxies.find(p => p && p.name && p.name.includes("新加坡") && p.name.includes("IEPL")) ||
                      config.proxies.find(p => p && p.name && p.name.includes("新加坡")) ||
                      config.proxies[0];
      fallbackProxyName = matched ? matched.name : "";
    }

    // 2. 你的专属静态 ISP 节点参数
    const myProxy = {
      name: "us 专属静态ISP",
      type: "socks5",
      server: "YOUR_ISP_HOST",
      port: 443,
      username: "YOUR_ISP_USERNAME",
      password: "YOUR_ISP_PASSWORD",
      udp: true,
      "skip-cert-verify": true
    };

    // 3. 挂载专线跳板 (防止国内直连被墙)
    if (fallbackProxyName && fallbackProxyName !== myProxy.name) {
      myProxy["dialer-proxy"] = fallbackProxyName;
    }

    // 4. 注入节点到列表最前排
    config.proxies.unshift(myProxy);

    // 5. 加入所有策略组
    if (config["proxy-groups"] && Array.isArray(config["proxy-groups"])) {
      config["proxy-groups"].forEach(group => {
        if (group.proxies && Array.isArray(group.proxies)) {
          if (!group.proxies.includes(myProxy.name)) {
            group.proxies.unshift(myProxy.name);
          }
        }
      });
    }
  } catch (e) {
    // 容错处理
  }

  return config;
}
