import { spawn } from "node:child_process";

export async function openUrl(url: string): Promise<void> {
	const platform = process.platform;
	let command: string;
	let args: string[];

	if (platform === "win32") {
		command = "cmd";
		args = ["/c", "start", "", url];
	} else if (platform === "darwin") {
		command = "open";
		args = [url];
	} else {
		command = "xdg-open";
		args = [url];
	}

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
