// modules/calendar/index.js
// Events from an ICS calendar feed — the export format Google Calendar,
// Outlook, iCloud, Nextcloud and most others can all publish.
// Read-only.
//
// WHAT THIS MODULE DOES AND DOESN'T DO
//
// It hands over raw event data and nothing else. It has no idea what
// "today" is on screen, no idea what a week or a month looks like, and
// no opinion about which events are worth showing. The theme already
// knows the device's own date and is the one drawing a calendar shape,
// so all of that belongs there.
//
// What this module owes the theme is a correct, boring list: every event
// inside a window of days, each with a start, an end, and a title. Getting
// the DATES right is the whole job — which is harder than it sounds,
// because the three big providers each express time differently.
//
// ICS is parsed here by hand rather than with a library, to keep OmniCore
// dependency-free.

// ---------------------------------------------------------------------
// Windows timezone names
//
// Outlook/Exchange feeds don't use standard IANA zone names
// ("America/Regina"). They use Microsoft's own names ("Central Standard
// Time"), which JavaScript's built-in Intl has never heard of. This table
// translates the common ones so those feeds land on the right day.
//
// It's deliberately a partial list of the zones people actually use, not
// all ~140 Windows zones. An unknown name isn't fatal — see resolveZone().
const WINDOWS_ZONES = {
	"Dateline Standard Time": "Etc/GMT+12",
	"Hawaiian Standard Time": "Pacific/Honolulu",
	"Alaskan Standard Time": "America/Anchorage",
	"Pacific Standard Time": "America/Los_Angeles",
	"Mountain Standard Time": "America/Denver",
	"US Mountain Standard Time": "America/Phoenix",
	"Central Standard Time": "America/Chicago",
	"Canada Central Standard Time": "America/Regina",
	"Central America Standard Time": "America/Guatemala",
	"Eastern Standard Time": "America/New_York",
	"US Eastern Standard Time": "America/Indianapolis",
	"Atlantic Standard Time": "America/Halifax",
	"Newfoundland Standard Time": "America/St_Johns",
	"SA Pacific Standard Time": "America/Bogota",
	"E. South America Standard Time": "America/Sao_Paulo",
	"Argentina Standard Time": "America/Buenos_Aires",
	"GMT Standard Time": "Europe/London",
	"Greenwich Standard Time": "Atlantic/Reykjavik",
	"W. Europe Standard Time": "Europe/Berlin",
	"Central Europe Standard Time": "Europe/Budapest",
	"Romance Standard Time": "Europe/Paris",
	"Central European Standard Time": "Europe/Warsaw",
	"W. Central Africa Standard Time": "Africa/Lagos",
	"GTB Standard Time": "Europe/Bucharest",
	"E. Europe Standard Time": "Europe/Chisinau",
	"Egypt Standard Time": "Africa/Cairo",
	"South Africa Standard Time": "Africa/Johannesburg",
	"FLE Standard Time": "Europe/Kiev",
	"Israel Standard Time": "Asia/Jerusalem",
	"Turkey Standard Time": "Europe/Istanbul",
	"Arabic Standard Time": "Asia/Baghdad",
	"Arab Standard Time": "Asia/Riyadh",
	"Russian Standard Time": "Europe/Moscow",
	"E. Africa Standard Time": "Africa/Nairobi",
	"Iran Standard Time": "Asia/Tehran",
	"Arabian Standard Time": "Asia/Dubai",
	"Azerbaijan Standard Time": "Asia/Baku",
	"Pakistan Standard Time": "Asia/Karachi",
	"India Standard Time": "Asia/Kolkata",
	"Sri Lanka Standard Time": "Asia/Colombo",
	"Nepal Standard Time": "Asia/Kathmandu",
	"Central Asia Standard Time": "Asia/Almaty",
	"Bangladesh Standard Time": "Asia/Dhaka",
	"Myanmar Standard Time": "Asia/Rangoon",
	"SE Asia Standard Time": "Asia/Bangkok",
	"China Standard Time": "Asia/Shanghai",
	"Singapore Standard Time": "Asia/Singapore",
	"W. Australia Standard Time": "Australia/Perth",
	"Taipei Standard Time": "Asia/Taipei",
	"Tokyo Standard Time": "Asia/Tokyo",
	"Korea Standard Time": "Asia/Seoul",
	"Cen. Australia Standard Time": "Australia/Adelaide",
	"AUS Central Standard Time": "Australia/Darwin",
	"E. Australia Standard Time": "Australia/Brisbane",
	"AUS Eastern Standard Time": "Australia/Sydney",
	"Tasmania Standard Time": "Australia/Hobart",
	"New Zealand Standard Time": "Pacific/Auckland",
	"UTC": "Etc/UTC",
	"Coordinated Universal Time": "Etc/UTC"
};

// ---------------------------------------------------------------------
// Reading the feed

// ICS wraps long lines by starting the continuation with a space or tab.
// Join those back together before parsing anything, or a SUMMARY that
// happened to be long would come out cut in half.
function unfold(text) {
	return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

// Find one property line and return its parameters and value separately.
//
// A line looks like one of these:
//
//   DTSTART:20260915T090000Z                       <- no parameters
//   DTSTART;VALUE=DATE:20260920                    <- a parameter
//   DTSTART;TZID=America/Regina:20260915T090000    <- a parameter
//
// The old version of this module threw away everything before the colon,
// which is exactly where the timezone lives — so every event from a feed
// that uses TZID was silently read as local time.
function readProperty(body, name) {
	const pattern = new RegExp("\\n" + name + "([^:\\n]*):([^\\r\\n]+)");
	const match = body.match(pattern);

	if (!match) {
		return null;
	}

	const params = {};

	// "params" is the ";VALUE=DATE;TZID=Foo" part. Split it up.
	for (const piece of match[1].split(";")) {
		if (!piece) continue;

		const equals = piece.indexOf("=");
		if (equals === -1) continue;

		const key = piece.slice(0, equals).toUpperCase();
		// Some feeds quote the value: TZID="W. Europe Standard Time"
		const value = piece.slice(equals + 1).replace(/^"|"$/g, "");

		params[key] = value;
	}

	return { params: params, value: match[2].trim() };
}

// ICS escapes commas, semicolons, backslashes and newlines in text values.
function unescapeText(value) {
	return value
		.replace(/\\n/gi, " ")
		.replace(/\\([,;\\])/g, "$1")
		.trim();
}

// ---------------------------------------------------------------------
// Timezones
//
// This is the part that decides whether an event shows on the right day.

// Turn whatever TZID a feed used into a name Intl actually understands.
// Returns null if we can't, which the caller treats as "no zone known".
function resolveZone(tzid) {
	if (!tzid) {
		return null;
	}

	// Already an IANA name? (Apple and Nextcloud feeds use these.)
	// The only reliable test is to try it — Intl throws on a bad zone.
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tzid });
		return tzid;
	} catch (error) {
		// Not IANA — fall through and try the Windows table
	}

	if (WINDOWS_ZONES[tzid]) {
		return WINDOWS_ZONES[tzid];
	}

	// Outlook occasionally emits placeholder zone names like "Customized
	// Time Zone" that mean nothing outside the file, and it doesn't always
	// define them in the feed either. Nothing sensible to map those to.
	return null;
}

// How far ahead of UTC a zone was at a particular instant, in milliseconds.
//
// There's no built-in way to ask this, so the trick is: format the instant
// AS that zone, read the wall-clock numbers back, and see how far they
// drifted from UTC. Doing it this way means DST is handled for free —
// we're asking what the zone was actually doing on that date, not applying
// a fixed offset.
function zoneOffsetAt(utcMilliseconds, zone) {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	});

	const parts = {};

	for (const part of formatter.formatToParts(new Date(utcMilliseconds))) {
		parts[part.type] = part.value;
	}

	// Some environments render midnight as hour 24 rather than 0
	let hour = Number(parts.hour);
	if (hour === 24) hour = 0;

	const asIfUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		hour,
		Number(parts.minute),
		Number(parts.second)
	);

	return asIfUtc - utcMilliseconds;
}

// A wall-clock reading in some zone ("9am in Kolkata") into a real instant.
//
// Done in two passes on purpose. The first pass guesses using the offset
// at roughly the right moment; if that guess landed on the other side of
// a DST change, the offset there is different and the second pass corrects
// it. Without this, events within an hour of a clock change come out wrong.
function wallClockToInstant(parts, zone) {
	const guess = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second
	);

	const firstOffset = zoneOffsetAt(guess, zone);
	const corrected = guess - firstOffset;
	const secondOffset = zoneOffsetAt(corrected, zone);

	if (secondOffset === firstOffset) {
		return new Date(corrected);
	}

	return new Date(guess - secondOffset);
}

// ---------------------------------------------------------------------
// Dates
//
// Two genuinely different things come out of a feed, and the difference
// matters all the way through to the theme:
//
//   an INSTANT — "9:00am on the 15th", a specific moment in time
//   a DATE     — "the 20th", a whole calendar day with no time in it
//
// An all-day event has no timezone. Pinning it to a UTC instant (midnight
// Z, say) would shift it onto the wrong day for anyone not on UTC — in
// Regina, UTC midnight on the 20th is 6pm on the 19th. So all-day events
// are kept as bare year/month/day the entire way through, never converted.
function parseDate(property) {
	const value = property.value;

	// 20260920 — a whole day, no time
	const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);

	if (dateOnly || property.params.VALUE === "DATE") {
		const match = dateOnly || value.match(/^(\d{4})(\d{2})(\d{2})/);

		if (!match) return null;

		return {
			allDay: true,
			year: Number(match[1]),
			month: Number(match[2]),
			day: Number(match[3])
		};
	}

	// 20260915T090000Z  or  20260915T090000
	const dateTime = value.match(
		/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/
	);

	if (!dateTime) {
		return null;
	}

	const parts = {
		year: Number(dateTime[1]),
		month: Number(dateTime[2]),
		day: Number(dateTime[3]),
		hour: Number(dateTime[4]),
		minute: Number(dateTime[5]),
		second: Number(dateTime[6])
	};

	// Ends in Z — already UTC, nothing to work out. This is what Google's
	// feeds use for nearly everything, which is why the old naive parser
	// looked fine against Google and only against Google.
	if (dateTime[7]) {
		return {
			allDay: false,
			instant: new Date(
				Date.UTC(
					parts.year,
					parts.month - 1,
					parts.day,
					parts.hour,
					parts.minute,
					parts.second
				)
			)
		};
	}

	const zone = resolveZone(property.params.TZID);

	if (zone) {
		return { allDay: false, instant: wallClockToInstant(parts, zone) };
	}

	// No zone, or one we couldn't make sense of. RFC 5545 calls this a
	// "floating" time and says to read it as local — which is also the
	// only sane fallback for an unmappable TZID.
	return {
		allDay: false,
		instant: new Date(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second
		)
	};
}

// ICS can give an end as a DURATION instead of a DTEND: "PT1H30M",
// "P2D". Only the parts that show up in real feeds are handled.
function parseDuration(value) {
	const match = value.match(
		/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
	);

	if (!match) {
		return null;
	}

	const [, weeks, days, hours, minutes, seconds] = match;

	return (
		(Number(weeks || 0) * 7 + Number(days || 0)) * 86400000 +
		Number(hours || 0) * 3600000 +
		Number(minutes || 0) * 60000 +
		Number(seconds || 0) * 1000
	);
}

// Add days to a bare year/month/day without any timezone involved.
// Date does the month/year rollover for us (Sept 31st becomes Oct 1st).
function shiftDate(date, days) {
	const shifted = new Date(date.year, date.month - 1, date.day + days);

	return {
		allDay: true,
		year: shifted.getFullYear(),
		month: shifted.getMonth() + 1,
		day: shifted.getDate()
	};
}

// "2026-09-20" for an all-day date, a full ISO instant for a timed one.
//
// This is the only signal the theme gets, and it's enough: a string with
// a "T" in it is a moment; a bare date is a whole day. No extra flag to
// keep in sync, and nothing for a theme to accidentally timezone-convert.
function formatDate(date) {
	if (!date.allDay) {
		return date.instant.toISOString();
	}

	const month = String(date.month).padStart(2, "0");
	const day = String(date.day).padStart(2, "0");

	return `${date.year}-${month}-${day}`;
}

// A comparable moment, for deciding whether an event falls in the window.
// All-day dates compare as local midnight, since a calendar day is a local
// idea — this is for filtering only and never reaches the theme.
function comparableStart(date) {
	return date.allDay
		? new Date(date.year, date.month - 1, date.day)
		: date.instant;
}

function comparableEnd(date) {
	return date.allDay
		? new Date(date.year, date.month - 1, date.day, 23, 59, 59)
		: date.instant;
}

// ---------------------------------------------------------------------
// Events

// Pull events out of a feed.
//
// Repeating events (those carrying an RRULE) are skipped. Working out
// every occurrence of a rule like "third Tuesday, skipping holidays" is a
// genuinely hard problem, and quietly showing the wrong dates on a wall
// display is worse than showing nothing. A library is the right answer if
// you need them.
function parseEvents(text) {
	const events = [];
	const blocks = text.split("BEGIN:VEVENT").slice(1);

	for (const block of blocks) {
		const body = "\n" + block.split("END:VEVENT")[0];

		if (/\nRRULE[:;]/.test(body)) {
			continue; // repeating — skip it
		}

		// A deleted occurrence of a series. Some providers leave these in
		// the feed rather than removing them, so without this check a
		// cancelled meeting would still show up as upcoming.
		const status = readProperty(body, "STATUS");
		if (status && status.value.toUpperCase() === "CANCELLED") {
			continue;
		}

		const startProperty = readProperty(body, "DTSTART");
		if (!startProperty) continue;

		const start = parseDate(startProperty);
		if (!start) continue;

		const summaryProperty = readProperty(body, "SUMMARY");
		const summary = summaryProperty
			? unescapeText(summaryProperty.value)
			: "(no title)";

		events.push({
			start: start,
			end: readEnd(body, start),
			summary: summary
		});
	}

	return events;
}

// Work out when an event finishes.
//
// Every event this module emits has an end, even when the feed didn't
// spell one out — a theme drawing a calendar shouldn't have to handle a
// missing field. RFC 5545 says what to assume when it's absent.
function readEnd(body, start) {
	const endProperty = readProperty(body, "DTEND");

	if (endProperty) {
		const end = parseDate(endProperty);

		if (end) {
			// ICS all-day ends are EXCLUSIVE: a holiday running the 20th
			// to the 22nd is written as DTEND:20260923, the day after it
			// finishes. Passing that straight through would stretch every
			// all-day event a day too long. Step it back so `end` means
			// the last day the event is actually on.
			return end.allDay ? shiftDate(end, -1) : end;
		}
	}

	const durationProperty = readProperty(body, "DURATION");

	if (durationProperty) {
		const milliseconds = parseDuration(durationProperty.value);

		if (milliseconds !== null) {
			if (start.allDay) {
				const days = Math.max(1, Math.round(milliseconds / 86400000));
				// Same exclusive-end correction as above
				return shiftDate(start, days - 1);
			}

			return {
				allDay: false,
				instant: new Date(start.instant.getTime() + milliseconds)
			};
		}
	}

	// Nothing given. An all-day event with no end covers one day; a timed
	// event with no end takes no time at all.
	return start;
}

// ---------------------------------------------------------------------
// The module

// Every failure returns a real envelope rather than throwing. A tile that
// says why it's empty is more useful than one that vanishes.
function problem(reason) {
	return {
		title: "Calendar",
		content: [
			{ type: "text", emphasis: "primary", value: "—" },
			{ type: "text", emphasis: "secondary", value: reason }
		],
		updated: new Date().toISOString()
	};
}

module.exports = async function calendar(config, richness, omni) {
	if (!config.url) {
		return problem("No feed set");
	}

	// webcal:// is what iCloud (and some others) hand out when you copy a
	// calendar link. It isn't a real protocol — it's plain https with a
	// different name on the front, meant to make a desktop calendar app
	// open instead of a browser. Swapping it keeps users from having to
	// know that.
	const url = String(config.url).replace(/^webcal:\/\//i, "https://");

	// Calendar feeds are plain text, not JSON
	const { data, stale } = await omni.fetch(url, {
		as: "text",
		cacheSeconds: Number(config.refreshMinutes) * 60
	});

	if (!data) {
		return problem("Not reachable");
	}

	const feed = unfold(data);

	// WINDOW
	//
	// This bounds how much of the feed is scanned and returned at all —
	// a calendar has no natural end of its own, so something has to say
	// where to stop. It is NOT a display limit: a theme drawing a month
	// grid wants every event inside this range, not a top slice of it.
	const now = new Date();

	const windowStart = new Date(now);
	windowStart.setDate(now.getDate() - Number(config.daysBehind));
	windowStart.setHours(0, 0, 0, 0);

	const windowEnd = new Date(now);
	windowEnd.setDate(now.getDate() + Number(config.daysAhead));
	windowEnd.setHours(23, 59, 59, 999);

	// An event counts if it OVERLAPS the window, not just if it starts
	// inside it — a week-long holiday that began before the window opened
	// is still happening, and a month grid needs to draw it.
	const events = parseEvents(feed)
		.filter((event) => {
			return (
				comparableEnd(event.end) >= windowStart &&
				comparableStart(event.start) <= windowEnd
			);
		})
		.sort((a, b) => comparableStart(a.start) - comparableStart(b.start));

	// RICHNESS
	//
	// Genuinely unused, on purpose — same as World Clock. This module's
	// only job is saying what events exist. The theme knows the device's
	// own date and decides what a day, a week or a month looks like, and
	// which of these actually get drawn. Trimming the list here would
	// just be second-guessing that.
	const content = events.map((event) => ({
		type: "event",
		start: formatDate(event.start),
		end: formatDate(event.end),
		summary: event.summary
	}));

	// Staleness is a caveat about the data, not an event — so it goes out
	// as its own block rather than folded into one, the same way Weather
	// reports a last-known reading.
	if (stale) {
		content.push({ type: "pair", label: "Reading", value: "last known" });
	}

	// Feeds usually name themselves. X-WR-CALNAME isn't in the RFC — it's
	// a convention Google started and the others copied — so it may well
	// be missing, and OmniCore falls back to the instance's own label
	// anyway when a module's title is empty.
	const name = readProperty("\n" + feed, "X-WR-CALNAME");

	return {
		title: name ? unescapeText(name.value) : "Calendar",
		content: content,
		updated: new Date().toISOString()
	};
};