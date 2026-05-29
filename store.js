'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const RUNS_DIR = path.join(os.homedir(), '.pipecraft', 'runs');

function ensureRunsDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function generateRunId() {
  return crypto.randomBytes(4).toString('hex');
}

function saveRun(runData) {
  ensureRunsDir();
  const filename = `${runData.startTime.replace(/[:.]/g, '-')}-${runData.id}.json`;
  const filepath = path.join(RUNS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(runData, null, 2));
  return filepath;
}

function loadRun(runId) {
  ensureRunsDir();
  const files = fs.readdirSync(RUNS_DIR);
  const match = files.find(f => f.includes(runId));
  if (!match) return null;
  return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, match), 'utf8'));
}

function listRuns() {
  ensureRunsDir();
  const files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json'));
  return files
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
        return {
          id: data.id,
          pipeline: data.pipelineName,
          status: data.status,
          startTime: data.startTime,
          endTime: data.endTime,
          duration: data.duration,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
}

function getRunLogsText(runData) {
  const lines = [];
  lines.push(`Run ID: ${runData.id}`);
  lines.push(`Pipeline: ${runData.pipelineName}`);
  lines.push(`Status: ${runData.status}`);
  lines.push(`Started: ${runData.startTime}`);
  lines.push(`Ended: ${runData.endTime || 'N/A'}`);
  lines.push(`Duration: ${runData.duration != null ? (runData.duration / 1000).toFixed(2) + 's' : 'N/A'}`);
  lines.push('');

  for (const stage of runData.stages || []) {
    lines.push(`━━━ Stage: ${stage.name} [${stage.status}] ━━━`);
    for (const job of stage.jobs || []) {
      lines.push(`  ── Job: ${job.name} [${job.status}] (${job.duration != null ? (job.duration / 1000).toFixed(2) + 's' : 'N/A'})`);
      for (const step of job.steps || []) {
        lines.push(`    ── Step: ${step.name} [${step.status}]`);
        if (step.output) {
          step.output.split('\n').forEach(l => lines.push(`      ${l}`));
        }
        if (step.error) {
          step.error.split('\n').forEach(l => lines.push(`      ERR: ${l}`));
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { generateRunId, saveRun, loadRun, listRuns, getRunLogsText, RUNS_DIR };
