// modules/ntfy/index.js
// Listens to an ntfy topic, shows recent messages on a tile, and raises a
// notification for every new one.
//
// Read-only: it only ever listens. It never sends anything to a server.
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
// ("Catch up on" in settings), then carries on with new ones as they're
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

// Turn a timestamp into "3m", "2h", "4d" -- short enough for a tile
function timeAgo(seconds) {
	const elapsed = Math.floor(Date.now() / 1000) - seconds;

	if (elapsed < 60) return "now";
	if (elapsed < 3600) return Math.floor(elapsed / 60) + "m";
	if (elapsed < 86400) return Math.floor(elapsed / 3600) + "h";
	return Math.floor(elapsed / 86400) + "d";
}

// The server setting, tidied into one consistent form -- or null if it
// isn't a web address at all, or has a username and password written
// into it ("https://me:secret@ntfy.example"). That form can't connect --
// Node refuses to send a request built that way -- and it would put the
// password on the tile, into the scan code, and into OmniCore's logs. Tidying matters for sharing: OmniCore
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

// What a phone should open to follow this topic.
//
// "ntfy app" uses ntfy's own link format, which the Android app opens
// straight to the topic, ready to subscribe. ntfy's docs say this is the
// only way to do that -- an ordinary web link can't open the app there.
// It assumes HTTPS unless told otherwise, so a plain-HTTP home server
// adds ?secure=false.
//
// "Web page" is the topic's page on the server itself, which any phone
// can open in a browser, app installed or not.
function subscribeLink(server, topic, opens) {
	if (opens === "Web page") {
		return server + "/" + topic;
	}

	const url = new URL(server);
	const path = url.pathname.replace(/\/+$/, "");
	const insecure = url.protocol === "http:" ? "?secure=false" : "";

	return "ntfy://" + url.host + path + "/" + topic + insecure;
}

// A tile that only has one thing to say: a dash, and why
function problemTile(reason, server) {
	const content = [
		{ type: "text", emphasis: "primary", value: "—" },
		{ type: "text", emphasis: "secondary", value: reason }
	];

	if (server) {
		content.push({ type: "pair", label: "Server", value: server });
	}

	return {
		title: "ntfy",
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

	// What the tile reads. Written fresh on every start -- a settings
	// change restarts this, and nothing from the old topic should linger.
	const state = {
		status: "connecting",
		messages: [],
		// How many messages this connection has seen, replayed and live.
		// Separate from `messages`, which is capped at KEEP.
		count: 0
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

			// A message with no title of its own is announced under its
			// topic's name, so the overlay is never just a bare line of
			// text with nothing saying where it came from
			omni.notify({
				title: message.title || topic,
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
						title: topic,
						description:
							count + (count === 1 ? " more message" : " more messages") +
							" — see the tile",
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

	const since = String(config.since || "").trim() || "24h";

	omni.connections.join({
		// Everything that decides HOW to connect goes in the key: two
		// instances only share a connection if it would be opened exactly
		// the same way for both. "Catch up on" is part of the request
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
				state.count = 0;
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
			state.count++;

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

	if (!topic) {
		return problemTile("No topic set");
	}

	// An OmniCore too old for background modules never calls start() and
	// has no memory to hand over. The registry's minOmniCore keeps this
	// from being installed there, but a tile saying why beats a crash.
	if (!omni.memory) {
		return problemTile("Needs a newer OmniCore");
	}

	const state = omni.memory.read();

	if (state.status === "bad-server") {
		return problemTile("Not a valid server address");
	}

	if (state.status === "bad-topic") {
		return problemTile("Not a valid topic");
	}

	const messages = state.messages || [];

	// Nothing yet, and not connected yet either
	if (messages.length === 0 && state.status !== "connected") {
		return problemTile(
			state.status === "unreachable" ? "Not reachable" : "Connecting…",
			server
		);
	}

	// RICHNESS
	//
	// Every row is the same kind of thing -- one message -- so there is
	// nothing for a user to reorder. Richness decides how many fit. The
	// count leads at every size; the topic comes next; then the messages;
	// and the scan-to-subscribe code last, only where there's real room
	// for it, since a code too small to scan is worse than none.
	const content = [
		{ type: "text", emphasis: "primary", value: String(state.count || 0) }
	];

	if (richness >= 25) {
		content.push({
			type: "text",
			emphasis: "secondary",
			// Still showing what it last had, but say so -- old messages
			// shouldn't pass for a live connection
			value: topic + (state.status === "unreachable" ? " (offline)" : "")
		});
	}

	// The user's own limit is the ceiling; richness decides how much of it
	// this tile earns. minimum 0 so a tile with room only for the count
	// shows only the count.
	const room = omni.share(
		Math.min(messages.length, Number(config.limit) || 0),
		richness,
		{ minimum: 0 }
	);

	for (const message of messages.slice(0, room)) {
		content.push({
			type: "pair",
			label: timeAgo(message.time),
			value: message.title || message.body
		});
	}

	if (config.showCode !== false && richness >= 60 && server) {
		content.push({
			type: "qr",
			value: subscribeLink(server, topic, config.codeOpens),
			label: "Scan to subscribe"
		});
	}

	return {
		title: "ntfy",
		content: content,
		updated: new Date().toISOString()
	};
}