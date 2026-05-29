# pipecraft

[hadikhan777.github.io/portfolio](https://hadikhan777.github.io/portfolio/)

CI/CD pipeline engine from scratch — zero dependencies.

Parallel job execution, dependency graph resolution, retry with exponential backoff, artifact collection, and a live terminal display.

## Features

- **Parallel jobs** — jobs within a stage run with `Promise.all`
- **Dependency graph** — `needs: [...]` resolved via topological sort into execution waves
- **Retry with backoff** — `retry: 2` retries on failure with 1s → 2s → 4s wait
- **Timeouts** — `timeout: 120` kills steps that exceed N seconds
- **`continue_on_error`** — marks step as warning, continues the job
- **Artifact collection** — copies paths from job workspace to run archive
- **Live TUI** — spinner animation, per-job elapsed time, status icons
- **Run history** — every run saved to `~/.pipecraft/runs/`
- **Webhook server** — HTTP endpoint to trigger pipelines remotely

## Quick start

```bash
# Scaffold a pipeline in the current directory
node pipecraft.js init

# Run it
node pipecraft.js run

# Run only one stage
node pipecraft.js run --stage build

# Validate config without running
node pipecraft.js validate

# View run history
node pipecraft.js history

# Show detailed logs for a run
node pipecraft.js logs <run-id>

# Start webhook server on :3141
node pipecraft.js server
```

## Pipeline config

```json
{
  "name": "my-app",
  "env": { "CI": "true" },
  "stages": [
    {
      "name": "test",
      "jobs": [
        {
          "name": "lint",
          "steps": [
            { "name": "ESLint", "run": "npx eslint .", "continue_on_error": true }
          ]
        },
        {
          "name": "unit-tests",
          "steps": [
            { "name": "Run tests", "run": "npm test", "retry": 2, "timeout": 120 }
          ]
        }
      ]
    },
    {
      "name": "build",
      "jobs": [
        {
          "name": "compile",
          "needs": ["lint", "unit-tests"],
          "env": { "NODE_ENV": "production" },
          "steps": [
            { "name": "Build", "run": "npm run build" }
          ],
          "artifacts": { "paths": ["dist/"] }
        }
      ]
    }
  ]
}
```

## Live output

```
┌─ Pipeline: my-app  run#3  2026-05-29 ───────────────────┐
│                                                           │
│  Stage: test                                  [running]  │
│    ⠙ ⟳ lint             1.2s  (step 1/1: ESLint)        │
│    ⠸ ⟳ unit-tests       2.8s  (step 1/1: Run tests)     │
│                                                           │
│  Stage: build                                 [pending]  │
│    ○ compile                                             │
│                                                           │
│  ● 2 running  ○ 1 pending                  elapsed: 2.8s │
└───────────────────────────────────────────────────────── ┘
```

## Webhook server

```bash
node pipecraft.js server 3141
```

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/trigger` | Run pipeline (body: `{"config":"./path.json"}`) |
| `GET` | `/history` | List all runs |
| `GET` | `/logs/:id` | Full run details |
| `GET` | `/health` | Health check |

## Files

| File | Purpose |
|------|---------|
| `pipecraft.js` | CLI — run, validate, init, history, logs, server |
| `runner.js` | Pipeline executor, parallel jobs, retry, artifacts |
| `display.js` | Live TUI display with spinner and status tracking |
| `store.js` | Run history persistence in `~/.pipecraft/runs/` |
| `examples/web-app.json` | 4-stage pipeline: install → quality → build → deploy |
