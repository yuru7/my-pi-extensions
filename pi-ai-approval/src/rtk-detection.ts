/**
 * `pi-rtk-optimizer` rewrites shell commands into `rtk ...` proxy calls before
 * Pi sees them. `rtk` only filters command output; it is not a safety boundary,
 * so risk review needs to know when a command invokes it.
 *
 * Detection is deliberately shell-aware instead of a substring match: quoted
 * text, escaped operators, and heredoc bodies contain literal data rather than
 * commands, and must not trigger the RTK reviewer guidance.
 */

/** True when any command position in `command` is an `rtk` invocation. */
export function commandContainsRtk(command: string): boolean {
	return splitShellSegments(command).some(
		(segment) => scanShellWord(segment, 0)?.raw === "rtk",
	);
}

/** Action-level helper for bash/powershell review actions. */
export function shellActionContainsRtk(action: {
	tool: string;
	payload: Record<string, unknown>;
}): boolean {
	if (action.tool !== "bash" && action.tool !== "powershell") return false;
	const command = action.payload.command;
	return typeof command === "string" && commandContainsRtk(command);
}

interface ShellWord {
	raw: string;
	value: string;
	end: number;
}

interface Heredoc {
	delimiter: string;
	stripTabs: boolean;
}

/**
 * Splits a command line on unquoted, unescaped shell operators. Heredoc bodies
 * are literal data, so lines between `<<DELIM` and the closing delimiter stay
 * inside the segment that opened them. This is deliberately not a full shell
 * parser.
 */
function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let start = 0;
	let index = 0;
	let lineStart = 0;
	let quote: "'" | '"' | undefined;
	let heredoc: Heredoc | undefined;
	while (index < command.length) {
		const character = command[index] ?? "";
		if (heredoc) {
			if (character !== "\n") {
				index++;
				continue;
			}
			const line = command.slice(lineStart, index);
			const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
			lineStart = index + 1;
			if (candidate !== heredoc.delimiter) {
				index++;
				continue;
			}
			heredoc = undefined;
			// Fall through: the newline after the closing delimiter ends the segment.
		} else {
			if (character === "\\" && quote !== "'" && index + 1 < command.length) {
				index += 2;
				continue;
			}
			if (quote === undefined && (character === "'" || character === '"')) {
				quote = character;
				index++;
				continue;
			}
			if (quote === character) {
				quote = undefined;
				index++;
				continue;
			}
			if (quote !== undefined) {
				index++;
				continue;
			}
			if (character === "\n") {
				const opening = heredocInLine(command.slice(lineStart, index));
				lineStart = index + 1;
				if (opening) {
					// The body belongs to this segment until the closing delimiter.
					heredoc = opening;
					index++;
					continue;
				}
			}
		}
		const separator = shellSeparatorAt(command, index);
		if (separator) {
			segments.push(command.slice(start, index));
			index += separator.length;
			start = index;
			if (separator === "\n") lineStart = index;
			continue;
		}
		index++;
	}
	segments.push(command.slice(start));
	return segments;
}

function shellSeparatorAt(command: string, index: number): string | undefined {
	const character = command[index];
	if (character === "&" || character === "|") {
		return command[index + 1] === character
			? `${character}${character}`
			: character;
	}
	return character === ";" || character === "\n" ? character : undefined;
}

/** Finds an unquoted `<<`/`<<-` heredoc opener and its delimiter on `line`. */
function heredocInLine(line: string): Heredoc | undefined {
	let index = 0;
	let quote: "'" | '"' | undefined;
	while (index < line.length) {
		const character = line[index] ?? "";
		if (character === "\\" && quote !== "'") {
			index += 2;
			continue;
		}
		if (quote === undefined && (character === "'" || character === '"')) {
			quote = character;
			index++;
			continue;
		}
		if (quote === character) {
			quote = undefined;
			index++;
			continue;
		}
		if (quote !== undefined) {
			index++;
			continue;
		}
		if (character !== "<" || line[index + 1] !== "<") {
			index++;
			continue;
		}
		if (line[index + 2] === "<") {
			// Here-string: the word is an argument, not a heredoc body.
			index += 3;
			continue;
		}
		const stripTabs = line[index + 2] === "-";
		const word = scanShellWord(line, stripTabs ? index + 3 : index + 2);
		if (!word?.value) return undefined;
		return { delimiter: word.value, stripTabs };
	}
	return undefined;
}

/** Reads one shell word from `start`, keeping quoted and escaped text intact. */
function scanShellWord(input: string, start: number): ShellWord | undefined {
	let index = start;
	while (index < input.length && /\s/.test(input[index] ?? "")) index++;
	let raw = "";
	let value = "";
	let quote: "'" | '"' | undefined;
	while (index < input.length) {
		const character = input[index] ?? "";
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else value += character;
			raw += character;
			index++;
			continue;
		}
		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
			} else if (character === "\\" && index + 1 < input.length) {
				const escaped = input[++index] ?? "";
				raw += `\\${escaped}`;
				value += escaped;
				index++;
				continue;
			} else {
				value += character;
			}
			raw += character;
			index++;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			raw += character;
			index++;
			continue;
		}
		if (character === "\\" && index + 1 < input.length) {
			const escaped = input[++index] ?? "";
			raw += `\\${escaped}`;
			value += escaped;
			index++;
			continue;
		}
		if (/[\s;|&<>()]/.test(character)) break;
		raw += character;
		value += character;
		index++;
	}
	return raw ? { raw, value, end: index } : undefined;
}
