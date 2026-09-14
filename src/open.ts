/**
 * gardener-open 的打开器：用系统默认应用（浏览器）打开 md 文件。
 *
 * 平台策略：
 *   win32 → cmd.exe /c start "" <file>
 *   wsl   → wslpath -w 转成 Windows 路径后 cmd.exe /c start "" <winPath>
 *           （explorer.exe 成功也常返回非零退出码，cmd start 更稳）
 *   darwin → open <file>
 *   linux  → xdg-open <file>
 * 兜底：PI_GARDEN_OPEN_CMD 自定义命令（空格切分；含 {file} 则替换，否则文件追加为末参）。
 *
 * 打开器类进程不认退出码（spawn 成功即视为已发起），只报 spawn 级错误。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { release as osRelease } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 选择器/转换共用的级别优先级：取存在的最高级别（l3 预留给未来） */
export const GARDEN_LEVELS = ["l3", "l2", "l1", "l0"] as const;
export type GardenLevel = (typeof GARDEN_LEVELS)[number];

export function isGardenLevel(s: string): s is GardenLevel {
  return (GARDEN_LEVELS as readonly string[]).includes(s);
}

/** dir 下存在的最高级别 md：{base}.{level}.md；都没有返回 null */
export function pickHighestLevelFile(dir: string, base: string, level?: GardenLevel): string | null {
  if (level) {
    const p = path.join(dir, `${base}.${level}.md`);
    return existsSync(p) ? p : null;
  }
  for (const l of GARDEN_LEVELS) {
    const p = path.join(dir, `${base}.${l}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

export type OpenPlatform = "win32" | "wsl" | "darwin" | "linux";

/** 平台检测（注入 env/platform/release 便于测试） */
export function detectPlatform(env: NodeJS.ProcessEnv, platform: string, release: string): OpenPlatform {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft|wsl/i.test(release)) return "wsl";
  return "linux";
}

export interface OpenCommand {
  cmd: string;
  args: string[];
  /** WSL 专用：执行前需先 wslpath -w 翻译 args 里的文件路径占位 */
  translatePath?: boolean;
}

/**
 * 拼打开命令。file 为 Linux/本机路径；WSL 时标记 translatePath，由 openFile 先翻译。
 * PI_GARDEN_OPEN_CMD：如 `powershell.exe -NoProfile -Command Start-Process {file}`。
 */
export function buildOpenCommand(file: string, platform: OpenPlatform, env: NodeJS.ProcessEnv): OpenCommand {
  const custom = (env.PI_GARDEN_OPEN_CMD ?? "").trim();
  if (custom) {
    if (custom.includes("{file}")) {
      const parts = custom.split(/\s+/).map((p) => (p === "{file}" ? file : p.split("{file}").join(file)));
      return { cmd: parts[0], args: parts.slice(1) };
    }
    const parts = custom.split(/\s+/);
    return { cmd: parts[0], args: [...parts.slice(1), file] };
  }
  switch (platform) {
    case "win32":
      return { cmd: "cmd.exe", args: ["/c", "start", "", file] };
    case "wsl":
      return { cmd: "cmd.exe", args: ["/c", "start", "", file], translatePath: true };
    case "darwin":
      return { cmd: "open", args: [file] };
    case "linux":
      return { cmd: "xdg-open", args: [file] };
  }
}

function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * 用默认应用打开文件。返回 { ok, detail }；spawn 成功即 ok（不等退出码）。
 */
export async function openFile(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: OpenPlatform = detectPlatform(env, process.platform, osRelease()),
): Promise<{ ok: boolean; detail: string }> {
  const spec = buildOpenCommand(file, platform, env);
  let args = spec.args;
  if (spec.translatePath) {
    try {
      const { stdout } = await execFileP("wslpath", ["-w", file]);
      const winPath = stdout.trim();
      args = args.map((a) => (a === file ? winPath : a));
    } catch (e) {
      return { ok: false, detail: `wslpath 翻译失败: ${(e as Error).message}` };
    }
  }
  try {
    await spawnDetached(spec.cmd, args);
    return { ok: true, detail: `${spec.cmd} ${args.join(" ")}` };
  } catch (e) {
    return { ok: false, detail: `${spec.cmd} 启动失败: ${(e as Error).message}` };
  }
}
