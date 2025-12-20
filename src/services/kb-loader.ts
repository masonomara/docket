/**
 * Loads KB markdown files at build time using Vite's import.meta.glob.
 * Files are bundled into the worker, no runtime filesystem access needed.
 */

// Import all .md files from /kb/ directory at build time
const kbModules = import.meta.glob("/kb/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Returns a Map of file paths to content for all KB files.
 * Paths are relative to /kb/ (e.g., "general/billing.md")
 */
export function loadKBFiles(): Map<string, string> {
  const files = new Map<string, string>();

  for (const [path, content] of Object.entries(kbModules)) {
    // Convert "/kb/general/file.md" to "general/file.md"
    const relativePath = path.replace(/^\/kb\//, "");
    files.set(relativePath, content);
  }

  return files;
}

/**
 * Returns stats about loaded KB files without loading content.
 */
export function getKBStats(): {
  totalFiles: number;
  byCategory: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};

  for (const path of Object.keys(kbModules)) {
    // Extract category from path: /kb/{category}/...
    const match = path.match(/^\/kb\/([^/]+)\//);
    const category = match ? match[1] : "unknown";
    byCategory[category] = (byCategory[category] || 0) + 1;
  }

  return {
    totalFiles: Object.keys(kbModules).length,
    byCategory,
  };
}
