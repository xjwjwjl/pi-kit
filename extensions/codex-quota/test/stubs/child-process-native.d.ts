declare module "node:child_process?native" {
  export * from "node:child_process";
  const childProcess: typeof import("node:child_process");
  export default childProcess;
}
