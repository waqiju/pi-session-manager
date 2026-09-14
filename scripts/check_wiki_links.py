#!/usr/bin/env python3
"""garden wiki 链接与结构校验。

仿照 bot_home 的 scripts/check_wiki_links.py：
- 校验 wiki 内 markdown 的链接可达性（跳过代码围栏与行内代码）
- 校验目录结构：必备 README、任务目录规范
- 校验任务页五段式结构：Before You Begin / Steps / Verify / Troubleshooting / Related

用法：python3 scripts/check_wiki_links.py
"""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
PATTERNS = ("wiki/**/*.md", "AGENTS.md", "README.md")
LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")


def is_external(url: str) -> bool:
    return url.startswith("#") or bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url))


def resolve_link(source: Path, url: str) -> Path:
    if url.startswith("wiki/"):
        return ROOT / url
    return source.parent / url


def iter_markdown_files():
    seen = set()
    for pattern in PATTERNS:
        for path in ROOT.glob(pattern):
            if path.is_file() and path not in seen:
                seen.add(path)
                yield path


def check_links():
    problems = []
    for path in iter_markdown_files():
        text = path.read_text(encoding="utf-8")
        scan_text = INLINE_CODE_RE.sub("", FENCE_RE.sub("", text))
        rel = path.relative_to(ROOT).as_posix()
        for match in LINK_RE.finditer(scan_text):
            url = match.group(2).strip()
            clean = url.split("#", 1)[0]
            if not clean or is_external(clean):
                continue
            target = resolve_link(path, clean)
            if not target.exists():
                problems.append(f"{rel}: broken link {url} -> {target}")
    return problems


def check_structure():
    problems = []
    required = (
        "wiki/internals/README.md",
        "wiki/internals/concepts/README.md",
        "wiki/internals/tasks/README.md",
        "wiki/internals/reference/README.md",
    )
    for rel in required:
        if not (ROOT / rel).exists():
            problems.append(f"missing required file: {rel}")

    if (ROOT / "docs").exists():
        problems.append("docs/ directory must not exist")

    # reference 子目录必须有 README（当前无子目录，防御未来）
    for directory in (ROOT / "wiki/internals/reference").iterdir():
        if directory.is_dir() and not (directory / "README.md").exists():
            problems.append(f"reference directory missing README.md: {directory.relative_to(ROOT).as_posix()}")
    return problems


def check_task_pages():
    problems = []
    required_sections = (
        "## Before You Begin",
        "## Steps",
        "## Verify",
        "## Troubleshooting",
        "## Related",
    )
    tasks_root = ROOT / "wiki/internals/tasks"
    for path in tasks_root.glob("*.md"):
        if path.name == "README.md":
            continue
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT).as_posix()
        for section in required_sections:
            if section not in text:
                problems.append(f"{rel}: missing task section {section}")
    return problems


def main() -> int:
    problems = []
    problems.extend(check_links())
    problems.extend(check_structure())
    problems.extend(check_task_pages())

    if problems:
        for problem in problems:
            print(problem)
        return 1

    print("OK: wiki links and structure passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
