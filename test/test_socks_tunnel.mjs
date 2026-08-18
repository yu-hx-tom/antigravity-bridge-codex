import net from "node:net";
import http from "node:http";

export function createIspTunnelServer({ port = 8789, upstreamPort = 7888 } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Antigravity ISP Tunnel Ready");
  });

  server.on("connect", (req, clientSocket, head) => {
    const [targetHost, targetPortStr] = req.url.split(":");
    const targetPort = parseInt(targetPortStr) || 443;

    // 1. 连接西游云作为前置跳板
    const hopSocket = net.connect(upstreamPort, "127.0.0.1", () => {
      const ispHost = process.env.ABC_TEST_ISP_HOST || "203.0.113.10";
      const ispPort = Number(process.env.ABC_TEST_ISP_PORT || 443);
      hopSocket.write(`CONNECT ${ispHost}:${ispPort} HTTP/1.1\r\nHost: ${ispHost}:${ispPort}\r\n\r\n`);
    });

    let state = 0; // 0: wait http 200, 1: wait auth methods, 2: wait auth result, 3: wait connect result, 4: streaming
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      if (state === 4) return;
      buffer = Buffer.concat([buffer, chunk]);

      // Step 0: 等待西游云前置跳板返回 200 Connection Established
      if (state === 0) {
        const idx = buffer.indexOf("\r\n\r\n");
        if (idx !== -1) {
          const header = buffer.subarray(0, idx).toString();
          if (!header.includes("200")) {
            clientSocket.destroy();
            hopSocket.destroy();
            return;
          }
          buffer = buffer.subarray(idx + 4);
          state = 1;
          hopSocket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        }
      }

      // Step 1: 接收 SOCKS5 认证方法响应
      if (state === 1 && buffer.length >= 2) {
        if (buffer[0] !== 0x05) { clientSocket.destroy(); hopSocket.destroy(); return; }
        const method = buffer[1];
        buffer = buffer.subarray(2);
        if (method === 0x02) {
          state = 2;
          const u = Buffer.from(process.env.ABC_TEST_ISP_USER || "test-user");
          const p = Buffer.from(process.env.ABC_TEST_ISP_PASS || "test-pass");
          const authPacket = Buffer.concat([
            Buffer.from([0x01, u.length]),
            u,
            Buffer.from([p.length]),
            p
          ]);
          hopSocket.write(authPacket);
        } else if (method === 0x00) {
          state = 3;
          sendSocksConnect();
        } else {
          clientSocket.destroy(); hopSocket.destroy(); return;
        }
      }

      // Step 2: 接收用户名密码认证结果
      if (state === 2 && buffer.length >= 2) {
        if (buffer[1] !== 0x00) { clientSocket.destroy(); hopSocket.destroy(); return; }
        buffer = buffer.subarray(2);
        state = 3;
        sendSocksConnect();
      }

      // Step 3: 接收 SOCKS5 CONNECT 结果
      if (state === 3 && buffer.length >= 4) {
        if (buffer[1] !== 0x00) { clientSocket.destroy(); hopSocket.destroy(); return; }
        let respLen = 10; // IPv4 default
        if (buffer[3] === 0x01) respLen = 10;
        else if (buffer[3] === 0x03) respLen = 4 + 1 + buffer[4] + 2;
        else if (buffer[3] === 0x04) respLen = 22;

        if (buffer.length >= respLen) {
          const extra = buffer.subarray(respLen);
          state = 4;
          hopSocket.removeListener("data", onData);

          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (extra.length > 0) clientSocket.write(extra);
          if (head && head.length > 0) hopSocket.write(head);
          clientSocket.pipe(hopSocket);
          hopSocket.pipe(clientSocket);
        }
      }
    };

    hopSocket.on("data", onData);

    function sendSocksConnect() {
      const isIp = net.isIP(targetHost);
      let reqBuf;
      if (isIp === 4) {
        const parts = targetHost.split(".").map(Number);
        reqBuf = Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts, (targetPort >> 8) & 0xff, targetPort & 0xff]);
      } else {
        const hostBuf = Buffer.from(targetHost);
        reqBuf = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
      }
      hopSocket.write(reqBuf);
    }

    clientSocket.on("error", () => hopSocket.destroy());
    hopSocket.on("error", () => clientSocket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
