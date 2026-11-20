/**
 * Runs rga as a child process. The only module that touches Node: the plugin is
 * desktop-only, and tests pass Node's own modules in.
 */
import { Hit, LineSplitter, parseLine, rgaExecutable, searchPath, unreadableFile, unreadableWarning } from "./rga";

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
	/**
	 * Set when the search failed as a whole: rga could not start, or exited with an error
	 * that isn't about particular files (exit 1 means "no matches" and is not one).
	 */
	error: string | null;
	/** Set when the search ran but some files couldn't be read, or rga reported a problem alongside its matches. */
	warning: string | null;
	/** Files rga couldn't extract text from. */
	unreadable: string[];
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
		const unreadable: string[] = [];
		let warning: string | null = null;
		let settle: ((error: string | null) => void) | null = null;

		const done = new Promise<RunOutcome>((resolve) => {
			let settled = false;
			settle = (error) => {
				if (settled) return;
				settled = true;
				resolve({ hits, truncated, cancelled, error: cancelled || truncated ? null : error, warning, unreadable });
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
			// Stopping rga must also stop the rg, rga-preproc and extractor processes it starts;
			// otherwise they would run on after each keystroke. On macOS and Linux rga gets its own
			// process group, and the group is signalled; on Windows taskkill ends the process tree.
			const windows = this.platform === "win32";
			const proc = this.node.cp.spawn(exe, args, { cwd: this.opts.cwd, env, windowsHide: true, detached: !windows });
			stop = () => this.killTree(proc);
			const lines = new LineSplitter();
			const errLines = new LineSplitter();
			let stderr = "";
			// Each unreadable file gets a report: an "rg: <path>: preprocessor command failed" line,
			// then the adapter's output between two rules of dashes. Those are collected as files;
			// anything else (a bad regex, an unknown flag) is kept as the error text.
			let rules = -1;
			const takeErr = (line: string) => {
				const file = unreadableFile(line);
				if (file) {
					unreadable.push(file);
					rules = 0;
					return;
				}
				if (rules >= 0) {
					if (/^-{20,}\s*$/.test(line)) rules++;
					if (rules >= 2) rules = -1;
					return;
				}
				if (stderr.length < 8000) stderr += `${line}\n`;
			};
			const take = (line: string) => {
				if (truncated || cancelled) return;
				const found = parseLine(line);
				if (!found.length) return;
				hits.push(...found.slice(0, maxResults - hits.length));
				if (hits.length >= maxResults) {
					truncated = true;
					stop?.();
					finish(null);
				}
			};
			proc.stdout?.setEncoding("utf8");
			proc.stdout?.on("data", (chunk: string) => lines.push(chunk).forEach(take));
			proc.stderr?.setEncoding("utf8");
			// rga prints a multi-line report per unreadable file; only the "rg: path: ..." lines matter.
			proc.stderr?.on("data", (chunk: string) => errLines.push(chunk).forEach(takeErr));
			proc.on("error", (e: NodeJS.ErrnoException) => finish(e.code === "ENOENT" ? `Could not start rga at ${exe}.` : e.message));
			proc.on("close", (code) => {
				lines.flush().forEach(take);
				errLines.flush().forEach(takeErr);
				// ripgrep: 0 = matches, 1 = no matches, 2 = an error somewhere (with or without matches).
				warning = unreadableWarning(unreadable);
				if (code === 0 || code === 1 || code === null) return finish(null);
				const problem = firstLines(stderr);
				// Unreadable files alone don't fail a search: the rest of the library was searched.
				if (!problem && unreadable.length) return finish(null);
				if (hits.length) {
					warning = [warning, problem].filter(Boolean).join(" ") || `rga exited with code ${code}.`;
					return finish(null);
				}
				finish(problem || `rga exited with code ${code}.`);
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

	/** Stops rga and every process it started. */
	private killTree(proc: import("child_process").ChildProcess): void {
		try {
			if (this.platform === "win32") {
				if (proc.pid) this.node.cp.execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
				else proc.kill();
			} else if (proc.pid) {
				this.node.process.kill(-proc.pid, "SIGTERM");
			} else {
				proc.kill();
			}
		} catch {
			proc.kill();
		}
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
