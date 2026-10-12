import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { SaxesParser } from "saxes";
import { IptvProviderClient } from "./iptvProviderClient";
import type { IptvSetup } from "../../shared/iptv";

// This index is private to a provider worker. No provider addresses leave it.
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, epg TEXT NOT NULL);
CREATE INDEX channel_epg ON channels(epg);
CREATE TABLE programmes (id INTEGER PRIMARY KEY, epg TEXT, title TEXT, description TEXT, start INTEGER, end INTEGER);
CREATE INDEX programme_channel_time ON programmes(epg,start,end);
CREATE VIRTUAL TABLE titles USING fts5(title, content='programmes', content_rowid='id', tokenize='unicode61 remove_diacritics 2');`);

export function xmltvTime(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(Z|[+-]\d{4})?$/.exec(value.trim());
  if (!m) return NaN;
  const [, year, month, day, hour, minute, second = "00", zone = "Z"] = m;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(3)}`}`;
  return Date.parse(iso);
}

async function build() {
  const setup = workerData.setup as IptvSetup;
  const client = new IptvProviderClient();
  const signal = AbortSignal.timeout(180000);
  const channel = db.prepare("INSERT OR REPLACE INTO channels VALUES (?,?)");
  let channelCount = 0;
  for await (const entry of client.guideChannelMappings(setup, signal)) {
    if (++channelCount > 100000) throw new Error();
    channel.run(entry.id, entry.epg);
  }
  if (!channelCount) throw new Error();
  const insert = db.prepare("INSERT INTO programmes(epg,title,description,start,end) VALUES (?,?,?,?,?)");
  const parser = new SaxesParser({ xmlns: false });
  let depth = 0; let field = ""; let programme: { epg: string; title: string; description: string; start: number; end: number } | null = null;
  let count = 0; let root = false;
  const now = Date.now();
  const clean = (text: string, limit: number) => {
    let value = text.replace(/https?:\/\/[^\s<>"']+/giu, "[provider link]").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/gu, " ");
    if (setup.kind === "xtream") for (const secret of [setup.username, setup.password]) if (secret) value = value.split(secret).join("[private]");
    return value.trim().slice(0, limit);
  };
  parser.on("doctype", value => { if (/\[|ENTITY/i.test(value)) throw new Error(); });
  parser.on("opentag", tag => {
    depth++; if (depth > 32) throw new Error();
    if (depth === 1) { if (tag.name !== "tv") throw new Error(); root = true; }
    if (depth === 2 && tag.name === "programme") {
      programme = { epg: String(tag.attributes.channel ?? ""), title: "", description: "", start: xmltvTime(String(tag.attributes.start ?? "")), end: xmltvTime(String(tag.attributes.stop ?? "")) };
    }
    if (depth === 3 && programme) field = tag.name;
  });
  const append = (text: string) => {
    if (!programme) return;
    if (field === "title") programme.title = (programme.title + text).slice(0, 4096);
    if (field === "desc") programme.description = (programme.description + text).slice(0, 8192);
  };
  parser.on("text", append); parser.on("cdata", append);
  parser.on("closetag", tag => {
    if (depth === 3) field = "";
    if (depth === 2 && tag.name === "programme" && programme) {
      const p = programme; programme = null;
      if (p.epg && p.epg.length <= 512 && p.title && Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start && p.end > now - 86400000 && p.start < now + 7 * 86400000) {
        if (++count > 2000000) throw new Error();
        insert.run(p.epg, clean(p.title, 1024), clean(p.description, 8192), p.start, p.end);
      }
    }
    depth--;
  });
  db.exec("BEGIN");
  for await (const text of client.guideXml(setup, signal)) parser.write(text);
  parser.close();
  if (!root || !count || !db.prepare("SELECT 1 FROM programmes p JOIN channels c ON c.epg=p.epg LIMIT 1").get()) throw new Error();
  db.exec("INSERT INTO titles(titles) VALUES ('rebuild'); COMMIT;");
  parentPort!.postMessage({ ready: true });
}

parentPort!.on("message", (message: { id: number; query?: string; start?: number; end?: number; channelId?: string }) => {
  try {
    if (message.channelId) {
      const rows = db.prepare(`SELECT p.* FROM programmes p JOIN channels c ON c.epg=p.epg WHERE c.id=? ORDER BY p.start LIMIT 500`).all(message.channelId);
      parentPort!.postMessage({ id: message.id, result: rows.map(p => ({ id: String(p.id), title: String(p.title), description: String(p.description), startUtc: new Date(Number(p.start)).toISOString(), endUtc: new Date(Number(p.end)).toISOString() })) });
      return;
    }
    const tokens = message.query?.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
    const match = tokens.map(token => `"${token}"*`).join(" AND ");
    const rows = match ? db.prepare(`SELECT DISTINCT c.id FROM titles JOIN programmes p ON p.id=titles.rowid JOIN channels c ON c.epg=p.epg WHERE titles MATCH ? AND p.start < ? AND p.end > ?`).all(match, message.end!, message.start!) : [];
    parentPort!.postMessage({ id: message.id, result: rows.map(row => String(row.id)) });
  } catch { parentPort!.postMessage({ id: message.id, error: true }); }
});
void build().catch(() => { parentPort!.postMessage({ failed: true }); });
