'use strict';

// Create all slide slots before starting concurrent rendering workers.
// PptxGenJS preserves this insertion order in the final presentation.
function createOrderedSlideTasks(pptx, files) {
  return files.map((htmlFile, index) => ({
    htmlFile,
    index,
    slide: pptx.addSlide(),
    failed: false
  }));
}

// Remove failed slots from highest index to lowest so earlier slide numbers
// remain stable while PptxGenJS updates its internal slide indices.
function removeFailedSlideTasks(pptx, tasks) {
  const failed = tasks.filter((task) => task.failed).sort((a, b) => b.index - a.index);
  for (const task of failed) {
    if (task.slide && typeof pptx.removeSlide === 'function') {
      pptx.removeSlide(task.slide._slideNum);
    }
  }
  return failed;
}

module.exports = { createOrderedSlideTasks, removeFailedSlideTasks };
