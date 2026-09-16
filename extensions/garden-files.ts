/**
 * /garden 选择器的删除操作：session jsonl（trash 优先）+ garden md 产物清理。
 * 零运行时 pi 依赖（node --test 可直测）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { indexOutputsBySessionId } from "../src/cli.ts";
import { GARDEN_LEVELS } from "../src/open.ts";
import type { SessionListItem } from "../src/session-list.ts";

/** 删除 session jsonl：先试 trash CLI，失败回退 unlink（对齐内建 /resume 删除语义） */
export async function deleteSessionFile(sessionPath: string): Promise<{ ok: boolean; error?: string }> {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
  if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true };
  try {
    await unlink(sessionPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 删除该 session 的全部 garden 产物：按 frontmatter session_id 反查（不认文件名），
 * 改名/重编号残留一并清掉，保证下次列表不再出现。
 */
export async function deleteGardenOutputs(item: SessionListItem): Promise<number> {
  const files = indexOutputsBySessionId(item.mdDir).get(JSON.stringify(item.id)) ?? [];
  let removed = 0;
  for (const f of files) {
    try {
      await unlink(path.join(item.mdDir, f));
      removed++;
    } catch {
      /* ignore */
    }
  }
  // 保底：按当前 base 直删（frontmatter 损坏的文件 indexOutputsBySessionId 索引不到）
  for (const level of GARDEN_LEVELS) {
    try {
      await unlink(path.join(item.mdDir, `${item.mdBase}.${level}.md`));
    } catch {
      /* ignore */
    }
  }
  return removed;
}
