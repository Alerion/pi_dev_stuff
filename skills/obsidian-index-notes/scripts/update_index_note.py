#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml>=6.0"]
# ///

from __future__ import annotations

import argparse
import datetime as dt
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

START_MARKER = "<!-- index-note:start -->"
END_MARKER = "<!-- index-note:end -->"
DEFAULT_DESCRIPTION_FIELDS = ["description", "summary", "excerpt", "abstract"]


@dataclass
class NoteEntry:
    path: Path
    rel_path: str
    title: str
    description: str
    mtime: float
    folder: str


@dataclass
class IndexConfig:
    title: str | None = None
    index_type: str | None = None
    index_scope: str | None = None
    index_sort: str = "path-asc"
    index_group_by: str = "none"
    index_include_subfolders: bool = True
    index_description_chars: int = 140
    index_exclude: list[str] | None = None
    tags: list[str] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create or update an Obsidian index note.")
    parser.add_argument("--vault", required=True, help="Path to the Obsidian vault root")
    parser.add_argument("--index", required=True, help="Path to the index note, relative to vault or absolute")
    parser.add_argument("--create", action="store_true", help="Create the index note if missing")
    parser.add_argument("--title", help="Title/frontmatter title for a new index note")
    parser.add_argument("--index-type", choices=["folder", "tag"], help="Index scope type")
    parser.add_argument("--index-scope", help="Folder path or tag name for the index")
    parser.add_argument(
        "--sort",
        choices=["path-asc", "path-desc", "title-asc", "title-desc", "mtime-asc", "mtime-desc"],
        help="Sort order",
    )
    parser.add_argument("--group-by", choices=["none", "folder"], help="Grouping mode")
    parser.add_argument("--include-subfolders", dest="include_subfolders", action="store_true")
    parser.add_argument("--no-include-subfolders", dest="include_subfolders", action="store_false")
    parser.set_defaults(include_subfolders=None)
    parser.add_argument("--description-chars", type=int, help="Maximum description length")
    parser.add_argument("--exclude", action="append", default=[], help="Path prefix to exclude; may be repeated")
    parser.add_argument("--dry-run", action="store_true", help="Print the updated note instead of writing it")
    return parser.parse_args()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    parts = text.split("\n---\n", 1)
    if len(parts) != 2:
        return {}, text
    raw_frontmatter = parts[0][4:]
    body = parts[1]
    data = yaml.safe_load(raw_frontmatter) or {}
    if not isinstance(data, dict):
        data = {}
    return data, body


def dump_frontmatter(data: dict[str, Any]) -> str:
    return "---\n" + yaml.safe_dump(data, sort_keys=False, allow_unicode=True).strip() + "\n---\n\n"


def normalize_rel_path(path: Path, vault: Path) -> str:
    return path.relative_to(vault).as_posix()


def coerce_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1", "on"}:
            return True
        if lowered in {"false", "no", "0", "off"}:
            return False
    return default


def coerce_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return [str(value).strip()] if str(value).strip() else []


def merge_config(frontmatter: dict[str, Any], args: argparse.Namespace) -> IndexConfig:
    cfg = IndexConfig()
    cfg.title = args.title or frontmatter.get("title")
    cfg.index_type = args.index_type or frontmatter.get("index_type")
    cfg.index_scope = args.index_scope or frontmatter.get("index_scope")
    cfg.index_sort = args.sort or str(frontmatter.get("index_sort") or cfg.index_sort)
    cfg.index_group_by = args.group_by or str(frontmatter.get("index_group_by") or cfg.index_group_by)
    cfg.index_include_subfolders = coerce_bool(
        args.include_subfolders if args.include_subfolders is not None else frontmatter.get("index_include_subfolders"),
        cfg.index_include_subfolders,
    )
    cfg.index_description_chars = int(
        args.description_chars or frontmatter.get("index_description_chars") or cfg.index_description_chars
    )
    merged_excludes = coerce_list(frontmatter.get("index_exclude")) + list(args.exclude or [])
    cfg.index_exclude = list(dict.fromkeys(merged_excludes))
    cfg.tags = coerce_list(frontmatter.get("tags"))
    return cfg


def canonical_tag(tag: str) -> str:
    tag = tag.strip()
    if tag.startswith("#"):
        tag = tag[1:]
    return tag.strip().strip("/").lower()


def extract_tags(frontmatter: dict[str, Any]) -> list[str]:
    return [canonical_tag(tag) for tag in coerce_list(frontmatter.get("tags"))]


def strip_markdown(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^\)]*\)", r"\1", text)
    text = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"^#+\s*", "", text, flags=re.M)
    text = re.sub(r"^>+\s*", "", text, flags=re.M)
    text = re.sub(r"^[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def shorten(text: str, max_chars: int) -> str:
    text = strip_markdown(text)
    if len(text) <= max_chars:
        return text
    clipped = text[: max_chars - 1].rstrip()
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0]
    return clipped + "…"


def body_without_generated_block(body: str) -> str:
    pattern = re.compile(
        rf"\n*{re.escape(START_MARKER)}.*?{re.escape(END_MARKER)}\n*",
        flags=re.S,
    )
    return re.sub(pattern, "\n\n", body).strip()


def extract_description(frontmatter: dict[str, Any], body: str, max_chars: int) -> str:
    for field in DEFAULT_DESCRIPTION_FIELDS:
        value = frontmatter.get(field)
        if isinstance(value, str) and value.strip():
            return shorten(value.strip(), max_chars)

    clean_body = body_without_generated_block(body)
    lines = clean_body.splitlines()
    buffer: list[str] = []
    in_code_block = False
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block or not line:
            if buffer:
                break
            continue
        if line == START_MARKER or line == END_MARKER:
            continue
        if line.startswith("---"):
            continue
        if line.startswith("#"):
            continue
        if re.match(r"^!\[.*\]", line):
            continue
        if line.startswith("<!--"):
            continue
        buffer.append(line)
        if len(" ".join(buffer)) >= max_chars:
            break
    if buffer:
        return shorten(" ".join(buffer), max_chars)
    return "No description yet."


def display_title(frontmatter: dict[str, Any], file_path: Path) -> str:
    title = frontmatter.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    return file_path.stem


def should_skip_path(rel_path: str, excludes: list[str]) -> bool:
    return any(rel_path == prefix or rel_path.startswith(prefix.rstrip("/") + "/") for prefix in excludes)


def collect_entries(vault: Path, index_path: Path, cfg: IndexConfig) -> list[NoteEntry]:
    if not cfg.index_type or not cfg.index_scope:
        raise SystemExit("Index note config is incomplete: need index_type and index_scope")

    scope = cfg.index_scope.strip().strip("/")
    excludes = [p.strip().strip("/") for p in (cfg.index_exclude or []) if p.strip()]
    entries: list[NoteEntry] = []

    for note_path in vault.rglob("*.md"):
        if note_path == index_path:
            continue
        rel_path = normalize_rel_path(note_path, vault)
        if rel_path.startswith(".obsidian/") or rel_path.startswith(".pi/"):
            continue
        if should_skip_path(rel_path, excludes):
            continue

        text = read_text(note_path)
        frontmatter, body = split_frontmatter(text)

        include = False
        if cfg.index_type == "folder":
            if cfg.index_include_subfolders:
                include = rel_path == scope or rel_path.startswith(scope + "/")
            else:
                include = Path(rel_path).parent.as_posix() == scope
        elif cfg.index_type == "tag":
            include = canonical_tag(scope) in extract_tags(frontmatter)

        if not include:
            continue

        entries.append(
            NoteEntry(
                path=note_path,
                rel_path=rel_path,
                title=display_title(frontmatter, note_path),
                description=extract_description(frontmatter, body, cfg.index_description_chars),
                mtime=note_path.stat().st_mtime,
                folder=Path(rel_path).parent.as_posix(),
            )
        )

    return sort_entries(entries, cfg.index_sort)


def sort_entries(entries: list[NoteEntry], mode: str) -> list[NoteEntry]:
    reverse = mode.endswith("-desc")
    if mode.startswith("path"):
        key = lambda e: e.rel_path.lower()
    elif mode.startswith("title"):
        key = lambda e: e.title.lower()
    elif mode.startswith("mtime"):
        key = lambda e: e.mtime
    else:
        key = lambda e: e.rel_path.lower()
    return sorted(entries, key=key, reverse=reverse)


def render_entry(entry: NoteEntry) -> str:
    target = entry.rel_path[:-3] if entry.rel_path.endswith(".md") else entry.rel_path
    return f"- [[{target}|{entry.title}]] — {entry.description}"


def render_generated_block(entries: list[NoteEntry], cfg: IndexConfig) -> str:
    lines: list[str] = [START_MARKER]
    if not entries:
        lines.append("- No matching notes yet.")
        lines.append(END_MARKER)
        return "\n".join(lines)

    if cfg.index_group_by == "folder":
        current_folder: str | None = None
        for entry in entries:
            folder = entry.folder or "."
            if folder != current_folder:
                if len(lines) > 1:
                    lines.append("")
                heading = folder if folder != "." else "Vault root"
                lines.append(f"### {heading}")
                current_folder = folder
            lines.append(render_entry(entry))
    else:
        lines.extend(render_entry(entry) for entry in entries)

    lines.append(END_MARKER)
    return "\n".join(lines)


def build_note(frontmatter: dict[str, Any], body: str, generated_block: str, cfg: IndexConfig) -> str:
    clean_body = body_without_generated_block(body)
    if clean_body:
        if generated_block not in clean_body:
            new_body = clean_body.rstrip() + "\n\n" + generated_block + "\n"
        else:
            new_body = clean_body
    else:
        new_body = "## Notes\n\n" + generated_block + "\n"

    frontmatter = dict(frontmatter)
    if cfg.title:
        frontmatter["title"] = cfg.title
    frontmatter["type"] = frontmatter.get("type", "index-note")
    if cfg.index_type:
        frontmatter["index_type"] = cfg.index_type
    if cfg.index_scope:
        frontmatter["index_scope"] = cfg.index_scope
    frontmatter["index_sort"] = cfg.index_sort
    frontmatter["index_group_by"] = cfg.index_group_by
    frontmatter["index_include_subfolders"] = cfg.index_include_subfolders
    frontmatter["index_description_chars"] = cfg.index_description_chars
    if cfg.index_exclude:
        frontmatter["index_exclude"] = cfg.index_exclude
    frontmatter["updated"] = dt.date.today().isoformat()
    if cfg.tags:
        frontmatter["tags"] = cfg.tags
    elif "tags" not in frontmatter:
        frontmatter["tags"] = ["index"]

    return dump_frontmatter(frontmatter) + new_body.strip() + "\n"


def ensure_index_exists(index_path: Path, cfg: IndexConfig, create: bool) -> tuple[dict[str, Any], str]:
    if index_path.exists():
        return split_frontmatter(read_text(index_path))
    if not create:
        raise SystemExit(f"Index note not found: {index_path}")
    frontmatter: dict[str, Any] = {}
    if cfg.title:
        frontmatter["title"] = cfg.title
    body = "## Notes\n"
    return frontmatter, body


def resolve_index_path(vault: Path, index_arg: str) -> Path:
    path = Path(index_arg)
    return path if path.is_absolute() else vault / path


def main() -> None:
    args = parse_args()
    vault = Path(args.vault).expanduser().resolve()
    if not vault.exists() or not vault.is_dir():
        raise SystemExit(f"Vault path does not exist or is not a directory: {vault}")

    index_path = resolve_index_path(vault, args.index).resolve()
    if not str(index_path).startswith(str(vault)):
        raise SystemExit("Index note must be inside the vault")
    index_path.parent.mkdir(parents=True, exist_ok=True)

    existing_frontmatter: dict[str, Any] = {}
    existing_body = ""
    if index_path.exists():
        existing_frontmatter, existing_body = split_frontmatter(read_text(index_path))

    cfg = merge_config(existing_frontmatter, args)
    frontmatter, body = ensure_index_exists(index_path, cfg, args.create)
    if not existing_frontmatter:
        existing_frontmatter = frontmatter
    if not existing_body:
        existing_body = body

    entries = collect_entries(vault, index_path, cfg)
    generated_block = render_generated_block(entries, cfg)
    final_text = build_note(existing_frontmatter, existing_body, generated_block, cfg)

    if args.dry_run:
        print(final_text)
        return

    index_path.write_text(final_text, encoding="utf-8")
    print(f"Updated {normalize_rel_path(index_path, vault)} with {len(entries)} entries")


if __name__ == "__main__":
    main()
