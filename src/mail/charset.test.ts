import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeText } from "./charset.js";
import { snippetFrom } from "../imap.js";
// GBK bytes: 通知邮件 / 退票通知 / 您的订单已支付
const gbk = (hex: string) => Buffer.from(hex, "hex");
const part = (over: object) => ({
  childNodes: [
    { type: "text/plain", encoding: "7bit", parameters: {}, ...over },
  ],
} as any);
test("decodeText handles GBK and its legacy gb2312 label", () => {
  const bytes = gbk("cda8d6aad3cabcfe");
  assert.equal(decodeText(bytes, "gbk"), "通知邮件");
  assert.equal(decodeText(bytes, "GB2312"), "通知邮件");
  assert.equal(decodeText(bytes, '"gb_2312-80"'), "通知邮件");
});
test("decodeText decodes UTF-8 and falls back to Latin-1 for unknown labels", () => {
  assert.equal(decodeText(Buffer.from("通知邮件"), "utf-8"), "通知邮件");
  assert.equal(decodeText(Buffer.from("plain"), ""), "plain");
  const bytes = gbk("cda8d6aa");
  // An unrecognized charset must not throw; bytes stay inspectable as Latin-1.
  assert.equal(decodeText(bytes, "x-mystery-9"), bytes.toString("latin1"));
});
test("snippetFrom decodes GBK payloads instead of passing bytes through", () => {
  const quoted = Buffer.from(
    "=CD=A8=D6=AA=D3=CA=BC=FE: =CD=CB=C6=B1=CD=A8=D6=AA",
    "latin1",
  );
  assert.equal(
    snippetFrom(quoted, part({ encoding: "quoted-printable", parameters: { charset: "gb2312" } })),
    "通知邮件: 退票通知",
  );
  const base64 = Buffer.from(gbk("cda8d6aad3cabcfe").toString("base64"));
  assert.equal(
    snippetFrom(base64, part({ encoding: "base64", parameters: { charset: "GBK" } })),
    "通知邮件",
  );
});
test("snippetFrom keeps UTF-8 snippets and strips HTML around GBK text", () => {
  const utf8 = Buffer.from("您有一封新邮件 请查收", "utf8");
  assert.equal(
    snippetFrom(utf8, part({ parameters: { charset: "utf-8" } })),
    "您有一封新邮件 请查收",
  );
  const html = Buffer.from(
    "<html><style>p{color:red}</style><body>=C4=FA=B5=C4=B6=A9=B5=A5=D2=D1=D6=A7=B8=B6</body></html>",
    "latin1",
  );
  assert.equal(
    snippetFrom(html, part({ type: "text/html", encoding: "quoted-printable", parameters: { charset: "gbk" } })),
    "您的订单已支付",
  );
});
