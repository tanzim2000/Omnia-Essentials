// modules/prayer-times/index.js
// Prayer times from the Aladhan API. Free, no key required.
//
// RICHNESS
//
// One next-up prayer at the smallest size, growing to all five at the
// largest — but which five, and in what order, is worked out fresh every
// call rather than fixed. The list always starts at whichever prayer is
// actually next and cascades forward through the day, wrapping past
// midnight if it has to. A small tile showing "Dhuhr" first because
// that's where the calendar day happens to start is a small tile lying
// about what's actually coming up.
//
//    1-24    the next prayer's time, nothing else
//   25-49    that time, and which prayer it is
//   50-79    the above, plus the two prayers after it
//   80-100   the above, plus the whole rotation -- all five, next-first

// Aladhan identifies calculation methods by number. We store the readable
// name in settings and map it here, so the admin page shows words rather
// than a number nobody can interpret.
const METHODS = {
	"Muslim World League": 3,
	"ISNA (North America)": 2,
	"Egyptian General Authority": 5,
	"Umm Al-Qura, Makkah": 4,
	"University of Islamic Sciences, Karachi": 1
};

// Which of the returned timings are actual prayers, in order.
// Aladhan also returns Sunrise, Imsak, Midnight and others.
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

// Aladhan returns times as "17:42" — turn that into minutes since midnight
// so we can compare them against now
function toMinutes(time) {
	const [hours, minutes] = time.split(":").map(Number);
	return hours * 60 + minutes;
}

function formatTime(time, use12Hour) {
	if (!use12Hour) {
		return time;
	}

	let [hours, minutes] = time.split(":").map(Number);
	const suffix = hours >= 12 ? "PM" : "AM";

	hours = hours % 12;
	if (hours === 0) hours = 12;

	return hours + ":" + String(minutes).padStart(2, "0") + " " + suffix;
}

// The current wall-clock time AT THE PRAYER LOCATION, in minutes since
// midnight — which is not necessarily the same as the server's own clock.
//
// Aladhan's location setting can legitimately point anywhere, the same
// way World Clock's can — someone in Regina is entitled to track prayer
// times for family in Dhaka. Comparing Dhaka's prayer times against
// Regina's own system clock would get "what's next" wrong by whatever the
// two timezones differ by. Aladhan hands back the zone it actually
// calculated against (`meta.timezone`), so we ask what time it is THERE
// rather than assuming the server's own zone applies.
function nowMinutesInZone(zone) {
	if (!zone) {
		return null;
	}

	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hour12: false,
			hour: "2-digit",
			minute: "2-digit"
		}).formatToParts(new Date());

		const read = (type) => Number(parts.find((p) => p.type === type).value);

		// Some environments render midnight as hour 24 rather than 0
		const hour = read("hour") % 24;

		return hour * 60 + read("minute");
	} catch (error) {
		// An unrecognised zone name shouldn't take the whole tile down
		return null;
	}
}

function problem(reason) {
	return {
		title: "Prayer",
		content: [
			{ type: "text", emphasis: "primary", value: "—" },
			{ type: "text", emphasis: "secondary", value: reason }
		],
		updated: new Date().toISOString()
	};
}

module.exports = async function prayerTimes(config, richness, omni) {
	// OmniCore resolves the location setting before we see it. Null means
	// there's no location to work with — either location services are off,
	// or detection failed and nothing was set by hand.
	if (!config.location) {
		return problem("No location");
	}

	const use12Hour = config.timeFormat === "12-hour";
	const method = METHODS[config.method] || 2;

	// school: 0 = Shafi (earlier Asr), 1 = Hanafi (later Asr)
	const school = config.school === "Hanafi" ? 1 : 0;

	const url =
		"https://api.aladhan.com/v1/timings" +
		"?latitude=" + encodeURIComponent(config.location.latitude) +
		"&longitude=" + encodeURIComponent(config.location.longitude) +
		"&method=" + method +
		"&school=" + school;

	// Include today's date in the cache key so the cached answer is dropped
	// at midnight rather than carrying yesterday's times over
	const { data, stale } = await omni.fetch(url, {
		key: "prayer-times:" + new Date().toDateString() + ":" + url,
		cacheSeconds: Number(config.refreshMinutes) * 60
	});

	if (!data || !data.data || !data.data.timings) {
		return problem("Not reachable");
	}

	const timings = data.data.timings;

	// Aladhan sometimes appends a timezone, e.g. "17:42 (CST)"
	const clean = {};
	for (const prayer of PRAYERS) {
		if (!timings[prayer]) {
			return problem("Not reachable");
		}
		clean[prayer] = timings[prayer].split(" ")[0];
	}

	const zone = data.data.meta && data.data.meta.timezone;
	let nowMinutes = nowMinutesInZone(zone);

	if (nowMinutes === null) {
		// No usable zone from Aladhan — fall back to the server's own
		// clock, the same assumption every earlier version of this
		// module made unconditionally
		const now = new Date();
		nowMinutes = now.getHours() * 60 + now.getMinutes();
	}

	// Where in the day we are. If every prayer has passed, the next one is
	// tomorrow's Fajr.
	const upcomingAt = PRAYERS.findIndex(
		(prayer) => toMinutes(clean[prayer]) > nowMinutes
	);

	const wrapped = upcomingAt === -1;
	const nextAt = wrapped ? 0 : upcomingAt;

	// The next time is the one thing worth seeing from across a room, so it
	// leads at every richness
	const content = [
		{
			type: "text",
			emphasis: "primary",
			value: formatTime(clean[PRAYERS[nextAt]], use12Hour)
		}
	];

	if (richness >= 25) {
		content.push({
			type: "text",
			emphasis: "secondary",
			value: wrapped ? "Fajr, tomorrow" : PRAYERS[nextAt]
		});
	}

	// How many MORE prayers to show beyond the leading one, scaling with
	// richness -- 0, 2, or 4, for a total of 1, 3, or 5 shown.
	const extra = richness >= 80 ? 4 : richness >= 50 ? 2 : 0;

	// Always the same five names, just rotated to start at whichever is
	// actually next -- never the fixed Fajr-first order this used to show
	// regardless of the time of day.
	//
	// Rotating past index 4 wraps into tomorrow. There's no fetched value
	// for tomorrow specifically, so today's already-fetched time for that
	// same prayer stands in for it -- prayer times move by a minute or two
	// day to day, so this is a fair approximation, not a guess.
	for (let ahead = 1; ahead <= extra; ahead++) {
		const prayer = PRAYERS[(nextAt + ahead) % PRAYERS.length];

		content.push({
			type: "pair",
			label: prayer,
			value: formatTime(clean[prayer], use12Hour)
		});
	}

	// Staleness is a caveat about the data, not a prayer time -- it goes
	// out as its own block, the same way Weather and Calendar handle a
	// last-known reading rather than folding it into the schedule itself.
	if (stale) {
		content.push({ type: "pair", label: "Reading", value: "last known" });
	}

	return {
		title: "Prayer",
		content: content,
		updated: new Date().toISOString()
	};
};