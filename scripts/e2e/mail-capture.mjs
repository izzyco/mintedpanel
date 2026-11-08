#!/usr/bin/env node
// Stands in for SendGrid in the local-stack onboarding run
// (scripts/e2e/onboarding-local-stack.sh). It accepts POST /v3/mail/send the
// way SendGrid does (202 with an x-message-id) and keeps every body in memory,
// so nothing is delivered and the spec can read what would have been sent:
// GET /messages returns them in order. GET / is the same mail as plain text,
// newest first, for a person reading invite links and sign-in codes in a
// browser tab. It binds 127.0.0.1 only.
//
//   node scripts/e2e/mail-capture.mjs [port]   (default 8092)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.argv[2] ?? 8092);
const messages = [];

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function inbox() {
  if (messages.length === 0) return "No mail yet. Reload this page after the app sends one.\n";
  const shown = messages.toReversed().map(({ receivedAt, body }) => {
    const to = (body.personalizations ?? []).flatMap((p) => p.to ?? []).map((t) => t.email);
    const text = (body.content ?? []).find((c) => c.type === "text/plain")?.value;
    return [
      `Received: ${receivedAt}`,
      `To: ${to.join(", ")}`,
      `Subject: ${body.subject ?? ""}`,
      "",
      text ?? "(no plain-text part)",
    ].join("\n");
  });
  const count = messages.length === 1 ? "1 message" : `${messages.length} messages`;
  return `${count}, newest first. Reload for new mail.\n\n${shown.join(`\n\n${"-".repeat(60)}\n\n`)}\n`;
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v3/mail/send") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(res, 400, { errors: [{ message: "body is not JSON" }] });
      }
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        return json(res, 401, { errors: [{ message: "no bearer key" }] });
      }
      const messageId = randomUUID();
      messages.push({ messageId, receivedAt: new Date().toISOString(), body });
      res.writeHead(202, { "x-message-id": messageId });
      res.end();
    });
    return;
  }
  if (req.method === "GET" && req.url === "/messages") return json(res, 200, messages);
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(inbox());
  }
  json(res, 404, { errors: [{ message: "not found" }] });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mail capture listening on http://127.0.0.1:${port}\n`);
});
