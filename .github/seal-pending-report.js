'use strict';

// Seal build helper (CI only; .github/ is in .npmignore so this never ships).
//
// Upstream's `:ci` scripts run mocha with `--reporter min`, which prints only a
// "N pending" count. This file makes the log name every pending (skipped) test,
// its file, and the skip condition read from the test / hook source, printed
// after mocha's own summary. It changes no test and no reporter output.
//
// Loaded two ways:
//   - Node legs: NODE_OPTIONS="--require <abs path>/.github/seal-pending-report.js"
//     (test commands stay verbatim). In processes without mocha it is a no-op.
//   - Deno leg: as mocha's `--reporter` (test/deno_mocha.mjs takes no
//     --require); it exports the stock `min` reporter unchanged.

const path = require('path');

let Mocha;
try {
  Mocha = require(require.resolve('mocha', { paths: [process.cwd(), path.join(__dirname, '..')] }));
} catch (err) {
  Mocha = null;
}

function condense(src, max) {
  const s = String(src).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' ...' : s;
}

function skipContext(src) {
  if (!src) {
    return null;
  }
  const lines = String(src).split('\n');
  const idx = lines.findIndex(l => /\bskip\(\)/.test(l));
  if (idx === -1) {
    return null;
  }
  return lines.slice(Math.max(0, idx - 3), idx + 1).map(l => l.trim()).filter(Boolean).join(' ');
}

function suitePending(test) {
  for (let s = test.parent; s; s = s.parent) {
    if (s.pending) {
      return s.fullTitle() || '(root)';
    }
  }
  return null;
}

function hookReason(test) {
  // Every ancestor before/beforeEach hook that can skip, nearest first.
  const found = [];
  for (let s = test.parent; s; s = s.parent) {
    const hooks = [].concat(s._beforeAll || [], s._beforeEach || []);
    for (const h of hooks) {
      const src = h.fn && h.fn.toString();
      if (!src || !/skip\(\)/.test(src)) {
        continue;
      }
      const ctx = skipContext(src) || condense(src, 300);
      found.push(`${h.title} of suite "${s.fullTitle() || '(root)'}": ${condense(ctx, 220)}`);
    }
  }
  return found.length ? 'skipped at runtime by ' + found.join(' <- inside ') : null;
}

function baseReason(test) {
  const src = typeof test.fn === 'function' ? test.fn.toString() : null;
  const ctx = skipContext(src);
  if (ctx) {
    return `skipped at runtime by condition in test body: ${condense(ctx, 220)}`;
  }
  const fromHook = hookReason(test);
  if (fromHook) {
    return fromHook;
  }
  const pendingSuite = suitePending(test);
  if (pendingSuite) {
    return `suite "${pendingSuite}" is declared describe.skip()/xdescribe() upstream`;
  }
  if (!src) {
    return 'declared it.skip()/xit() upstream (test body never runs)';
  }
  if (/skip/i.test(src)) {
    return `skipped at runtime via helper called in test body: ${condense(src, 300)}`;
  }
  return 'marked pending by mocha (no skip call found in test or hooks)';
}

// Where in this same workflow run an environment-gated skip does run.
function coverage(reason) {
  const notes = [];
  if (/REPLICA_SET/.test(reason) && !(process.env.START_REPLICA_SET && process.env.REPLICA_SET)) {
    notes.push('needs a replica set (this step runs a standalone mongod by upstream design); it runs in the ' +
      '"Replica Set tests" job and the "Replica-set tests" step of the "Atlas CLI tests" job (START_REPLICA_SET=1 REPLICA_SET=testset)');
  }
  if (/IS_ATLAS/.test(reason) && !process.env.IS_ATLAS) {
    notes.push('needs an Atlas deployment with search (IS_ATLAS); it runs in the "Atlas CLI tests" job and the ' +
      '"Atlas search-index tests" step of the "Replica Set tests" job (local Atlas deployment)');
  }
  if (/version\[0\] < 8/.test(reason) && !/IS_ATLAS/.test(reason)) {
    notes.push('needs MongoDB >= 8; this job uses MONGOMS_VERSION=' + (process.env.MONGOMS_VERSION || 'default') +
      '. It runs in the MongoDB 8.2.0 legs of the test matrix');
  }
  if (/typeof Deno/.test(reason)) {
    notes.push('Deno-only skip (Deno lacks the API under test). It runs in every Node.js job');
  }
  return notes.length ? ' | coverage: ' + notes.join('; ') : '';
}

function reasonFor(test) {
  const reason = baseReason(test);
  return reason + coverage(reason);
}

// The skip condition guarding a test that can skip itself (body or hook), or null.
function gateCondition(test) {
  const src = typeof test.fn === 'function' ? test.fn.toString() : null;
  const ctx = skipContext(src);
  if (ctx) {
    return condense(ctx, 200);
  }
  for (let s = test.parent; s; s = s.parent) {
    for (const h of [].concat(s._beforeAll || [], s._beforeEach || [])) {
      const hsrc = h.fn && h.fn.toString();
      const hctx = hsrc && /skip\(\)/.test(hsrc) ? skipContext(hsrc) : null;
      if (hctx) {
        return condense(hctx, 200);
      }
    }
  }
  return null;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it[key])) {
      groups.set(it[key], []);
    }
    groups.get(it[key]).push(it);
  }
  return groups;
}

function category(reason) {
  if (/coverage: needs a replica set/.test(reason)) {
    return 'replica-set-only (runs in "Replica Set tests" job)';
  }
  if (/coverage: needs an Atlas deployment/.test(reason)) {
    return 'Atlas-only (runs in "Atlas CLI tests" job)';
  }
  if (/coverage: needs MongoDB >= 8/.test(reason)) {
    return 'MongoDB>=8-only (runs in MongoDB 8.2.0 legs)';
  }
  if (/coverage: Deno-only/.test(reason) || /typeof Deno/.test(reason)) {
    return 'Deno-unsupported API (runs in Node.js jobs)';
  }
  if (/declared (it|describe)\.skip/.test(reason)) {
    return 'declared skip upstream';
  }
  return 'other (see group reason)';
}

function envGated(cond) {
  return /process\.env\.|MODULE_NOT_FOUND/.test(cond);
}

function printReport(pending, gatedPassed, stats) {
  const out = [];
  out.push('');
  // 1. Tests guarded by an environment condition that did run here.
  const envRan = gatedPassed.filter(t => envGated(t.cond));
  const otherRan = gatedPassed.length - envRan.length;
  out.push(`===== Env-gated tests that RAN and PASSED in this job: ${envRan.length} =====`);
  for (const [cond, tests] of groupBy(envRan, 'cond')) {
    out.push(`[ran] ${tests.length} passed, guard: ${cond}`);
    out.push('  passed: ' + tests.map(t => t.title).join(' ; '));
  }
  out.push(`(${otherRan} more tests with MongoDB-version / runtime-feature skip guards also ran and passed here)`);
  // 2. Every pending test, grouped by reason.
  const pGroups = groupBy(pending, 'reason');
  out.push(`===== Pending (skipped) tests: ${pending.length}, in ${pGroups.size} reason groups =====`);
  let i = 0;
  for (const [reason, tests] of pGroups) {
    out.push(`[skip group ${++i}] ${tests.length} test(s) - reason: ${reason}`);
    for (const t of tests) {
      out.push(`  - ${t.title}  [${t.file}]`);
    }
  }
  if (!process.env.MONGOOSE_SHARD_TEST_URI) {
    out.push('NOTE: test/shard.test.js registers no tests (they are not counted as passing or pending) ' +
      'unless MONGOOSE_SHARD_TEST_URI names a pre-sharded cluster. Upstream test.yml never sets it, and ' +
      'its 6 tests use the callback API (Model.create(doc, cb), doc.save(cb)) that Mongoose 7+ removed - ' +
      'Model.create() now throws "no longer accepts a callback" - so they cannot pass against any server.');
  }
  // 3. One-screen summary, last so it sits at the end of the job log.
  const cats = {};
  for (const t of pending) {
    const c = category(t.reason);
    cats[c] = (cats[c] || 0) + 1;
  }
  const envRanSummary = [...groupBy(envRan, 'cond')].
    map(([cond, tests]) => `${tests.length}x [${condense(cond.replace(/^.*?if \(/, 'if ('), 90)}]`).join(', ');
  out.push('===== SEAL TEST SUMMARY =====');
  out.push(`passed=${stats.passes} failed=${stats.failures} pending=${stats.pending} total=${stats.tests}`);
  out.push('pending by reason: ' + (Object.keys(cats).map(c => `${c}=${cats[c]}`).join('; ') || 'none'));
  out.push(`env-gated tests that ran and passed in THIS job: ${envRan.length}` + (envRanSummary ? ' - ' + envRanSummary : ''));
  out.push('===== End of seal test report =====');
  console.log(out.join('\n'));
}

if (Mocha && Mocha.Runner && !Mocha.Runner.__sealPendingReport) {
  Mocha.Runner.__sealPendingReport = true;
  const { EVENT_TEST_PENDING, EVENT_TEST_PASS, EVENT_RUN_END } = Mocha.Runner.constants;
  const origRun = Mocha.Runner.prototype.run;
  Mocha.Runner.prototype.run = function(fn, opts) {
    const pending = [];
    const gatedPassed = [];
    // Capture title/reason now: mocha drops test/hook function references
    // after each suite (cleanReferencesAfterRun), so they are gone by run end.
    this.on(EVENT_TEST_PENDING, t => {
      let reason;
      try {
        reason = reasonFor(t);
      } catch (err) {
        reason = `could not derive reason: ${err.message}`;
      }
      pending.push({
        title: t.fullTitle(),
        file: t.file ? path.relative(process.cwd(), t.file) : '(unknown file)',
        reason
      });
    });
    this.on(EVENT_TEST_PASS, t => {
      try {
        const cond = gateCondition(t);
        if (cond) {
          gatedPassed.push({ title: t.fullTitle(), cond });
        }
      } catch (err) {
        // reporting only; never affect the run
      }
    });
    this.once(EVENT_RUN_END, () => printReport(pending, gatedPassed, this.stats || {}));
    return origRun.call(this, fn, opts);
  };
}

module.exports = Mocha ? Mocha.reporters.Min : function NoopReporter() {};
