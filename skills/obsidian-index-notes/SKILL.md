---
name: obsidian-index-notes
description: Create and update Obsidian index notes with wikilinks and short descriptions. Use when a vault needs a lightweight table of contents for a folder or tag, or when new/changed notes should be reflected in an overview note.
---

# Obsidian Index Notes

Create and maintain **index notes**: Markdown overview notes that link to other notes and include a short one-line description for each entry.

This skill is inspired by the Obsidian community plugin `adanielnoel/obsidian-index-notes`, but is adapted for Pi workflows:
- plain Markdown files
- managed generated block inside a note
- optional folder- or tag-based scope
- short descriptions, not just links
- easy to keep in git and readable outside Obsidian

## When to use

Use this skill when:
- the user asks for an index note / overview note / map-of-content style note
- a new Markdown file was added and an overview note should reflect it
- many notes changed and an index note summary should be refreshed
- you need a compact “first place to look” before reading a whole vault section

## Principles

- Keep index notes short and skimmable.
- Prefer one-line descriptions.
- Preserve manual text outside the managed block.
- Do not index everything by default if a smaller scope is enough.
- Prefer a curated folder or tag scope over giant vault-wide indexes.
- When the user wants consistency across folders or vaults, prefer the filename `index.md`.

## Managed block format

This skill updates only the content between these markers:

```md
<!-- index-note:start -->
...generated entries...
<!-- index-note:end -->
```

Anything outside the markers stays manual.

## Suggested frontmatter for an index note

```yaml
---
title: Practice index
type: index-note
index_type: folder
index_scope: practice
index_sort: mtime-desc
index_group_by: folder
index_include_subfolders: true
index_description_chars: 140
tags:
  - index
  - practice
---
```

Supported config fields:
- `index_type`: `folder` or `tag`
- `index_scope`: folder path or tag name
- `index_sort`: `path-asc`, `path-desc`, `title-asc`, `title-desc`, `mtime-asc`, `mtime-desc`
- `index_group_by`: `none` or `folder`
- `index_include_subfolders`: `true`/`false` for folder indexes
- `index_description_chars`: max description length
- `index_exclude`: optional list of path prefixes to skip

## Helper script

Use the script in this skill directory:

```bash
uv run scripts/update_index_note.py --vault /path/to/vault --index "practice/index.md"
```

Create a new index note if it does not exist yet:

```bash
uv run scripts/update_index_note.py \
  --vault /path/to/vault \
  --index "practice/index.md" \
  --create \
  --title "Practice index" \
  --index-type folder \
  --index-scope practice \
  --group-by folder \
  --sort mtime-desc
```

Dry run:

```bash
uv run scripts/update_index_note.py --vault /path/to/vault --index "practice/index.md" --dry-run
```

## Default workflow

1. Read the existing index note if present.
2. Confirm the intended scope: folder or tag.
3. Run the helper script to refresh the managed block.
4. Read the result.
5. If some descriptions are weak, improve only the affected lines manually.
6. Tell the user what changed.

## Description extraction rules

The helper script prefers, in order:
1. frontmatter `description`
2. frontmatter `summary`
3. frontmatter `excerpt`
4. frontmatter `abstract`
5. first meaningful paragraph in the note body

So when better summaries are needed, it is often useful to add a `description` property to important notes.

## Important behavior for Pi

When you create a new note or significantly rewrite an existing one in an Obsidian vault:
- check whether a nearby or related index note exists
- if yes, consider refreshing it
- if no, suggest creating one only when it would clearly help navigation

Do not force index notes everywhere.

Naming convention:
- prefer folder-local `index.md` when the user wants a predictable filename everywhere
- use the note `title` property to make the visible name more descriptive when needed

## Output style

Prefer entries like:

```md
- [[practice/2026/2026-05-23 BeatStep Pro minimal techno setup|2026-05-23 BeatStep Pro minimal techno setup]] — Chose minimal techno as the starter style for BeatStep Pro practice, using Reaper as a stable sound source before moving to modular.
```

Group under folder headings when that makes scanning easier.
