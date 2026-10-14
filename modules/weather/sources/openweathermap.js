// modules/weather/sources/openweathermap.js
// OpenWeatherMap: anywhere in the world, with your own free API key.
//
// The free key covers the current weather and a 5-day forecast in
// 3-hour steps; the forecast's next 24 hours give the high and low.
// Weather alerts are only in OpenWeatherMap's paid plan (One Call), so
// this source has none.
//
// Built from OpenWeatherMap's documentation rather than a saved answer
// (the key used while building this hadn't started working yet). A new
// key can take a couple of hours to start working, and until then the
// tile says "Invalid API key".

const { coordinate } = require("../common");

const BASE = "https://api.openweathermap.org/data/2.5/";

function url(ctx, kind, extra) {
	return (
		BASE + kind +
		"?lat=" + coordinate(ctx.lat) + "&lon=" + coordinate(ctx.lon) +
		"&units=metric" + (extra || "") +
		"&appid=" + encodeURIComponent(ctx.key)
	);
}

// Metres per second, as OpenWeatherMap's metric units give wind, in km/h
function kmh(value) {
	return typeof value === "number" ? value * 3.6 : undefined;
}

function problemFor(status) {
	return status === 401 || status === 403 ? "Invalid API key" : "Not reachable";
}

async function read(ctx) {
	if (!ctx.key) {
		return { problem: "No API key" };
	}

	const current = await ctx.omni.fetch(url(ctx, "weather"), { cacheSeconds: ctx.cacheSeconds });
	const now = current.data;

	if (!now || !now.main) {
		return { problem: problemFor(current.status), status: current.status };
	}

	// The next 24 hours: eight 3-hour steps. Without it there's still
	// the current weather, just no high and low.
	const forecast = await ctx.omni.fetch(url(ctx, "forecast", "&cnt=8"), { cacheSeconds: ctx.cacheSeconds });
	const steps = (forecast.data && forecast.data.list) || [];

	const highs = steps.map((step) => step.main && step.main.temp_max).filter((value) => typeof value === "number");
	const lows = steps.map((step) => step.main && step.main.temp_min).filter((value) => typeof value === "number");

	const description = (now.weather && now.weather[0] && now.weather[0].description) || "";
	const wind = now.wind || {};

	return {
		stale: current.stale,
		readings: {
			temperature: now.main.temp,
			// "light rain" -> "Light rain"
			condition: description ? description.charAt(0).toUpperCase() + description.slice(1) : undefined,
			feelsLike: now.main.feels_like,
			high: highs.length ? Math.max(now.main.temp, ...highs) : undefined,
			low: lows.length ? Math.min(now.main.temp, ...lows) : undefined,
			humidity: now.main.humidity,
			wind: kmh(wind.speed),
			windDirection: wind.deg,
			gust: kmh(wind.gust),
			pressure: now.main.sea_level || now.main.pressure,
			visibility: typeof now.visibility === "number" ? now.visibility / 1000 : undefined,
			// Chance of rain or snow in the next 3 hours, 0 to 1
			precipChance: steps[0] && typeof steps[0].pop === "number" ? steps[0].pop * 100 : undefined
		}
	};
}

module.exports = {
	name: "OpenWeatherMap",
	credit: "Weather data by OpenWeather",
	keySetting: "owmKey",
	fields: [
		"Temperature",
		"Condition",
		"Feels like",
		"High / low",
		"Humidity",
		"Wind",
		"Wind gusts",
		"Pressure",
		"Visibility",
		"Precipitation chance"
	],
	covers: () => "",
	read
};
