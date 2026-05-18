// Wrangler `Text` rule for **/*.md (see wrangler.jsonc) makes esbuild
// import markdown files as string default exports. Declare the module
// shape so TypeScript follows along.
declare module '*.md' {
  const content: string;
  export default content;
}
