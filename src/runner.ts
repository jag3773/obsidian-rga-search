/**
 * Runs rga as a child process. The only module that touches Node: the plugin is
 * desktop-only, and tests pass Node's own modules in.
 */
import { Hit, LineSplitter, parseLine, rgaExecutable, searchPath } from "./rga";

export interface NodeModules {
	cp: typeof import("child_process");
	fs: typeof import("fs");
	path: typeof import("path");
	os: typeof import("os");
	process: typeof import("process");
}

declare global {
	interface Window {
		/** Node's require, present in the desktop app's renderer. */
		require: NodeJS.Require;
	}
}

/** Node's modules in the desktop app. */
export function desktopModules(): NodeModules {
	return {
		cp: window.require("child_process") as typeof import("child_process"),
		fs: window.require("fs") as typeof import("fs"),
		path: window.require("path") as typeof import("path"),
		os: window.require("os") as typeof import("os"),
		process: window.require("process") as typeof import("process"),
	};
}

export interface RunOutcome {
	hits: Hit[];
	/** True when the search stopped at the result limit. */
	truncated: boolean;
	cancelled: boolean;
	/** Set when rga could not start or exited with an error (exit 1 means "no matches" and is not one). */
	error: string | null;
}

export interface RunHandle {
	done: Promise<RunOutcome>;
	cancel(): void;
}

export interface RunnerOptions {
	/** A configured path to rga, or "" to look it up on PATH. */
	rgaPath: string;
	/** Working directory: the vault folder. */
	cwd: string;
}

export class NotFoundError extends Error {}

export class Runner {
	constructor(
		private node: NodeModules,
		private opts: RunnerOptions,
	) {
		this.env = node.process.env;
		this.platform = node.process.platform;
	}

	private env: Record<string, string | undefined>;
	private platform: string;

	private pathVar(rgaDir?: string): string {
		return searchPath(this.env.PATH ?? "", { platform: this.platform, home: this.node.os.homedir(), rgaDir });
	}

	/** The rga executable to run: the configured path, else the first one on the extended PATH. */
	resolve(): string {
		const configured = this.opts.rgaPath.trim();
		if (configured) {
			const p = configured.startsWith("~") ? this.node.path.join(this.node.os.homedir(), configured.slice(1)) : configured;
			if (!this.node.fs.existsSync(p)) throw new NotFoundError(`rga was not found at ${p}. Check the path in RGA Search's settings.`);
			return p;
		}
		const sep = this.platform === "win32" ? ";" : ":";
		const name = rgaExecutable(this.platform);
		for (const dir of this.pathVar().split(sep)) {
			const p = this.node.path.join(dir, name);
			if (this.node.fs.existsSync(p)) return p;
		}
		throw new NotFoundError("rga (ripgrep-all) was not found. Install it, for example with `brew install ripgrep-all poppler`, or set its path in RGA Search's settings.");
	}

	/**
	 * Run rga with `args` and collect its matches. Stops early, killing rga, once
	 * `maxResults` matches have arrived.
	 */
	run(args: string[], maxResults = Infinity): RunHandle {
		let stop: (() => void) | null = null;
		let cancelled = false;
		let truncated = false;
		const hits: Hit[] = [];
		let settle: ((error: string | null) => void) | null = null;

		const done = new Promise<RunOutcome>((resolve) => {
			let settled = false;
			settle = (error) => {
				if (settled) return;
				settled = true;
				resolve({ hits, truncated, cancelled, error: cancelled || truncated ? null : error });
			};
			const finish = settle;
			let exe: string;
			try {
				exe = this.resolve();
			} catch (e) {
				finish((e as Error).message);
				return;
			}
			const env = { ...this.env, PATH: this.pathVar(this.node.path.dirname(exe)) };
			// On macOS and Linux rga gets its own process group, so stopping it also stops the
			// rg and rga-preproc processes it starts; otherwise they would run on after each keystroke.
			const group = this.platform !== "win32";
			const proc = this.node.cp.spawn(exe, args, { cwd: this.opts.cwd, env, windowsHide: true, detached: group });
			stop = () => {
				try {
					if (group && proc.pid) this.node.process.kill(-proc.pid, "SIGTERM");
					else proc.kill();
				} catch {
					proc.kill();
				}
			};
			const lines = new LineSplitter();
			let stderr = "";
			const take = (line: string) => {
				if (truncated || cancelled) return;
				const hit = parseLine(line);
				if (!hit) return;
				hits.push(hit);
				if (hits.length >= maxResults) {
					truncated = true;
					stop?.();
					finish(null);
				}
			};
			proc.stdout?.setEncoding("utf8");
			proc.stdout?.on("data", (chunk: string) => lines.push(chunk).forEach(take));
			proc.stderr?.setEncoding("utf8");
			proc.stderr?.on("data", (chunk: string) => {
				if (stderr.length < 8000) stderr += chunk;
			});
			proc.on("error", (e: NodeJS.ErrnoException) => finish(e.code === "ENOENT" ? `Could not start rga at ${exe}.` : e.message));
			proc.on("close", (code) => {
				lines.flush().forEach(take);
				// ripgrep: 0 = matches, 1 = no matches, 2 = error (possibly with matches too).
				if (code === 0 || code === 1 || code === null) finish(null);
				else finish(hits.length ? null : firstLines(stderr) || `rga exited with code ${code}.`);
			});
		});

		return {
			done,
			cancel: () => {
				if (cancelled) return;
				cancelled = true;
				stop?.();
				settle?.(null);
			},
		};
	}

	/** `rga --version`, or an error message. */
	async version(): Promise<{ ok: boolean; text: string }> {
		try {
			const exe = this.resolve();
			return await new Promise((resolve) => {
				this.node.cp.execFile(exe, ["--version"], { env: { ...this.env, PATH: this.pathVar(this.node.path.dirname(exe)) }, timeout: 10000 }, (err, stdout, stderr) => {
					if (err) resolve({ ok: false, text: firstLines(String(stderr)) || err.message });
					else resolve({ ok: true, text: `${firstLines(String(stdout))} (${exe})` });
				});
			});
		} catch (e) {
			return { ok: false, text: (e as Error).message };
		}
	}

	/** Whether a helper program (pdftotext, pandoc) can be found on the PATH rga runs with. */
	hasProgram(name: string): boolean {
		let rgaDir: string | undefined;
		try {
			rgaDir = this.node.path.dirname(this.resolve());
		} catch {
			rgaDir = undefined;
		}
		const sep = this.platform === "win32" ? ";" : ":";
		const exe = this.platform === "win32" ? `${name}.exe` : name;
		return this.pathVar(rgaDir)
			.split(sep)
			.some((dir) => dir && this.node.fs.existsSync(this.node.path.join(dir, exe)));
	}
}

function firstLines(s: string, n = 3): string {
	return s.trim().split("\n").slice(0, n).join("\n").trim();
}
