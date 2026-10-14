// modules/weather/sources/open-meteo.js
// Open-Meteo: anywhere in the world, no key, no account. The default.
// No weather alerts: Open-Meteo doesn't publish any.
//
// Every source file has the same shape (see index.js for how they're
// used):
//
//   name      the option's text in the Source setting
//   credit    the line naming the data, sent as `data-source`
//   fields    every piece this source can show, in its default order.
//             Must match its Info order setting in settings.json.
//   covers    (lat, lon) -> "" when the place is covered, or a few words
//             saying what the source does cover
//   read      (ctx) -> { readings, stale } or { problem }
//   alerts    (ctx) -> { alerts } or { problem }. Only on sources that
//             publish alerts.

// Open-Meteo reports conditions as WMO weather codes: numbers, not words
const WEATHER_CODES = {
	0: "Clear",
	1: "Mainly clear",
	2: "Partly cloudy",
	3: "Overcast",
	45: "Fog",
	48: "Freezing fog",
	51: "Light drizzle",
	53: "Drizzle",
	55: "Heavy drizzle",
	56: "Freezing drizzle",
	57: "Freezing drizzle",
	61: "Light rain",
	63: "Rain",
	65: "Heavy rain",
	66: "Freezing rain",
	67: "Freezing rain",
	71: "Light snow",
	73: "Snow",
	75: "Heavy snow",
	77: "Snow grains",
	80: "Light showers",
	81: "Showers",
	82: "Heavy showers",
	85: "Snow showers",
	86: "Snow showers",
	95: "Thunderstorm",
	96: "Thunderstorm, hail",
	99: "Thunderstorm, hail"
};

const { coordinate } = require("../common");

async function read(ctx) {
	// Always metric: index.js converts to the user's units
	const url =
		"https://api.open-meteo.com/v1/forecast" +
		"?latitude=" + coordinate(ctx.lat) +
		"&longitude=" + coordinate(ctx.lon) +
		"&current=temperature_2m,apparent_temperature,relative_humidity_2m," +
		"weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl" +
		"&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max" +
		"&forecast_days=1&timezone=auto";

	const { data, stale, status } = await ctx.omni.fetch(url, { cacheSeconds: ctx.cacheSeconds });

	if (!data || !data.current) {
		return { problem: "Not reachable", status };
	}

	const now = data.current;
	const today = data.daily || {};
	const first = (list) => (Array.isArray(list) ? list[0] : undefined);

	return {
		stale,
		readings: {
			temperature: now.temperature_2m,
			condition: WEATHER_CODES[now.weather_code],
			feelsLike: now.apparent_temperature,
			high: first(today.temperature_2m_max),
			low: first(today.temperature_2m_min),
			humidity: now.relative_humidity_2m,
			wind: now.wind_speed_10m,
			windDirection: now.wind_direction_10m,
			gust: now.wind_gusts_10m,
			pressure: now.pressure_msl,
			precipChance: first(today.precipitation_probability_max),
			uv: first(today.uv_index_max)
		}
	};
}

module.exports = {
	name: "Open-Meteo",
	credit: "Weather data by Open-Meteo.com",
	fields: [
		"Temperature",
		"Condition",
		"Feels like",
		"High / low",
		"Humidity",
		"Wind",
		"Wind gusts",
		"Pressure",
		"Precipitation chance",
		"UV index"
	],
	covers: () => "",
	read
};
