'use strict';

// ANSI helpers
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const BRIGHT_WHITE = '\x1b[97m';
const BG_DARK = '\x1b[48;5;234m';

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
const MOVE_UP = (n) => `\x1b[${n}A`;
const MOVE_COL = (n) => `\x1b[${n}G`;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATUS_ICONS = {
  pending:  `${DIM}○${RESET}`,
  running:  `${CYAN}⟳${RESET}`,
  success:  `${GREEN}✓${RESET}`,
  failed:   `${RED}✗${RESET}`,
  skipped:  `${DIM}⊘${RESET}`,
  warning:  `${YELLOW}⚠${RESET}`,
};

function statusColor(status) {
  switch (status) {
    case 'success': return GREEN;
    case 'failed':  return RED;
    case 'running': return CYAN;
    case 'warning': return YELLOW;
    case 'skipped': return DIM;
    default:        return DIM;
  }
}

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function elapsed(startMs) {
  return Date.now() - startMs;
}

function padRight(str, len) {
  // strip ANSI codes for length calculation
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = len - plain.length;
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

class Display {
  constructor(pipelineName, runId) {
    this.pipelineName = pipelineName;
    this.runId = runId;
    this.runNumber = runId;
    this.stages = [];
    this.lineCount = 0;
    this.spinnerIdx = 0;
    this.startTime = Date.now();
    this.interval = null;
    this.isTTY = process.stdout.isTTY;
    this.width = (process.stdout.columns || 80);
    this._lastLines = [];
  }

  setStages(stages) {
    // stages: [{ name, jobs: [{ name, status, startTime, currentStep, stepIndex, stepTotal, duration }] }]
    this.stages = stages;
  }

  start() {
    if (this.isTTY) {
      process.stdout.write(CURSOR_HIDE);
      this.interval = setInterval(() => this.render(), 80);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY) {
      process.stdout.write(CURSOR_SHOW);
    }
  }

  _buildLines() {
    const W = Math.min(this.width, 100);
    const inner = W - 2;
    const date = new Date().toISOString().slice(0, 10);
    const title = ` Pipeline: ${BOLD}${this.pipelineName}${RESET}  run#${this.runId}  ${date} `;
    const titlePlain = title.replace(/\x1b\[[0-9;]*m/g, '');
    const titlePad = inner - titlePlain.length - 4;
    const spinner = SPINNER_FRAMES[this.spinnerIdx % SPINNER_FRAMES.length];

    const lines = [];

    // Top border
    lines.push(`${CYAN}┌─${RESET}${title}${CYAN}${'─'.repeat(Math.max(0, titlePad))}┐${RESET}`);
    lines.push(`${CYAN}│${RESET}${' '.repeat(inner)}${CYAN}│${RESET}`);

    let passed = 0, failed = 0, running = 0, warned = 0, pending = 0;

    for (const stage of this.stages) {
      const stageStatus = this._stageStatus(stage);
      const stageLabel = `  Stage: ${BOLD}${stage.name}${RESET}`;
      const stageStatusStr = stageStatus === 'running'
        ? `${CYAN}[running]${RESET}`
        : stageStatus === 'success'
          ? `${GREEN}[done]${RESET}`
          : stageStatus === 'failed'
            ? `${RED}[failed]${RESET}`
            : stageStatus === 'pending'
              ? `${DIM}[pending]${RESET}`
              : `${DIM}[${stageStatus}]${RESET}`;

      const stageLine = padRight(stageLabel, inner - 14) + '  ' + stageStatusStr;
      lines.push(`${CYAN}│${RESET} ${stageLine}  ${CYAN}│${RESET}`);

      for (const job of stage.jobs) {
        // Count stats
        if (job.status === 'success') passed++;
        else if (job.status === 'failed') failed++;
        else if (job.status === 'running') running++;
        else if (job.status === 'warning') warned++;
        else if (job.status === 'pending') pending++;

        const icon = STATUS_ICONS[job.status] || STATUS_ICONS.pending;
        const nameCol = 18;
        const durCol = 8;

        let jobName = truncate(job.name, nameCol);
        const namePad = nameCol - jobName.length;
        const color = statusColor(job.status);
        const jobNameStr = `${color}${jobName}${RESET}`;

        let durStr = '';
        if (job.status === 'running' && job.startTime) {
          durStr = `${formatDuration(elapsed(job.startTime))}`;
        } else if (job.duration != null) {
          durStr = formatDuration(job.duration);
        }

        let stepInfo = '';
        if (job.status === 'running' && job.currentStep) {
          stepInfo = `  ${DIM}(step ${job.stepIndex}/${job.stepTotal}: ${truncate(job.currentStep, 22)})${RESET}`;
        }

        const spinStr = job.status === 'running' ? `${CYAN}${spinner}${RESET} ` : '  ';
        const jobLine = `    ${spinStr}${icon} ${jobNameStr}${' '.repeat(namePad)}  ${DIM}${durStr}${RESET}${stepInfo}`;
        lines.push(`${CYAN}│${RESET}${jobLine}${CYAN}│${RESET}`);
      }

      lines.push(`${CYAN}│${RESET}${' '.repeat(inner)}${CYAN}│${RESET}`);
    }

    // Summary bar
    const summaryParts = [];
    if (running > 0) summaryParts.push(`${CYAN}● ${running} running${RESET}`);
    if (passed > 0)  summaryParts.push(`${GREEN}✓ ${passed} passed${RESET}`);
    if (failed > 0)  summaryParts.push(`${RED}✗ ${failed} failed${RESET}`);
    if (warned > 0)  summaryParts.push(`${YELLOW}⚠ ${warned} warned${RESET}`);
    if (pending > 0) summaryParts.push(`${DIM}○ ${pending} pending${RESET}`);

    const elapsedStr = `${DIM}elapsed: ${formatDuration(elapsed(this.startTime))}${RESET}`;
    const summaryStr = '  ' + summaryParts.join(`  `) + '  ' + elapsedStr;
    lines.push(`${CYAN}│${RESET}${summaryStr}${CYAN}│${RESET}`);

    // Bottom border
    lines.push(`${CYAN}└${'─'.repeat(inner + 1)}┘${RESET}`);

    this.spinnerIdx++;
    return lines;
  }

  _stageStatus(stage) {
    const statuses = stage.jobs.map(j => j.status);
    if (statuses.some(s => s === 'failed')) return 'failed';
    if (statuses.some(s => s === 'running')) return 'running';
    if (statuses.every(s => s === 'success' || s === 'warning')) return 'success';
    if (statuses.every(s => s === 'pending')) return 'pending';
    return 'running';
  }

  render() {
    const lines = this._buildLines();

    if (this.isTTY && this._lastLines.length > 0) {
      // Move cursor up and overwrite
      process.stdout.write(MOVE_UP(this._lastLines.length));
      for (let i = 0; i < lines.length; i++) {
        process.stdout.write(MOVE_COL(1) + CLEAR_LINE + lines[i] + '\n');
      }
      // If new output is shorter, clear remaining old lines
      for (let i = lines.length; i < this._lastLines.length; i++) {
        process.stdout.write(MOVE_COL(1) + CLEAR_LINE + '\n');
      }
    } else {
      for (const line of lines) {
        process.stdout.write(line + '\n');
      }
    }

    this._lastLines = lines;
  }

  printFinal(runData) {
    this.stop();

    // If TTY, do one final render then print a newline
    if (this.isTTY) {
      this.render();
      process.stdout.write('\n');
    }

    // Print detailed final summary
    const W = Math.min(this.width, 100);
    const sep = '─'.repeat(W);

    console.log('');
    console.log(`${BOLD}${WHITE}Final Summary${RESET}`);
    console.log(sep);
    console.log(`  Pipeline : ${BOLD}${runData.pipelineName}${RESET}`);
    console.log(`  Run ID   : ${runData.id}`);
    console.log(`  Status   : ${statusColor(runData.status)}${BOLD}${runData.status.toUpperCase()}${RESET}`);
    console.log(`  Duration : ${formatDuration(runData.duration)}`);
    console.log(sep);

    for (const stage of runData.stages || []) {
      console.log(`  ${BOLD}Stage: ${stage.name}${RESET}  [${statusColor(stage.status)}${stage.status}${RESET}]`);
      for (const job of stage.jobs || []) {
        const icon = STATUS_ICONS[job.status] || STATUS_ICONS.pending;
        const dur = job.duration != null ? `  ${DIM}${formatDuration(job.duration)}${RESET}` : '';
        console.log(`    ${icon} ${job.name}${dur}`);
        for (const step of job.steps || []) {
          const sicon = STATUS_ICONS[step.status] || STATUS_ICONS.pending;
          console.log(`      ${sicon} ${step.name}`);
        }
      }
    }

    console.log(sep);
    const overallIcon = runData.status === 'success' ? `${GREEN}✓ PASSED${RESET}` :
                        runData.status === 'failed'  ? `${RED}✗ FAILED${RESET}` :
                        `${YELLOW}⚠ WARNED${RESET}`;
    console.log(`  ${overallIcon}  in ${formatDuration(runData.duration)}`);
    console.log('');
  }

  logStep(jobName, stepName, text) {
    // Used when not TTY or for verbose output
    if (!this.isTTY) {
      const lines = text.trim().split('\n');
      for (const line of lines) {
        if (line.trim()) console.log(`  ${DIM}[${jobName}/${stepName}]${RESET} ${line}`);
      }
    }
  }
}

module.exports = { Display };
