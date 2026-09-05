declare module "node:child_process?native" {
	export * from "node:child_process";
	import childProcess from "node:child_process";
	export default childProcess;
}
