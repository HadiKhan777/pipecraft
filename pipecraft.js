#!/usr/bin/env node
'use strict'
// pipecraft — CI/CD pipeline engine from scratch.
// Zero dependencies. Parallel jobs, dependency resolution, retry, artifacts.

const fs   = require('fs')
const path = require('path')
const net  = require('net')
const { runPipeline, validateConfig } = require('./runner')
const { listRuns, loadRun, getRunLogsText, RUNS_DIR } = require('./store')

const C = {
  reset:  '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan:   '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
}

function fmt(text, ...codes) { return codes.join('') + text + C.reset }
function die(msg) { console.error(fmt('error: ' + msg, C.red)); process.exit(1) }

// ── Config loading ────────────────────────────────────────────────────────────

function loadConfig(file) {
  const f = file || path.join(process.cwd(), '.pipecraft.json')
  if (!fs.existsSync(f)) die(`Pipeline config not found: ${f}\nRun: pipecraft init`)
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch(e) {
    die(`Failed to parse config: ${e.message}`)
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmd_run(args) {
  const opts = {}
  let   file = null
  let   i    = 0

  while (i < args.length) {
    if      (args[i] === '--stage') { opts.stage = args[++i] }
    else if (args[i] === '--job')   { opts.job   = args[++i] }
    else if (args[i] === '--continue-on-error') { opts.continueOnError = true }
    else if (!args[i].startsWith('-')) { file = args[i] }
    i++
  }

  const config = loadConfig(file)
  const errors = validateConfig(config)
  if (errors.length) {
    console.error(fmt('Pipeline validation failed:', C.red, C.bold))
    for (const e of errors) console.error(`  • ${e}`)
    process.exit(1)
  }

  console.log()
  console.log(fmt(`  ▶ ${config.name}`, C.bold, C.cyan))
  if (opts.stage) console.log(fmt(`    Stage filter: ${opts.stage}`, C.dim))
  if (opts.job)   console.log(fmt(`    Job filter: ${opts.job}`,   C.dim))
  console.log()

  const run = await runPipeline(config, opts)
  process.exit(run.status === 'success' ? 0 : 1)
}

function cmd_validate(args) {
  const config = loadConfig(args[0])
  const errors = validateConfig(config)
  if (errors.length) {
    console.error(fmt('Validation failed:', C.red, C.bold))
    for (const e of errors) console.error(`  • ${e}`)
    process.exit(1)
  }
  console.log(fmt(`  ✓ ${config.name} is valid`, C.green))
  console.log(fmt(`    ${config.stages.length} stage(s), ${config.stages.reduce((n, s) => n + s.jobs.length, 0)} job(s)`, C.dim))
}

function cmd_history() {
  const runs = listRuns()
  if (!runs.length) { console.log(fmt('  No runs yet.', C.dim)); return }

  const widths = [8, 30, 10, 24, 10]
  const headers = ['RUN ID', 'PIPELINE', 'STATUS', 'STARTED', 'DURATION']
  const header  = headers.map((h, i) => fmt(h.padEnd(widths[i]), C.bold, C.cyan)).join('  ')
  const divider = widths.map(w => '─'.repeat(w)).join('  ')

  console.log()
  console.log('  ' + header)
  console.log('  ' + divider)

  for (const run of runs.slice(0, 20)) {
    const statusC = run.status === 'success' ? C.green : run.status === 'failed' ? C.red : C.yellow
    const cells = [
      run.id,
      (run.pipeline || '').slice(0, widths[1]),
      fmt(run.status, statusC),
      (run.startTime || '').slice(0, 19).replace('T', ' '),
      run.duration != null ? `${(run.duration / 1000).toFixed(1)}s` : '-',
    ]
    const row = cells.map((c, i) => {
      const plain = c.replace(/\x1b\[[0-9;]*m/g, '')
      return c + ' '.repeat(Math.max(0, widths[i] - plain.length))
    }).join('  ')
    console.log('  ' + row)
  }
  console.log()
}

function cmd_logs(runId) {
  if (!runId) die('run ID required. See: pipecraft history')
  const run = loadRun(runId)
  if (!run) die(`Run '${runId}' not found`)
  console.log(getRunLogsText(run))
}

function cmd_init() {
  const dest = path.join(process.cwd(), '.pipecraft.json')
  if (fs.existsSync(dest)) {
    console.log(fmt('  .pipecraft.json already exists', C.yellow))
    return
  }

  const template = {
    name: path.basename(process.cwd()),
    env: { CI: 'true' },
    stages: [
      {
        name: 'setup',
        jobs: [
          {
            name: 'env-check',
            steps: [
              { name: 'Print environment', run: 'echo "Node $(node --version), OS $(uname -s)"' },
              { name: 'List workspace',    run: 'ls -la' },
            ],
          },
        ],
      },
      {
        name: 'verify',
        jobs: [
          {
            name: 'lint',
            steps: [
              { name: 'Check syntax', run: 'echo "Linting..."  && sleep 0.3 && echo "✓ No issues found"' },
            ],
          },
          {
            name: 'test',
            steps: [
              { name: 'Unit tests',        run: 'echo "Running tests..." && sleep 0.5 && echo "✓ 42 tests passed"' },
              { name: 'Coverage report',   run: 'echo "Coverage: 87%"', continue_on_error: true },
            ],
          },
        ],
      },
      {
        name: 'build',
        jobs: [
          {
            name: 'compile',
            steps: [
              { name: 'Build',   run: 'echo "Building..." && sleep 0.4 && echo "✓ Build complete"' },
              { name: 'Package', run: 'echo "Packaging artifacts..."', timeout: 60 },
            ],
            artifacts: { paths: ['dist/'] },
          },
        ],
      },
    ],
  }

  fs.writeFileSync(dest, JSON.stringify(template, null, 2))
  console.log(fmt('  ✓ Created .pipecraft.json', C.green))
  console.log(fmt('  Run: node pipecraft.js run', C.dim))
}

function cmd_server(args) {
  const port = parseInt(args[0]) || 3141

  // Minimal HTTP server for webhook triggers
  const server = net.createServer((socket) => {
    let buf = ''
    socket.on('data', chunk => {
      buf += chunk.toString()
      if (!buf.includes('\r\n\r\n')) return

      const headerEnd   = buf.indexOf('\r\n\r\n')
      const headerPart  = buf.slice(0, headerEnd)
      const bodyRaw     = buf.slice(headerEnd + 4)
      const [reqLine]   = headerPart.split('\r\n')
      const [method, reqPath] = reqLine.split(' ')

      const headers = {}
      for (const line of headerPart.split('\r\n').slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }

      const contentLen = parseInt(headers['content-length'] || '0', 10)
      if (bodyRaw.length < contentLen) return
      const body = bodyRaw.slice(0, contentLen)

      function respond(status, data) {
        const json = JSON.stringify(data)
        socket.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`)
        socket.end()
      }

      if (method === 'GET' && reqPath === '/health') {
        return respond('200 OK', { status: 'ok', uptime: process.uptime() })
      }

      if (method === 'GET' && reqPath === '/history') {
        return respond('200 OK', listRuns().slice(0, 50))
      }

      if (method === 'GET' && reqPath.startsWith('/logs/')) {
        const runId = reqPath.slice(6)
        const run   = loadRun(runId)
        if (!run) return respond('404 Not Found', { error: 'Run not found' })
        return respond('200 OK', run)
      }

      if (method === 'POST' && reqPath === '/trigger') {
        let triggerConfig
        try {
          const payload = JSON.parse(body || '{}')
          const file    = payload.config || path.join(process.cwd(), '.pipecraft.json')
          triggerConfig = typeof payload.pipeline === 'object' ? payload.pipeline : loadConfig(file)
        } catch(e) {
          return respond('400 Bad Request', { error: e.message })
        }

        respond('202 Accepted', { status: 'triggered', pipeline: triggerConfig.name })

        // Run pipeline asynchronously
        runPipeline(triggerConfig, {}).catch(e => console.error('Pipeline error:', e.message))
        return
      }

      respond('404 Not Found', { error: `${method} ${reqPath} not found` })
    })
    socket.on('error', () => {})
  })

  server.listen(port, () => {
    console.log()
    console.log(fmt(`  pipecraft webhook server  :${port}`, C.bold, C.cyan))
    console.log()
    console.log(`  POST /trigger   Run pipeline  (body: {"config":"path"} or {"pipeline":{...}})`)
    console.log(`  GET  /history   List runs`)
    console.log(`  GET  /logs/:id  Get run details`)
    console.log(`  GET  /health    Health check`)
    console.log()
  })
}

function showHelp() {
  console.log(`
${fmt('pipecraft', C.bold, C.cyan)} — CI/CD pipeline engine

${fmt('Commands', C.bold)}
  run [file]              Run pipeline (default: .pipecraft.json)
    --stage <name>        Run only a specific stage
    --job <name>          Run only a specific job
  validate [file]         Validate pipeline config
  init                    Scaffold a .pipecraft.json in current directory
  history                 Show past run history
  logs <run-id>           Show detailed logs for a run
  server [port]           Start webhook trigger server (default port 3141)

${fmt('Pipeline config (.pipecraft.json)', C.bold)}
  {
    "name": "My Pipeline",
    "env": { "CI": "true" },
    "stages": [
      {
        "name": "build",
        "jobs": [
          {
            "name": "compile",
            "needs": ["lint"],          ${fmt('// wait for other jobs', C.dim)}
            "env":   { "NODE_ENV": "production" },
            "steps": [
              { "name": "Build", "run": "npm run build",
                "timeout": 120,         ${fmt('// seconds', C.dim)}
                "retry": 2,             ${fmt('// retry up to 2x with backoff', C.dim)}
                "continue_on_error": false }
            ],
            "artifacts": { "paths": ["dist/"] }
          }
        ]
      }
    ]
  }

${fmt('Features', C.dim)}
  Parallel jobs within a stage · Dependency graph (needs) · Retry with
  exponential backoff · Timeout per step · Artifact collection · Live TUI
  display · Run history · Webhook server for remote triggering
`)
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv

const commands = {
  run:      () => cmd_run(args),
  validate: () => cmd_validate(args),
  init:     () => cmd_init(),
  history:  () => cmd_history(),
  logs:     () => cmd_logs(args[0]),
  server:   () => cmd_server(args),
  help:     () => showHelp(),
}

if (!cmd || !commands[cmd]) {
  showHelp()
} else {
  Promise.resolve(commands[cmd]()).catch(e => {
    console.error(fmt('error: ' + e.message, C.red))
    process.exit(1)
  })
}
