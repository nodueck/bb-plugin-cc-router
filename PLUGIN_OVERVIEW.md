# CC-Router

A BB plugin that keeps [CC-Router](https://github.com/Timo972/cc-router) visible while you work: router health, every account's allowance usage, and the account each thread is running on.

## Sidebar and badge

The plugin adds a **CC-Router** entry to the sidebar with a live badge such as `4/6` showing how many accounts can take requests right now. The badge turns orange when some accounts are exhausted, cooling down, or unhealthy, and red when none are ready or the router is unreachable.

## CC-Router page

Behind the sidebar entry you get a full status page: router health, version, uptime and totals, a provider summary, and a card per account with its 5-hour and 7-day usage windows, reset times, sessions, and state.

## Thread header button

Each Claude Code and Codex thread shows a header button like `main-account · 5%`: the account this session runs on and its highest current usage. Click it to jump to the CC-Router page.

The thread's account comes from the exact CC-Router session binding — the plugin never guesses from logs. CC-Router forgets a binding an hour after its last request, so the plugin records the account when each turn ends. An idle thread then shows its last account as `main-account · 5% · last`.

## Polling

Status refreshes every five minutes. Use the **Refresh** button to reload immediately.

## Requirements

- BB 0.49 or newer.
- [CC-Router](https://github.com/Timo972/cc-router) 0.13.1 or newer on `127.0.0.1:3456`.
- Claude Code or Codex threads routed through CC-Router.
