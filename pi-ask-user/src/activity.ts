import type { TUI } from "@earendil-works/pi-tui";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/**
 * Terminal bytes that mean a person did something. Focus reports and replies
 * to our own device queries are not activity. Mouse clicks and motion also
 * count when the terminal sends them; wheel scrolling is the required case.
 */
export function isUserActivity(data: string): boolean {
	if (data.length === 0) return false;
	if (data === FOCUS_IN || data === FOCUS_OUT) return false;
	if (/^\x1b\[\?[\d;]*c$/.test(data)) return false;
	if (data.startsWith("\x1b]11;")) return false;
	return true;
}

export function isWheelSequence(data: string): boolean {
	const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (sgr) return (Number(sgr[1]) & 64) !== 0;
	if (data.length === 6 && data.startsWith("\x1b[M")) return ((data.charCodeAt(3) - 32) & 64) !== 0;
	return false;
}

type Listener = (data: string) => { consume?: boolean; data?: string } | undefined;

/**
 * Observe raw terminal input without consuming it. pi-tui's fullscreen
 * viewport listener is registered first and swallows PageUp and wheel events,
 * so this inserts the observer ahead of listeners that are already attached.
 * Later listeners, including the questionnaire's collapse shortcut, still run.
 */
export function observeTerminalInput(tui: TUI, onData: (data: string) => void): () => void {
	const listener: Listener = (data) => {
		onData(data);
		return undefined;
	};
	const bag = (tui as TUI & { inputListeners?: Set<Listener> }).inputListeners;
	if (bag) {
		const prior = [...bag];
		bag.clear();
		const remove = tui.addInputListener(listener);
		for (const existing of prior) bag.add(existing);
		return remove;
	}
	return tui.addInputListener(listener);
}
