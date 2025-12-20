/**
 * Type declarations for raw text imports.
 * Allows importing .md files as raw strings.
 */

declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}
