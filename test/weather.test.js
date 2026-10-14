// test/weather.test.js
// The Weather module against real answers saved from each service
// (test/weather-samples), with a stand-in for OmniCore's `omni` so no
// network is used. Run from the repo's root:
//
//   node --test
//
// The samples were saved on Oct 11 and 12, 2026. "Now" is set to just
// after they were saved, so their alerts are still in force.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const weather = require("../modules/weather");
const common = require("../modules/weather/common");
const metNorway = require("../modules/weather/sources/met-norway");

const SAMPLES = path.join(__dirname, "weather-samples");
const sample = (name) => JSON.parse(fs.readFileSync(path.join(SAMPLES, name), "utf8"));

const REGINA = { latitude: 50.4452, longitude: -104.6189, label: "Regina, Saskatchewan, Canada" };
const OSLO = { latitude: 59.9139, longitude: 10.7522, label: "Oslo, Oslo, Norway" };
const DENVER = { latitude: 39.7392, longitude: -104.9903, label: "Denver, Colorado, United States" };
const PINCHER_CREEK = { latitude: 49.49, longitude: -113.95, label: "Pincher Creek, Alberta, Canada" };
const FORT_ERIE = { latitude: 42.91, longitude: -78.92, label: "Fort Erie, Ontario, Canada" };

// Just after the samples were saved
const realNow = Date.now;
Date.now = () => Date.parse("2026-10-12T01:00:00Z");
test.after(() => {
	Date.now = realNow;
});

// A stand-in for OmniCore's omni. `answer(url, options)` returns a sample
// file's name, an object to send as it is, or { status } for a failure.
function fakeOmni(answer) {
	const calls = [];
	const notes = [];
	let saved = {};

	return {
		calls,
		notes,
		async fetch(url, options) {
			calls.push({ url, options });
			const reply = answer(url, options);

			if (typeof reply === "string") return { data: sample(reply), stale: false };
			if (reply && reply.status) return { data: null, stale: false, status: reply.status };
			if (reply) return { data: reply, stale: false };
			return { data: null, stale: false, status: 0 };
		},
		// The same arithmetic as OmniCore's core/priority.js
		share(total, richness) {
			if (!total) return 0;
			return Math.max(1, Math.min(total, Math.round((richness / 100) * total)));
		},
		storage: {
			read: () => JSON.parse(JSON.stringify(saved)),
			write: (data) => {
				saved = data;
			}
		},
		time: () => ({ timestamp: new Date(Date.now()).toISOString(), timezone: "America/Regina" }),
		notify: (note) => notes.push(note)
	};
}

// Settings as OmniCore hands them over: defaults filled in
function settings(extra) {
	const config = {};

	for (const field of require("../modules/weather/settings.json").settings) {
		if (field.default !== undefined) config[field.key] = field.default;
	}

	return Object.assign(config, extra);
}

const pairs = (envelope) => Object.fromEntries(envelope.content.map((block) => [block.label, block.value]));

// ---- The settings themselves ------------------------------------------

test("each source's Info order lists exactly what that source can show", () => {
	const fields = require("../modules/weather/settings.json").settings;

	for (const source of weather.SOURCES) {
		const order = fields.find(
			(field) => field.type === "priority" && field.showWhen && field.showWhen.equals === source.name
		);

		assert.ok(order, `an Info order for ${source.name}`);
		assert.deepEqual(order.options, source.fields);
	}

	// Open-Meteo keeps the original key, so an older widget keeps its order
	assert.equal(fields.find((field) => field.key === "fieldOrder").showWhen.equals, "Open-Meteo");
});

test("OpenWeatherMap and Google Weather ask for a key first", () => {
	const source = require("../modules/weather/settings.json").settings.find((field) => field.key === "source");

	assert.equal(source.ask.OpenWeatherMap.into, "owmKey");
	assert.equal(source.ask["Google Weather"].into, "googleKey");
});

test("no long dashes anywhere in the module's own words", () => {
	const folder = path.join(__dirname, "../modules/weather");
	const files = ["module.json", "settings.json", "index.js", "common.js"].concat(
		fs.readdirSync(path.join(folder, "sources")).map((name) => "sources/" + name)
	);

	for (const file of files) {
		assert.ok(!fs.readFileSync(path.join(folder, file), "utf8").includes("\u2014"), file);
	}
});

// ---- Where a place is ---------------------------------------------------

test("Norway: towns on islands and fjords count, Stockholm and Copenhagen don't", () => {
	assert.ok(common.inNorway(59.91, 10.75), "Oslo");
	assert.ok(common.inNorway(69.65, 18.96), "Tromsø");
	assert.ok(common.inNorway(78.22, 15.63), "Longyearbyen");
	assert.ok(common.inNorway(68.44, 17.43), "Narvik");
	assert.ok(!common.inNorway(59.33, 18.07), "Stockholm");
	assert.ok(!common.inNorway(55.68, 12.57), "Copenhagen");
	assert.ok(!common.inNorway(50.45, -104.62), "Regina");
});

test("Environment Canada's nearest place to Regina is Regina", () => {
	assert.equal(common.nearestEcPlaces(50.4452, -104.6189, 1, 100)[0].id, "sk-32");
	assert.deepEqual(common.nearestEcPlaces(59.91, 10.75, 1, 100), [], "Oslo is nowhere near");
});

// ---- Open-Meteo -----------------------------------------------------------

test("Open-Meteo: an older answer still makes a tile, named after the place, with its credit", async () => {
	const omni = fakeOmni(() => "open-meteo-regina.json");
	const tile = await weather(settings({ location: REGINA }), 95, omni);

	assert.equal(tile.title, "Regina");
	assert.equal(tile["data-source"], "Weather data by Open-Meteo.com");
	assert.equal(tile.content[0].label, "Temperature");
	assert.equal(tile.content[0].emphasis, "primary");
	assert.equal(tile.content.length, 6, "the older answer has six of the ten");

	// Metric always, whatever the user picked: this module converts
	assert.ok(!omni.calls[0].url.includes("fahrenheit"));
});

test("Fahrenheit and mph: every number follows the units picked", async () => {
	const omni = fakeOmni(() => "open-meteo-regina.json");
	const metric = pairs(await weather(settings({ location: REGINA }), 95, omni));
	const us = pairs(await weather(settings({ location: REGINA, units: "Fahrenheit", windUnits: "mph" }), 95, omni));

	assert.match(metric.Temperature, /°C$/);
	assert.match(us.Temperature, /°F$/);
	assert.match(metric.Wind, /km\/h/);
	assert.match(us.Wind, /mph/);
});

test("wind on Automatic follows the temperature, as the older Weather did", async () => {
	const omni = fakeOmni(() => "open-meteo-regina.json");
	const fahrenheit = pairs(await weather(settings({ location: REGINA, units: "Fahrenheit" }), 95, omni));
	const forced = pairs(await weather(settings({ location: REGINA, units: "Fahrenheit", windUnits: "km/h" }), 95, omni));

	assert.equal(settings({}).windUnits, "Automatic");
	assert.match(fahrenheit.Wind, /mph/);
	assert.match(forced.Wind, /km\/h/);
});

test("a small tile shows only the top of the user's order", async () => {
	const omni = fakeOmni(() => "open-meteo-regina.json");
	const config = settings({ location: REGINA, fieldOrder: ["Condition", "Temperature", "Humidity"] });
	const tile = await weather(config, 10, omni);

	assert.equal(tile.content.length, 1);
	assert.equal(tile.content[0].label, "Condition");
});

test("no location: the tile says so", async () => {
	const tile = await weather(settings({ location: null }), 50, fakeOmni(() => null));

	assert.equal(tile.content[1].value, "No location");
	assert.ok(!JSON.stringify(tile).includes("\u2014"));
});

// ---- Environment Canada -------------------------------------------------

function ecAnswers(url) {
	const match = /citypageweather-realtime\/items\/([a-z0-9-]+)\?/.exec(url);
	return match && fs.existsSync(path.join(SAMPLES, `ec-${match[1]}.json`)) ? `ec-${match[1]}.json` : null;
}

test("Environment Canada: Regina's reading, wind chill as feels like, the next high and low", async () => {
	const omni = fakeOmni(ecAnswers);
	const config = settings({ location: REGINA, source: "Environment Canada", alertLevel: "Every alert" });
	const tile = await weather(config, 95, omni);
	const shown = pairs(tile);

	assert.equal(tile["data-source"], "Based on Environment and Climate Change Canada data");
	assert.equal(shown.Temperature, "5°C");
	assert.equal(shown.Condition, "Mostly Cloudy");
	// The special weather statement is in force and shows third
	assert.equal(shown.Alert, "Special weather statement");
	assert.equal(tile.content[2].label, "Alert");

	const all = pairs(await weather(Object.assign({}, config, { ecOrder: ["Feels like", "High / low", "Wind", "Pressure", "Dew point", "Humidity"] }), 95, omni));
	assert.equal(all["Feels like"], "-2°C");
	assert.equal(all["High / low"], "3°C / -1°C");
	assert.equal(all.Wind, "17 km/h NE");
	assert.equal(all.Pressure, "1022 hPa");
	assert.equal(all["Dew point"], "1°C");

	// One page for the reading and the alert: the same address both times
	assert.ok(omni.calls.every((call) => call.url.includes("/items/sk-32?")));
});

test("Environment Canada outside Canada says what it covers, without asking anyone", async () => {
	const omni = fakeOmni(() => null);
	const tile = await weather(settings({ location: OSLO, source: "Environment Canada" }), 50, omni);

	assert.equal(tile.content[1].value, "Covers Canada only");
	assert.equal(omni.calls.length, 0);
});

test("Environment Canada: a place with no station reading asks the next nearest", async () => {
	const omni = fakeOmni(ecAnswers);
	const tile = await weather(settings({ location: FORT_ERIE, source: "Environment Canada" }), 95, omni);

	assert.ok(omni.calls.length >= 2, "asked for another place's reading");
	assert.ok(omni.calls[0].url.includes("/items/on-12?"));
	// Still a tile, from the forecast, rather than an error
	assert.ok(tile.content.length > 0);
	assert.equal(tile.content[0].type, "pair");
});

test("Environment Canada: a yellow warning is announced once, and remembered", async () => {
	const omni = fakeOmni(ecAnswers);
	const config = settings({ location: PINCHER_CREEK, source: "Environment Canada" });
	const source = weather.SOURCES[1];

	const handle = await weather.start(config, omni);
	assert.ok(handle, "it watches");
	await weather.stop(handle);

	// What the timer would do, done by hand
	const check = () => weather.checkAlertsNow(config, omni);
	await check();

	assert.equal(omni.notes.length, 1);
	const note = omni.notes[0];
	assert.equal(note.source, "Environment Canada");
	assert.equal(note.title, "Yellow warning - snowfall");
	assert.equal(note.priority, 3);
	assert.match(note.link, /^https:\/\/weather\.gc\.ca\/warnings\//);
	assert.match(note.description, /^For Pincher Creek, until /);

	// Checked again: nothing new
	await check();
	assert.equal(omni.notes.length, 1);

	// Remembered under its own link and under its title
	assert.ok(omni.storage.read().announced.includes("Environment Canada|yellow warning - snowfall"));
	assert.ok(source.alerts);
});

test("an alert that ends is forgotten, so it's news if it comes back", async () => {
	let quiet = false;
	const omni = fakeOmni((url) => {
		if (!quiet) return ecAnswers(url);
		const page = sample("ec-ab-46.json");
		page.properties.warnings = [];
		return page;
	});
	const config = settings({ location: PINCHER_CREEK, source: "Environment Canada" });

	await weather.checkAlertsNow(config, omni);
	assert.equal(omni.notes.length, 1);

	quiet = true;
	await weather.checkAlertsNow(config, omni);
	assert.deepEqual(omni.storage.read().announced, []);

	quiet = false;
	await weather.checkAlertsNow(config, omni);
	assert.equal(omni.notes.length, 2);
});

test("a service that can't be reached keeps what's remembered", async () => {
	let down = false;
	const omni = fakeOmni((url) => (down ? { status: 503 } : ecAnswers(url)));
	const config = settings({ location: PINCHER_CREEK, source: "Environment Canada" });

	await weather.checkAlertsNow(config, omni);
	const before = omni.storage.read().announced;

	down = true;
	await weather.checkAlertsNow(config, omni);
	assert.deepEqual(omni.storage.read().announced, before);
});

// ---- MET Norway ---------------------------------------------------------

test("MET Norway: Oslo's forecast in words, wind in km/h", async () => {
	const omni = fakeOmni((url) => (url.includes("locationforecast") ? "met-forecast-oslo.json" : "met-alerts-oslo-none.json"));
	const config = settings({
		location: OSLO,
		source: "MET Norway",
		metOrder: ["Temperature", "Condition", "Feels like", "Wind", "High / low", "Alert"]
	});
	const tile = await weather(config, 95, omni);
	const shown = pairs(tile);

	assert.equal(tile["data-source"], "Weather data from MET Norway");
	assert.equal(shown.Temperature, "5°C");
	assert.equal(shown.Condition, "Partly cloudy");
	assert.equal(shown["Feels like"], "3°C");
	// 2.3 m/s from 24 degrees
	assert.equal(shown.Wind, "8 km/h NE");
	assert.equal(shown.Alert, undefined, "no alert, no slot taken");

	// MET Norway's rules: say who's asking, four decimals at most, and
	// no more than every 10 minutes
	for (const call of omni.calls) {
		assert.match(call.options.headers["User-Agent"], /Omnia-Weather/);
		assert.ok(call.options.cacheSeconds >= 600);
		assert.ok(!/\d\.\d{5}/.test(call.url));
	}
});

test("MET Norway's condition codes, in words", () => {
	assert.equal(metNorway.describe("clearsky_day"), "Clear");
	assert.equal(metNorway.describe("lightrainshowers_night"), "Light rain showers");
	assert.equal(metNorway.describe("heavysnowandthunder"), "Heavy snow and thunder");
	assert.equal(metNorway.describe("lightssleetshowersandthunder"), "Light sleet showers and thunder");
	assert.equal(metNorway.describe("sleet"), "Sleet");
});

test("MET Norway: outside Norway says what it covers", async () => {
	const tile = await weather(settings({ location: REGINA, source: "MET Norway" }), 50, fakeOmni(() => null));
	assert.equal(tile.content[1].value, "Covers Norway only");
});

test("MET Norway: a warning is announced with its colour; a cancellation never is", async () => {
	const alerts = sample("met-alerts-two.json");
	const cancelled = JSON.parse(JSON.stringify(alerts.features[1]));
	// Edited from a real alert: the same, sent as a cancellation
	cancelled.properties.type = "Cancel";
	cancelled.properties.id += "-cancel";
	cancelled.properties.eventAwarenessName = "Something cancelled";
	alerts.features.push(cancelled);

	const omni = fakeOmni((url) => (url.includes("metalerts") ? alerts : "met-forecast-oslo.json"));
	await weather.checkAlertsNow(settings({ location: OSLO, source: "MET Norway", alertLevel: "Every alert" }), omni);

	const titles = omni.notes.map((note) => note.title);
	assert.ok(titles.every((title) => /^(Yellow|Orange|Red): /.test(title)), titles.join(", "));
	assert.ok(!titles.some((title) => title.includes("cancelled")));
	assert.ok(omni.notes.every((note) => note.link && !/\s/.test(note.link)), "the link is trimmed");
});

// ---- US National Weather Service -----------------------------------------

function nwsAnswers(url) {
	if (url.includes("/points/")) return "nws-points-denver.json";
	if (url.endsWith("/stations")) return "nws-stations-denver.json";
	if (url.includes("/observations/latest")) return "nws-observation-denver.json";
	if (url.endsWith("/forecast")) return "nws-forecast-denver.json";
	if (url.includes("/alerts/active")) return "nws-alerts-denver-none.json";
	return null;
}

test("US National Weather Service: the station's reading, the forecast's high and low", async () => {
	const omni = fakeOmni(nwsAnswers);
	const config = settings({
		location: DENVER,
		source: "US National Weather Service",
		units: "Fahrenheit",
		windUnits: "mph",
		nwsOrder: ["Temperature", "Condition", "High / low", "Wind", "Feels like", "Visibility"]
	});
	const shown = pairs(await weather(config, 95, omni));

	// 24°C, 80°F high, 56°F low (Fahrenheit there and back)
	assert.equal(shown.Temperature, "75°F");
	assert.equal(shown.Condition, "Clear");
	assert.equal(shown["High / low"], "80°F / 56°F");
	assert.equal(shown.Wind, "9 mph N");
	assert.equal(shown["Feels like"], "74°F");
	assert.equal(shown.Visibility, "10 mi");

	// The point and its stations are kept for a day
	const point = omni.calls.find((call) => call.url.includes("/points/"));
	assert.equal(point.options.cacheSeconds, 86400);
	assert.match(point.options.headers["User-Agent"], /Omnia-Weather/);
});

test("US National Weather Service outside the US: its own 404 says so", async () => {
	const omni = fakeOmni((url) => (url.includes("/points/") ? { status: 404 } : null));
	const tile = await weather(settings({ location: REGINA, source: "US National Weather Service" }), 50, omni);

	assert.equal(tile.content[1].value, "Covers the US only");
});

test("US National Weather Service: an update to an announced alert isn't announced again", async () => {
	const first = sample("nws-alerts-severe-two.json");
	first.features = first.features.slice(0, 1);

	// Edited from the real alert: the same one, updated under a new number
	const update = JSON.parse(JSON.stringify(first));
	const original = update.features[0].properties;
	update.features[0].properties = Object.assign({}, original, {
		id: original.id + ".update",
		messageType: "Update",
		event: original.event + " (extended)",
		references: [{ identifier: original.id }]
	});

	let answer = first;
	const omni = fakeOmni((url) => (url.includes("/alerts/active") ? answer : nwsAnswers(url)));
	const config = settings({ location: DENVER, source: "US National Weather Service" });

	await weather.checkAlertsNow(config, omni);
	assert.equal(omni.notes.length, 1);
	assert.equal(omni.notes[0].priority, 4, "Severe is priority 4");
	assert.match(omni.notes[0].link, /^https:\/\/forecast\.weather\.gov\/MapClick\.php\?lat=/);

	answer = update;
	await weather.checkAlertsNow(config, omni);
	assert.equal(omni.notes.length, 1, "the update replaced an alert already announced");
});

// ---- OpenWeatherMap -------------------------------------------------------

// OpenWeatherMap's documented answers (no live sample: see the source file)
const OWM_CURRENT = {
	weather: [{ id: 500, main: "Rain", description: "light rain", icon: "10d" }],
	main: { temp: 4.2, feels_like: 1.1, temp_min: 3.9, temp_max: 4.8, pressure: 1021, humidity: 81 },
	visibility: 10000,
	wind: { speed: 5, deg: 40, gust: 9 },
	name: "Regina"
};
const OWM_FORECAST = {
	list: [
		{ main: { temp: 4, temp_min: 3, temp_max: 6 }, pop: 0.35 },
		{ main: { temp: 1, temp_min: -1, temp_max: 2 }, pop: 0.1 }
	]
};

test("OpenWeatherMap: the documented answer makes a tile, wind from m/s", async () => {
	const omni = fakeOmni((url) => (url.includes("/weather?") ? OWM_CURRENT : OWM_FORECAST));
	const config = settings({
		location: REGINA,
		source: "OpenWeatherMap",
		owmKey: "abc123",
		owmOrder: ["Temperature", "Condition", "High / low", "Wind", "Precipitation chance", "Visibility"]
	});
	const tile = await weather(config, 95, omni);
	const shown = pairs(tile);

	assert.equal(tile["data-source"], "Weather data by OpenWeather");
	assert.equal(shown.Condition, "Light rain");
	assert.equal(shown["High / low"], "6°C / -1°C");
	assert.equal(shown.Wind, "18 km/h NE");
	assert.equal(shown["Precipitation chance"], "35%");
	assert.equal(shown.Visibility, "10 km");
	assert.ok(omni.calls.every((call) => call.url.includes("appid=abc123") && call.url.includes("units=metric")));
});

test("OpenWeatherMap: no key, and a wrong key, each say so", async () => {
	const noKey = await weather(settings({ location: REGINA, source: "OpenWeatherMap" }), 50, fakeOmni(() => null));
	assert.equal(noKey.content[1].value, "No API key");

	const wrong = await weather(
		settings({ location: REGINA, source: "OpenWeatherMap", owmKey: "nope" }),
		50,
		fakeOmni(() => ({ status: 401 }))
	);
	assert.equal(wrong.content[1].value, "Invalid API key");
});

// ---- Google Weather -------------------------------------------------------

function googleAnswers(url) {
	if (url.includes("currentConditions")) return "google-current-regina.json";
	if (url.includes("forecast/days")) return "google-forecast-days-regina.json";
	if (url.includes("publicAlerts")) return "google-alerts-regina.json";
	return null;
}

test("Google Weather: Regina, with Google's own credit line", async () => {
	const omni = fakeOmni(googleAnswers);
	const config = settings({
		location: REGINA,
		source: "Google Weather",
		googleKey: "key-1",
		googleOrder: ["Temperature", "Condition", "Feels like", "High / low", "Wind", "UV index"]
	});
	const tile = await weather(config, 95, omni);
	const shown = pairs(tile);

	assert.equal(tile["data-source"], "Source: Includes weather data from Google");
	assert.equal(shown.Temperature, "3°C");
	assert.equal(shown.Condition, "Cloudy");
	assert.equal(shown["Feels like"], "-2°C");
	assert.equal(shown["High / low"], "4°C / 0°C");
	assert.equal(shown.Wind, "18 km/h NE");
});

test("Google Weather: a wrong key is a 400 from Google", async () => {
	const tile = await weather(
		settings({ location: REGINA, source: "Google Weather", googleKey: "bad" }),
		50,
		fakeOmni(() => ({ status: 400 }))
	);
	assert.equal(tile.content[1].value, "Invalid API key");
});

test("Google Weather: alerts name who issued them", async () => {
	const utah = { latitude: 37.44, longitude: -113.31, label: "Utah" };
	const omni = fakeOmni((url) => (url.includes("publicAlerts") ? "google-alerts-utah.json" : googleAnswers(url)));

	await weather.checkAlertsNow(settings({ location: utah, source: "Google Weather", googleKey: "k", alertLevel: "Every alert" }), omni);

	assert.ok(omni.notes.length >= 1);
	assert.equal(omni.notes[0].source, "Google Weather (National Weather Service)");
});

// ---- Background ---------------------------------------------------------

test("nothing is watched when there's nothing to watch", async () => {
	const omni = fakeOmni(() => null);

	assert.equal(await weather.start(settings({ location: REGINA }), omni), null, "Open-Meteo has no alerts");
	assert.equal(await weather.start(settings({ location: REGINA, source: "Environment Canada", alertLevel: "Nothing" }), omni), null);
	assert.equal(await weather.start(settings({ location: OSLO, source: "Environment Canada" }), omni), null, "outside Canada");
	assert.equal(await weather.start(settings({ location: REGINA, source: "Google Weather" }), omni), null, "no key");
	assert.equal(await weather.start(settings({ location: null, source: "MET Norway" }), omni), null);
});
