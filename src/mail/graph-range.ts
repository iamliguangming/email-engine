import type { MailRange, RangePage, RemoteMessage } from "../adapter.js";

/** Page selected folders server-side; never fetch other folders and filter locally. */
export async function graphRange(
  base: string,
  api: (url: string) => Promise<any>,
  convert: (message: any, folder: string) => RemoteMessage,
  range: MailRange,
  cursor: string | null,
  select: string,
): Promise<RangePage> {
  const folders = [...new Set(range.folders)];
  if (!folders.length) throw new Error("Select a Graph folder before importing mail");
  const folderUrl = (index: number) => `${base}/mailFolders/${encodeURIComponent(folders[index]!)}/messages`;
  const validate = (url: string, index: number) => {
    const expected = new URL(folderUrl(index)), actual = new URL(url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.username || actual.password)
      throw new Error("invalid Graph pagination URL");
  };
  let index = 0, next: string | undefined;
  if (cursor) {
    if (cursor.startsWith("graph-range:")) {
      const state = JSON.parse(Buffer.from(cursor.slice(12), "base64url").toString("utf8"));
      if (!Number.isInteger(state.index) || state.index < 0 || state.index >= folders.length || (state.next !== undefined && typeof state.next !== "string"))
        throw new Error("invalid Graph pagination cursor");
      index = state.index;
      next = state.next;
    } else {
      // Accept old provider URLs only when they already target one selected folder.
      index = folders.findIndex((_, i) => new URL(folderUrl(i)).pathname === new URL(cursor).pathname);
      if (index < 0) throw new Error("invalid Graph pagination URL; restart this import");
      next = cursor;
    }
  }
  const query = new URLSearchParams({ "$top": "50", "$select": select, "$filter": `receivedDateTime ge ${range.from} and receivedDateTime lt ${range.to}` });
  const url = next ?? `${folderUrl(index)}?${query}`;
  validate(url, index);
  const page = await api(url);
  const messages = (page?.value ?? [])
    .filter((row: any) => !row.parentFolderId || row.parentFolderId === folders[index])
    .map((row: any) => ({ ...convert(row, folders[index]!), date: new Date(row.receivedDateTime).toISOString() }))
    .filter((message: RemoteMessage) => message.date >= range.from && message.date < range.to);
  const providerNext = page?.["@odata.nextLink"];
  if (providerNext) validate(providerNext, index);
  const state = providerNext ? { index, next: providerNext } : index + 1 < folders.length ? { index: index + 1 } : null;
  return { messages, next: state ? "graph-range:" + Buffer.from(JSON.stringify(state)).toString("base64url") : null };
}
