/** Bound decoded HTTP bodies before parsers/base64 allocation. */
export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw new Error("provider_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("provider_response_too_large");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}
