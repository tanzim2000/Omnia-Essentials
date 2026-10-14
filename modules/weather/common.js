// modules/weather/common.js
// What every source shares: turning numbers into readable values, and
// working out where a place is.
//
// Every source hands back its readings in ONE set of units, the metric
// ones below, whatever it was given itself. Converting to what the user
// picked happens once, here, so no source has to know about the Units
// settings at all:
//
//   temperatures   degrees Celsius
//   wind and gusts kilometres per hour
//   pressure       hectopascals (the same as millibars)
//   visibility     kilometres
//   humidity, precipitation chance   percent

const norway = require("./data/norway.json");
const ecPlaces = require("./data/ec-places.json");

// ---- Units -----------------------------------------------------------

// The user's two unit choices, read once. Wind on "Automatic" follows
// the temperature: mph with Fahrenheit, km/h with Celsius. That's also
// what a Weather widget set up before there was a wind setting did, so
// it carries on as it was.
function unitsOf(config) {
	const fahrenheit = config.units === "Fahrenheit";
	const wind = config.windUnits || "Automatic";

	return {
		fahrenheit,
		mph: wind === "mph" || (wind === "Automatic" && fahrenheit)
	};
}

function temperature(celsius, units) {
	if (!isNumber(celsius)) return undefined;
	const value = units.fahrenheit ? celsius * 9 / 5 + 32 : celsius;

	// Math.round(-0.4) is -0, which prints as "-0". Nobody says that.
	return (Math.round(value) || 0) + (units.fahrenheit ? "°F" : "°C");
}

function speed(kmh, units) {
	if (!isNumber(kmh)) return undefined;
	return units.mph ? Math.round(kmh / 1.609344) + " mph" : Math.round(kmh) + " km/h";
}

// Pressure follows the temperature choice: hectopascals with Celsius,
// inches of mercury with Fahrenheit, which is how each is usually read
function pressure(hpa, units) {
	if (!isNumber(hpa)) return undefined;
	return units.fahrenheit
		? (hpa * 0.02953).toFixed(2) + " inHg"
		: Math.round(hpa) + " hPa";
}

// Distance follows the wind choice: miles with mph, kilometres with km/h
function distance(km, units) {
	if (!isNumber(km)) return undefined;
	const value = units.mph ? km / 1.609344 : km;
	const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
	return rounded + (units.mph ? " mi" : " km");
}

function percent(value) {
	return isNumber(value) ? Math.round(value) + "%" : undefined;
}

function isNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

// 0 to 360 degrees, the way wind is reported, into one of eight
// directions: N, NE, E, SE, S, SW, W, NW
const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function compass(degrees) {
	if (!isNumber(degrees)) return "";
	return DIRECTIONS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

// ---- Where a place is ------------------------------------------------

// Straight-line distance between two places, in kilometres
function kilometresBetween(lat1, lon1, lat2, lon2) {
	const rad = Math.PI / 180;
	const dLat = (lat2 - lat1) * rad;
	const dLon = (lon2 - lon1) * rad;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;

	return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Is a point inside a ring of [longitude, latitude] corners? The usual
// trick: draw a line from the point out to the east and count how many
// of the ring's edges it crosses. An odd number means inside.
function insideRing(lat, lon, ring) {
	let inside = false;

	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];

		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}

	return inside;
}

// How far a point is from the nearest edge of a ring, in kilometres.
// Close enough for a few kilometres either way, which is all this needs.
function kilometresFromRing(lat, lon, ring) {
	const squash = Math.cos((lat * Math.PI) / 180);
	let best = Infinity;

	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		// Both ends of the edge, in kilometres east and north of the point
		const ax = (ring[j][0] - lon) * squash * 111.32;
		const ay = (ring[j][1] - lat) * 111.32;
		const bx = (ring[i][0] - lon) * squash * 111.32;
		const by = (ring[i][1] - lat) * 111.32;

		// The closest spot on the edge to the point (which is at 0, 0)
		const dx = bx - ax;
		const dy = by - ay;
		const length = dx * dx + dy * dy;
		const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;

		best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
	}

	return best;
}

// Is this place in Norway? The outline is simplified (see data/), which
// cuts off the tips of islands and the ends of fjords: Tromsø and
// Longyearbyen are just outside it. So anything within 5 km of the
// outline counts too. That also lets in a few kilometres of Sweden,
// Finland and Russia right at the border, where MET Norway's forecast is
// still a good one.
const NORWAY_MARGIN_KM = 5;

function inNorway(lat, lon) {
	return norway.rings.some(
		(ring) => insideRing(lat, lon, ring) || kilometresFromRing(lat, lon, ring) <= NORWAY_MARGIN_KM
	);
}

// Environment Canada's forecast places nearest a point, nearest first,
// as [{ id, km }]. Only places within `withinKm` are returned, so an
// empty list means the point isn't in Canada (or anywhere near it).
function nearestEcPlaces(lat, lon, count, withinKm) {
	return ecPlaces.places
		.map(([id, placeLat, placeLon]) => ({ id, km: kilometresBetween(lat, lon, placeLat, placeLon) }))
		.filter((place) => place.km <= withinKm)
		.sort((a, b) => a.km - b.km)
		.slice(0, count);
}

// Coordinates for a request URL: at most four decimals (about 10 m).
// MET Norway refuses more, and the US National Weather Service redirects.
function coordinate(value) {
	return String(Math.round(Number(value) * 10000) / 10000);
}

// ---- Alerts ----------------------------------------------------------

// Every source rates its alerts in its own words: colours in Canada and
// Norway, CAP's Minor to Extreme in the US and from Google. They all go
// onto one scale, 1 to 4, so one setting works for every source.
const SEVERITY = { minor: 1, moderate: 2, severe: 3, extreme: 4 };

// What "Notify me about" lets through
const NOTIFY_FROM = {
	"Every alert": 1,
	"Moderate and up": 2,
	"Severe and up": 3,
	"Nothing": Infinity
};

function notifyFrom(config) {
	return NOTIFY_FROM[config.alertLevel] || NOTIFY_FROM["Moderate and up"];
}

module.exports = {
	unitsOf,
	temperature,
	speed,
	pressure,
	distance,
	percent,
	isNumber,
	compass,
	kilometresBetween,
	inNorway,
	nearestEcPlaces,
	coordinate,
	SEVERITY,
	notifyFrom
};
