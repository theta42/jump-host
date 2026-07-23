'use strict';

// Hand-rolled ANSI host picker rendered over an inbound SSH shell channel.
// (blessed/inquirer/ink want a real TTY object; an ssh2 server channel isn't
// one, so we parse raw keystrokes ourselves.) Resolves to the chosen host
// resource, or null if the user quits.

const ESC = '\x1b';
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CUR = `${ESC}[?25l`;
const SHOW_CUR = `${ESC}[?25h`;
const INV = `${ESC}[7m`;
const RST = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;

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
			out += `${BOLD}  Theta42 Jump — hosts for ${uid}${RST}\r\n`;
			out += `${DIM}  ↑/↓ move · Enter connect · type to filter · q quit${RST}\r\n\r\n`;
			if (!list.length) {
				out += `  ${DIM}(no match for "${filter}")${RST}\r\n`;
			} else {
				list.forEach((h, i) => {
					const ip = (h.metadata && h.metadata.ip) || (h.metadata && h.metadata.address) || '';
					const row = `  ${h.name}  ${DIM}(${h.slug})${RST}${ip ? `  ${ip}` : ''}`;
					out += (i === selected ? `${INV}> ${h.name}  (${h.slug})${ip ? `  ${ip}` : ''}${RST}` : row) + '\r\n';
				});
			}
			if (filter) out += `\r\n  ${DIM}filter:${RST} ${filter}`;
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
