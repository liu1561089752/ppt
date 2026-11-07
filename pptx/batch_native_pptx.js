'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { generatePptx } = require('./native');

function parseArgs(argv) {
  const options = { inputs: [], inputDir: null, outputDir: 'dist', concurrency: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) options.inputs.push(argv[++i]);
    else if (arg === '--input-dir' && argv[i + 1]) options.inputDir = argv[++i];
    else if (arg === '--output-dir' && argv[i + 1]) options.outputDir = argv[++i];
    else if (arg === '--concurrency' && argv[i + 1]) options.concurrency = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('Unknown or incomplete argument: ' + arg);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8');
  }
  return options;
}

async function collectInputs(options) {
  const files = [...options.inputs];
  if (options.inputDir) {
    const entries = await fs.readdir(options.inputDir, { withFileTypes: true });
    entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => files.push(path.join(options.inputDir, entry.name)));
  }
  const unique = Array.from(new Set(files.map((file) => path.resolve(file))));
  if (!unique.length) throw new Error('Provide --input file.json and/or --input-dir directory');
  return unique;
}

async function generateBatch(inputFiles, outputDir, concurrency = 2) {
  await fs.mkdir(outputDir, { recursive: true });
  const names = inputFiles.map((file) => path.basename(file, path.extname(file)) + '.pptx');
  if (new Set(names).size !== names.length) throw new Error('Input files must have unique base names');

  const results = new Array(inputFiles.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputFiles.length) return;
      const inputPath = inputFiles[index];
      const outputPath = path.join(outputDir, names[index]);
      const raw = await fs.readFile(inputPath, 'utf8');
      const deck = JSON.parse(raw);
      const result = await generatePptx(deck, outputPath);
      results[index] = { input: inputPath, output: outputPath, warnings: result.report };
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, inputFiles.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node pptx/batch_native_pptx.js --input-dir decks --output-dir dist [--concurrency 2]');
    console.log('       node pptx/batch_native_pptx.js --input deck.json --output-dir dist');
    return;
  }
  const inputs = await collectInputs(options);
  const results = await generateBatch(inputs, options.outputDir, options.concurrency);
  console.log(JSON.stringify(results, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, collectInputs, generateBatch };
