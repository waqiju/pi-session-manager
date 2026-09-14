import { readFileSync } from "node:fs";
import type { Entry, SessionHeader } from "./types.ts";

export interface ParsedSession {
  header: SessionHeader | null;
  entries: Entry[];
}

/** 解析 session .jsonl 文件。容忍最后追加到一半的残缺行（跳过）。 */
export function parseSessionFile(filePath: string): ParsedSession {
  return parseSessionText(readFileSync(filePath, "utf8"));
}

export function parseSessionText(text: string): ParsedSession {
  let header: SessionHeader | null = null;
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // append 到一半的末行
    }
    if (obj?.type === "session") {
      if (!header) header = obj as SessionHeader;
    } else if (obj?.type) {
      entries.push(obj as Entry);
    }
  }
  return { header, entries };
}
