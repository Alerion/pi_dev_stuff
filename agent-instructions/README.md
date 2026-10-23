# Agent instructions

`AGENTS.md` holds the global rules that every coding agent loads in every project.
Each agent reads it straight from this repo, so you only edit it here.

The commands below assume the repo is at `~/Workspace/pi_dev_stuff`.

## Claude Code

Claude Code reads `~/.claude/CLAUDE.md`. Make that file import the rules:

```sh
echo '@~/Workspace/pi_dev_stuff/agent-instructions/AGENTS.md' > ~/.claude/CLAUDE.md
```

The setup uses an import, not a symlink, because of `pi-claude-bridge`. The
bridge stops Claude Code from loading `**/CLAUDE.md`, since pi already provides
the context files. That match is on the file name. A symlink whose target is
`AGENTS.md` could get past it and load the rules a second time. An import that
sits inside an excluded `CLAUDE.md` never loads.

Run `/memory` in Claude Code to check that the file is loaded.

## pi

pi loads `~/.pi/agent/AGENTS.md` as a user context file in every working
directory. Link it to this repo:

```sh
ln -sf ~/Workspace/pi_dev_stuff/agent-instructions/AGENTS.md ~/.pi/agent/AGENTS.md
```

Keep these rules out of `~/.pi/agent/APPEND_SYSTEM.md`. If they are in both
files, pi sends them twice.

In a running session, run `/reload` to pick up the changes.
