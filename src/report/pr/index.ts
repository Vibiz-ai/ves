// PR/CI report formats (ci package, DESIGN-agnostic §5.4, §7.4). Loaded by src/registry/report.ts for
// `ves report --format pr|summary|junit|annotations`. Every function is pure over the card model (+ result rows).
export { renderPrComment, renderJobSummary, markerFor, MARKER_PREFIX, DEFAULT_MAX_CHARS, headline } from './markdown.ts';
export { renderJUnit } from './junit.ts';
export { renderAnnotations } from './annotations.ts';
