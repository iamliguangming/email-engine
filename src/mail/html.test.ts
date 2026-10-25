import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { htmlToText, textFromParsed } from "./html.js";
const qp = (hex: string) =>
  hex.toUpperCase().match(/../g)!.map((b) => `=${b}`).join("");
const NOTICE = qp("cda8d6aad3cabcfe"); // 通知邮件
const PAID = qp("c4fab5c4b6a9b5a5d2d1d6a7b8b6"); // 您的订单已支付
test("htmlToText keeps Chinese text, converts block tags and entities", () => {
  assert.equal(htmlToText("<p>第一段</p><p>第二段&nbsp;结束</p>"), "第一段\n第二段 结束");
  assert.equal(htmlToText("A &amp; B &#65; &#x42;"), "A & B A B");
  assert.equal(htmlToText("<style>p{color:red}</style><div>正文</div>"), "正文");
});
test("textFromParsed prefers the plain part and falls back to HTML", () => {
  assert.equal(textFromParsed({ text: "纯文本", html: "<p>网页版</p>" }), "纯文本");
  assert.equal(textFromParsed({ text: "  ", html: "<p>网页版</p>" }), "网页版");
  assert.equal(textFromParsed({ text: false, html: false }), "");
  assert.equal(textFromParsed({}), "");
});
test("a GBK HTML-only message parses to readable text instead of an empty body", async () => {
  // The 12306 shape: multipart/alternative holding a single GBK text/html part.
  const raw = Buffer.from(
    'From: a@example.test\r\nTo: b@example.test\r\nSubject: notice\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="X"\r\n\r\n' +
      "--X\r\nContent-Type: text/html; charset=gbk\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
      `<html><body>12306${NOTICE}: ${PAID}</body></html>\r\n--X--\r\n`,
    "latin1",
  );
  const body = await simpleParser(raw);
  assert.equal(body.text, undefined);
  assert.equal(textFromParsed(body), `12306通知邮件: 您的订单已支付`);
});
test("a multipart message with both parts still prefers the plain text part", async () => {
  const raw = Buffer.from(
    'From: a@example.test\r\nTo: b@example.test\r\nSubject: both\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="Y"\r\n\r\n' +
      "--Y\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n候选人投递\r\n" +
      "--Y\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>候选人投递</p>\r\n--Y--\r\n",
    "utf8",
  );
  const body = await simpleParser(raw);
  assert.equal(textFromParsed(body), "候选人投递");
});
