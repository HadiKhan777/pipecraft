'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Display } = require('./display');
const { generateRunId, saveRun } = require('./store');

// ─── Validation ──────────────────────────────────────────────────────────────

function validateConfig(config) {
  const errors = [];
  if (!config.name || typeof config.name !== 'string') errors.push('Pipeline must have a "name" string');
  if (!Array.isArray(config.stages)) errors.push('Pipeline must have a "stages" array');
  else {
    for (let si = 0; si < config.stages.length; si++) {
      const stage = config.stages[si];
      if (!stage.name) errors.push(`Stage[${si}] missing "name"`);
      if (!Array.isArray(stage.jobs)) errors.push(`Stage "${stage.name}" missing "jobs" array`);
      else {
        for (let ji = 0; ji < stage.jobs.length; ji++) {
          const job = stage.jobs[ji];
          if (!job.name) errors.push(`Stage "${stage.name}" Job[${ji}] missing "name"`);
          if (!Array.isArray(job.steps)) errors.push(`Job "${job.name}" missing "steps" array`);
          else {
            for (let sti = 0; sti < job.steps.length; sti++) {
              const step = job.steps[sti];
              if (!step.name) errors.push(`Job "${job.name}" Step[${sti}] missing "name"`);
              if (!step.run) errors.push(`Job "${job.name}" Step "${step.name}" missing "run" command`);
            }
          }
        }
      }
    }
  }
  return errors;
}

// ─── Topological sort for job dependencies ───────────────────────────────────

function resolveJobOrder(jobs) {
  // Returns jobs in execution order respecting `needs` deps
  // Jobs with no deps or whose deps are complete run first (in parallel batches)
  const nameToJob = {};
  for (const job of jobs) nameToJob[job.name] = job;

  const visited = new Set();
  const inProgress = new Set();
  const order = [];

  function visit(job) {
    if (visited.has(job.name)) return;
    if (inProgress.has(job.name)) throw new Error(`Circular dependency detected for job "${job.name}"`);
    inProgress.add(job.name);
    for (const dep of (job.needs || [])) {
      if (!nameToJob[dep]) throw new Error(`Job "${job.name}" depends on unknown job "${dep}"`);
      visit(nameToJob[dep]);
    }
    inProgress.delete(job.name);
    visited.add(job.name);
    order.push(job);
  }

  for (const job of jobs) visit(job);
  return order;
}

// Group jobs into parallel waves based on deps
function buildExecutionWaves(jobs) {
  const nameToJob = {};
  for (const job of jobs) nameToJob[job.name] = job;

  const completed = new Set();
  const remaining = [...jobs];
  const waves = [];

  while (remaining.length > 0) {
    const wave = [];
    const stillRemaining = [];

    for (const job of remaining) {
      const deps = job.needs || [];
      if (deps.every(d => completed.has(d))) {
        wave.push(job);
      } else {
        stillRemaining.push(job);
      }
    }

    if (wave.length === 0) {
      throw new Error(`Deadlock: circular dependency or unresolvable needs in jobs: ${remaining.map(j => j.name).join(', ')}`);
    }

    waves.push(wave);
    for (const job of wave) completed.add(job.name);
    remaining.length = 0;
    remaining.push(...stillRemaining);
  }

  return waves;
}

// ─── Step execution ──────────────────────────────────────────────────────────

function runCommand(cmd, env, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', cmd], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let timer = null;

    if (timeoutMs != null && timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, timeoutMs * 1000);
    }

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: killed ? -1 : (code ?? 0),
        stdout,
        stderr,
        timedOut: killed,
      });
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + '\n' + err.message, timedOut: false });
    });
  });
}

async function runStep(step, env, cwd, onOutput) {
  const maxRetries = step.retry || 0;
  let attempt = 0;
  let lastResult;

  while (attempt <= maxRetries) {
    if (attempt > 0) {
      const backoff = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, backoff));
    }

    const result = await runCommand(step.run, env, cwd, step.timeout || null);
    lastResult = result;

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (onOutput) onOutput(output);

    if (result.exitCode === 0) {
      return { status: 'success', output, exitCode: 0, attempts: attempt + 1 };
    }

    if (result.timedOut) {
      return {
        status: step.continue_on_error ? 'warning' : 'failed',
        output,
        exitCode: -1,
        error: `Step timed out after ${step.timeout}s`,
        attempts: attempt + 1,
      };
    }

    attempt++;
  }

  const output = [lastResult.stdout, lastResult.stderr].filter(Boolean).join('\n');
  return {
    status: step.continue_on_error ? 'warning' : 'failed',
    output,
    exitCode: lastResult.exitCode,
    error: `Command exited with code ${lastResult.exitCode}`,
    attempts: attempt,
  };
}

// ─── Artifact collection ─────────────────────────────────────────────────────

function copyArtifacts(artifactPaths, srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const p of artifactPaths) {
    const src = path.resolve(srcDir, p);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destDir, p);
    copyRecursive(src, dest);
  }
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

async function runPipeline(config, opts = {}) {
  const runId = generateRunId();
  const runStart = Date.now();
  const runStartISO = new Date(runStart).toISOString();

  // Workspace for this run
  const workspaceBase = path.join(os.homedir(), '.pipecraft', 'workspaces', runId);
  fs.mkdirSync(workspaceBase, { recursive: true });

  const display = new Display(config.name, runId);

  // Build display state structure
  const displayStages = [];
  for (const stage of config.stages) {
    displayStages.push({
      name: stage.name,
      jobs: stage.jobs.map(j => ({
        name: j.name,
        status: 'pending',
        startTime: null,
        currentStep: null,
        stepIndex: 0,
        stepTotal: (j.steps || []).length,
        duration: null,
      })),
    });
  }
  display.setStages(displayStages);
  display.start();

  const runData = {
    id: runId,
    pipelineName: config.name,
    startTime: runStartISO,
    endTime: null,
    duration: null,
    status: 'running',
    stages: [],
  };

  // Filter stages/jobs if requested
  const targetStage = opts.stage;
  const targetJob = opts.job;

  let overallStatus = 'success';

  try {
    for (let si = 0; si < config.stages.length; si++) {
      const stageCfg = config.stages[si];

      // Skip if filtering by stage
      if (targetStage && stageCfg.name !== targetStage) continue;

      const stageData = {
        name: stageCfg.name,
        status: 'running',
        jobs: [],
      };
      runData.stages.push(stageData);

      const stageEnv = { ...(config.env || {}), ...(stageCfg.env || {}) };

      // Filter jobs
      let jobsToRun = stageCfg.jobs;
      if (targetJob) jobsToRun = jobsToRun.filter(j => j.name === targetJob);

      // Validate + resolve dep order
      let waves;
      try {
        waves = buildExecutionWaves(jobsToRun);
      } catch (e) {
        display.stop();
        console.error(`Dependency error: ${e.message}`);
        process.exit(1);
      }

      const completedJobs = {};
      let stageFailed = false;

      for (const wave of waves) {
        // Run wave jobs in parallel
        await Promise.all(wave.map(async (jobCfg) => {
          // Check if any dep failed
          const failedDep = (jobCfg.needs || []).find(dep => completedJobs[dep] === 'failed');
          if (failedDep) {
            const dispJob = displayStages[si].jobs.find(j => j.name === jobCfg.name);
            if (dispJob) dispJob.status = 'skipped';
            stageData.jobs.push({
              name: jobCfg.name,
              status: 'skipped',
              steps: [],
              duration: 0,
            });
            completedJobs[jobCfg.name] = 'skipped';
            return;
          }

          const jobStart = Date.now();
          const dispJob = displayStages[si].jobs.find(j => j.name === jobCfg.name);
          if (dispJob) {
            dispJob.status = 'running';
            dispJob.startTime = jobStart;
          }

          // Per-job workspace
          const jobWorkspace = path.join(workspaceBase, stageCfg.name, jobCfg.name);
          fs.mkdirSync(jobWorkspace, { recursive: true });

          const jobEnv = { ...stageEnv, ...(jobCfg.env || {}) };

          const jobData = {
            name: jobCfg.name,
            status: 'running',
            startTime: new Date(jobStart).toISOString(),
            endTime: null,
            duration: null,
            steps: [],
          };
          stageData.jobs.push(jobData);

          let jobFailed = false;
          let jobWarned = false;

          for (let sti = 0; sti < jobCfg.steps.length; sti++) {
            const stepCfg = jobCfg.steps[sti];
            const stepEnv = { ...jobEnv, ...(stepCfg.env || {}) };

            if (dispJob) {
              dispJob.currentStep = stepCfg.name;
              dispJob.stepIndex = sti + 1;
            }

            const stepStart = Date.now();
            const stepResult = await runStep(stepCfg, stepEnv, jobWorkspace, (out) => {
              display.logStep(jobCfg.name, stepCfg.name, out);
            });
            const stepDur = Date.now() - stepStart;

            const stepData = {
              name: stepCfg.name,
              status: stepResult.status,
              duration: stepDur,
              exitCode: stepResult.exitCode,
              attempts: stepResult.attempts,
              output: stepResult.output || '',
              error: stepResult.error || null,
            };
            jobData.steps.push(stepData);

            if (stepResult.status === 'failed') {
              jobFailed = true;
              break;
            } else if (stepResult.status === 'warning') {
              jobWarned = true;
            }
          }

          // Collect artifacts
          if (jobCfg.artifacts && jobCfg.artifacts.paths) {
            const artifactDest = path.join(workspaceBase, 'artifacts', stageCfg.name, jobCfg.name);
            try {
              copyArtifacts(jobCfg.artifacts.paths, jobWorkspace, artifactDest);
            } catch (e) {
              // Non-fatal: artifact collection best-effort
            }
          }

          const jobEnd = Date.now();
          const jobDur = jobEnd - jobStart;

          jobData.status = jobFailed ? 'failed' : (jobWarned ? 'warning' : 'success');
          jobData.endTime = new Date(jobEnd).toISOString();
          jobData.duration = jobDur;

          if (dispJob) {
            dispJob.status = jobData.status;
            dispJob.duration = jobDur;
            dispJob.currentStep = null;
          }

          completedJobs[jobCfg.name] = jobData.status;
          if (jobFailed) stageFailed = true;
        }));

        if (stageFailed) break;
      }

      stageData.status = stageFailed ? 'failed' : 'success';
      if (stageFailed) {
        overallStatus = 'failed';
        break;
      }
    }
  } catch (err) {
    overallStatus = 'failed';
    console.error('Unexpected runner error:', err);
  }

  const runEnd = Date.now();
  runData.endTime = new Date(runEnd).toISOString();
  runData.duration = runEnd - runStart;
  runData.status = overallStatus;

  saveRun(runData);

  display.printFinal(runData);

  return runData;
}

module.exports = { runPipeline, validateConfig };
