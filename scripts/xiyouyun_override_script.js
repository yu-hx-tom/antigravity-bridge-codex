// 西游云 (Flclash / Mihomo) 四端口独立多出口权威覆写脚本
// 支持 Google AI (Antigravity / Gemini) 官方支持的所有主流优质地区
function main(config) {
  try {
    if (!config.proxies) {
      config.proxies = [];
    }

    // 1. 自动从列表中抓取专线/新加坡节点作为跳板
    let fallbackProxyName = "";
    if (config.proxies.length > 0) {
      const matched = config.proxies.find(p => 
        p && p.name && (p.name.includes("专线") || p.name.includes("新加坡") || p.name.includes("香港") || p.name.includes("日本"))
      );
      fallbackProxyName = matched ? matched.name : config.proxies[0].name;
    }

    // 2. 你的美国专属静态 ISP 节点
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

    // 3. 挂载跳板中转
    if (fallbackProxyName && fallbackProxyName !== myProxy.name) {
      myProxy["dialer-proxy"] = fallbackProxyName;
    }

    // 4. 注入节点到列表
    config.proxies.push(myProxy);

    // 5. 加入策略组
    if (config["proxy-groups"] && Array.isArray(config["proxy-groups"])) {
      config["proxy-groups"].forEach(group => {
        if (group.proxies && Array.isArray(group.proxies)) {
          if (!group.proxies.includes(myProxy.name)) {
            group.proxies.push(myProxy.name);
          }
        }
      });
    }

    // 6. 核心：开辟 4 个独立固定出口端口 (全部支持 Google AI，彻底排除受限的香港)
    config.listeners = [
      {
        name: "mixed-us-isp",
        type: "mixed",
        port: 7892,
        listen: "127.0.0.1",
        proxy: "us 专属静态ISP"
      },
      {
        name: "mixed-sg-iepl",
        type: "mixed",
        port: 7893,
        listen: "127.0.0.1",
        proxy: "新加坡｜IEPL专线"
      },
      {
        name: "mixed-tw-home",
        type: "mixed",
        port: 7894,
        listen: "127.0.0.1",
        proxy: "台湾｜高速-家宽"
      },
      {
        name: "mixed-jp-fast",
        type: "mixed",
        port: 7895,
        listen: "127.0.0.1",
        proxy: "日本1｜高速"
      }
    ];

  } catch (e) {
    // 容错处理
  }

  return config;
}
