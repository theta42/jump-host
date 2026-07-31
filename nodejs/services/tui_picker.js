'use strict';

// Hand-rolled ANSI host picker rendered over an inbound SSH shell channel.
// (blessed/inquirer/ink want a real TTY object; an ssh2 server channel isn't
// one, so we parse raw keystrokes ourselves.) Resolves to the chosen host
// resource, or null if the user quits.

const ESC = '\x1b';
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CUR = `${ESC}[?25l`;
const SHOW_CUR = `${ESC}[?25h`;

// Basic styles
const RST = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;

// Colors (30-37: standard, 90-97: bright)
const RED = `${ESC}[31m`;
const BRIGHT_RED = `${ESC}[91m`;
const CYAN = `${ESC}[36m`;
const BRIGHT_CYAN = `${ESC}[96m`;
const GREEN = `${ESC}[32m`;
const BRIGHT_GREEN = `${ESC}[92m`;
const YELLOW = `${ESC}[33m`;
const BRIGHT_YELLOW = `${ESC}[93m`;
const MAGENTA = `${ESC}[35m`;
const BRIGHT_MAGENTA = `${ESC}[95m`;
const BLUE = `${ESC}[34m`;
const BRIGHT_BLUE = `${ESC}[94m`;

// Inverted selection with color
const INV_GREEN = `${ESC}[42m${ESC}[30m`;  // Green bg, black text
const INV = `${ESC}[7m`;

function pickHost(channel, uid, hosts) {
	return new Promise((resolve) => {
		if (!hosts.length) {
			channel.write(`\r\n  No hosts available for ${uid}.\r\n  (You have no directory access to any SSH host.)\r\n\r\n`);
			setTimeout(() => resolve(null), 50);
			return;
		}

		let filter = '';
		let selected = 0;

		const visible = () => hosts.filter((h) => {
			if (!filter) return true;
			const hay = `${h.name} ${h.slug} ${(h.metadata && h.metadata.ip) || ''}`.toLowerCase();
			return hay.includes(filter.toLowerCase());
		});

		const render = () => {
			const list = visible();
			if (selected >= list.length) selected = Math.max(0, list.length - 1);
			let out = CLEAR + HIDE_CUR;

			// Header with gradient-style color
			out += `\r\n  ${BOLD}${BRIGHT_CYAN}╔════════════════════════════════════════════════════════╗${RST}\r\n`;
			out += `  ${BOLD}${BRIGHT_CYAN}║${RST}  ${BOLD}${BRIGHT_MAGENTA}Theta42 Jump${RST} ${DIM}·${RST} ${BRIGHT_GREEN}hosts for ${uid}${RST}                      ${BOLD}${BRIGHT_CYAN}║${RST}\r\n`;
			out += `  ${BOLD}${BRIGHT_CYAN}╚════════════════════════════════════════════════════════╝${RST}\r\n`;
			out += `\r\n`;
			out += `  ${DIM}↑/↓ move · Enter connect · type to filter · q quit${RST}\r\n`;
			out += `\r\n`;

			if (!list.length) {
				out += `  ${YELLOW}⚠${RST}  ${DIM}(no match for "${filter}")${RST}\r\n`;
			} else {
				list.forEach((h, i) => {
					const ip = (h.metadata && h.metadata.ip) || (h.metadata && h.metadata.address) || '';
					const isProd = h.metadata && h.metadata.isProduction;
					const envBadge = isProd ? `${BOLD}${RED}PROD${RST} ` : `${DIM}DEV${RST}  `;

					if (i === selected) {
						// Selected row with green inverse background
						const selRow = `${INV_GREEN}  ${h.name}  ${DIM}(${h.slug})${RST}${ip ? `  ${CYAN}${ip}${RST}` : ''}  ${envBadge}  ${BOLD}${BRIGHT_GREEN}◄ SELECTED ►${RST}${INV_GREEN}${RST}`;
						out += selRow + '\r\n';
					} else {
						// Normal row with subtle coloring
						const nameColor = i % 2 === 0 ? BRIGHT_CYAN : CYAN;
						out += `  ${nameColor}${h.name}${RST}  ${DIM}(${h.slug})${RST}${ip ? `  ${BLUE}${ip}${RST}` : ''}  ${envBadge}\r\n`;
					}
				});
			}

			if (filter) {
				out += `\r\n  ${DIM}filter: ${BRIGHT_YELLOW}${filter}${RST}`;
			}

			// Footer
			out += `\r\n\r\n  ${DIM}────────────────────────────────────────────────────────${RST}\r\n`;
			out += `  ${DIM}Press${RST} ${BOLD}1-9${RST} ${DIM}to quick-select · ${BOLD}q${RST} ${DIM}to quit${RST}\r\n`;

			channel.write(out);
		};

		const done = (host) => {
			channel.removeListener('data', onData);
			channel.write(SHOW_CUR);
			resolve(host);
		};

		const onData = (buf) => {
			const s = buf.toString('utf8');
			const list = visible();
			if (s === '\x03' || s === 'q') return done(null);        // Ctrl-C / q
			if (s === '\x0c') return render();                        // Ctrl-L
			if (s === `${ESC}[A`) { selected = Math.max(0, selected - 1); return render(); }
			if (s === `${ESC}[B`) { selected = Math.min(list.length - 1, selected + 1); return render(); }
			if (s === '\r' || s === '\n') { if (list[selected]) return done(list[selected]); return; }
			if (s === '\x7f' || s === '\b') { filter = filter.slice(0, -1); selected = 0; return render(); }
			if (/^[0-9]$/.test(s)) { const i = Number(s) - 1; if (list[i]) return done(list[i]); return; }
			if (s.length === 1 && s >= ' ') { filter += s; selected = 0; return render(); }
		};

		channel.on('data', onData);
		render();
	});
}

module.exports = { pickHost };
