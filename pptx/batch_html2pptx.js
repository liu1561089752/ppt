// batch_html2pptx.js
// Convert slide_*.html files into a single .pptx using html2pptx1.js.
//
// Two modes:
//
//  1) Single-directory mode (default — most common after Stage 4):
//       node batch_html2pptx.js <slides_dir> [output.pptx]
//     Converts every slide_*.html under <slides_dir> (sorted) into ONE pptx.
//     If [output.pptx] is omitted, the file is saved next to <slides_dir> as
//     <parent_basename>.pptx (e.g. .../my_deck/slides → .../my_deck/my_deck.pptx).
//
//  2) Batch mode (legacy — walks <base>/ppt_*/download/*/slides):
//       node batch_html2pptx.js --batch <base_dir>
//     Each slides/ folder becomes one .pptx, saved in the parent <name>/ folder.
//
// NODE_PATH=/share/hc/utils/superz/p-p-p-x/ppt0403/node_modules \
//   node batch_html2pptx.js <slides_dir>

const path = require('path');
const fs = require('fs');
const pptxgen = require('pptxgenjs');

// LEGACY PATH. This script draws an existing HTML deck into a .pptx and keeps a raster fallback
// for SVG artwork and CSS gradient canvases. New decks do not come from HTML: author a Deck Spec
// and run the native tool instead -
//
//   node native/cli.js <spec.json|spec.js> out.pptx
//
// which writes every word, panel, table and chart as a PowerPoint object and never rasterises a
// page. See native/README.md and native/LIMITS.md.
const html2pptx = require(path.join(__dirname, 'html2pptx1.js'));
const { createOrderedSlideTasks, removeFailedSlideTasks } = require('./slide_order');

// M-23③:BOUNDS 严重档阈值(pt)。溢出超过此值视为真实排版缺陷(页剔除+failed 计数),
// 低于此值视为排版噪声(仅告警)。与 html2pptx1.js 的 BOUNDS_SEVERE_PT 保持一致。
const BOUNDS_SEVERE_PT = 20;

/** 解析 "⚠ BOUNDS: ... extends Npt beyond X" 的溢出值 */
function boundsOverflowPt(warning) {
  const m = /⚠ BOUNDS:.*extends\s+(\d+(?:\.\d+)?)pt beyond/i.exec(warning);
  return m ? Number(m[1]) : 0;
}

function safeReaddir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function findSlidesDirs(baseDir) {
  // Match: <baseDir>/ppt_*/download/*/slides
  const results = [];
  for (const pptDir of safeReaddir(baseDir)) {
    if (!/^ppt_/.test(pptDir.name) || !pptDir.isDirectory()) continue;
    const downloadDir = path.join(baseDir, pptDir.name, 'download');
    for (const sub of safeReaddir(downloadDir)) {
      if (!sub.isDirectory()) continue;
      const slidesDir = path.join(downloadDir, sub.name, 'slides');
      if (fs.existsSync(slidesDir) && fs.statSync(slidesDir).isDirectory()) {
        results.push(slidesDir);
      }
    }
  }
  return results;
}

function collectHtmlFiles(slidesDir) {
  return fs.readdirSync(slidesDir)
    .filter(f => /^slide.*\.html$/i.test(f))
    .sort()
    .map(f => path.join(slidesDir, f));
}

async function buildPptxFromDir(slidesDir, outputPath, options = {}) {
  const { strict = false, fontConfig = null, concurrency = 4 } = options;
  const htmlFiles = collectHtmlFiles(slidesDir);

  if (htmlFiles.length === 0) {
    console.log(`  [skip] no slide_*.html in ${slidesDir}`);
    return null;
  }

  // M-67 修复第二层(2026-10-12):pptxgenjs 的 addImage({path}) 懒读取图片 ——
  // writeFile 时才打开文件。html2pptx 每页 finally 会清自己的会话 tmpDir,
  // 若 object-fit 中间图(h2p-fit-*.png)落在那里,writeFile 必 ENOENT。
  // 解法:本批次共享一个会话级 TMPDIR(env.TMPDIR),html2pptx 检测到 envTmp
  // 时 finally 跳过清理(其 L5230 已有该分支),产物引用在整个批次内有效;
  // writeFile 完成后这里统一清理。
  const sessionTmp = path.join(
    path.dirname(path.resolve(outputPath)),
    `.h2p-tmp-${path.basename(outputPath).replace(/\.pptx$/i, '')}-${Date.now().toString(36)}`
  );
  fs.rmSync(sessionTmp, { recursive: true, force: true });
  fs.mkdirSync(sessionTmp, { recursive: true });
  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = sessionTmp;

  try {
    return await buildPptxFromDirInner(slidesDir, outputPath, options, htmlFiles);
  } finally {
    process.env.TMPDIR = prevTmp;
    try { fs.rmSync(sessionTmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function buildPptxFromDirInner(slidesDir, outputPath, options, htmlFiles) {
  const { strict = false, fontConfig = null, concurrency = 4 } = options;

  console.log(`  ${htmlFiles.length} slides → ${outputPath} (concurrency=${concurrency})`);

  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';

  // Pre-create slide slots in source order. HTML rendering may run concurrently,
  // but each worker writes into its assigned slide so completion order cannot
  // reorder the final presentation.
  const tasks = createOrderedSlideTasks(pptx, htmlFiles);

  const failures = [];
  const mustFix = [];
  let nextIndex = 0;
  let doneCount = 0;
  const total = tasks.length;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= total) return;
      const task = tasks[i];
      const { htmlFile, slide } = task;
      const base = path.basename(htmlFile);
      console.log(`    [start ${i + 1}/${total}] ${base}`);
      try {
        // Optional per-page preview screenshot (slide_01.html → preview/slide_01.png)
        const screenshotPath = options.previewDir
          ? path.join(options.previewDir, base.replace(/\.html$/i, '.png'))
          : null;
        // M-67:allowedRoots 传给引擎,限定本地图片源白名单(slidesDir + previewDir)。
        const allowedRoots = [path.resolve(slidesDir)];
        if (options.previewDir) allowedRoots.push(path.resolve(options.previewDir));
        const { warnings } = await html2pptx(htmlFile, pptx, { fontConfig, screenshotPath, allowedRoots, slide });
        const mustFixHere = (warnings || []).some(w => w.includes('MUST FIX'));
        // M-23③:BOUNDS 溢出超过 BOUNDS_SEVERE_PT(20pt)也按 mustFix 处理
        const boundsSevere = (warnings || []).some(w => {
          if (!w.includes('⚠ BOUNDS')) return false;
          return boundsOverflowPt(w) > BOUNDS_SEVERE_PT;
        });
        if (mustFixHere || boundsSevere) task.failed = true;
        if (warnings && warnings.length > 0) {
          warnings.forEach(w => {
            // Severe overflow / severe BOUNDS are must-fix signals — surface loudly.
            const severeBounds = w.includes('⚠ BOUNDS') && boundsOverflowPt(w) > BOUNDS_SEVERE_PT;
            if (w.includes('MUST FIX') || severeBounds) {
              task.failed = true;
              mustFix.push({ file: base, message: w, task });
              console.error(`      ${base}: ${w}`);
            } else {
              console.warn(`      ${base}: ${w}`);
            }
          });
        }
      } catch (err) {
        console.error(`      [error] ${base}: ${err.message}`);
        task.failed = true;
        failures.push({ file: htmlFile, error: err });
      } finally {
        doneCount++;
        console.log(`    [done  ${doneCount}/${total}] ${base}`);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Remove failed slots in descending source order so earlier slide indices stay stable.
  const failedTasks = removeFailedSlideTasks(pptx, tasks);
  for (const task of failedTasks) {
    if (!failures.some(failure => failure.file === task.htmlFile)) {
      const issue = mustFix.find(item => item.task === task);
      failures.push({
        file: task.htmlFile,
        error: new Error(issue ? issue.message : 'Slide conversion failed'),
      });
    }
  }

  if (strict && failures.length > 0) {
    throw new Error(failures.map(failure => path.basename(failure.file) + ': ' + failure.error.message).join('\\n'));
  }

  if (failures.length > 0) {
    console.warn(`  ${failures.length} slide(s) failed during conversion.`);
  }

  // Severe-overflow / severe-BOUNDS slides do not block output, but they MUST be
  // fixed — print a consolidated, hard-to-miss list so the caller knows exactly
  // what to re-render.
  if (mustFix.length > 0) {
    console.error(`\n  🚨🚨 ${mustFix.length} slide(s) with SEVERE defects (overflow/BOUNDS>${BOUNDS_SEVERE_PT}pt) — MUST FIX and re-run:`);
    mustFix.forEach(({ file, message }) => console.error(`     - ${file}: ${message}`));
    console.error('');
  }

  await pptx.writeFile({ fileName: outputPath });
  console.log(`  saved: ${outputPath}`);

  // 结构化汇总(M-22):调用侧解析此行判定真实成败,页数不再守恒
  const failedFiles = failures.map(f => path.basename(f.file)).join(',');
  const summary = `CONVERT_SUMMARY total=${total} ok=${total - failures.length} failed=${failures.length} failedFiles=${failedFiles}`;
  console.log(summary);

  return { outputPath, __failed: failures.length, __summary: summary };
}

function defaultOutputPath(slidesDir) {
  // Save the pptx next to the slides/ folder (one folder up),
  // named after the parent directory.
  const parentDir = path.dirname(path.resolve(slidesDir));
  return path.join(parentDir, `${path.basename(parentDir)}.pptx`);
}

async function runSingle(slidesDir, outputPath, options = {}) {
  if (!fs.existsSync(slidesDir) || !fs.statSync(slidesDir).isDirectory()) {
    throw new Error(`slides_dir not found or not a directory: ${slidesDir}`);
  }
  const out = outputPath || defaultOutputPath(slidesDir);
  return await buildPptxFromDir(slidesDir, out, options);
}

async function runBatch(baseDir, options = {}) {
  const slidesDirs = findSlidesDirs(baseDir);
  console.log(`Found ${slidesDirs.length} slides directories under ${baseDir}`);

  for (const slidesDir of slidesDirs) {
    const label = path.relative(baseDir, slidesDir);
    console.log(`\nProcessing: ${label}`);
    try {
      const parentDir = path.dirname(slidesDir);
      const outputPath = path.join(parentDir, `${path.basename(parentDir)}.pptx`);
      const r = await buildPptxFromDir(slidesDir, outputPath, options);
      if (r && r.__failed > 0) global.__convertHadFailures = true;
    } catch (err) {
      console.error(`  [error] ${slidesDir}: ${err.message}`);
      global.__convertHadFailures = true;
      if (options.strict) throw err;
    }
  }
}

function printUsageAndExit(code = 1) {
  console.error(
    'Usage:\n' +
    '  node batch_html2pptx.js [--strict] [--concurrency=N] <slides_dir> [output.pptx]\n' +
    '  node batch_html2pptx.js [--strict] [--concurrency=N] --batch <base_dir>\n'
  );
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');

  let concurrency = 8;
  const concIdx = args.findIndex(a => a === '--concurrency' || a.startsWith('--concurrency='));
  if (concIdx !== -1) {
    const arg = args[concIdx];
    if (arg.includes('=')) {
      concurrency = parseInt(arg.split('=')[1], 10);
    } else {
      concurrency = parseInt(args[concIdx + 1], 10);
    }
    if (!Number.isFinite(concurrency) || concurrency < 1) {
      console.error(`invalid --concurrency value`);
      process.exit(1);
    }
  }

  const filteredArgs = args.filter((arg, i) => {
    if (arg === '--strict') return false;
    if (arg === '--concurrency' || arg.startsWith('--concurrency=')) return false;
    if (concIdx !== -1 && !args[concIdx].includes('=') && i === concIdx + 1) return false;
    if (arg.startsWith('--preview-dir=')) return false;
    return true;
  });

  if (filteredArgs.length === 0) printUsageAndExit();

  const previewDirFlag = args.find((a) => a.startsWith('--preview-dir='));
  const previewDir = previewDirFlag ? previewDirFlag.split('=').slice(1).join('=') : null;
  if (previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
  }
  // M-29:fontConfig 链打通 —— 环境变量 PPTX_FONT_CONFIG(JSON,如
  // {"cjk":"Microsoft YaHei","latin":"Carlito"})可选注入;缺省 null 走引擎内置默认。
  // 解析失败不阻断转换,告警后按缺省处理。
  let fontConfig = null;
  const fontCfgRaw = (process.env.PPTX_FONT_CONFIG || '').trim();
  if (fontCfgRaw) {
    try {
      fontConfig = JSON.parse(fontCfgRaw);
    } catch (e) {
      console.warn(`  [warn] PPTX_FONT_CONFIG 不是合法 JSON,忽略(${e.message})`);
    }
  }
  const runOpts = { strict, concurrency, previewDir, fontConfig };

  if (filteredArgs[0] === '--batch') {
    if (!filteredArgs[1]) printUsageAndExit();
    await runBatch(filteredArgs[1], runOpts);
  } else if (filteredArgs[0] === '--dir') {
    // Backwards-compatible alias for batch mode.
    if (!filteredArgs[1]) printUsageAndExit();
    await runBatch(filteredArgs[1], runOpts);
  } else {
    const slidesDir = filteredArgs[0];
    const outputPath = filteredArgs[1];
    const r = await runSingle(slidesDir, outputPath, runOpts);
    if (r && r.__failed > 0) global.__convertHadFailures = true;
  }

  console.log('\nDone.');

  // 有失败 ⇒ 非零退出码 3(区别于其它错误),调用侧据此判定“部分/全部页失败”
  if (global.__convertHadFailures) process.exitCode = 3;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
