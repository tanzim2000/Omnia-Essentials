// modules/ntfy/index.js
// Listens to an ntfy topic, raises a notification for every new message,
// and keeps a small tile answering one question: did anything happen?
// How many announcements came in the window, when the last one came, and
// how urgent it was. The details live on your phone; this is the glance.
//
// Read-only: it only ever listens. It never sends anything to a server.
//
// The topic is never shown. On a public server like ntfy.sh, the topic
// name works like a password: anyone who knows it can read every message
// and send their own. So nothing this module puts on a screen -- the
// tile, a notification -- contains it. The tile is named by its own
// setting, and a notification says which server it came from.
//
// HOW IT'S PUT TOGETHER
//
// This module has two halves that run separately and meet in the middle:
//
//   start()   runs in the background for as long as the instance exists.
//             It holds a connection open to the ntfy server, and every
//             message that arrives is added to this instance's memory --
//             and, if it arrived live, raised as a notification.
//
//   the tile  runs every time a display asks. It never talks to the
//             server at all; it just reads what start() has collected in
//             memory and turns it into blocks.
//
// `omni.memory` is the middle: the same object for both halves of the same
// instance. See "Running in the background" in OmniCore's Building
// modules.md.
//
// ONE CONNECTION PER SERVER
//
// ntfy can stream several topics down one connection -- you ask for
// "topic1,topic2" instead of one name. So instances on the same server
// don't each open their own: they join a connection OmniCore shares
// between them (`omni.connections`), each saying which topic it wants.
// OmniCore decides when the real connection opens, reopens and closes;
// this file only says HOW to open one and what to do with what arrives.
//
// CATCHING UP VS. LIVE
//
// Every time the connection opens -- OmniCore starting, a network blip,
// another ntfy tile being added -- ntfy first replays recent messages
// ("Count announcements from the last" in settings), then carries on with new ones as they're
// sent. Both kinds fill the tile, so it's never empty after a restart.
// Only the live ones raise a notification: a replayed message was already
// sent before anyone here was listening, and announcing it again on every
// reconnect would bury the display in old news.
//
// Telling them apart needs no saved state. When the stream opens, ntfy's
// first line is an "open" event carrying the SERVER's current time. Any
// message stamped earlier than that is a replay; anything stamped later
// is live. Both times come from the same clock -- the server's -- so it
// doesn't matter if this machine's clock is a little off.
//
// One awkward case: ntfy's times are whole seconds, so a message stamped
// in the very same second as the "open" could be either. It could be one
// sent just before a reconnect, which this instance already has and
// already announced; announcing it again would be a duplicate. Or it
// could be genuinely new, and skipping it would lose it. So for that one
// second only, it's announced if this instance didn't already have it
// before the reconnect. That looks only at what's on the tile right now;
// nothing is saved, and nothing survives a restart.

// What ntfy itself allows a topic name to be. Checked before connecting,
// so a typo shows up as "Not a valid topic" on the tile rather than as a
// server error that looks like the server is down.
const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;

// How many messages to keep in memory per instance. Comfortably more than
// any tile shows, and small enough that a busy topic running for weeks
// can't grow this without limit -- the oldest drop off the end.
const KEEP = 50;

// ntfy sends an empty "keepalive" line every 45 seconds or so while
// nothing else is happening. A connection that's said nothing at all for
// much longer than that has died without saying so -- which happens: a
// router restarting, a laptop server sleeping -- and is given up on, so
// OmniCore can open a fresh one.
const SILENCE_LIMIT_MS = 150 * 1000;

// Notifications one instance may raise per minute. ntfy topics are open:
// on a public server, anyone who knows or guesses the name can publish to
// it, at whatever priority they like. Without a ceiling, a stranger (or a
// script stuck in a loop) could keep the display buried under overlays
// indefinitely. Past this, messages still reach the tile straight away;
// they're just announced together, once, as "N more messages".
const NOTIFY_PER_MINUTE = 5;

// A single line longer than this isn't an ntfy message. Something else is
// answering on that address; better to drop the connection than to keep
// buffering it forever.
const LONGEST_LINE = 1024 * 1024;

// How long ago a message came, in words a tile can say: "just now",
// "12 min ago", "3 hours ago", "2 days ago". A message stamped a moment
// in the future (the server's clock a little ahead of this one's) is
// "just now" rather than nonsense.
function timeAgo(seconds) {
	const elapsed = Math.floor(Date.now() / 1000) - seconds;

	if (elapsed < 60) return "just now";

	if (elapsed < 3600) {
		return Math.floor(elapsed / 60) + " min ago";
	}

	if (elapsed < 86400) {
		const hours = Math.floor(elapsed / 3600);
		return hours + (hours === 1 ? " hour ago" : " hours ago");
	}

	const days = Math.floor(elapsed / 86400);
	return days + (days === 1 ? " day ago" : " days ago");
}

// ntfy's priorities, 1 to 5, by the names ntfy itself gives them
const PRIORITY_NAMES = {
	1: "Min",
	2: "Low",
	3: "Default",
	4: "High",
	5: "Max"
};

// The "Count announcements from the last" setting, read once into the
// three things that need it:
//
//   since    what to ask ntfy for when connecting, so the catch-up and
//            the count cover the same stretch of time
//   seconds  how far back the tile counts; null for "all"
//   label    how the tile names the window: "last 24h"
//
// A number and a unit -- 30m, 12h, 7d -- or "all". Anything else falls
// back to the default rather than being passed on to ntfy as-is: the
// tile has to count over the window too, and a window it can't measure
// would make the count say something different from the catch-up.
const DEFAULT_WINDOW = "24h";
const UNIT_SECONDS = { m: 60, h: 3600, d: 86400 };

function readWindow(value) {
	const text = String(value || "").trim().toLowerCase();

	if (text === "all") {
		return { since: "all", seconds: null, label: "" };
	}

	const match = /^(\d+)\s*([mhd])$/.exec(text);
	const amount = match ? Number(match[1]) : 0;

	if (!amount) {
		return readWindow(DEFAULT_WINDOW);
	}

	const since = amount + match[2];

	return {
		since: since,
		seconds: amount * UNIT_SECONDS[match[2]],
		label: "last " + since
	};
}

// The server setting, tidied into one consistent form -- or null if it
// isn't a web address at all, or has a username and password written
// into it ("https://me:secret@ntfy.example"). That form can't connect --
// Node refuses to send a request built that way -- and it would put the
// password on the tile and into OmniCore's logs. Tidying matters for
// sharing: OmniCore
// shares a connection between instances whose server is written exactly
// the same, so "https://ntfy.sh" and "https://ntfy.sh/" must come out as
// one thing, not two.
function readServer(value) {
	try {
		const url = new URL(String(value || "").trim());

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}

		if (url.username || url.password) {
			return null;
		}

		url.search = "";
		url.hash = "";

		return url.href.replace(/\/+$/, "");
	} catch (error) {
		return null;
	}
}

// How the server is named in the notification's source box: just its
// address, "ntfy.sh" or "192.168.1.20:8080", without the https:// in
// front. Never the topic. On a public server the topic name is the only
// thing keeping a stranger from reading your messages or sending you
// some, so it's never put on a screen anyone else can see.
function serverName(server) {
	try {
		return new URL(server).host;
	} catch (error) {
		return "";
	}
}

// What the tile is called: the "Tile name" setting, or "ntfy". Not the
// topic, for the same reason as above.
function tileName(config) {
	const name = String(config.name || "").trim();
	return name || "ntfy";
}

// A tile that only has one thing to say: a dash, and why
function problemTile(reason, server, title) {
	const content = [
		{ type: "text", emphasis: "primary", value: "—" },
		{ type: "text", emphasis: "secondary", value: reason }
	];

	// Only the server's own address, never the full web address: someone
	// who pasted the topic's link ("https://ntfy.sh/my-topic") into the
	// Server box would otherwise see their topic printed right here
	if (server && serverName(server)) {
		content.push({ type: "pair", label: "Server", value: serverName(server) });
	}

	return {
		title: title || "ntfy",
		content: content,
		updated: new Date().toISOString()
	};
}

// ---------------------------------------------------------------------
// The connection
//
// Builds the function OmniCore calls to open the one real connection for
// every instance sharing this server. It's handed every topic at once,
// and reports back through three things OmniCore gives it:
//
//   emit(event, topic)  hand something to the instances that want it --
//                       only those on that topic, or all of them when
//                       no topic is given
//   drop(error)         the connection's been lost; OmniCore waits a
//                       little and calls this function again
//   signal              aborted when OmniCore closes the connection on
//                       purpose (nobody needs it any more, or the topics
//                       changed and it's reopening with the new list)
function makeOpener(server, since) {
	return function open({ interests, emit, drop, signal }) {
		// Our own off switch, for when the connection goes silent. Tied to
		// OmniCore's signal too, so either one ends the request.
		const controller = new AbortController();
		signal.addEventListener("abort", () => controller.abort(), { once: true });

		// The server's clock at the moment the stream opened. Messages
		// stamped earlier are replays; see the top of this file.
		let openedAt = null;

		let silenceTimer = null;

		function heardSomething() {
			clearTimeout(silenceTimer);
			silenceTimer = setTimeout(() => {
				controller.abort(new Error("the connection went silent"));
			}, SILENCE_LIMIT_MS);
		}

		// One line of ntfy's stream: one JSON object
		function handleLine(line) {
			let entry;

			try {
				entry = JSON.parse(line);
			} catch (error) {
				return; // not something we understand -- skip it, keep going
			}

			// Valid JSON, but not an object ntfy would send (a bare `null`,
			// a number). Same as above: skip it.
			if (!entry || typeof entry !== "object") {
				return;
			}

			if (entry.event === "open") {
				openedAt = Number(entry.time) || 0;

				// Every instance starts its list afresh: the replay that
				// follows refills it, so nothing is listed twice
				emit({ type: "open" });
				return;
			}

			if (entry.event !== "message") {
				// keepalive, and anything newer ntfy may add one day
				return;
			}

			// Real ntfy always says which topic a message is from. One that
			// doesn't can't be routed to the right tile -- and handed to
			// every tile instead, it would show up on topics it was never
			// sent to.
			if (!entry.topic) {
				return;
			}

			const time = Number(entry.time) || Math.floor(Date.now() / 1000);

			emit(
				{
					type: "message",
					message: {
						id: String(entry.id || ""),
						time: time,
						title: String(entry.title || ""),
						body: String(entry.message || ""),
						// ntfy's priorities run 1 to 5, exactly like
						// OmniCore's notifications, with 3 as the default
						priority: Number(entry.priority) || 3
					},
					// Later than the open: live. The same second: can't tell
					// from the time alone -- the instance decides, see above.
					live: openedAt !== null && time > openedAt,
					sameSecond: openedAt !== null && time === openedAt
				},
				entry.topic
			);
		}

		// Kicked off rather than awaited: this runs for as long as the
		// connection stays up, and OmniCore shouldn't wait on that
		(async () => {
			try {
				// Commas between topics are part of ntfy's syntax, so each
				// topic is encoded on its own and the commas left alone
				const url =
					server +
					"/" +
					interests.map(encodeURIComponent).join(",") +
					"/json?since=" +
					encodeURIComponent(since);

				heardSomething();

				// The plain fetch, not omni.fetch: this is a stream that stays
				// open, not a request to cache and share
				const response = await fetch(url, { signal: controller.signal });

				if (!response.ok) {
					throw new Error("the server answered " + response.status);
				}

				emit({ type: "status", status: "connected" });

				// Read the stream as it arrives, a chunk at a time, and hand
				// each complete line over as soon as it's whole
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						// Whatever's left: the decoder's last few bytes, and a
						// final line that arrived without a newline after it
						buffer += decoder.decode();

						if (buffer.trim()) {
							handleLine(buffer.trim());
						}

						break;
					}

					heardSomething();
					buffer += decoder.decode(value, { stream: true });

					let newline;

					while ((newline = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);

						if (line) {
							handleLine(line);
						}
					}

					if (buffer.length > LONGEST_LINE) {
						throw new Error("the server sent something that isn't ntfy");
					}
				}

				throw new Error("the server closed the connection");
			} catch (error) {
				// Closed on purpose by OmniCore. Not a failure; say nothing.
				if (signal.aborted) {
					return;
				}

				emit({ type: "status", status: "unreachable" });

				// The silence timer's own reason, if that's what ended it
				drop(controller.signal.reason || error);
			} finally {
				clearTimeout(silenceTimer);
			}
		})();
	};
}

// ---------------------------------------------------------------------
// The background half

module.exports = async function ntfy(config, richness, omni) {
	return tile(config, richness, omni);
};

module.exports.start = async function start(config, omni) {
	const server = readServer(config.server);
	const topic = String(config.topic || "").trim();

	// What every notification's source box says
	const source = serverName(server);

	// What the tile reads. Written fresh on every start -- a settings
	// change restarts this, and nothing from the old topic should linger.
	const state = {
		status: "connecting",
		// Newest first, at most KEEP of them. The tile counts the ones
		// inside the window itself, every time it's asked: an
		// announcement quietly ages out of "the last 24h" without any
		// new message arriving to say so.
		messages: []
	};

	// The ids that were on the tile just before the last reconnect. Only
	// ever consulted for a message stamped in the same second the
	// connection opened -- see the top of this file.
	let hadBeforeReopen = new Set();

	// The notification ceiling (see NOTIFY_PER_MINUTE): when each of the
	// last few notifications went out, and what's waiting to be announced
	// together once the minute is up.
	const sentAt = [];
	let heldCount = 0;
	let heldPriority = 1;
	let summaryTimer = null;

	function announce(message) {
		const now = Date.now();

		// Forget anything more than a minute old
		while (sentAt.length && now - sentAt[0] >= 60 * 1000) {
			sentAt.shift();
		}

		if (sentAt.length < NOTIFY_PER_MINUTE) {
			sentAt.push(now);

			// Exactly what was sent: its title if it had one, and its text.
			// A message with no title shows as just its text. The source box
			// above it says it came from this server -- never the topic,
			// see serverName().
			omni.notify({
				source: source,
				title: message.title,
				description: message.body,
				priority: message.priority
			});
			return;
		}

		// Over the ceiling: hold it, and announce everything held in one go
		// as soon as the oldest of the last few is a minute old. The summary
		// takes the most urgent priority among what it stands for.
		heldCount++;
		heldPriority = Math.max(heldPriority, message.priority);

		if (!summaryTimer) {
			summaryTimer = setTimeout(() => {
				summaryTimer = null;

				const count = heldCount;
				const priority = heldPriority;
				heldCount = 0;
				heldPriority = 1;

				if (count > 0) {
					sentAt.push(Date.now());
					omni.notify({
						source: source,
						title: count + (count === 1 ? " more message" : " more messages"),
						description: "See the tile, or your phone",
						priority: priority
					});
				}
			}, 60 * 1000 - (now - sentAt[0]));
		}
	}

	omni.memory.write(state);

	if (!server) {
		state.status = "bad-server";
		return null;
	}

	if (!TOPIC_PATTERN.test(topic)) {
		state.status = "bad-topic";
		return null;
	}

	const since = readWindow(config.since).since;

	omni.connections.join({
		// Everything that decides HOW to connect goes in the key: two
		// instances only share a connection if it would be opened exactly
		// the same way for both. The window is part of the request
		// itself, so it belongs here too.
		key: server + " since=" + since,
		interest: topic,
		open: makeOpener(server, since),
		onEvent(event) {
			if (event.type === "open") {
				// Only replaced when there's something to replace it with. Two
				// reopens close together can deliver this twice before the
				// replay in between has refilled the tile; forgetting what we
				// had at that point would let an already-announced message
				// through again.
				if (state.messages.length) {
					hadBeforeReopen = new Set(state.messages.map((message) => message.id));
				}

				state.status = "connected";
				state.messages = [];
				return;
			}

			if (event.type === "status") {
				state.status = event.status;
				return;
			}

			if (event.type !== "message") {
				return;
			}

			// Newest first, oldest falling off the end
			state.messages.unshift(event.message);
			state.messages.length = Math.min(state.messages.length, KEEP);

			const isNew =
				event.live ||
				(event.sameSecond && !hadBeforeReopen.has(event.message.id));

			if (isNew && config.notify !== false) {
				announce(event.message);
			}
		}
	});

	// What stop() needs. The connection is OmniCore's to close, and it does
	// that by itself; the summary timer is this module's own.
	return {
		cancel() {
			clearTimeout(summaryTimer);
		}
	};
};

module.exports.stop = async function stop(handle) {
	if (handle) {
		handle.cancel();
	}
};

// ---------------------------------------------------------------------
// The tile

function tile(config, richness, omni) {
	const server = readServer(config.server);
	const topic = String(config.topic || "").trim();
	const name = tileName(config);

	if (!topic) {
		return problemTile("No topic set", null, name);
	}

	// An OmniCore too old for background modules never calls start() and
	// has no memory to hand over. The registry's minOmniCore keeps this
	// from being installed there, but a tile saying why beats a crash.
	if (!omni.memory) {
		return problemTile("Needs a newer OmniCore", null, name);
	}

	const state = omni.memory.read();

	if (state.status === "bad-server") {
		return problemTile("Not a valid server address", null, name);
	}

	if (state.status === "bad-topic") {
		return problemTile("Not a valid topic", null, name);
	}

	const messages = state.messages || [];

	// Nothing yet, and not connected yet either
	if (messages.length === 0 && state.status !== "connected") {
		return problemTile(
			state.status === "unreachable" ? "Not reachable" : "Connecting…",
			server,
			name
		);
	}

	// WHAT THE TILE SAYS
	//
	// Three facts, as plain pairs, so any theme can lay them out its own
	// way -- big and small, rows, columns, flipping or not:
	//
	//   how many   announcements inside the window
	//   when       how long ago the latest one came
	//   priority   how urgent the latest one was
	//
	// Only messages inside the window count for any of them. A quiet
	// topic says 0 and "none", never "the last one was 3 days ago" when
	// the window is a day: the tile answers for the window you picked.
	const windowed = readWindow(config.since);
	const cutoff = windowed.seconds === null
		? -Infinity
		: Math.floor(Date.now() / 1000) - windowed.seconds;

	// Newest first, so the latest is always the first one in the window
	const inWindow = messages.filter((message) => message.time >= cutoff);
	const latest = inWindow[0];

	// Only the last KEEP are remembered. If every one of those is still
	// inside the window, there may well have been more before them, so
	// the count says so rather than passing a floor off as the total.
	const count = inWindow.length >= KEEP ? KEEP + "+" : String(inWindow.length);

	// Still showing what it last had, but say so -- old numbers shouldn't
	// pass for a live connection
	const offline = state.status === "unreachable" ? " (offline)" : "";

	const howMany = {
		type: "pair",
		emphasis: "primary",
		label: "Announcements" + (windowed.label ? ", " + windowed.label : "") + offline,
		value: count
	};

	const when = {
		type: "pair",
		label: "Last",
		value: latest ? timeAgo(latest.time) : "none"
	};

	const priority = {
		type: "pair",
		label: "Priority",
		value: latest ? PRIORITY_NAMES[latest.priority] || "Default" : "—"
	};

	// RICHNESS
	//
	// Two levels. The count leads at every size. With the least room
	// there's space for one more fact, and how urgent beats how long ago.
	// With any more room than that, all three, in the order above.
	const content = richness < 30 ? [howMany, priority] : [howMany, when, priority];

	return {
		// The "Tile name" setting names the tile, so several ntfy tiles side
		// by side can be told apart -- "GitHub", "Backups" -- without the
		// topic ever appearing on screen
		title: name,
		content: content,
		updated: new Date().toISOString()
	};
}