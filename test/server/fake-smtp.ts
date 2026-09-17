/**
 * A fake SMTP server, just enough of RFC 5321 to watch what the alert mailer
 * sends: optional STARTTLS with a given certificate, AUTH accepted blindly,
 * every command line recorded. With `banner` it plays some other service
 * that greets and then says nothing more.
 */
import net from "node:net";
import tls from "node:tls";

export interface FakeSmtp {
  port: number;
  /** Command lines received, in order, over either the plain or the TLS socket. */
  lines: string[];
  close(): Promise<void>;
}

export async function startFakeSmtp(opts: { banner?: string; startTls?: { key: string; cert: string } } = {}): Promise<FakeSmtp> {
  const lines: string[] = [];
  const sockets = new Set<net.Socket>();

  const converse = (sock: net.Socket, secured: boolean) => {
    let buf = "";
    let inData = false;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            sock.write("250 2.0.0 queued\r\n");
          }
          continue;
        }
        lines.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") {
          const tlsLine = opts.startTls && !secured ? "250-STARTTLS\r\n" : "";
          sock.write(`250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n${tlsLine}250 8BITMIME\r\n`);
        } else if (verb === "STARTTLS" && opts.startTls && !secured) {
          sock.removeListener("data", onData);
          sock.write("220 2.0.0 ready\r\n", () => {
            const secure = new tls.TLSSocket(sock, { isServer: true, key: opts.startTls!.key, cert: opts.startTls!.cert });
            // The client may refuse the certificate; that is what some tests want.
            secure.on("error", () => sock.destroy());
            converse(secure, true);
          });
          return;
        } else if (verb === "STARTTLS") {
          sock.write("502 5.5.1 not implemented\r\n");
        } else if (verb === "AUTH") {
          sock.write("235 2.7.0 accepted\r\n");
        } else if (verb === "DATA") {
          inData = true;
          sock.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          sock.end("221 2.0.0 bye\r\n");
        } else if (verb === "MAIL" || verb === "RCPT" || verb === "RSET" || verb === "NOOP") {
          sock.write("250 2.0.0 ok\r\n");
        } else {
          sock.write("500 5.5.2 what\r\n");
        }
      }
    };
    sock.on("data", onData);
  };

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    if (opts.banner !== undefined) {
      sock.write(opts.banner);
      sock.on("data", (c: Buffer) => lines.push(c.toString("utf8")));
      return;
    }
    sock.write("220 fake.test ESMTP\r\n");
    converse(sock, false);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    lines,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
