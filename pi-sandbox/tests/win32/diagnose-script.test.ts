// pi-sandbox/tests/win32/diagnose-script.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL(
		"../../resources/skills/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1",
		import.meta.url,
	),
);
const PACKAGE_SID = "S-1-15-2-1234567890-1234567890";

/** pwsh when installed, Windows PowerShell 5.1 otherwise (same policy as the e2e suite: the target machine may only have 5.1). */
function resolvePowerShell(): string {
	const pathDirs = (process.env.PATH ?? "").split(delimiter);
	for (const name of ["pwsh.exe", "powershell.exe"]) {
		for (const dir of pathDirs) {
			if (dir.length > 0 && existsSync(join(dir, name))) return join(dir, name);
		}
	}
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const PS = process.env.PI_SANDBOX_PS ?? (process.platform === "win32" ? resolvePowerShell() : "pwsh");

/** Current user's `[domain\]name`: a bare USERNAME in a domain environment may resolve to the local account. */
function currentUser(): string {
	return `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
}

function shell(program: string, args: readonly string[]) {
	const result = spawnSync(program, args, { encoding: "utf8", timeout: 120_000 });
	// When spawn fails (for example, that PowerShell is not on PATH), result.error must land in output; otherwise the assertion collapses to "expected null to be 0".
	const spawnError = result.error === undefined ? "" : `[spawn error: ${result.error.message}]`;
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}${spawnError}` };
}

function runScript(args: readonly string[]) {
	return shell(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args]);
}

/** Write one deny ACE (trustee = package SID). Confirmed on a real machine: `icacls /deny "*SID:…"` **silently does nothing** here
 * (status 0, but the ACE is absent from the SDDL; the script's collateral check passing implies it was never written).
 * Writing the security descriptor through .NET skips icacls's mapping and uses the same path as the capability ACE this repo already verified as writable on a real machine.
 * Read it back immediately so a failure lands on the fixture, not on "the script failed to preserve an ACE that was never there". */
function addPackageDenyAce(path: string): void {
	const literal = psLiteral(path);
	const command = [
		`$sid = [System.Security.Principal.SecurityIdentifier]::new('${PACKAGE_SID}')`,
		`$acl = Get-Acl -LiteralPath ${literal}`,
		"$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Deny'))",
		`Set-Acl -LiteralPath ${literal} -AclObject $acl`,
	].join("; ");
	const result = shell(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
	expect(result.status, result.output).toBe(0);
	expect(sddl(path)).toMatch(/\(D;[A-Z]*;[^)]*;;;S-1-15-2-1234567890-1234567890\)/u);
}

/** PowerShell literal (single quotes doubled) for splicing into `-Command`. */
function psLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function reports(output: string) {
	return output
		.split(/\r?\n/u)
		.filter((line) => line.startsWith("REPORT "))
		.map(
			(line) =>
				JSON.parse(line.slice("REPORT ".length)) as {
					kind?: string;
					operation?: string;
					status?: string;
					details?: Record<string, unknown>;
				},
		);
}

function recap(output: string) {
	const line = output.split(/\r?\n/u).find((l) => l.startsWith("RECAP "));
	return line === undefined ? undefined : (JSON.parse(line.slice("RECAP ".length)) as Record<string, unknown>);
}

/** `nextAction` lives in the summary report record's details, not in RECAP (RECAP only has verdicts/changes/verifications/refusals/scans/report).
 * The discriminator is `kind`: `Write-Report`'s parameter order is (Kind, Operation, Target, ...), and the summary record's `operation` holds the mode. */
function nextAction(output: string): unknown {
	return reports(output).find((record) => record.kind === "summary")?.details?.nextAction;
}

/** RECAP.verdicts is an array of objects: `{ path, verdict, writeDac, writeOwner, packageObjects }`. */
function verdicts(output: string): string[] {
	const value = recap(output)?.verdicts;
	return Array.isArray(value) ? value.map((entry) => String((entry as { verdict?: unknown }).verdict)) : [];
}

/** Add an explicit package allow ACE (using a real S-1-15-2-* shape). */
function addPackageAce(path: string): void {
	const icacls = shell("icacls", [path, "/grant", `*${PACKAGE_SID}:(OI)(CI)(RX)`]);
	expect(icacls.status, icacls.output).toBe(0);
}

/** Build a target that needs a grant: break inheritance and give the current user only RX, leaving only the **owner's implicit WRITE_DAC**, which lands exactly on the script's grant branch.
 * Do not use `icacls /remove`: it deletes only explicit ACEs, so inherited FullControl remains and the target looks completely healthy. */
function needsGrant(path: string): void {
	const icacls = shell("icacls", [path, "/inheritance:r", "/grant", `${currentUser()}:(OI)(CI)(RX)`]);
	expect(icacls.status, icacls.output).toBe(0);
	// The fixture must actually take effect: only RX remains and inherited FullControl is broken, or the case passes or fails for the wrong reason.
	// These two self-checks read icacls text rather than sddl(): `(RX)`/`(F)` are icacls symbolic forms (stable across locales).
	// In SDDL the permission bits are hex masks (RX = 0x1200a9, F = 0x1f01ff), so `(RX)` never appears. After sddl() switched to
	// Get-Acl's SDDL, keeping the old assertions would regress cases 2/7, which already passed on the second real-machine run, solely because of the fixture self-check.
	const icaclsText = shell("icacls", [path]).output;
	expect(icaclsText).toContain("(RX)");
	expect(icaclsText).not.toContain("(F)");
}

/** Use `Get-Acl`'s SDDL (locale-independent, SID form, so a `(D;` deny ACE can be asserted directly) instead of icacls's localized output. */
function sddl(path: string): string {
	const result = shell(PS, [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		`(Get-Acl -LiteralPath ${psLiteral(path)}).Sddl`,
	]);
	expect(result.status, result.output).toBe(0);
	return result.output.trim();
}

let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-sbx-acl-"));
});
afterEach(() => {
	// A protected DACL from `/inheritance:r` makes deletion fail with EPERM immediately (not a transient lock): reset the whole
	// tree's ACEs back to inheritance first (the user is the owner and has implicit WRITE_DAC), then delete.
	shell("icacls", [scratch, "/reset", "/T", "/C", "/Q"]);
	rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(process.platform !== "win32")("diagnose-windows-sandbox-acl script", { timeout: 120_000 }, () => {
	it("reports NOT_THIS_CLASS and changes nothing on a healthy directory", () => {
		const target = join(scratch, "healthy");
		shell("cmd", ["/c", "mkdir", target]);
		const before = sddl(target);
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(0);
		expect(verdicts(run.output)).toContain("NOT_THIS_CLASS");
		expect(sddl(target)).toBe(before);
	});

	it("grants the signed-in user full control when WRITE_OWNER is missing and emits a recovery pair", () => {
		const target = join(scratch, "locked");
		shell("cmd", ["/c", "mkdir", target]);
		needsGrant(target);
		const out = join(scratch, "out");
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", out]);
		expect(run.status).toBe(0);
		expect(nextAction(run.output), run.output).toBe("verify_original_confined_operation");
		const files = readdirSync(out);
		expect(files.some((f) => /^acl-backup-.*\.json$/u.test(f))).toBe(true);
		expect(files.some((f) => /^acl-backup-.*\.ps1$/u.test(f))).toBe(true);
		expect(run.output).toContain("ROLLBACK ");
	});

	it("removes an explicit package allow entry at its source", () => {
		const target = join(scratch, "packaged");
		shell("cmd", ["/c", "mkdir", target]);
		addPackageAce(target);
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(0);
		expect(sddl(target)).not.toContain("S-1-15-2-1234567890");
	});

	it("removes package allow entries while preserving deny entries and other allow entries", () => {
		const target = join(scratch, "denied");
		shell("cmd", ["/c", "mkdir", target]);
		// The DENY trustee is the **same package SID** (not the current user). A real machine showed that a deny whose trustee is the current user,
		// if it includes SYNCHRONIZE (both icacls (W) and (D) expand to include S), knocks out the CreateFileW(FILE_WRITE_DAC) probe.
		// A package-SID deny does not affect the user's access check, and it pins the script rule that a same-SID deny must not be removed as a conflict.
		const otherAllow = shell("icacls", [target, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"]);
		expect(otherAllow.status, otherAllow.output).toBe(0);
		addPackageAce(target); // same-SID allow: the removal path must run and remove only the allow
		// Write the deny last: an icacls grant rewrites the whole DACL, so anything written before it can be re-derived or frozen by that disk write.
		// icacls /deny also silently does nothing on this machine (status 0, no ACE), so write it through .NET and self-check.
		addPackageDenyAce(target);
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status, run.output).toBe(0);
		const after = sddl(target);
		// Distinguish by ACE type in the SDDL: the same-SID allow must disappear and the same-SID deny must be preserved as-is.
		expect(after).not.toMatch(/\(A;[A-Z]*;[^)]*;;;S-1-15-2-1234567890-1234567890\)/u);
		expect(after).toMatch(/\(D;[A-Z]*;[^)]*;;;S-1-15-2-1234567890-1234567890\)/u);
		expect(after).toMatch(/\(A;[A-Z]*;[^)]*;;;(?:BU|S-1-5-32-545)\)/u); // other allow ACEs stay as-is (SDDL aliases that well-known SID to BU)
	});

	it("refuses a package source outside -AllowRoot before changing anything and exits 2", () => {
		// Refusal fires only on the package-ACE source (Get-RepairRefusal applies only to packageTargets and grant candidates):
		// place the package ACE on an **ancestor** of the requested path (outside -AllowRoot) to get REPAIR_REFUSED and exit 2.
		const outer = join(scratch, "outer");
		const inner = join(outer, "inner");
		shell("cmd", ["/c", "mkdir", inner]);
		addPackageAce(outer);
		const before = sddl(outer);
		const run = runScript(["-Path", inner, "-AllowRoot", inner, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(2);
		expect(run.output).toContain("REPAIR_REFUSED");
		expect(sddl(outer)).toBe(before);
	});

	it("refuses the managed application tree inside -AllowRoot", () => {
		// Test-DangerousRoot only recognizes real protected roots (%ProgramFiles%\WindowsApps and the like). A same-named
		// directory under a temp folder does not trigger it, so override the child process's ProgramFiles to scratch and let the script's own check fire.
		const managed = join(scratch, "WindowsApps", "app");
		shell("cmd", ["/c", "mkdir", managed]);
		addPackageAce(managed);
		const before = sddl(managed);
		const out = join(scratch, "out");
		// Passing an env override from Node did not take effect on a real machine (the child still read C:\Program Files): set `$env:ProgramFiles`
		// inside the same PowerShell process before invoking the script, and pass the exit code through with `exit $LASTEXITCODE`.
		const run = shell(PS, [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`$env:ProgramFiles = ${psLiteral(scratch)}; & ${psLiteral(SCRIPT)} -Path ${psLiteral(managed)} -AllowRoot ${psLiteral(scratch)} -Out ${psLiteral(out)}; exit $LASTEXITCODE`,
		]);
		expect(run.status, run.output).toBe(2);
		expect(run.output).toContain("REPAIR_REFUSED");
		expect(nextAction(run.output), run.output).toBe("stop");
		expect(sddl(managed)).toBe(before);
	});

	it("restores a saved DACL from the recovery record and the printed ROLLBACK command", () => {
		const target = join(scratch, "restore-me");
		shell("cmd", ["/c", "mkdir", target]);
		needsGrant(target);
		const before = sddl(target);
		const out = join(scratch, "out");
		const repair = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", out]);
		expect(repair.status).toBe(0);
		expect(sddl(target)).not.toBe(before); // the repair must actually change the DACL, or the restore assertions below are meaningless
		const rollbackLine = repair.output.split(/\r?\n/u).find((l) => l.startsWith("ROLLBACK "));
		expect(rollbackLine).toBeDefined();
		// Actually run the printed ROLLBACK command (the line a user would paste), rather than repeating the repair argv.
		const viaCommand = shell(PS, ["-NoProfile", "-Command", (rollbackLine as string).slice("ROLLBACK ".length)]);
		expect(viaCommand.status, viaCommand.output).toBe(0);
		expect(sddl(target)).toBe(before);
		// The record file itself can also be passed to -Restore (RECAP / record contract).
		const record = readdirSync(out).find((f) => /^acl-backup-.*\.json$/u.test(f));
		expect(record).toBeDefined();
		const restored = runScript(["-Path", target, "-AllowRoot", scratch, "-Restore", join(out, record as string)]);
		expect(restored.status).toBe(0);
		expect(sddl(target)).toBe(before);
	});

	it("rejects a missing -AllowRoot, a repair without -Out, and -Restore with two paths", () => {
		const target = join(scratch, "usage");
		shell("cmd", ["/c", "mkdir", target]);
		const missingRoot = runScript(["-Path", target, "-Out", join(scratch, "out")]);
		expect(missingRoot.status).toBe(2);
		expect(missingRoot.output).toContain("-AllowRoot");
		const missingOut = runScript(["-Path", target, "-AllowRoot", scratch]);
		expect(missingOut.status).toBe(2);
		expect(missingOut.output).toContain("-Out");
		// Under `-File`, `-Path a b` does not bind as an array (`b` binds positionally to -AllowRoot, PowerShell reports the parameter as specified more than once
		// and exits 1, rather than the script's ArgumentException). Use `-Command` with an explicit `-Path 'a','b'` array.
		const restoreTwoPaths = shell(PS, [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`& ${psLiteral(SCRIPT)} -Path ${psLiteral(target)},${psLiteral(join(target, "x"))} -AllowRoot ${psLiteral(scratch)} -Restore 'record.json'; exit $LASTEXITCODE`,
		]);
		expect(restoreTwoPaths.status, restoreTwoPaths.output).toBe(2);
		expect(restoreTwoPaths.output).toContain("exactly one -Path");
	});

	it("refuses a package source reached through a junction", () => {
		const outside = join(scratch, "outside-junction");
		const link = join(scratch, "link");
		shell("cmd", ["/c", "mkdir", outside]);
		shell("cmd", ["/c", "mklink", "/J", link, outside]);
		// Place the package ACE on the real directory **behind** the junction: the ancestor chain must cross a reparse point, so the script must refuse.
		// This does not depend on the unsettled question of whether icacls writes the ACL on the link itself or on the target.
		const sub = join(link, "sub");
		shell("cmd", ["/c", "mkdir", sub]);
		addPackageAce(sub);
		const before = sddl(sub);
		const run = runScript(["-Path", sub, "-AllowRoot", scratch, "-Out", join(scratch, "out")]);
		expect(run.status).toBe(2);
		expect(run.output).toContain("REPAIR_REFUSED");
		expect(nextAction(run.output), run.output).toBe("stop");
		expect(sddl(sub)).toBe(before);
	});

	it("writes one JSONL report per run under -Out", () => {
		const target = join(scratch, "report");
		shell("cmd", ["/c", "mkdir", target]);
		const out = join(scratch, "out");
		const run = runScript(["-Path", target, "-AllowRoot", scratch, "-Out", out]);
		expect(run.status).toBe(0);
		const found = readdirSync(out).filter((f) => /^acl-report-.*\.jsonl$/u.test(f));
		expect(found).toHaveLength(1);
		expect(existsSync(join(out, found[0] as string))).toBe(true);
	});
});
