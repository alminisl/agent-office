# Agent Office

**A pixel-art office where your Claude Code sessions come to life as coworkers.**

![Agent Office: Claude Code sessions as pixel-art coworkers](docs/office.gif)

When you run several Claude Code sessions at once, it gets hard to keep track of them: which one is busy, which one is waiting for your permission, which one finished ten minutes ago and is waiting on you. Agent Office reads the session data Claude Code already keeps on your machine and turns every session into a little pixel-art employee with a desk, a status, a personality and a career. You can see at a glance who needs you, jump back into any session with one click, and have some fun along the way.

It is a single zero-dependency Node server plus a canvas front end. Every sprite is drawn procedurally in code; there are no image assets.

## Features

### Office
- Every recent Claude Code session gets its own cubicle, grouped by project (the coloured stripe on a nameplate marks the project).
- A kitchen, gym, game room and lounge where agents spend their breaks.
- Agents arrive and leave through the elevator.
- Zoom in and out, or fit the whole office to the window.

### Agents & status
Live status comes from `~/.claude/sessions`:
- **Busy**: typing at their desk; the speech bubble shows the current tool ("Editing Cart.tsx", "$ Run the test suite").
- **Waiting**: hand raised, needs your permission or input.
- **Your turn**: just replied (idle for under 10 minutes, configurable) and sitting at their desk waiting for you.
- **Idle**: on a break: coffee in the kitchen, the gym, ping pong or the arcade, the sofa, chatting with each other, or peeking into a busy colleague's cubicle.
- **Offline**: out of office with an empty chair. Hide them with the *Show offline* toggle.
- Subagents show up as little helper robots that ride the elevator and stand at the parent's desk until their job is done.

### Progress & gamification
- XP from hands-on work time, tool calls, lines changed, prompts, helpers spawned and pull requests.
- Levels with ranks from Intern to Legend, 12 achievements, and a 👑 for the top agent.
- At level 5 an agent is promoted out of their cubicle into a private office in the executive wing.
- A context bar under every nameplate shows context window usage. Above 80% the agent starts sweating and mutters "maybe /compact?".

### Personalities
- Presets such as Grizzled Senior, Hype Intern, Zen Monk, Sarcastic Wit, Pirate Captain, Nervous Perfectionist, Noir Detective, Shakespearean Bard, Gym Coach, Neo, Morpheus and Agent Smith.
- A personality changes how an agent types, fidgets, walks, talks and where they hang out.
- Customise name, traits, favourite hangout and look (skin, hair, clothes, hair style, glasses), or let Claude generate quirks for them.
- **Bring this personality to work**: when you start or resume a session from the office, the personality's work style is passed to Claude via `--append-system-prompt` (a Perfectionist tests everything, a Detective finds the root cause first, a Senior keeps diffs minimal).

### Roles & background agents
- Hire a **PR Reviewer**, **QA Tester**, **Bug Hunter**, **Security Auditor** or **Docs Reviewer** from *New session*.
- Run them interactively in a terminal, or **inside the office**: a background `claude -p` run with read-only tools that hands in a 📋 report, shown in the agent's panel.

### Dashboard
Press <kbd>D</kbd> for the office dashboard:
- **Overview**: total spend, spend per hour of work, hands-on work time, lines changed, PRs, office motivation, spend and work time by project, who's working right now and who needs you.
- **Employees**: a sortable table with status, what they're doing now, motivation, level, cost, context usage and last activity.
- **Leaderboard** and **Settings**.

### Session control
- **Click an agent** to copy `cd <project> && claude --resume <id>` and open their panel:
  - **Work**: latest report, level, XP, context gauge, achievements, stats, latest replies, prompts and files touched.
  - **Ask**: ask a forked copy of the session a question. The real session is never touched.
  - **Personality**: name, preset, traits, hangout and look.
- **New session**: opens iTerm or Terminal running `claude --session-id <new id>` in the chosen folder, with the personality and role pre-assigned.
- **Open in terminal**: resume a session in a new terminal window.
- **End session**: stops a running `claude` process with SIGTERM (two-step confirm; the transcript is kept).
- **Hide**: remove a cubicle from the office (bring it back later from Settings).

### Easter eggs
- Type `matrix` (or click the white rabbit that sometimes hops by) for digital rain and trench coats; type `bluepill` to leave. The Konami code works too.
- A black cat walks by twice. Déjà vu.
- Agent Smith occasionally copies himself onto a coworker.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/office.jpg" alt="The office"><br><sub><b>The office.</b> Cubicles grouped by project, private offices up top, break rooms below.</sub></td>
    <td width="50%"><img src="docs/agent-panel.jpg" alt="Agent panel"><br><sub><b>Agent panel.</b> A QA Tester that ran in the background and handed in a report.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/dashboard.jpg" alt="Dashboard overview"><br><sub><b>Dashboard.</b> Spend, work time and who needs you.</sub></td>
    <td><img src="docs/employees.jpg" alt="Employees table"><br><sub><b>Employees.</b> Status, motivation, level, cost and context for everyone.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/new-agent.jpg" alt="Hire a new agent"><br><sub><b>Hire a new agent.</b> Pick a role, a personality and where they should work.</sub></td>
    <td><img src="docs/matrix.jpg" alt="Matrix mode"><br><sub><b>Matrix mode.</b> Follow the white rabbit.</sub></td>
  </tr>
</table>

All screenshots use demo mode: the agents, projects and numbers are made up.

## Quick start

```sh
git clone https://github.com/alminisl/agent-office && cd agent-office && npm start
```

Then open <http://localhost:4747>. Press <kbd>?</kbd> in the app for the legend and shortcuts.

Want to try it without touching your own sessions, or show it in a talk?

```sh
npm run demo
```

Demo mode serves a completely made-up office. Nothing is read from `~/.claude`.

There is nothing to install: no dependencies, no build step.

## How it works

- **Sessions** come from the transcripts in `~/.claude/projects/**.jsonl` (the last 14 days, up to 20 cubicles; running sessions are always shown). Transcripts are parsed for titles, prompts, replies, tool calls, files, lines changed, PRs, cost and context usage, and cached by modification time.
- **Live status** comes from `~/.claude/sessions`, which tells the office which sessions are running, busy or waiting.
- **Helpers** are the subagent transcripts of a running session that were touched in the last 45 seconds.
- **Ask** runs `claude -p --resume <id> --fork-session --no-session-persistence --tools ""`, so the question goes to a throwaway fork with no tools, and your original conversation is never modified. It uses your Claude account and can take a while on long sessions.
- **Quirks** are generated with a small `claude -p --model haiku --tools ""` call.
- **Background roles** run `claude -p` with `--allowedTools` decided on the server per role, never taken from the browser. Anything not on the list is denied automatically in print mode, so these agents can read and inspect, but not edit, push or merge:
  - All roles: `Read`, `Grep`, `Glob`, and `git log / diff / show / status / branch / fetch / blame`, `ls`.
  - PR Reviewer: also `gh pr list / view / diff / checks` and `glab mr list / view / diff`.
  - QA Tester and Bug Hunter: also common test runners (`npm test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `make test`, `rspec`, Django tests, ...).

  The final report is saved to `data/reports/` and shown in the agent's panel.
- **Personalities** and hidden cubicles are stored locally in `data/` (ignored by git).

## Configuration

All settings are optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4747` | Port to serve the office on |
| `MAX_DAYS` | `14` | How many days back to look for sessions |
| `MAX_ROOMS` | `20` | Maximum number of cubicles |
| `CLAUDE_DIR` | `~/.claude` | Where Claude Code keeps its data |
| `CLAUDE_BIN` | `claude` | The Claude Code executable |
| `OFFICE_TERMINAL` | `iTerm` if you run inside iTerm, else `Terminal` | Terminal app for New session / Open in terminal (`iTerm` or `Terminal`) |
| `CONTEXT_WINDOW` | `200000` (or 1M for `[1m]` models) | Context window size used for the context bar |
| `DEMO` | unset | Set to `1` for demo mode (same as `--demo`) |

Example: `PORT=8080 MAX_DAYS=7 npm start`

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>?</kbd> | Help |
| <kbd>N</kbd> | New session (hire an agent) |
| <kbd>D</kbd> | Office dashboard |
| <kbd>S</kbd> | Show / hide offline agents |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Cycle through agents |
| <kbd>O</kbd> | Open the selected agent in a terminal |
| <kbd>C</kbd> | Copy the resume command |
| <kbd>A</kbd> | Ask the selected agent a question |
| <kbd>H</kbd> | Hide the selected cubicle |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom in / out |
| <kbd>0</kbd> | Fit to window |
| <kbd>Esc</kbd> | Close panel / dialogs |

## Privacy & safety

- The server listens on `127.0.0.1` only and reads your Claude Code data locally. Your transcripts are never uploaded anywhere by Agent Office.
- The only things that leave your machine are what Claude Code itself sends when you use **Ask**, **Generate quirks** or a **background role**, all of which run the regular `claude` CLI with your account. The page also loads its fonts from Google Fonts.
- **Ask** always uses a forked, non-persistent copy of the session with all tools disabled.
- **Background roles** get a fixed, read-only tool allowlist chosen on the server.
- **End session** asks twice before sending SIGTERM, and only to a `claude` process.
- Personal settings live in `data/`, which is git-ignored.
- Use `npm run demo` for screenshots, recordings and talks so no real session data is shown.

## Requirements

- Node.js 18 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and used at least once (so `~/.claude` exists)
- macOS for the terminal features (New session, Open in terminal), which use AppleScript to drive iTerm or Terminal. Everything else works wherever Node and Claude Code run.

## Project structure

```
server.mjs          Local HTTP server: parses ~/.claude, live status, XP, Ask, roles, terminal control
demo.mjs            Made-up agents and projects for demo mode
public/
  index.html        UI shell: header, side panel, dialogs, dashboard, help
  app.js            Simulation, rendering, agents' behaviour, panel, dashboard, easter eggs
  world.js          Office layout: cubicles, private offices, break rooms
  sprites.js        Procedurally drawn pixel-art characters and furniture
  personas.js       Personality presets, names, looks and quirks
  style.css         Styles
docs/               Screenshots and the GIF used in this README
data/               Your personalities, hidden cubicles and reports (git-ignored)
```

## Contributing

Issues and pull requests are welcome. The project deliberately has no dependencies and no build step, so please keep it that way. Some ideas:

- Linux and Windows terminal support for New session / Open in terminal
- More personalities, break-room activities and achievements
- More background roles
- Sound effects (optional, off by default)

## Disclaimer

Agent Office is an unofficial fan project. It is not affiliated with, endorsed by or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## License

TBD
